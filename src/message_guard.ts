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
 * Commands that create, change, move, or delete files, or copy them (a copy brings its source's
 * content into the workspace on paste): their paths must be inside by real path.
 */
export const FILE_CHANGING_COMMANDS = new Set([
    "renameFile", "deleteFile", "cutFile", "copyFile", "newFile", "newFolder", "cutFolder", "copyFolder",
    "renameFolder", "deleteFolder", "moveFileToFolder", "moveFolderToFolder", "pasteItem"
]);

/**
 * Real-path checks for FILE_CHANGING_COMMANDS. The lexical check passes a path that runs through a
 * symlinked folder pointing outside the workspace, which would let a rename or delete change files
 * there. Opening and reading keep the lexical check, so files under such links still open.
 */
export interface RealPathChecks {
    uri(uri: string): boolean;
    relative(relativePath: string): boolean;
}

/**
 * True when a webview message may be handled. `uri` (if present) must be inside a workspace
 * folder, as decided by `isInsideWorkspace`, and for FILE_CHANGING_COMMANDS also by `real`;
 * relative path fields must pass isSafeRelativePath.
 */
export function isSafeWebviewMessage(msg: unknown, isInsideWorkspace: (uri: string) => boolean, real?: RealPathChecks): boolean {
    if (!msg || typeof msg !== "object") {
        return false;
    }
    const fields = msg as { [key: string]: unknown };
    const strict = !!real && typeof fields.command === "string" && FILE_CHANGING_COMMANDS.has(fields.command);
    if (fields.uri !== undefined) {
        if (typeof fields.uri !== "string" || hasDotDotSegment(fields.uri)) {
            return false;
        }
        try {
            if (!isInsideWorkspace(fields.uri) || (strict && !real!.uri(fields.uri))) {
                return false;
            }
        } catch {
            return false;
        }
    }
    return RELATIVE_PATH_FIELDS.every(field => {
        const value = fields[field];
        if (!isSafeRelativePath(value)) {
            return false;
        }
        if (!strict || typeof value !== "string" || !value) {
            return true;
        }
        try {
            return real!.relative(value);
        } catch {
            return false;
        }
    });
}

/** Longest layout order accepted from the webview (far above MAX_SCANNED_FILES plus gaps). */
export const MAX_ORDER_LENGTH = 200_000;

/**
 * A layout order sent by the webview, made safe to persist: anything but a string becomes a gap,
 * a repeated id becomes a gap (one file drawn twice would corrupt every later slot), and the length
 * is bounded. Null when it is not an array. Gaps keep their position, so nothing shifts.
 */
export function sanitizeOrderIds(raw: unknown): string[] | null {
    if (!Array.isArray(raw) || raw.length > MAX_ORDER_LENGTH) {
        return null;
    }
    const seen = new Set<string>();
    return raw.map(id => {
        if (typeof id !== "string" || id.length > 4096 || seen.has(id)) {
            return "";
        }
        if (id) {
            seen.add(id);
        }
        return id;
    });
}

/** A positive row count from the webview, or undefined. */
export function sanitizeRowCount(raw: unknown): number | undefined {
    return typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= 100_000 ? raw : undefined;
}
