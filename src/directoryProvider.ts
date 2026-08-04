import * as vscode from "vscode";
import { scanRepository, ScanIgnoreState } from "./scanner";

function isFolderIgnored(folderPath: string, ignorePatterns: string[]): boolean {
    const cleanFolder = folderPath.trim().replace(/^\/+|\/+$/g, "");
    if (!cleanFolder) return false;
    for (const pattern of ignorePatterns) {
        const cleanPattern = pattern.trim().replace(/^\/+|\/+$/g, "");
        if (!cleanPattern) continue;
        if (cleanFolder === cleanPattern || cleanFolder.startsWith(cleanPattern + "/")) {
            return true;
        }
    }
    return false;
}

export class DirectoryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly labelName: string,
        public readonly folderPath: string,
        public readonly fileCount: number,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly isRoot: boolean = false,
        public readonly isIgnored: boolean = false
    ) {
        super(labelName, collapsibleState);

        this.tooltip = isRoot
            ? "Show all workspace files"
            : folderPath === "(root files)/"
                ? `Show only files in the root workspace folder (${fileCount} file${fileCount === 1 ? "" : "s"})`
                : isIgnored
                    ? `Folder: ${folderPath} (${fileCount} files - Hidden / Ignored in Thumbview)`
                    : `Folder: ${folderPath} (${fileCount} total files including subdirectories)`;

        this.description = isRoot
            ? ""
            : isIgnored
                ? `${fileCount} file${fileCount === 1 ? "" : "s"} (hidden)`
                : `${fileCount} file${fileCount === 1 ? "" : "s"}`;

        this.contextValue = isIgnored ? "ignoredDirectoryItem" : "directoryItem";

        this.iconPath = isRoot
            ? new vscode.ThemeIcon("root-folder")
            : folderPath === "(root files)/"
                ? new vscode.ThemeIcon("files")
                : isIgnored
                    ? new vscode.ThemeIcon("eye-closed", new vscode.ThemeColor("disabledForeground"))
                    : new vscode.ThemeIcon("folder");

        this.command = {
            command: "thumbview.focusFolder",
            title: "Focus Directory",
            arguments: [isRoot ? "" : folderPath]
        };
    }
}

export class DirectoryTreeDataProvider implements vscode.TreeDataProvider<DirectoryTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DirectoryTreeItem | undefined | void> = new vscode.EventEmitter<DirectoryTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<DirectoryTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DirectoryTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DirectoryTreeItem): Promise<DirectoryTreeItem[]> {
        try {
            const ignorePatterns = this.context.workspaceState.get<string[]>("thumbview.ignorePatterns") ?? [];
            const autoIgnoreExclusions = this.context.workspaceState.get<string[]>("thumbview.autoIgnoreExclusions") ?? [];

            const ignoreState: ScanIgnoreState = { ignorePatterns, autoIgnoreExclusions };
            const persistIgnore = async (updated: ScanIgnoreState) => {
                await this.context.workspaceState.update("thumbview.ignorePatterns", updated.ignorePatterns);
                await this.context.workspaceState.update("thumbview.autoIgnoreExclusions", updated.autoIgnoreExclusions);
            };

            const validFiles = await scanRepository(ignoreState, persistIgnore);
            const allFileUris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git}/**");
            const allFiles = allFileUris.map(u => ({ path: vscode.workspace.asRelativePath(u).replace(/\\/g, "/") }));

            if (!element) {
                // Root level items
                const rootItem = new DirectoryTreeItem(
                    "All Workspace Files (Root)",
                    "",
                    validFiles.length,
                    vscode.TreeItemCollapsibleState.None,
                    true,
                    false
                );

                const rootFilesOnly = validFiles.filter(f => !f.path.includes("/"));
                const rootOnlyItem = new DirectoryTreeItem(
                    "Root Directory Files Only",
                    "(root files)/",
                    rootFilesOnly.length,
                    vscode.TreeItemCollapsibleState.None,
                    false,
                    false
                );

                const topLevelFolders = this.buildFolderTree(allFiles, validFiles, "", ignorePatterns);
                return [rootItem, rootOnlyItem, ...topLevelFolders];
            } else {
                return this.buildFolderTree(allFiles, validFiles, element.folderPath, ignorePatterns);
            }
        } catch {
            return [];
        }
    }

    private buildFolderTree(
        allFiles: { path: string }[],
        validFiles: { path: string }[],
        parentFolderPath: string,
        ignorePatterns: string[]
    ): DirectoryTreeItem[] {
        const directSubfolders = new Map<string, { total: number; valid: number }>();

        for (const file of allFiles) {
            if (file.path.startsWith(parentFolderPath)) {
                const relative = parentFolderPath ? file.path.slice(parentFolderPath.length) : file.path;
                const parts = relative.split("/").filter(Boolean);
                if (parts.length > 1) {
                    const subfolderName = parts[0];
                    const fullSubfolderPath = parentFolderPath ? `${parentFolderPath}${subfolderName}/` : `${subfolderName}/`;
                    const current = directSubfolders.get(fullSubfolderPath) || { total: 0, valid: 0 };
                    current.total += 1;
                    directSubfolders.set(fullSubfolderPath, current);
                }
            }
        }

        for (const file of validFiles) {
            if (file.path.startsWith(parentFolderPath)) {
                const relative = parentFolderPath ? file.path.slice(parentFolderPath.length) : file.path;
                const parts = relative.split("/").filter(Boolean);
                if (parts.length > 1) {
                    const subfolderName = parts[0];
                    const fullSubfolderPath = parentFolderPath ? `${parentFolderPath}${subfolderName}/` : `${subfolderName}/`;
                    const current = directSubfolders.get(fullSubfolderPath);
                    if (current) {
                        current.valid += 1;
                    }
                }
            }
        }

        const sortedPaths = Array.from(directSubfolders.keys()).sort();

        return sortedPaths.map(folderPath => {
            const folderName = folderPath.slice(0, -1).split("/").pop() || folderPath;
            const counts = directSubfolders.get(folderPath) || { total: 0, valid: 0 };

            const isIgnored = isFolderIgnored(folderPath, ignorePatterns) || (counts.valid === 0 && counts.total > 0);

            // Check if this folder has nested subfolders
            const hasSubfolders = allFiles.some(f => {
                if (f.path.startsWith(folderPath)) {
                    const subRel = f.path.slice(folderPath.length);
                    return subRel.includes("/");
                }
                return false;
            });

            return new DirectoryTreeItem(
                folderName,
                folderPath,
                counts.total,
                hasSubfolders ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                false,
                isIgnored
            );
        });
    }
}
