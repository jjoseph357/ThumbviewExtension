// Lists the workspace files Thumbview should show, honoring the user's own ignore rules instead of
// a hard-coded folder blocklist. Returns file URIs across all workspace folders.
import * as vscode from "vscode";
import { execFile } from "child_process";

// Always skipped: VCS metadata and dependency trees are never source the user wrote, and
// enumerating node_modules alone can cost more than the rest of the scan.
export const ALWAYS_EXCLUDED_DIRS = [".git", "node_modules"];

const GIT_LIST_TIMEOUT_MS = 15000;
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Converts a VS Code glob (files.exclude style: `**`, `*`, `?`, `[abc]`, `{a,b}`) to a RegExp matched
 * against a workspace-relative path with forward slashes. A pattern without a slash matches at
 * any depth, as VS Code does for keys like `*.pyc`.
 */
export function globToRegExp(glob: string): RegExp {
    let pattern = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!pattern.includes("/")) {
        pattern = `**/${pattern}`;
    }
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                const followedBySlash = pattern[i + 2] === "/";
                re += followedBySlash ? "(?:.*/)?" : ".*";
                i += followedBySlash ? 2 : 1;
            } else {
                re += "[^/]*";
            }
        } else if (ch === "?") {
            re += "[^/]";
        } else if (ch === "[") {
            // Character class, e.g. `*.[oa]` or `[!._]*`; an unterminated `[` is literal.
            const close = pattern.indexOf("]", i + 1);
            if (close === -1) {
                re += "\\[";
            } else {
                let body = pattern.substring(i + 1, close);
                if (body.startsWith("!")) {
                    body = "^" + body.substring(1);
                }
                re += `[${body.replace(/\\/g, "\\\\")}]`;
                i = close;
            }
        } else if (ch === "{") {
            const close = pattern.indexOf("}", i);
            if (close === -1) {
                re += "\\{";
            } else {
                const alternatives = pattern.substring(i + 1, close).split(",").map(a => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
                re += `(?:${alternatives.join("|")})`;
                i = close;
            }
        } else {
            re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
        }
    }
    // A pattern naming a folder also excludes everything inside it.
    return new RegExp(`^${re}(?:/.*)?$`);
}

/**
 * Enabled `files.exclude` and `search.exclude` globs for a folder (entries set to `true`; `when`
 * clauses are ignored). search.exclude is where users list generated trees they never want to
 * search (e.g. dist/, coverage/), which are equally noise in a code overview.
 */
function excludeGlobs(folder: vscode.WorkspaceFolder): string[] {
    const globs: string[] = [];
    for (const section of ["files", "search"]) {
        const setting = vscode.workspace.getConfiguration(section, folder.uri).get<{ [glob: string]: unknown }>("exclude") || {};
        globs.push(...Object.entries(setting).filter(([, enabled]) => enabled === true).map(([glob]) => glob));
    }
    return globs;
}

/** True for a path inside an always-excluded directory. */
export function isAlwaysExcluded(relativePath: string): boolean {
    return relativePath.split("/").some(segment => ALWAYS_EXCLUDED_DIRS.includes(segment));
}

/**
 * `git ls-files` lists tracked files plus untracked files not ignored by any .gitignore level,
 * .git/info/exclude, or the global excludes file — exactly the files a developer considers
 * theirs. Returns null when git is unavailable, the folder is not a repository, or the
 * workspace is untrusted (a repository's own git config can run commands, e.g. core.fsmonitor).
 */
function listViaGit(folder: vscode.WorkspaceFolder): Promise<string[] | null> {
    if (folder.uri.scheme !== "file" || !vscode.workspace.isTrusted) {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        execFile(
            "git",
            ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            { cwd: folder.uri.fsPath, maxBuffer: GIT_LIST_MAX_BUFFER, timeout: GIT_LIST_TIMEOUT_MS },
            (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }
                resolve(stdout.split("\0").filter(Boolean));
            }
        );
    });
}

/** Files to scan across every workspace folder, after .gitignore (via git), files.exclude/search.exclude, and ALWAYS_EXCLUDED_DIRS. */
export async function listWorkspaceFiles(): Promise<vscode.Uri[]> {
    const folders = vscode.workspace.workspaceFolders || [];
    const perFolder = await Promise.all(folders.map(async folder => {
        const excludeRegexes = excludeGlobs(folder).map(globToRegExp);
        const isExcluded = (rel: string) => isAlwaysExcluded(rel) || excludeRegexes.some(re => re.test(rel));

        const gitPaths = await listViaGit(folder);
        if (gitPaths) {
            return gitPaths
                .filter(rel => !isExcluded(rel))
                .map(rel => vscode.Uri.joinPath(folder.uri, rel));
        }

        // Not a git repository, git missing, untrusted, or a virtual/remote file system.
        const found = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, "**/*"),
            `**/{${ALWAYS_EXCLUDED_DIRS.join(",")}}/**`
        );
        return found.filter(uri => !isExcluded(vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/")));
    }));
    return perFolder.flat();
}

/** A file whose first 8KB contain a NUL character is treated as binary and not shown as code. */
export function looksBinary(text: string): boolean {
    return text.slice(0, 8192).includes("\0");
}
