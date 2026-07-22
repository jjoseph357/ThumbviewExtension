import * as vscode from "vscode";
import { scanRepository } from "./scanner";

export class DirectoryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly labelName: string,
        public readonly folderPath: string,
        public readonly fileCount: number,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly isRoot: boolean = false
    ) {
        super(labelName, collapsibleState);
        this.tooltip = isRoot
            ? "Show all workspace files"
            : `Folder: ${folderPath} (${fileCount} total files including subdirectories)`;
        this.description = isRoot ? "" : `${fileCount} file${fileCount === 1 ? "" : "s"}`;
        this.contextValue = "directoryItem";
        this.iconPath = new vscode.ThemeIcon(isRoot ? "root-folder" : "folder");
        this.command = {
            command: "thumbview.focusFolder",
            title: "Focus Directory",
            arguments: [isRoot ? "" : folderPath]
        };
    }
}

interface FolderNode {
    name: string;
    path: string;
    filesCount: number;
    children: Map<string, FolderNode>;
}

const DIRECTORY_MIME_TYPE = "application/vnd.code.tree.thumbview-directories";

export class DirectoryTreeDataProvider implements vscode.TreeDataProvider<DirectoryTreeItem>, vscode.TreeDragAndDropController<DirectoryTreeItem> {
    dropMimeTypes = [DIRECTORY_MIME_TYPE];
    dragMimeTypes = [DIRECTORY_MIME_TYPE];

    private _onDidChangeTreeData: vscode.EventEmitter<DirectoryTreeItem | undefined | void> = new vscode.EventEmitter<DirectoryTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<DirectoryTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    handleDrag(source: readonly DirectoryTreeItem[], treeDataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
        const payload = source.map(item => ({
            folderPath: item.folderPath,
            labelName: item.labelName
        }));
        treeDataTransfer.set(DIRECTORY_MIME_TYPE, new vscode.DataTransferItem(payload));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DirectoryTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DirectoryTreeItem): Promise<DirectoryTreeItem[]> {
        try {
            const files = await scanRepository();

            if (!element) {
                // Root level items
                const rootItem = new DirectoryTreeItem(
                    "All Workspace Files (Root)",
                    "",
                    files.length,
                    vscode.TreeItemCollapsibleState.None,
                    true
                );

                const topLevelFolders = this.buildFolderTree(files, "");
                return [rootItem, ...topLevelFolders];
            } else {
                return this.buildFolderTree(files, element.folderPath);
            }
        } catch {
            return [];
        }
    }

    private buildFolderTree(files: { path: string }[], parentFolderPath: string): DirectoryTreeItem[] {
        const directSubfolders = new Map<string, number>();

        for (const file of files) {
            if (file.path.startsWith(parentFolderPath)) {
                const relative = parentFolderPath ? file.path.slice(parentFolderPath.length) : file.path;
                const parts = relative.split("/").filter(Boolean);
                if (parts.length > 1) {
                    const subfolderName = parts[0];
                    const fullSubfolderPath = parentFolderPath ? `${parentFolderPath}${subfolderName}/` : `${subfolderName}/`;
                    directSubfolders.set(fullSubfolderPath, (directSubfolders.get(fullSubfolderPath) || 0) + 1);
                }
            }
        }

        const sortedPaths = Array.from(directSubfolders.keys()).sort();

        return sortedPaths.map(folderPath => {
            const folderName = folderPath.slice(0, -1).split("/").pop() || folderPath;
            const totalFileCount = directSubfolders.get(folderPath) || 0;

            // Check if this folder has nested subfolders
            const hasSubfolders = files.some(f => {
                if (f.path.startsWith(folderPath)) {
                    const subRel = f.path.slice(folderPath.length);
                    return subRel.includes("/");
                }
                return false;
            });

            return new DirectoryTreeItem(
                folderName,
                folderPath,
                totalFileCount,
                hasSubfolders ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                false
            );
        });
    }
}
