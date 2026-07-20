import * as vscode from "vscode";

export interface RepoFile {

    id: string;
    path: string;
    uri: string;
    content: string;
    lines: number;
}

export async function scanRepository(): Promise<RepoFile[]> {

    const files = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,build,out,target}/**"
    );

    const result: RepoFile[] = [];

    for (const file of files) {

        try {

            const doc = await vscode.workspace.openTextDocument(file);

            if (doc.lineCount === 0) {
                continue;
            }

            result.push({
                id: file.fsPath,
                path: vscode.workspace.asRelativePath(file),
                uri: file.toString(),
                content: doc.getText(),
                lines: doc.lineCount
            });

        } catch {
        }
    }

    return result;
}