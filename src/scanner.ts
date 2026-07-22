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

function matchSingleRule(pathStr: string, rule: string): boolean {
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
        return rx.test(pathStr);
    } catch {
        return pathStr.includes(cleanRule);
    }
}

// Hand-rolled gitignore-glob-to-regex translator (falls back to a plain substring
// match if the generated pattern fails to compile). Evaluates rules sequentially
// in order and supports negation patterns ("!foo") to un-ignore files.
function shouldIgnore(relativePath: string, rules: string[]): boolean {
    const pathStr = relativePath.replace(/\\/g, "/");
    let ignored = false;

    for (const rule of rules) {
        if (!rule) continue;
        const isNegated = rule.startsWith("!");
        const pattern = isNegated ? rule.slice(1).trim() : rule.trim();
        if (!pattern) continue;

        if (matchSingleRule(pathStr, pattern)) {
            ignored = !isNegated;
        }
    }

    return ignored;
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
    const config = vscode.workspace.getConfiguration("thumbview");
    const customIgnored = config.get<string[]>("ignorePatterns") || [];
    gitignoreRules.push(...customIgnored);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const gitignorePath = path.join(workspaceFolders[0].uri.fsPath, ".gitignore");
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, "utf-8");
                const fileRules = content
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith("#"));
                gitignoreRules.push(...fileRules);
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
            const stat = await vscode.workspace.fs.stat(file);
            // Skip massive files (>2MB) to prevent memory overload
            if (stat.size > 2 * 1024 * 1024) {
                continue;
            }

            const doc = await vscode.workspace.openTextDocument(file);
            if (doc.lineCount === 0) {
                continue;
            }

            const MAX_LINES = 2000;
            const MAX_LINE_LENGTH = 300;
            const step = doc.lineCount > MAX_LINES ? doc.lineCount / MAX_LINES : 1;

            const rawLines: MiniLine[] = [];
            for (let idx = 0; idx < Math.min(doc.lineCount, MAX_LINES); idx++) {
                const i = Math.floor(idx * step);
                if (i >= doc.lineCount) break;

                let textLine = doc.lineAt(i).text;
                if (textLine.length > MAX_LINE_LENGTH) {
                    textLine = textLine.substring(0, MAX_LINE_LENGTH);
                }
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