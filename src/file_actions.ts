// File and Explorer actions requested from Thumbview's tiles, folder cards, and empty space
// (open, reveal, rename, delete, copy/cut/paste, new file/folder, terminal, compare, tests,
// ignore). Returns a table of handlers by webview command name; extension.ts dispatches to it
// after isSafeWebviewMessage has checked every path and URI the message names.
import * as vscode from "vscode";
import { isSafeRelativePath } from "./message_guard";
import type { ScanIgnoreState } from "./scanner";

/** What the actions need from extension.ts. `host.activePanel` is read at call time (it changes). */
export interface FileActionHost {
    readonly activePanel: vscode.WebviewPanel | undefined;
    refreshThumbview(panel: vscode.WebviewPanel): Promise<void>;
    updateLayoutFromCache(panel: vscode.WebviewPanel): Promise<void>;
    getIgnoreState(): ScanIgnoreState;
    persistIgnoreState(state: ScanIgnoreState): Promise<void>;
    refreshProviders(): void;
}

/** Deletes always offer Move to Trash first; a permanent delete needs a second confirmation. */
export async function askDeleteMode(label: string): Promise<"trash" | "permanent" | undefined> {
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

// A name typed into New File / New Folder / Rename, resolved inside the workspace folder.
// Absolute paths and ".." segments are refused (message_guard's rule for webview paths).
function typedPathInside(folder: vscode.Uri, typed: string): vscode.Uri | undefined {
    if (!isSafeRelativePath(typed.trim())) {
        vscode.window.showErrorMessage(`"${typed}" is outside the workspace. Use a name or a path inside it.`);
        return undefined;
    }
    return vscode.Uri.joinPath(folder, typed.trim());
}

export type FileActionHandler = (msg: any) => Promise<void>;

export function createFileActions(host: FileActionHost): Record<string, FileActionHandler> {
    const { refreshThumbview, updateLayoutFromCache, getIgnoreState, persistIgnoreState, refreshProviders } = host;
    // The item Copy/Cut last selected, for Paste.
    let lastCopiedItem: { uri: vscode.Uri; isFolder: boolean; isCut: boolean } | null = null;

    return {
        openPreview: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                await vscode.commands.executeCommand("vscode.open", uri, { preview: true });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open preview: ${err?.message ?? String(err)}`);
            }
        },
        openToSide: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                await vscode.commands.executeCommand("vscode.open", uri, { viewColumn: vscode.ViewColumn.Beside });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open to side: ${err?.message ?? String(err)}`);
            }
        },
        revealInFiles: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                await vscode.commands.executeCommand("revealInExplorer", uri);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to reveal in explorer: ${err?.message ?? String(err)}`);
            }
        },
        renameFile: async (msg: any) => {
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
                        if (success && host.activePanel) {
                            refreshThumbview(host.activePanel);
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to rename file: ${err?.message ?? String(err)}`);
            }
        },
        deleteFile: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                const fileName = vscode.workspace.asRelativePath(uri);
                const mode = await askDeleteMode(`'${fileName}'`);
                if (mode) {
                    await vscode.workspace.fs.delete(uri, { useTrash: mode === "trash" });
                    if (host.activePanel) {
                        refreshThumbview(host.activePanel);
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to delete file: ${err?.message ?? String(err)}`);
            }
        },
        ignoreFile: async (msg: any) => {
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
                    if (host.activePanel) {
                        await updateLayoutFromCache(host.activePanel);
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to ignore file: ${err?.message ?? String(err)}`);
            }
        },
        copyPath: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                await vscode.env.clipboard.writeText(uri.fsPath);
                vscode.window.showInformationMessage("Copied path to clipboard.");
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to copy path: ${err?.message ?? String(err)}`);
            }
        },
        copyRelativePath: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                const rel = vscode.workspace.asRelativePath(uri);
                await vscode.env.clipboard.writeText(rel);
                vscode.window.showInformationMessage("Copied relative path to clipboard.");
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to copy relative path: ${err?.message ?? String(err)}`);
            }
        },
        copyFile: async (msg: any) => {
            const uri = vscode.Uri.parse(msg.uri);
            lastCopiedItem = { uri, isFolder: false, isCut: false };
            try {
                await vscode.commands.executeCommand("filesExplorer.copy", uri);
            } catch (err: any) {
                await vscode.env.clipboard.writeText(uri.fsPath);
            }
            vscode.window.showInformationMessage(`Copied '${vscode.workspace.asRelativePath(uri)}'.`);
        },
        cutFile: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                lastCopiedItem = { uri, isFolder: false, isCut: true };
                await vscode.commands.executeCommand("filesExplorer.cut", uri);
                vscode.window.showInformationMessage(`Cut '${vscode.workspace.asRelativePath(uri)}'.`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to cut file: ${err?.message ?? String(err)}`);
            }
        },
        newFile: async (msg: any) => {
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
                        if (host.activePanel) {
                            refreshThumbview(host.activePanel);
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to create file: ${err?.message ?? String(err)}`);
            }
        },
        newFolder: async (msg: any) => {
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
                        if (host.activePanel) {
                            refreshThumbview(host.activePanel);
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to create folder: ${err?.message ?? String(err)}`);
            }
        },
        copyFolder: async (msg: any) => {
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
        },
        cutFolder: async (msg: any) => {
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
        },
        copyFolderPath: async (msg: any) => {
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
        },
        copyFolderRelativePath: async (msg: any) => {
            try {
                const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                await vscode.env.clipboard.writeText(folderRel);
                vscode.window.showInformationMessage("Copied relative folder path to clipboard.");
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to copy relative path: ${err?.message ?? String(err)}`);
            }
        },
        renameFolder: async (msg: any) => {
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
                        if (success && host.activePanel) {
                            refreshThumbview(host.activePanel);
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to rename folder: ${err?.message ?? String(err)}`);
            }
        },
        deleteFolder: async (msg: any) => {
            try {
                const wsFolder = vscode.workspace.workspaceFolders?.[0];
                if (wsFolder) {
                    const folderRel = (msg.folderPath || "").replace(/^\/+|\/+$/g, "");
                    const folderUri = vscode.Uri.joinPath(wsFolder.uri, folderRel);
                    const mode = await askDeleteMode(`folder '${folderRel}' and all its contents`);
                    if (mode) {
                        await vscode.workspace.fs.delete(folderUri, { recursive: true, useTrash: mode === "trash" });
                        if (host.activePanel) {
                            refreshThumbview(host.activePanel);
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to delete folder: ${err?.message ?? String(err)}`);
            }
        },
        revealFolder: async (msg: any) => {
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
        },
        openFolderInTerminal: async (msg: any) => {
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
        },
        ignoreFolder: async (msg: any) => {
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
                    if (host.activePanel) {
                        await updateLayoutFromCache(host.activePanel);
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to ignore folder: ${err?.message ?? String(err)}`);
            }
        },
        moveFileToFolder: async (msg: any) => {
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
                            if (host.activePanel) {
                                refreshThumbview(host.activePanel);
                            }
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to move file: ${err?.message ?? String(err)}`);
            }
        },
        pasteItem: async (msg: any) => {
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
                        if (host.activePanel) {
                            refreshThumbview(host.activePanel);
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
                                if (host.activePanel) {
                                    refreshThumbview(host.activePanel);
                                }
                                return;
                            } catch {
                                // Not a valid path, continue
                            }
                        }
                        await vscode.commands.executeCommand("filesExplorer.paste");
                        if (host.activePanel) {
                            refreshThumbview(host.activePanel);
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to paste: ${err?.message ?? String(err)}`);
            }
        },
        selectForCompare: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                await vscode.commands.executeCommand("selectForCompare", uri);
                vscode.window.showInformationMessage(`Selected '${vscode.workspace.asRelativePath(uri)}' for compare.`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to select for compare: ${err?.message ?? String(err)}`);
            }
        },
        compareWithSelected: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                await vscode.commands.executeCommand("compareFiles", uri);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to compare: ${err?.message ?? String(err)}`);
            }
        },
        openContainingFolder: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                const folderUri = vscode.Uri.joinPath(uri, "..");
                await vscode.commands.executeCommand("revealFileInOS", folderUri);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open containing folder: ${err?.message ?? String(err)}`);
            }
        },
        openWith: async (msg: any) => {
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
        },
        openInTerminal: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                await vscode.commands.executeCommand("openInTerminal", uri);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open in integrated terminal: ${err?.message ?? String(err)}`);
            }
        },
        openTimeline: async (msg: any) => {
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
        },
        runTests: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                await vscode.commands.executeCommand("testing.runCurrentFile");
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to run tests: ${err?.message ?? String(err)}`);
            }
        },
        debugTests: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                await vscode.commands.executeCommand("testing.debugCurrentFile");
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to debug tests: ${err?.message ?? String(err)}`);
            }
        },
        coverageTests: async (msg: any) => {
            try {
                const uri = vscode.Uri.parse(msg.uri);
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
                await vscode.commands.executeCommand("testing.coverageCurrentFile");
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to run tests with coverage: ${err?.message ?? String(err)}`);
            }
        },
        moveFolderToFolder: async (msg: any) => {
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
                            if (host.activePanel) {
                                refreshThumbview(host.activePanel);
                            }
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to move folder: ${err?.message ?? String(err)}`);
            }
        },
    };
}
