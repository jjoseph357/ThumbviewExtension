import * as vscode from "vscode";

export class IgnoreTreeItem extends vscode.TreeItem {
    constructor(public readonly pattern: string) {
        super(pattern, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `Ignored pattern: ${pattern}`;
        this.contextValue = "ignoreItem";
        this.iconPath = new vscode.ThemeIcon("eye-closed");
    }
}

export class IgnoreTreeDataProvider implements vscode.TreeDataProvider<IgnoreTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<IgnoreTreeItem | undefined | void> = new vscode.EventEmitter<IgnoreTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<IgnoreTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private onPatternAdded?: () => void) {}

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
        const config = vscode.workspace.getConfiguration("thumbview");
        const patterns = config.get<string[]>("ignorePatterns") || [];
        return Promise.resolve(patterns.map(p => new IgnoreTreeItem(p)));
    }
}
