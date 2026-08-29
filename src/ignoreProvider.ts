import * as vscode from "vscode";

export class IgnoreTreeItem extends vscode.TreeItem {
    constructor(public readonly pattern: string) {
        super(pattern, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `Ignored pattern: ${pattern}`;
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

    getChildren(element?: IgnoreTreeItem): Thenable<IgnoreTreeItem[]> {
        if (element) {
            return Promise.resolve([]);
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

        return Promise.resolve(filteredPatterns.map(p => new IgnoreTreeItem(p)));
    }
}
