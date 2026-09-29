// Runs inside a real VS Code instance (npm test, @vscode/test-cli; see .vscode-test.mjs), against
// the shipped bundle and a generated demo workspace. The node unit tests never load the extension
// into VS Code, so this is the check that activation, the F4 command, and the panel lifecycle work.
import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

// thumbview.open trusts its own last intent for TOGGLE_INTENT_TRUST_MS (1s), so a second press
// sooner than that is read as part of the same toggle. This is the one fixed wait.
const TOGGLE_INTENT_TRUST_MS = 1000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function thumbviewTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("thumbview"));
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            assert.fail(`timed out waiting for ${what}`);
        }
        await sleep(50);
    }
}

async function pressF4(): Promise<void> {
    await sleep(TOGGLE_INTENT_TRUST_MS + 100);
    await vscode.commands.executeCommand("thumbview.open");
}

suite("Thumbview in VS Code", () => {
    suiteSetup(async () => {
        // A real editor tab, so closing Thumbview backgrounds its retained panel instead of
        // disposing it (with no other tabs, closing disposes).
        const folder = vscode.workspace.workspaceFolders![0].uri;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder.fsPath, "README.md")));
        await vscode.window.showTextDocument(doc, { preview: false });
    });

    suiteTeardown(async () => {
        if (thumbviewTabs().some(tab => tab.isActive)) {
            await pressF4();
            await waitFor("Thumbview to close", () => !thumbviewTabs().some(tab => tab.isActive));
        }
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    test("activates from the bundled entry point", async () => {
        const ext = vscode.extensions.all.find(e => e.packageJSON.name === "thumbview");
        assert.ok(ext, "the extension is installed in the test instance");
        await ext.activate();
        assert.ok(ext.isActive);
        assert.match(String(ext.packageJSON.main), /dist\/extension\.js$/);
    });

    test("F4 opens the panel, and a second press returns to the editor", async () => {
        await vscode.commands.executeCommand("thumbview.open");
        await waitFor("the Thumbview tab to become active", () => thumbviewTabs().some(tab => tab.isActive));
        assert.strictEqual(thumbviewTabs().length, 1);

        await pressF4();
        await waitFor("the README editor to be active again", () =>
            vscode.window.activeTextEditor?.document.uri.fsPath.endsWith("README.md") === true);
        assert.strictEqual(thumbviewTabs().length, 1, "the panel is kept in the background, not disposed");
    });

    test("reopening reuses the retained panel", async () => {
        await pressF4();
        await waitFor("the Thumbview tab to become active again", () => thumbviewTabs().some(tab => tab.isActive));
        assert.strictEqual(thumbviewTabs().length, 1, "no second Thumbview panel is created");
    });
});
