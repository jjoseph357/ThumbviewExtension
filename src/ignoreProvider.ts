import * as vscode from "vscode";

export class IgnoreTreeItem extends vscode.TreeItem {
    constructor(public readonly pattern: string) {
        super(pattern, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `Ignored pattern: ${pattern}`;
        this.contextValue = "ignoreItem";
        this.iconPath = new vscode.ThemeIcon("eye-closed");
    }
}

const DIRECTORY_MIME_TYPE = "application/vnd.code.tree.thumbview-directories";

export class IgnoreTreeDataProvider implements vscode.TreeDataProvider<IgnoreTreeItem>, vscode.TreeDragAndDropController<IgnoreTreeItem> {
    dropMimeTypes = [DIRECTORY_MIME_TYPE, "text/uri-list"];
    dragMimeTypes = [];

    private _onDidChangeTreeData: vscode.EventEmitter<IgnoreTreeItem | undefined | void> = new vscode.EventEmitter<IgnoreTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<IgnoreTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private onPatternAdded?: () => void) {}

    async handleDrop(target: IgnoreTreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        let sourceItems: any[] = [];
        const customItem = dataTransfer.get(DIRECTORY_MIME_TYPE);
        if (customItem) {
            if (Array.isArray(customItem.value)) {
                sourceItems = customItem.value;
            } else if (typeof customItem.value === "string") {
                try {
                    sourceItems = JSON.parse(customItem.value);
                } catch {
                }
            } else if (customItem.value) {
                sourceItems = [customItem.value];
            }
        }

        const config = vscode.workspace.getConfiguration("thumbview");
        const current = config.get<string[]>("ignorePatterns") || [];
        let updated = [...current];

        for (const source of sourceItems) {
            const pattern = typeof source === "string" ? source : (source.folderPath || source.labelName);
            if (pattern && typeof pattern === "string" && !updated.includes(pattern)) {
                updated.push(pattern);
            }
        }

        if (updated.length !== current.length) {
            await config.update("ignorePatterns", updated, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Added folder(s) to ignore list.`);
            this.refresh();
            if (this.onPatternAdded) {
                this.onPatternAdded();
            }
        }
    }

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
