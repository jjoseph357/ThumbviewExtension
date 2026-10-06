import * as vscode from "vscode";
import { scanRepository, ScanIgnoreState, shouldIgnore, RepoFile, isSourceRootRegex, clearScanCache, invalidateScanFile, setScanPriorityProvider, rescanFile, getLastListedPaths, isListedPath, containsListedPath } from "./scanner";
import { isAlwaysExcluded, listableAmong } from "./file_discovery";
import { chunkBySize, inlineWithinBudget, lineTextSize } from "./payload_stream";
import { ChangeGenerations, emptyPendingChanges, isListingRuleFile, planDiskChanges, type PendingDiskChanges } from "./disk_changes";
import { isSafeWebviewMessage, sanitizeOrderIds, sanitizeRowCount } from "./message_guard";
import { askDeleteMode, createFileActions } from "./file_actions";
import { createSettingsActions, AUTO_HIDDEN_DISMISSED_KEY, AUTO_IGNORED_FOLDERS_KEY, FULLSCREEN_NOTICE_KEY, SHORTCUT_LEGEND_DISMISSED_KEY, STATUS_MESSAGE_MS } from "./settings_actions";
import { isThumbviewViewType, THUMBVIEW_VIEW_TYPE } from "./webview_tabs";
import { PanelSession } from "./panel_session";
import { decideF4, EditorGroupTracker, type EditorInfo, type GroupInfo, type OpenResult, type TabInfo } from "./editor_groups";
import { buildStableGrid, slotToIndex, findSlotIndex, MIN_GRID_COLS, MIN_GRID_ROWS } from "./layout";
import { buildSpanningGrid, cellsNeeded, SpanningPlacement, DEFAULT_BASE_LINES_PER_CELL, DEFAULT_COMPRESSION_PCT } from "./spanning_layout";
import { PersistentFileOrder, fillLayoutHoles } from "./state";
import { createReentrantLock, createCoalescedToggle } from "./locks";
import { applyZenOverrides, ConfigLike, ZEN_BACKUP_KEY, ZEN_ENTERED_KEY, ZEN_OWNER_HEARTBEAT_MS, ZEN_OWNER_STALE_MS, claimZenOwnership, hasOtherLiveOwners, releaseZenOwnership } from "./zen_settings";

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
import { createStudy } from "./study/study";
import { HostVisitTracker } from "./study/study_events";
import { readParticipantFile } from "./study/participant_file";

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
        autoIgnoreExclusions: context.workspaceState.get<string[]>("thumbview.autoIgnoreExclusions") ?? [],
        autoIgnoredFolders: context.workspaceState.get<string[]>(AUTO_IGNORED_FOLDERS_KEY) ?? []
    });
    const persistIgnoreState = async (state: ScanIgnoreState): Promise<void> => {
        await context.workspaceState.update("thumbview.ignorePatterns", state.ignorePatterns);
        await context.workspaceState.update("thumbview.autoIgnoreExclusions", state.autoIgnoreExclusions);
        if ((state.autoIgnored && state.autoIgnored.length > 0) || (state.autoUnhidden && state.autoUnhidden.length > 0)) {
            const unhidden = new Set(state.autoUnhidden ?? []);
            const known = (context.workspaceState.get<string[]>(AUTO_IGNORED_FOLDERS_KEY) ?? []).filter(folder => !unhidden.has(folder));
            await context.workspaceState.update(AUTO_IGNORED_FOLDERS_KEY, Array.from(new Set([...known, ...(state.autoIgnored ?? [])])));
        }
    };
    // Auto-ignored folders still ignored now (unignoring one removes it from the chip's count).
    // Recorded only from 0.5.2 on; earlier auto-ignores cannot be told apart from the user's own.
    const autoHiddenFolders = (ignorePatterns: string[]): string[] => {
        const current = new Set(ignorePatterns);
        return (context.workspaceState.get<string[]>(AUTO_IGNORED_FOLDERS_KEY) ?? []).filter(folder => current.has(folder));
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

    // Versions before 0.5.1 copied every root .gitignore line into ignorePatterns at activation. git
    // ls-files (and the non-git fallback in file_discovery.ts) already apply .gitignore, so the copies
    // only cluttered Folders & Ignored and hid tracked files. Remove them once; nothing shown moves.
    const GITIGNORE_COPIES_REMOVED_KEY = "thumbview.gitignoreCopiesRemoved";
    if (workspaceFolders && workspaceFolders.length > 0 && !context.workspaceState.get<boolean>(GITIGNORE_COPIES_REMOVED_KEY)) {
        const gitignorePath = path.join(workspaceFolders[0].uri.fsPath, ".gitignore");
        const copiedRules = new Set<string>();
        try {
            fs.readFileSync(gitignorePath, "utf-8")
                .split("\n")
                .map(line => line.trim())
                .filter(line => line && !line.startsWith("#"))
                .forEach(rule => {
                    copiedRules.add(rule);
                    copiedRules.add(rule.replace(/^\/+|\/+$/g, ""));
                });
        } catch {
        }
        const { ignorePatterns, autoIgnoreExclusions } = getIgnoreState();
        const kept = ignorePatterns.filter(pattern => !copiedRules.has(pattern));
        if (kept.length !== ignorePatterns.length) {
            await persistIgnoreState({ ignorePatterns: kept, autoIgnoreExclusions });
        }
        await context.workspaceState.update(GITIGNORE_COPIES_REMOVED_KEY, true);
    }

    const fileOrder = new PersistentFileOrder();
    setScanPriorityProvider(() => fileOrder.getOrder().filter(Boolean));
    const savedOrder = context.workspaceState.get<string[]>("thumbview.seenFiles");
    if (savedOrder) {
        fileOrder.restore(savedOrder);
    }

    const cursorLocations: { [uri: string]: number } = {};
    let lastSpanningPlacements: SpanningPlacement[] = [];

    let lastActiveTextEditor: vscode.TextEditor | undefined;
    let activePanel: vscode.WebviewPanel | undefined;
    // Opt-in usage study (src/study, STUDY.md); every method is a no-op unless the user joined.
    const study = createStudy(context, { isThumbviewVisible: () => !!activePanel?.visible, log });
    // Webview messages recorded by name only, as study "action" events (never their arguments).
    const STUDY_ACTIONS = new Set([
        "reorderFile", "reorderFolder", "swapCardItems", "reflow", "expandSpace", "reduceSpace",
        "addIgnorePattern", "removeIgnorePattern", "ignoreFile", "ignoreFolder", "setLayoutMode", "setDragReorderMode",
        "openPreview", "openToSide", "revealInFiles", "renameFile", "deleteFile", "copyPath", "copyRelativePath",
        "newFile", "newFolder", "renameFolder", "deleteFolder", "moveFileToFolder", "moveFolderToFolder",
        "compareWithSelected", "openInTerminal", "openFolderInTerminal", "runTests", "debugTests", "close"
    ]);
    let studyPanelVisible = false;
    let studyHiddenAt = -Infinity;
    let studyVisitEndTimer: NodeJS.Timeout | undefined;
    // The visit announced to the webview; onDidDispose reports one the closed tab took with it.
    const hostVisit = new HostVisitTracker();
    // The webview's last drop the host has processed (reorderFile reorderSeq), echoed in payloads.
    let lastReorderSeq = 0;
    // When F4 or the Open command was last invoked, and the request behind the current visit (null
    // for a tab click): the start of the episode's reveal_latency_ms (study.ts).
    let lastOpenRequestedAt: number | null = null;
    let studyVisitRequestedAt: number | null = null;
    // How the last open was requested: the F4 keybinding passes { source: "keybinding" } (package.json).
    let lastOpenSource: "f4" | "command" = "command";
    // A hide shorter than this (Zen/maximize steps flipping visibility) continues the same visit.
    const STUDY_FLICKER_MS = 500;
    const studyShown = (panel: vscode.WebviewPanel, trigger: "f4" | "command" | "tab", coldStart: boolean) => {
        if (study.recordShown(trigger, coldStart, cachedScannedFiles ? cachedScannedFiles.length : null)) {
            hostVisit.started(Date.now());
            studyVisitRequestedAt = trigger === "tab" ? null : lastOpenRequestedAt;
            // Starts the visit clock in the webview even when no reveal gate runs (tab click).
            // Protocol: "studyVisitStart", no fields (overview.js beginStudyEpisode).
            panel.webview.postMessage({ command: "studyVisitStart" });
        }
    };

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
        if (doc.uri.scheme !== "file" || doc.isClosed || doc.lineCount === 0 || !cachedScannedFiles) {
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
    // Documents edited since the cache last took them in (onDidChangeTextDocument, debounced; queued
    // without work while Thumbview is hidden). Applied before every payload is built.
    const pendingChangedDocs = new Map<string, vscode.TextDocument>();
    // Documents edited since their last save, so a close without saving re-reads the file from disk.
    const docsWithUnsavedText = new Set<string>();
    const applyPendingDocChanges = () => {
        if (pendingChangedDocs.size === 0) {
            return;
        }
        for (const doc of pendingChangedDocs.values()) {
            updateDocumentInCache(doc);
        }
        pendingChangedDocs.clear();
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
    //
    // Text beyond FIRST_PAYLOAD_LINE_BUDGET (payload_stream.ts) is not inlined: those files go out as
    // `linesPending: true` and their text follows in "fileLines" chunks once the payload is delivered
    // (streamPendingLines), so a 10k-file first open paints its full layout without waiting for
    // ~70 MB of text. Every payload starts a new stream generation, which stops an older stream;
    // files it had not sent yet are simply pending again in the newer payload.
    type StreamedLines = { id: string; contentVersion: number; lines: string[]; fullLines?: string[] };
    let lineStreamGeneration = 0;
    let queuedLineStream: { generation: number; files: StreamedLines[] } | null = null;
    const withDeltaLines = <T extends { id: string; contentVersion: number; lines: { text: string }[]; fullLines?: string[] }>(files: T[]) => {
        const generation = ++lineStreamGeneration;
        const needed = files.filter(file => postedContentVersions.get(file.id) !== file.contentVersion);
        const texts = new Map(needed.map(file => [file.id, file.lines.map(line => line.text)]));
        const inline = inlineWithinBudget(needed.map(file => lineTextSize({ lines: texts.get(file.id)!, fullLines: file.fullLines })));
        const inlineIds = new Set(needed.filter((_, i) => inline[i]).map(file => file.id));
        const streamed: StreamedLines[] = [];
        const result = files.map(file => {
            const lines = texts.get(file.id);
            if (!lines) {
                const { lines: _lines, fullLines: _fullLines, ...rest } = file;
                return { ...rest, lines: [] as string[], linesOmitted: true };
            }
            if (inlineIds.has(file.id)) {
                postedContentVersions.set(file.id, file.contentVersion);
                return { ...file, lines };
            }
            streamed.push({ id: file.id, contentVersion: file.contentVersion, lines, fullLines: file.fullLines });
            const { lines: _lines, fullLines: _fullLines, ...rest } = file;
            return { ...rest, lines: [] as string[], linesPending: true };
        });
        queuedLineStream = streamed.length > 0 ? { generation, files: streamed } : null;
        return result;
    };
    // Fields: { files: { id, contentVersion, lines: string[], fullLines? }[] } (overview.js "fileLines").
    const streamPendingLines = async (panel: vscode.WebviewPanel, stream: { generation: number; files: StreamedLines[] }) => {
        const startedAt = performance.now();
        const chunks = chunkBySize(stream.files, lineTextSize);
        for (const chunk of chunks) {
            if (stream.generation !== lineStreamGeneration) {
                return;
            }
            let delivered = false;
            try {
                delivered = await panel.webview.postMessage({ command: "fileLines", files: chunk });
            } catch {
            }
            // A reload ("ready") during the await cleared postedContentVersions for a new page that
            // never got this chunk; recording it there would make the next payload omit its text.
            if (!delivered || stream.generation !== lineStreamGeneration) {
                return;
            }
            for (const file of chunk) {
                postedContentVersions.set(file.id, file.contentVersion);
            }
        }
        log.info(`Streamed text of ${stream.files.length} files in ${chunks.length} chunks after the payload, ${Math.round(performance.now() - startedAt)} ms.`);
    };

    // Every payload (one per typing pause) used to rewrite 10k-entry orders to workspaceState. Compare
    // against the stored value first; it is in memory, so the comparison is far cheaper than a write.
    // No private cache: reflow and drag handlers write these keys directly.
    const sameShallow = (a: unknown, b: unknown): boolean => {
        if (a === b) {
            return true;
        }
        if (Array.isArray(a) && Array.isArray(b)) {
            return a.length === b.length && a.every((v, i) => v === b[i]);
        }
        if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
            const ka = Object.keys(a);
            return ka.length === Object.keys(b).length && ka.every(k => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
        }
        return false;
    };
    const persistIfChanged = async (key: string, value: unknown): Promise<void> => {
        if (!sameShallow(context.workspaceState.get(key), value)) {
            await context.workspaceState.update(key, value);
        }
    };

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
        const stream = queuedLineStream;
        queuedLineStream = null;
        panel.webview.postMessage(message).then(() => {
            if (stream) {
                streamPendingLines(panel, stream).catch(() => { });
            }
            const line = `Data payload ${count} (${message.files.length} files${stream ? `, text of ${stream.files.length} streamed after` : ""}): built in ${Math.round(builtAt - layoutStartedAt)} ms, delivered in ${Math.round(performance.now() - builtAt)} ms`;
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
        // Edits made while Thumbview was hidden or closed were only queued (onDidChangeTextDocument).
        applyPendingDocChanges();

        try {
            const { ignorePatterns } = getIgnoreState();
            const activeFiles = cachedScannedFiles.filter(file => !shouldIgnore(file.path, ignorePatterns));

            const listedPaths = getLastListedPaths();
            const allPaths = listedPaths.length > 0 ? listedPaths : cachedScannedFiles.map(f => f.path);
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
            await persistIfChanged("thumbview.seenFiles", fileOrder.getOrder());

            const order = fileOrder.getOrder();
            const dragReorderMode = getDragReorderMode();
            const config = vscode.workspace.getConfiguration("thumbview");
            const renderMediaThumbnails = config.get<boolean>("renderMediaThumbnails") ?? true;
            const minCellWidth = config.get<number>("minCellWidth") ?? 40;
            const minCellHeight = config.get<number>("minCellHeight") ?? 28;
            const autoIgnoreThreshold = config.get<number>("autoIgnoreThreshold") ?? 30;
            const compressionPercentage = config.get<number>("compressionPercentage") ?? 5;
            const compressionPct = getCompressionPct();
            const openKeybinding = getOpenKeybindingLabel();
            // Git markers come from the cache; saves, commits, and reveals refresh it (requestGitRefresh).
            const gitDiff = getCachedGitDiff();

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

                await persistIfChanged("thumbview.spanningAllocations", layout.allocations);
                await persistIfChanged("thumbview.spanningRows", layout.wrapRows);

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
                    // The webview reports one "studyEpisode" per visit only while this is true.
                    studyActive: study.isActive(),
                    // In-grid legend of the non-obvious keys, until dismissed ("dismissShortcutLegend").
                    showShortcutLegend: !context.globalState.get<boolean>(SHORTCUT_LEGEND_DISMISSED_KEY),
                    reorderSeq: lastReorderSeq,
                    // In-grid chip "N folders auto-hidden" (overview.js updateAutoHiddenChip) until dismissed
                    // for this exact set ("dismissAutoHiddenChip" { signature }).
                    autoHiddenFolders: autoHiddenFolders(ignorePatterns),
                    autoHiddenDismissed: context.workspaceState.get<string>(AUTO_HIDDEN_DISMISSED_KEY) ?? "",
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
                        flowRows: layout.flowRows + extraRows,
                        // Without Expand Grid Space's extras: the only size the folder-card decision uses
                        // (overview.js rootCellsTooSmall), so expanding or reducing can never flip it.
                        baseFlowCols: layout.flowCols,
                        baseFlowRows: layout.flowRows
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
                    // The webview reports one "studyEpisode" per visit only while this is true.
                    studyActive: study.isActive(),
                    // In-grid legend of the non-obvious keys, until dismissed ("dismissShortcutLegend").
                    showShortcutLegend: !context.globalState.get<boolean>(SHORTCUT_LEGEND_DISMISSED_KEY),
                    reorderSeq: lastReorderSeq,
                    // In-grid chip "N folders auto-hidden" (overview.js updateAutoHiddenChip) until dismissed
                    // for this exact set ("dismissAutoHiddenChip" { signature }).
                    autoHiddenFolders: autoHiddenFolders(ignorePatterns),
                    autoHiddenDismissed: context.workspaceState.get<string>(AUTO_HIDDEN_DISMISSED_KEY) ?? "",
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
                        slots: layout.slots,
                        // Without extras, for the folder-card decision (see the spanning branch).
                        baseFlowCols: layout.cols,
                        baseFlowRows: layout.rows
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
    // The listing also counts: a file added to an ignored folder changes the Folders & Ignored counts.
    let lastListedCount = -1;
    const sameScan = (a: RepoFile[] | null, b: RepoFile[]) =>
        !!a && a.length === b.length && a.every((file, i) => file === b[i]) && lastListedCount === getLastListedPaths().length;

    // Files changed on disk, by generation. A full scan can read a file before it changes and then
    // install that older text over the newer incremental re-read; installScan re-reads those files.
    const diskChanges = new ChangeGenerations<vscode.Uri>();
    let installedScanGeneration = -1;
    let reReadAfterScan: (uris: vscode.Uri[]) => void = () => { };
    /**
     * Installs a finished full scan as the cache. A scan that started before the last installed one
     * is dropped (its reads are older). Returns "same" when nothing visible changed.
     */
    // Full scans are single-flight: a request during a scan queues exactly one more, which starts after
    // it and so sees every event that led to the request. Without this, two overlapping scans could
    // finish out of order and the older listing (e.g. one still holding a deleted file) would win.
    type ScanResult = { files: RepoFile[]; startedAt: number };
    let scanInFlight: Promise<ScanResult> | undefined;
    let scanQueued: Promise<ScanResult> | undefined;
    const fullScan = (): Promise<ScanResult> => {
        if (!scanInFlight) {
            const startedAt = diskChanges.current();
            scanInFlight = scanRepository(getIgnoreState(), persistIgnoreState)
                .then(files => ({ files, startedAt }))
                .finally(() => {
                    scanInFlight = undefined;
                });
            return scanInFlight;
        }
        if (!scanQueued) {
            scanQueued = scanInFlight.catch(() => undefined).then(() => {
                scanQueued = undefined;
                return fullScan();
            });
        }
        return scanQueued;
    };

    const installScan = (files: RepoFile[], startedAt: number, onlyIfChanged: boolean): "stale" | "same" | "installed" => {
        if (startedAt < installedScanGeneration) {
            return "stale";
        }
        installedScanGeneration = startedAt;
        const late = diskChanges.changedSince(startedAt);
        diskChanges.forgetThrough(startedAt);
        if (late.length > 0) {
            reReadAfterScan(late);
        }
        if (onlyIfChanged && sameScan(lastRawScan, files)) {
            return "same";
        }
        lastRawScan = files;
        lastListedCount = getLastListedPaths().length;
        cachedScannedFiles = files;
        // The scan reads disk; re-apply unsaved buffers so their tiles keep showing the edits.
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.isDirty) {
                updateDocumentInCache(doc);
            }
        }
        return "installed";
    };

    const refreshThumbview = async (panel: vscode.WebviewPanel, onlyIfChanged = false) => {
        try {
            if (!onlyIfChanged) {
                panel.webview.postMessage({
                    command: "status",
                    text: "Refreshing Thumbview...",
                    clearData: false
                });
            }

            const { files, startedAt } = await fullScan();
            if (installScan(files, startedAt, onlyIfChanged) !== "installed" && onlyIfChanged) {
                return;
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

    // With no panel, the startup pre-scan's cache must still follow creates and deletes, or the first
    // F4 would show a stale file set. Coalesced: events during a scan queue one more.
    let backgroundRescan: Promise<void> | undefined;
    let backgroundRescanAgain = false;
    const rescanInBackground = () => {
        if (backgroundRescan) {
            backgroundRescanAgain = true;
            return;
        }
        backgroundRescan = fullScan().then(({ files, startedAt }) => {
            if (installScan(files, startedAt, true) === "installed" && activePanel) {
                refreshOrDefer("layout");
            }
        }).catch(() => {}).finally(() => {
            backgroundRescan = undefined;
            if (backgroundRescanAgain) {
                backgroundRescanAgain = false;
                rescanInBackground();
            }
        });
    };

    const refreshOrDefer = (kind: "layout" | "rescan") => {
        if (!activePanel) {
            if (kind === "rescan" && cachedScannedFiles) {
                rescanInBackground();
            }
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

    // Git markers refresh after saves, disk changes, and commits (.git/index, .git/HEAD), and only while
    // Thumbview is visible: a hidden panel just marks them stale and the next reveal fetches once.
    // Each fetch runs `git status -uall` and `git diff HEAD` over the whole repository.
    // Stale until the first fetch: without the startup pre-scan, the first open fetches after its first paint.
    let gitStale = true;
    const requestGitRefresh = (): Promise<unknown> => {
        if (activePanel?.visible) {
            gitStale = false;
            return fetchWorkspaceGitDiff().catch(() => {});
        }
        gitStale = true;
        return Promise.resolve();
    };

    // Runs after the reveal has painted, so the instant reveal shows the retained frame first and
    // the (full-payload) catch-up update lands afterwards instead of stalling the reveal.
    const HIDDEN_REFRESH_FLUSH_DELAY_MS = 250;
    const flushHiddenRefresh = (panel: vscode.WebviewPanel) => {
        if (!hiddenRefreshPending && !gitStale) {
            return;
        }
        setTimeout(() => detachFromLocks(async () => {
            if (!panel.visible) {
                return;
            }
            const kind = hiddenRefreshPending ?? "layout";
            hiddenRefreshPending = null;
            if (gitStale) {
                await requestGitRefresh();
            }
            if (kind === "rescan") {
                refreshThumbview(panel, true);
            } else {
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
    // F4 pressed while the user was already in Zen mode (package.json passes { inZen: true } under
    // the inZenMode context key). Thumbview then neither toggles Zen nor changes Zen settings, so the
    // user's Zen mode stays on when Thumbview closes.
    let userZenOnOpen = false;
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
        // First: restoring the user's settings matters more than the study's last upload.
        await releaseZenOwnership(zenConfig, context.globalState, zenSessionId, Date.now());
        await study.shutdown();
    };

    // Background pre-scan and git diff fetch so opening Thumbview is instant. The extension activates
    // at startup (onStartupFinished, which also lets Zen crash recovery run before any F4), but the
    // scan waits PRESCAN_DELAY_MS so it never competes with the window, language servers, and other
    // extensions while they load. F4 before then starts it at once (startPrescan is idempotent), and
    // "ready" awaits the same promise instead of starting a second full scan.
    const PRESCAN_DELAY_MS = 3000;
    const GIT_FIRST_PAINT_WAIT_MS = 100;
    const HAS_OPENED_KEY = "thumbview.hasOpened";
    const EVER_OPENED_KEY = "thumbview.everOpened";

    // First-run hint: nothing else tells a new install that F4 opens Thumbview. Once per install, a
    // few seconds after startup, with a folder open, and only for someone who never used Thumbview
    // (state that earlier versions left behind counts as use, so upgrading users are not told).
    const F4_HINT_KEY = "thumbview.f4HintShown";
    const F4_HINT_DELAY_MS = 5000;
    const usedThumbviewBefore = () => [EVER_OPENED_KEY, F4_HINT_KEY, FULLSCREEN_NOTICE_KEY, SHORTCUT_LEGEND_DISMISSED_KEY, ZEN_BACKUP_KEY]
        .some(key => context.globalState.get(key) !== undefined) || !!context.workspaceState.get(HAS_OPENED_KEY);
    if (!usedThumbviewBefore() && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
        const hintTimer = setTimeout(async () => {
            if (usedThumbviewBefore() || activePanel) {
                return;
            }
            await context.globalState.update(F4_HINT_KEY, true);
            const key = getOpenKeybindingLabel();
            const choice = await vscode.window.showInformationMessage(
                `Thumbview: press ${key} to see every file in this workspace on one screen, and ${key} again to go back.`,
                "Open Thumbview",
                "Show Me Around"
            );
            if (choice === "Open Thumbview") {
                void vscode.commands.executeCommand("thumbview.open");
            } else if (choice === "Show Me Around") {
                void vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#gettingStarted`, false);
            }
        }, F4_HINT_DELAY_MS);
        context.subscriptions.push({ dispose: () => clearTimeout(hintTimer) });
    }
    let prescanPromise: Promise<void> | undefined;
    const startPrescan = (): Promise<void> | undefined => {
        if (cachedScannedFiles || prescanPromise) {
            return prescanPromise;
        }
        const prescanStartedAt = performance.now();
        prescanPromise = fullScan().then(({ files, startedAt }) => {
            log.info(`Initial workspace scan: ${files.length} files in ${Math.round(performance.now() - prescanStartedAt)} ms.`);
            if (!cachedScannedFiles) {
                installScan(files, startedAt, false);
            }
        }).catch(() => {}).finally(() => {
            prescanPromise = undefined;
        });
        gitStale = false;
        fetchWorkspaceGitDiff().catch(() => {});
        return prescanPromise;
    };
    // Only where Thumbview has been opened before: a window whose user never opens it must not pay
    // for a scan, hold the file cache, or see auto-ignore messages. The first open elsewhere scans on demand.
    const prescanTimer = setTimeout(() => {
        if (context.workspaceState.get<boolean>(HAS_OPENED_KEY)) {
            startPrescan();
        }
    }, PRESCAN_DELAY_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(prescanTimer) });

    const enterFullscreen = async (): Promise<void> => {
        if (fullscreenActive || !isFullscreenOnOpen() || userZenOnOpen) {
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
        if (!groupMaximizedByUs) {
            // Thumbview changed nothing (tab mode, or no splits when it opened): split widths are
            // the user's and are never touched.
            return;
        }
        groupMaximizedByUs = false;
        try {
            await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
        } catch { }
        // After undoing our own maximize, split editors are left at equal widths (the owner's
        // decision): VS Code's unmaximize does not restore sizes reliably, and keeping the
        // user's proportions left one group tiny and the other huge, sometimes unreadable.
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
    // Real paths (symlinks resolved) for commands that change files (message_guard.ts RealPathChecks).
    // A path that does not exist yet (a new file) resolves through its nearest existing parent.
    const realPathOf = (p: string): string => {
        let current = path.resolve(p);
        const rest: string[] = [];
        for (;;) {
            try {
                return path.join(fs.realpathSync.native(current), ...rest.reverse());
            } catch {
                const parent = path.dirname(current);
                if (parent === current) {
                    return path.resolve(p);
                }
                rest.push(path.basename(current));
                current = parent;
            }
        }
    };
    const realInside = (target: string, folderPath: string) => {
        const root = realPathOf(folderPath);
        const real = realPathOf(target);
        return real === root || real.startsWith(root + path.sep);
    };
    const fileFolders = () => (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === "file");
    const realPathChecks = {
        uri: (uriString: string) => {
            const uri = vscode.Uri.parse(uriString);
            return uri.scheme !== "file" || fileFolders().some(folder => realInside(uri.fsPath, folder.uri.fsPath));
        },
        relative: (relativePath: string) => fileFolders().length === 0
            || fileFolders().some(folder => realInside(path.join(folder.uri.fsPath, relativePath), folder.uri.fsPath))
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
            // A later manual open of the same file must not be credited to this failed jump.
            study.clearThumbviewTarget();
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

            // One visual step, as for jump (switchLeavingFullscreen): the Zen exit, the unmaximize,
            // and the return to the user's file are sent back to back, so the file appears directly
            // in the restored layout instead of after a frame of the empty layout. Dispatch order is
            // exit, unmaximize, then show (openInGroup loads the document first), so the maximize is
            // undone before a file opens in another group. All settle before the fallbacks run.
            // 0. Return to where the user was when F4 opened Thumbview (the tracker's return point).
            // 1. Otherwise try lastActiveTextEditor if valid and not closed
            const exiting = thumbviewEnteredZenMode ? (thumbviewEnteredZenMode = false, exitFullscreen()) : Promise.resolve();
            const unmaximizing = unmaximizeIfSplits();
            const returning = editorGroups.returnToEditor();
            const [, , returnSettled] = await Promise.allSettled([exiting, unmaximizing, returning]);
            const returnResult: OpenResult = returnSettled.status === "fulfilled" ? returnSettled.value : "failed";
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
                // From now on this workspace pre-scans at startup, so later first opens are instant.
                context.workspaceState.update(HAS_OPENED_KEY, true);
                context.globalState.update(EVER_OPENED_KEY, true);

                activePanel = panel;
                session.shown();
                studyPanelVisible = true;
                studyShown(panel, lastOpenSource, true);
                editorGroups.recordCovered(editorsBeforeCreate, createColumn);

                // pdf.js is not on the page: overview.js loads it after Thumbview has opened (requestPdfJs).
                const currentParticipant = readParticipantFile().participant;
                panel.webview.html = getHtml(panel.webview, context, getOpenKeybindingLabel(), currentParticipant?.id ?? "");
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

            // Settings, ignore patterns, and one-time notices (settings_actions.ts).
            const settingsActions = createSettingsActions({
                context,
                get activePanel() {
                    return activePanel;
                },
                refreshThumbview,
                updateLayoutFromCache,
                getIgnoreState,
                persistIgnoreState,
                refreshProviders,
                isFullscreenOnOpen,
                forgetSpanningPlacements: () => {
                    lastSpanningPlacements = [];
                }
            });

            // Explorer-style file actions from tiles and folder cards (file_actions.ts).
            const fileActions = createFileActions({
                get activePanel() {
                    return activePanel;
                },
                refreshThumbview,
                updateLayoutFromCache,
                getIgnoreState,
                persistIgnoreState,
                refreshProviders
            });

            panel.webview.onDidReceiveMessage(async msg => {
                if (!isSafeWebviewMessage(msg, isUriInsideWorkspace, realPathChecks)) {
                    console.warn("THUMBVIEW: rejected webview message targeting a path outside the workspace", msg && msg.command);
                    return;
                }

                if (msg.command === "exitThumbview") {
                    await closeActiveThumbview();
                    return;
                }

                // PDF preview stages and failures (overview.js reportPdf): { level: "info" | "warn", text }.
                if (msg.command === "pdfStatus") {
                    const text = `PDF previews: ${String(msg.text ?? "").slice(0, 300)}`;
                    if (msg.level === "warn") {
                        log.warn(text);
                    } else {
                        log.info(text);
                    }
                    return;
                }

                // One visit's summary (overview.js studyEpisode); validated field by field in study_events.ts.
                if (msg.command === "studyEpisode") {
                    hostVisit.handedOff();
                    study.recordEpisode(msg, studyVisitRequestedAt, { layoutMode: getLayoutMode(), fullscreen: fullscreenActive });
                    studyVisitRequestedAt = null;
                    return;
                }
                if (STUDY_ACTIONS.has(msg.command)) {
                    study.recordAction(msg.command);
                }
                if ((msg.command === "jump" || msg.command === "switchTab" || msg.command === "openPreview" || msg.command === "openToSide") && typeof msg.uri === "string") {
                    study.noteThumbviewTarget(msg.uri);
                }

                if (msg.command === "ready") {
                    postedContentVersions.clear();
                    lastReorderSeq = 0; // a new page numbers its drops from 1 again
                    lineStreamGeneration++;
                    const pendingPrescan = cachedScannedFiles ? undefined : startPrescan();
                    if (pendingPrescan) {
                        const scanWaitStart = performance.now();
                        await pendingPrescan;
                        log.info(`Webview ready; waited ${Math.round(performance.now() - scanWaitStart)} ms for the initial workspace scan (${(cachedScannedFiles as RepoFile[] | null)?.length ?? 0} files).`);
                    }
                    // Markers went stale while no panel was visible (or were never fetched). A fetch that
                    // finishes within GIT_FIRST_PAINT_WAIT_MS lands in the first payload; a slower one
                    // follows as a second payload so it never holds up the first paint.
                    let lateGit: Promise<unknown> | undefined;
                    if (gitStale) {
                        gitStale = false;
                        const git = fetchWorkspaceGitDiff().catch(() => { });
                        const inTime = await Promise.race([
                            git.then(() => true),
                            new Promise<boolean>(resolve => setTimeout(() => resolve(false), GIT_FIRST_PAINT_WAIT_MS))
                        ]);
                        if (!inTime) {
                            lateGit = git;
                        }
                    }
                    const firstPaint = cachedScannedFiles && cachedScannedFiles.length > 0
                        ? updateLayoutFromCache(panel)
                        : refreshThumbview(panel);
                    if (lateGit) {
                        Promise.all([firstPaint, lateGit]).then(() => refreshOrDefer("layout"));
                    }
                    endTransition(panel);
                    maybeShowFullscreenNotice(panel);
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
                    const ids = sanitizeOrderIds(msg.ids);
                    if (!ids) {
                        return;
                    }
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
                    const savedWrapRows = sanitizeRowCount(msg.wrapRows);
                    if (savedWrapRows !== undefined) {
                        await withOrderLock(async () => {
                            if (msg.scope === "rootCards") {
                                await context.workspaceState.update("thumbview.cardWrapRows", savedWrapRows);
                            } else if (typeof msg.folder === "string" && msg.folder) {
                                const wrapKey = msg.scope === "folderCards" ? "thumbview.folderCardWrapRows" : "thumbview.folderWrapRows";
                                const wraps = context.workspaceState.get<{ [folder: string]: number }>(wrapKey) || {};
                                wraps[msg.folder] = savedWrapRows;
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

                // Settings, ignore patterns, and one-time notices (settings_actions.ts), by command name.
                const settingsAction = settingsActions[msg.command];
                if (settingsAction) {
                    await settingsAction(msg);
                    return;
                }

                // File and Explorer actions (file_actions.ts), looked up by command name.
                const fileAction = fileActions[msg.command];
                if (fileAction) {
                    await fileAction(msg);
                    return;
                }

                if (msg.command === "reorderFile") {
                    // Fields: reorderSeq (number), echoed in every later payload so the webview knows
                    // which of its drops a payload already includes (overview.js keepPendingRootOrder).
                    if (typeof msg.reorderSeq === "number" && Number.isFinite(msg.reorderSeq)) {
                        lastReorderSeq = Math.max(lastReorderSeq, msg.reorderSeq);
                    }
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
                                    // The one stability rule (fillLayoutHoles): new files fill holes left by removed
                                    // ones; "" user gaps are never filled. In spanning mode a hole has the removed
                                    // file's cells, and a file takes only a hole it fits in.
                                    const spanning = layoutMode === "spanning_grid";
                                    const holeCells = spanning ? context.workspaceState.get<{ [id: string]: number }>("thumbview.naturalCells") || {} : {};
                                    const scopedCells = new Map(scopedFiles.map(f => [f.id, spanning ? cellsNeeded(f.lineCount, DEFAULT_BASE_LINES_PER_CELL, getCompressionPct()) : 1]));
                                    currentFolderOrder = fillLayoutHoles(currentFolderOrder, scopedIds, id => scopedCells.get(id) ?? 1, id => holeCells[id] ?? 1).order;
                                }

                                if (layoutMode === "spanning_grid") {
                                    const folderWrapRowsMap = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderWrapRows") || {};
                                    const sentOrder = sanitizeOrderIds(msg.currentOrder);
                                    if (sentOrder && sentOrder.length > 0) {
                                        currentFolderOrder = sentOrder;
                                        const sentWrapRows = sanitizeRowCount(msg.wrapRows);
                                        if (sentWrapRows !== undefined) {
                                            folderWrapRowsMap[msg.focusedFolder] = sentWrapRows;
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
                                const sentOrder = sanitizeOrderIds(msg.currentOrder);
                                if (sentOrder && sentOrder.length > 0) {
                                    fileOrder.setOrder(sentOrder);
                                    const sentWrapRows = sanitizeRowCount(msg.wrapRows);
                                    if (sentWrapRows !== undefined) {
                                        await context.workspaceState.update("thumbview.spanningRows", sentWrapRows);
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
                            const sentCardIds = sanitizeOrderIds(msg.currentCardIds);
                            if (sentCardIds && sentCardIds.length > 0) {
                                cardOrder = sentCardIds;
                            } else if (isFolderTarget) {
                                cardOrder = folderCardOrders[msg.focusedFolder] ? [...folderCardOrders[msg.focusedFolder]] : [];
                            } else {
                                cardOrder = context.workspaceState.get<string[]>("thumbview.cardOrder") || [];
                            }
                            if (msg.sourceId && !cardOrder.includes(msg.sourceId)) {
                                cardOrder.push(msg.sourceId);
                            }

                            if (msg.isSpanning) {
                                const cardWrapRows = sanitizeRowCount(msg.wrapRows);
                                if (isFolderTarget) {
                                    folderCardOrders[msg.focusedFolder] = cardOrder;
                                    if (cardWrapRows !== undefined) {
                                        const folderCardWrapRows = context.workspaceState.get<{ [folder: string]: number }>("thumbview.folderCardWrapRows") || {};
                                        folderCardWrapRows[msg.focusedFolder] = cardWrapRows;
                                        await context.workspaceState.update("thumbview.folderCardWrapRows", folderCardWrapRows);
                                    }
                                    await context.workspaceState.update("thumbview.folderCardOrders", folderCardOrders);
                                } else {
                                    if (cardWrapRows !== undefined) {
                                        await context.workspaceState.update("thumbview.cardWrapRows", cardWrapRows);
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
                        vscode.window.setStatusBarMessage("Expanded grid space.", STATUS_MESSAGE_MS);
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
                        vscode.window.setStatusBarMessage("Reduced grid space.", STATUS_MESSAGE_MS);
                        if (activePanel) {
                            updateLayoutFromCache(activePanel);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to reduce space: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "refresh") {
                    try {
                        clearScanCache();
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

            });

            panel.onDidChangeViewState(async e => {
                if (e.webviewPanel.visible !== studyPanelVisible) {
                    studyPanelVisible = e.webviewPanel.visible;
                    if (!studyPanelVisible) {
                        studyHiddenAt = Date.now();
                        study.recordHidden();
                        // The visit ends only if the panel stays hidden past the flicker window; Zen and
                        // maximize steps hide it briefly. Protocol: "studyVisitEnd", no fields.
                        if (studyVisitEndTimer) {
                            clearTimeout(studyVisitEndTimer);
                        }
                        studyVisitEndTimer = setTimeout(() => {
                            studyVisitEndTimer = undefined;
                            try {
                                if (!panel.visible) {
                                    // The webview reports this visit now (as dismissed unless a jump already did).
                                    hostVisit.handedOff();
                                    panel.webview.postMessage({ command: "studyVisitEnd" });
                                }
                            } catch {
                                // Disposed meanwhile; onDidDispose reported the visit.
                            }
                        }, STUDY_FLICKER_MS);
                    } else if (studyVisitEndTimer) {
                        // Back within the flicker window: the same visit continues.
                        clearTimeout(studyVisitEndTimer);
                        studyVisitEndTimer = undefined;
                    } else if (Date.now() - studyHiddenAt > STUDY_FLICKER_MS) {
                        // Shown by F4 or the Open command just now, else by a tab click or Ctrl+Tab.
                        studyShown(panel, Date.now() - lastToggleAt < 2000 ? lastOpenSource : "tab", false);
                    }
                }
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

            panel.onDidDispose(() => {
                // Synchronously, before the layout lock: a panel created while the lock is held must
                // not have its visit reported or its visibility reset by this one's dispose.
                if (studyVisitEndTimer) {
                    clearTimeout(studyVisitEndTimer);
                    studyVisitEndTimer = undefined;
                }
                // A tab closed mid-visit took the page and its summary with it (HostVisitTracker).
                const closedVisit = hostVisit.closedTab(studyPanelVisible ? Date.now() : studyHiddenAt);
                if (closedVisit) {
                    study.recordEpisode(closedVisit, null, { layoutMode: getLayoutMode(), fullscreen: fullscreenActive });
                }
                studyPanelVisible = false;
                return withLayoutLock(async () => {
                    if (activePanel === panel) {
                        activePanel = undefined;
                    }
                    // Same order as every other path: leave Zen first, then undo our maximize.
                    if (thumbviewEnteredZenMode) {
                        thumbviewEnteredZenMode = false;
                        await exitFullscreen();
                    }
                    await unmaximizeIfSplits();
                });
            });
    }, withLayoutLock);

    const disposable = vscode.commands.registerCommand("thumbview.open", (args?: { source?: string; inZen?: boolean }) => {
        lastOpenSource = args?.source === "keybinding" ? "f4" : "command";
        lastOpenRequestedAt = Date.now();
        // inZenMode is also true while Thumbview's own Zen is on (F4 to close); only otherwise is it the user's.
        userZenOnOpen = args?.inZen === true && !fullscreenActive;
        // Overlaps a scan not yet started (F4 within PRESCAN_DELAY_MS of startup) with panel creation.
        startPrescan();
        return toggleThumbview();
    });
    context.subscriptions.push(disposable);

    const reflowDisposable = vscode.commands.registerCommand("thumbview.reflow", async () => {
        const { files } = await fullScan();
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
        vscode.window.setStatusBarMessage("Thumbview layout reflowed and gaps filled.", STATUS_MESSAGE_MS);
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
        vscode.window.setStatusBarMessage("Expanded grid space.", STATUS_MESSAGE_MS);
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
        vscode.window.setStatusBarMessage("Reduced grid space.", STATUS_MESSAGE_MS);
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(reduceSpaceDisposable);

    const setUniformGridDisposable = vscode.commands.registerCommand("thumbview.setUniformGrid", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("layoutMode", "uniform_grid", vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage("Thumbview Layout set to Uniform Grid.", STATUS_MESSAGE_MS);
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(setUniformGridDisposable);

    const setSpanningGridDisposable = vscode.commands.registerCommand("thumbview.setSpanningGrid", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("layoutMode", "spanning_grid", vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage("Thumbview Layout set to Spanning Grid.", STATUS_MESSAGE_MS);
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(setSpanningGridDisposable);

    const setSwapReorderModeDisposable = vscode.commands.registerCommand("thumbview.setSwapReorderMode", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("dragReorderMode", "swap", vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage("Thumbview Drag Reorder Mode set to Swap.", STATUS_MESSAGE_MS);
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(setSwapReorderModeDisposable);

    const setShiftReorderModeDisposable = vscode.commands.registerCommand("thumbview.setShiftReorderMode", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("dragReorderMode", "shift", vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage("Thumbview Drag Reorder Mode set to Shift.", STATUS_MESSAGE_MS);
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
                vscode.window.showInformationMessage(`Ignored directory '${folderPath}'. Unignore it from the Folders & Ignored menu in the Thumbview toolbar.`);
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
        // Both decide which files are listed (file_discovery.ts); works with or without a panel.
        if (e.affectsConfiguration("files.exclude") || e.affectsConfiguration("search.exclude")) {
            refreshOrDefer("rescan");
        }
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
    let pendingDisk: PendingDiskChanges<vscode.Uri> = emptyPendingChanges();
    // "listing": a .gitignore or .git/info/exclude edit, which changes what is listed.
    const triggerUpdate = (uri: vscode.Uri, kind: "change" | "create" | "delete" | "listing") => {
        invalidateScanFile(uri.fsPath);
        const event = { key: uri.fsPath, rel: vscode.workspace.asRelativePath(uri).replace(/\\/g, "/"), uri };
        if (kind === "listing") {
            pendingDisk.structural = true;
        } else if (kind === "delete") {
            pendingDisk.deleted.set(event.key, event);
        } else {
            (kind === "create" ? pendingDisk.created : pendingDisk.changed).set(event.key, event);
            diskChanges.record(event.key, uri);
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            const batch = pendingDisk;
            pendingDisk = emptyPendingChanges();
            applyDiskChanges(batch).catch(err => log.error(`Applying file changes failed: ${err?.message ?? err}`));
        }, 200);
    };
    reReadAfterScan = uris => uris.forEach(uri => triggerUpdate(uri, "change"));

    // The cheapest correct refresh for a batch (planDiskChanges in disk_changes.ts): shown files are
    // re-read one by one, and only a delete of a listed path, a create git would list, or a listing
    // rule change takes the full rescan. Build output, caches, and swap files cost nothing.
    const applyDiskChanges = async (batch: PendingDiskChanges<vscode.Uri>): Promise<void> => {
        const { ignorePatterns } = getIgnoreState();
        const shownIds = new Set((cachedScannedFiles ?? []).map(f => f.id));
        const plan = planDiskChanges(batch, {
            isShown: key => shownIds.has(key),
            isListed: isListedPath,
            containsListed: containsListedPath,
            isIgnored: rel => shouldIgnore(rel, ignorePatterns)
        });
        let needsRescan = plan.rescan;
        if (!needsRescan && plan.toCheck.length > 0) {
            const listable = await listableAmong(plan.toCheck);
            needsRescan = listable === null || listable.length > 0;
        }
        if (!cachedScannedFiles) {
            // No scan installed yet. A scan in flight may have listed before this change; rescan after it.
            if (needsRescan && prescanPromise) {
                prescanPromise.then(() => refreshOrDefer("rescan"));
            }
            return;
        }
        if (!needsRescan && plan.toRead.length === 0) {
            return;
        }
        // A save's git markers land in the same payload as its lines.
        const gitRefresh = requestGitRefresh();
        const reread = await Promise.all(plan.toRead.map(uri => rescanFile(uri)));
        await gitRefresh;
        if (!cachedScannedFiles) {
            return;
        }
        const dirtyDocs = new Map(vscode.workspace.textDocuments.filter(d => d.isDirty).map(d => [d.uri.fsPath, d]));
        for (let i = 0; i < plan.toRead.length; i++) {
            const index = cachedScannedFiles.findIndex(f => f.id === plan.toRead[i].fsPath);
            const file = reread[i];
            if (!file) {
                // Now binary, empty, oversized, or gone: the listing decides what happens to its slot.
                needsRescan = true;
            } else if (index !== -1) {
                cachedScannedFiles[index] = file;
                const dirty = dirtyDocs.get(file.id);
                if (dirty) {
                    updateDocumentInCache(dirty);
                }
            }
        }
        refreshOrDefer(needsRescan ? "rescan" : "layout");
    };

    // Commits, checkouts, and staging change git markers without touching a shown file.
    let gitMetaTimer: NodeJS.Timeout | undefined;
    const isGitMetaPath = (rel: string) => /(^|\/)\.git\/(index|HEAD)$/.test(rel);

    // .git churn and dependency installs never touch shown files.
    // Nothing is cached until Thumbview's first scan in this workspace (startPrescan), and the first
    // scan reads everything anyway: until then file, edit, and diagnostics events cost nothing.
    const nothingToUpdate = () => !cachedScannedFiles && !scanInFlight;
    const onWatcherEvent = (uri: vscode.Uri, kind: "change" | "create" | "delete") => {
        if (nothingToUpdate()) {
            return;
        }
        const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
        if (isListingRuleFile(rel)) {
            triggerUpdate(uri, "listing");
            return;
        }
        if (isGitMetaPath(rel)) {
            if (gitMetaTimer) {
                clearTimeout(gitMetaTimer);
            }
            gitMetaTimer = setTimeout(() => {
                requestGitRefresh().then(() => refreshOrDefer("layout"));
            }, 300);
            return;
        }
        if (!isAlwaysExcluded(rel)) {
            triggerUpdate(uri, kind);
        }
    };
    watcher.onDidCreate(uri => onWatcherEvent(uri, "create"));
    watcher.onDidDelete(uri => onWatcherEvent(uri, "delete"));
    watcher.onDidChange(uri => onWatcherEvent(uri, "change"));

    // Debounced so typing rebuilds the cached document and re-posts the workspace payload once
    // per pause, not once per keystroke. While Thumbview is hidden or closed nothing is rebuilt:
    // the documents stay queued until the next payload is built (applyPendingDocChanges), so typing
    // never costs a copy of the document on the extension host for a map nobody is looking at.
    let docChangeDebounceTimer: NodeJS.Timeout | undefined;
    const docChangeDisposable = vscode.workspace.onDidChangeTextDocument(e => {
        // A scan re-applies every unsaved document (refreshThumbview), so nothing is queued before one.
        if (e.contentChanges.length === 0 || nothingToUpdate()) {
            return;
        }
        pendingChangedDocs.set(e.document.uri.toString(), e.document);
        docsWithUnsavedText.add(e.document.uri.toString());
        if (docChangeDebounceTimer) {
            clearTimeout(docChangeDebounceTimer);
        }
        docChangeDebounceTimer = setTimeout(() => {
            if (activePanel?.visible) {
                applyPendingDocChanges();
            }
            refreshOrDefer("layout");
        }, 300);
    });
    context.subscriptions.push(docChangeDisposable);

    // The save joins its own watcher event in triggerUpdate's debounce: one re-read of the file,
    // one git refresh, and one payload.
    const docSaveDisposable = vscode.workspace.onDidSaveTextDocument(doc => {
        pendingChangedDocs.delete(doc.uri.toString());
        docsWithUnsavedText.delete(doc.uri.toString());
        triggerUpdate(doc.uri, "change");
    });
    context.subscriptions.push(docSaveDisposable);

    // Closing a document whose edits were never saved ("Don't Save") leaves its unsaved text in the
    // cache; nothing on disk changed, so no watcher event would correct it. Re-read the file instead.
    const docCloseDisposable = vscode.workspace.onDidCloseTextDocument(doc => {
        const key = doc.uri.toString();
        pendingChangedDocs.delete(key);
        if (docsWithUnsavedText.delete(key) && doc.uri.scheme === "file") {
            triggerUpdate(doc.uri, "change");
        }
    });
    context.subscriptions.push(docCloseDisposable);

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
        if (nothingToUpdate()) {
            return;
        }
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

export function deactivate(): Promise<void> | undefined {
    return deactivateHook?.();
}
