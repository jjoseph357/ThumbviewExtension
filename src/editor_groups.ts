// Split-editor bookkeeping for Thumbview: what F4 does, where closing returns to, and which editor
// Thumbview covers in its own group so it can be put back. Works over an injected Workbench facade
// (no vscode import), so every decision is unit tested against simulated editor groups.

export interface TabInfo {
    uri?: string;
    isThumbview: boolean;
    label: string;
}

export interface GroupInfo {
    viewColumn: number;
    isActive: boolean;
    activeTab?: TabInfo;
    tabs: TabInfo[];
}

export interface EditorInfo {
    uri: string;
    /** Undefined when the editor is not visible (e.g. hidden behind Thumbview in its group). */
    viewColumn?: number;
}

export type OpenResult = "opened" | "timeout" | "failed";

export interface Workbench {
    groups(): GroupInfo[];
    /** Shows `uri` in the group at `viewColumn` ("active": the focused group). */
    open(uri: string, viewColumn: number | "active", preserveFocus: boolean): Promise<void>;
    log(line: string): void;
}

export type F4Action = "create" | "close" | "focus-in-place" | "reopen";

export interface F4State {
    panelExists: boolean;
    panelActive: boolean;
    panelVisible: boolean;
    /** Our own open happened within the last second; panel.active may not have caught up. */
    recentlyOpened: boolean;
    fullscreenActive: boolean;
    fullscreenOnOpen: boolean;
}

/**
 * F4 closes only a focused Thumbview. A visible but unfocused one (beside the code in a split, or
 * with the terminal focused) is focused where it is, never moved over the code; in fullscreen mode
 * one that is not fullscreen yet is reopened (entering fullscreen) instead.
 */
export function decideF4(state: F4State): F4Action {
    if (!state.panelExists) {
        return "create";
    }
    if (state.panelActive || state.recentlyOpened) {
        return "close";
    }
    if (state.panelVisible && (state.fullscreenActive || !state.fullscreenOnOpen)) {
        return "focus-in-place";
    }
    return "reopen";
}

export const EDITOR_OPEN_TIMEOUT_MS = 1500;

const fileName = (uri: string) => uri.split("/").pop() || uri;

export class EditorGroupTracker {
    // Where the user was when Thumbview came up (file and group). Closing returns exactly there,
    // not to the last active text editor, which Thumbview's own Zen and maximize steps disturb.
    private returnTo: { uri: string; viewColumn: number } | undefined;
    // The editor Thumbview covered in its own group, put back on close when the return point is
    // in another group (otherwise that group would keep showing Thumbview beside the code).
    private covered: { uri: string; viewColumn: number } | undefined;

    constructor(private readonly workbench: Workbench, private readonly openTimeoutMs = EDITOR_OPEN_TIMEOUT_MS) { }

    /** `fallbackColumn`: the group to assume when the editor is hidden (it was in Thumbview's group). */
    recordReturnPoint(editor: EditorInfo | undefined, fallbackColumn: number | undefined): void {
        const column = editor ? editor.viewColumn ?? fallbackColumn : undefined;
        this.returnTo = editor && column !== undefined ? { uri: editor.uri, viewColumn: column } : undefined;
    }

    clearReturnPoint(): void {
        this.returnTo = undefined;
    }

    get returnPoint(): { uri: string; viewColumn: number } | undefined {
        return this.returnTo;
    }

    /** Each group's active non-Thumbview editor, taken just before Thumbview is revealed or created. */
    snapshot(): Map<number, string> {
        const result = new Map<number, string>();
        for (const group of this.workbench.groups()) {
            if (group.activeTab && !group.activeTab.isThumbview && group.activeTab.uri) {
                result.set(group.viewColumn, group.activeTab.uri);
            }
        }
        return result;
    }

    recordCovered(snapshot: Map<number, string>, column: number | undefined): void {
        const uri = column !== undefined ? snapshot.get(column) : undefined;
        this.covered = column !== undefined && uri ? { uri, viewColumn: column } : undefined;
        this.workbench.log(`Thumbview shown in group ${column ?? "unknown"}, covering ${uri ? fileName(uri) : "nothing recorded"}. ${this.describe()}`);
    }

    /** Opens in a group, bounded: "timeout" means the open may still land, so do not start another. */
    async openInGroup(uri: string, viewColumn: number, preserveFocus: boolean): Promise<OpenResult> {
        // Opening into a column whose group was closed would create a new split.
        const target = this.workbench.groups().some(group => group.viewColumn === viewColumn) ? viewColumn : "active";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<OpenResult>(resolve => {
            timer = setTimeout(() => resolve("timeout"), this.openTimeoutMs);
        });
        const open = this.workbench.open(uri, target, preserveFocus).then((): OpenResult => "opened", (): OpenResult => "failed");
        try {
            return await Promise.race([open, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Returns to the recorded return point with focus. "failed" also when there is none. */
    async returnToEditor(): Promise<OpenResult> {
        if (!this.returnTo) {
            return "failed";
        }
        const { uri, viewColumn } = this.returnTo;
        const result = await this.openInGroup(uri, viewColumn, false);
        this.workbench.log(`Close: ${result === "opened" ? "returned to" : result === "timeout" ? "still opening (timed out waiting for)" : "could not return to"} ${fileName(uri)} in group ${viewColumn}.`);
        return result;
    }

    /**
     * If a group still shows Thumbview, shows the editor Thumbview covered there (falling back to
     * the group's first other editor) without moving focus.
     */
    async restoreCovered(): Promise<OpenResult | "nothing"> {
        const group = this.workbench.groups().find(g => g.tabs.some(tab => tab.isThumbview));
        if (!group || !group.activeTab?.isThumbview) {
            return "nothing";
        }
        const others = group.tabs.filter(tab => !tab.isThumbview && tab.uri);
        const covered = this.covered && this.covered.viewColumn === group.viewColumn
            ? others.find(tab => tab.uri === this.covered!.uri)
            : undefined;
        const target = covered ?? others[0];
        if (!target || !target.uri) {
            this.workbench.log(`Close: Thumbview is alone in group ${group.viewColumn}; nothing to restore.`);
            return "nothing";
        }
        this.workbench.log(`Close: restoring ${fileName(target.uri)} in group ${group.viewColumn} (${covered ? "the covered editor" : "fallback: first other editor"}).`);
        const result = await this.openInGroup(target.uri, group.viewColumn, true);
        this.workbench.log(`Close: ${result === "opened" ? "restored" : result === "timeout" ? `restore did not finish within ${this.openTimeoutMs} ms` : "restore failed"}. ${this.describe()}`);
        return result;
    }

    /** One line describing every editor group, for the trace in the output channel. */
    describe(): string {
        const name = (tab: TabInfo | undefined) => !tab ? "empty" : tab.isThumbview ? "Thumbview" : tab.uri ? fileName(tab.uri) : tab.label;
        return this.workbench.groups().map(group =>
            `group ${group.viewColumn}${group.isActive ? " (focused)" : ""}: showing ${name(group.activeTab)}, tabs [${group.tabs.map(name).join(", ")}]`
        ).join("; ");
    }
}
