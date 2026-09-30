import * as vscode from "vscode";
import { scanRepository, ScanIgnoreState, shouldIgnore, RepoFile, isSourceRootRegex, clearScanCache, invalidateScanFile, setScanPriorityProvider } from "./scanner";
import { isAlwaysExcluded } from "./file_discovery";
import { isSafeRelativePath, isSafeWebviewMessage } from "./message_guard";
import { isThumbviewViewType, THUMBVIEW_VIEW_TYPE } from "./webview_tabs";
import { PanelSession } from "./panel_session";
import { decideF4, EditorGroupTracker, type EditorInfo, type GroupInfo, type TabInfo } from "./editor_groups";
import { buildStableGrid, slotToIndex, findSlotIndex, MIN_GRID_COLS, MIN_GRID_ROWS } from "./layout";
import { buildSpanningGrid, cellsNeeded, SpanningPlacement, DEFAULT_BASE_LINES_PER_CELL, DEFAULT_COMPRESSION_PCT } from "./spanning_layout";
import { PersistentFileOrder } from "./state";
import { createReentrantLock, createCoalescedToggle } from "./locks";
import { applyZenOverrides, ConfigLike, ZEN_ENTERED_KEY, ZEN_OWNER_HEARTBEAT_MS, ZEN_OWNER_STALE_MS, claimZenOwnership, hasOtherLiveOwners, releaseZenOwnership } from "./zen_settings";

function getCompressionPct(): number {
    const raw = vscode.workspace.getConfiguration("thumbview").get<number>("compressionPercentage") ?? 5;
    if (raw <= 0) return 0;
    const pct = raw >= 1 ? raw / 100 : raw;
    return Math.max(0, Math.min(0.25, pct));
}
import { IgnoreTreeItem } from "./ignoreProvider";
import { DirectoryTreeItem } from "./directoryProvider";
import { fetchWorkspaceGitDiff, getCachedGitDiff } from "./git";
import { ACCENT_SEARCH, withAlpha } from "./colors";
import { getHtml } from "./webview_html";

// Re-exported for scripts/capture-screenshots.mjs, which renders the page headlessly from the bundle.
export { getHtml } from "./webview_html";
import { clampTargetToGridCapacity, reorderFolderItems, reorderCardItems, reorderSpanningItems, expandSpanningGridOrder, reduceSpanningGridOrder } from "./reorder_helpers";

import * as fs from "fs";
import * as path from "path";

/** performance.now() marks for one file opened from Thumbview, logged by switchLeavingFullscreen. */
interface SwitchTiming {
    label: string;
    receivedAt: number;
    lockedAt: number;
    loadedAt?: number;
}

