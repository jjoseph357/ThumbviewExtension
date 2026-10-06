// Event shapes for the usage study and the pure helpers that build them: salted path hashing,
// validation of the episode summary the webview reports, and per-file visit history. Returns plain
// objects to study.ts; no vscode imports, so it is unit tested. STUDY.md is the data dictionary.
import { createHmac } from "crypto";

export type StudyEventName =
    | "study_enrolled"
    | "study_left"
    | "session_start"
    | "thumbview_shown"
    | "thumbview_episode"
    | "editor_switch"
    | "action"
    | "survey_opened";

export interface StudyEvent {
    event: StudyEventName;
    /** ISO timestamp on the participant's machine. */
    ts: string;
    props: { [key: string]: string | number | boolean | null };
}

/**
 * Stable pseudonym for a file: HMAC-SHA256 keyed by the participant's secret salt (never sent), over
 * the workspace key and the workspace-relative path. The same file always gets the same value for
 * that participant, so revisits and positions can be analyzed, but names cannot be recovered.
 */
export function hashPath(salt: string, workspaceKey: string, relativePath: string): string {
    return createHmac("sha256", salt).update(`${workspaceKey}\0${relativePath.replace(/\\/g, "/")}`).digest("base64url").slice(0, 22);
}

const OUTCOMES = ["jump", "switch_tab", "dismissed"] as const;
const METHODS = ["click", "keyboard", "view_band", "none"] as const;
/** What started the visit's clock: the page's reveal, the host showing the panel, or (fallback) the first interaction. */
const START_SOURCES = ["reveal", "shown", "interaction"] as const;
/** Where the target was chosen: the root grid, an opened folder, or a view of folder cards. */
const VIEW_KINDS = ["root", "folder", "cards"] as const;

