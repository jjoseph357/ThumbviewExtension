// Lists the workspace files Thumbview should show, honoring the user's own ignore rules instead of
// a hard-coded folder blocklist. Returns file URIs across all workspace folders.
import * as vscode from "vscode";
import { execFile } from "child_process";
import { shouldIgnore } from "./ignore_rules";

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

/** True when the folder itself is ignored by an enclosing git repository. */
export function isFolderGitIgnored(folder: vscode.WorkspaceFolder): Promise<boolean> {
    if (!folder?.uri || folder.uri.scheme !== "file" || !vscode.workspace?.isTrusted) {
        return Promise.resolve(false);
    }
    return new Promise(resolve => {
        execFile(
            "git",
            ["check-ignore", "-q", "."],
            { cwd: folder.uri.fsPath, timeout: 3000 },
            (error) => {
                // Exit code 0 means git considers this folder ignored.
                resolve(!error);
            }
        );
    });
}

/**
 * `git ls-files` lists tracked files plus untracked files not ignored by any .gitignore level,
 * .git/info/exclude, or the global excludes file — exactly the files a developer considers
 * theirs. Returns null when git is unavailable, the folder is not a repository, or the
 * workspace is untrusted (a repository's own git config can run commands, e.g. core.fsmonitor).
 */
async function listViaGit(folder: vscode.WorkspaceFolder): Promise<string[] | null> {
    if (folder.uri.scheme !== "file" || !vscode.workspace.isTrusted) {
        return null;
    }
    if (await isFolderGitIgnored(folder)) {
        return null;
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

/** Rules from a folder's root .gitignore, for the listing path that cannot ask git. */
async function readRootGitignore(folder: vscode.WorkspaceFolder): Promise<string[]> {
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, ".gitignore"));
        return Buffer.from(bytes).toString("utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    } catch {
        return [];
    }
}

/** Files to scan across every workspace folder, after .gitignore (via git), files.exclude/search.exclude, and ALWAYS_EXCLUDED_DIRS. */
export async function listWorkspaceFiles(): Promise<vscode.Uri[]> {
    const folders = vscode.workspace.workspaceFolders || [];
    const perFolder = await Promise.all(folders.map(async folder => {
        const excludeRegexes = excludeGlobs(folder).map(globToRegExp);
        const isExcluded = (rel: string) => isAlwaysExcluded(rel) || excludeRegexes.some(re => re.test(rel));

        const gitPaths = await listViaGit(folder);
        if (gitPaths && gitPaths.length > 0) {
            return gitPaths
                .filter(rel => !isExcluded(rel))
                .map(rel => vscode.Uri.joinPath(folder.uri, rel));
        }

        // Not a git repository, git missing, untrusted, or a virtual/remote file system. The folder's
        // root .gitignore still applies (read, never executed), so build output stays hidden here too.
        const [found, gitignoreRules] = await Promise.all([
            vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, "**/*"),
                `**/{${ALWAYS_EXCLUDED_DIRS.join(",")}}/**`
            ),
            readRootGitignore(folder)
        ]);
        return found.filter(uri => {
            const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
            return !isExcluded(rel) && !shouldIgnore(rel, gitignoreRules);
        });
    }));
    return perFolder.flat();
}

/** A file whose first 8KB contain a NUL character is treated as binary and not shown as code. */
export function looksBinary(text: string): boolean {
    return text.slice(0, 8192).includes("\0");
}

/** Paths (relative to `folder`) that git ignores, among `rels`; null when git cannot answer. */
async function gitIgnoredAmong(folder: vscode.WorkspaceFolder, rels: string[]): Promise<Set<string> | null> {
    if (folder.uri.scheme !== "file" || !vscode.workspace.isTrusted) {
        return null;
    }
    if (await isFolderGitIgnored(folder)) {
        return null;
    }
    return new Promise(resolve => {
        const child = execFile(
            "git",
            ["--no-optional-locks", "check-ignore", "--stdin", "-z"],
            { cwd: folder.uri.fsPath, maxBuffer: GIT_LIST_MAX_BUFFER, timeout: GIT_LIST_TIMEOUT_MS },
            (error, stdout) => {
                // Exit code 1 means "none of these are ignored"; anything else is a real failure.
                if (error && (error as { code?: unknown }).code !== 1) {
                    resolve(null);
                    return;
                }
                resolve(new Set(String(stdout).split("\0").filter(Boolean)));
            }
        );
        child.stdin?.end(rels.join("\0") + "\0");
    });
}

/**
 * Which of these newly created paths the next listing would include (same rules as
 * listWorkspaceFiles), so a create inside build output or a cache never costs a full rescan.
 * Returns null when that cannot be decided cheaply (no git); the caller then rescans.
 */
export async function listableAmong(uris: vscode.Uri[]): Promise<vscode.Uri[] | null> {
    const byFolder = new Map<vscode.WorkspaceFolder, { uri: vscode.Uri; rel: string }[]>();
    for (const uri of uris) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            continue;
        }
        const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
        const list = byFolder.get(folder) ?? [];
        list.push({ uri, rel });
        byFolder.set(folder, list);
    }
    const listable: vscode.Uri[] = [];
    for (const [folder, entries] of byFolder) {
        const excludeRegexes = excludeGlobs(folder).map(globToRegExp);
        const candidates = entries.filter(e => !isAlwaysExcluded(e.rel) && !excludeRegexes.some(re => re.test(e.rel)));
        if (candidates.length === 0) {
            continue;
        }
        const ignored = await gitIgnoredAmong(folder, candidates.map(e => e.rel));
        if (!ignored) {
            return null;
        }
        listable.push(...candidates.filter(e => !ignored.has(e.rel)).map(e => e.uri));
    }
    return listable;
}
