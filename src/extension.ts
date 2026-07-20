import * as vscode from "vscode";
import { scanRepository } from "./scanner";
import { buildStableGrid } from "./layout";

export async function activate(
    context: vscode.ExtensionContext
) {

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "repomap.open",
            async () => {

                const files = await scanRepository();

                const panel =
                    vscode.window.createWebviewPanel(
                        "repomap",
                        "Repository Map",
                        vscode.ViewColumn.Beside,
                        {
                            enableScripts: true,
                            retainContextWhenHidden: true
                        }
                    );

                const layout =
                    buildStableGrid(files.length);

                panel.webview.html = getHtml(
                    panel.webview,
                    context
                );

                panel.webview.onDidReceiveMessage(
                    async msg => {

                        if (msg.command === "ready") {

                            panel.webview.postMessage({
                                command: "data",
                                files,
                                layout
                            });
                        }

                        if (msg.command === "jump") {

                            const doc =
                                await vscode.workspace
                                    .openTextDocument(
                                        vscode.Uri.parse(msg.uri)
                                    );

                            const editor =
                                await vscode.window
                                    .showTextDocument(doc);

                            const line =
                                Math.min(
                                    msg.line,
                                    doc.lineCount - 1
                                );

                            const pos =
                                new vscode.Position(
                                    line,
                                    0
                                );

                            editor.revealRange(
                                new vscode.Range(
                                    pos,
                                    pos
                                )
                            );

                            editor.selection =
                                new vscode.Selection(
                                    pos,
                                    pos
                                );
                        }

                    }
                );
            }
        )
    );
}

function getHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext
) {

    const js = webview.asWebviewUri(
        vscode.Uri.joinPath(
            context.extensionUri,
            "media",
            "overview.js"
        )
    );

    return `
<!DOCTYPE html>
<html>
<body>

<canvas id="map"></canvas>

${js}

</body>
</html>
`;
}