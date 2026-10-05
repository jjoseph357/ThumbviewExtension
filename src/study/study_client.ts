// Queues study events and uploads them in batches to the Supabase `events` table. The queue is
// persisted (through the injected store) so events survive restarts and offline periods. Returns
// nothing to callers; study.ts decides whether sending is allowed at all.
import type { StudyEvent } from "./study_events";

export interface StudyRow {
    /**
     * Unique per event (a unique constraint in the database), so a batch sent twice (two windows, a
     * retry after a lost response) is stored once: the repeat is rejected with 409 and dropped.
     */
    event_id: string;
    participant_id: string;
    session_id: string;
    event: string;
    ts: string;
    ext_version: string;
    schema_version: number;
    props: StudyEvent["props"];
}

export interface QueueStore {
    load(): StudyRow[];
    save(rows: StudyRow[]): Thenable<void> | Promise<void> | void;
}

/** `text` reads the response body (PostgREST puts the error code there); a Fetch API Response has it. */
export type FetchLike = (url: string, init: { method: string; headers: { [key: string]: string }; body: string }) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;

/** Unsent events kept at most (oldest dropped first), so an offline machine never grows the store without bound. */
export const MAX_QUEUED_EVENTS = 5000;
export const BATCH_SIZE = 200;

/**
 * Rejections caused by the rows themselves (a duplicate event_id, a failed check constraint, an
 * oversized row): resending them alone isolates the bad row. Every other failure (401/403 from a
 * rotated key or a policy mistake, 404 from a wrong URL, 408, 429, 5xx, no network) is systemic:
 * the rows are fine, so they are kept and retried later. Dropping on those would let one
 * deployment mistake silently delete every participant's queued data.
 *
 * A 400 or 422 is a row rejection only when its body carries a PostgreSQL data or constraint error
 * (SQLSTATE class 22 or 23). PostgREST's own 400s (`PGRST…`, e.g. PGRST204 for a column missing
 * after a schema mistake) and unreadable bodies are systemic.
 */
export function isRowRejection(status: number, body = ""): boolean {
    if (status === 409 || status === 413) {
        return true;
    }
    if (status !== 400 && status !== 422) {
        return false;
    }
    let code: unknown;
    try {
        code = (JSON.parse(body) as { code?: unknown }).code;
    } catch {
        return false;
    }
    return typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code);
}

const SEND_NOW_TIMEOUT_MS = 3000;

export class StudyClient {
    private queue: StudyRow[];
    private sending: Promise<void> | undefined;
    private failures = 0;
    private nextAttemptAt = 0;

    constructor(
        private readonly endpoint: { url: string; anonKey: string },
        private readonly store: QueueStore,
        private readonly fetchImpl: FetchLike,
        private readonly now: () => number = Date.now,
        private readonly onDropped: (count: number, status: number) => void = () => { }
    ) {
        this.queue = store.load();
    }

    get pending(): number {
        return this.queue.length;
    }

    enqueue(row: StudyRow): void {
        this.queue.push(row);
        // Not while uploading: the in-flight batch is the head of the queue.
        if (!this.sending && this.queue.length > MAX_QUEUED_EVENTS) {
            this.queue.splice(0, this.queue.length - MAX_QUEUED_EVENTS);
        }
        void this.store.save(this.queue);
    }

    /** Drops everything unsent (the participant left the study). */
    clear(): void {
        this.queue = [];
        void this.store.save(this.queue);
    }

    /** Keeps only matching rows, e.g. those of the current participant (never another ID's leftovers). */
    retain(keep: (row: StudyRow) => boolean): void {
        const kept = this.queue.filter(keep);
        if (kept.length !== this.queue.length) {
            // A new array: an in-flight upload sees the swap and stops instead of trimming the wrong rows.
            this.queue = kept;
            void this.store.save(this.queue);
        }
    }

    /**
     * Sends one row now, outside the queue and any upload in flight (which may be about to be
     * cleared), with a timeout. For the event that must not be lost: leaving the study.
     */
    async sendNow(row: StudyRow): Promise<boolean> {
        const timeout = new Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>(resolve => setTimeout(() => resolve({ ok: false, status: 0 }), SEND_NOW_TIMEOUT_MS));
        try {
            const response = await Promise.race([this.post([row]), timeout]);
            return response.ok || response.status === 409;
        } catch {
            return false;
        }
    }

    /**
     * Uploads queued events in batches. One flush at a time; after a failure it backs off
     * exponentially (up to 30 minutes) and keeps the events for the next attempt.
     */
    flush(): Promise<void> {
        if (this.sending) {
            return this.sending;
        }
        if (this.queue.length === 0 || this.now() < this.nextAttemptAt) {
            return Promise.resolve();
        }
        this.sending = this.sendAll().finally(() => {
            this.sending = undefined;
        });
        return this.sending;
    }

    private post(rows: StudyRow[]): ReturnType<FetchLike> {
        return this.fetchImpl(`${this.endpoint.url.replace(/\/+$/, "")}/rest/v1/events`, {
            method: "POST",
            headers: {
                "apikey": this.endpoint.anonKey,
                "Authorization": `Bearer ${this.endpoint.anonKey}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            },
            body: JSON.stringify(rows)
        });
    }

    private async sendAll(): Promise<void> {
        // Bisection after a row rejection: halve the batch until the bad row is alone, then grow back
        // after each success, so one bad row among n costs about log2(n) extra requests.
        let batchSize = BATCH_SIZE;
        while (this.queue.length > 0) {
            const sentFrom = this.queue;
            const batch = sentFrom.slice(0, batchSize);
            let ok = false;
            let status = 0;
            let body = "";
            try {
                const response = await this.post(batch);
                ok = response.ok;
                status = response.status;
                if (!ok && response.text) {
                    body = await response.text().catch(() => "");
                }
            } catch {
                ok = false;
            }
            if (ok) {
                this.failures = 0;
                this.nextAttemptAt = 0;
                if (this.queue === sentFrom) {
                    // Events enqueued during the request sit after the batch; remove exactly the batch.
                    this.queue.splice(0, batch.length);
                } else {
                    // clear() or retain() swapped the queue during the request: the batch is stored, so
                    // remove it from the new queue by event_id instead of sending it again.
                    const sent = new Set(batch.map(row => row.event_id));
                    this.queue = this.queue.filter(row => !sent.has(row.event_id));
                }
                await this.store.save(this.queue);
                if (this.queue !== sentFrom) {
                    return;
                }
                batchSize = Math.min(BATCH_SIZE, batchSize * 2);
                continue;
            }
            if (this.queue !== sentFrom) {
                // clear() or retain() ran during the request: the next flush starts from the new queue.
                return;
            }
            // Insert-or-ignore (ON CONFLICT) would need a select policy, which would let the public key
            // read data. So a batch holding an already-stored event fails as a whole (409) and is
            // bisected; a single row rejected for its content is dropped (a 409 row is already stored,
            // so nothing is lost and nothing is reported).
            if (isRowRejection(status, body)) {
                if (batch.length > 1) {
                    batchSize = Math.max(1, Math.floor(batch.length / 2));
                    continue;
                }
                this.queue.splice(0, 1);
                await this.store.save(this.queue);
                if (status !== 409) {
                    this.onDropped(1, status);
                }
                continue;
            }
            this.failures++;
            this.nextAttemptAt = this.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(this.failures - 1, 6));
            return;
        }
    }
}
