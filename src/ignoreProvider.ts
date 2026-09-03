import * as vscode from "vscode";
import { shouldIgnore } from "./scanner";

export class IgnoreTreeItem extends vscode.TreeItem {
    constructor(public readonly pattern: string, public readonly fileCount: number = 0) {
        super(pattern, vscode.TreeItemCollapsibleState.None);
        this.tooltip = fileCount > 0
            ? `Ignored pattern: ${pattern} (${fileCount} file${fileCount === 1 ? "" : "s"} ignored)`
            : `Ignored pattern: ${pattern}`;
        this.description = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
        this.contextValue = "ignoreItem";
        const isFolder = pattern.endsWith("/") || pattern === "(root files)/" || !pattern.includes(".");
        this.iconPath = isFolder ? new vscode.ThemeIcon("folder") : new vscode.ThemeIcon("file");
    }
}

export class IgnoreTreeDataProvider implements vscode.TreeDataProvider<IgnoreTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<IgnoreTreeItem | undefined | void> = new vscode.EventEmitter<IgnoreTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<IgnoreTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext, private onPatternAdded?: () => void) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: IgnoreTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: IgnoreTreeItem): Promise<IgnoreTreeItem[]> {
        if (element) {
            return [];
        }
        const patterns: string[] = this.context.workspaceState.get("thumbview.ignorePatterns") ?? [];
        
        // Filter out redundant child patterns whose parent directory is already ignored
        const filteredPatterns = patterns.filter(p => {
            const clean = p.trim().replace(/^\/+|\/+$/g, "");
            if (!clean) return false;
            const isChildOfOther = patterns.some(other => {
                const otherClean = other.trim().replace(/^\/+|\/+$/g, "");
                return otherClean && clean !== otherClean && clean.startsWith(otherClean + "/");
            });
            return !isChildOfOther;
        });

        try {
            const allFileUris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git}/**");
            const allFiles = allFileUris.map(u => vscode.workspace.asRelativePath(u).replace(/\\/g, "/"));
            return filteredPatterns.map(p => {
                const count = allFiles.filter(f => shouldIgnore(f, [p])).length;
                return new IgnoreTreeItem(p, count);
            });
        } catch {
            return filteredPatterns.map(p => new IgnoreTreeItem(p, 0));
        }
    }
}

