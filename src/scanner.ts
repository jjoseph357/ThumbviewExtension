// Lists workspace files (file_discovery.ts: .gitignore via git, files.exclude), applies the user's
// Thumbview ignore patterns, and reads every remaining text file into per-line records
// (RepoFile[]) for the layout builders to place and the webview to tokenize/draw.
// Runs on the extension-host side only.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { listWorkspaceFiles, looksBinary } from "./file_discovery";
import { categorizeLine, type LineCategory } from "./layout_core";

export interface MiniLine {
    text: string;
    indent: number;
    length: number;
    category: LineCategory;
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
    gitChanges?: { [lineIndex0: number]: "added" | "modified" | "removed" };
    gitStatus?: "modified" | "added" | "untracked" | "deleted";
    hasError?: boolean;
    errorCount?: number;
    errorLines?: { [lineIndex0: number]: string | boolean };
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
export function shouldIgnore(relativePath: string, rules: string[]): boolean {
    const pathStr = relativePath.replace(/\\/g, "/");
    let ignored = false;

    for (const rule of rules) {
        if (!rule) continue;
        const isNegated = rule.startsWith("!");
        const pattern = isNegated ? rule.slice(1).trim() : rule.trim();
        if (!pattern) continue;

        const cleanPattern = pattern.replace(/^\/+|\/+$/g, "");
        if (cleanPattern === "(root files)") {
            if (!pathStr.includes("/")) {
                ignored = !isNegated;
            }
        } else if (matchSingleRule(pathStr, pattern)) {
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

export interface ScanIgnoreState {
    ignorePatterns: string[];
    autoIgnoreExclusions: string[];
}

export const isLibFolderRegex = /(^|\/)(lib|lib64|vendor|libraries|venv|\.venv|env|\.env|__pycache__|\.pytest_cache|\.mypy_cache)(\/|$)/i;
export const isSourceRootRegex = /^(src|app|packages|pkg|source|frontend|backend|client|server|pages|components|routes)([\s_-].*)?(\/|$)/i;

export function computeAutoIgnorePatterns(
    relativePaths: string[],
    threshold: number,
    gitignoreRules: string[],
    autoIgnoreExclusions: string[] = []
): string[] {
    const dirDirectCounts = new Map<string, number>();
    const dirSubdirs = new Map<string, Set<string>>();

    for (const relative of relativePaths) {
        const parts = relative.replace(/\\/g, "/").split("/");
        if (parts.length > 1) {
            let prefix = "";
            for (let i = 0; i < parts.length - 1; i++) {
                const parent = prefix;
                prefix += parts[i] + "/";
                if (parent) {
                    if (!dirSubdirs.has(parent)) dirSubdirs.set(parent, new Set());
                    dirSubdirs.get(parent)!.add(prefix);
                }
            }
            const directDir = prefix;
            dirDirectCounts.set(directDir, (dirDirectCounts.get(directDir) || 0) + 1);
        }
    }

    const denseFolders: string[] = [];
    const isAlreadyCovered = (dir: string, rules: string[]): boolean => {
        if (shouldIgnore(dir, rules)) return true;
        for (const rule of rules) {
            const clean = rule.trim().replace(/^\/+|\/+$/g, "");
            if (clean && (dir.startsWith(clean + "/") || dir === clean + "/")) {
                return true;
            }
        }
        return false;
    };

    const exclusionSet = new Set(autoIgnoreExclusions.map(e => e.trim().replace(/^\/+|\/+$/g, "")));
    const isUserExcluded = (dir: string): boolean => {
        const clean = dir.trim().replace(/^\/+|\/+$/g, "");
        return exclusionSet.has(clean);
    };

    const combinedRules = [...gitignoreRules];

    const allDirs = new Set<string>();
    for (const d of dirDirectCounts.keys()) allDirs.add(d);
    for (const d of dirSubdirs.keys()) allDirs.add(d);

    const sortedDirs = Array.from(allDirs).sort((a, b) => {
        const depthA = a.split("/").length;
        const depthB = b.split("/").length;
        if (depthA !== depthB) return depthA - depthB;
        return a.localeCompare(b);
    });

    for (const dir of sortedDirs) {
        if (isUserExcluded(dir)) continue;
        if (isAlreadyCovered(dir, combinedRules)) continue;

        const isLib = isLibFolderRegex.test(dir);
        if (isLib) {
            denseFolders.push(dir);
            combinedRules.push(dir);
            continue;
        }

        // Never auto-ignore standard project source roots or any folder inside them
        if (isSourceRootRegex.test(dir)) {
            continue;
        }

        if (threshold > 0) {
            const directCount = dirDirectCounts.get(dir) || 0;
            if (directCount > threshold) {
                denseFolders.push(dir);
                combinedRules.push(dir);
            }
        }
    }

    return denseFolders;
}

interface FileCacheEntry {
    mtime: number;
    size: number;
    repoFile: RepoFile;
}

const scanFileCache = new Map<string, FileCacheEntry>();

export function clearScanCache(): void {
    scanFileCache.clear();
}

export function invalidateScanFile(filePath: string): void {
    scanFileCache.delete(filePath);
}

export const MAX_SCANNED_FILES = 10000;
let scanCapNotified = false;
// Ids already on the map (extension.ts registers the persisted layout order). When the cap
// applies, these keep their place first so tiles never vanish because unrelated files were added.
let scanPriorityProvider: () => Iterable<string> = () => [];
export function setScanPriorityProvider(provider: () => Iterable<string>): void {
    scanPriorityProvider = provider;
}

export async function scanRepository(
    ignoreState: ScanIgnoreState,
    persistIgnore: (updated: ScanIgnoreState) => Promise<void>
): Promise<RepoFile[]> {
    // The user's own rules decide what is source: every .gitignore level (via git), files.exclude,
    // and .git/node_modules. A blanket folder-name blocklist used to hide real code such as lib/.
    const files = await listWorkspaceFiles();

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const config = vscode.workspace.getConfiguration("thumbview", wsFolder?.uri);

    const gitignoreRules = [...ignoreState.ignorePatterns];
    const autoIgnoreExclusions = ignoreState.autoIgnoreExclusions;

    // Prioritize auto-ignoring top-level dense folders & library subdirectories (>threshold files)
    const threshold = config.get<number>("autoIgnoreThreshold") ?? 30;
    const denseFolders = computeAutoIgnorePatterns(
        files.map(f => vscode.workspace.asRelativePath(f)),
        threshold,
        gitignoreRules,
        autoIgnoreExclusions
    );

    // Prune redundant child rules from gitignoreRules (e.g. if BOFS/ or lib64/ exists, remove deep child entries)
    const allEffectiveRules = [...gitignoreRules, ...denseFolders];
    const cleanedRules: string[] = [];
    for (const rule of gitignoreRules) {
        const clean = rule.trim().replace(/^\/+|\/+$/g, "");
        if (!clean) continue;

        const isChildOfOther = allEffectiveRules.some(other => {
            const otherClean = other.trim().replace(/^\/+|\/+$/g, "");
            return otherClean && clean !== otherClean && clean.startsWith(otherClean + "/");
        });
        if (!isChildOfOther && !cleanedRules.includes(rule)) {
            cleanedRules.push(rule);
        }
    }

    if (denseFolders.length > 0 || cleanedRules.length !== gitignoreRules.length) {
        const updatedIgnored = Array.from(new Set([...cleanedRules, ...denseFolders]));
        await persistIgnore({
            ignorePatterns: updatedIgnored,
            autoIgnoreExclusions
        });
        if (denseFolders.length > 0) {
            const msg = denseFolders.length === 1
                ? `Auto-ignored folder '${denseFolders[0]}'. Check out 'Ignored Files & Directories' in the Thumbview sidebar to unignore it if you want.`
                : `Auto-ignored ${denseFolders.length} folders (e.g. '${denseFolders[0]}'). Check out 'Ignored Files & Directories' in the Thumbview sidebar to unignore them if you want.`;
            vscode.window.showInformationMessage(msg);
        }
        gitignoreRules.length = 0;
        gitignoreRules.push(...updatedIgnored);
    }

    const result: RepoFile[] = [];
    const validFiles = files.filter(file => !shouldIgnore(vscode.workspace.asRelativePath(file), gitignoreRules));

    // Sort files by directory level so root-level files and subdirectories sit adjacent to their siblings
    validFiles.sort((a, b) => {
        const relA = vscode.workspace.asRelativePath(a).replace(/\\/g, "/");
        const relB = vscode.workspace.asRelativePath(b).replace(/\\/g, "/");

        const lastSlashA = relA.lastIndexOf("/");
        const lastSlashB = relB.lastIndexOf("/");

        const dirA = lastSlashA !== -1 ? relA.substring(0, lastSlashA) : "";
        const dirB = lastSlashB !== -1 ? relB.substring(0, lastSlashB) : "";

        if (dirA !== dirB) {
            // Group root directory files (dir === "") together first
            if (dirA === "") return -1;
            if (dirB === "") return 1;
            return dirA.localeCompare(dirB, undefined, { numeric: true, sensitivity: "base" });
        }

        return relA.localeCompare(relB, undefined, { numeric: true, sensitivity: "base" });
    });

    // Safety net after auto-ignore (thumbview.autoIgnoreThreshold, which already hides any folder
    // with too many files): a monorepo of many small folders can still list 100k+ files. Read only
    // the first MAX_SCANNED_FILES in layout order and tell the user once per session.
    if (validFiles.length > MAX_SCANNED_FILES) {
        if (!scanCapNotified) {
            scanCapNotified = true;
            vscode.window.showWarningMessage(
                `Thumbview is showing the first ${MAX_SCANNED_FILES.toLocaleString()} of ${validFiles.length.toLocaleString()} files. Ignore large folders from the Folders & Ignored menu (or with .gitignore / files.exclude) to see the rest.`
            );
        }
        // Spatial stability: files already shown stay shown; new files take the remaining slots
        // in layout order. Sort order alone would let one added file push another off the map.
        const shown = new Set(scanPriorityProvider());
        const kept = validFiles.filter(file => shown.has(file.fsPath)).slice(0, MAX_SCANNED_FILES);
        const room = MAX_SCANNED_FILES - kept.length;
        const added = room > 0 ? validFiles.filter(file => !shown.has(file.fsPath)).slice(0, room) : [];
        const keep = new Set([...kept, ...added]);
        const capped = validFiles.filter(file => keep.has(file));
        validFiles.length = 0;
        validFiles.push(...capped);
    }

    // Parallel chunked processing (batch size 50) to prevent thread block while speeding up scan by ~5x
    const CHUNK_SIZE = 50;
    for (let c = 0; c < validFiles.length; c += CHUNK_SIZE) {
        const chunk = validFiles.slice(c, c + CHUNK_SIZE);
        const chunkResults = await Promise.all(chunk.map(async file => {
            try {
                const ext = path.extname(file.fsPath).toLowerCase().slice(1);
                const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
                const isPdf = ext === "pdf";

                if (isImage) {
                    return {
                        id: file.fsPath,
                        path: vscode.workspace.asRelativePath(file),
                        uri: file.toString(),
                        lines: [],
                        lineCount: 1,
                        isImage: true,
                        isPdf: false,
                        mediaUri: file.toString()
                    } as RepoFile;
                }

                let statMtime = 0;
                let statSize = 0;
                try {
                    if (file.scheme !== "file") {
                        // Virtual/remote URIs: fsPath could name an unrelated local file.
                        throw new Error("non-file scheme");
                    }
                    const st = await fs.promises.stat(file.fsPath);
                    statMtime = st.mtimeMs;
                    statSize = st.size;
                } catch {
                    try {
                        const st = await vscode.workspace.fs.stat(file);
                        statMtime = st.mtime || 0;
                        statSize = st.size || 0;
                    } catch {
                        statMtime = 0;
                        statSize = 0;
                    }
                }

                // Skip massive files (>2MB) to prevent memory overload
                if (statSize > 2 * 1024 * 1024) {
                    return null;
                }

                const cached = scanFileCache.get(file.fsPath);
                if (cached && cached.mtime === statMtime && cached.size === statSize && statMtime !== 0) {
                    return cached.repoFile;
                }

                if (isPdf) {
                    const pdfLines = await extractPdfPage1Lines(file);
                    const pdfFile: RepoFile = {
                        id: file.fsPath,
                        path: vscode.workspace.asRelativePath(file),
                        uri: file.toString(),
                        lines: pdfLines,
                        lineCount: Math.max(pdfLines.length, 1),
                        isImage: false,
                        isPdf: true,
                        mediaUri: file.toString()
                    };
                    if (statMtime !== 0) {
                        scanFileCache.set(file.fsPath, { mtime: statMtime, size: statSize, repoFile: pdfFile });
                    }
                    return pdfFile;
                }

                let rawText: string | null = null;
                try {
                    if (file.scheme !== "file") {
                        throw new Error("non-file scheme");
                    }
                    rawText = await fs.promises.readFile(file.fsPath, "utf-8");
                } catch {
                    if (vscode.workspace.fs && typeof vscode.workspace.fs.readFile === "function") {
                        try {
                            const bytes = await vscode.workspace.fs.readFile(file);
                            rawText = Buffer.from(bytes).toString("utf-8");
                        } catch {
                            rawText = null;
                        }
                    }
                    if (rawText === null && typeof vscode.workspace.openTextDocument === "function") {
                        try {
                            const doc = await vscode.workspace.openTextDocument(file);
                            const lines: string[] = [];
                            for (let i = 0; i < doc.lineCount; i++) {
                                lines.push(doc.lineAt(i).text);
                            }
                            rawText = lines.join("\n");
                        } catch {
                            rawText = null;
                        }
                    }
                }

                if (rawText === null || looksBinary(rawText)) {
                    return null;
                }

                const lines = rawText.split(/\r?\n/);
                const lineCount = lines.length;
                if (lineCount === 0 || (lineCount === 1 && lines[0] === "")) {
                    return null;
                }

                const MAX_LINES = 2000;
                const MAX_LINE_LENGTH = 300;
                const step = lineCount > MAX_LINES ? lineCount / MAX_LINES : 1;

                const rawLines: MiniLine[] = [];
                for (let idx = 0; idx < Math.min(lineCount, MAX_LINES); idx++) {
                    const i = Math.floor(idx * step);
                    if (i >= lineCount) break;

                    let textLine = lines[i];
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
                if (lineCount > MAX_LINES) {
                    fullLines = [];
                    for (let i = 0; i < lineCount; i++) {
                        let text = lines[i];
                        if (text.length > MAX_LINE_LENGTH) {
                            text = text.substring(0, MAX_LINE_LENGTH);
                        }
                        fullLines.push(text);
                    }
                }

                const repoFile: RepoFile = {
                    id: file.fsPath,
                    path: vscode.workspace.asRelativePath(file),
                    uri: file.toString(),
                    lines: rawLines,
                    lineCount,
                    fullLines
                };

                if (statMtime !== 0) {
                    scanFileCache.set(file.fsPath, {
                        mtime: statMtime,
                        size: statSize,
                        repoFile
                    });
                }

                return repoFile;
            } catch {
                return null;
            }
        }));

        for (const item of chunkResults) {
            if (item) result.push(item);
        }
    }

    return result;
}