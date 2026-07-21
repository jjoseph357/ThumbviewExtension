// Walks the workspace, applies a hand-rolled .gitignore emulation, and reads every
// remaining file into per-line records (RepoFile[]) for the layout builders to place
// and the webview to tokenize/draw. Runs on the extension-host side only.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface MiniLine {
    text: string;
    indent: number;
    length: number;
    category: "comment" | "import" | "function" | "class" | "control-flow" | "normal";
}

export interface RepoFile {
    id: string;
    path: string;
    uri: string;
    lines: MiniLine[];
    lineCount: number;
}

// Coarse per-line category guess from leading/contained keywords, not a real parser.
// NOTE: media/overview.js does its own independent full tokenization from raw text and
// does not appear to read this field — confirm it's actually unused before extending it.
function categorizeLine(line: string): MiniLine["category"] {
    const trimmed = line.trim();
    if (!trimmed) {
        return "normal";
    }

    if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("'''") ||
        trimmed.startsWith("\"\"\"")
    ) {
        return "comment";
    }

    if (
        trimmed.startsWith("import ") ||
        trimmed.startsWith("export ") ||
        trimmed.startsWith("from ") ||
        trimmed.startsWith("using ") ||
        trimmed.includes("require(")
    ) {
        return "import";
    }

    if (
        trimmed.startsWith("class ") ||
        trimmed.startsWith("interface ") ||
        trimmed.startsWith("struct ") ||
        trimmed.startsWith("impl ") ||
        trimmed.startsWith("type ")
    ) {
        return "class";
    }

    if (
        trimmed.startsWith("function ") ||
        trimmed.startsWith("def ") ||
        trimmed.startsWith("fn ") ||
        trimmed.startsWith("func ")
    ) {
        return "function";
    }

    if (
        trimmed.includes("if ") ||
        trimmed.includes("for ") ||
        trimmed.includes("while ") ||
        trimmed.includes("return") ||
        trimmed.includes("switch") ||
        trimmed.includes("else") ||
        trimmed.includes("elif") ||
        trimmed.includes("catch") ||
        trimmed.includes("try")
    ) {
        return "control-flow";
    }

    return "normal";
}

// Hand-rolled gitignore-glob-to-regex translator (falls back to a plain substring
// match if the generated pattern fails to compile). Does NOT handle negation
// patterns ("!foo") — those get treated as an ordinary rule to match, effectively
// the opposite of their intended meaning. Known limitation, not yet fixed.
function shouldIgnore(relativePath: string, rules: string[]): boolean {
    const pathStr = relativePath.replace(/\\/g, "/");
    for (const rule of rules) {
        const ruleStr = rule.replace(/\\/g, "/");
        const isDirRule = ruleStr.endsWith("/");
        const cleanRule = isDirRule ? ruleStr.slice(0, -1) : ruleStr;

        let regexPattern = cleanRule
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');

        if (cleanRule.startsWith("/")) {
            regexPattern = "^" + regexPattern.slice(1);
        } else {
            regexPattern = "(^|/)" + regexPattern;
        }

        if (isDirRule) {
            regexPattern = regexPattern + "(/|$)";
        } else {
            regexPattern = regexPattern + "($|/)";
        }

        try {
            const rx = new RegExp(regexPattern);
            if (rx.test(pathStr)) {
                return true;
            }
        } catch {
            if (pathStr.includes(cleanRule)) {
                return true;
            }
        }
    }
    return false;
}

export async function scanRepository(): Promise<RepoFile[]> {
    // Scan all files but exclude non-code or build folders
    const files = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,build,out,target,coverage,venv,.venv}/**"
    );

    // Second, finer-grained exclusion layer on top of the glob above: the workspace's
    // own .gitignore, applied manually via shouldIgnore() since findFiles' exclude glob
    // can't read an arbitrary file at scan time.
    let gitignoreRules: string[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const gitignorePath = path.join(workspaceFolders[0].uri.fsPath, ".gitignore");
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, "utf-8");
                gitignoreRules = content
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith("#"));
            } catch {
            }
        }
    }

    const result: RepoFile[] = [];

    for (const file of files) {
        const relative = vscode.workspace.asRelativePath(file);
        if (shouldIgnore(relative, gitignoreRules)) {
            continue;
        }

        try {
            const doc = await vscode.workspace.openTextDocument(file);
            if (doc.lineCount === 0) {
                continue;
            }

            const rawLines: MiniLine[] = [];
            for (let i = 0; i < doc.lineCount; i++) {
                const textLine = doc.lineAt(i).text;
                const trimmedRight = textLine.trimEnd();
                const indent = textLine.length - textLine.trimStart().length;
                const len = trimmedRight.length;

                rawLines.push({
                    text: textLine,
                    indent,
                    length: len,
                    category: categorizeLine(textLine)
                });
            }

            result.push({
                id: file.fsPath,
                path: vscode.workspace.asRelativePath(file),
                uri: file.toString(),
                lines: rawLines,
                lineCount: doc.lineCount
            });
        } catch {
            // Ignore unreadable files
        }
    }

    return result;
}