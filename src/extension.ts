import * as vscode from "vscode";
import { scanRepository, ScanIgnoreState, shouldIgnore, RepoFile, isSourceRootRegex, clearScanCache, invalidateScanFile, setScanPriorityProvider } from "./scanner";
import { isAlwaysExcluded } from "./file_discovery";
import { isSafeWebviewMessage } from "./message_guard";
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
import { ACCENT_SEARCH, ACCENT_INSPECT, ACCENT_RECENCY, withAlpha } from "./colors";
import { clampTargetToGridCapacity, reorderFolderItems, reorderCardItems, reorderSpanningItems, expandSpanningGridOrder, reduceSpanningGridOrder } from "./reorder_helpers";

import * as fs from "fs";
import * as path from "path";

export async function activate(context: vscode.ExtensionContext) {
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

    const updateLayoutFromCacheLocked = async (panel: vscode.WebviewPanel, forceBreakBeforeId?: string) => {
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

                panel.webview.postMessage({
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

                panel.webview.postMessage({
                    command: "data",
                    mode: "uniform_grid",
                    dragReorderMode,
                    renderMediaThumbnails,
                    fullscreenOnOpen: isFullscreenOnOpen(),
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
    let prescanPromise: Promise<void> | undefined = scanRepository(getIgnoreState(), persistIgnoreState).then(files => {
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
        if (vscode.window.tabGroups.all.length > 1) {
            try {
                await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
            } catch { }
        }
    };

    const isThumbviewTab = (tab: vscode.Tab): boolean => {
        const input: any = tab.input;
        if (input instanceof vscode.TabInputWebview) {
            return input.viewType === "thumbview";
        }
        if (input && typeof input.viewType === "string" && input.viewType === "thumbview") {
            return true;
        }
        return tab.label === "Thumbview";
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
                    await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
                } else {
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(doc, {
                            preview: false,
                            viewColumn: tab.group.viewColumn
                        });
                    } catch {
                        await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
                    }
                }
                return true;
            } catch {
                return false;
            }
        }
        return false;
    };

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
    // the layout lock while the layout is still changing.
    const switchLeavingFullscreen = async <T>(show: () => Thenable<T>): Promise<T> => {
        const exiting = thumbviewEnteredZenMode ? (thumbviewEnteredZenMode = false, exitFullscreen()) : Promise.resolve();
        const unmaximizing = groupMaximizedByUs ? unmaximizeIfSplits() : Promise.resolve();
        let shown: Thenable<T>;
        try {
            shown = show();
        } catch (err) {
            shown = Promise.reject(err);
        }
        const [, , result] = await Promise.allSettled([exiting, unmaximizing, shown]);
        if (result.status === "rejected") {
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

            if (thumbviewEnteredZenMode) {
                thumbviewEnteredZenMode = false;
                await exitFullscreen();
                // Settle Delay: Allow VS Code's workbench layout animation to finish restoring
                await new Promise(r => setTimeout(r, 70));
            }
            if (groupMaximizedByUs) {
                await unmaximizeIfSplits();
                await new Promise(r => setTimeout(r, 30));
            }

            // Robust Tab Switcher:
            // 1. Try lastActiveTextEditor if valid and not closed
            let switched = false;
            if (lastActiveTextEditor && !lastActiveTextEditor.document.isClosed) {
                try {
                    await vscode.window.showTextDocument(lastActiveTextEditor.document, {
                        preview: false,
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

            // Settle check & Double-activation:
            // Give VS Code 50ms to finish any pending tab activation.
            await new Promise(r => setTimeout(r, 50));

            // If VS Code's layout engine clobbered the focus and Thumbview is still active,
            // re-trigger the switch to the desired code tab.
            if (activePanel && activePanel.active) {
                if (lastActiveTextEditor && !lastActiveTextEditor.document.isClosed) {
                    try {
                        await vscode.window.showTextDocument(lastActiveTextEditor.document, { preview: false });
                    } catch { }
                } else if (preferred) {
                    await switchToTab(preferred);
                }
                await new Promise(r => setTimeout(r, 50));
            }

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

            // panel.visible updates asynchronously after reveal(), so a coalesced replay right after
            // our own open could misread it as closed; trust our last intent for a moment.
            const recentlyOpened = lastToggleIntent === "open" && Date.now() - lastToggleAt < TOGGLE_INTENT_TRUST_MS;
            if (activePanel && (activePanel.visible || recentlyOpened)) {
                lastToggleIntent = "close";
                lastToggleAt = Date.now();
                await closeActiveThumbview();
                return;
            }
            lastToggleIntent = "open";
            lastToggleAt = Date.now();

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

                    if (isFullscreenOnOpen() && vscode.window.tabGroups.all.length > 1 && !groupMaximizedByUs) {
                        groupMaximizedByUs = true;
                        try {
                            await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
                        } catch { }
                    }

                    // Settle delay for Zen mode window expansion:
                    // Wait for the workbench layout to expand to fullscreen before revealing
                    await new Promise(r => setTimeout(r, 70));

                    updateVisibleRanges(vscode.window.activeTextEditor || lastActiveTextEditor);
                    activePanel.reveal(vscode.ViewColumn.Active);
                    sendOpenState();

                    // Settle delay before revealing opacity: allow webview resize & render to paint at full size
                    await new Promise(r => setTimeout(r, 40));
                    endTransition(activePanel, reopenTransitionId);
                    flushHiddenRefresh(activePanel);
                    maybeShowFullscreenNotice(activePanel);
                } finally {
                    releaseLayoutOp();
                }
                return;
            }

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
            try {
                panel = vscode.window.createWebviewPanel(
                    "thumbview",
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

                const hasPdfs = (cachedScannedFiles || []).some(f => f.isPdf);
                panel.webview.html = getHtml(panel.webview, context, getOpenKeybindingLabel(), hasPdfs);
            } catch (err) {
                console.error("Failed to open Thumbview panel:", err);
                return;
            }

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
                        await prescanPromise;
                    }
                    if (cachedScannedFiles && cachedScannedFiles.length > 0) {
                        updateLayoutFromCache(panel);
                    } else {
                        refreshThumbview(panel);
                    }
                    endTransition(panel);
                    maybeShowFullscreenNotice(panel);
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
                    await withLayoutLock(async () => {
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
                                    : vscode.commands.executeCommand("vscode.open", uri, { preview: false }));
                            } finally {
                                releaseLayoutOp();
                            }
                        } catch (err: any) {
                            console.error("THUMBVIEW SWITCH TAB ERROR:", err);
                            vscode.window.showErrorMessage(`Thumbview could not open ${vscode.Uri.parse(msg.uri).path.split("/").pop()}: ${err?.message ?? String(err)}`);
                        }
                    });
                }

                if (msg.command === "jump") {
                    await withLayoutLock(async () => {
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
                                    await switchLeavingFullscreen(() => vscode.commands.executeCommand("vscode.open", uri, { preview: false }));
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
                            }));

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
                            if (wsFolder) {
                                const newUri = vscode.Uri.joinPath(wsFolder.uri, newName);
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
                            if (input && input !== folderPrefix) {
                                const targetUri = vscode.Uri.joinPath(wsFolder.uri, input);
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
                            if (input && input !== folderPrefix) {
                                const targetUri = vscode.Uri.joinPath(wsFolder.uri, input);
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
                            if (newName && newName !== oldRel) {
                                const newUri = vscode.Uri.joinPath(wsFolder.uri, newName);
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
                if (!e.webviewPanel.visible) {
                    // Sent even mid-transition: the webview's fast reopen path needs to know the
                    // panel really was backgrounded (protocol: "panelHidden", no fields).
                    panel.webview.postMessage({ command: "panelHidden" });
                }
                if (layoutOpsInFlight > 0) {
                    return;
                }
                if (e.webviewPanel.visible && e.webviewPanel.active) {
                    if (fullscreenActive && vscode.window.tabGroups.all.length > 1) {
                        // User dragged the tab into a new split, breaking zen mode layout. Close gracefully.
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


// Builds the webview's HTML shell. media/overview.js is loaded via a nonce'd <script>
// tag under a strict CSP (script-src limited to that nonce) so no inline/remote script
// can run in the panel — see getNonce() below.
// Exported for scripts/capture-screenshots.mjs, which renders this exact page headlessly for the README.
export function getHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    openKeybindingLabel: string = "F4",
    hasPdfs: boolean = false
): string {
    const isMac = process.platform === "darwin";
    const jsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "overview.js")
    );
    const pdfJsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "pdf.min.js")
    );
    const pdfWorkerUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "pdf.worker.min.js")
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Thumbview</title>

    <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src blob: data: ${webview.cspSource}; connect-src ${webview.cspSource} blob: data:;"
    >

    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <style>
        :root {
            --tv-accent-search: ${ACCENT_SEARCH};
            --tv-accent-inspect: ${ACCENT_INSPECT};
            --tv-accent-recency: ${ACCENT_RECENCY};
        }

        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: var(--vscode-editor-background, #18181c);
            color: var(--vscode-foreground, #e1e1e6);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            user-select: none;
        }

        /* Hidden until overview.js reveals a frame rendered at a stable size (inline opacity wins). */
        body {
            opacity: 0;
        }

        /* Visually hidden but read by screen readers. */
        .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
        }

        /* Keyboard focus is always visible on DOM controls; the canvas draws its own ring. */
        button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
            outline: 2px solid var(--vscode-focusBorder, #007fd4);
            outline-offset: 1px;
        }
        canvas:focus-visible {
            outline: none;
        }

        /* High contrast themes: controls get explicit borders; state is not conveyed by fill alone. */
        body.vscode-high-contrast button, body.vscode-high-contrast-light button,
        body.vscode-high-contrast input, body.vscode-high-contrast-light input {
            border: 1px solid var(--vscode-contrastBorder, CanvasText) !important;
        }
        body.vscode-high-contrast button.active, body.vscode-high-contrast-light button.active {
            outline: 2px solid var(--vscode-contrastActiveBorder, Highlight);
        }

        @media (forced-colors: active) {
            button, input, .menu-popover, .menu-modal {
                border: 1px solid ButtonText !important;
                forced-color-adjust: auto;
            }
            button.active {
                outline: 2px solid Highlight;
            }
        }

        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                transition: none !important;
                animation: none !important;
            }
        }

        #canvas-container {
            position: relative;
            width: 100%;
            height: 100%;
        }

        canvas {
            display: block;
            width: 100%;
            height: 100%;
        }

        /* Float controls for search & navigation */
        .controls-overlay {
            position: absolute;
            top: 16px;
            left: 16px;
            right: 16px;
            display: flex;
            justify-content: flex-start;
            align-items: center;
            pointer-events: none;
            gap: 12px;
        }

        .breadcrumb-container {
            display: flex;
            align-items: center;
            background: var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-editor-background, #1e1e22) 90%, #888888 10%));
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 8px;
            padding: 6px 12px;
            font-size: 13px;
            pointer-events: auto;
            box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.15));
            max-width: 60%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .breadcrumb-item {
            cursor: pointer;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            transition: color 0.15s ease;
        }

        .breadcrumb-item:hover {
            color: var(--vscode-foreground, #ffffff);
        }

        .breadcrumb-separator {
            margin: 0 8px;
            color: var(--vscode-descriptionForeground, #505055);
        }

        .search-container {
            background: var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-editor-background, #1e1e22) 90%, #888888 10%));
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 8px;
            padding: 2px;
            pointer-events: auto;
            box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.15));
            display: flex;
            align-items: center;
        }

        .search-input {
            background: transparent;
            border: none;
            outline: none;
            color: var(--vscode-input-foreground, var(--vscode-foreground, #ffffff));
            font-size: 13px;
            padding: 6px 10px;
            width: 180px;
            transition: width 0.2s ease;
        }

        .search-input.regex-error {
            outline: 1px solid var(--vscode-inputValidation-errorBorder, rgba(239, 68, 68, 0.8));
            outline-offset: -1px;
        }

        .search-input:focus {
            width: 240px;
        }

        .search-input::placeholder {
            color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground, #707075));
        }

        .search-option-btn {
            background: transparent;
            border: none;
            outline: none;
            color: var(--vscode-descriptionForeground, #707075);
            cursor: pointer;
            font-size: 14px;
            padding: 0 8px;
        }

        .search-option-btn:hover {
            color: var(--vscode-foreground, #ffffff);
        }
        
        .search-option-btn.active {
            background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 20%, transparent);
            border: 1px solid var(--vscode-focusBorder, #007fd4);
            border-radius: 4px;
            color: var(--vscode-foreground, #ffffff);
        }

        /* Magnifying floating code tooltip */
        #hover-tooltip {
            position: absolute;
            display: none;
            background: var(--vscode-editorHoverWidget-background, rgba(20, 20, 25, 0.98));
            backdrop-filter: blur(12px);
            border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-focusBorder, rgba(168, 85, 247, 0.6)));
            border-radius: 8px;
            padding: 12px;
            box-shadow: 0 12px 36px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.75));
            font-family: Consolas, "Liberation Mono", Courier, monospace;
            font-size: 13px;
            color: var(--vscode-editorHoverWidget-foreground, #d4d4d4);
            pointer-events: none;
            z-index: 1000;
            max-width: 750px;
            line-height: 1.4;
            white-space: pre;
            tab-size: 4;
            -moz-tab-size: 4;
            overflow: hidden;
        }

        .tooltip-filename {
            font-family: system-ui, -apple-system, sans-serif;
            font-weight: 600;
            color: var(--vscode-foreground, #ffffff);
            margin-bottom: 8px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.15));
            padding-bottom: 4px;
            font-size: 12px;
        }

        /* Right-click Context Menu */
        #context-menu {
            position: absolute;
            display: none;
            background: var(--vscode-menu-background, #252526);
            border: 1px solid var(--vscode-menu-border, rgba(255, 255, 255, 0.12));
            border-radius: 5px;
            padding: 4px 0;
            box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.5));
            z-index: 4000;
            min-width: 220px;
            font-size: 12px;
            color: var(--vscode-menu-foreground, #cccccc);
        }

        .menu-item {
            padding: 5px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            font-size: 12px;
            color: var(--vscode-menu-foreground, #cccccc);
            user-select: none;
            transition: background 0.1s ease;
        }

        .menu-item:hover {
            background: var(--vscode-menu-selectionBackground, #04395e);
            color: var(--vscode-menu-selectionForeground, #ffffff);
        }

        .menu-item-label {
            display: flex;
            align-items: center;
            gap: 8px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .menu-item-key {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8a8a93);
            margin-left: auto;
            padding-left: 12px;
            flex-shrink: 0;
            letter-spacing: 0.2px;
        }

        .menu-item:hover .menu-item-key {
            color: var(--vscode-menu-selectionForeground, #ffffff);
            opacity: 0.85;
        }

        .menu-item.danger:hover {
            background: var(--vscode-statusBarItem-errorBackground, #900c3f);
            color: #ffffff;
        }

        .menu-separator {
            height: 1px;
            background: var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.08));
            margin: 4px 0;
        }

        .top-bar-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: auto;
            pointer-events: auto;
        }

        .toolbar-btn {
            background: var(--vscode-editorWidget-background, #222227);
            border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.12)));
            border-radius: 4px;
            color: var(--vscode-foreground, #d0d0d5);
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            box-shadow: 0 2px 6px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.2));
            transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
            position: relative;
        }

        .toolbar-btn:hover {
            background: color-mix(in srgb, var(--vscode-editorWidget-background, #222227) 80%, rgba(255, 255, 255, 0.1));
            border-color: rgba(255, 255, 255, 0.25);
            color: var(--vscode-foreground, #ffffff);
        }

        .toolbar-btn.active {
            background: var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.12));
            border-color: var(--vscode-focusBorder, #007fd4);
            color: var(--vscode-foreground, #ffffff);
        }

        .toolbar-btn-icon {
            display: inline-block;
            vertical-align: middle;
            flex-shrink: 0;
            opacity: 0.9;
        }

        .toolbar-btn:hover .toolbar-btn-icon,
        .toolbar-btn.active .toolbar-btn-icon {
            opacity: 1;
        }

        .badge {
            background: var(--vscode-badge-background, #4d4d4d);
            border-radius: 10px;
            padding: 1px 6px;
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-badge-foreground, #ffffff);
        }

        /* Clean Minimalist Dropdown Popovers */
        .menu-popover {
            position: absolute;
            top: 56px;
            right: 16px;
            width: 380px;
            max-width: 92vw;
            max-height: 75vh;
            background: var(--vscode-editorWidget-background, #222227);
            border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.14)));
            border-radius: 6px;
            box-shadow: 0 10px 30px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.45));
            z-index: 3000;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-size: 12px;
            color: var(--vscode-foreground, #cccccc);
            pointer-events: auto;
        }

        .menu-popover::before, .menu-modal::before {
            content: "";
            display: block;
            height: 2px;
            width: 100%;
            background: var(--vscode-button-background, #0e639c);
            flex-shrink: 0;
        }

        .popover-header {
            flex-shrink: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground, #ffffff);
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            background: var(--vscode-editorWidget-headerBackground, color-mix(in srgb, var(--vscode-editorWidget-background, #222227) 90%, #ffffff 10%));
        }

        .popover-header-title {
            display: flex;
            align-items: center;
            gap: 8px;
            letter-spacing: 0.2px;
        }

        .popover-close {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
            cursor: pointer;
            transition: background 0.1s ease, color 0.1s ease;
        }

        .popover-close:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
            color: var(--vscode-foreground, #ffffff);
        }

        .folders-popover-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr;
            flex: 1 1 0%;
            min-height: 0;
            height: 100%;
            overflow: hidden;
        }

        .popover-column {
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
            height: 100%;
            padding: 10px;
            overflow: hidden;
            box-sizing: border-box;
        }

        .popover-column-left {
            border-right: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
        }

        .popover-column-header {
            flex-shrink: 0;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground, #8a8a93));
            margin-bottom: 8px;
            padding-bottom: 5px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .popover-count-badge {
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground, #8a8a93);
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.08);
            padding: 1px 6px;
            border-radius: 10px;
        }

        .popover-body {
            flex: 1 1 0%;
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 2px 4px 6px 0;
            scrollbar-width: thin;
            scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.25)) transparent;
        }

        .popover-body::-webkit-scrollbar {
            width: 8px;
        }

        .popover-body::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.12);
            border-radius: 4px;
        }

        .popover-body::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.25));
            border-radius: 4px;
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .popover-body::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255, 255, 255, 0.45));
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .popover-body::-webkit-scrollbar-thumb:active {
            background: var(--vscode-scrollbarSlider-activeBackground, rgba(255, 255, 255, 0.65));
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .popover-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 5px 8px;
            border-radius: 4px;
            cursor: pointer;
            transition: background 0.1s ease, border-color 0.1s ease;
            font-size: 12px;
            color: var(--vscode-foreground, #cccccc);
            user-select: none;
            border-left: 2px solid transparent;
        }

        .popover-item:hover {
            background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
            color: var(--vscode-list-hoverForeground, #ffffff);
        }

        .popover-item.active {
            background: var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.1));
            border-left: 2px solid var(--vscode-focusBorder, #007fd4);
            color: var(--vscode-list-activeSelectionForeground, #ffffff);
            font-weight: 500;
        }
        /* The dimmed count color fails contrast on the selection background. */
        .popover-item.active .popover-item-count {
            color: inherit;
        }

        .popover-chevron-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            padding: 0;
            margin: 0 2px 0 0;
            background: transparent;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            color: var(--vscode-foreground, #cccccc);
            flex-shrink: 0;
            transition: background-color 0.15s ease, color 0.15s ease;
        }

        .popover-chevron-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.12));
            color: var(--vscode-foreground, #ffffff);
        }

        .item-icon-label {
            display: flex;
            align-items: center;
            gap: 8px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
            flex: 1;
        }

        .folder-name-text,
        .pattern-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .path-sep {
            opacity: 0.35;
            margin: 0 1px;
        }

        .pattern-type-badge {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 1px 5px;
            border-radius: 3px;
            font-weight: 500;
            margin-left: auto;
            margin-right: 4px;
            flex-shrink: 0;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: var(--vscode-descriptionForeground, #8a8a93);
        }

        .popover-item-count {
            color: var(--vscode-descriptionForeground, #8a8a93);
            font-size: 11px;
            margin-left: auto;
            padding-left: 8px;
            flex-shrink: 0;
        }

        .popover-add-bar {
            flex-shrink: 0;
            display: flex;
            gap: 6px;
            padding-bottom: 8px;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
        }

        .popover-input {
            flex: 1;
            background: var(--vscode-input-background, #1a1a1e);
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.12));
            border-radius: 3px;
            color: var(--vscode-input-foreground, #cccccc);
            padding: 4px 8px;
            font-size: 12px;
            font-family: inherit;
            outline: none;
            transition: border-color 0.1s ease;
        }

        .popover-input:focus {
            border-color: var(--vscode-focusBorder, #007fd4);
        }

        .popover-btn-action {
            background: var(--vscode-button-background, #0e639c);
            border: 1px solid transparent;
            border-radius: 3px;
            color: var(--vscode-button-foreground, #ffffff);
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 4px;
            transition: background 0.12s ease;
        }

        .popover-btn-action:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }

        .remove-pattern-btn {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
            cursor: pointer;
            transition: background 0.1s ease, color 0.1s ease;
        }

        .remove-pattern-btn:hover {
            background: rgba(239, 68, 68, 0.15);
            color: var(--vscode-errorForeground, #f87171);
        }

        .popover-action-btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            padding: 2px 7px;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.12s ease;
            margin-left: 8px;
            flex-shrink: 0;
        }

        .popover-action-btn:hover {
            background: rgba(239, 68, 68, 0.15);
            border-color: rgba(239, 68, 68, 0.4);
            color: var(--vscode-errorForeground, #f87171);
        }

        .popover-empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 28px 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground, #707075);
            font-size: 12px;
        }

        .popover-empty-state .empty-hint {
            font-size: 11px;
            margin-top: 4px;
            opacity: 0.7;
            max-width: 220px;
        }

        /* Clean Minimalist Settings Modal */
        .menu-modal {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            display: none;
            width: 540px;
            max-width: 90vw;
            max-height: 84vh;
            background: var(--vscode-editorWidget-background, #222227);
            border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.14)));
            border-radius: 6px;
            box-shadow: 0 12px 36px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.5));
            z-index: 3000;
            font-size: 13px;
            color: var(--vscode-foreground, #cccccc);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        #actions-modal {
            display: none;
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground, #ffffff);
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            padding: 10px 16px;
            background: var(--vscode-editorWidget-headerBackground, color-mix(in srgb, var(--vscode-editorWidget-background, #222227) 90%, #ffffff 10%));
            flex-shrink: 0;
        }

        .modal-header-title {
            display: flex;
            align-items: center;
            gap: 8px;
            letter-spacing: 0.2px;
        }

        .modal-close {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
            cursor: pointer;
            transition: background 0.1s ease, color 0.1s ease;
        }

        .modal-close:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
            color: var(--vscode-foreground, #ffffff);
        }

        .modal-content-scroll {
            padding: 16px 20px;
            overflow-y: auto;
            max-height: calc(84vh - 48px);
            scrollbar-width: thin;
            scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.25)) transparent;
        }

        .modal-content-scroll::-webkit-scrollbar {
            width: 8px;
        }

        .modal-content-scroll::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.12);
            border-radius: 4px;
        }

        .modal-content-scroll::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.25));
            border-radius: 4px;
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .modal-content-scroll::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255, 255, 255, 0.45));
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .modal-section {
            margin-bottom: 20px;
        }

        .modal-section:last-child {
            margin-bottom: 4px;
        }

        .modal-section-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground, #8a8a93));
            font-weight: 600;
            margin-bottom: 10px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            padding-bottom: 5px;
        }

        .setting-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 9px 0;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.05));
        }

        .setting-row:last-child {
            border-bottom: none;
        }

        .setting-text {
            padding-right: 16px;
            min-width: 0;
        }

        .setting-name {
            font-weight: 500;
            color: var(--vscode-settings-headerForeground, var(--vscode-foreground, #ffffff));
            font-size: 13px;
        }

        .setting-desc {
            font-size: 12px;
            color: var(--vscode-descriptionForeground, #8a8a93);
            margin-top: 2px;
            line-height: 1.4;
        }

        .segmented-control {
            display: inline-flex;
            background: var(--vscode-input-background, #1a1a1e);
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.1));
            border-radius: 4px;
            padding: 2px;
            gap: 2px;
            flex-shrink: 0;
        }

        .seg-btn {
            background: transparent;
            border: none;
            border-radius: 3px;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            padding: 4px 12px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.12s ease;
        }

        .seg-btn:hover {
            color: var(--vscode-foreground, #ffffff);
            background: rgba(255, 255, 255, 0.04);
        }

        .seg-btn.active {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
            font-weight: 500;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
        }

        .action-trigger-btn {
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            border: 1px solid var(--vscode-button-secondaryBorder, rgba(255, 255, 255, 0.1));
            border-radius: 4px;
            color: var(--vscode-button-secondaryForeground, #ffffff);
            padding: 5px 12px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.12s ease, border-color 0.12s ease;
            flex-shrink: 0;
        }

        .action-trigger-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
            border-color: rgba(255, 255, 255, 0.2);
        }

        .setting-input-wrapper {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }

        .setting-dimension-group {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }

        .setting-input {
            background: var(--vscode-input-background, #1a1a1e);
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.12));
            border-radius: 4px;
            color: var(--vscode-input-foreground, #ffffff);
            padding: 4px 8px;
            font-size: 12px;
            font-family: inherit;
            outline: none;
            width: 58px;
            text-align: right;
            transition: border-color 0.12s ease;
            box-sizing: border-box;
            -moz-appearance: textfield;
            appearance: textfield;
        }

        .setting-input::-webkit-outer-spin-button,
        .setting-input::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        .setting-input-dim {
            width: 50px;
            text-align: center;
        }

        .setting-input:focus {
            border-color: var(--vscode-focusBorder, #007fd4);
        }

        .setting-input-unit {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8a8a93);
            min-width: 14px;
        }

        .setting-dim-sep {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8a8a93);
            user-select: none;
        }

        /* Clean Desktop Toggle Control with Accent */
        .fullscreen-notice {
            position: absolute;
            left: 50%;
            bottom: 20px;
            transform: translateX(-50%);
            z-index: 60;
            display: flex;
            align-items: center;
            gap: 10px;
            max-width: calc(100% - 32px);
            box-sizing: border-box;
            padding: 10px 12px 10px 16px;
            border-radius: 6px;
            background: var(--vscode-editorWidget-background, #252526);
            color: var(--vscode-foreground, #cccccc);
            border: 1px solid var(--vscode-widget-border, #454545);
            box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
            font-size: 13px;
        }
        .fullscreen-notice[hidden] {
            display: none;
        }
        .fullscreen-notice kbd {
            font-family: inherit;
            padding: 1px 5px;
            border-radius: 3px;
            background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.17));
            border: 1px solid var(--vscode-keybindingLabel-border, rgba(51, 51, 51, 0.6));
        }
        .notice-btn {
            flex: none;
            padding: 4px 10px;
            border-radius: 2px;
            border: 1px solid var(--vscode-button-secondaryBorder, transparent);
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ffffff);
            font: inherit;
            cursor: pointer;
        }
        .notice-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .notice-btn-primary {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
        }
        .notice-btn-primary:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }
        .notice-btn:focus-visible {
            outline: 1px solid var(--vscode-focusBorder, #007fd4);
            outline-offset: 2px;
        }
        @media (max-width: 560px) {
            .fullscreen-notice {
                flex-wrap: wrap;
            }
        }
        .toggle-control {
            position: relative;
            display: inline-flex;
            align-items: center;
            cursor: pointer;
            user-select: none;
            flex-shrink: 0;
        }

        .toggle-control input {
            opacity: 0;
            width: 0;
            height: 0;
            position: absolute;
        }

        .toggle-track {
            width: 36px;
            height: 18px;
            background: var(--vscode-input-background, #1a1a1e);
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15));
            border-radius: 10px;
            position: relative;
            transition: all 0.15s ease;
            display: block;
        }

        .toggle-thumb {
            position: absolute;
            top: 2px;
            left: 2px;
            width: 12px;
            height: 12px;
            background: var(--vscode-descriptionForeground, #8a8a93);
            border-radius: 50%;
            transition: transform 0.15s ease, background 0.15s ease;
        }

        .toggle-control input:checked + .toggle-track {
            background: var(--vscode-button-background, #0e639c);
            border-color: var(--vscode-button-background, #0e639c);
        }

        .toggle-control input:checked + .toggle-track .toggle-thumb {
            transform: translateX(18px);
            background: #ffffff;
        }

        .shortcuts-table {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .shortcut-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 5px 0;
            font-size: 12px;
        }

        .shortcut-label {
            color: var(--vscode-foreground, #cccccc);
        }

        .shortcut-keys {
            color: var(--vscode-descriptionForeground, #8a8a93);
            font-size: 11px;
        }

        .kbd {
            background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.12));
            border: 1px solid var(--vscode-keybindingLabel-border, rgba(128, 128, 128, 0.25));
            border-bottom: 2px solid var(--vscode-keybindingLabel-bottomBorder, rgba(128, 128, 128, 0.35));
            border-radius: 3px;
            padding: 2px 6px;
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            font-size: 11px;
            font-weight: 500;
            color: var(--vscode-keybindingLabel-foreground, var(--vscode-foreground, #dcdce0));
            box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.1);
            display: inline-block;
        }

        .shortcut-config-box {
            margin-top: 12px;
            padding: 10px 14px;
            background: var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-editor-background, #222227) 85%, #888888 15%));
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
    </style>
</head>
<body>
    <div id="canvas-container" role="main">
        <h1 class="sr-only">Thumbview</h1>
        <canvas id="map" tabindex="0" role="application" aria-roledescription="file grid" aria-label="Thumbview files" aria-describedby="grid-help"></canvas>
        <div id="grid-help" class="sr-only">Arrow keys move between files and folders. Home and End jump to the first and last. Enter opens. Shift+F10 opens the context menu. Hold Control to magnify the focused file. Alt+Arrow moves the focused tile. Type to search.</div>
        <div id="sr-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
        <div id="hover-tooltip"></div>
        <div id="context-menu"></div>
        
        <div id="folders-popover" class="menu-popover" role="dialog" aria-modal="false" aria-labelledby="folders-popover-title" style="display: none; width: 720px; max-width: 94vw; height: 560px; max-height: 82vh;">
            <div class="popover-header">
                <div class="popover-header-title">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" style="opacity:0.9;"><path d="M1.75 3.75C1.75 3.06 2.31 2.5 3 2.5H6.05C6.46 2.5 6.84 2.69 7.09 3.01L7.91 4.09C8.16 4.41 8.54 4.6 8.95 4.6H13C13.69 4.6 14.25 5.16 14.25 5.85V12.4C14.25 13.09 13.69 13.65 13 13.65H3C2.31 13.65 1.75 13.09 1.75 12.4V3.75Z" fill="currentColor" fill-opacity="0.08"/></svg>
                    <span id="folders-popover-title">Folders &amp; Ignored Items</span>
                </div>
                <button class="popover-close" id="close-folders-popover" title="Close (Esc)" aria-label="Close Folders and Ignored Items">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"/></svg>
                </button>
            </div>
            <div class="folders-popover-grid">
                <!-- Left column: Shown Folders -->
                <div class="popover-column popover-column-left">
                    <div class="popover-column-header">
                        <span>Active Directories</span>
                        <span id="shown-folders-count" class="popover-count-badge">0</span>
                    </div>
                    <div class="popover-body" id="folders-list"></div>
                </div>

                <!-- Right column: Ignored Patterns & Folders -->
                <div class="popover-column popover-column-right">
                    <div class="popover-column-header">
                        <span>Ignored Patterns</span>
                        <span id="ignores-count" class="popover-count-badge">0</span>
                    </div>
                    <div class="popover-add-bar">
                        <input type="text" id="add-ignore-input" class="popover-input" placeholder="e.g. src/temp/ or *.log" spellcheck="false">
                        <button id="add-ignore-btn" class="popover-btn-action">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 2.5V13.5M2.5 8H13.5"/></svg>
                            <span>Add</span>
                        </button>
                    </div>
                    <div class="popover-body" id="ignores-list"></div>
                </div>
            </div>
        </div>

        <div id="actions-modal" class="menu-modal" role="dialog" aria-modal="true" aria-labelledby="actions-modal-title">
            <div class="modal-header">
                <div class="modal-header-title">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.9;"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.7 1.3-2-.8-.9-2 1.3-.7-.2zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
                    <span id="actions-modal-title">Settings &amp; Shortcuts</span>
                </div>
                <button class="modal-close" id="close-modal" title="Close (Esc)" aria-label="Close Settings and Shortcuts">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"/></svg>
                </button>
            </div>
            <div class="modal-content-scroll">
                <div class="modal-section">
                    <div class="modal-section-title">Layout &amp; Grid</div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Layout Mode</div>
                            <div class="setting-desc">Spanning grid scales tall files across multiple vertical slots</div>
                        </div>
                        <div class="segmented-control">
                            <button id="layout-spanning-btn" class="seg-btn">Spanning</button>
                            <button id="layout-uniform-btn" class="seg-btn">Uniform</button>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Drag-to-Reorder Mode</div>
                            <div class="setting-desc">Choose between swapping positions or reflowing adjacent tiles</div>
                        </div>
                        <div class="segmented-control">
                            <button id="drag-swap-btn" class="seg-btn">Swap</button>
                            <button id="drag-shift-btn" class="seg-btn">Shift</button>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name" id="media-thumbnails-setting-name">Media Thumbnails</div>
                            <div class="setting-desc">Render image and PDF page 1 previews directly inside thumbnail tiles</div>
                        </div>
                        <label class="toggle-control">
                            <input type="checkbox" id="media-thumbnails-toggle" aria-labelledby="media-thumbnails-setting-name" checked>
                            <span class="toggle-track">
                                <span class="toggle-thumb"></span>
                            </span>
                        </label>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name" id="fullscreen-setting-name">Open Fullscreen</div>
                            <div class="setting-desc">Open Thumbview in Zen mode so code stays readable. Turn off to open it as a normal editor tab.</div>
                        </div>
                        <label class="toggle-control">
                            <input type="checkbox" id="fullscreen-toggle" aria-labelledby="fullscreen-setting-name" checked>
                            <span class="toggle-track">
                                <span class="toggle-thumb"></span>
                            </span>
                        </label>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name" id="compression-setting-name">Compression Percentage</div>
                            <div class="setting-desc">When code shrinks to this percentage of its height in a cell, the tile expands one cell taller (0% disables, 1% to 20% recommended)</div>
                        </div>
                        <div class="setting-input-wrapper">
                            <input type="number" id="compression-percentage-input" aria-labelledby="compression-setting-name" class="setting-input" min="0" max="25" step="1" value="5">
                            <span class="setting-input-unit">%</span>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Tile Size Before Collapse</div>
                            <div class="setting-desc">Minimum tile width and height in pixels before grouping files into folder cards</div>
                        </div>
                        <div class="setting-dimension-group">
                            <input type="number" id="min-cell-width-input" class="setting-input setting-input-dim" min="10" max="500" step="5" value="60" title="Minimum width (px)" aria-label="Minimum tile width in pixels">
                            <span class="setting-dim-sep">×</span>
                            <input type="number" id="min-cell-height-input" class="setting-input setting-input-dim" min="10" max="500" step="5" value="40" title="Minimum height (px)" aria-label="Minimum tile height in pixels">
                            <span class="setting-input-unit">px</span>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name" id="auto-ignore-setting-name">Auto-Ignore Threshold</div>
                            <div class="setting-desc">Automatically ignore folders containing more than this number of files (0 disables)</div>
                        </div>
                        <div class="setting-input-wrapper">
                            <input type="number" id="auto-ignore-threshold-input" aria-labelledby="auto-ignore-setting-name" class="setting-input" min="0" max="10000" step="5" value="30">
                            <span class="setting-input-unit">files</span>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Reflow Layout</div>
                            <div class="setting-desc">Reset grid slot arrangement back to repository directory order</div>
                        </div>
                        <button id="reflow-layout-btn" class="action-trigger-btn">Reflow Grid</button>
                    </div>
                </div>

                <div class="modal-section">
                    <div class="modal-section-title">Keyboard &amp; Mouse Shortcuts</div>
                    <div class="shortcuts-table">
                        <div class="shortcut-row">
                            <span class="shortcut-label">Open / Focus Thumbview</span>
                            <span class="shortcut-keys"><span class="kbd" id="open-shortcut-label">${openKeybindingLabel}</span></span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Code Magnifier Preview</span>
                            <span class="shortcut-keys"><span class="kbd">${isMac ? "Cmd / Ctrl" : "Ctrl"}</span> + Hover</span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Jump to Line in Editor</span>
                            <span class="shortcut-keys"><span class="kbd">Left Click</span> Tile Line</span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Close Document / Tab</span>
                            <span class="shortcut-keys"><span class="kbd">Middle Click</span> or <span class="kbd">×</span></span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Isolate Folder</span>
                            <span class="shortcut-keys"><span class="kbd">Left Click</span> Folder Header / Item</span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Context Menu</span>
                            <span class="shortcut-keys"><span class="kbd">${isMac ? "Right Click / ⌃Click" : "Right Click"}</span> Tile</span>
                        </div>
                    </div>
                    <div class="shortcut-config-box">
                        <div class="setting-text">
                            <div class="setting-name">Global Shortcut Hotkey</div>
                            <div class="setting-desc">Current keybinding: <span class="kbd" id="open-shortcut-label-2">${openKeybindingLabel}</span></div>
                        </div>
                        <button id="change-hotkey-btn" class="action-trigger-btn">Configure Keybinding</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="controls-overlay">
            <div class="search-container" role="search">
                <input type="text" id="search-input" class="search-input" title="Begin typing with the Thumbview open to Search" aria-label="Search files" placeholder="Search files (e.g. auth)...">
                <button id="search-match-case" class="search-option-btn" aria-label="Match Case" aria-pressed="false" title="Match Case (${isMac ? "⌥C" : "Alt+C"})">Aa</button>
                <button id="search-match-word" class="search-option-btn" aria-label="Match Whole Word" aria-pressed="false" title="Match Whole Word (${isMac ? "⌥W" : "Alt+W"})">[ab]</button>
                <button id="search-use-regex" class="search-option-btn" aria-label="Use Regular Expression" aria-pressed="false" title="Use Regular Expression (${isMac ? "⌥X" : "Alt+X"})">.*</button>
                <button id="clear-search" class="search-option-btn" aria-label="Clear search" title="Clear Search (${isMac ? "⌘⌫" : "Ctrl+Backspace"})" style="display: none;">&times;</button>
            </div>
            <div id="breadcrumbs" class="breadcrumb-container" style="display: none;">
                <span class="breadcrumb-item" id="breadcrumb-root">root</span>
            </div>
            <div class="top-bar-actions">
                <button id="folders-btn" class="toolbar-btn" title="Folders &amp; Ignored" aria-haspopup="dialog" aria-expanded="false" aria-controls="folders-popover">
                    <svg class="toolbar-btn-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.75 3.75C1.75 3.06 2.31 2.5 3 2.5H6.05C6.46 2.5 6.84 2.69 7.09 3.01L7.91 4.09C8.16 4.41 8.54 4.6 8.95 4.6H13C13.69 4.6 14.25 5.16 14.25 5.85V12.4C14.25 13.09 13.69 13.65 13 13.65H3C2.31 13.65 1.75 13.09 1.75 12.4V3.75Z" fill="currentColor" fill-opacity="0.1"/></svg>
                    <span>Folders &amp; Ignored</span>
                </button>
                <button id="actions-btn" class="toolbar-btn" title="Settings &amp; Shortcuts" aria-haspopup="dialog" aria-expanded="false" aria-controls="actions-modal">
                    <svg class="toolbar-btn-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.7 1.3-2-.8-.9-2 1.3-.7-.2zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
                    <span>Settings</span>
                </button>
            </div>
        </div>
        <div id="fullscreen-notice" class="fullscreen-notice" role="region" aria-labelledby="fullscreen-notice-text" hidden>
            <span id="fullscreen-notice-text">Thumbview opens fullscreen so code stays readable. Press <kbd id="fullscreen-notice-key">F4</kbd> or open a file to go back.</span>
            <button id="fullscreen-notice-keep" class="notice-btn notice-btn-primary">Got it</button>
            <button id="fullscreen-notice-tab" class="notice-btn">Open as a tab instead</button>
        </div>
    </div>
    <script nonce="${nonce}">
        window.PDF_WORKER_URI = "${pdfWorkerUri}";
        window.PDF_JS_URI = "${pdfJsUri}";
    </script>
    ${hasPdfs ? `<script nonce="${nonce}" src="${pdfJsUri}"></script>` : ""}
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let text = "";

    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return text;
}