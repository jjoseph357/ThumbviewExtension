"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const scanner_1 = require("./scanner");
const layout_1 = require("./layout");
const state_1 = require("./state");
async function activate(context) {
    console.log("REPOMAP EXTENSION ACTIVATED");
    const fileOrder = new state_1.PersistentFileOrder();
    const savedOrder = context.globalState.get("repomap.seenFiles");
    if (savedOrder) {
        fileOrder.update(savedOrder);
    }
    const cursorLocations = {};
    let activePanel;
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
    const getOpenTabUris = () => {
        const uris = new Set();
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
        if (activePanel) {
            activePanel.webview.postMessage({
                command: "openState",
                openFiles: getOpenTabUris(),
                cursorLocations
            });
        }
    };
    const refreshRepositoryMap = async (panel) => {
        try {
            panel.webview.postMessage({
                command: "status",
                text: "Refreshing repository map..."
            });
            const files = await (0, scanner_1.scanRepository)();
            fileOrder.update(files.map(f => f.id));
            await context.globalState.update("repomap.seenFiles", fileOrder.getOrder());
            const order = fileOrder.getOrder();
            const layout = (0, layout_1.buildStableGrid)(order.length);
            const filesWithSlots = files.map(file => ({
                ...file,
                slot: layout.slots[order.indexOf(file.id)]
            }));
            panel.webview.postMessage({
                command: "data",
                files: filesWithSlots,
                layout: {
                    cols: layout.cols,
                    rows: layout.rows
                }
            });
            // Send open files list & cursor positions
            panel.webview.postMessage({
                command: "openState",
                openFiles: getOpenTabUris(),
                cursorLocations
            });
            // Send active editor file URI
            if (vscode.window.activeTextEditor) {
                panel.webview.postMessage({
                    command: "activeFile",
                    uri: vscode.window.activeTextEditor.document.uri.toString()
                });
            }
        }
        catch (err) {
            console.error("REPOMAP REFRESH ERROR:", err);
            panel.webview.postMessage({
                command: "status",
                text: `Error: ${err?.message ?? String(err)}`
            });
        }
    };
    const disposable = vscode.commands.registerCommand("repomap.open", async () => {
        console.log("REPOMAP COMMAND EXECUTED");
        if (activePanel) {
            activePanel.reveal(vscode.ViewColumn.Active);
            refreshRepositoryMap(activePanel);
            return;
        }
        vscode.window.showInformationMessage("Repository Map opening...");
        const panel = vscode.window.createWebviewPanel("repomap", "Repository Map", vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, "media")
            ]
        });
        activePanel = panel;
        panel.webview.html = getHtml(panel.webview, context);
        panel.webview.onDidReceiveMessage(async (msg) => {
            console.log("REPOMAP WEBVIEW MESSAGE:", msg);
            if (msg.command === "ready") {
                refreshRepositoryMap(panel);
            }
            if (msg.command === "jump") {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(msg.uri));
                    const editor = await vscode.window.showTextDocument(doc);
                    const safeLine = Math.max(0, Math.min(Number(msg.line) || 0, doc.lineCount - 1));
                    const pos = new vscode.Position(safeLine, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    // Flash all matching lines pink in the document and fade away
                    const query = (msg.query || "").trim().toLowerCase();
                    if (query) {
                        const matchingRanges = [];
                        for (let i = 0; i < doc.lineCount; i++) {
                            if (doc.lineAt(i).text.toLowerCase().includes(query)) {
                                matchingRanges.push(new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, 0)));
                            }
                        }
                        if (matchingRanges.length > 0) {
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
                                    setTimeout(() => {
                                        if (editor && !editor.document.isClosed) {
                                            editor.setDecorations(searchFlashSteps[2], []);
                                            editor.setDecorations(searchFlashSteps[3], matchingRanges);
                                        }
                                    }, 1800);
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
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Repository Map jump failed: ${err?.message ?? String(err)}`);
                }
            }
        });
        panel.onDidDispose(() => {
            if (activePanel === panel) {
                activePanel = undefined;
            }
        });
    });
    context.subscriptions.push(disposable);
    // Watch active editor changes
    const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
        if (activePanel) {
            const activeUri = vscode.window.activeTextEditor?.document.uri.toString() || null;
            activePanel.webview.postMessage({
                command: "activeFile",
                uri: activeUri
            });
            sendOpenState();
        }
    });
    context.subscriptions.push(editorDisposable);
    // Watch cursor selection changes (debounced cursor line highlight)
    let cursorDebounce;
    const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(event => {
        const uri = event.textEditor.document.uri.toString();
        const line = event.selections[0].active.line;
        cursorLocations[uri] = line;
        if (cursorDebounce) {
            clearTimeout(cursorDebounce);
        }
        cursorDebounce = setTimeout(() => {
            sendOpenState();
        }, 150);
    });
    context.subscriptions.push(selectionDisposable);
    // Watch tab changes
    const tabDisposable = vscode.window.tabGroups.onDidChangeTabs(() => {
        sendOpenState();
    });
    context.subscriptions.push(tabDisposable);
    // Watch workspace changes
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    let debounceTimer;
    const triggerUpdate = () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(async () => {
            if (!activePanel) {
                return;
            }
            try {
                const files = await (0, scanner_1.scanRepository)();
                fileOrder.update(files.map(f => f.id));
                await context.globalState.update("repomap.seenFiles", fileOrder.getOrder());
                const order = fileOrder.getOrder();
                const layout = (0, layout_1.buildStableGrid)(order.length);
                const filesWithSlots = files.map(file => ({
                    ...file,
                    slot: layout.slots[order.indexOf(file.id)]
                }));
                activePanel.webview.postMessage({
                    command: "data",
                    files: filesWithSlots,
                    layout: {
                        cols: layout.cols,
                        rows: layout.rows
                    }
                });
                const activeUri = vscode.window.activeTextEditor?.document.uri.toString() || null;
                activePanel.webview.postMessage({
                    command: "activeFile",
                    uri: activeUri
                });
                sendOpenState();
            }
            catch (err) {
                console.error("REPOMAP WATCHER UPDATE ERROR:", err);
            }
        }, 800);
    };
    watcher.onDidCreate(() => triggerUpdate());
    watcher.onDidDelete(() => triggerUpdate());
    watcher.onDidChange(() => triggerUpdate());
    context.subscriptions.push(watcher);
}
function deactivate() { }
function getHtml(webview, context) {
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "overview.js"));
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
            font-size: 11px;
            color: #d4d4d4;
            pointer-events: none;
            z-index: 1000;
            max-width: 550px;
            line-height: 1.4;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-x: hidden;
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
    </style>
</head>
<body>
    <div id="canvas-container">
        <canvas id="map"></canvas>
        <div id="hover-tooltip"></div>
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
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let text = "";
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
//# sourceMappingURL=extension.js.map