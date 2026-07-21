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