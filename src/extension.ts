import * as vscode from "vscode";
import { scanRepository, ScanIgnoreState } from "./scanner";
import { buildStableGrid } from "./layout";
import { buildSpanningGrid } from "./spanning_layout";
import { PersistentFileOrder } from "./state";
import { IgnoreTreeDataProvider, IgnoreTreeItem } from "./ignoreProvider";
import { DirectoryTreeDataProvider, DirectoryTreeItem } from "./directoryProvider";

import * as fs from "fs";
import * as path from "path";

export async function activate(context: vscode.ExtensionContext) {
    console.log("REPOMAP EXTENSION ACTIVATED");

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

    // Auto-populate ignorePatterns with workspace .gitignore rules once initialized
    if (workspaceFolders && workspaceFolders.length > 0) {
        const gitignorePath = path.join(workspaceFolders[0].uri.fsPath, ".gitignore");
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, "utf-8");
                const gitignoreRules = content
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith("#"));

                const { ignorePatterns, autoIgnoreExclusions } = getIgnoreState();
                const exclusionSet = new Set(autoIgnoreExclusions.map(e => e.trim().replace(/^\/+|\/+$/g, "")));
                const isExcluded = (pat: string) => {
                    const clean = pat.trim().replace(/^\/+|\/+$/g, "");
                    return exclusionSet.has(clean) || autoIgnoreExclusions.includes(pat);
                };

                const updatedIgnored = [...ignorePatterns];
                let changed = false;

                for (const rule of gitignoreRules) {
                    if (!updatedIgnored.includes(rule) && !isExcluded(rule)) {
                        updatedIgnored.push(rule);
                        changed = true;
                    }
                }

                if (changed) {
                    await persistIgnoreState({ ignorePatterns: updatedIgnored, autoIgnoreExclusions });
                }
            } catch {
            }
        }
    }

    const fileOrder = new PersistentFileOrder();
    const savedOrder = context.workspaceState.get<string[]>("repomap.seenFiles");
    if (savedOrder) {
        fileOrder.update(savedOrder);
    }

    const cursorLocations: { [uri: string]: number } = {};

    let lastActiveTextEditor: vscode.TextEditor | undefined;
    let activePanel: vscode.WebviewPanel | undefined;

    // Reads the user setting fresh each call (rather than caching) so a config change
    // picked up by the onDidChangeConfiguration listener below is always honored.
    const getLayoutMode = (): "uniform_grid" | "spanning_grid" => {
        const config = vscode.workspace.getConfiguration("thumbview");
        const mode = config.get<string>("layoutMode");
        return mode === "uniform_grid" ? "uniform_grid" : "spanning_grid";
    };

    // Four progressively-fainter pink decoration types used to fade a "jump" search
    // match out over ~2s (see the "jump" message handler below) instead of an abrupt
    // on/off highlight — VS Code decorations don't support CSS transitions, so the
    // fade is faked by swapping between discrete opacity steps on a timer.
    const searchFlashSteps = [
        vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(236, 72, 153, 0.35)",
            border: "1px dashed #ec4899",
            overviewRulerColor: "#ec4899",
            overviewRulerLane: vscode.OverviewRulerLane.Full
        }),
        vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(236, 72, 153, 0.22)",
            border: "1px dashed rgba(236, 72, 153, 0.6)",
            overviewRulerColor: "rgba(236, 72, 153, 0.6)",
            overviewRulerLane: vscode.OverviewRulerLane.Full
        }),
        vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(236, 72, 153, 0.12)",
            border: "1px dashed rgba(236, 72, 153, 0.3)",
            overviewRulerColor: "rgba(236, 72, 153, 0.3)",
            overviewRulerLane: vscode.OverviewRulerLane.Full
        }),
        vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: "rgba(236, 72, 153, 0.05)",
            border: "1px dashed rgba(236, 72, 153, 0.15)",
            overviewRulerColor: "rgba(236, 72, 153, 0.15)",
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
            const activeUri = vscode.window.activeTextEditor?.document.uri.toString() || null;
            activePanel.webview.postMessage({
                command: "openState",
                activeFileUri: activeUri,
                openFiles: getOpenTabUris(),
                viewLocations
            });
        }
    };

    const getOpenKeybindingLabel = (): string => {
        try {
            // Check package.json default or fallback
            return "F4";
        } catch {
            return "F4";
        }
    };

    const refreshRepositoryMap = async (panel: vscode.WebviewPanel) => {
        try {
            panel.webview.postMessage({
                command: "status",
                text: "Refreshing repository map...",
                clearData: true
            });

            const files = await scanRepository(getIgnoreState(), persistIgnoreState);

            fileOrder.update(files.map(f => f.id));
            await context.workspaceState.update("repomap.seenFiles", fileOrder.getOrder());

            const order = fileOrder.getOrder();
            const mode = getLayoutMode();
            const config = vscode.workspace.getConfiguration("thumbview");
            const renderMediaThumbnails = config.get<boolean>("renderMediaThumbnails") ?? true;
            const minCellWidth = config.get<number>("minCellWidth") ?? 32;
            const minCellHeight = config.get<number>("minCellHeight") ?? 28;
            const openKeybinding = getOpenKeybindingLabel();
            const filesWithWebviewUris = files.map(file => {
                if ((file.isImage || file.isPdf) && file.mediaUri) {
                    try {
                        const webviewUri = panel.webview.asWebviewUri(vscode.Uri.parse(file.uri)).toString();
                        return { ...file, mediaUri: webviewUri };
                    } catch {
                        return file;
                    }
                }
                return file;
            });

            if (mode === "spanning_grid") {
                // Allocations/rows are persisted so a file's cell count and the grid's
                // row count don't get recomputed (and reshuffle everyone else's slot)
                // on every rescan — see spanning_layout.ts's buildSpanningGrid doc.
                const savedAllocations = context.workspaceState.get<{ [id: string]: number }>("repomap.spanningAllocations") || {};
                const savedRows = context.workspaceState.get<number | null>("repomap.spanningRows") || null;

                const layout = buildSpanningGrid(filesWithWebviewUris, order, savedAllocations, savedRows);

                await context.workspaceState.update("repomap.spanningAllocations", layout.allocations);
                await context.workspaceState.update("repomap.spanningRows", layout.rows);

                const filesWithSlots = layout.placements.map(p => ({
                    ...p.file,
                    slot: [p.col, p.row],
                    nCells: p.nCells,
                    slots: p.slots
                }));

                // Compute tight bounding box of occupied cells so the webview
                // doesn't waste space on empty edge rows/columns from stale order
                let spMaxCol = 0, spMaxRow = 0;
                for (const p of layout.placements) {
                    spMaxCol = Math.max(spMaxCol, p.col);
                    for (const s of p.slots) {
                        spMaxRow = Math.max(spMaxRow, s[1]);
                    }
                }

                panel.webview.postMessage({
                    command: "data",
                    mode: "spanning_grid",
                    renderMediaThumbnails,
                    minCellWidth,
                    minCellHeight,
                    openKeybinding,
                    files: filesWithSlots,
                    layout: {
                        cols: Math.max(1, spMaxCol + 1),
                        rows: Math.max(1, spMaxRow + 1)
                    }
                });
            } else {
                const layout = buildStableGrid(order.length);

                const filesWithSlots = filesWithWebviewUris.map(file => ({
                    ...file,
                    slot: layout.slots[order.indexOf(file.id)],
                    nCells: 1,
                    slots: [layout.slots[order.indexOf(file.id)]]
                }));

                // Compute tight bounding box of occupied cells so the webview
                // doesn't waste space on empty edge rows/columns from stale order
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
                    renderMediaThumbnails,
                    minCellWidth,
                    minCellHeight,
                    openKeybinding,
                    files: filesWithSlots,
                    layout: {
                        cols: Math.max(1, ugMaxCol + 1),
                        rows: Math.max(1, ugMaxRow + 1)
                    }
                });
            }

            // Send open files list & viewport ranges
            panel.webview.postMessage({
                command: "openState",
                openFiles: getOpenTabUris(),
                viewLocations
            });

            // Send active editor file URI
            if (vscode.window.activeTextEditor) {
                panel.webview.postMessage({
                    command: "activeFile",
                    uri: vscode.window.activeTextEditor.document.uri.toString()
                });
            }
        } catch (err: any) {
            console.error("REPOMAP REFRESH ERROR:", err);
            panel.webview.postMessage({
                command: "status",
                text: `Error: ${err?.message ?? String(err)}`
            });
        }
    };

    let isThumbviewMaximized = false;

    const maximizeThumbview = async () => {
        if (vscode.window.tabGroups.all.length > 1) {
            try {
                await vscode.commands.executeCommand("workbench.action.minimizeOtherEditors");
                isThumbviewMaximized = true;
            } catch {
            }
        }
    };

    const restoreSplitLayout = async () => {
        if (isThumbviewMaximized) {
            isThumbviewMaximized = false;
            try {
                await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
            } catch {
            }
        }
    };

    const disposable = vscode.commands.registerCommand(
        "thumbview.open",
        async () => {
            console.log("THUMBVIEW COMMAND EXECUTED");

            if (activePanel) {
                if (activePanel.active) {
                    restoreSplitLayout();
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
                } else {
                    activePanel.reveal(vscode.ViewColumn.Active, false);
                    sendOpenState();
                    activePanel.webview.postMessage({ command: "focusWebview" });
                    maximizeThumbview();
                    return;
                }
            }

            vscode.window.showInformationMessage("Thumbview opening...");

            const panel = vscode.window.createWebviewPanel(
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
            await maximizeThumbview();

            panel.webview.html = getHtml(panel.webview, context, getOpenKeybindingLabel());

            panel.webview.onDidReceiveMessage(async msg => {
                console.log("REPOMAP WEBVIEW MESSAGE:", msg);

                if (msg.command === "ready") {
                    refreshRepositoryMap(panel);
                }

                if (msg.command === "focusWindow") {
                    if (activePanel && !activePanel.active) {
                        activePanel.reveal(undefined, true);
                    }
                }

                if (msg.command === "switchTab") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        // PDFs: skip openTextDocument (which shows raw binary metadata)
                        // and go straight to vscode.open so the user's PDF viewer extension handles it
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
                        let doc: vscode.TextDocument;
                        try {
                            doc = await vscode.workspace.openTextDocument(uri);
                        } catch {
                            // Binary/media file fallback
                            await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
                            return;
                        }

                        const editor = await vscode.window.showTextDocument(doc, { preview: false });

                        const safeLine = Math.max(
                            0,
                            Math.min(Number(msg.line) || 0, doc.lineCount - 1)
                        );
                        const pos = new vscode.Position(safeLine, 0);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(
                            new vscode.Range(pos, pos),
                            vscode.TextEditorRevealType.InCenter
                        );

                        // Flash all matching lines pink in the document and fade away
                        const query = (msg.query || "").trim().toLowerCase();
                        if (query) {
                            const matchingRanges: vscode.Range[] = [];
                            for (let i = 0; i < doc.lineCount; i++) {
                                if (doc.lineAt(i).text.toLowerCase().includes(query)) {
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
                                    refreshRepositoryMap(activePanel);
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
                                refreshRepositoryMap(activePanel);
                            }
                        } else if (confirm === "Delete Permanently") {
                            await vscode.workspace.fs.delete(uri, { useTrash: false });
                            if (activePanel) {
                                refreshRepositoryMap(activePanel);
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to delete file: ${err?.message ?? String(err)}`);
                    }
                }

                if (msg.command === "ignoreFile") {
                    try {
                        const relPath = msg.path;
                        if (relPath) {
                            const state = getIgnoreState();
                            if (!state.ignorePatterns.includes(relPath)) {
                                await persistIgnoreState({ ...state, ignorePatterns: [...state.ignorePatterns, relPath] });
                                vscode.window.showInformationMessage(`Added '${relPath}' to Thumbview ignore list.`);
                            }
                            refreshProviders();
                            if (activePanel) {
                                refreshRepositoryMap(activePanel);
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
                    try {
                        await vscode.commands.executeCommand("filesExplorer.copy", uri);
                    } catch (err: any) {
                        // Fallback to clipboard path if native explorer command fails
                        await vscode.env.clipboard.writeText(uri.fsPath);
                        vscode.window.showInformationMessage("Copied file path to clipboard.");
                    }
                }

                if (msg.command === "cutFile") {
                    try {
                        const uri = vscode.Uri.parse(msg.uri);
                        await vscode.commands.executeCommand("filesExplorer.cut", uri);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Failed to cut file: ${err?.message ?? String(err)}`);
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
            });

            panel.onDidChangeViewState(e => {
                if (e.webviewPanel.visible && e.webviewPanel.active) {
                    const activeUri = vscode.window.activeTextEditor?.document.uri.toString() || null;
                    panel.webview.postMessage({
                        command: "activeFile",
                        uri: activeUri
                    });
                    sendOpenState();
                    maximizeThumbview();
                } else if (!e.webviewPanel.active) {
                    restoreSplitLayout();
                }
            });

            panel.onDidDispose(async () => {
                if (activePanel === panel) {
                    activePanel = undefined;
                }
                await restoreSplitLayout();
            });
        }
    );

    context.subscriptions.push(disposable);

    const reflowDisposable = vscode.commands.registerCommand("thumbview.reflow", async () => {
        const files = await scanRepository(getIgnoreState(), persistIgnoreState);
        fileOrder.reflow(files.map(f => f.id));
        await context.workspaceState.update("repomap.seenFiles", fileOrder.getOrder());
        await context.workspaceState.update("repomap.spanningAllocations", undefined);
        await context.workspaceState.update("repomap.spanningRows", undefined);

        if (activePanel) {
            refreshRepositoryMap(activePanel);
        } else {
            vscode.commands.executeCommand("thumbview.open");
        }
        vscode.window.showInformationMessage("Thumbview layout reflowed and gaps filled.");
    });
    context.subscriptions.push(reflowDisposable);

    const setUniformGridDisposable = vscode.commands.registerCommand("thumbview.setUniformGrid", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("layoutMode", "uniform_grid", vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("Thumbview Layout set to Uniform Grid.");
        if (activePanel) {
            refreshRepositoryMap(activePanel);
        }
    });
    context.subscriptions.push(setUniformGridDisposable);

    const setSpanningGridDisposable = vscode.commands.registerCommand("thumbview.setSpanningGrid", async () => {
        const config = vscode.workspace.getConfiguration("thumbview");
        await config.update("layoutMode", "spanning_grid", vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("Thumbview Layout set to Spanning Grid.");
        if (activePanel) {
            refreshRepositoryMap(activePanel);
        }
    });
    context.subscriptions.push(setSpanningGridDisposable);

    const directoryProvider = new DirectoryTreeDataProvider(context);
    const directoryTreeView = vscode.window.createTreeView("thumbview-directories", {
        treeDataProvider: directoryProvider
    });
    context.subscriptions.push(directoryTreeView);

    const ignoreProvider = new IgnoreTreeDataProvider(context, () => {
        if (activePanel) {
            refreshRepositoryMap(activePanel);
        }
        directoryProvider.refresh();
    });
    const ignoreTreeView = vscode.window.createTreeView("thumbview-ignores", {
        treeDataProvider: ignoreProvider,
        canSelectMany: true
    });
    context.subscriptions.push(ignoreTreeView);

    const refreshProviders = () => {
        ignoreProvider.refresh();
        directoryProvider.refresh();
    };

    const ignoreDirectoryDisposable = vscode.commands.registerCommand("thumbview.ignoreDirectory", async (item?: DirectoryTreeItem) => {
        const folderPath = item?.folderPath;
        if (folderPath && !item?.isRoot) {
            const state = getIgnoreState();
            if (!state.ignorePatterns.includes(folderPath)) {
                await persistIgnoreState({ ...state, ignorePatterns: [...state.ignorePatterns, folderPath] });
                vscode.window.showInformationMessage(`Ignored directory '${folderPath}'. Check out 'Ignored Files & Directories' in the Thumbview sidebar to unignore it if you want.`);
                refreshProviders();
                if (activePanel) {
                    refreshRepositoryMap(activePanel);
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
            if (!state.ignorePatterns.includes(pattern)) {
                await persistIgnoreState({ ...state, ignorePatterns: [...state.ignorePatterns, pattern] });
                vscode.window.showInformationMessage(`Added '${pattern}' to ignore list.`);
                refreshProviders();
                if (activePanel) {
                    refreshRepositoryMap(activePanel);
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
            const updatedPatterns = state.ignorePatterns.filter(p => !patternsToRemove.includes(p));
            const updatedExclusions = [...state.autoIgnoreExclusions];
            for (const p of patternsToRemove) {
                if (!updatedExclusions.includes(p)) {
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
                refreshRepositoryMap(activePanel);
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
            if (activePanel) { refreshRepositoryMap(activePanel); }
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
            refreshRepositoryMap(activePanel);
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
            refreshProviders();
            if (activePanel) {
                refreshRepositoryMap(activePanel);
            }
        }, 200);
    };

    watcher.onDidCreate(() => triggerUpdate());
    watcher.onDidDelete(() => triggerUpdate());
    watcher.onDidChange(() => triggerUpdate());
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => triggerUpdate()));

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
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #18181c;
            color: #e1e1e6;
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
            background: rgba(30, 30, 34, 0.85);
            backdrop-filter: blur(8px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 6px 12px;
            font-size: 13px;
            pointer-events: auto;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            max-width: 60%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .breadcrumb-item {
            cursor: pointer;
            color: #a0a0a5;
            transition: color 0.15s ease;
        }

        .breadcrumb-item:hover {
            color: #ffffff;
        }

        .breadcrumb-separator {
            margin: 0 8px;
            color: #505055;
        }

        .search-container {
            background: rgba(30, 30, 34, 0.85);
            backdrop-filter: blur(8px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 2px;
            pointer-events: auto;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            display: flex;
            align-items: center;
        }

        .search-input {
            background: transparent;
            border: none;
            outline: none;
            color: #ffffff;
            font-size: 13px;
            padding: 6px 10px;
            width: 180px;
            transition: width 0.2s ease;
        }

        .search-input:focus {
            width: 240px;
        }

        .search-input::placeholder {
            color: #707075;
        }

        .clear-search-btn {
            background: transparent;
            border: none;
            outline: none;
            color: #707075;
            cursor: pointer;
            font-size: 14px;
            padding: 0 8px;
        }

        .clear-search-btn:hover {
            color: #ffffff;
        }

        /* Magnifying floating code tooltip */
        #hover-tooltip {
            position: absolute;
            display: none;
            background: rgba(20, 20, 25, 0.98);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(168, 85, 247, 0.6);
            border-radius: 8px;
            padding: 12px;
            box-shadow: 0 12px 36px rgba(0, 0, 0, 0.75);
            font-family: Consolas, "Liberation Mono", Courier, monospace;
            font-size: 13px;
            color: #d4d4d4;
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
            color: #ffffff;
            margin-bottom: 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.15);
            padding-bottom: 4px;
            font-size: 12px;
        }

        /* Right-click Context Menu */
        #context-menu {
            position: absolute;
            display: none;
            background: #252526;
            border: 1px solid #454545;
            border-radius: 6px;
            padding: 4px 0;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
            z-index: 2000;
            min-width: 180px;
            font-size: 12px;
            color: #cccccc;
        }

        .menu-item {
            padding: 6px 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            transition: background 0.1s ease;
        }

        .menu-item:hover {
            background: #04395e;
            color: #ffffff;
        }

        .menu-item.danger:hover {
            background: #900c3f;
            color: #ffffff;
        }

        .actions-btn {
            background: rgba(30, 30, 34, 0.85);
            backdrop-filter: blur(8px);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 8px;
            color: #e1e1e6;
            padding: 6px 12px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            pointer-events: auto;
            display: flex;
            align-items: center;
            gap: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            transition: all 0.15s ease;
            margin-left: auto;
        }

        .actions-btn:hover {
            background: rgba(168, 85, 247, 0.25);
            border-color: rgba(168, 85, 247, 0.6);
            color: #ffffff;
        }

        /* Glassmorphic Actions & Settings Modal */
        #actions-modal {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            display: none;
            width: 560px;
            max-width: 90vw;
            max-height: 82vh;
            overflow-y: auto;
            background: rgba(20, 20, 26, 0.96);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(168, 85, 247, 0.4);
            border-radius: 12px;
            padding: 20px 24px;
            box-shadow: 0 16px 48px rgba(0, 0, 0, 0.85);
            z-index: 3000;
            font-size: 13px;
            color: #d4d4d8;
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 15px;
            font-weight: 600;
            color: #ffffff;
            border-bottom: 1px solid rgba(255, 255, 255, 0.12);
            padding-bottom: 10px;
            margin-bottom: 16px;
            position: sticky;
            top: 0;
            background: rgba(20, 20, 26, 0.98);
            z-index: 10;
        }

        .modal-close {
            background: transparent;
            border: none;
            color: #a0a0a5;
            font-size: 18px;
            cursor: pointer;
        }

        .modal-close:hover { color: #ffffff; }

        .modal-section { margin-bottom: 20px; }
        .modal-section-title {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #a855f7;
            font-weight: 600;
            margin-bottom: 8px;
            border-bottom: 1px solid rgba(168, 85, 247, 0.2);
            padding-bottom: 4px;
        }

        .shortcut-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            font-size: 12px;
        }

        .kbd {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            padding: 2px 6px;
            font-family: monospace;
            font-size: 11px;
            color: #f472b6;
        }

        .modal-guide-list {
            font-size: 12px;
            line-height: 1.6;
            color: #cccccc;
            padding-left: 18px;
            margin: 4px 0 8px 0;
        }
    </style>
</head>
<body>
    <div id="canvas-container">
        <canvas id="map"></canvas>
        <div id="hover-tooltip"></div>
        <div id="context-menu"></div>
        <div id="actions-modal">
            <div class="modal-header">
                <span>⚙ Actions &amp; Setup</span>
                <button class="modal-close" id="close-modal">&times;</button>
            </div>
            <div class="modal-section">
                <div class="modal-section-title">Shortcuts</div>
                <div class="shortcut-row">
                    <span>Open / Focus</span>
                    <span>Press <span class="kbd" id="open-shortcut-label">${openKeybindingLabel}</span></span>
                </div>
                <div class="shortcut-row">
                    <span>Code Magnifier</span>
                    <span>Hold <span class="kbd">Left CTRL</span> + Hover</span>
                </div>
                <div class="shortcut-row">
                    <span>Jump to Line</span>
                    <span><span class="kbd">Left Click</span> Tile Line</span>
                </div>
                <div class="shortcut-row">
                    <span>Close Tab</span>
                    <span><span class="kbd">Middle Click</span> or <span class="kbd">×</span></span>
                </div>
                <div class="shortcut-row">
                    <span>Isolate Folder</span>
                    <span><span class="kbd">Left Click</span> Header / Tree Item</span>
                </div>
                <div class="shortcut-row">
                    <span>Context Menu</span>
                    <span><span class="kbd">Right Click</span> Tile</span>
                </div>
            </div>

            <div class="modal-section">
                <div class="modal-section-title">Setup &amp; Settings</div>
                <ul class="modal-guide-list">
                    <li><b>Layout</b>: <code>spanning_grid</code> (tall files span cells) or <code>uniform_grid</code>.</li>
                    <li><b>Small tiles</b> group into folder cards (<code>minCellWidth/Height</code>); use breadcrumbs to go back.</li>
                    <li><b>Auto-Ignore</b>: folders with &gt;30 files are hidden (<code>thumbview.autoIgnoreThreshold</code>).</li>
                </ul>
            </div>

            <div class="modal-section">
                <div class="modal-section-title">Ignoring &amp; Unignoring</div>
                <ul class="modal-guide-list">
                    <li><b>Ignore</b>: right-click folder → <b>Ignore Directory</b>, or tile → <b>Ignore in Thumbview</b>.</li>
                    <li><b>Unignore</b>: click 👁 on <code>(hidden)</code> folders, or right-click in <b>Ignored Files</b> panel.</li>
                    <li><b>Globs</b>: <code>+</code> in <b>Ignored Files</b> panel (e.g. <code>*.log</code>, <code>build/</code>). Saved per workspace.</li>
                </ul>
            </div>

            <div class="modal-section">
                <div class="modal-section-title">More Features</div>
                <ul class="modal-guide-list">
                    <li><b>Isolate Folder</b>: click a folder or tile header to dim the rest; <b>All Workspace Files (Root)</b> resets.</li>
                    <li><b>Root Files Only</b>: sidebar item to spotlight top-level files.</li>
                    <li><b>Instant Search</b>: top search bar highlights tokens across all tiles.</li>
                </ul>
            </div>
        </div>
        <div class="controls-overlay">
            <div class="search-container">
                <input type="text" id="search-input" class="search-input" placeholder="Search files (e.g. auth)...">
                <button id="clear-search" class="clear-search-btn" style="display: none;">&times;</button>
            </div>
            <div id="breadcrumbs" class="breadcrumb-container" style="display: none;">
                <span class="breadcrumb-item" id="breadcrumb-root">root</span>
            </div>
            <button id="actions-btn" class="actions-btn">⚙ Actions &amp; Shortcuts</button>
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