import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";

export interface GitLineChanges {
    [lineIndex0: number]: "added" | "modified" | "removed";
}

export interface GitFileStatus {
    status: "modified" | "added" | "untracked" | "deleted";
    lines: GitLineChanges;
}

export type WorkspaceGitDiff = Map<string, GitFileStatus>;

let cachedGitDiff: WorkspaceGitDiff = new Map();
let isFetchingGit = false;

function execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve) => {
        execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 3000 }, (error, stdout) => {
            if (error) {
                resolve("");
            } else {
                resolve(stdout);
            }
        });
    });
}

export async function fetchWorkspaceGitDiff(): Promise<WorkspaceGitDiff> {
    if (isFetchingGit) {
        return cachedGitDiff;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return new Map();
    }

    isFetchingGit = true;
    const result: WorkspaceGitDiff = new Map();

    try {
        for (const folder of folders) {
            const cwd = folder.uri.fsPath;

            // 1. Get status for untracked and modified files
            const statusOutput = await execGit(["status", "--porcelain", "-uall"], cwd);
            if (!statusOutput) {
                continue;
            }

            const untrackedFiles: string[] = [];
            const lines = statusOutput.split("\n");
            for (const line of lines) {
                if (!line) continue;
                const status = line.slice(0, 2);
                let filePath = line.slice(3).trim();
                if (filePath.startsWith('"') && filePath.endsWith('"')) {
                    filePath = filePath.slice(1, -1);
                }
                const fullPath = path.resolve(cwd, filePath).replace(/\\/g, "/");

                if (status === "??" || status === "A ") {
                    untrackedFiles.push(fullPath);
                    result.set(fullPath, {
                        status: status === "??" ? "untracked" : "added",
                        lines: {}
                    });
                }
            }

            // 2. Get line-level diff against HEAD (both staged and unstaged)
            const diffOutput = await execGit(["diff", "HEAD", "-U0", "--no-color"], cwd);
            if (diffOutput) {
                parseGitDiff(diffOutput, cwd, result);
            } else {
                // Fallback to plain diff if HEAD doesn't exist yet (fresh repo)
                const fallbackDiff = await execGit(["diff", "-U0", "--no-color"], cwd);
                if (fallbackDiff) {
                    parseGitDiff(fallbackDiff, cwd, result);
                }
            }
        }
        cachedGitDiff = result;
    } catch {
    } finally {
        isFetchingGit = false;
    }

    return cachedGitDiff;
}

function parseGitDiff(diffText: string, cwd: string, out: WorkspaceGitDiff): void {
    const fileDiffs = diffText.split(/^diff --git /m);

    for (const chunk of fileDiffs) {
        if (!chunk.trim()) continue;

        const bMatch = chunk.match(/\+\+\+ (?:b\/|"b\/)(.+)$/m);
        if (!bMatch) continue;

        let relPath = bMatch[1].trim();
        if (relPath.endsWith('"')) {
            relPath = relPath.slice(0, -1);
        }
        const fullPath = path.resolve(cwd, relPath).replace(/\\/g, "/");

        const lineChanges: GitLineChanges = {};
        const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
        let match: RegExpExecArray | null;

        while ((match = hunkRegex.exec(chunk)) !== null) {
            const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
            const newStart = parseInt(match[3], 10);
            const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

            if (oldCount > 0 && newCount > 0) {
                const count = Math.min(oldCount, newCount);
                for (let i = 0; i < count; i++) {
                    lineChanges[newStart - 1 + i] = "modified";
                }
                if (newCount > oldCount) {
                    for (let i = count; i < newCount; i++) {
                        lineChanges[newStart - 1 + i] = "added";
                    }
                }
            } else if (oldCount === 0 && newCount > 0) {
                for (let i = 0; i < newCount; i++) {
                    lineChanges[newStart - 1 + i] = "added";
                }
            } else if (oldCount > 0 && newCount === 0) {
                const targetLine = Math.max(0, newStart - 1);
                lineChanges[targetLine] = "removed";
            }
        }

        const existing = out.get(fullPath);
        out.set(fullPath, {
            status: existing?.status || "modified",
            lines: { ...(existing?.lines || {}), ...lineChanges }
        });
    }
}

export function getCachedGitDiff(): WorkspaceGitDiff {
    return cachedGitDiff;
}
