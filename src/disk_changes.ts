// Decides the cheapest correct refresh for a batch of file-watcher events, and remembers which files
// changed after a full scan started so the scan's older reads can be corrected. Returns decisions to
// extension.ts; no vscode imports, so it is unit tested directly.

/** One watcher event: `key` is the file's fsPath (RepoFile.id), `rel` its workspace-relative path. */
export interface DiskEvent<U> {
    key: string;
    rel: string;
    uri: U;
}

export interface PendingDiskChanges<U> {
    changed: Map<string, DiskEvent<U>>;
    created: Map<string, DiskEvent<U>>;
    deleted: Map<string, DiskEvent<U>>;
    /** Set by events that change what is listed without naming a shown file (.gitignore, excludes). */
    structural: boolean;
}

export function emptyPendingChanges<U>(): PendingDiskChanges<U> {
    return { changed: new Map(), created: new Map(), deleted: new Map(), structural: false };
}

export interface DiskFacts {
    /** The file is a tile on the map. */
    isShown(key: string): boolean;
    /** The last scan listed the path (it may still be unshown: empty, binary, or past the file cap). */
    isListed(rel: string): boolean;
    /** The last scan listed a file inside this folder path (a deleted folder arrives as one event). */
    containsListed(rel: string): boolean;
    /** A Thumbview ignore pattern hides the path. */
    isIgnored(rel: string): boolean;
}

export interface DiskChangePlan<U> {
    /** Shown files to re-read one by one. */
    toRead: U[];
    /** Created paths that need a listing check (git check-ignore, files.exclude) before a rescan. */
    toCheck: U[];
    /** The listing itself may have changed: run the full scan. */
    rescan: boolean;
}

/**
 * A save or an edit re-reads only shown files. A delete matters only if the path was listed, and a
 * created path only if nothing already hides it, so build output, swap files, and caches cost nothing.
 */
export function planDiskChanges<U>(pending: PendingDiskChanges<U>, facts: DiskFacts): DiskChangePlan<U> {
    const plan: DiskChangePlan<U> = { toRead: [], toCheck: [], rescan: pending.structural };
    for (const event of pending.deleted.values()) {
        if (facts.isShown(event.key) || facts.isListed(event.rel) || facts.containsListed(event.rel)) {
            plan.rescan = true;
        }
    }
    const reads = new Map<string, U>();
    for (const event of pending.created.values()) {
        if (facts.isShown(event.key)) {
            // Atomic saves (write a temp file, rename it over the original) arrive as a create.
            reads.set(event.key, event.uri);
        } else if (!facts.isIgnored(event.rel)) {
            plan.toCheck.push(event.uri);
        }
    }
    for (const event of pending.changed.values()) {
        if (facts.isShown(event.key)) {
            reads.set(event.key, event.uri);
        } else if (facts.isListed(event.rel) && !facts.isIgnored(event.rel)) {
            // Listed but not shown, e.g. an empty file that just got content.
            plan.rescan = true;
        }
    }
    plan.toRead = [...reads.values()];
    return plan;
}

/** True for files whose change alters which files are listed rather than any tile's content. */
export function isListingRuleFile(rel: string): boolean {
    return /(^|\/)\.gitignore$/.test(rel) || /(^|\/)\.git\/info\/exclude$/.test(rel);
}

const MAX_TRACKED_CHANGES = 2000;

/**
 * A full scan may read a file before it changes, then install that old content over the newer
 * incremental re-read. Scans record `current()` when they start; after installing, the files in
 * `changedSince(start)` are read again.
 */
export class ChangeGenerations<U> {
    private generation = 0;
    private readonly changes = new Map<string, { generation: number; uri: U }>();

    current(): number {
        return this.generation;
    }

    record(key: string, uri: U): void {
        this.generation++;
        this.changes.delete(key);
        this.changes.set(key, { generation: this.generation, uri });
        if (this.changes.size > MAX_TRACKED_CHANGES) {
            const oldest = this.changes.keys().next().value;
            if (oldest !== undefined) {
                this.changes.delete(oldest);
            }
        }
    }

    changedSince(generation: number): U[] {
        const result: U[] = [];
        for (const change of this.changes.values()) {
            if (change.generation > generation) {
                result.push(change.uri);
            }
        }
        return result;
    }

    /** Forgets changes that every scan started at or after `generation` has already seen. */
    forgetThrough(generation: number): void {
        for (const [key, change] of this.changes) {
            if (change.generation <= generation) {
                this.changes.delete(key);
            }
        }
    }
}
