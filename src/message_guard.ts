// Validates webview messages before extension.ts acts on them. Returns whether a message may be
// handled: every file it names must lie inside the workspace.

// The webview is less trusted than the host (it renders workspace content), so any message that
// names a file is checked before a handler can open, rename, copy, move, or delete it.
export const RELATIVE_PATH_FIELDS = ["path", "folderPath", "targetFolder", "sourceFolder"];

/** Workspace-relative paths must not be absolute or climb out of the workspace with "..". */
export function isSafeRelativePath(value: unknown): boolean {
    if (value === undefined || value === null || value === "") {
        return true;
    }
    if (typeof value !== "string") {
        return false;
    }
    const normalized = value.replace(/\\/g, "/");
    return !normalized.startsWith("/") && !/^[a-zA-Z]:/.test(normalized) && !normalized.split("/").includes("..");
}

/**
 * True when a URI string contains a ".." path segment, raw or percent-encoded. VS Code's URI
 * parser does not normalize dot segments, so `file:///ws/../../etc/x` would pass a prefix-based
 * workspace check and then resolve outside the workspace on disk.
 */
export function hasDotDotSegment(uri: string): boolean {
    let decoded = uri;
    try {
        decoded = decodeURIComponent(uri);
    } catch {
        return true;
    }
    return decoded.replace(/\\/g, "/").split(/[/?#]/).includes("..");
}

/**
 * True when a webview message may be handled. `uri` (if present) must be inside a workspace
 * folder, as decided by `isInsideWorkspace`; relative path fields must pass isSafeRelativePath.
 */
export function isSafeWebviewMessage(msg: unknown, isInsideWorkspace: (uri: string) => boolean): boolean {
    if (!msg || typeof msg !== "object") {
        return false;
    }
    const fields = msg as { [key: string]: unknown };
    if (fields.uri !== undefined) {
        if (typeof fields.uri !== "string" || hasDotDotSegment(fields.uri)) {
            return false;
        }
        try {
            if (!isInsideWorkspace(fields.uri)) {
                return false;
            }
        } catch {
            return false;
        }
    }
    return RELATIVE_PATH_FIELDS.every(field => isSafeRelativePath(fields[field]));
}