function clampInt(value: unknown, max = 1_000_000_000): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    return Math.max(0, Math.min(max, Math.round(value)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return (allowed as readonly unknown[]).includes(value) ? value as T : fallback;
}

/**
 * The webview's summary of one Thumbview visit, reduced to whitelisted, bounded fields. The webview
 * renders workspace content and is less trusted than the host, so nothing else it sends is kept;
 * in particular no text (the search query only as its length).
 */
export function sanitizeEpisode(raw: { [key: string]: unknown }): StudyEvent["props"] {
    const timeToTarget = clampInt(raw.timeToTargetMs ?? raw.sinceRevealMs);
    const focusedDuration = clampInt(raw.focusedDurationMs ?? raw.focusedMs);
    const reactionTime = clampInt(raw.reactionTimeMs ?? raw.firstActionMs);
    const slotCol = clampInt(raw.slotCol ?? raw.targetCol, 100000);
    const slotRow = clampInt(raw.slotRow ?? raw.targetRow, 100000);
    return {
        outcome: oneOf(raw.outcome, OUTCOMES, "dismissed"),
        method: oneOf(raw.method, METHODS, "none"),
        time_to_target_ms: timeToTarget,
        focused_duration_ms: focusedDuration,
        reaction_time_ms: reactionTime,
        // Legacy aliases
        since_reveal_ms: timeToTarget,
        focused_ms: focusedDuration,
        first_action_ms: reactionTime,
        start_source: oneOf(raw.startSource, START_SOURCES, "interaction"),
        search_used: raw.searchUsed === true,
        search_edits: clampInt(raw.searchEdits, 100000),
        query_length: clampInt(raw.queryLength, 10000),
        search_toggles: clampInt(raw.searchToggles, 1000),
        search_match_count: clampInt(raw.searchMatchCount),
        target_matched_search: raw.targetMatchedSearch === true,
        tiles_hovered: clampInt(raw.tilesHovered, 100000),
        magnifier_uses: clampInt(raw.magnifierUses, 100000),
        folder_drill_ins: clampInt(raw.folderDrillIns, 10000),
        folder_back_outs: clampInt(raw.folderBackOuts, 10000),
        keyboard_moves: clampInt(raw.keyboardMoves, 100000),
        slot_col: slotCol,
        slot_row: slotRow,
        // Legacy aliases
        target_col: slotCol,
        target_row: slotRow,
        grid_cols: clampInt(raw.gridCols, 100000),
        grid_rows: clampInt(raw.gridRows, 100000),
        folder_cards_view: raw.folderCardsView === true,
        view_kind: (VIEW_KINDS as readonly unknown[]).includes(raw.viewKind) ? raw.viewKind as string : null,
        focused_folder_depth: clampInt(raw.focusedFolderDepth, 1000),
        file_count: clampInt(raw.fileCount),
        // Reported by the host when the tab was closed mid-visit: the interaction fields are then null.
        tab_closed: raw.tabClosed === true
    };
}

export interface VisitRecord {
    count: number;
    last: number;
}

const MAX_TRACKED_FILES = 20000;

/**
 * Per-file visit counts and last-visit times, keyed by path hash and kept only on the participant's
 * machine; events carry the derived "visit number" and "time since last visit". Several VS Code
 * windows share the stored record, so each window keeps only its own new visits (`pending`) on top
 * of the latest stored record (`base`), and `mergeInto` adds them to whatever is stored now instead
 * of overwriting it with this window's older copy.
 */
export class VisitHistory {
    private pending: { [hash: string]: VisitRecord } = {};

    constructor(private base: { [hash: string]: VisitRecord } = {}) { }

    /** Adopts the latest stored record (another window may have saved visits since). */
    refreshBase(stored: { [hash: string]: VisitRecord }): void {
        this.base = stored;
    }

    /** What is known about a file before this visit: prior visit count and ms since the last one. */
    peek(hash: string, now: number): { priorVisits: number; sinceLastVisitMs: number | null } {
        const stored = this.base[hash];
        const mine = this.pending[hash];
        const count = (stored?.count ?? 0) + (mine?.count ?? 0);
        const last = Math.max(stored?.last ?? -Infinity, mine?.last ?? -Infinity);
        return { priorVisits: count, sinceLastVisitMs: count > 0 && Number.isFinite(last) ? now - last : null };
    }

    /** Records a visit and returns what peek returned before it. */
    record(hash: string, now: number): { priorVisits: number; sinceLastVisitMs: number | null } {
        const before = this.peek(hash, now);
        const mine = this.pending[hash];
        this.pending[hash] = { count: (mine?.count ?? 0) + 1, last: now };
        return before;
    }

    /** Forgets everything (a new participant, after leaving or uninstalling). */
    reset(): void {
        this.base = {};
        this.pending = {};
    }

    get hasPending(): boolean {
        return Object.keys(this.pending).length > 0;
    }

    /** Adds this window's new visits to `stored` (not modified) and returns the record to save. */
    mergeInto(stored: { [hash: string]: VisitRecord }): { [hash: string]: VisitRecord } {
        const merged = { ...stored };
        for (const [hash, mine] of Object.entries(this.pending)) {
            const previous = merged[hash];
            merged[hash] = { count: (previous?.count ?? 0) + mine.count, last: Math.max(previous?.last ?? 0, mine.last) };
        }
        const hashes = Object.keys(merged);
        if (hashes.length > MAX_TRACKED_FILES) {
            hashes.sort((x, y) => merged[x].last - merged[y].last);
            for (const hash of hashes.slice(0, hashes.length - MAX_TRACKED_FILES)) {
                delete merged[hash];
            }
        }
        this.pending = {};
        this.base = merged;
        return merged;
    }
}

/**
 * How long after a Thumbview jump an editor change still counts as that jump's result. Generous
 * because opening a large file can take seconds; the jump is used up by the first matching switch,
 * so it cannot claim a later one.
 */
export const THUMBVIEW_ATTRIBUTION_MS = 10000;

/**
 * Comparable identity for a file path. URI strings differ for the same file on Windows (drive
 * letter case, percent-encoding), so attribution compares file-system paths, case-insensitively
 * on Windows and macOS.
 */
export function fileKey(fsPath: string, platform: string = process.platform): string {
    const normalized = fsPath.replace(/\\/g, "/");
    // Windows and macOS file systems are case-insensitive by default.
    return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/** Whether an editor change was caused by a Thumbview jump, or by any other way of opening a file. */
export function attributeEditorSwitch(key: string, now: number, lastThumbviewTarget: { key: string; at: number } | null): "thumbview" | "other" {
    return lastThumbviewTarget && lastThumbviewTarget.key === key && now - lastThumbviewTarget.at <= THUMBVIEW_ATTRIBUTION_MS
        ? "thumbview"
        : "other";
}

/**
 * Whether an editor change looks like a deliberate file open, as opposed to a side effect: focus moving
 * between split editors (the previous editor is still visible and no tab was opened), or VS Code
 * showing the next tab after one was closed.
 */
export function isDeliberateSwitch(signals: { previousStillVisible: boolean; tabOpened: boolean; tabClosedJustBefore: boolean; viaThumbview: boolean }): boolean {
    if (signals.viaThumbview || signals.tabOpened) {
        return true;
    }
    return !signals.previousStillVisible && !signals.tabClosedJustBefore;
}

/**
 * The host's view of the visit it announced to the webview (studyVisitStart). Open until the webview
 * reports it (studyEpisode) or is told to end it (studyVisitEnd). Closing the tab destroys the page
 * and its summary, so `closedTab` returns the episode to record then: dismissed, with the host's
 * visible time and no interaction counts (`tab_closed`).
 */
export class HostVisitTracker {
    private openSince: number | null = null;

    started(now: number): void {
        this.openSince = now;
    }

    /** The webview reported the visit, or was told to. */
    handedOff(): void {
        this.openSince = null;
    }

    /** `visibleUntil`: now if the panel was visible at dispose, else when it was hidden. */
    closedTab(visibleUntil: number): { [key: string]: unknown } | null {
        if (this.openSince === null) {
            return null;
        }
        const duration = Math.max(0, visibleUntil - this.openSince);
        const episode = {
            outcome: "dismissed",
            method: "none",
            startSource: "shown",
            timeToTargetMs: duration,
            sinceRevealMs: duration,
            tabClosed: true
        };
        this.openSince = null;
        return episode;
    }
}

/** Longest plausible F4-to-reveal time; anything longer was not one open (sleep, a debugger). */
export const MAX_REVEAL_LATENCY_MS = 60_000;

/**
 * Time from the open request (F4 or the Open command, host clock) to the page appearing (the
 * webview's wall clock at completeReveal; same machine). Null when either is unknown or implausible.
 */
export function revealLatencyMs(revealedAtEpochMs: unknown, openRequestedAt: number | null): number | null {
    if (typeof revealedAtEpochMs !== "number" || !Number.isFinite(revealedAtEpochMs) || openRequestedAt === null) {
        return null;
    }
    const latency = revealedAtEpochMs - openRequestedAt;
    return latency >= 0 && latency <= MAX_REVEAL_LATENCY_MS ? Math.round(latency) : null;
}

const MAX_REMEMBERED_SLOTS = 20000;

/**
 * Each file's root-grid slot when it was last chosen in Thumbview, keyed by path hash and kept only
 * on the participant's machine. `moved` answers whether the file sits elsewhere than last time
 * (null on the first visit) and records the new slot; the core covariate for spatial memory.
 */
export class SlotMemory {
    private slots: Map<string, string>;

    constructor(stored: { [hash: string]: string } = {}) {
        this.slots = new Map(Object.entries(stored));
    }

    moved(hash: string, col: number, row: number): boolean | null {
        const slot = `${col},${row}`;
        const previous = this.slots.get(hash);
        // Re-inserted so the map's order is least recently used first.
        this.slots.delete(hash);
        this.slots.set(hash, slot);
        while (this.slots.size > MAX_REMEMBERED_SLOTS) {
            this.slots.delete(this.slots.keys().next().value as string);
        }
        return previous === undefined ? null : previous !== slot;
    }

    toJSON(): { [hash: string]: string } {
        return Object.fromEntries(this.slots);
    }
}
