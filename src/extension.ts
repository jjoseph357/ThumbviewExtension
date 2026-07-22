import * as vscode from "vscode";
import { scanRepository } from "./scanner";
import { buildStableGrid } from "./layout";
import { buildSpanningGrid } from "./spanning_layout";
import { PersistentFileOrder } from "./state";
import { IgnoreTreeDataProvider, IgnoreTreeItem } from "./ignoreProvider";
import { DirectoryTreeDataProvider, DirectoryTreeItem } from "./directoryProvider";

export async function activate(context: vscode.ExtensionContext) {
    console.log("REPOMAP EXTENSION ACTIVATED");

    const fileOrder = new PersistentFileOrder();
    const savedOrder = context.workspaceState.get<string[]>("repomap.seenFiles");
    if (savedOrder) {
        fileOrder.update(savedOrder);
    }

    const cursorLocations: { [uri: string]: number } = {};

    let activePanel: vscode.WebviewPanel | undefined;

    // Reads the user setting fresh each call (rather than caching) so a config change
    // picked up by the onDidChangeConfiguration listener below is always honored.
    const getLayoutMode = (): "uniform_grid" | "spanning_grid" => {
        const config = vscode.workspace.getConfiguration("thumbview");
        const mode = config.get<string>("layoutMode");
        return mode === "spanning_grid" ? "spanning_grid" : "uniform_grid";
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
                if (tab.input instanceof vscode.TabInputText) {
                    uris.add(tab.input.uri.toString());
                }
            }
        }
        return Array.from(uris);
    };

    const sendOpenState = () => {
        updateVisibleRanges();
        if (activePanel) {
            activePanel.webview.postMessage({
                command: "openState",
                openFiles: getOpenTabUris(),
                viewLocations
            });
        }
    };

    const refreshRepositoryMap = async (panel: vscode.WebviewPanel) => {
        try {
            panel.webview.postMessage({
                command: "status",
                text: "Refreshing repository map..."
            });

            const files = await scanRepository();

            fileOrder.update(files.map(f => f.id));
            await context.workspaceState.update("repomap.seenFiles", fileOrder.getOrder());

            const order = fileOrder.getOrder();
            const mode = getLayoutMode();

            if (mode === "spanning_grid") {
                // Allocations/rows are persisted so a file's cell count and the grid's
                // row count don't get recomputed (and reshuffle everyone else's slot)
                // on every rescan — see spanning_layout.ts's buildSpanningGrid doc.
                const savedAllocations = context.workspaceState.get<{ [id: string]: number }>("repomap.spanningAllocations") || {};
                const savedRows = context.workspaceState.get<number | null>("repomap.spanningRows") || null;

                const layout = buildSpanningGrid(files, order, savedAllocations, savedRows);

                await context.workspaceState.update("repomap.spanningAllocations", layout.allocations);
                await context.workspaceState.update("repomap.spanningRows", layout.rows);

                const filesWithSlots = layout.placements.map(p => ({
                    ...p.file,
                    slot: [p.col, p.row],
                    nCells: p.nCells,
                    slots: p.slots
                }));

                panel.webview.postMessage({
                    command: "data",
                    mode: "spanning_grid",
                    files: filesWithSlots,
                    layout: {
                        cols: layout.cols,
                        rows: layout.rows
                    }
                });
            } else {
                const layout = buildStableGrid(order.length);

                const filesWithSlots = files.map(file => ({
                    ...file,
                    slot: layout.slots[order.indexOf(file.id)],
                    nCells: 1,
                    slots: [layout.slots[order.indexOf(file.id)]]
                }));

                panel.webview.postMessage({
                    command: "data",
                    mode: "uniform_grid",
                    files: filesWithSlots,
                    layout: {
                        cols: layout.cols,
                        rows: layout.rows
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

    const disposable = vscode.commands.registerCommand(
        "thumbview.open",
        async () => {
            console.log("THUMBVIEW COMMAND EXECUTED");

            if (activePanel) {
                activePanel.reveal(vscode.ViewColumn.Active);
                refreshRepositoryMap(activePanel);
                return;
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
                        vscode.Uri.joinPath(context.extensionUri, "media")
                    ]
                }
            );

            activePanel = panel;

            panel.webview.html = getHtml(panel.webview, context);

            panel.webview.onDidReceiveMessage(async msg => {
                console.log("REPOMAP WEBVIEW MESSAGE:", msg);

                if (msg.command === "ready") {
                    refreshRepositoryMap(panel);
                }

                if (msg.command === "switchTab") {
                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
                        await vscode.window.showTextDocument(doc, { preview: false });
                    } catch (err: any) {
                        console.error("THUMBVIEW SWITCH TAB ERROR:", err);
                    }
                }

                if (msg.command === "jump") {
                    try {
                        const doc = await vscode.workspace.openTextDocument(
                            vscode.Uri.parse(msg.uri)
                        );

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
                        for (const group of vscode.window.tabGroups.all) {
                            for (const tab of group.tabs) {
                                if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === targetUriStr) {
                                    await vscode.window.tabGroups.close(tab);
                                }
                            }
                        }
                    } catch (err: any) {
                        console.error("REPOMAP CLOSE ERROR:", err);
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
                            const config = vscode.workspace.getConfiguration("thumbview");
                            const current = config.get<string[]>("ignorePatterns") || [];
                            if (!current.includes(relPath)) {
                                await config.update("ignorePatterns", [...current, relPath], vscode.ConfigurationTarget.Global);
                                vscode.window.showInformationMessage(`Added '${relPath}' to Thumbview ignore list.`);
                            }
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

            panel.onDidDispose(() => {
                if (activePanel === panel) {
                    activePanel = undefined;
                }
            });
        }
    );

    context.subscriptions.push(disposable);

    const reflowDisposable = vscode.commands.registerCommand("thumbview.reflow", async () => {
        const files = await scanRepository();
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

    const ignoreProvider = new IgnoreTreeDataProvider();
    vscode.window.registerTreeDataProvider("thumbview-ignores", ignoreProvider);

    const directoryProvider = new DirectoryTreeDataProvider();
    vscode.window.registerTreeDataProvider("thumbview-directories", directoryProvider);

    const refreshProviders = () => {
        ignoreProvider.refresh();
        directoryProvider.refresh();
    };

    const addIgnoreDisposable = vscode.commands.registerCommand("thumbview.addIgnorePattern", async () => {
        const input = await vscode.window.showInputBox({
            prompt: "Enter file/directory relative path or pattern to ignore in Thumbview",
            placeHolder: "e.g. src/legacy/ or *.test.js"
        });
        if (input && input.trim()) {
            const config = vscode.workspace.getConfiguration("thumbview");
            const current = config.get<string[]>("ignorePatterns") || [];
            const pattern = input.trim();
            if (!current.includes(pattern)) {
                await config.update("ignorePatterns", [...current, pattern], vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Added '${pattern}' to ignore list.`);
                refreshProviders();
                if (activePanel) {
                    refreshRepositoryMap(activePanel);
                }
            }
        }
    });
    context.subscriptions.push(addIgnoreDisposable);

    const removeIgnoreDisposable = vscode.commands.registerCommand("thumbview.removeIgnorePattern", async (item?: IgnoreTreeItem) => {
        let pattern = item?.pattern;
        const config = vscode.workspace.getConfiguration("thumbview");
        const current = config.get<string[]>("ignorePatterns") || [];
        if (!pattern && current.length > 0) {
            pattern = await vscode.window.showQuickPick(current, { placeHolder: "Select pattern to remove" });
        }
        if (pattern) {
            const updated = current.filter(p => p !== pattern);
            await config.update("ignorePatterns", updated, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Removed '${pattern}' from ignore list.`);
            refreshProviders();
            if (activePanel) {
                refreshRepositoryMap(activePanel);
            }
        }
    });
    context.subscriptions.push(removeIgnoreDisposable);

    const focusFolderDisposable = vscode.commands.registerCommand("thumbview.focusFolder", async (folderPath?: string | DirectoryTreeItem) => {
        let targetFolder = typeof folderPath === "string" ? folderPath : folderPath?.folderPath || "";
        if (targetFolder === "(root files)/") {
            targetFolder = "";
        }
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

    const showAllFoldersDisposable = vscode.commands.registerCommand("thumbview.showAllFolders", async () => {
        vscode.commands.executeCommand("thumbview.focusFolder", "");
    });
    context.subscriptions.push(showAllFoldersDisposable);

    // Watch configuration changes
    const configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("thumbview.layoutMode") && activePanel) {
            refreshRepositoryMap(activePanel);
        }
        if (e.affectsConfiguration("thumbview.ignorePatterns")) {
            refreshProviders();
            if (activePanel) {
                refreshRepositoryMap(activePanel);
            }
        }
    });
    context.subscriptions.push(configDisposable);

    const updateVisibleRanges = (editor?: vscode.TextEditor | undefined) => {
        for (const visibleEditor of vscode.window.visibleTextEditors) {
            if (visibleEditor.visibleRanges.length > 0) {
                const uri = visibleEditor.document.uri.toString();
                const primaryRange = visibleEditor.visibleRanges[0];
                viewLocations[uri] = {
                    startLine: primaryRange.start.line,
                    endLine: primaryRange.end.line,
                    scrollLine: primaryRange.start.line
                };
            }
        }
        if (editor && editor.visibleRanges.length > 0) {
            const uri = editor.document.uri.toString();
            const primaryRange = editor.visibleRanges[0];
            viewLocations[uri] = {
                startLine: primaryRange.start.line,
                endLine: primaryRange.end.line,
                scrollLine: primaryRange.start.line
            };
        }
    };

    // Watch active editor changes
    const editorDisposable = vscode.window.onDidChangeActiveTextEditor(editor => {
        updateVisibleRanges(editor);
        if (activePanel) {
            const activeUri = editor?.document.uri.toString() || null;
            activePanel.webview.postMessage({
                command: "activeFile",
                uri: activeUri
            });
            sendOpenState();
        }
    });
    context.subscriptions.push(editorDisposable);

    // Watch text editor visible range changes (scroll/viewport movements)
    const visibleRangesDisposable = vscode.window.onDidChangeTextEditorVisibleRanges(event => {
        updateVisibleRanges(event.textEditor);
        sendOpenState();
    });
    context.subscriptions.push(visibleRangesDisposable);

    // Watch tab changes
    const tabDisposable = vscode.window.tabGroups.onDidChangeTabs(() => {
        sendOpenState();
    });
    context.subscriptions.push(tabDisposable);

    // Watch workspace changes. Debounced 800ms so a batch of file operations (e.g. a
    // git branch switch, or a build writing many files) triggers one rescan/postMessage
    // instead of flooding the webview with a message per file event.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    let debounceTimer: NodeJS.Timeout | undefined;
    const triggerUpdate = () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(async () => {
            if (activePanel) {
                refreshRepositoryMap(activePanel);
            }
        }, 500);
    };

    watcher.onDidCreate(() => triggerUpdate());
    watcher.onDidDelete(() => triggerUpdate());
    watcher.onDidChange(() => triggerUpdate());

    context.subscriptions.push(watcher);
}

export function deactivate() { }

// Builds the webview's HTML shell. media/overview.js is loaded via a nonce'd <script>
// tag under a strict CSP (script-src limited to that nonce) so no inline/remote script
// can run in the panel — see getNonce() below.
function getHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext
): string {
    const jsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "overview.js")
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">

    <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
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
            justify-content: space-between;
            align-items: center;
            pointer-events: none;
            gap: 16px;
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

        .menu-separator {
            height: 1px;
            background: #3c3c3c;
            margin: 4px 0;
        }
    </style>
</head>
<body>
    <div id="canvas-container">
        <canvas id="map"></canvas>
        <div id="hover-tooltip"></div>
        <div id="context-menu"></div>
        <div class="controls-overlay">
            <div id="breadcrumbs" class="breadcrumb-container" style="display: none;">
                <span class="breadcrumb-item" id="breadcrumb-root">root</span>
            </div>
            <div class="search-container">
                <input type="text" id="search-input" class="search-input" placeholder="Search files (e.g. auth)...">
                <button id="clear-search" class="clear-search-btn" style="display: none;">&times;</button>
            </div>
        </div>
    </div>
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