export async function activate(context: vscode.ExtensionContext) {
    // Diagnostics for users and bug reports (View > Output > Thumbview), e.g. where the time goes
    // when a file is opened from Thumbview.
    const log = vscode.window.createOutputChannel("Thumbview", { log: true });
    context.subscriptions.push(log);
    console.log("THUMBVIEW EXTENSION ACTIVATED");

    // --- Helpers: read/write ignore state from workspaceState (never touches .vscode/settings.json) ---
    const getIgnoreState = (): ScanIgnoreState => ({
        ignorePatterns: context.workspaceState.get<string[]>("thumbview.ignorePatterns") ?? [],
        autoIgnoreExclusions: context.workspaceState.get<string[]>("thumbview.autoIgnoreExclusions") ?? []
    });
    const persistIgnoreState = async (state: ScanIgnoreState): Promise<void> => {
        await context.workspaceState.update("thumbview.ignorePatterns", state.ignorePatterns);
        await context.workspaceState.update("thumbview.autoIgnoreExclusions", state.autoIgnoreExclusions);
    };

    // --- One-time migration: move old settings.json values into workspaceState, then delete them ---
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const config = vscode.workspace.getConfiguration("thumbview", workspaceFolders[0].uri);
        const inspected = config.inspect<string[]>("ignorePatterns");
        const oldPatterns = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
        const inspectedExcl = config.inspect<string[]>("autoIgnoreExclusions");
        const oldExclusions = inspectedExcl?.workspaceFolderValue ?? inspectedExcl?.workspaceValue;

        if (oldPatterns || oldExclusions) {
            const current = getIgnoreState();
            const mergedPatterns = Array.from(new Set([...current.ignorePatterns, ...(oldPatterns ?? [])]));
            const mergedExclusions = Array.from(new Set([...current.autoIgnoreExclusions, ...(oldExclusions ?? [])]));
            await persistIgnoreState({ ignorePatterns: mergedPatterns, autoIgnoreExclusions: mergedExclusions });
            // Remove from settings.json so .vscode/ can be deleted
            if (oldPatterns) {
                const target = inspected?.workspaceFolderValue
                    ? vscode.ConfigurationTarget.WorkspaceFolder
                    : vscode.ConfigurationTarget.Workspace;
                await config.update("ignorePatterns", undefined, target);
            }
            if (oldExclusions) {
                const target = inspectedExcl?.workspaceFolderValue
                    ? vscode.ConfigurationTarget.WorkspaceFolder
                    : vscode.ConfigurationTarget.Workspace;
                await config.update("autoIgnoreExclusions", undefined, target);
            }
        }
    }

    // --- One-time migration: rename legacy repomap.* workspaceState keys to thumbview.* ---
    // Added in 0.3.1 (2026-08-05). TODO: once we're confident most users have upgraded past
    // this version, delete this block and switch the reads/writes below back to plain
    // "thumbview.seenFiles" / "thumbview.spanningAllocations" / "thumbview.spanningRows"
    // literals (no fallback needed) — the repomap.* keys can be assumed gone by then.
    const legacyStateKeyMigrations: [string, string][] = [
        ["repomap.seenFiles", "thumbview.seenFiles"],
        ["repomap.spanningAllocations", "thumbview.spanningAllocations"],
        ["repomap.spanningRows", "thumbview.spanningRows"]
    ];
    for (const [oldKey, newKey] of legacyStateKeyMigrations) {
        const oldValue = context.workspaceState.get(oldKey);
        if (oldValue !== undefined) {
            if (context.workspaceState.get(newKey) === undefined) {
                await context.workspaceState.update(newKey, oldValue);
            }
            await context.workspaceState.update(oldKey, undefined);
        }
    }

    // Auto-populate ignorePatterns with workspace .gitignore rules once initialized and sanitize stale source ignore rules
    if (workspaceFolders && workspaceFolders.length > 0) {
        const gitignorePath = path.join(workspaceFolders[0].uri.fsPath, ".gitignore");
        const actualGitignoreRules = new Set<string>();
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, "utf-8");
                content
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith("#"))
                    .forEach(rule => {
                        actualGitignoreRules.add(rule);
                        actualGitignoreRules.add(rule.replace(/^\/+|\/+$/g, ""));
                    });
            } catch {
            }
        }

        const { ignorePatterns, autoIgnoreExclusions } = getIgnoreState();
        const exclusionSet = new Set(autoIgnoreExclusions.map(e => e.trim().replace(/^\/+|\/+$/g, "")));
        const isExcluded = (pat: string) => {
            const clean = pat.trim().replace(/^\/+|\/+$/g, "");
            return exclusionSet.has(clean) || autoIgnoreExclusions.includes(pat);
        };

        const updatedIgnored = [...ignorePatterns];
        let changed = false;

        for (const rule of actualGitignoreRules) {
            if (!updatedIgnored.includes(rule) && !isExcluded(rule)) {
                updatedIgnored.push(rule);
                changed = true;
            }
        }

        if (changed) {
            await persistIgnoreState({ ignorePatterns: updatedIgnored, autoIgnoreExclusions });
        }
    }

    const fileOrder = new PersistentFileOrder();
    setScanPriorityProvider(() => fileOrder.getOrder().filter(Boolean));
    const savedOrder = context.workspaceState.get<string[]>("thumbview.seenFiles");
    if (savedOrder) {
        fileOrder.update(savedOrder);
    }

    const cursorLocations: { [uri: string]: number } = {};
    let lastSpanningPlacements: SpanningPlacement[] = [];

    let lastActiveTextEditor: vscode.TextEditor | undefined;
    let activePanel: vscode.WebviewPanel | undefined;
    let lastCopiedItem: { uri: vscode.Uri; isFolder: boolean; isCut: boolean } | null = null;

    // Reads the user setting fresh each call (rather than caching) so a config change
    // picked up by the onDidChangeConfiguration listener below is always honored.
    const getLayoutMode = (): "uniform_grid" | "spanning_grid" => {
        const config = vscode.workspace.getConfiguration("thumbview");
        const mode = config.get<string>("layoutMode");
        return mode === "uniform_grid" ? "uniform_grid" : "spanning_grid";
    };

    const getDragReorderMode = (): "swap" | "shift" => {
        const config = vscode.workspace.getConfiguration("thumbview");
        const mode = config.get<string>("dragReorderMode");
        return mode === "swap" ? "swap" : "shift";
    };

    // Four progressively-fainter pink decoration types used to fade a "jump" search
    // match out over ~2s (see the "jump" message handler below) instead of an abrupt
    // on/off highlight — VS Code decorations don't support CSS transitions, so the
    // fade is faked by swapping between discrete opacity steps on a timer.
    const searchFlashSteps = [
        vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: withAlpha(ACCENT_SEARCH, 0.35),
            border: `1px dashed ${ACCENT_SEARCH}`,
            overviewRulerColor: ACCENT_SEARCH,
            overviewRulerLane: vscode.OverviewRulerLane.Full
        }),
        vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: withAlpha(ACCENT_SEARCH, 0.22),
            border: `1px dashed ${withAlpha(ACCENT_SEARCH, 0.6)}`,
            overviewRulerColor: withAlpha(ACCENT_SEARCH, 0.6),
            overviewRulerLane: vscode.OverviewRulerLane.Full
        }),
        vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: withAlpha(ACCENT_SEARCH, 0.12),
            border: `1px dashed ${withAlpha(ACCENT_SEARCH, 0.3)}`,
            overviewRulerColor: withAlpha(ACCENT_SEARCH, 0.3),
            overviewRulerLane: vscode.OverviewRulerLane.Full
        }),
        vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: withAlpha(ACCENT_SEARCH, 0.05),
            border: `1px dashed ${withAlpha(ACCENT_SEARCH, 0.15)}`,
            overviewRulerColor: withAlpha(ACCENT_SEARCH, 0.15),
            overviewRulerLane: vscode.OverviewRulerLane.Full
        })
    ];

    // Map of open file URIs to their active visible viewport ranges { startLine, endLine, scrollLine }
    let viewLocations: { [uri: string]: { startLine: number; endLine: number; scrollLine: number } } = {};

    const getOpenTabUris = (): string[] => {
        const uris = new Set<string>();
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input: any = tab.input;
                if (input && input.uri && typeof input.uri.toString === "function") {
                    uris.add(input.uri.toString());
                } else if (input && input.resource && typeof input.resource.toString === "function") {
                    uris.add(input.resource.toString());
                }
            }
        }
        return Array.from(uris);
    };

    const sendOpenState = () => {
        updateVisibleRanges();
        if (session.openStateHeld) {
            // A file is opening over Thumbview; the reopen path sends the latest state.
            return;
        }
        if (activePanel) {
            const activeUri = lastActiveTextEditor?.document.uri.toString() || null;
            activePanel.webview.postMessage({
                command: "openState",
                activeFileUri: activeUri,
                openFiles: getOpenTabUris(),
                viewLocations
            });
        }
    };

    const formatKeybindingString = (key: string): string => {
        return key
            .split("+")
            .map((part: string) => {
                const trimmed = part.trim();
                if (/^f\d+$/i.test(trimmed)) {
                    return trimmed.toUpperCase();
                }
                const lower = trimmed.toLowerCase();
                if (lower === "ctrl") return "Ctrl";
                if (lower === "shift") return "Shift";
                if (lower === "alt") return "Alt";
                if (lower === "cmd" || lower === "meta" || lower === "win") return "Cmd";
                return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
            })
            .join("+");
    };

    // Shows the user's own binding for thumbview.open in the UI. There is no API for resolved
    // keybindings, so read the file VS Code uses for this profile: the nearest keybindings.json
    // above this extension's globalStorage (User/ for the default profile, User/profiles/<id>/
    // for others). Under Remote/WSL the extension runs on the remote host, where no such file
    // exists, so the label falls back to "F4". Cached by mtime: consulted on every payload.
    let keybindingLabelCache: { mtimeMs: number; label: string } | undefined;
    const detectOpenKeybinding = (): string => {
        try {
            const candidates: string[] = [];
            if (context.globalStorageUri && context.globalStorageUri.scheme === "file") {
                for (let up = 1; up <= 3; up++) {
                    candidates.push(path.resolve(context.globalStorageUri.fsPath, ...new Array(up).fill(".."), "keybindings.json"));
                }
            }

            for (const keybindingsPath of candidates) {
                if (keybindingsPath && fs.existsSync(keybindingsPath)) {
                    const mtimeMs = fs.statSync(keybindingsPath).mtimeMs;
                    if (keybindingLabelCache && keybindingLabelCache.mtimeMs === mtimeMs) {
                        return keybindingLabelCache.label;
                    }
                    const label = labelFromKeybindingsFile(fs.readFileSync(keybindingsPath, "utf-8"));
                    keybindingLabelCache = { mtimeMs, label };
                    return label;
                }
            }
        } catch {
        }
        return "F4";
    };

    const labelFromKeybindingsFile = (raw: string): string => {
        let foundPositiveBinding: string | null = null;
        let hasUnassigned = false;
        try {
            const stripped = raw
                .replace(/\/\/.*$/gm, "")
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/,\s*([}\]])/g, "$1");
            const parsed = JSON.parse(stripped);
            if (Array.isArray(parsed)) {
                for (let i = parsed.length - 1; i >= 0; i--) {
                    const entry = parsed[i];
                    if (entry && entry.command === "thumbview.open" && typeof entry.key === "string" && !foundPositiveBinding) {
                        foundPositiveBinding = formatKeybindingString(entry.key);
                    }
                    if (entry && entry.command === "-thumbview.open") {
                        hasUnassigned = true;
                    }
                }
            }
        } catch {
        }
        if (foundPositiveBinding) {
            return foundPositiveBinding;
        }

        // Fallback when the file is not valid JSONC after stripping (e.g. mid-edit).
        const positiveMatches = Array.from(raw.matchAll(/\{[^{}]*?"command"\s*:\s*"thumbview\.open"[^{}]*?\}/gi));
        if (positiveMatches.length > 0) {
            const lastPosMatch = positiveMatches[positiveMatches.length - 1][0];
            const keyMatch = /"key"\s*:\s*"([^"]+)"/i.exec(lastPosMatch);
            if (keyMatch && keyMatch[1]) {
                return formatKeybindingString(keyMatch[1]);
            }
        }
        if (hasUnassigned || /"command"\s*:\s*"-thumbview\.open"/i.test(raw)) {
            return "Unassigned";
        }
        return "F4";
    };

    const getOpenKeybindingLabel = (): string => detectOpenKeybinding();

    let cachedScannedFiles: RepoFile[] | null = null;
    // Updates that arrive while the retained panel is hidden are deferred to the next reveal
    // instead of re-posting the whole workspace payload to a webview nobody can see.
    let hiddenRefreshPending: "layout" | "rescan" | null = null;

    // The scanner reuses a RepoFile object while its file is unchanged and updateDocumentInCache
    // replaces the object on edit, so object identity is a content version. The webview keys its
    // search index and tile rasters on it instead of re-deriving a content signature.
    const contentVersions = new WeakMap<RepoFile, number>();
    let nextContentVersion = 1;
    const getContentVersion = (file: RepoFile): number => {
        let version = contentVersions.get(file);
        if (version === undefined) {
            version = nextContentVersion++;
            contentVersions.set(file, version);
        }
        return version;
    };

    const updateDocumentInCache = (doc: vscode.TextDocument) => {
        if (doc.uri.scheme !== "file" || doc.lineCount === 0 || !cachedScannedFiles) {
            return;
        }
        const fsPath = doc.uri.fsPath;
        const index = cachedScannedFiles.findIndex(f => f.id === fsPath);
        if (index === -1) {
            return;
        }

        const MAX_LINES = 2000;
        const MAX_LINE_LENGTH = 300;
        const step = doc.lineCount > MAX_LINES ? doc.lineCount / MAX_LINES : 1;

        const rawLines = [];
        for (let idx = 0; idx < Math.min(doc.lineCount, MAX_LINES); idx++) {
            const i = Math.floor(idx * step);
            if (i >= doc.lineCount) break;

            let textLine = doc.lineAt(i).text;
            if (textLine.length > MAX_LINE_LENGTH) {
                textLine = textLine.substring(0, MAX_LINE_LENGTH);
            }
            const trimmedRight = textLine.trimEnd();
            const indent = textLine.length - textLine.trimStart().length;
            const len = trimmedRight.length;

            rawLines.push({
                text: textLine,
                indent,
                length: len,
                category: "normal" as const
            });
        }

        let fullLines: string[] | undefined = undefined;
        if (doc.lineCount > MAX_LINES) {
            fullLines = [];
            for (let i = 0; i < doc.lineCount; i++) {
                let text = doc.lineAt(i).text;
                if (text.length > MAX_LINE_LENGTH) {
                    text = text.substring(0, MAX_LINE_LENGTH);
                }
                fullLines.push(text);
            }
        }

        cachedScannedFiles[index] = {
            ...cachedScannedFiles[index],
            lines: rawLines,
            lineCount: doc.lineCount,
            fullLines
        };
    };

    const getWorkspaceDiagnostics = (): Map<string, { hasError: boolean; errorCount: number; errorLines: { [line0: number]: string } }> => {
        const map = new Map<string, { hasError: boolean; errorCount: number; errorLines: { [line0: number]: string } }>();
        const allDiags = vscode.languages.getDiagnostics();
        for (const [uri, diags] of allDiags) {
            if (uri.scheme !== "file") {
                continue;
            }
            const errorDiags = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            if (errorDiags.length > 0) {
                const errorLines: { [line0: number]: string } = {};
                for (const d of errorDiags) {
                    const startLine = d.range.start.line;
                    const endLine = d.range.end.line;
                    for (let l = startLine; l <= endLine; l++) {
                        errorLines[l] = d.message;
                    }
                }
                const normalizedPath = uri.fsPath.replace(/\\/g, "/");
                const entry = {
                    hasError: true,
                    errorCount: errorDiags.length,
                    errorLines
                };
                map.set(normalizedPath, entry);
                map.set(uri.toString(), entry);
            }
        }
        return map;
    };

    let cachedAllRelativePaths: string[] = [];
    const getAllWorkspaceRelativePaths = async (): Promise<string[]> => {
        try {
            const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git}/**");
            cachedAllRelativePaths = uris.map(u => vscode.workspace.asRelativePath(u).replace(/\\/g, "/"));
            return cachedAllRelativePaths;
        } catch {
            return cachedAllRelativePaths;
        }
    };

    let cachedIgnoreCountsKey = "";
    let cachedIgnoreCountsResult: { counts: { [pat: string]: number }; filesMap: { [pat: string]: string[] } } | null = null;

    const computeIgnoreCounts = (patterns: string[], allPaths: string[]): { counts: { [pat: string]: number }; filesMap: { [pat: string]: string[] } } => {
        const key = `${allPaths.length}:${patterns.join("|")}`;
        if (cachedIgnoreCountsResult && cachedIgnoreCountsKey === key) {
            return cachedIgnoreCountsResult;
        }
        const counts: { [pat: string]: number } = {};
        const filesMap: { [pat: string]: string[] } = {};
        for (const pat of patterns) {
            counts[pat] = 0;
            filesMap[pat] = [];
        }
        for (const p of allPaths) {
            for (const pat of patterns) {
                if (shouldIgnore(p, [pat])) {
                    counts[pat] = (counts[pat] || 0) + 1;
                    if (filesMap[pat].length < 100) {
                        filesMap[pat].push(p);
                    }
                }
            }
        }
        cachedIgnoreCountsKey = key;
        cachedIgnoreCountsResult = { counts, filesMap };
        return cachedIgnoreCountsResult;
    };

    // Serializes every read-modify-write of persisted layout orders (fileOrder, folderOrders,
    // folderCardOrders, cardOrder). Drag handlers await between their read and write, so without
    // this a concurrent payload or saveLayoutOrder could overwrite their change and move a tile.
    // Re-entrant through AsyncLocalStorage: a handler that already holds the lock and calls
    // updateLayoutFromCache runs it inline instead of deadlocking.
    const withOrderLock = createReentrantLock();

    // Every Zen/maximize layout sequence (open, close, jump, switchTab, view-state exit) runs one at
    // a time. Overlapping sequences stacked blind toggleZenMode/toggleMaximizeEditorGroup calls,
    // desynced fullscreenActive from the real Zen state, and hammered the workbench layout.
    const withLayoutLock = createReentrantLock();
    // Timer callbacks scheduled inside a locked task inherit its AsyncLocalStorage context; run
    // them detached so they queue for the locks like any other caller.
    const detachFromLocks = <T>(fn: () => T): T => withLayoutLock.exit(() => withOrderLock.exit(fn));

    // Minimum spanning cell counts for files that filled a taller hole (fillLayoutHoles in state.ts),
    // per layout scope: "root", "folder:<path>" (drill-down files), "cards:<path>" ("cards:" = root
    // cards). Scoped because a file filling a hole in one view must not grow, and re-flow, another.
    type FootprintsByScope = { [scope: string]: { [id: string]: number } };
    const getAllSlotFootprints = () => context.workspaceState.get<FootprintsByScope>("thumbview.slotFootprints") || {};
    const getSlotFootprints = (scope: string) => getAllSlotFootprints()[scope] || {};
    const mergeSlotFootprints = async (scope: string, added: { [id: string]: number }) => {
        if (Object.keys(added).length === 0) {
            return;
        }
        const all = getAllSlotFootprints();
        all[scope] = { ...(all[scope] || {}), ...added };
        await context.workspaceState.update("thumbview.slotFootprints", all);
    };
    // Frozen flow cells (column-membership heights) for webview-owned scopes, same keys as footprints.
    const getAllSlotFlowCells = () => context.workspaceState.get<FootprintsByScope>("thumbview.slotFlowCells") || {};
    const mergeSlotFlowCells = async (scope: string, added: { [id: string]: number }) => {
        if (Object.keys(added).length === 0) {
            return;
        }
        const all = getAllSlotFlowCells();
        all[scope] = { ...(all[scope] || {}), ...added };
        await context.workspaceState.update("thumbview.slotFlowCells", all);
    };
    const layoutScopeKey = (scope: unknown, folder: unknown) =>
        scope === "folderFiles" ? `folder:${folder}` : `cards:${scope === "folderCards" ? folder : ""}`;

    // Delta payloads: contentVersion of each file whose lines the webview already holds. Unchanged
    // files are sent without `lines`/`fullLines` (`linesOmitted: true`), so a diagnostics or git
    // update no longer re-serializes the whole workspace. Reset whenever a fresh webview loads
    // ("ready"); the webview asks for anything it is missing ("requestFileLines").
    const postedContentVersions = new Map<string, number>();
    // Lines go out as plain strings: the webview reads only their text, and string arrays are
    // about half the size of {text, indent, length, category} objects and several times faster
    // to clone across the webview boundary (see DESIGN.md "Scale benchmark").
    const withDeltaLines = <T extends { id: string; contentVersion: number; lines: { text: string }[]; fullLines?: unknown }>(files: T[]) =>
        files.map(file => {
            if (postedContentVersions.get(file.id) === file.contentVersion) {
                const { lines: _lines, fullLines: _fullLines, ...rest } = file;
                return { ...rest, lines: [] as string[], linesOmitted: true };
            }
            postedContentVersions.set(file.id, file.contentVersion);
            return { ...file, lines: file.lines.map(line => line.text) };
        });

    const updateLayoutFromCache = (panel: vscode.WebviewPanel, forceBreakBeforeId?: string): Promise<void> =>
        withOrderLock(() => updateLayoutFromCacheLocked(panel, forceBreakBeforeId));

    // Times building and delivering each data payload (View > Output > Thumbview): the host half of
    // first-open time, which the webview benchmark cannot see. The first payload per panel is
    // logged at info level, later ones at debug.
    const dataPostsByPanel = new WeakMap<vscode.WebviewPanel, number>();
    let layoutStartedAt = 0;
    const postData = (panel: vscode.WebviewPanel, message: { files: unknown[]; [field: string]: unknown }) => {
        const builtAt = performance.now();
        const count = (dataPostsByPanel.get(panel) ?? 0) + 1;
        dataPostsByPanel.set(panel, count);
        panel.webview.postMessage(message).then(() => {
            const line = `Data payload ${count} (${message.files.length} files): built in ${Math.round(builtAt - layoutStartedAt)} ms, delivered in ${Math.round(performance.now() - builtAt)} ms`;
            if (count === 1) {
                log.info(line);
            } else {
                log.debug(line);
            }
        }, () => { });
    };

    const updateLayoutFromCacheLocked = async (panel: vscode.WebviewPanel, forceBreakBeforeId?: string) => {
        layoutStartedAt = performance.now();
        if (!cachedScannedFiles) {
            await refreshThumbview(panel);
            return;
        }

        try {
            const { ignorePatterns } = getIgnoreState();
            const activeFiles = cachedScannedFiles.filter(file => !shouldIgnore(file.path, ignorePatterns));

            const allPaths = cachedAllRelativePaths.length > 0
                ? cachedAllRelativePaths
                : cachedScannedFiles.map(f => f.path);
            const { counts: ignorePatternCounts, filesMap: ignoredFilesMap } = computeIgnoreCounts(ignorePatterns, allPaths);

            const activeFileIds = activeFiles.map(f => f.id);
            const mode = getLayoutMode();
            const folderOrders = context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderOrders") || {};

            // Natural spanning cell counts, recorded in every layout mode and kept for ignored/deleted
            // ids too, so a hole is sized as its file was even after switching modes, and webview
            // folder/card views can size holes (spanningHoleCells).
            const naturalCompressionPct = getCompressionPct();
            const cellsById = new Map(activeFiles.map(f => [f.id, cellsNeeded(f.lineCount, DEFAULT_BASE_LINES_PER_CELL, naturalCompressionPct)]));
            const naturalCells = context.workspaceState.get<{ [id: string]: number }>("thumbview.naturalCells") || {};
            let naturalChanged = false;
            for (const [id, cells] of cellsById) {
                if (naturalCells[id] !== cells) {
                    naturalCells[id] = cells;
                    naturalChanged = true;
                }
            }
            if (naturalChanged) {
                await context.workspaceState.update("thumbview.naturalCells", naturalCells);
            }

            if (mode === "spanning_grid") {
                const savedAllocations = context.workspaceState.get<{ [id: string]: number }>("thumbview.spanningAllocations") || {};

                // New files fill the earliest hole they fit in (a hole keeps the removed file's
                // frozen height) and otherwise append; savedRows is left alone, so no existing
                // tile moves. See fillLayoutHoles in state.ts.
                const newFootprints = fileOrder.update(
                    activeFileIds,
                    id => cellsById.get(id) ?? 1,
                    id => savedAllocations[id] ?? naturalCells[id] ?? 1
                );
                await mergeSlotFootprints("root", newFootprints);
            } else {
                fileOrder.update(activeFileIds);
            }
            await context.workspaceState.update("thumbview.seenFiles", fileOrder.getOrder());

            const order = fileOrder.getOrder();
            const dragReorderMode = getDragReorderMode();
            const config = vscode.workspace.getConfiguration("thumbview");
            const renderMediaThumbnails = config.get<boolean>("renderMediaThumbnails") ?? true;
            const minCellWidth = config.get<number>("minCellWidth") ?? 60;
            const minCellHeight = config.get<number>("minCellHeight") ?? 40;
            const autoIgnoreThreshold = config.get<number>("autoIgnoreThreshold") ?? 30;
            const compressionPercentage = config.get<number>("compressionPercentage") ?? 5;
            const compressionPct = getCompressionPct();
            const openKeybinding = getOpenKeybindingLabel();
            const gitDiff = getCachedGitDiff();
            fetchWorkspaceGitDiff().catch(() => {});

            const extraCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
            const extraRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;

            const workspaceDiagnostics = getWorkspaceDiagnostics();
            const filesWithWebviewUris = activeFiles.map(file => {
                const normalizedId = file.id.replace(/\\/g, "/");
                const gitInfo = gitDiff.get(normalizedId);
                const diagInfo = workspaceDiagnostics.get(normalizedId) || workspaceDiagnostics.get(file.uri);
                let mediaUri = file.mediaUri;
                if ((file.isImage || file.isPdf) && file.mediaUri) {
                    try {
                        mediaUri = panel.webview.asWebviewUri(vscode.Uri.parse(file.uri)).toString();
                    } catch { }
                }
                return {
                    ...file,
                    contentVersion: getContentVersion(file),
                    mediaUri,
                    gitStatus: gitInfo?.status,
                    gitChanges: gitInfo?.lines,
                    hasError: diagInfo?.hasError ?? false,
                    errorCount: diagInfo?.errorCount ?? 0,
                    errorLines: diagInfo?.errorLines ?? {}
                };
            });

            if (mode === "spanning_grid") {
                const savedAllocations = context.workspaceState.get<{ [id: string]: number }>("thumbview.spanningAllocations") || {};
                let savedRows = context.workspaceState.get<number | null>("thumbview.spanningRows") || null;

                // Flow cells (persisted in spanningAllocations) are frozen when a file is first
                // placed and decide its column; display cells follow the current line count. So a
                // growing or shrinking file pushes files within its column but never re-wraps
                // anything into another column. A file that filled a taller hole displays at least
                // the hole's height (footprint). Reflow clears both.
                const flowAllocations: { [id: string]: number } = { ...savedAllocations };
                const displayCells: { [id: string]: number } = {};
                const footprints = getSlotFootprints("root");
                for (const f of filesWithWebviewUris) {
                    const shown = Math.max(cellsNeeded(f.lineCount, DEFAULT_BASE_LINES_PER_CELL, compressionPct), footprints[f.id] || 0);
                    displayCells[f.id] = shown;
                    if (flowAllocations[f.id] === undefined) {
                        flowAllocations[f.id] = shown;
                    }
                }

                const layout = buildSpanningGrid(filesWithWebviewUris, order, flowAllocations, savedRows, forceBreakBeforeId ?? null, 16 / 9, DEFAULT_BASE_LINES_PER_CELL, compressionPct, displayCells);
                lastSpanningPlacements = layout.placements;

                await context.workspaceState.update("thumbview.spanningAllocations", layout.allocations);
                await context.workspaceState.update("thumbview.spanningRows", layout.wrapRows);

                const filesWithSlots = withDeltaLines(layout.placements.map(p => ({
                    ...p.file,
                    slot: [p.col, p.row],
                    nCells: p.nCells,
                    slots: p.slots
                })));

                postData(panel, {
                    command: "data",
                    mode: "spanning_grid",
                    // naturalCells (including ignored/deleted ids) and per-scope slotFootprints let
                    // webview folder/card views size holes and filled holes (overview.js spanningHoleCells).
                    naturalCells: context.workspaceState.get<{ [id: string]: number }>("thumbview.naturalCells") || {},
                    slotFootprints: getAllSlotFootprints(),
                    // "root" carries the host's frozen root flow cells so webview drags simulate the same flow.
                    slotFlowCells: { ...getAllSlotFlowCells(), root: layout.allocations },
                    dragReorderMode,
                    renderMediaThumbnails,
                    fullscreenOnOpen: isFullscreenOnOpen(),
                    // In-grid legend of the non-obvious keys, until dismissed ("dismissShortcutLegend").
                    showShortcutLegend: !context.globalState.get<boolean>(SHORTCUT_LEGEND_DISMISSED_KEY),
                    compressionPercentage,
                    autoIgnoreThreshold,
                    minCellWidth,
                    minCellHeight,
                    openKeybinding,
                    ignorePatterns,
                    ignorePatternCounts,
                    ignoredFilesMap,
                    extraCols,
                    extraRows,
                    cardOrder: context.workspaceState.get<string[]>("thumbview.cardOrder") || [],
                    cardWrapRows: context.workspaceState.get<number>("thumbview.cardWrapRows") || null,
                    folderOrders,
                    folderCardOrders: context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderCardOrders") || {},
                    folderCardWrapRows: context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderCardWrapRows") || {},
                    folderWrapRows: context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderWrapRows") || {},
                    folderExtraCols: context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {},
                    folderExtraRows: context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {},
                    fileOrder: order,
                    files: filesWithSlots,
                    layout: {
                        cols: layout.cols + extraCols,
                        rows: layout.rows + extraRows,
                        wrapRows: layout.wrapRows,
                        flowCols: layout.flowCols + extraCols,
                        flowRows: layout.flowRows + extraRows
                    }
                });
            } else { // uniform grid (default)
                const layout = buildStableGrid(order.length);

                const orderIndex = new Map(order.map((id, i) => [id, i]));
                const slotIndexOf = (id: string) => orderIndex.get(id) ?? -1;
                const filesWithSlots = filesWithWebviewUris.map(file => ({
                    ...file,
                    slot: layout.slots[slotIndexOf(file.id)],
                    nCells: 1,
                    slots: [layout.slots[slotIndexOf(file.id)]]
                }));

                // sort so that array order reflects the user's custom order because subfolder views
                // build their grids by iterating this array directly (ignoring slot position)
                filesWithSlots.sort((a, b) => slotIndexOf(a.id) - slotIndexOf(b.id));
                const deltaFiles = withDeltaLines(filesWithSlots);

                let ugMaxCol = 0, ugMaxRow = 0;
                for (const f of filesWithSlots) {
                    if (f.slot) {
                        ugMaxCol = Math.max(ugMaxCol, f.slot[0]);
                        ugMaxRow = Math.max(ugMaxRow, f.slot[1]);
                    }
                }

                postData(panel, {
                    command: "data",
                    mode: "uniform_grid",
                    dragReorderMode,
                    renderMediaThumbnails,
                    fullscreenOnOpen: isFullscreenOnOpen(),
                    // In-grid legend of the non-obvious keys, until dismissed ("dismissShortcutLegend").
                    showShortcutLegend: !context.globalState.get<boolean>(SHORTCUT_LEGEND_DISMISSED_KEY),
                    compressionPercentage,
                    autoIgnoreThreshold,
                    minCellWidth,
                    minCellHeight,
                    openKeybinding,
                    ignorePatterns,
                    ignorePatternCounts,
                    ignoredFilesMap,
                    extraCols,
                    extraRows,
                    cardOrder: context.workspaceState.get<string[]>("thumbview.cardOrder") || [],
                    cardWrapRows: context.workspaceState.get<number>("thumbview.cardWrapRows") || null,
                    folderOrders,
                    folderCardOrders: context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderCardOrders") || {},
                    folderCardWrapRows: context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderCardWrapRows") || {},
                    folderWrapRows: context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderWrapRows") || {},
                    folderExtraCols: context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {},
                    folderExtraRows: context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {},
                    fileOrder: order,
                    files: deltaFiles,
                    layout: {
                        cols: Math.max(layout.cols + extraCols, ugMaxCol + 1),
                        rows: Math.max(layout.rows + extraRows, ugMaxRow + 1),
                        slots: layout.slots
                    }
                });
            }

            panel.webview.postMessage({
                command: "openState",
                openFiles: getOpenTabUris(),
                viewLocations
            });

            if (vscode.window.activeTextEditor) {
                panel.webview.postMessage({
                    command: "activeFile",
                    uri: vscode.window.activeTextEditor.document.uri.toString()
                });
            }
        } catch (err: any) {
            console.error("THUMBVIEW UPDATE LAYOUT ERROR:", err);
            panel.webview.postMessage({
                command: "status",
                text: `Error: ${err?.message ?? String(err)}`
            });
        }
    };

    // Raw result of the last scan. The scanner reuses a RepoFile object while its file is unchanged,
    // so an identical array means nothing visible changed (e.g. a build writing a gitignored folder).
    let lastRawScan: RepoFile[] | null = null;
    const sameScan = (a: RepoFile[] | null, b: RepoFile[]) =>
        !!a && a.length === b.length && a.every((file, i) => file === b[i]);

    const refreshThumbview = async (panel: vscode.WebviewPanel, onlyIfChanged = false) => {
        try {
            if (!onlyIfChanged) {
                panel.webview.postMessage({
                    command: "status",
                    text: "Refreshing Thumbview...",
                    clearData: false
                });
            }

            const files = await scanRepository(getIgnoreState(), persistIgnoreState);
            if (onlyIfChanged && sameScan(lastRawScan, files)) {
                return;
            }
            lastRawScan = files;
            cachedScannedFiles = files;
            // The scan reads disk; re-apply unsaved buffers so their tiles keep showing the edits.
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.isDirty) {
                    updateDocumentInCache(doc);
                }
            }

            await updateLayoutFromCache(panel);
        } catch (err: any) {
            console.error("THUMBVIEW REFRESH ERROR:", err);
            panel.webview.postMessage({
                command: "status",
                text: `Error: ${err?.message ?? String(err)}`
            });
        }
    };

    const refreshOrDefer = (kind: "layout" | "rescan") => {
        if (!activePanel) {
            return;
        }
        if (!activePanel.visible) {
            if (hiddenRefreshPending !== "rescan") {
                hiddenRefreshPending = kind;
            }
            return;
        }
        if (kind === "rescan") {
            refreshThumbview(activePanel, true);
        } else {
            updateLayoutFromCache(activePanel);
        }
    };

    // Runs after the reveal has painted, so the instant reveal shows the retained frame first and
    // the (full-payload) catch-up update lands afterwards instead of stalling the reveal.
    const HIDDEN_REFRESH_FLUSH_DELAY_MS = 250;
    const flushHiddenRefresh = (panel: vscode.WebviewPanel) => {
        if (!hiddenRefreshPending) {
            return;
        }
        setTimeout(() => detachFromLocks(() => {
            const kind = hiddenRefreshPending;
            hiddenRefreshPending = null;
            if (!panel.visible) {
                hiddenRefreshPending = kind;
                return;
            }
            if (kind === "rescan") {
                refreshThumbview(panel, true);
            } else if (kind === "layout") {
                updateLayoutFromCache(panel);
            }
        }), HIDDEN_REFRESH_FLUSH_DELAY_MS);
    };

    // Fullscreen = Zen Mode (natively hides AND restores sidebar/panel/aux bar —
    // extensions cannot read workbench visibility state, so VS Code must do the
    // snapshotting). All layout ops are serialized through layoutQueue; concurrent
    // enter/exit calls from the command path and onDidChangeViewState must not stack blind toggles.
    let fullscreenActive = false;
    let thumbviewEnteredZenMode = false;
    let groupMaximizedByUs = false;
    let layoutOpsInFlight = 0;

    // Every layout transition (open, reopen, close, jump, switchTab) gets an id. The webview hides on
    // hideForTransition and only treats showAfterTransition carrying the latest id as "layout settled",
    // so a delayed message from an earlier close cannot reveal a later open mid-expansion.
    // Protocol: hideForTransition { transitionId }, showAfterTransition { transitionId } (overview.js).
    let transitionSeq = 0;
    // `hide: false` (jump/switchTab) only supersedes older transitions: the target editor covers
    // Thumbview immediately, so hiding its page first would just flash the empty background.
    // `fromHidden` (reopen) tells the webview the panel really was hidden, enabling its fast
    // reopen path even when no close hid the page. Fields: { transitionId, fromHidden? }.
    const beginTransition = (panel: vscode.WebviewPanel | undefined, options: { hide?: boolean; fromHidden?: boolean } = {}): number => {
        const id = ++transitionSeq;
        if (options.hide !== false) {
            panel?.webview.postMessage({ command: "hideForTransition", transitionId: id, fromHidden: !!options.fromHidden });
        }
        return id;
    };
    const endTransition = (panel: vscode.WebviewPanel | undefined, id: number = transitionSeq) => {
        if (panel && id === transitionSeq) {
            panel.webview.postMessage({ command: "showAfterTransition", transitionId: id });
        }
    };

    // Layout ops release 400ms late so onDidChangeViewState ignores the events they cause. If the
    // user returns to a visible Thumbview inside that window, the view-state handler skipped it,
    // so the last release settles the current transition instead of leaving the page hidden.
    const releaseLayoutOp = () => {
        setTimeout(() => detachFromLocks(() => {
            layoutOpsInFlight = Math.max(0, layoutOpsInFlight - 1);
            if (layoutOpsInFlight === 0 && activePanel && activePanel.visible) {
                endTransition(activePanel);
            }
        }), 400);
    };

    // Thumbview never changes the user's settings at activation. The zenMode.* overrides it needs
    // are applied on the first fullscreen open of a session and kept until the session ends, so
    // toggling does not rewrite the global settings.json twice per F4 (Settings Sync churn, config
    // listeners, open-editor flicker, added open latency). They are restored at deactivate, or by
    // the next activation after a crash, once no other live window still uses them (zen_settings.ts).
    const zenConfig: ConfigLike = {
        inspect: key => vscode.workspace.getConfiguration().inspect(key),
        update: (key, value) => vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global),
    };
    const isFullscreenOnOpen = () => vscode.workspace.getConfiguration("thumbview").get<boolean>("fullscreenOnOpen") ?? true;
    const zenSessionId = vscode.env.sessionId;
    let zenOverridesApplied = false;
    let zenHeartbeat: NodeJS.Timeout | undefined;
    const recoverZenSettings = async (): Promise<void> => {
        if (zenOverridesApplied) {
            return;
        }
        if (hasOtherLiveOwners(context.globalState, zenSessionId, Date.now())) {
            // Another window is using the overrides, or a window that just crashed / reloaded has
            // not gone stale yet (sessionId changes on reload). Re-check once it would be stale.
            setTimeout(() => recoverZenSettings().catch(() => {}), ZEN_OWNER_STALE_MS + 1000);
            return;
        }
        if (context.globalState.get<boolean>(ZEN_ENTERED_KEY)) {
            // VS Code restores Zen mode across restarts; leave the one Thumbview entered before a crash.
            try {
                await vscode.commands.executeCommand("workbench.action.exitZenMode");
            } catch { }
            await context.globalState.update(ZEN_ENTERED_KEY, false);
        }
        await releaseZenOwnership(zenConfig, context.globalState, zenSessionId, Date.now());
    };
    recoverZenSettings().catch(() => {});
    const ensureZenOverrides = async () => {
        if (!zenOverridesApplied) {
            await applyZenOverrides(zenConfig, context.globalState);
            zenOverridesApplied = true;
        }
        await claimZenOwnership(context.globalState, zenSessionId, Date.now());
        if (!zenHeartbeat) {
            zenHeartbeat = setInterval(() => {
                claimZenOwnership(context.globalState, zenSessionId, Date.now()).catch(() => {});
            }, ZEN_OWNER_HEARTBEAT_MS);
        }
    };
    deactivateHook = async () => {
        if (zenHeartbeat) {
            clearInterval(zenHeartbeat);
            zenHeartbeat = undefined;
        }
        // Release even if this session never opened Thumbview, so its own entry never lingers.
        await releaseZenOwnership(zenConfig, context.globalState, zenSessionId, Date.now());
    };

    // Background pre-scan and git diff fetch so opening Thumbview is instant O(1).
    // The promise is kept so a "ready" that arrives mid-scan awaits it instead of starting a second full scan.
    const prescanStartedAt = performance.now();
    let prescanPromise: Promise<void> | undefined = scanRepository(getIgnoreState(), persistIgnoreState).then(files => {
        log.info(`Initial workspace scan: ${files.length} files in ${Math.round(performance.now() - prescanStartedAt)} ms.`);
        if (!cachedScannedFiles) {
            cachedScannedFiles = files;
            lastRawScan = files;
        }
    }).catch(() => {}).finally(() => {
        prescanPromise = undefined;
    });
    fetchWorkspaceGitDiff().catch(() => {});
    getAllWorkspaceRelativePaths().catch(() => {});

    const enterFullscreen = async (): Promise<void> => {
        if (fullscreenActive || !isFullscreenOnOpen()) {
            return;
        }
        fullscreenActive = true;
        // Settings are best effort: a failed write must never keep Thumbview out of fullscreen.
        try {
            await ensureZenOverrides();
            await context.globalState.update(ZEN_ENTERED_KEY, true);
        } catch {
        }
        try {
            // Blind toggle: extensions cannot read whether Zen is already on. thumbviewEnteredZenMode
            // ensures Thumbview only ever exits a Zen mode it entered itself.
            await vscode.commands.executeCommand("workbench.action.toggleZenMode");
        } catch {
        }
    };

    // One-time explanation of fullscreen, shown as a banner inside Thumbview: Zen mode's default
    // zenMode.silentNotifications would hide a VS Code notification. Recorded as shown when it is
    // sent, so closing Thumbview without answering never brings it back. Protocol: host -> webview
    // "fullscreenNotice" { keybinding } and "fullscreenSetting" { enabled }; webview -> host
    // "dismissFullscreenNotice" or "setFullscreenOnOpen" { enabled }.
    const FULLSCREEN_NOTICE_KEY = "thumbview.fullscreenNoticeShown";
    const SHORTCUT_LEGEND_DISMISSED_KEY = "thumbview.shortcutLegendDismissed";
    // When openState is held and when the return point is recorded or dropped (panel_session.ts).
    const session = new PanelSession();
    const maybeShowFullscreenNotice = (panel: vscode.WebviewPanel) => {
        if (fullscreenActive && !context.globalState.get<boolean>(FULLSCREEN_NOTICE_KEY)) {
            context.globalState.update(FULLSCREEN_NOTICE_KEY, true);
            panel.webview.postMessage({ command: "fullscreenNotice", keybinding: getOpenKeybindingLabel() });
        }
    };

    const exitFullscreen = async (): Promise<void> => {
        if (!fullscreenActive) {
            return;
        }
        fullscreenActive = false;
        try {
            await vscode.commands.executeCommand("workbench.action.exitZenMode");
            await context.globalState.update(ZEN_ENTERED_KEY, false);
        } catch {
        }
    };

    const unmaximizeIfSplits = async (): Promise<void> => {
        if (groupMaximizedByUs) {
            groupMaximizedByUs = false;
            try {
                await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
            } catch { }
        }
        // Split editors are left at equal widths (the owner's decision). VS Code's maximize and
        // unmaximize do not restore sizes reliably: keeping the user's proportions left one group
        // tiny and the other huge after a close, sometimes unreadable.
        if (vscode.window.tabGroups.all.length > 1) {
            try {
                await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
            } catch { }
        }
    };

    const isThumbviewTab = (tab: vscode.Tab): boolean => {
        const input: any = tab.input;
        return isThumbviewViewType(input?.viewType);
    };

    const getTabUri = (tab: vscode.Tab): vscode.Uri | undefined => {
        const input: any = tab.input;
        if (!input) {
            return undefined;
        }
        if (input instanceof vscode.TabInputText) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputTextDiff) {
            return input.modified || input.original;
        }
        if (input instanceof vscode.TabInputCustom) {
            return input.uri;
        }
        if (input instanceof vscode.TabInputNotebook) {
            return input.uri;
        }
        if (input.uri instanceof vscode.Uri) {
            return input.uri;
        }
        if (input.resource instanceof vscode.Uri) {
            return input.resource;
        }
        return undefined;
    };

    const switchToTab = async (tab: vscode.Tab): Promise<boolean> => {
        const uri = getTabUri(tab);
        if (uri) {
            try {
                if (uri.toString().toLowerCase().endsWith(".pdf")) {
                    await vscode.commands.executeCommand("vscode.open", uri);
                } else {
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        // Re-showing an existing tab: no `preview` option, so it is not pinned.
                        await vscode.window.showTextDocument(doc, {
                            viewColumn: tab.group.viewColumn
                        });
                    } catch {
                        await vscode.commands.executeCommand("vscode.open", uri);
                    }
                }
                return true;
            } catch {
                return false;
            }
        }
        return false;
    };

    // Split-editor bookkeeping (return point, covered editor, bounded opens) lives in
    // editor_groups.ts over this facade, so its decisions are unit tested.
    const tabInfo = (tab: vscode.Tab): TabInfo => ({ uri: getTabUri(tab)?.toString(), isThumbview: isThumbviewTab(tab), label: tab.label });
    const editorGroups = new EditorGroupTracker({
        groups: (): GroupInfo[] => vscode.window.tabGroups.all.map(group => ({
            viewColumn: group.viewColumn,
            isActive: group.isActive,
            activeTab: group.activeTab ? tabInfo(group.activeTab) : undefined,
            tabs: group.tabs.map(tabInfo)
        })),
        // No `preview` option: re-showing an existing preview tab must not pin it.
        open: async (uriString, viewColumn, preserveFocus) => {
            const uri = vscode.Uri.parse(uriString);
            const column = viewColumn === "active" ? vscode.ViewColumn.Active : viewColumn;
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus });
            } catch {
                await vscode.commands.executeCommand("vscode.open", uri, { viewColumn: column, preserveFocus });
            }
        },
        log: line => log.info(line)
    });
    const editorInfo = (editor: vscode.TextEditor | undefined): EditorInfo | undefined =>
        editor && !editor.document.isClosed && editor.document.uri.scheme !== "vscode-webview"
            ? { uri: editor.document.uri.toString(), viewColumn: editor.viewColumn }
            : undefined;

    const getAllNonThumbviewTabs = (): { preferred: vscode.Tab | undefined; tabs: vscode.Tab[] } => {
        const tabs: vscode.Tab[] = [];
        let preferred: vscode.Tab | undefined;

        const activeGroup = vscode.window.tabGroups.activeTabGroup;
        if (activeGroup?.activeTab && !isThumbviewTab(activeGroup.activeTab)) {
            preferred = activeGroup.activeTab;
        }

        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (!isThumbviewTab(tab)) {
                    tabs.push(tab);
                    if (!preferred && tab.isActive) {
                        preferred = tab;
                    }
                }
            }
        }

        if (!preferred && tabs.length > 0) {
            preferred = tabs[0];
        }

        return { preferred, tabs };
    };


    const closeActiveThumbview = (): Promise<void> => withLayoutLock(closeActiveThumbviewLocked);

    // Defense in depth for message_guard: for file URIs compare the resolved real path against each
    // workspace folder, since getWorkspaceFolder compares unnormalized paths.
    // A name typed into New File / New Folder / Rename, resolved inside the workspace folder.
    // Absolute paths and ".." segments are refused (message_guard's rule for webview paths).
    const typedPathInside = (folder: vscode.Uri, typed: string): vscode.Uri | undefined => {
        if (!isSafeRelativePath(typed.trim())) {
            vscode.window.showErrorMessage(`"${typed}" is outside the workspace. Use a name or a path inside it.`);
            return undefined;
        }
        return vscode.Uri.joinPath(folder, typed.trim());
    };

    const isUriInsideWorkspace = (uriString: string): boolean => {
        const uri = vscode.Uri.parse(uriString);
        if (uri.scheme !== "file") {
            return !!vscode.workspace.getWorkspaceFolder(uri);
        }
        const target = path.resolve(uri.fsPath);
        return (vscode.workspace.workspaceFolders || []).some(folder => {
            if (folder.uri.scheme !== "file") {
                return false;
            }
            const root = path.resolve(folder.uri.fsPath);
            return target === root || target.startsWith(root + path.sep);
        });
    };

    // After jump/switchTab has shown the target editor over Thumbview: exit the Zen mode and group
    // maximize Thumbview entered. The editor opened in Thumbview's own group, so unmaximizing
    // restores the user's other groups around it.
    // panel.active lags reveal(); waits for the view-state event (bounded) so a following
    // group command applies to the group that now holds the panel.
    const PANEL_ACTIVE_WAIT_MS = 300;
    const REOPEN_ACTIVE_WAIT_MS = 150;
    const waitForPanelState = (panel: vscode.WebviewPanel, wanted: (p: vscode.WebviewPanel) => boolean, timeoutMs: number): Promise<void> => new Promise(resolve => {
        if (wanted(panel)) {
            resolve();
            return;
        }
        const done = () => {
            clearTimeout(timer);
            subscription.dispose();
            resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        const subscription = panel.onDidChangeViewState(e => {
            if (wanted(e.webviewPanel)) {
                done();
            }
        });
    });
    const waitForPanelActive = (panel: vscode.WebviewPanel, timeoutMs: number) => waitForPanelState(panel, p => p.active, timeoutMs);
    // Close: after switching to the code, wait for the panel to report it lost focus (bounded)
    // instead of a fixed settle sleep, then check whether VS Code handed focus back to it.
    const CLOSE_SETTLE_MAX_MS = 150;

    const leaveFullscreenAfterSwitch = async (): Promise<void> => {
        if (thumbviewEnteredZenMode) {
            thumbviewEnteredZenMode = false;
            await exitFullscreen();
        }
        if (groupMaximizedByUs) {
            await unmaximizeIfSplits();
        }
    };

    // Leaves fullscreen and shows the target in the same workbench update. Callers load the
    // document first, so the Zen exit, the unmaximize, and the show are sent back to back: the
    // file appears directly in the normal layout instead of first in Zen mode and then again when
    // the layout is restored. All three settle before returning, so a failed show never releases
    // the layout lock while the layout is still changing. While it runs, openState posts are held
    // (the webview has stopped drawing and is about to be covered; reopening sends fresh state).
    // `timing` (performance.now() marks from the caller) is logged to the Thumbview output channel.
    const switchLeavingFullscreen = async <T>(show: () => Thenable<T>, timing?: SwitchTiming): Promise<T> => {
        session.switchStarted();
        // The user moves on to the opened file; an older return point must not be reused.
        editorGroups.clearReturnPoint();
        const showStart = performance.now();
        const exiting = thumbviewEnteredZenMode ? (thumbviewEnteredZenMode = false, exitFullscreen()) : Promise.resolve();
        const unmaximizing = groupMaximizedByUs ? unmaximizeIfSplits() : Promise.resolve();
        let shown: Thenable<T>;
        try {
            shown = show();
        } catch (err) {
            shown = Promise.reject(err);
        }
        const [, , result] = await Promise.allSettled([exiting, unmaximizing, shown]);
        if (timing) {
            const ms = (from: number, to: number) => Math.round(to - from);
            log.info(`Opened ${timing.label} in ${ms(timing.receivedAt, performance.now())} ms `
                + `(waiting for layout lock ${ms(timing.receivedAt, timing.lockedAt)} ms, loading ${ms(timing.lockedAt, timing.loadedAt ?? showStart)} ms, `
                + `showing and restoring layout ${ms(showStart, performance.now())} ms)`);
        }
        if (result.status === "rejected") {
            // Thumbview is still in front, so its state must flow again.
            session.switchFailed();
            sendOpenState();
            throw result.reason;
        }
        return result.value;
    };

    const closeActiveThumbviewLocked = async (): Promise<void> => {
        if (!activePanel) {
            return;
        }

        const { preferred, tabs: otherTabs } = getAllNonThumbviewTabs();

        // Fallback Close: If there are no other tabs open in the entire workspace,
        // cleanly dispose the Thumbview tab so the user sees the normal VS Code empty editor watermark.
        if (otherTabs.length === 0) {
            layoutOpsInFlight++;
            try {
                if (thumbviewEnteredZenMode) {
                    thumbviewEnteredZenMode = false;
                    await exitFullscreen();
                }
                if (groupMaximizedByUs) {
                    await unmaximizeIfSplits();
                }
                activePanel.dispose();
                activePanel = undefined;
            } finally {
                releaseLayoutOp();
            }
            return;
        }

        layoutOpsInFlight++;
        const closeTransitionId = beginTransition(activePanel);
        try {

            // No settle sleeps: both commands resolve once the workbench has applied them.
            if (thumbviewEnteredZenMode) {
                thumbviewEnteredZenMode = false;
                await exitFullscreen();
            }
            if (groupMaximizedByUs) {
                await unmaximizeIfSplits();
            }

            // Robust Tab Switcher:
            // 0. Return to where the user was when F4 opened Thumbview (returnTo).
            // 1. Otherwise try lastActiveTextEditor if valid and not closed
            const returnResult = await editorGroups.returnToEditor();
            // A timed-out return may still land, so no fallback open is started after it.
            let switched = returnResult !== "failed";
            if (!switched && lastActiveTextEditor && !lastActiveTextEditor.document.isClosed) {
                try {
                    // No `preview` option: returning must not pin a preview tab.
                    await vscode.window.showTextDocument(lastActiveTextEditor.document, {
                        viewColumn: lastActiveTextEditor.viewColumn
                    });
                    switched = true;
                } catch { }
            }

            // 2. If not switched, try preferred tab from vscode.window.tabGroups
            if (!switched && preferred) {
                switched = await switchToTab(preferred);
            }

            // 3. If still not switched, iterate remaining open tabs
            if (!switched) {
                for (const candidate of otherTabs) {
                    if (candidate !== preferred) {
                        switched = await switchToTab(candidate);
                        if (switched) {
                            break;
                        }
                    }
                }
            }

            // 4. Fallback to previousEditor if still not switched
            if (!switched) {
                try {
                    await vscode.commands.executeCommand("workbench.action.previousEditor");
                } catch { }
            }

            // Settle check & Double-activation: wait (bounded) for the panel to lose focus.
            if (activePanel) {
                await waitForPanelState(activePanel, p => !p.active, CLOSE_SETTLE_MAX_MS);
            }

            // If VS Code's layout engine clobbered the focus and Thumbview is still active,
            // re-trigger the switch to the desired code tab.
            if (activePanel && activePanel.active) {
                if (returnResult === "opened") {
                    await editorGroups.returnToEditor();
                } else if (returnResult === "timeout") {
                    // Still opening; a second open would bounce focus.
                } else if (lastActiveTextEditor && !lastActiveTextEditor.document.isClosed) {
                    try {
                        await vscode.window.showTextDocument(lastActiveTextEditor.document);
                    } catch { }
                } else if (preferred) {
                    await switchToTab(preferred);
                }
                if (activePanel) {
                    await waitForPanelState(activePanel, p => !p.active, CLOSE_SETTLE_MAX_MS);
                }
            }

            // Returned to code in another group: put back the editor Thumbview covered in its own
            // group (focus stays on the code), so both groups look as they did before F4.
            log.info(`Close: returned to code; panel ${activePanel?.active ? "focused" : activePanel?.visible ? "visible, not focused" : "hidden"}. ${editorGroups.describe()}`);
            if (activePanel && activePanel.visible && !activePanel.active) {
                await editorGroups.restoreCovered();
            }
            // Used; the next open records a fresh one.
            editorGroups.clearReturnPoint();

            // Acknowledge and Reset Opacity:
            // If Thumbview is still visible (e.g. user stayed on Thumbview or switch failed),
            // ensure opacity is restored so it is never stuck as a blank canvas.
            if (activePanel && activePanel.visible) {
                endTransition(activePanel, closeTransitionId);
            }
        } finally {
            setTimeout(() => detachFromLocks(() => {
                layoutOpsInFlight = Math.max(0, layoutOpsInFlight - 1);
                if (layoutOpsInFlight === 0 && activePanel && activePanel.visible) {
                    endTransition(activePanel, closeTransitionId);
                }
            }), 400);
        }
    };

    const TOGGLE_INTENT_TRUST_MS = 1000;
    let lastToggleIntent: "open" | "close" | null = null;
    let lastToggleAt = 0;

    // F4 presses that arrive while a toggle is running are coalesced (see createCoalescedToggle),
    // so spamming the key can never queue a burst of Zen/maximize layout sequences.
    const toggleThumbview = createCoalescedToggle(async () => {

            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme !== "vscode-webview") {
                lastActiveTextEditor = vscode.window.activeTextEditor;
            }

            // panel.active updates asynchronously after reveal(), so a coalesced replay right after
            // our own open could misread it as closed; trust our last intent for a moment.
            // F4 closes only a focused Thumbview. Visible but unfocused (beside the code in a split,
            // or while the terminal has focus) means "open / focus", so it is brought forward.
            const recentlyOpened = lastToggleIntent === "open" && Date.now() - lastToggleAt < TOGGLE_INTENT_TRUST_MS;
            const action = decideF4({
                panelExists: !!activePanel,
                panelActive: !!activePanel?.active,
                panelVisible: !!activePanel?.visible,
                recentlyOpened,
                fullscreenActive,
                fullscreenOnOpen: isFullscreenOnOpen()
            });
            log.info(`F4: panel ${activePanel ? (activePanel.active ? "focused" : activePanel.visible ? "visible, not focused" : "hidden") : "not created"}, `
                + `${vscode.window.tabGroups.all.length} editor group(s), fullscreen ${fullscreenActive ? "on" : "off"} -> ${action}`);
            if (action === "close") {
                lastToggleIntent = "close";
                lastToggleAt = Date.now();
                await closeActiveThumbview();
                return;
            }
            lastToggleIntent = "open";
            editorGroups.recordReturnPoint(editorInfo(vscode.window.activeTextEditor), vscode.window.tabGroups.activeTabGroup.viewColumn);
            lastToggleAt = Date.now();

            if (action === "focus-in-place" && activePanel) {
                activePanel.reveal(activePanel.viewColumn, false);
                session.shown();
                sendOpenState();
                return;
            }

            // Sync unsaved buffers into the memory cache (saved files are rescanned by the watcher)
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.isDirty) {
                    updateDocumentInCache(doc);
                }
            }
            fetchWorkspaceGitDiff().catch(() => {});

            if (activePanel) {
                layoutOpsInFlight++;
                const reopenTransitionId = beginTransition(activePanel, { fromHidden: true });
                try {
                    thumbviewEnteredZenMode = true;
                    await enterFullscreen();

                    // Reveal before maximizing. toggleMaximizeEditorGroup acts on the active group,
                    // and right after a split that is the new group, not the one holding the
                    // retained panel; revealing the panel in its hidden group afterwards made VS
                    // Code undo the maximize, leaving Thumbview beside the code. The page stays
                    // hidden (reopen transition) until endTransition below.
                    updateVisibleRanges(vscode.window.activeTextEditor || lastActiveTextEditor);
                    const editorsBeforeReveal = editorGroups.snapshot();
                    activePanel.reveal(activePanel.visible ? activePanel.viewColumn : vscode.ViewColumn.Active);
                    if (isFullscreenOnOpen() && vscode.window.tabGroups.all.length > 1 && !groupMaximizedByUs) {
                        await waitForPanelActive(activePanel, PANEL_ACTIVE_WAIT_MS);
                        groupMaximizedByUs = true;
                        try {
                            await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
                        } catch { }
                    }

                    // A signal instead of a fixed sleep: the panel's view-state event means it is shown
                    // in its group (and panel.viewColumn is current). Showing the page is still gated
                    // in the webview on a size that holds (checkRevealStable), so no settle sleep is needed.
                    await waitForPanelActive(activePanel, REOPEN_ACTIVE_WAIT_MS);
                    editorGroups.recordCovered(editorsBeforeReveal, activePanel.viewColumn);

                    session.shown();
                    sendOpenState();

                    endTransition(activePanel, reopenTransitionId);
                    flushHiddenRefresh(activePanel);
                    maybeShowFullscreenNotice(activePanel);
                } finally {
                    releaseLayoutOp();
                }
                return;
            }

            // A layout op like reopen, so onDidChangeViewState ignores the events our own Zen,
            // maximize, and panel creation cause (with split editors it used to read them as the
            // user dragging Thumbview into a split and closed the brand-new panel). Released at the
            // end of this toggle.
            layoutOpsInFlight++;

            // Enter fullscreen BEFORE creating the panel so Thumbview renders
            // directly at full size instead of snapping through layouts
            thumbviewEnteredZenMode = true;
            await enterFullscreen();

            if (isFullscreenOnOpen() && vscode.window.tabGroups.all.length > 1 && !groupMaximizedByUs) {
                groupMaximizedByUs = true;
                try {
                    await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
                } catch { }
            }

            let panel: vscode.WebviewPanel;
            const editorsBeforeCreate = editorGroups.snapshot();
            // createWebviewPanel(ViewColumn.Active) lands in the active group; panel.viewColumn is
            // not resolved until the first view-state event, so record by the group's column.
            const createColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
            try {
                panel = vscode.window.createWebviewPanel(
                    THUMBVIEW_VIEW_TYPE,
                    "Thumbview",
                    vscode.ViewColumn.Active,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: [
                            vscode.Uri.joinPath(context.extensionUri, "media"),
                            ...(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(f => f.uri) : [])
                        ]
                    }
                );

                activePanel = panel;
                session.shown();
                editorGroups.recordCovered(editorsBeforeCreate, createColumn);

                const hasPdfs = (cachedScannedFiles || []).some(f => f.isPdf);
                panel.webview.html = getHtml(panel.webview, context, getOpenKeybindingLabel(), hasPdfs);
            } catch (err) {
                log.error(`Failed to open the Thumbview panel: ${err instanceof Error ? err.message : String(err)}`);
                // Zen and the maximize were entered for a panel that does not exist: undo them.
                await leaveFullscreenAfterSwitch();
                releaseLayoutOp();
                return;
            }
            // Released here, not after the handler registrations below: those are synchronous (same
            // tick, so the 400 ms grace window is unchanged), and a throw in them must not leave
            // layoutOpsInFlight raised, which would make the view-state handler ignore every event.
            releaseLayoutOp();

            panel.webview.onDidReceiveMessage(async msg => {
                if (!isSafeWebviewMessage(msg, isUriInsideWorkspace)) {
                    console.warn("THUMBVIEW: rejected webview message targeting a path outside the workspace", msg && msg.command);
                    return;
                }

                if (msg.command === "exitThumbview") {
                    await closeActiveThumbview();
                    return;
                }

                if (msg.command === "ensureZenMode") {
                    thumbviewEnteredZenMode = true;
                    await enterFullscreen();
                }

                if (msg.command === "ready") {
                    postedContentVersions.clear();
                    if (!cachedScannedFiles && prescanPromise) {
                        const scanWaitStart = performance.now();
                        await prescanPromise;
                        log.info(`Webview ready; waited ${Math.round(performance.now() - scanWaitStart)} ms for the initial workspace scan (${(cachedScannedFiles as RepoFile[] | null)?.length ?? 0} files).`);
                    }
                    if (cachedScannedFiles && cachedScannedFiles.length > 0) {
                        updateLayoutFromCache(panel);
                    } else {
                        refreshThumbview(panel);
                    }
                    endTransition(panel);
                    maybeShowFullscreenNotice(panel);
                }

                if (msg.command === "dismissShortcutLegend") {
                    await context.globalState.update(SHORTCUT_LEGEND_DISMISSED_KEY, true);
                    return;
                }

                if (msg.command === "dismissFullscreenNotice") {
                    await context.globalState.update(FULLSCREEN_NOTICE_KEY, true);
                    return;
                }

                // From the fullscreen banner or the settings toggle. The configuration listener
                // applies it (leaving fullscreen when turned off), exactly as for a settings.json
                // edit, so a failed write never leaves the window out of step with the setting.
                if (msg.command === "setFullscreenOnOpen") {
                    await context.globalState.update(FULLSCREEN_NOTICE_KEY, true);
                    try {
                        await vscode.workspace.getConfiguration("thumbview").update("fullscreenOnOpen", !!msg.enabled, vscode.ConfigurationTarget.Global);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to change fullscreen setting: ${err?.message ?? String(err)}`);
                        panel.webview.postMessage({ command: "fullscreenSetting", enabled: isFullscreenOnOpen() });
                    }
                    return;
                }

                // The webview lacks lines for these ids (e.g. a delta payload arrived after one it
                // skipped). Fields: { ids: string[] } — see applyDataMessage in overview.js.
                if (msg.command === "requestFileLines" && Array.isArray(msg.ids)) {
                    for (const id of msg.ids) {
                        postedContentVersions.delete(String(id));
                    }
                    await updateLayoutFromCache(panel);
                    return;
                }

                // The webview reconciles folder-file and card orders (it owns those layouts) and
                // persists them here. Fields: { scope: "folderFiles" | "folderCards" | "rootCards",
                // folder, ids, footprints?, wrapRows?, flowCells? } — see requestLayoutOrderSave in overview.js.
                if (msg.command === "saveLayoutOrder" && Array.isArray(msg.ids)) {
                    const ids: string[] = msg.ids.map((id: unknown) => (typeof id === "string" ? id : ""));
                    await withOrderLock(async () => {
                        if (msg.scope === "rootCards") {
                            await context.workspaceState.update("thumbview.cardOrder", ids);
                            return;
                        }
                        if (typeof msg.folder !== "string" || !msg.folder) {
                            return;
                        }
                        const key = msg.scope === "folderCards" ? "thumbview.folderCardOrders" : "thumbview.folderOrders";
                        const orders = context.workspaceState.get<{ [folder: string]: string[] }>(key) || {};
                        orders[msg.folder] = ids;
                        await context.workspaceState.update(key, orders);
                    });
                    if (typeof msg.wrapRows === "number" && msg.wrapRows > 0) {
                        await withOrderLock(async () => {
                            if (msg.scope === "rootCards") {
                                await context.workspaceState.update("thumbview.cardWrapRows", msg.wrapRows);
                            } else if (typeof msg.folder === "string" && msg.folder) {
                                const wrapKey = msg.scope === "folderCards" ? "thumbview.folderCardWrapRows" : "thumbview.folderWrapRows";
                                const wraps = context.workspaceState.get<{ [folder: string]: number }>(wrapKey) || {};
                                wraps[msg.folder] = msg.wrapRows;
                                await context.workspaceState.update(wrapKey, wraps);
                            }
                        });
                    }
                    if (msg.footprints && typeof msg.footprints === "object") {
                        await withOrderLock(() => mergeSlotFootprints(layoutScopeKey(msg.scope, msg.folder), msg.footprints));
                    }
                    if (msg.flowCells && typeof msg.flowCells === "object") {
                        await withOrderLock(() => mergeSlotFlowCells(layoutScopeKey(msg.scope, msg.folder), msg.flowCells));
                    }
                    return;
                }

                if (msg.command === "focusWindow") {
                    if (activePanel && !activePanel.active) {
                        activePanel.reveal(undefined, true);
                    }
                }

                if (msg.command === "switchTab") {
                    const receivedAt = performance.now();
                    await withLayoutLock(async () => {
                        const lockedAt = performance.now();
                        try {
                            const uri = vscode.Uri.parse(msg.uri);
                            layoutOpsInFlight++;
                            try {
                                // Load the target, then show it while leaving fullscreen in one
                                // update: no hidden-page flash and no fixed settle sleeps.
                                beginTransition(activePanel, { hide: false });
                                let doc: vscode.TextDocument | undefined;
                                if (!msg.uri.toLowerCase().endsWith(".pdf")) {
                                    try {
                                        doc = await vscode.workspace.openTextDocument(uri);
                                    } catch {
                                        doc = undefined;
                                    }
                                }
                                const textDoc = doc;
                                await switchLeavingFullscreen(() => textDoc
                                    ? vscode.window.showTextDocument(textDoc, { preview: false })
                                    : vscode.commands.executeCommand("vscode.open", uri, { preview: false }),
                                { label: uri.path.split("/").pop() || msg.uri, receivedAt, lockedAt, loadedAt: performance.now() });
                            } finally {
                                releaseLayoutOp();
                            }
                        } catch (err: any) {
                            log.error(`Opening ${msg.uri} from Thumbview failed: ${err?.message ?? String(err)}`);
                            vscode.window.showErrorMessage(`Thumbview could not open ${vscode.Uri.parse(msg.uri).path.split("/").pop()}: ${err?.message ?? String(err)}`);
                        }
                    });
                }

                if (msg.command === "jump") {
                    const receivedAt = performance.now();
                    await withLayoutLock(async () => {
                        const lockedAt = performance.now();
                        try {
                            const uri = vscode.Uri.parse(msg.uri);
                            layoutOpsInFlight++;
                            try {
                                // Load the target, then show it while leaving fullscreen in one
                                // update: no hidden-page flash and no fixed settle sleeps.
                                beginTransition(activePanel, { hide: false });

                                let doc: vscode.TextDocument;
                                try {
                                    doc = await vscode.workspace.openTextDocument(uri);
                                } catch {
                                    // Binary/media file fallback
                                    await switchLeavingFullscreen(() => vscode.commands.executeCommand("vscode.open", uri, { preview: false }),
                                        { label: uri.path.split("/").pop() || msg.uri, receivedAt, lockedAt });
                                    return;
                                }

                            const safeLine = Math.max(
                                0,
                                Math.min(Number(msg.line) || 0, doc.lineCount - 1)
                            );
                            const pos = new vscode.Position(safeLine, 0);

                            const editor = await switchLeavingFullscreen(() => vscode.window.showTextDocument(doc, {
                                preview: false,
                                selection: new vscode.Range(pos, pos)
                            }), { label: uri.path.split("/").pop() || msg.uri, receivedAt, lockedAt, loadedAt: performance.now() });

                            editor.revealRange(
                                new vscode.Range(pos, pos),
                                vscode.TextEditorRevealType.InCenter
                            );
                            // Flash all matching lines pink in the document and fade away.
                            // The regex/whole-word pattern-building here is duplicated in
                            // media/overview.js's rebuildSearchState — keep both in sync.
                            const query = (msg.query || "").trim();
                            if (query && !msg.searchInvalid) {
                                let isMatch: (lineText: string) => boolean;
                                if (msg.useRegex || msg.matchWholeWord) {
                                    let pattern = msg.useRegex ? query : query.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
                                    if (msg.matchWholeWord) pattern = `\\b(?:${pattern})\\b`;
                                    try {
                                        const re = new RegExp(pattern, msg.matchCase ? "" : "i");
                                        isMatch = (lineText: string) => re.test(lineText);
                                    } catch {
                                        isMatch = () => false;
                                    }
                                } else if (msg.matchCase) {
                                    isMatch = (lineText: string) => lineText.includes(query);
                                } else {
                                    const lowerQuery = query.toLowerCase();
                                    isMatch = (lineText: string) => lineText.toLowerCase().includes(lowerQuery);
                                }

                                const matchingRanges: vscode.Range[] = [];
                                for (let i = 0; i < doc.lineCount; i++) {
                                    if (isMatch(doc.lineAt(i).text)) {
                                        matchingRanges.push(new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, 0)));
                                    }
                                }
                                // "auto" (the default) follows the OS preference, which only the webview can read.
                                const reduceMotionSetting = vscode.workspace.getConfiguration("workbench").get<string>("reduceMotion");
                                const reduceMotion = reduceMotionSetting === "on" || (reduceMotionSetting !== "off" && msg.reduceMotion === true);
                                if (matchingRanges.length > 0 && reduceMotion) {
                                    // Reduced motion: one steady highlight, no fade steps.
                                    editor.setDecorations(searchFlashSteps[0], matchingRanges);
                                    setTimeout(() => {
                                        if (!editor.document.isClosed) {
                                            editor.setDecorations(searchFlashSteps[0], []);
                                        }
                                    }, 2000);
                                } else if (matchingRanges.length > 0) {
                                    // Chained setTimeouts step through searchFlashSteps to fake
                                    // a fade-out, since decoration opacity can't be animated.
                                    setTimeout(() => {
                                        if (editor && !editor.document.isClosed) {
                                            // Step 1: 0.35 opacity (lasts 1500ms)
                                            editor.setDecorations(searchFlashSteps[0], matchingRanges);

                                            // Step 2: 0.22 opacity (starts at 1500ms, lasts 150ms)
                                            setTimeout(() => {
                                                if (editor && !editor.document.isClosed) {
                                                    editor.setDecorations(searchFlashSteps[0], []);
                                                    editor.setDecorations(searchFlashSteps[1], matchingRanges);
                                                }
                                            }, 1500);

                                            // Step 3: 0.12 opacity (starts at 1650ms, lasts 150ms)
                                            setTimeout(() => {
                                                if (editor && !editor.document.isClosed) {
                                                    editor.setDecorations(searchFlashSteps[1], []);
                                                    editor.setDecorations(searchFlashSteps[2], matchingRanges);
                                                }
                                            }, 1650);

                                            // Step 4: 0.05 opacity (starts at 1800ms, lasts 200ms)
                                            // Clear all (at 2000ms)
                                            setTimeout(() => {
                                                if (editor && !editor.document.isClosed) {
                                                    editor.setDecorations(searchFlashSteps[3], []);
                                                }
                                            }, 2000);
                                        }
                                    }, 150);
                                }
                            }
                        } finally {
                            releaseLayoutOp();
                        }
                    } catch (err: any) {
                        log.error(`Opening ${msg.uri} from Thumbview failed: ${err?.message ?? String(err)}`);
                        vscode.window.showErrorMessage(
                            `Thumbview jump failed: ${err?.message ?? String(err)}`
                        );
                    }
                    });
                }

                if (msg.command === "getHoverLines") {
                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
                        const start = Math.max(0, Math.min(Number(msg.start) || 0, doc.lineCount - 1));
                        const end = Math.max(0, Math.min(Number(msg.end) || 0, doc.lineCount - 1));
                        const lines: { text: string; indent: number; length: number; category: string }[] = [];
                        const MAX_LINE_LEN = 500;

                        for (let i = start; i <= end; i++) {
                            let textLine = doc.lineAt(i).text;
                            if (textLine.length > MAX_LINE_LEN) {
                                textLine = textLine.substring(0, MAX_LINE_LEN);
                            }
                            const trimmedRight = textLine.trimEnd();
                            const indent = textLine.length - textLine.trimStart().length;
                            lines.push({
                                text: textLine,
                                indent,
                                length: trimmedRight.length,
                                category: "normal"
                            });
                        }

                        panel.webview.postMessage({
                            command: "hoverLines",
                            requestId: msg.requestId,
                            uri: msg.uri,
                            start,
                            end,
                            lines
                        });
                    } catch (err: any) {
                        console.error("THUMBVIEW GET HOVER LINES ERROR:", err);
                    }
                }

                if (msg.command === "close") {
                    try {
                        const targetUriStr = msg.uri;
                        const tabsToClose: vscode.Tab[] = [];
                        for (const group of vscode.window.tabGroups.all) {
                            for (const tab of group.tabs) {
                                const input: any = tab.input;
                                const tabUri = input?.uri?.toString?.() || input?.resource?.toString?.();
                                if (tabUri === targetUriStr) {
                                    tabsToClose.push(tab);
                                }
                            }
                        }
                        if (tabsToClose.length > 0) {
                            await vscode.window.tabGroups.close(tabsToClose);
                        }
                    } catch (err: any) {
                        console.error("THUMBVIEW CLOSE ERROR:", err);
                    }
                }

                if (msg.command === "openPreview") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to open preview: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "openToSide") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("vscode.open", uri, { viewColumn: vscode.ViewColumn.Beside });
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to open to side: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "revealInFiles") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("revealInExplorer", uri);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to reveal in explorer: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "renameFile") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        const oldPath = msg.path || vscode.workspace.asRelativePath(uri);
                        const newName = await vscode.window.showInputBox({
                            prompt: "Enter new name/relative path for file",
                            value: oldPath
                        });
                        if (newName && newName !== oldPath) {
                            const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
                            const newUri = wsFolder && typedPathInside(wsFolder.uri, newName);
                            if (wsFolder && newUri) {
                                const edit = new vscode.WorkspaceEdit();
                                edit.renameFile(uri, newUri, { overwrite: false });
                                const success = await vscode.workspace.applyEdit(edit);
                                if (success && activePanel) {
                                    refreshThumbview(activePanel);
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to rename file: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "deleteFile") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        const fileName = vscode.workspace.asRelativePath(uri);
                        const mode = await askDeleteMode(`'${fileName}'`);
                        if (mode) {
                            await vscode.workspace.fs.delete(uri, { useTrash: mode === "trash" });
                            if (activePanel) {
                                refreshThumbview(activePanel);
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to delete file: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "ignoreFile") {
                    try {
                        const relPath = (msg.path || "").replace(/\\/g, "/").trim();
                        if (relPath) {
                            const state = getIgnoreState();
                            const cleanPattern = relPath.replace(/\/+$/, "");
                            const exists = state.ignorePatterns.some(p => p === relPath || p.replace(/\/+$/, "") === cleanPattern);
                            if (!exists) {
                                await persistIgnoreState({ ...state, ignorePatterns: [relPath, ...state.ignorePatterns] });
                                vscode.window.showInformationMessage(`Added '${relPath}' to Thumbview ignore list.`);
                                refreshProviders();
                            }
                            if (activePanel) {
                                await updateLayoutFromCache(activePanel);
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to ignore file: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "copyPath") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.env.clipboard.writeText(uri.fsPath);
                        vscode.window.showInformationMessage("Copied path to clipboard.");
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to copy path: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "copyRelativePath") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        const rel = vscode.workspace.asRelativePath(uri);
                        await vscode.env.clipboard.writeText(rel);
                        vscode.window.showInformationMessage("Copied relative path to clipboard.");
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to copy relative path: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "copyFile") {
                    const uri = vscode.Uri.parse(msg.uri);
                    lastCopiedItem = { uri, isFolder: false, isCut: false };
                    try {
                        await vscode.commands.executeCommand("filesExplorer.copy", uri);
                    } catch (err: any) {
                        await vscode.env.clipboard.writeText(uri.fsPath);
                    }
                    vscode.window.showInformationMessage(`Copied '${vscode.workspace.asRelativePath(uri)}'.`);
                }

                if (msg.command === "cutFile") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        lastCopiedItem = { uri, isFolder: false, isCut: true };
                        await vscode.commands.executeCommand("filesExplorer.cut", uri);
                        vscode.window.showInformationMessage(`Cut '${vscode.workspace.asRelativePath(uri)}'.`);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to cut file: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "newFile") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const folderPrefix = msg.targetFolder ? msg.targetFolder.replace(/^\/+|\/+$/g, "") + "/" : "";
                            const input = await vscode.window.showInputBox({
                                prompt: "Enter file name or relative path",
                                value: folderPrefix
                            });
                            const targetUri = input && input !== folderPrefix ? typedPathInside(wsFolder.uri, input) : undefined;
                            if (targetUri) {
                                await vscode.workspace.fs.writeFile(targetUri, new Uint8Array());
                                const doc = await vscode.workspace.openTextDocument(targetUri);
                                await vscode.window.showTextDocument(doc);
                                if (activePanel) {
                                    refreshThumbview(activePanel);
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to create file: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "newFolder") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const folderPrefix = msg.targetFolder ? msg.targetFolder.replace(/^\/+|\/+$/g, "") + "/" : "";
                            const input = await vscode.window.showInputBox({
                                prompt: "Enter folder name or relative path",
                                value: folderPrefix
                            });
                            const targetUri = input && input !== folderPrefix ? typedPathInside(wsFolder.uri, input) : undefined;
                            if (targetUri) {
                                await vscode.workspace.fs.createDirectory(targetUri);
                                vscode.window.showInformationMessage(`Created folder '${input}'.`);
                                if (activePanel) {
                                    refreshThumbview(activePanel);
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to create folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "copyFolder") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                            const folderUri = vscode.Uri.joinPath(wsFolder.uri, folderRel);
                            lastCopiedItem = { uri: folderUri, isFolder: true, isCut: false };
                            try {
                                await vscode.commands.executeCommand("filesExplorer.copy", folderUri);
                            } catch {
                                await vscode.env.clipboard.writeText(folderUri.fsPath);
                            }
                            vscode.window.showInformationMessage(`Copied folder '${folderRel}'.`);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to copy folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "cutFolder") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                            const folderUri = vscode.Uri.joinPath(wsFolder.uri, folderRel);
                            lastCopiedItem = { uri: folderUri, isFolder: true, isCut: true };
                            try {
                                await vscode.commands.executeCommand("filesExplorer.cut", folderUri);
                            } catch {
                                await vscode.env.clipboard.writeText(folderUri.fsPath);
                            }
                            vscode.window.showInformationMessage(`Cut folder '${folderRel}'.`);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to cut folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "copyFolderPath") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                            const folderUri = vscode.Uri.joinPath(wsFolder.uri, folderRel);
                            await vscode.env.clipboard.writeText(folderUri.fsPath);
                            vscode.window.showInformationMessage("Copied folder path to clipboard.");
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to copy path: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "copyFolderRelativePath") {
                    try {
                        const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                        await vscode.env.clipboard.writeText(folderRel);
                        vscode.window.showInformationMessage("Copied relative folder path to clipboard.");
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to copy relative path: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "renameFolder") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const oldRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                            const oldUri = vscode.Uri.joinPath(wsFolder.uri, oldRel);
                            const newName = await vscode.window.showInputBox({
                                prompt: "Enter new name/relative path for folder",
                                value: oldRel
                            });
                            const newUri = newName && newName !== oldRel ? typedPathInside(wsFolder.uri, newName) : undefined;
                            if (newUri) {
                                const edit = new vscode.WorkspaceEdit();
                                edit.renameFile(oldUri, newUri, { overwrite: false });
                                const success = await vscode.workspace.applyEdit(edit);
                                if (success && activePanel) {
                                    refreshThumbview(activePanel);
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to rename folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "deleteFolder") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                            const folderUri = vscode.Uri.joinPath(wsFolder.uri, folderRel);
                            const mode = await askDeleteMode(`folder '${folderRel}' and all its contents`);
                            if (mode) {
                                await vscode.workspace.fs.delete(folderUri, { recursive: true, useTrash: mode === "trash" });
                                if (activePanel) {
                                    refreshThumbview(activePanel);
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to delete folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "revealFolder") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                            const folderUri = vscode.Uri.joinPath(wsFolder.uri, folderRel);
                            await vscode.commands.executeCommand("revealInExplorer", folderUri);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to reveal folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "openFolderInTerminal") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                            const folderUri = vscode.Uri.joinPath(wsFolder.uri, folderRel);
                            await vscode.commands.executeCommand("openInTerminal", folderUri);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to open in integrated terminal: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "ignoreFolder") {
                    try {
                        const relPath = (msg.folderPath || "").replace(/\\/g, "/").trim();
                        if (relPath) {
                            const state = getIgnoreState();
                            const cleanPattern = relPath.replace(/\/+$/, "");
                            const exists = state.ignorePatterns.some(p => p === relPath || p.replace(/\/+$/, "") === cleanPattern);
                            if (!exists) {
                                await persistIgnoreState({ ...state, ignorePatterns: [relPath, ...state.ignorePatterns] });
                                vscode.window.showInformationMessage(`Added '${relPath}' to Thumbview ignore list.`);
                            }
                            refreshProviders();
                            if (activePanel) {
                                await updateLayoutFromCache(activePanel);
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to ignore folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "moveFileToFolder") {
                    try {
                        const sourceUri = vscode.Uri.parse(msg.uri);
                        const fileName = sourceUri.path.split("/").pop() || "file";
                        const wsFolder = vscode.workspace.getWorkspaceFolder(sourceUri) || vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const targetFolderRel = (msg.targetFolder || "").replace(/^\/+|\/+$/g, "");
                            const targetUri = targetFolderRel
                                ? vscode.Uri.joinPath(wsFolder.uri, targetFolderRel, fileName)
                                : vscode.Uri.joinPath(wsFolder.uri, fileName);

                            if (sourceUri.toString() !== targetUri.toString()) {
                                const edit = new vscode.WorkspaceEdit();
                                edit.renameFile(sourceUri, targetUri, { overwrite: false });
                                const success = await vscode.workspace.applyEdit(edit);
                                if (success) {
                                    vscode.window.showInformationMessage(`Moved '${fileName}' to '${targetFolderRel || "root"}'.`);
                                    if (activePanel) {
                                        refreshThumbview(activePanel);
                                    }
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to move file: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "pasteItem") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const targetFolderRel = (msg.targetFolder || "").replace(/^\/+|\/+$/g, "");
                            const targetDirUri = targetFolderRel ? vscode.Uri.joinPath(wsFolder.uri, targetFolderRel) : wsFolder.uri;

                            try {
                                await vscode.workspace.fs.createDirectory(targetDirUri);
                            } catch {
                                // Already exists
                            }

                            if (lastCopiedItem) {
                                const sourceUri = lastCopiedItem.uri;
                                const sourceName = sourceUri.path.split("/").filter(Boolean).pop() || "item";
                                let destUri = vscode.Uri.joinPath(targetDirUri, sourceName);

                                if (lastCopiedItem.isCut) {
                                    if (sourceUri.toString() !== destUri.toString()) {
                                        const edit = new vscode.WorkspaceEdit();
                                        edit.renameFile(sourceUri, destUri, { overwrite: false });
                                        await vscode.workspace.applyEdit(edit);
                                        vscode.window.showInformationMessage(`Moved '${sourceName}' to '${targetFolderRel || "root"}'.`);
                                    }
                                    lastCopiedItem = null;
                                } else {
                                    let finalDestUri = destUri;
                                    let exists = true;
                                    try {
                                        await vscode.workspace.fs.stat(finalDestUri);
                                    } catch {
                                        exists = false;
                                    }
                                    if (exists) {
                                        const ext = (!lastCopiedItem.isFolder && sourceName.includes(".")) ? "." + sourceName.split(".").pop() : "";
                                        const base = ext ? sourceName.slice(0, -ext.length) : sourceName;
                                        let copyIdx = 1;
                                        while (true) {
                                            const candName = `${base} copy${copyIdx > 1 ? " " + copyIdx : ""}${ext}`;
                                            const candUri = vscode.Uri.joinPath(targetDirUri, candName);
                                            try {
                                                await vscode.workspace.fs.stat(candUri);
                                                copyIdx++;
                                            } catch {
                                                finalDestUri = candUri;
                                                break;
                                            }
                                        }
                                    }
                                    await vscode.workspace.fs.copy(sourceUri, finalDestUri, { overwrite: false });
                                    vscode.window.showInformationMessage(`Pasted '${finalDestUri.path.split("/").pop()}'.`);
                                }
                                if (activePanel) {
                                    refreshThumbview(activePanel);
                                }
                            } else {
                                const clipboardText = (await vscode.env.clipboard.readText() || "").trim();
                                if (clipboardText && (clipboardText.startsWith("/") || clipboardText.match(/^[A-Za-z]:[\\/]/))) {
                                    const clipUri = vscode.Uri.file(clipboardText);
                                    try {
                                        await vscode.workspace.fs.stat(clipUri);
                                        const clipName = clipUri.path.split("/").filter(Boolean).pop() || "item";
                                        const destUri = vscode.Uri.joinPath(targetDirUri, clipName);
                                        await vscode.workspace.fs.copy(clipUri, destUri, { overwrite: false });
                                        vscode.window.showInformationMessage(`Pasted '${clipName}'.`);
                                        if (activePanel) {
                                            refreshThumbview(activePanel);
                                        }
                                        return;
                                    } catch {
                                        // Not a valid path, continue
                                    }
                                }
                                await vscode.commands.executeCommand("filesExplorer.paste");
                                if (activePanel) {
                                    refreshThumbview(activePanel);
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to paste: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "selectForCompare") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("selectForCompare", uri);
                        vscode.window.showInformationMessage(`Selected '${vscode.workspace.asRelativePath(uri)}' for compare.`);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to select for compare: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "compareWithSelected") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("compareFiles", uri);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to compare: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "openContainingFolder") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        const folderUri = vscode.Uri.joinPath(uri, "..");
                        await vscode.commands.executeCommand("revealFileInOS", folderUri);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to open containing folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "openWith") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("explorer.openWith", uri);
                    } catch {
                        try {
                            const uri = vscode.Uri.parse(msg.uri);
                            await vscode.commands.executeCommand("workbench.action.openWith", uri);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to open with: ${err?.message ?? String(err)}`);
                        }
                    }
                }

                if (msg.command === "openInTerminal") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("openInTerminal", uri);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to open in integrated terminal: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "openTimeline") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("filesExplorer.openTimeline", uri);
                    } catch {
                        try {
                            await vscode.commands.executeCommand("timeline.focus");
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to open timeline: ${err?.message ?? String(err)}`);
                        }
                    }
                }

                if (msg.command === "runTests") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                        await vscode.commands.executeCommand("testing.runCurrentFile");
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to run tests: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "debugTests") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                        await vscode.commands.executeCommand("testing.debugCurrentFile");
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to debug tests: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "coverageTests") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                        await vscode.commands.executeCommand("testing.coverageCurrentFile");
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to run tests with coverage: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "reorderFile") {
                    await withOrderLock(async () => {
                        const mode = getDragReorderMode();
                        const layoutMode = getLayoutMode();

                        try {
                            let forceBreakBeforeId: string | undefined;

                            if (msg.focusedFolder) {
                                const { ignorePatterns } = getIgnoreState();
                                const activeFiles = (cachedScannedFiles || []).filter(file => !shouldIgnore(file.path, ignorePatterns));
                                const scopedFiles = activeFiles.filter(f => f.path && (msg.focusedFolder === "(root files)/" ? !f.path.includes("/") : f.path.startsWith(msg.focusedFolder)));
                                const fullOrder = fileOrder.getOrder();
                                const folderOrders = context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderOrders") || {};
                                let currentFolderOrder = folderOrders[msg.focusedFolder] ? [...folderOrders[msg.focusedFolder]] : [];

                                const scopedIds = scopedFiles.map(f => f.id);
                                if (currentFolderOrder.length === 0) {
                                    currentFolderOrder = [...scopedIds];
                                } else {
                                    const presentIds = new Set(currentFolderOrder.filter(Boolean));
                                    for (const sid of scopedIds) {
                                        if (!presentIds.has(sid)) {
                                            const holeIdx = currentFolderOrder.indexOf("");
                                            if (holeIdx !== -1) {
                                                currentFolderOrder[holeIdx] = sid;
                                            } else {
                                                currentFolderOrder.push(sid);
                                            }
                                        }
                                    }
                                }

                                if (layoutMode === "spanning_grid") {
                                    const folderWrapRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderWrapRows") || {};
                                    if (Array.isArray(msg.currentOrder) && msg.currentOrder.length > 0) {
                                        currentFolderOrder = msg.currentOrder;
                                        if (typeof msg.wrapRows === "number") {
                                            folderWrapRowsMap[msg.focusedFolder] = msg.wrapRows;
                                            await context.workspaceState.update("thumbview.folderWrapRows", folderWrapRowsMap);
                                        }
                                    } else {
                                        const folderColsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {};
                                        const folderRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {};
                                        const extraCols = folderColsMap[msg.focusedFolder] || 0;
                                        const extraRows = folderRowsMap[msg.focusedFolder] || 0;
                                        const baseWrapRows = Math.max(1, Math.round(Math.sqrt(Math.max(scopedFiles.length, 1) / (16 / 9))));
                                        const wrapRows = folderWrapRowsMap[msg.focusedFolder] || msg.targetWrapRows || (baseWrapRows + extraRows);
                                        const maxAllowedCols = Math.max(2, msg.targetGridCols || (Math.max(2, Math.ceil(Math.round(Math.sqrt(Math.max(scopedFiles.length, 1) / (16 / 9))) * (16 / 9))) + extraCols));
                                        const maxAllowedRows = Math.max(1, wrapRows, msg.targetGridRows || (baseWrapRows + extraRows));

                                        // Folder scope uses its own frozen flow cells (column membership),
                                        // never the root's or the current line count; see slotFlowCells.
                                        const naturalCells = context.workspaceState.get<{ [id: string]: number }>("thumbview.naturalCells") || {};
                                        const folderFlow = getAllSlotFlowCells()[`folder:${msg.focusedFolder}`] || {};
                                        const currentAllocations: { [id: string]: number } = { ...naturalCells, ...folderFlow };
                                        for (const f of scopedFiles) {
                                            if (folderFlow[f.id] === undefined) {
                                                currentAllocations[f.id] = cellsNeeded(f.lineCount, DEFAULT_BASE_LINES_PER_CELL, getCompressionPct());
                                            }
                                        }

                                        const res = reorderSpanningItems(
                                            scopedIds,
                                            currentFolderOrder,
                                            currentAllocations,
                                            msg.sourceId,
                                            msg.targetCol,
                                            msg.targetRow,
                                            maxAllowedCols,
                                            maxAllowedRows,
                                            wrapRows
                                        );
                                        currentFolderOrder = res.newOrder;
                                        folderWrapRowsMap[msg.focusedFolder] = res.rows;
                                        await context.workspaceState.update("thumbview.folderWrapRows", folderWrapRowsMap);
                                    }
                                } else {
                                    const gridCols = Math.max(1, msg.targetGridCols || 1);
                                    const gridRows = Math.max(1, msg.targetGridRows || Math.ceil(currentFolderOrder.length / gridCols));
                                    const maxCapacity = gridCols * gridRows;
                                    const targetSlotIdx = (typeof msg.targetSlotIdx === "number" && msg.targetSlotIdx >= 0)
                                        ? msg.targetSlotIdx
                                        : (typeof msg.targetRow === "number" && typeof msg.targetCol === "number"
                                            ? msg.targetRow * gridCols + msg.targetCol
                                            : findSlotIndex(msg.targetCol, msg.targetRow, currentFolderOrder.length));

                                    currentFolderOrder = reorderFolderItems(
                                        currentFolderOrder,
                                        msg.sourceId,
                                        !!msg.targetIsEmpty,
                                        msg.targetId || null,
                                        targetSlotIdx,
                                        maxCapacity,
                                        mode
                                    );
                                }

                                folderOrders[msg.focusedFolder] = currentFolderOrder;
                                await context.workspaceState.update("thumbview.folderOrders", folderOrders);
                            } else if (layoutMode === "spanning_grid") {
                                if (Array.isArray(msg.currentOrder) && msg.currentOrder.length > 0) {
                                    fileOrder.setOrder(msg.currentOrder);
                                    if (typeof msg.wrapRows === "number") {
                                        await context.workspaceState.update("thumbview.spanningRows", msg.wrapRows);
                                    }
                                } else {
                                    const { ignorePatterns } = getIgnoreState();
                                    const activeFiles = (cachedScannedFiles || []).filter(file => !shouldIgnore(file.path, ignorePatterns));
                                    const activeFileIds = activeFiles.map(f => f.id);
                                    const savedAllocations = context.workspaceState.get<{ [id: string]: number }>("thumbview.spanningAllocations") || {};
                                    const savedRows = context.workspaceState.get<number | null>("thumbview.spanningRows") || null;
                                    const currentLayout = buildSpanningGrid(activeFiles, fileOrder.getOrder(), savedAllocations, savedRows);
                                    const sourceCells = savedAllocations[msg.sourceId] || 1;
                                    const targetCells = msg.targetId ? (savedAllocations[msg.targetId] || 1) : 1;

                                    if (!msg.targetIsEmpty && mode === "shift" && sourceCells === targetCells) {
                                        fileOrder.move(msg.sourceId, msg.targetId);
                                    } else {
                                        const extraCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
                                        const extraRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
                                        const maxAllowedRows = msg.targetGridRows || (Math.max(currentLayout.rows, currentLayout.wrapRows, savedRows || 0) + extraRows);
                                        const maxAllowedCols = msg.targetGridCols || (Math.max(currentLayout.cols, 2) + extraCols);
                                        const wrapRows = savedRows || currentLayout.wrapRows;

                                        // Frozen flow cells decide columns; only files never laid out fall back
                                        // to their current line count.
                                        const currentAllocations: { [id: string]: number } = { ...savedAllocations };
                                        for (const f of activeFiles) {
                                            if (currentAllocations[f.id] === undefined) {
                                                currentAllocations[f.id] = cellsNeeded(f.lineCount, DEFAULT_BASE_LINES_PER_CELL, getCompressionPct());
                                            }
                                        }

                                        const res = reorderSpanningItems(
                                            activeFileIds,
                                            fileOrder.getOrder(),
                                            currentAllocations,
                                            msg.sourceId,
                                            msg.targetCol,
                                            msg.targetRow,
                                            maxAllowedCols,
                                            maxAllowedRows,
                                            wrapRows
                                        );

                                        fileOrder.setOrder(res.newOrder);
                                        await context.workspaceState.update("thumbview.spanningRows", res.rows);
                                    }
                                }
                            } else {
                                if (msg.targetIsEmpty) {
                                    const extraCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
                                    const extraRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
                                    const layout = buildStableGrid(fileOrder.getOrder().length);
                                    const maxCols = layout.cols + extraCols;
                                    const maxRows = layout.rows + extraRows;
                                    const maxCapacity = maxCols * maxRows;

                                    const clamped = clampTargetToGridCapacity(msg.targetCol, msg.targetRow, 1, maxCols, maxRows);
                                    const rawTargetIndex = findSlotIndex(clamped.col, clamped.row, fileOrder.getOrder().length);
                                    const targetIndex = Math.min(rawTargetIndex, maxCapacity - 1);
                                    fileOrder.moveToEmptySlot(msg.sourceId, targetIndex);
                                } else if (mode === "shift") {
                                    fileOrder.move(msg.sourceId, msg.targetId);
                                } else {
                                    fileOrder.swap(msg.sourceId, msg.targetId);
                                }
                            }
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to reorder file: ${err?.message ?? String(err)}`);
                        }
                    });
                }

                if (msg.command === "moveFolderToFolder") {
                    try {
                        const wsFolder = vscode.workspace.workspaceFolders?.[0];
                        if (wsFolder) {
                            const srcRel = (msg.sourceFolder || "").replace(/^\/+|\/+$/g, "");
                            const tgtRel = (msg.targetFolder || "").replace(/^\/+|\/+$/g, "");
                            const folderName = srcRel.split("/").filter(Boolean).pop() || "folder";
                            const srcUri = vscode.Uri.joinPath(wsFolder.uri, srcRel);
                            const destUri = tgtRel ? vscode.Uri.joinPath(wsFolder.uri, tgtRel, folderName) : vscode.Uri.joinPath(wsFolder.uri, folderName);

                            if (srcUri.toString() !== destUri.toString()) {
                                const edit = new vscode.WorkspaceEdit();
                                edit.renameFile(srcUri, destUri, { overwrite: false });
                                const success = await vscode.workspace.applyEdit(edit);
                                if (success) {
                                    vscode.window.showInformationMessage(`Moved folder '${folderName}' to '${tgtRel || "root"}'.`);
                                    if (activePanel) {
                                        refreshThumbview(activePanel);
                                    }
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to move folder: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "reorderFolder") {
                    await withOrderLock(async () => {
                        try {
                            const srcFolderRel = (msg.sourceFolder || "").replace(/^\/+|\/+$/g, "") + "/";
                            const currentOrder = fileOrder.getOrder();
                            const pathById = new Map((cachedScannedFiles || []).map(cf => [cf.id, cf.path]));
                            const srcFiles = currentOrder.filter(id => (pathById.get(id) || "").startsWith(srcFolderRel) && pathById.has(id));

                            if (srcFiles.length > 0) {
                                const srcSet = new Set(srcFiles);
                                const remainingOrder = currentOrder.filter(id => !srcSet.has(id));
                                let insertIdx = remainingOrder.length;

                                if (msg.targetFolder) {
                                    const tgtFolderRel = (msg.targetFolder || "").replace(/^\/+|\/+$/g, "") + "/";
                                    const tgtFirstIdx = remainingOrder.findIndex(id => pathById.has(id) && (pathById.get(id) || "").startsWith(tgtFolderRel));
                                    if (tgtFirstIdx !== -1) {
                                        insertIdx = tgtFirstIdx;
                                    }
                                }
                                remainingOrder.splice(insertIdx, 0, ...srcFiles);
                                fileOrder.setOrder(remainingOrder);
                                if (activePanel) {
                                    updateLayoutFromCache(activePanel);
                                }
                            }
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to reorder folder: ${err?.message ?? String(err)}`);
                        }
                    });
                }

                if (msg.command === "swapCardItems") {
                    await withOrderLock(async () => {
                        try {
                            const fullOrder = fileOrder.getOrder();
                            const pathById = new Map((cachedScannedFiles || []).map(cf => [cf.id, cf.path]));

                            const getIdsForItem = (itemId: string): string[] => {
                                if (!itemId) return [];
                                if (itemId.startsWith("folder:")) {
                                    const folderRel = itemId.substring(7);
                                    return fullOrder.filter(id => pathById.has(id) && (pathById.get(id) || "").startsWith(folderRel));
                                } else {
                                    return [itemId];
                                }
                            };

                            const isFolderTarget = !!msg.focusedFolder;
                            const folderCardOrders = isFolderTarget
                                ? (context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderCardOrders") || {})
                                : {};
                            let cardOrder: string[] = [];
                            if (Array.isArray(msg.currentCardIds) && msg.currentCardIds.length > 0) {
                                cardOrder = [...msg.currentCardIds];
                            } else if (isFolderTarget) {
                                cardOrder = folderCardOrders[msg.focusedFolder] ? [...folderCardOrders[msg.focusedFolder]] : [];
                            } else {
                                cardOrder = context.workspaceState.get<string[]>("thumbview.cardOrder") || [];
                            }
                            if (msg.sourceId && !cardOrder.includes(msg.sourceId)) {
                                cardOrder.push(msg.sourceId);
                            }

                            if (msg.isSpanning) {
                                if (isFolderTarget) {
                                    folderCardOrders[msg.focusedFolder] = cardOrder;
                                    if (typeof msg.wrapRows === "number") {
                                        const folderCardWrapRows = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderCardWrapRows") || {};
                                        folderCardWrapRows[msg.focusedFolder] = msg.wrapRows;
                                        await context.workspaceState.update("thumbview.folderCardWrapRows", folderCardWrapRows);
                                    }
                                    await context.workspaceState.update("thumbview.folderCardOrders", folderCardOrders);
                                } else {
                                    if (typeof msg.wrapRows === "number") {
                                        await context.workspaceState.update("thumbview.cardWrapRows", msg.wrapRows);
                                    }
                                    await context.workspaceState.update("thumbview.cardOrder", cardOrder);
                                }
                                return;
                            }

                            if (msg.targetIsEmpty) {
                                const maxCapacity = Math.max(1, msg.maxCapacity || cardOrder.length || 1);
                                cardOrder = reorderCardItems(cardOrder, msg.sourceId, true, null, msg.targetSlotIdx, maxCapacity);
                                if (isFolderTarget) {
                                    folderCardOrders[msg.focusedFolder] = cardOrder;
                                    await context.workspaceState.update("thumbview.folderCardOrders", folderCardOrders);
                                } else {
                                    await context.workspaceState.update("thumbview.cardOrder", cardOrder);
                                }
                                return;
                            }

                            const srcIds = getIdsForItem(msg.sourceId);
                            const tgtIds = getIdsForItem(msg.targetId);

                            if (srcIds.length > 0 && tgtIds.length > 0 && msg.sourceId !== msg.targetId) {
                                if (cardOrder.length > 0) {
                                    cardOrder = reorderCardItems(cardOrder, msg.sourceId, false, msg.targetId, 0, cardOrder.length);
                                    if (isFolderTarget) {
                                        folderCardOrders[msg.focusedFolder] = cardOrder;
                                        await context.workspaceState.update("thumbview.folderCardOrders", folderCardOrders);
                                    } else {
                                        await context.workspaceState.update("thumbview.cardOrder", cardOrder);
                                    }
                                }

                                if (!isFolderTarget) {
                                    const srcFirst = fullOrder.indexOf(srcIds[0]);
                                    const tgtFirst = fullOrder.indexOf(tgtIds[0]);

                                    if (srcFirst !== -1 && tgtFirst !== -1) {
                                        const srcIdSet = new Set(srcIds);
                                        const remaining = fullOrder.filter(id => !srcIdSet.has(id));
                                        const newTgtIdx = remaining.indexOf(tgtIds[0]);
                                        if (newTgtIdx !== -1) {
                                            if (srcFirst < tgtFirst) {
                                                remaining.splice(newTgtIdx + tgtIds.length, 0, ...srcIds);
                                            } else {
                                                remaining.splice(newTgtIdx, 0, ...srcIds);
                                            }
                                            fileOrder.setOrder(remaining);
                                        }
                                    }
                                }
                            }
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to swap items: ${err?.message ?? String(err)}`);
                        }
                    });
                }

                if (msg.command === "expandSpace") {
                    try {
                        const targetFolder = typeof msg.focusedFolder === "string" ? msg.focusedFolder : "";
                        if (targetFolder) {
                            const folderColsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {};
                            const folderRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {};
                            folderColsMap[targetFolder] = (folderColsMap[targetFolder] || 0) + 1;
                            folderRowsMap[targetFolder] = (folderRowsMap[targetFolder] || 0) + 1;
                            await context.workspaceState.update("thumbview.folderExtraCols", folderColsMap);
                            await context.workspaceState.update("thumbview.folderExtraRows", folderRowsMap);

                        } else {
                            const curCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
                            const curRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
                            await context.workspaceState.update("thumbview.extraCols", curCols + 1);
                            await context.workspaceState.update("thumbview.extraRows", curRows + 1);
                            const folderColsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {};
                            const folderRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {};
                            folderColsMap[""] = curCols + 1;
                            folderRowsMap[""] = curRows + 1;
                            await context.workspaceState.update("thumbview.folderExtraCols", folderColsMap);
                            await context.workspaceState.update("thumbview.folderExtraRows", folderRowsMap);
                        }
                        vscode.window.showInformationMessage("Expanded grid space.");
                        if (activePanel) {
                            updateLayoutFromCache(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to expand space: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "reduceSpace") {
                    try {
                        const targetFolder = typeof msg.focusedFolder === "string" ? msg.focusedFolder : "";
                        if (targetFolder) {
                            const folderColsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {};
                            const folderRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {};
                            const curCols = folderColsMap[targetFolder] || 0;
                            const curRows = folderRowsMap[targetFolder] || 0;
                            folderColsMap[targetFolder] = Math.max(0, curCols - 1);
                            folderRowsMap[targetFolder] = Math.max(0, curRows - 1);
                            await context.workspaceState.update("thumbview.folderExtraCols", folderColsMap);
                            await context.workspaceState.update("thumbview.folderExtraRows", folderRowsMap);
                        } else {
                            const curCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
                            const curRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
                            await context.workspaceState.update("thumbview.extraCols", Math.max(0, curCols - 1));
                            await context.workspaceState.update("thumbview.extraRows", Math.max(0, curRows - 1));
                            const folderColsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {};
                            const folderRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {};
                            folderColsMap[""] = Math.max(0, curCols - 1);
                            folderRowsMap[""] = Math.max(0, curRows - 1);
                            await context.workspaceState.update("thumbview.folderExtraCols", folderColsMap);
                            await context.workspaceState.update("thumbview.folderExtraRows", folderRowsMap);
                        }
                        vscode.window.showInformationMessage("Reduced grid space.");
                        if (activePanel) {
                            updateLayoutFromCache(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to reduce space: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "setDragReorderMode") {
                    try {
                        const config = vscode.workspace.getConfiguration("thumbview");
                        if (msg.mode !== "swap" && msg.mode !== "shift") {
                            return;
                        }
                        await config.update("dragReorderMode", msg.mode, vscode.ConfigurationTarget.Global);
                        const modeStr = !msg.mode ? "" : msg.mode.charAt(0).toUpperCase() + msg.mode.slice(1);
                        vscode.window.showInformationMessage(`Thumbview Drag Reorder Mode set to ${modeStr}.`);
                        if (activePanel) {
                            updateLayoutFromCache(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to set drag reorder mode: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "setLayoutMode") {
                    try {
                        const config = vscode.workspace.getConfiguration("thumbview");
                        if (msg.mode !== "uniform_grid" && msg.mode !== "spanning_grid") {
                            return;
                        }
                        await config.update("layoutMode", msg.mode, vscode.ConfigurationTarget.Global);
                        if (activePanel) {
                            refreshThumbview(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to set layout mode: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "setRenderMediaThumbnails") {
                    try {
                        const config = vscode.workspace.getConfiguration("thumbview");
                        await config.update("renderMediaThumbnails", !!msg.enabled, vscode.ConfigurationTarget.Global);
                        if (activePanel) {
                            refreshThumbview(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to set media thumbnails: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "setCompressionPercentage") {
                    try {
                        const val = Math.max(0, Math.min(25, Math.round(Number(msg.value) || 0)));
                        const config = vscode.workspace.getConfiguration("thumbview");
                        await context.workspaceState.update("thumbview.spanningRows", undefined);
                        await context.workspaceState.update("thumbview.spanningAllocations", undefined);
                        lastSpanningPlacements = [];
                        await config.update("compressionPercentage", val, vscode.ConfigurationTarget.Global);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to set compression percentage: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "setMinCellDimensions") {
                    try {
                        const w = Math.max(10, Math.min(500, Math.round(Number(msg.minCellWidth) || 60)));
                        const h = Math.max(10, Math.min(500, Math.round(Number(msg.minCellHeight) || 40)));
                        const config = vscode.workspace.getConfiguration("thumbview");
                        await config.update("minCellWidth", w, vscode.ConfigurationTarget.Global);
                        await config.update("minCellHeight", h, vscode.ConfigurationTarget.Global);
                        if (activePanel) {
                            refreshThumbview(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to set tile collapse dimensions: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "setAutoIgnoreThreshold") {
                    try {
                        const val = Math.max(0, Math.round(Number(msg.threshold) || 0));
                        const config = vscode.workspace.getConfiguration("thumbview");
                        await config.update("autoIgnoreThreshold", val, vscode.ConfigurationTarget.Global);
                        clearScanCache();
                        if (activePanel) {
                            refreshThumbview(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to set auto-ignore threshold: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "refresh") {
                    try {
                        clearScanCache();
                        cachedAllRelativePaths = [];
                        await getAllWorkspaceRelativePaths().catch(() => {});
                        refreshProviders();
                        if (activePanel) {
                            await refreshThumbview(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to refresh: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "reflow") {
                    try {
                        const targetFolder = typeof msg.focusedFolder === "string" ? msg.focusedFolder : "";
                        if (targetFolder) {
                            const folderOrders = context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderOrders") || {};
                            const folderWrapRows = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderWrapRows") || {};
                            const folderCardOrders = context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderCardOrders") || {};
                            const folderCardWrapRows = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderCardWrapRows") || {};
                            const folderExtraCols = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {};
                            const folderExtraRows = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {};

                            delete folderOrders[targetFolder];
                            delete folderWrapRows[targetFolder];
                            delete folderCardOrders[targetFolder];
                            delete folderCardWrapRows[targetFolder];
                            delete folderExtraCols[targetFolder];
                            delete folderExtraRows[targetFolder];

                            await context.workspaceState.update("thumbview.folderOrders", folderOrders);
                            await context.workspaceState.update("thumbview.folderWrapRows", folderWrapRows);
                            await context.workspaceState.update("thumbview.folderCardOrders", folderCardOrders);
                            await context.workspaceState.update("thumbview.folderCardWrapRows", folderCardWrapRows);
                            await context.workspaceState.update("thumbview.folderExtraCols", folderExtraCols);
                            await context.workspaceState.update("thumbview.folderExtraRows", folderExtraRows);
                            const allFootprints = getAllSlotFootprints();
                            delete allFootprints[`folder:${targetFolder}`];
                            delete allFootprints[`cards:${targetFolder}`];
                            await context.workspaceState.update("thumbview.slotFootprints", allFootprints);
                            const allFlowCells = getAllSlotFlowCells();
                            delete allFlowCells[`folder:${targetFolder}`];
                            delete allFlowCells[`cards:${targetFolder}`];
                            await context.workspaceState.update("thumbview.slotFlowCells", allFlowCells);

                            if (activePanel) {
                                await updateLayoutFromCache(activePanel);
                            }
                        } else {
                            await vscode.commands.executeCommand("thumbview.reflow");
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to reflow layout: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "addIgnorePattern") {
                    try {
                        const pattern = (msg.pattern || "").replace(/\\/g, "/").trim();
                        if (pattern) {
                            const state = getIgnoreState();
                            const cleanPattern = pattern.replace(/\/+$/, "");
                            const exists = state.ignorePatterns.some(p => p === pattern || p.replace(/\/+$/, "") === cleanPattern);
                            if (!exists) {
                                await persistIgnoreState({ ...state, ignorePatterns: [pattern, ...state.ignorePatterns] });
                                vscode.window.showInformationMessage(`Added '${pattern}' to ignore list.`);
                                refreshProviders();
                            }
                            if (activePanel) {
                                await updateLayoutFromCache(activePanel);
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to add ignore pattern: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "removeIgnorePattern") {
                    try {
                        const pattern = (msg.pattern || "").trim();
                        if (pattern) {
                            const state = getIgnoreState();
                            const cleanPattern = pattern.replace(/\/+$/, "");
                            const updatedPatterns = state.ignorePatterns.filter(p => p !== pattern && p.replace(/\/+$/, "") !== cleanPattern);
                            const updatedExclusions = [...state.autoIgnoreExclusions];
                            if (!updatedExclusions.some(p => p === pattern || p.replace(/\/+$/, "") === cleanPattern)) {
                                updatedExclusions.push(pattern);
                            }
                            await persistIgnoreState({ ignorePatterns: updatedPatterns, autoIgnoreExclusions: updatedExclusions });
                            vscode.window.showInformationMessage(`Unignored '${pattern}'.`);
                            refreshProviders();
                            if (activePanel) {
                                await refreshThumbview(activePanel);
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to remove ignore pattern: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "configureHotkey") {
                    vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "thumbview.open");
                }
            });

            panel.onDidChangeViewState(async e => {
                const actions = session.viewStateChanged(
                    { visible: e.webviewPanel.visible, active: e.webviewPanel.active, layoutOpInFlight: layoutOpsInFlight > 0 },
                    !!editorGroups.returnPoint
                );
                if (actions.recordReturnPoint) {
                    // Came back without F4 (tab click, Ctrl+Tab): return to the editor just left.
                    editorGroups.recordReturnPoint(editorInfo(lastActiveTextEditor), panel.viewColumn);
                }
                if (actions.clearReturnPoint) {
                    editorGroups.clearReturnPoint();
                }
                if (actions.releaseHold) {
                    sendOpenState();
                }
                if (!e.webviewPanel.visible) {
                    // Sent even mid-transition: the webview's fast reopen path needs to know the
                    // panel really was backgrounded (protocol: "panelHidden", no fields).
                    panel.webview.postMessage({ command: "panelHidden" });
                }
                if (layoutOpsInFlight > 0) {
                    return;
                }
                if (e.webviewPanel.visible && e.webviewPanel.active) {
                    if (fullscreenActive && vscode.window.tabGroups.all.length > 1 && !groupMaximizedByUs) {
                        // User dragged the tab into a new split, breaking zen mode layout. Close gracefully.
                        // (Groups hidden by our own maximize are expected, not a user split.)
                        await closeActiveThumbview();
                        return;
                    }
                    flushHiddenRefresh(panel);
                    sendOpenState();
                    endTransition(panel);
                } else if (e.webviewPanel.visible) {
                    flushHiddenRefresh(panel);
                    endTransition(panel);
                } else if (!e.webviewPanel.visible && fullscreenActive) {
                    // Exit only when Thumbview is truly backgrounded — an inactive
                    // but still visible panel is just a focus shift, not leaving
                    await withLayoutLock(async () => {
                        if (thumbviewEnteredZenMode) {
                            thumbviewEnteredZenMode = false;
                            await exitFullscreen();
                        }
                        if (groupMaximizedByUs) {
                            await unmaximizeIfSplits();
                        }
                    });
                }
            });

            panel.onDidDispose(() => withLayoutLock(async () => {
                if (activePanel === panel) {
                    activePanel = undefined;
                }
                await unmaximizeIfSplits();
                if (thumbviewEnteredZenMode) {
                    thumbviewEnteredZenMode = false;
                    await exitFullscreen();
                }
            }));
    }, withLayoutLock);

    const disposable = vscode.commands.registerCommand("thumbview.open", () => toggleThumbview());
    context.subscriptions.push(disposable);

    const reflowDisposable = vscode.commands.registerCommand("thumbview.reflow", async () => {
        const files = await scanRepository(getIgnoreState(), persistIgnoreState);
        fileOrder.reflow(files.map(f => f.id));
        await context.workspaceState.update("thumbview.seenFiles", fileOrder.getOrder());
        await context.workspaceState.update("thumbview.spanningAllocations", undefined);
        await context.workspaceState.update("thumbview.spanningRows", undefined);
        await context.workspaceState.update("thumbview.cardOrder", undefined);
        await context.workspaceState.update("thumbview.cardWrapRows", undefined);
        await context.workspaceState.update("thumbview.folderOrders", undefined);
        await context.workspaceState.update("thumbview.folderWrapRows", undefined);
        await context.workspaceState.update("thumbview.folderCardOrders", undefined);
        await context.workspaceState.update("thumbview.folderCardWrapRows", undefined);
        await context.workspaceState.update("thumbview.extraCols", undefined);
        await context.workspaceState.update("thumbview.extraRows", undefined);
        await context.workspaceState.update("thumbview.folderExtraCols", undefined);
        await context.workspaceState.update("thumbview.folderExtraRows", undefined);
        await context.workspaceState.update("thumbview.slotFootprints", undefined);
        await context.workspaceState.update("thumbview.naturalCells", undefined);
        await context.workspaceState.update("thumbview.slotFlowCells", undefined);
        lastSpanningPlacements = [];

        if (activePanel) {
            refreshThumbview(activePanel);
        } else {
            vscode.commands.executeCommand("thumbview.open");
        }
        vscode.window.showInformationMessage("Thumbview layout reflowed and gaps filled.");
    });
    context.subscriptions.push(reflowDisposable);

    const expandSpaceDisposable = vscode.commands.registerCommand("thumbview.expandSpace", async () => {
        const curCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
        const curRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
        await context.workspaceState.update("thumbview.extraCols", curCols + 1);
        await context.workspaceState.update("thumbview.extraRows", curRows + 1);
        const folderColsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {};
        const folderRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {};
        folderColsMap[""] = curCols + 1;
        folderRowsMap[""] = curRows + 1;
        await context.workspaceState.update("thumbview.folderExtraCols", folderColsMap);
        await context.workspaceState.update("thumbview.folderExtraRows", folderRowsMap);
        vscode.window.showInformationMessage("Expanded grid space.");
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(expandSpaceDisposable);

    const reduceSpaceDisposable = vscode.commands.registerCommand("thumbview.reduceSpace", async () => {
        const curCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
        const curRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
        await context.workspaceState.update("thumbview.extraCols", Math.max(0, curCols - 1));
        await context.workspaceState.update("thumbview.extraRows", Math.max(0, curRows - 1));
        const folderColsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraCols") || {};
        const folderRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderExtraRows") || {};
        folderColsMap[""] = Math.max(0, curCols - 1);
        folderRowsMap[""] = Math.max(0, curRows - 1);
        await context.workspaceState.update("thumbview.folderExtraCols", folderColsMap);
        await context.workspaceState.update("thumbview.folderExtraRows", folderRowsMap);
        vscode.window.showInformationMessage("Reduced grid space.");
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(reduceSpaceDisposable);

    const setUniformGridDisposable = vscode.commands.registerCommand("thumbview.setUniformGrid", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("layoutMode", "uniform_grid", vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("Thumbview Layout set to Uniform Grid.");
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(setUniformGridDisposable);

    const setSpanningGridDisposable = vscode.commands.registerCommand("thumbview.setSpanningGrid", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("layoutMode", "spanning_grid", vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("Thumbview Layout set to Spanning Grid.");
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(setSpanningGridDisposable);

    const setSwapReorderModeDisposable = vscode.commands.registerCommand("thumbview.setSwapReorderMode", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("dragReorderMode", "swap", vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("Thumbview Drag Reorder Mode set to Swap.");
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(setSwapReorderModeDisposable);

    const setShiftReorderModeDisposable = vscode.commands.registerCommand("thumbview.setShiftReorderMode", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("dragReorderMode", "shift", vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("Thumbview Drag Reorder Mode set to Shift.");
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }   
    });
    context.subscriptions.push(setShiftReorderModeDisposable);

    const configureHotkeyDisposable = vscode.commands.registerCommand("thumbview.configureHotkey", async () => {
        vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "thumbview.open");
    });
    context.subscriptions.push(configureHotkeyDisposable);


    const refreshProviders = () => {
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    };

    const ignoreDirectoryDisposable = vscode.commands.registerCommand("thumbview.ignoreDirectory", async (item?: DirectoryTreeItem) => {
        const folderPath = item?.folderPath;
        if (folderPath && !item?.isRoot) {
            const state = getIgnoreState();
            const cleanPattern = folderPath.replace(/\/+$/, "");
            const exists = state.ignorePatterns.some(p => p === folderPath || p.replace(/\/+$/, "") === cleanPattern);
            if (!exists) {
                await persistIgnoreState({ ...state, ignorePatterns: [folderPath, ...state.ignorePatterns] });
                vscode.window.showInformationMessage(`Ignored directory '${folderPath}'. Check out 'Ignored Files & Directories' in the Thumbview sidebar to unignore it if you want.`);
                refreshProviders();
                if (activePanel) {
                    updateLayoutFromCache(activePanel);
                }
            }
        }
    });
    context.subscriptions.push(ignoreDirectoryDisposable);

    const addIgnoreDisposable = vscode.commands.registerCommand("thumbview.addIgnorePattern", async () => {
        const input = await vscode.window.showInputBox({
            prompt: "Enter file/directory relative path or pattern to ignore in Thumbview",
            placeHolder: "e.g. src/legacy/ or *.test.js"
        });
        if (input && input.trim()) {
            const state = getIgnoreState();
            const pattern = input.trim();
            const cleanPattern = pattern.replace(/\/+$/, "");
            const exists = state.ignorePatterns.some(p => p === pattern || p.replace(/\/+$/, "") === cleanPattern);
            if (!exists) {
                await persistIgnoreState({ ...state, ignorePatterns: [pattern, ...state.ignorePatterns] });
                vscode.window.showInformationMessage(`Added '${pattern}' to ignore list.`);
                refreshProviders();
                if (activePanel) {
                    updateLayoutFromCache(activePanel);
                }
            }
        }
    });
    context.subscriptions.push(addIgnoreDisposable);

    const removeIgnoreDisposable = vscode.commands.registerCommand("thumbview.removeIgnorePattern", async (item?: IgnoreTreeItem | DirectoryTreeItem, items?: (IgnoreTreeItem | DirectoryTreeItem)[]) => {
        const state = getIgnoreState();

        const targetItems = items && items.length > 0 ? items : (item ? [item] : []);
        let patternsToRemove: string[] = targetItems.map(i => {
            if (i instanceof IgnoreTreeItem) return i.pattern;
            if (i instanceof DirectoryTreeItem) return i.folderPath;
            return (i as any)?.pattern || (i as any)?.folderPath || "";
        }).filter(Boolean);

        if (patternsToRemove.length === 0 && state.ignorePatterns.length > 0) {
            const selected = await vscode.window.showQuickPick(state.ignorePatterns, {
                placeHolder: "Select pattern to unignore",
                canPickMany: true
            });
            if (selected) {
                patternsToRemove = Array.isArray(selected) ? selected : [selected];
            }
        }

        if (patternsToRemove.length > 0) {
            const cleanTargets = patternsToRemove.map(p => p.replace(/\/+$/, ""));
            const updatedPatterns = state.ignorePatterns.filter(p => !patternsToRemove.includes(p) && !cleanTargets.includes(p.replace(/\/+$/, "")));
            const updatedExclusions = [...state.autoIgnoreExclusions];
            for (const p of patternsToRemove) {
                const cleanP = p.replace(/\/+$/, "");
                if (!updatedExclusions.some(e => e === p || e.replace(/\/+$/, "") === cleanP)) {
                    updatedExclusions.push(p);
                }
            }
            // Write exclusions and updated patterns atomically
            await persistIgnoreState({ ignorePatterns: updatedPatterns, autoIgnoreExclusions: updatedExclusions });

            const msg = patternsToRemove.length === 1
                ? `Unignored '${patternsToRemove[0]}'.`
                : `Batch unignored ${patternsToRemove.length} items.`;
            vscode.window.showInformationMessage(msg);
            refreshProviders();
            if (activePanel) {
                await refreshThumbview(activePanel);
            }
        }
    });
    context.subscriptions.push(removeIgnoreDisposable);

    const focusFolderDisposable = vscode.commands.registerCommand("thumbview.focusFolder", async (folderPath?: string | DirectoryTreeItem) => {
        let targetFolder = typeof folderPath === "string" ? folderPath : folderPath?.folderPath || "";
        let panel = activePanel;
        if (!panel || !panel.visible) {
            await vscode.commands.executeCommand("thumbview.open");
            panel = activePanel;
        }
        if (panel) {
            panel.webview.postMessage({
                command: "setFocusedFolder",
                folder: targetFolder
            });
            panel.reveal(vscode.ViewColumn.Active);
        }
    });
    context.subscriptions.push(focusFolderDisposable);

    const revealInExplorerDisposable = vscode.commands.registerCommand("thumbview.revealInExplorer", async (item?: DirectoryTreeItem | IgnoreTreeItem) => {
        if (!item) { return; }
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) { return; }

        let itemRelativePath = "";
        if (item instanceof DirectoryTreeItem) {
            if (!item.isRoot) {
                itemRelativePath = item.folderPath;
            }
        } else if (item instanceof IgnoreTreeItem) {
            itemRelativePath = item.pattern.trim().replace(/^\/+|\/+$/g, "");
        } else if (typeof (item as any).folderPath === "string") {
            itemRelativePath = (item as any).folderPath;
        } else if (typeof (item as any).pattern === "string") {
            itemRelativePath = (item as any).pattern.trim().replace(/^\/+|\/+$/g, "");
        }

        const targetUri = itemRelativePath ? vscode.Uri.joinPath(wsFolder.uri, itemRelativePath) : wsFolder.uri;
        await vscode.commands.executeCommand("revealInExplorer", targetUri);
    });
    context.subscriptions.push(revealInExplorerDisposable);

    const deleteDirectoryDisposable = vscode.commands.registerCommand("thumbview.deleteDirectory", async (item?: DirectoryTreeItem | IgnoreTreeItem, items?: (DirectoryTreeItem | IgnoreTreeItem)[]) => {
        const targetItems = items && items.length > 0 ? items : (item ? [item] : []);
        if (targetItems.length === 0) { return; }

        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) { return; }

        const validItems = targetItems.filter(i => {
            if (i instanceof DirectoryTreeItem && (i.isRoot || !i.folderPath)) return false;
            if (i instanceof IgnoreTreeItem && !i.pattern) return false;
            return true;
        });
        if (validItems.length === 0) { return; }

        const itemPaths: { path: string; isIgnoreItem: boolean; rawPattern?: string }[] = validItems.map(i => {
            if (i instanceof DirectoryTreeItem || typeof (i as any).folderPath === "string") {
                return { path: (i as any).folderPath, isIgnoreItem: false };
            } else {
                const pat = (i as IgnoreTreeItem).pattern;
                return { path: pat.trim().replace(/^\/+|\/+$/g, ""), isIgnoreItem: true, rawPattern: pat };
            }
        });

        const labelStr = itemPaths.length === 1 ? `'${itemPaths[0].path}'` : `${itemPaths.length} items`;
        const mode = await askDeleteMode(labelStr);

        if (mode) {
            const useTrash = mode === "trash";
            const ignoreState = getIgnoreState();
            const patternsToRemove: string[] = [];

            for (const itemInfo of itemPaths) {
                try {
                    const targetUri = vscode.Uri.joinPath(wsFolder.uri, itemInfo.path);
                    await vscode.workspace.fs.delete(targetUri, { recursive: true, useTrash });
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to delete '${itemInfo.path}': ${err?.message ?? String(err)}`);
                }
                if (itemInfo.isIgnoreItem && itemInfo.rawPattern) {
                    patternsToRemove.push(itemInfo.rawPattern);
                }
            }

            if (patternsToRemove.length > 0) {
                const updatedPatterns = ignoreState.ignorePatterns.filter(p => !patternsToRemove.includes(p));
                await persistIgnoreState({ ...ignoreState, ignorePatterns: updatedPatterns });
            }

            refreshProviders();
            if (activePanel) { refreshThumbview(activePanel); }
        }
    });
    context.subscriptions.push(deleteDirectoryDisposable);

    const deleteIgnoredDisposable = vscode.commands.registerCommand("thumbview.deleteIgnoredItem", async (item?: IgnoreTreeItem, items?: IgnoreTreeItem[]) => {
        return vscode.commands.executeCommand("thumbview.deleteDirectory", item, items);
    });
    context.subscriptions.push(deleteIgnoredDisposable);

    const showAllFoldersDisposable = vscode.commands.registerCommand("thumbview.showAllFolders", async () => {
        vscode.commands.executeCommand("thumbview.focusFolder", "");
    });
    context.subscriptions.push(showAllFoldersDisposable);

    // Watch configuration changes (ignorePatterns no longer lives in config — only
    // layoutMode, renderMediaThumbnails, and autoIgnoreThreshold are real settings)
    const configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (!activePanel) return;
        if (e.affectsConfiguration("thumbview.fullscreenOnOpen")) {
            const enabled = isFullscreenOnOpen();
            activePanel.webview.postMessage({ command: "fullscreenSetting", enabled });
            if (!enabled) {
                // Turned off while open: leave fullscreen now and keep Thumbview as a normal tab.
                withLayoutLock(async () => {
                    layoutOpsInFlight++;
                    try {
                        await leaveFullscreenAfterSwitch();
                    } finally {
                        releaseLayoutOp();
                    }
                }).catch(() => {});
            }
        }
        if (e.affectsConfiguration("thumbview.autoIgnoreThreshold")) {
            clearScanCache();
            refreshThumbview(activePanel);
        } else if (
            e.affectsConfiguration("thumbview.layoutMode") ||
            e.affectsConfiguration("thumbview.renderMediaThumbnails") ||
            e.affectsConfiguration("thumbview.minCellWidth") ||
            e.affectsConfiguration("thumbview.minCellHeight") ||
            e.affectsConfiguration("thumbview.compressionPercentage")
        ) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(configDisposable);

    const updateVisibleRanges = (editor?: vscode.TextEditor | undefined) => {
        const processEditor = (e: vscode.TextEditor) => {
            if (e && e.visibleRanges && e.visibleRanges.length > 0) {
                const uri = e.document.uri.toString();
                const primaryRange = e.visibleRanges[0];
                viewLocations[uri] = {
                    startLine: primaryRange.start.line,
                    endLine: primaryRange.end.line,
                    scrollLine: primaryRange.start.line
                };
            }
        };

        for (const visibleEditor of vscode.window.visibleTextEditors) {
            processEditor(visibleEditor);
        }
        if (editor) {
            processEditor(editor);
        }
    };

    let stateDebounceTimer: NodeJS.Timeout | undefined;
    const scheduleSendOpenState = (delayMs = 30) => {
        if (stateDebounceTimer) {
            clearTimeout(stateDebounceTimer);
        }
        stateDebounceTimer = setTimeout(() => {
            sendOpenState();
        }, delayMs);
    };

    // Watch active editor changes
    const editorDisposable = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document.uri.scheme !== "vscode-webview") {
            lastActiveTextEditor = editor;
        }
        updateVisibleRanges(editor);
        scheduleSendOpenState(0);
    });
    context.subscriptions.push(editorDisposable);

    // Watch text editor visible range changes (scroll/viewport movements)
    const visibleRangesDisposable = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
        updateVisibleRanges(event.textEditor);
        scheduleSendOpenState(250);
    });
    context.subscriptions.push(visibleRangesDisposable);

    // Watch tab changes
    const tabDisposable = vscode.window.tabGroups.onDidChangeTabs(() => {
        sendOpenState();
    });
    context.subscriptions.push(tabDisposable);

    // Watch workspace changes. Debounced 200ms so a batch of file operations (e.g. a
    // git branch switch, or a build writing many files) triggers one rescan/postMessage
    // instead of flooding the webview with a message per file event.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    let debounceTimer: NodeJS.Timeout | undefined;
    let pendingSaveGitDiff: Promise<unknown> = Promise.resolve();
    const triggerUpdate = (uri?: vscode.Uri) => {
        if (uri) {
            invalidateScanFile(uri.fsPath);
        } else {
            clearScanCache();
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(async () => {
            // A save starts a git diff fetch; wait for it so the rescan's single payload carries fresh git markers.
            await pendingSaveGitDiff;
            await getAllWorkspaceRelativePaths().catch(() => {});
            refreshProviders();
            refreshOrDefer("rescan");
        }, 200);
    };

    // .git churn and dependency installs never touch shown files. Other ignored output (e.g.
    // `npm run watch` writing a gitignored out/) still reaches the debounced rescan, which posts
    // nothing when the scanned file set is unchanged (see refreshThumbview).
    const isUnscannedPath = (uri: vscode.Uri) =>
        isAlwaysExcluded(vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"));
    const onWatcherEvent = (uri: vscode.Uri) => {
        if (!isUnscannedPath(uri)) {
            triggerUpdate(uri);
        }
    };
    watcher.onDidCreate(onWatcherEvent);
    watcher.onDidDelete(onWatcherEvent);
    watcher.onDidChange(onWatcherEvent);

    // Debounced so typing rebuilds the cached document and re-posts the workspace payload once
    // per pause, not once per keystroke.
    let docChangeDebounceTimer: NodeJS.Timeout | undefined;
    const pendingChangedDocs = new Map<string, vscode.TextDocument>();
    const docChangeDisposable = vscode.workspace.onDidChangeTextDocument(e => {
        if (e.contentChanges.length === 0) {
            return;
        }
        pendingChangedDocs.set(e.document.uri.toString(), e.document);
        if (docChangeDebounceTimer) {
            clearTimeout(docChangeDebounceTimer);
        }
        docChangeDebounceTimer = setTimeout(() => {
            for (const doc of pendingChangedDocs.values()) {
                updateDocumentInCache(doc);
            }
            pendingChangedDocs.clear();
            refreshOrDefer("layout");
        }, 300);
    });
    context.subscriptions.push(docChangeDisposable);

    // The save's own watcher event (or this triggerUpdate) rescans the file from disk, so a save
    // produces one payload instead of a git-diff layout post followed by a rescan post.
    const docSaveDisposable = vscode.workspace.onDidSaveTextDocument(doc => {
        pendingChangedDocs.delete(doc.uri.toString());
        pendingSaveGitDiff = fetchWorkspaceGitDiff().catch(() => {});
        triggerUpdate(doc.uri);
    });
    context.subscriptions.push(docSaveDisposable);

    let diagDebounceTimer: NodeJS.Timeout | undefined;
    let lastErrorDiagnosticsSignature = "";
    const errorDiagnosticsSignature = (): string => {
        const parts: string[] = [];
        for (const [uri, diags] of vscode.languages.getDiagnostics()) {
            if (uri.scheme !== "file") {
                continue;
            }
            for (const d of diags) {
                if (d.severity === vscode.DiagnosticSeverity.Error) {
                    parts.push(`${uri.toString()}|${d.range.start.line}-${d.range.end.line}|${d.message}`);
                }
            }
        }
        return parts.sort().join("\n");
    };
    const diagDisposable = vscode.languages.onDidChangeDiagnostics(() => {
        if (diagDebounceTimer) {
            clearTimeout(diagDebounceTimer);
        }
        // Language servers publish diagnostics in bursts while warming up; 500ms collapses a burst into one update.
        diagDebounceTimer = setTimeout(() => {
            // Tiles only show error markers, and every editor switch (including each Thumbview
            // open/close) republishes warnings and hints. Skip the full workspace payload unless
            // the set of errors actually changed.
            const signature = errorDiagnosticsSignature();
            if (signature === lastErrorDiagnosticsSignature) {
                return;
            }
            lastErrorDiagnosticsSignature = signature;
            refreshOrDefer("layout");
        }, 500);
    });
    context.subscriptions.push(diagDisposable);

    context.subscriptions.push(watcher);
}

// Set by activate(): restores the user's zenMode.* settings if Thumbview is fullscreen when the
// extension host shuts down.
let deactivateHook: (() => Promise<void>) | undefined;

/**
 * Asks how to delete `label`. Moving to the Trash is the first, recoverable choice; a permanent
 * delete needs a second, explicit confirmation because it cannot be undone.
 */
async function askDeleteMode(label: string): Promise<"trash" | "permanent" | undefined> {
    const choice = await vscode.window.showWarningMessage(
        `Delete ${label}?`,
        { modal: true, detail: "Moving to the Trash can be undone from your system's Trash." },
        "Move to Trash",
        "Delete Permanently"
    );
    if (choice === "Move to Trash") {
        return "trash";
    }
    if (choice !== "Delete Permanently") {
        return undefined;
    }
    const confirmed = await vscode.window.showWarningMessage(
        `Permanently delete ${label}?`,
        { modal: true, detail: "This cannot be undone." },
        "Delete Permanently"
    );
    return confirmed === "Delete Permanently" ? "permanent" : undefined;
}

export function deactivate(): Promise<void> | undefined {
    return deactivateHook?.();
}
