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
    fullLines?: string[];
    isImage?: boolean;
    isPdf?: boolean;
    mediaUri?: string;
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

// Fast PDF Page 1 text stream extractor (parses text brackets (text) and TJ arrays from PDF stream chunks)
async function extractPdfPage1Lines(fileUri: vscode.Uri): Promise<MiniLine[]> {
    try {
        const fileData = await vscode.workspace.fs.readFile(fileUri);
        // Sample first 64KB chunk for Page 1 content
        const chunkLength = Math.min(fileData.length, 64 * 1024);
        const textChunk = Buffer.from(fileData.subarray(0, chunkLength)).toString("utf8");

        const lines: MiniLine[] = [];
        // Match literal PDF text strings inside (text) or [(text)] within BT...ET blocks
        const textMatches = textChunk.match(/\(([^()]+)\)/g);
        if (textMatches && textMatches.length > 0) {
            for (let idx = 0; idx < Math.min(textMatches.length, 40); idx++) {
                const rawStr = textMatches[idx].slice(1, -1).trim();
                if (rawStr.length >= 2) {
                    lines.push({
                        text: rawStr.substring(0, 150),
                        indent: Math.min(rawStr.length % 10, 8),
                        length: Math.min(rawStr.length, 150),
                        category: "normal"
                    });
                }
            }
        }
        return lines;
    } catch {
        return [];
    }
}

export async function scanRepository(): Promise<RepoFile[]> {
    // Scan all files but exclude non-code, library, or build folders
    const files = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,build,out,target,coverage,venv,.venv,env,.env,lib,vendor}/**"
    );

    // Apply ignore patterns configured in thumbview.ignorePatterns setting
    const config = vscode.workspace.getConfiguration("thumbview");
    const gitignoreRules = config.get<string[]>("ignorePatterns") || [];

    // Prioritize auto-ignoring 'lib' or 'vendor' subdirectories & dense folders (>threshold files)
    const threshold = config.get<number>("autoIgnoreThreshold") ?? 30;
    const folderCounts = new Map<string, number>();
    for (const file of files) {
        const relative = vscode.workspace.asRelativePath(file);
        const parts = relative.split("/");
        if (parts.length > 1) {
            const folderDir = parts.slice(0, parts.length - 1).join("/") + "/";
            folderCounts.set(folderDir, (folderCounts.get(folderDir) || 0) + 1);
        }
    }

    const denseFolders: string[] = [];
    for (const [folderDir, count] of folderCounts.entries()) {
        const isLibFolder = /(^|\/)(lib|vendor|libraries)(\/|$)/i.test(folderDir);
        if ((isLibFolder || (threshold > 0 && count > threshold)) && !gitignoreRules.includes(folderDir)) {
            denseFolders.push(folderDir);
        }
    }

    if (denseFolders.length > 0) {
        const updatedIgnored = [...gitignoreRules, ...denseFolders];
        await config.update("ignorePatterns", updatedIgnored, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Auto-ignored ${denseFolders.length} library/dense directory (e.g. ${denseFolders[0]}). You can un-ignore them anytime in the sidebar.`);
        gitignoreRules.push(...denseFolders);
    }

    const result: RepoFile[] = [];

    for (const file of files) {
        const relative = vscode.workspace.asRelativePath(file);
        if (shouldIgnore(relative, gitignoreRules)) {
            continue;
        }

        try {
            const ext = path.extname(file.fsPath).toLowerCase().slice(1);
            const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
            const isPdf = ext === "pdf";

            if (isImage) {
                result.push({
                    id: file.fsPath,
                    path: vscode.workspace.asRelativePath(file),
                    uri: file.toString(),
                    lines: [],
                    lineCount: 1,
                    isImage: true,
                    isPdf: false,
                    mediaUri: file.toString()
                });
                continue;
            }

            if (isPdf) {
                const pdfLines = await extractPdfPage1Lines(file);
                result.push({
                    id: file.fsPath,
                    path: vscode.workspace.asRelativePath(file),
                    uri: file.toString(),
                    lines: pdfLines,
                    lineCount: Math.max(pdfLines.length, 1),
                    isImage: false,
                    isPdf: true,
                    mediaUri: file.toString()
                });
                continue;
            }

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

            let fullLines: string[] | undefined = undefined;
            if (doc.lineCount > MAX_LINES) {
                fullLines = [];
                for (let i = 0; i < doc.lineCount; i++) {
                    let text = doc.lineAt(i).text;
                    if (text.length > MAX_LINE_LENGTH) {
                        text = text.substring(0, MAX_LINE_LENGTH);
                    }
                    fullLines.push(text);
                }
            }

            result.push({
                id: file.fsPath,
                path: vscode.workspace.asRelativePath(file),
                uri: file.toString(),
                lines: rawLines,
                lineCount: doc.lineCount,
                fullLines
            });
        } catch {
            // Ignore unreadable files
        }
    }

    return result;
}