import * as vscode from "vscode";
import { scanRepository, ScanIgnoreState, shouldIgnore, RepoFile, isSourceRootRegex, clearScanCache } from "./scanner";
import { buildStableGrid, slotToIndex, findSlotIndex } from "./layout";
import { buildSpanningGrid, cellsNeeded, integrateNewFilesPreservingPositions, SpanningPlacement } from "./spanning_layout";
import { PersistentFileOrder } from "./state";
import { IgnoreTreeItem } from "./ignoreProvider";
import { DirectoryTreeItem } from "./directoryProvider";
import { fetchWorkspaceGitDiff, getCachedGitDiff } from "./git";
import { ACCENT_SEARCH, ACCENT_INSPECT, ACCENT_RECENCY, withAlpha } from "./colors";
import { clampTargetToGridCapacity, reorderFolderItems, reorderCardItems, reorderSpanningItems } from "./reorder_helpers";

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

    const detectOpenKeybinding = (): string => {
        try {
            const home = process.env.HOME || process.env.USERPROFILE || "";
            const candidates: string[] = [];

            if (context.globalStorageUri && context.globalStorageUri.fsPath) {
                candidates.push(path.resolve(context.globalStorageUri.fsPath, "..", "..", "keybindings.json"));
                candidates.push(path.resolve(context.globalStorageUri.fsPath, "..", "keybindings.json"));
            }
            if (context.logUri && context.logUri.fsPath) {
                candidates.push(path.resolve(context.logUri.fsPath, "..", "..", "keybindings.json"));
                candidates.push(path.resolve(context.logUri.fsPath, "..", "..", "..", "keybindings.json"));
            }

            if (process.platform === "win32") {
                const appData = process.env.APPDATA || "";
                candidates.push(path.join(appData, "Code", "User", "keybindings.json"));
                candidates.push(path.join(appData, "Code - Insiders", "User", "keybindings.json"));
                candidates.push(path.join(appData, "Code - OSS", "User", "keybindings.json"));
                candidates.push(path.join(appData, "VSCodium", "User", "keybindings.json"));
            } else if (process.platform === "darwin") {
                candidates.push(path.join(home, "Library", "Application Support", "Code", "User", "keybindings.json"));
                candidates.push(path.join(home, "Library", "Application Support", "Code - Insiders", "User", "keybindings.json"));
                candidates.push(path.join(home, "Library", "Application Support", "Code - OSS", "User", "keybindings.json"));
                candidates.push(path.join(home, "Library", "Application Support", "VSCodium", "User", "keybindings.json"));
            } else {
                candidates.push(path.join(home, ".config", "Code", "User", "keybindings.json"));
                candidates.push(path.join(home, ".config", "Code - OSS", "User", "keybindings.json"));
                candidates.push(path.join(home, ".config", "Code - Insiders", "User", "keybindings.json"));
                candidates.push(path.join(home, ".config", "VSCodium", "User", "keybindings.json"));
                candidates.push(path.join(home, ".vscode-oss-dev", "User", "keybindings.json"));
                candidates.push(path.join(home, ".vscode-insiders", "User", "keybindings.json"));
            }

            for (const keybindingsPath of candidates) {
                if (keybindingsPath && fs.existsSync(keybindingsPath)) {
                    const raw = fs.readFileSync(keybindingsPath, "utf-8");
                    
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

                    // Robust Regex extraction for positive binding
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
                }
            }
        } catch {
        }
        return "F4";
    };

    const getOpenKeybindingLabel = (): string => detectOpenKeybinding();

    let cachedScannedFiles: RepoFile[] | null = null;

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

    const computeIgnoreCounts = (patterns: string[], allPaths: string[]): { counts: { [pat: string]: number }; filesMap: { [pat: string]: string[] } } => {
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
        return { counts, filesMap };
    };

    const updateLayoutFromCache = async (panel: vscode.WebviewPanel, forceBreakBeforeId?: string) => {
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

            if (mode === "spanning_grid") {
                const savedAllocations = context.workspaceState.get<{ [id: string]: number }>("thumbview.spanningAllocations") || {};
                let savedRows = context.workspaceState.get<number | null>("thumbview.spanningRows") || null;

                if (lastSpanningPlacements.length > 0) {
                    const prevIds = new Set(lastSpanningPlacements.map(p => p.file.id));
                    const newIds = activeFileIds.filter(id => !prevIds.has(id));
                    if (newIds.length > 0) {
                        const validPrevPlacements = lastSpanningPlacements.filter(p => activeFileIds.includes(p.file.id));
                        const integrated = integrateNewFilesPreservingPositions(validPrevPlacements, newIds, savedAllocations, 16 / 9);
                        fileOrder.setOrder(integrated.newOrder);
                        savedRows = integrated.wrapRows;
                        await context.workspaceState.update("thumbview.spanningRows", integrated.wrapRows);
                    } else {
                        fileOrder.update(activeFileIds);
                    }
                } else {
                    fileOrder.update(activeFileIds);
                }
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

                const layout = buildSpanningGrid(filesWithWebviewUris, order, savedAllocations, savedRows, forceBreakBeforeId ?? null);
                lastSpanningPlacements = layout.placements;

                await context.workspaceState.update("thumbview.spanningAllocations", layout.allocations);
                await context.workspaceState.update("thumbview.spanningRows", layout.wrapRows);

                const filesWithSlots = layout.placements.map(p => ({
                    ...p.file,
                    slot: [p.col, p.row],
                    nCells: p.nCells,
                    slots: p.slots
                }));

                panel.webview.postMessage({
                    command: "data",
                    mode: "spanning_grid",
                    dragReorderMode,
                    renderMediaThumbnails,
                    minCellWidth,
                    minCellHeight,
                    openKeybinding,
                    ignorePatterns,
                    ignorePatternCounts,
                    ignoredFilesMap,
                    extraCols,
                    extraRows,
                    cardOrder: context.workspaceState.get<string[]>("thumbview.cardOrder") || [],
                    folderOrders: context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderOrders") || {},
                    files: filesWithSlots,
                    layout: {
                        cols: layout.cols + extraCols,
                        rows: layout.rows + extraRows
                    }
                });
            } else { // uniform grid (default)
                const layout = buildStableGrid(order.length);

                const filesWithSlots = filesWithWebviewUris.map(file => ({
                    ...file,
                    slot: layout.slots[order.indexOf(file.id)],
                    nCells: 1,
                    slots: [layout.slots[order.indexOf(file.id)]]
                }));
                
                // sort so that array order reflects the user's custom order because subfolder views
                // build their grids by iterating this array directly (ignoring slot position)
                filesWithSlots.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

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
                    minCellWidth,
                    minCellHeight,
                    openKeybinding,
                    ignorePatterns,
                    ignorePatternCounts,
                    ignoredFilesMap,
                    extraCols,
                    extraRows,
                    cardOrder: context.workspaceState.get<string[]>("thumbview.cardOrder") || [],
                    folderOrders: context.workspaceState.get<{ [folder: string]: string[] }>("thumbview.folderOrders") || {},
                    files: filesWithSlots,
                    layout: {
                        cols: Math.max(layout.cols, ugMaxCol + 1) + extraCols,
                        rows: Math.max(layout.rows, ugMaxRow + 1) + extraRows,
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

    const refreshThumbview = async (panel: vscode.WebviewPanel) => {
        try {
            panel.webview.postMessage({
                command: "status",
                text: "Refreshing Thumbview...",
                clearData: false
            });

            const files = await scanRepository(getIgnoreState(), persistIgnoreState);
            cachedScannedFiles = files;

            await updateLayoutFromCache(panel);
        } catch (err: any) {
            console.error("THUMBVIEW REFRESH ERROR:", err);
            panel.webview.postMessage({
                command: "status",
                text: `Error: ${err?.message ?? String(err)}`
            });
        }
    };

    // Fullscreen = Zen Mode (natively hides AND restores sidebar/panel/aux bar —
    // extensions cannot read workbench visibility state, so VS Code must do the
    // snapshotting). All layout ops are serialized through layoutQueue; concurrent
    // enter/exit calls from the command path and onDidChangeViewState must not stack blind toggles.
    let fullscreenActive = false;
    let thumbviewEnteredZenMode = false;
    let groupMaximizedByUs = false;

    const initZenSettings = () => {
        try {
            const config = vscode.workspace.getConfiguration();
            if (config.get<boolean>("zenMode.centerLayout") !== false) {
                config.update("zenMode.centerLayout", false, vscode.ConfigurationTarget.Global);
            }
            if (config.get<boolean>("zenMode.fullScreen") !== false) {
                config.update("zenMode.fullScreen", false, vscode.ConfigurationTarget.Global);
            }
            if (config.get<boolean>("zenMode.hideActivityBar") !== false) {
                config.update("zenMode.hideActivityBar", false, vscode.ConfigurationTarget.Global);
            }
            if (config.get<boolean>("zenMode.hideLineNumbers") !== false) {
                config.update("zenMode.hideLineNumbers", false, vscode.ConfigurationTarget.Global);
            }
            if (config.get<string>("zenMode.showTabs") !== "none") {
                config.update("zenMode.showTabs", "none", vscode.ConfigurationTarget.Global);
            }
            if (config.get<boolean>("zenMode.singleTabGroup") !== true) {
                config.update("zenMode.singleTabGroup", true, vscode.ConfigurationTarget.Global);
            }
        } catch {
        }
    };
    initZenSettings();

    // Background pre-scan and git diff fetch so opening Thumbview is instant O(1)
    scanRepository(getIgnoreState(), persistIgnoreState).then(files => {
        cachedScannedFiles = files;
    }).catch(() => {});
    fetchWorkspaceGitDiff().catch(() => {});
    getAllWorkspaceRelativePaths().catch(() => {});

    const enterFullscreen = async (): Promise<void> => {
        if (fullscreenActive) {
            return;
        }
        fullscreenActive = true;
        try {
            await vscode.commands.executeCommand("workbench.action.toggleZenMode");
        } catch {
        }
    };

    const exitFullscreen = async (): Promise<void> => {
        if (!fullscreenActive) {
            return;
        }
        fullscreenActive = false;
        try {
            await vscode.commands.executeCommand("workbench.action.exitZenMode");
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

    const disposable = vscode.commands.registerCommand(
        "thumbview.open",
        async () => {
            console.log("THUMBVIEW COMMAND EXECUTED");

            if (activePanel) {
                const panelToDispose = activePanel;
                activePanel = undefined;
                try {
                    panelToDispose.dispose();
                } catch { }

                if (thumbviewEnteredZenMode) {
                    thumbviewEnteredZenMode = false;
                    exitFullscreen();
                }
                if (groupMaximizedByUs) {
                    unmaximizeIfSplits();
                }

                if (lastActiveTextEditor && !lastActiveTextEditor.document.isClosed) {
                    try {
                        await vscode.window.showTextDocument(lastActiveTextEditor.document, { preview: false });
                    } catch {
                        try {
                            await vscode.commands.executeCommand("workbench.action.previousEditor");
                        } catch { }
                    }
                } else {
                    try {
                        await vscode.commands.executeCommand("workbench.action.previousEditor");
                    } catch { }
                }
                return;
            }

            // Sync currently open modified documents into memory cache
            for (const doc of vscode.workspace.textDocuments) {
                updateDocumentInCache(doc);
            }
            fetchWorkspaceGitDiff().catch(() => {});

            let panel: vscode.WebviewPanel;
            try {
                panel = vscode.window.createWebviewPanel(
                    "thumbview",
                    "Thumbview",
                    vscode.ViewColumn.Active,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: false,
                        localResourceRoots: [
                            vscode.Uri.joinPath(context.extensionUri, "media"),
                            ...(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(f => f.uri) : [])
                        ]
                    }
                );

                activePanel = panel;
                if (vscode.window.tabGroups.all.length > 1 && !groupMaximizedByUs) {
                    groupMaximizedByUs = true;
                    try {
                        await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
                    } catch { }
                }

                panel.webview.html = getHtml(panel.webview, context, getOpenKeybindingLabel());
            } catch (err) {
                console.error("Failed to open Thumbview panel:", err);
                return;
            }

            panel.webview.onDidReceiveMessage(async msg => {
                console.log("THUMBVIEW WEBVIEW MESSAGE:", msg);

                if (msg.command === "ensureZenMode") {
                    thumbviewEnteredZenMode = true;
                    await enterFullscreen();
                }

                if (msg.command === "ready") {
                    if (cachedScannedFiles && cachedScannedFiles.length > 0) {
                        updateLayoutFromCache(panel);
                    } else {
                        refreshThumbview(panel);
                    }
                }

                if (msg.command === "focusWindow") {
                    if (activePanel && !activePanel.active) {
                        activePanel.reveal(undefined, true);
                    }
                }

                if (msg.command === "switchTab") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        if (activePanel) {
                            const p = activePanel;
                            activePanel = undefined;
                            try { p.dispose(); } catch { }
                        }
                        if (thumbviewEnteredZenMode) {
                            thumbviewEnteredZenMode = false;
                            exitFullscreen();
                        }
                        if (groupMaximizedByUs) {
                            unmaximizeIfSplits();
                        }
                        if (msg.uri.toLowerCase().endsWith(".pdf")) {
                            await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
                        } else {
                            try {
                                const doc = await vscode.workspace.openTextDocument(uri);
                                await vscode.window.showTextDocument(doc, { preview: false });
                            } catch {
                                await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
                            }
                        }
                    } catch (err: any) {
                        console.error("THUMBVIEW SWITCH TAB ERROR:", err);
                    }
                }

                if (msg.command === "jump") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        if (activePanel) {
                            const p = activePanel;
                            activePanel = undefined;
                            try { p.dispose(); } catch { }
                        }
                        if (thumbviewEnteredZenMode) {
                            thumbviewEnteredZenMode = false;
                            exitFullscreen();
                        }
                        if (groupMaximizedByUs) {
                            unmaximizeIfSplits();
                        }

                        let doc: vscode.TextDocument;
                        try {
                            doc = await vscode.workspace.openTextDocument(uri);
                        } catch {
                            // Binary/media file fallback
                            await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
                            return;
                        }

                        const safeLine = Math.max(
                            0,
                            Math.min(Number(msg.line) || 0, doc.lineCount - 1)
                        );
                        const pos = new vscode.Position(safeLine, 0);

                        const editor = await vscode.window.showTextDocument(doc, {
                            preview: false,
                            selection: new vscode.Range(pos, pos)
                        });

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
                            if (matchingRanges.length > 0) {
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
                    } catch (err: any) {
                        vscode.window.showErrorMessage(
                            `Thumbview jump failed: ${err?.message ?? String(err)}`
                        );
                    }
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
                        const confirm = await vscode.window.showWarningMessage(
                            `Are you sure you want to delete '${fileName}'?`,
                            { modal: true },
                            "Move to Trash",
                            "Delete Permanently"
                        );
                        if (confirm === "Move to Trash") {
                            await vscode.workspace.fs.delete(uri, { useTrash: true });
                            if (activePanel) {
                                refreshThumbview(activePanel);
                            }
                        } else if (confirm === "Delete Permanently") {
                            await vscode.workspace.fs.delete(uri, { useTrash: false });
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
                            const confirm = await vscode.window.showWarningMessage(
                                `Are you sure you want to delete folder '${folderRel}' and all its contents?`,
                                { modal: true },
                                "Move to Trash",
                                "Delete Permanently"
                            );
                            if (confirm === "Move to Trash") {
                                await vscode.workspace.fs.delete(folderUri, { recursive: true, useTrash: true });
                                if (activePanel) {
                                    refreshThumbview(activePanel);
                                }
                            } else if (confirm === "Delete Permanently") {
                                await vscode.workspace.fs.delete(folderUri, { recursive: true, useTrash: false });
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
                                const savedAllocations = context.workspaceState.get<{ [id: string]: number }>("thumbview.spanningAllocations") || {};
                                const extraCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
                                const extraRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
                                const baseWrapRows = Math.max(1, Math.round(Math.sqrt(Math.max(scopedFiles.length, 1) / (16 / 9))));
                                const wrapRows = msg.targetWrapRows || msg.targetGridRows || baseWrapRows;
                                const maxAllowedCols = Math.max(2, (msg.targetGridCols || 2) + extraCols);
                                const maxAllowedRows = Math.max(1, wrapRows + extraRows);

                                const res = reorderSpanningItems(
                                    scopedIds,
                                    currentFolderOrder,
                                    savedAllocations,
                                    msg.sourceId,
                                    msg.targetCol,
                                    msg.targetRow,
                                    maxAllowedCols,
                                    maxAllowedRows,
                                    wrapRows
                                );
                                currentFolderOrder = res.newOrder;
                            } else {
                                const gridCols = Math.max(1, msg.targetGridCols || 1);
                                const gridRows = Math.max(1, msg.targetGridRows || Math.ceil(currentFolderOrder.length / gridCols));
                                const maxCapacity = gridCols * gridRows;
                                const targetSlotIdx = (typeof msg.targetSlotIdx === "number" && msg.targetSlotIdx >= 0)
                                    ? msg.targetSlotIdx
                                    : findSlotIndex(msg.targetCol, msg.targetRow, currentFolderOrder.length);

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

                            if (activePanel) {
                                updateLayoutFromCache(activePanel);
                            }
                        } else if (layoutMode === "spanning_grid") {
                            const { ignorePatterns } = getIgnoreState();
                            const activeFiles = (cachedScannedFiles || []).filter(file => !shouldIgnore(file.path, ignorePatterns));
                            const savedAllocations = context.workspaceState.get<{ [id: string]: number }>("thumbview.spanningAllocations") || {};
                            const savedRows = context.workspaceState.get<number | null>("thumbview.spanningRows") || null;
                            const currentLayout = buildSpanningGrid(activeFiles, fileOrder.getOrder(), savedAllocations, savedRows);
                            const sourceCells = savedAllocations[msg.sourceId] || 1;
                            const targetCells = msg.targetId ? (savedAllocations[msg.targetId] || 1) : 1;

                            if (!msg.targetIsEmpty && mode === "shift" && sourceCells === targetCells) {
                                fileOrder.move(msg.sourceId, msg.targetId);
                            } else {
                                const placementByFileId = new Map<string, (typeof currentLayout.placements)[0]>();
                                const placementBySlot = new Map<string, (typeof currentLayout.placements)[0]>();

                                for (const p of currentLayout.placements) {
                                    placementByFileId.set(p.file.id, p);
                                    for (const s of p.slots) {
                                        placementBySlot.set(`${s[0]},${s[1]}`, p);
                                    }
                                }

                                const sourcePlacement = placementByFileId.get(msg.sourceId);
                                const sourceCol = sourcePlacement ? sourcePlacement.col : 0;
                                const sourceRow = sourcePlacement ? sourcePlacement.row : 0;

                                // Find if the drop lands on any occupied placement (including sub-cells of spanning files)
                                let targetPlacement = placementBySlot.get(`${msg.targetCol},${msg.targetRow}`);
                                if (targetPlacement && targetPlacement.file.id === msg.sourceId) {
                                    targetPlacement = undefined;
                                }

                                const extraCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
                                const extraRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
                                const maxAllowedRows = Math.max(currentLayout.rows, currentLayout.wrapRows, savedRows || 0) + extraRows;
                                const maxAllowedCols = Math.max(currentLayout.cols, 2) + extraCols;

                                const clamped = clampTargetToGridCapacity(msg.targetCol, msg.targetRow, sourceCells, maxAllowedCols, maxAllowedRows);
                                const targetCol = targetPlacement ? targetPlacement.col : clamped.col;
                                const targetRow = targetPlacement ? targetPlacement.row : clamped.row;

                                let reqRows = currentLayout.wrapRows;
                                for (const p of currentLayout.placements) {
                                    reqRows = Math.max(reqRows, p.row + p.nCells);
                                }
                                const gridRows = Math.min(maxAllowedRows, Math.max(reqRows, targetRow + sourceCells));
                                const maxCol = Math.min(maxAllowedCols - 1, Math.max(currentLayout.cols - 1, targetCol, sourceCol));

                                // Build 2D column-major grid representing current spanning layout
                                const grid: string[][] = [];
                                for (let c = 0; c <= maxCol; c++) {
                                    grid.push(new Array(gridRows).fill(""));
                                }
                                for (const p of currentLayout.placements) {
                                    for (let i = 0; i < p.nCells; i++) {
                                        if (p.row + i < gridRows && p.col <= maxCol) {
                                            grid[p.col][p.row + i] = p.file.id;
                                        }
                                    }
                                }

                                // Identify all target files overlapping the incoming file span in targetCol
                                const targetRaw = grid[targetCol].slice(targetRow, targetRow + sourceCells).filter(id => Boolean(id) && id !== msg.sourceId);
                                const targetFileIds = Array.from(new Set(targetRaw));
                                if (targetPlacement && !targetFileIds.includes(targetPlacement.file.id)) {
                                    targetFileIds.push(targetPlacement.file.id);
                                }

                                if (targetFileIds.length === 0) {
                                    for (let c = 0; c <= maxCol; c++) {
                                        for (let r = 0; r < gridRows; r++) {
                                            if (grid[c][r] === msg.sourceId) {
                                                grid[c][r] = "";
                                            }
                                        }
                                    }
                                    for (let i = 0; i < sourceCells; i++) {
                                        if (targetRow + i < gridRows) {
                                            grid[targetCol][targetRow + i] = msg.sourceId;
                                        }
                                    }
                                } else if (sourceCol === targetCol) {
                                    for (let r = 0; r < gridRows; r++) {
                                        if (grid[sourceCol][r] === msg.sourceId || targetFileIds.includes(grid[sourceCol][r])) {
                                            grid[sourceCol][r] = "";
                                        }
                                    }
                                    
                                    const minRow = Math.min(sourceRow, targetRow);
                                    if (sourceRow < targetRow) {
                                        let curR = minRow;
                                        for (const tid of targetFileIds) {
                                            const tc = savedAllocations[tid] || 1;
                                            for (let i = 0; i < tc; i++) {
                                                if (curR + i < gridRows) grid[sourceCol][curR + i] = tid;
                                            }
                                            curR += tc;
                                        }
                                        for (let i = 0; i < sourceCells; i++) {
                                            if (curR + i < gridRows) grid[sourceCol][curR + i] = msg.sourceId;
                                        }
                                    } else {
                                        let curR = minRow;
                                        for (let i = 0; i < sourceCells; i++) {
                                            if (curR + i < gridRows) grid[sourceCol][curR + i] = msg.sourceId;
                                        }
                                        curR += sourceCells;
                                        for (const tid of targetFileIds) {
                                            const tc = savedAllocations[tid] || 1;
                                            for (let i = 0; i < tc; i++) {
                                                if (curR + i < gridRows) grid[sourceCol][curR + i] = tid;
                                            }
                                            curR += tc;
                                        }
                                    }
                                } else {
                                    // Cross-column swap / displacement
                                    const maxTargetSpan = targetFileIds.reduce((sum, tid) => sum + (savedAllocations[tid] || 1), 0);
                                    const totalSpan = Math.max(sourceCells, maxTargetSpan);

                                    let effectiveSourceRow = sourceRow;
                                    if (sourceCells < maxTargetSpan) {
                                        effectiveSourceRow = Math.max(0, Math.min(sourceRow, gridRows - totalSpan));
                                        if (targetRow === 0 && sourceRow < totalSpan) {
                                            effectiveSourceRow = 0;
                                        }
                                    }

                                    const sourceRaw = grid[sourceCol].slice(effectiveSourceRow, effectiveSourceRow + totalSpan).filter(id => Boolean(id) && !targetFileIds.includes(id));
                                    const sourceFileIds = Array.from(new Set(sourceRaw));
                                    if (!sourceFileIds.includes(msg.sourceId)) {
                                        sourceFileIds.unshift(msg.sourceId);
                                    }

                                    // Clear sourceFileIds from sourceCol and targetFileIds from targetCol
                                    for (let r = 0; r < gridRows; r++) {
                                        if (sourceFileIds.includes(grid[sourceCol][r])) {
                                            grid[sourceCol][r] = "";
                                        }
                                        if (targetFileIds.includes(grid[targetCol][r])) {
                                            grid[targetCol][r] = "";
                                        }
                                    }

                                    // Place sourceFileIds in targetCol
                                    let curTargetR = targetRow;
                                    for (const sid of sourceFileIds) {
                                        const sidPlacement = placementByFileId.get(sid);
                                        const offset = sidPlacement ? Math.max(0, sidPlacement.row - effectiveSourceRow) : (curTargetR - targetRow);
                                        const destR = (sourceFileIds.length === 1 && sourceCells === 1) ? targetRow : (targetRow + offset);
                                        const sc = savedAllocations[sid] || 1;
                                        for (let i = 0; i < sc; i++) {
                                            if (destR + i < gridRows) {
                                                grid[targetCol][destR + i] = sid;
                                            }
                                        }
                                        curTargetR += sc;
                                    }

                                    // Place targetFileIds in sourceCol
                                    let curSourceR = effectiveSourceRow;
                                    for (const tid of targetFileIds) {
                                        const tidPlacement = placementByFileId.get(tid);
                                        const offset = tidPlacement ? Math.max(0, tidPlacement.row - targetRow) : (curSourceR - effectiveSourceRow);
                                        const destR = (targetFileIds.length === 1 && maxTargetSpan === 1 && targetPlacement && targetPlacement.row === targetRow)
                                            ? (sourceCells === 1 ? sourceRow : effectiveSourceRow)
                                            : (effectiveSourceRow + offset);
                                        const tc = savedAllocations[tid] || 1;
                                        for (let i = 0; i < tc; i++) {
                                            if (destR + i < gridRows) {
                                                grid[sourceCol][destR + i] = tid;
                                            }
                                        }
                                        curSourceR += tc;
                                    }
                                }

                                // Reconstruct order array from grid in column-major order
                                const newOrder: string[] = [];
                                for (let c = 0; c <= maxCol; c++) {
                                    let r = 0;
                                    while (r < gridRows) {
                                        const cell = grid[c][r];
                                        if (cell) {
                                            newOrder.push(cell);
                                            const nCells = savedAllocations[cell] || 1;
                                            r += nCells;
                                        } else {
                                            newOrder.push("");
                                            r += 1;
                                        }
                                    }
                                }
                                while (newOrder.length > 0 && !newOrder[newOrder.length - 1]) {
                                    newOrder.pop();
                                }

                                await context.workspaceState.update("thumbview.spanningRows", gridRows);
                                fileOrder.setOrder(newOrder);
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

                        if (activePanel) {
                            updateLayoutFromCache(activePanel, forceBreakBeforeId);
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to reorder file: ${err?.message ?? String(err)}`);
                    }
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
                    try {
                        const srcFolderRel = (msg.sourceFolder || "").replace(/^\/+|\/+$/g, "") + "/";
                        const currentOrder = fileOrder.getOrder();
                        const srcFiles = currentOrder.filter(id => {
                            const f = (cachedScannedFiles || []).find(cf => cf.id === id);
                            return f && f.path.startsWith(srcFolderRel);
                        });

                        if (srcFiles.length > 0) {
                            const remainingOrder = currentOrder.filter(id => !srcFiles.includes(id));
                            let insertIdx = remainingOrder.length;

                            if (msg.targetFolder) {
                                const tgtFolderRel = (msg.targetFolder || "").replace(/^\/+|\/+$/g, "") + "/";
                                const tgtFirstIdx = remainingOrder.findIndex(id => {
                                    const f = (cachedScannedFiles || []).find(cf => cf.id === id);
                                    return f && f.path.startsWith(tgtFolderRel);
                                });
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
                }

                if (msg.command === "swapCardItems") {
                    try {
                        const fullOrder = fileOrder.getOrder();
                        const activeFiles = (cachedScannedFiles || []);

                        const getIdsForItem = (itemId: string): string[] => {
                            if (!itemId) return [];
                            if (itemId.startsWith("folder:")) {
                                const folderRel = itemId.substring(7);
                                return fullOrder.filter(id => {
                                    const f = activeFiles.find(cf => cf.id === id);
                                    return f && f.path.startsWith(folderRel);
                                });
                            } else {
                                return [itemId];
                            }
                        };

                        let cardOrder: string[] = [];
                        if (Array.isArray(msg.currentCardIds) && msg.currentCardIds.length > 0) {
                            cardOrder = [...msg.currentCardIds];
                        } else {
                            cardOrder = context.workspaceState.get<string[]>("thumbview.cardOrder") || [];
                        }
                        if (msg.sourceId && !cardOrder.includes(msg.sourceId)) {
                            cardOrder.push(msg.sourceId);
                        }

                        if (msg.targetIsEmpty) {
                            const maxCapacity = Math.max(1, msg.maxCapacity || cardOrder.length || 1);
                            cardOrder = reorderCardItems(cardOrder, msg.sourceId, true, null, msg.targetSlotIdx, maxCapacity);
                            await context.workspaceState.update("thumbview.cardOrder", cardOrder);

                            if (activePanel) {
                                updateLayoutFromCache(activePanel);
                            }
                            return;
                        }

                        const srcIds = getIdsForItem(msg.sourceId);
                        const tgtIds = getIdsForItem(msg.targetId);

                        if (srcIds.length > 0 && tgtIds.length > 0 && msg.sourceId !== msg.targetId) {
                            if (cardOrder.length > 0) {
                                cardOrder = reorderCardItems(cardOrder, msg.sourceId, false, msg.targetId, 0, cardOrder.length);
                                await context.workspaceState.update("thumbview.cardOrder", cardOrder);
                            }

                            const srcFirst = fullOrder.indexOf(srcIds[0]);
                            const tgtFirst = fullOrder.indexOf(tgtIds[0]);

                            if (srcFirst !== -1 && tgtFirst !== -1) {
                                const remaining = fullOrder.filter(id => !srcIds.includes(id));
                                const newTgtIdx = remaining.indexOf(tgtIds[0]);
                                if (newTgtIdx !== -1) {
                                    if (srcFirst < tgtFirst) {
                                        remaining.splice(newTgtIdx + tgtIds.length, 0, ...srcIds);
                                    } else {
                                        remaining.splice(newTgtIdx, 0, ...srcIds);
                                    }
                                    fileOrder.setOrder(remaining);
                                    if (activePanel) {
                                        updateLayoutFromCache(activePanel);
                                    }
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to swap items: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "expandSpace") {
                    try {
                        const curCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
                        const curRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
                        await context.workspaceState.update("thumbview.extraCols", curCols + 1);
                        await context.workspaceState.update("thumbview.extraRows", curRows + 1);
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
                        const curCols = context.workspaceState.get<number>("thumbview.extraCols") || 0;
                        const curRows = context.workspaceState.get<number>("thumbview.extraRows") || 0;
                        await context.workspaceState.update("thumbview.extraCols", Math.max(0, curCols - 1));
                        await context.workspaceState.update("thumbview.extraRows", Math.max(0, curRows - 1));
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
                        await vscode.commands.executeCommand("thumbview.reflow");
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
                if (e.webviewPanel.visible && e.webviewPanel.active) {
                    if (fullscreenActive && vscode.window.tabGroups.all.length > 1) {
                        // User dragged the tab into a new split, breaking zen mode layout. Close gracefully.
                        panel.dispose();
                        return;
                    }
                    const activeUri = lastActiveTextEditor?.document.uri.toString() || null;
                    panel.webview.postMessage({
                        command: "activeFile",
                        uri: activeUri
                    });
                    sendOpenState();
                } else if (!e.webviewPanel.visible && fullscreenActive) {
                    // Exit only when Thumbview is truly backgrounded — an inactive
                    // but still visible panel is just a focus shift, not leaving
                    exitFullscreen();
                }
            });

            panel.onDidDispose(async () => {
                if (activePanel === panel) {
                    activePanel = undefined;
                }
                await unmaximizeIfSplits();
                if (thumbviewEnteredZenMode) {
                    thumbviewEnteredZenMode = false;
                    await exitFullscreen();
                }
            });
        }
    );

    context.subscriptions.push(disposable);

    const reflowDisposable = vscode.commands.registerCommand("thumbview.reflow", async () => {
        const files = await scanRepository(getIgnoreState(), persistIgnoreState);
        fileOrder.reflow(files.map(f => f.id));
        await context.workspaceState.update("thumbview.seenFiles", fileOrder.getOrder());
        await context.workspaceState.update("thumbview.spanningAllocations", undefined);
        await context.workspaceState.update("thumbview.spanningRows", undefined);
        await context.workspaceState.update("thumbview.cardOrder", undefined);
        await context.workspaceState.update("thumbview.folderOrders", undefined);
        await context.workspaceState.update("thumbview.extraCols", undefined);
        await context.workspaceState.update("thumbview.extraRows", undefined);
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

    try {
        const keybindingWatcher = vscode.workspace.createFileSystemWatcher("**/keybindings.json");
        const onKbChange = () => {
            if (activePanel) {
                updateLayoutFromCache(activePanel);
            }
        };
        keybindingWatcher.onDidChange(onKbChange);
        keybindingWatcher.onDidCreate(onKbChange);
        context.subscriptions.push(keybindingWatcher);
    } catch {
    }

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
        if (!panel) {
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
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${labelStr}?`,
            { modal: true },
            "Move to Trash",
            "Delete Permanently"
        );

        if (confirm === "Move to Trash" || confirm === "Delete Permanently") {
            const useTrash = confirm === "Move to Trash";
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
        if ((e.affectsConfiguration("thumbview.layoutMode") || e.affectsConfiguration("thumbview.renderMediaThumbnails") || e.affectsConfiguration("thumbview.minCellWidth") || e.affectsConfiguration("thumbview.minCellHeight")) && activePanel) {
            refreshThumbview(activePanel);
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
    const triggerUpdate = () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(async () => {
            clearScanCache();
            await getAllWorkspaceRelativePaths().catch(() => {});
            refreshProviders();
            if (activePanel) {
                await refreshThumbview(activePanel);
            }
        }, 200);
    };

    watcher.onDidCreate(() => triggerUpdate());
    watcher.onDidDelete(() => triggerUpdate());
    watcher.onDidChange(() => triggerUpdate());

    const docChangeDisposable = vscode.workspace.onDidChangeTextDocument(e => {
        updateDocumentInCache(e.document);
        if (activePanel) {
            updateLayoutFromCache(activePanel);
        }
    });
    context.subscriptions.push(docChangeDisposable);

    const docSaveDisposable = vscode.workspace.onDidSaveTextDocument(doc => {
        updateDocumentInCache(doc);
        fetchWorkspaceGitDiff().then(() => {
            if (activePanel) {
                updateLayoutFromCache(activePanel);
            }
        }).catch(() => {});
        triggerUpdate();
    });
    context.subscriptions.push(docSaveDisposable);

    let diagDebounceTimer: NodeJS.Timeout | undefined;
    const diagDisposable = vscode.languages.onDidChangeDiagnostics(() => {
        if (diagDebounceTimer) {
            clearTimeout(diagDebounceTimer);
        }
        diagDebounceTimer = setTimeout(() => {
            if (activePanel) {
                updateLayoutFromCache(activePanel);
            }
        }, 100);
    });
    context.subscriptions.push(diagDisposable);

    context.subscriptions.push(watcher);
}

export function deactivate() { }

// Builds the webview's HTML shell. media/overview.js is loaded via a nonce'd <script>
// tag under a strict CSP (script-src limited to that nonce) so no inline/remote script
// can run in the panel — see getNonce() below.
function getHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    openKeybindingLabel: string = "F4"
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

    <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval' ${webview.cspSource}; worker-src blob: data: ${webview.cspSource}; connect-src ${webview.cspSource} blob: data:;"
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
            background: linear-gradient(90deg, var(--tv-accent-inspect, #785ef0) 0%, var(--tv-accent-search, #dc267f) 50%, var(--tv-accent-recency, #fe6100) 100%);
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

        .folder-name-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .path-sep {
            opacity: 0.35;
            margin: 0 1px;
        }

        .pattern-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
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

        /* Clean Desktop Toggle Control with Accent */
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
    <div id="canvas-container">
        <canvas id="map"></canvas>
        <div id="hover-tooltip"></div>
        <div id="context-menu"></div>
        
        <div id="folders-popover" class="menu-popover" style="display: none; width: 720px; max-width: 94vw; height: 560px; max-height: 82vh;">
            <div class="popover-header">
                <div class="popover-header-title">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" style="opacity:0.9;"><path d="M1.75 3.75C1.75 3.06 2.31 2.5 3 2.5H6.05C6.46 2.5 6.84 2.69 7.09 3.01L7.91 4.09C8.16 4.41 8.54 4.6 8.95 4.6H13C13.69 4.6 14.25 5.16 14.25 5.85V12.4C14.25 13.09 13.69 13.65 13 13.65H3C2.31 13.65 1.75 13.09 1.75 12.4V3.75Z" fill="currentColor" fill-opacity="0.08"/></svg>
                    <span>Folders &amp; Ignored Items</span>
                </div>
                <button class="popover-close" id="close-folders-popover" title="Close (Esc)">
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

        <div id="actions-modal" class="menu-modal">
            <div class="modal-header">
                <div class="modal-header-title">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.9;"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.7 1.3-2-.8-.9-2 1.3-.7-.2zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
                    <span>Settings &amp; Shortcuts</span>
                </div>
                <button class="modal-close" id="close-modal" title="Close (Esc)">
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
                            <div class="setting-name">Media Thumbnails</div>
                            <div class="setting-desc">Render image and PDF page 1 previews directly inside thumbnail tiles</div>
                        </div>
                        <label class="toggle-control">
                            <input type="checkbox" id="media-thumbnails-toggle" checked>
                            <span class="toggle-track">
                                <span class="toggle-thumb"></span>
                            </span>
                        </label>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Grid Space</div>
                            <div class="setting-desc">Add or remove empty margin rows and columns around the grid</div>
                        </div>
                        <div style="display: flex; gap: 6px;">
                            <button id="expand-grid-btn" class="action-trigger-btn">+ Expand Space</button>
                            <button id="reduce-grid-btn" class="action-trigger-btn">− Reduce Space</button>
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
            <div class="search-container">
                <input type="text" id="search-input" class="search-input" title="Begin typing with the Thumbview open to Search" placeholder="Search files (e.g. auth)...">
                <button id="search-match-case" class="search-option-btn" title="Match Case (${isMac ? "⌥C" : "Alt+C"})">Aa</button>
                <button id="search-match-word" class="search-option-btn" title="Match Whole Word (${isMac ? "⌥W" : "Alt+W"})">[ab]</button>
                <button id="search-use-regex" class="search-option-btn" title="Use Regular Expression (${isMac ? "⌥X" : "Alt+X"})">.*</button>
                <button id="clear-search" class="search-option-btn" title="Clear Search (${isMac ? "⌘⌫" : "Ctrl+Backspace"})" style="display: none;">&times;</button>
            </div>
            <div id="breadcrumbs" class="breadcrumb-container" style="display: none;">
                <span class="breadcrumb-item" id="breadcrumb-root">root</span>
            </div>
            <div class="top-bar-actions">
                <button id="folders-btn" class="toolbar-btn" title="Folders &amp; Ignored">
                    <svg class="toolbar-btn-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.75 3.75C1.75 3.06 2.31 2.5 3 2.5H6.05C6.46 2.5 6.84 2.69 7.09 3.01L7.91 4.09C8.16 4.41 8.54 4.6 8.95 4.6H13C13.69 4.6 14.25 5.16 14.25 5.85V12.4C14.25 13.09 13.69 13.65 13 13.65H3C2.31 13.65 1.75 13.09 1.75 12.4V3.75Z" fill="currentColor" fill-opacity="0.1"/></svg>
                    <span>Folders &amp; Ignored</span>
                </button>
                <button id="actions-btn" class="toolbar-btn" title="Settings &amp; Shortcuts">
                    <svg class="toolbar-btn-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.7 1.3-2-.8-.9-2 1.3-.7-.2zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
                    <span>Settings</span>
                </button>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">
        window.PDF_WORKER_URI = "${pdfWorkerUri}";
    </script>
    <script nonce="${nonce}" src="${pdfJsUri}"></script>
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