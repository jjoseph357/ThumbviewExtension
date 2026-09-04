// Webview/browser-side counterpart to extension.ts (the "host"). Receives postMessage
// data from the host and re-tokenizes/redraws everything to a single <canvas> on
// every render() call — there is no virtual DOM or per-tile element, for performance
// with large workspaces. Not compiled/bundled: loaded as-is via a nonce'd <script> tag
// (see extension.ts's getHtml), so it can't `import` the extension-host TypeScript in
// src/ — hence buildStableGrid below being a hand-kept-in-sync duplicate of layout.ts's,
// and tokenizeJS/tokenizeCSS/tokenizeHTML being a second, independent highlighter from
// scanner.ts's coarse per-line categorizer.
const vscode = acquireVsCodeApi();

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("hover-tooltip");

/** Reads a VS Code theme CSS variable off body, falling back to fallbackHex if unset. */
function getThemeColor(varName, fallbackHex) {
    const val = getComputedStyle(document.body).getPropertyValue(varName).trim();
    return val || fallbackHex;
}

/** Checks whether the active VS Code color theme is a light theme. */
function isLightTheme() {
    if (typeof document === "undefined") return false;
    return document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
}

// Fixed brand accents — single source of truth is src/colors.ts, injected here as
// CSS custom properties by extension.ts. Never hardcode these hexes elsewhere.
let ACCENT_SEARCH = "#dc267f";
let ACCENT_INSPECT = "#785ef0";
let ACCENT_RECENCY = "#fe6100";

// Color definitions that dynamically adapt across Dark and Light themes
let TILE_BACKGROUND = "#1e1e24";
let TILE_LABEL_COLOR = {
    searchMatch: "#dc267f",
    error: "#f14c4c",
    active: "#ffffff",
    normal: "#a0a0a5",
    modified: "#e2c08d",
    added: "#73c991"
};
let BORDER_STYLES = {
    searchMatch: { color: "#dc267f", width: 2.5 },
    active:      { color: "#007fd4", width: 2.5 },
    open:        { color: "#fe6100", width: 1.8 },
    dragging:    { color: "#648fff", width: 1.8 },
    default:     { color: "rgba(255, 255, 255, 0.08)", width: 1 }
};
let CLOSE_BTN_COLOR = "#707075";

let MEDIA_CONFIG = {
    tileBackground: "#1e1e24",
    imageTileBackground: "#252526",
    imageTilePlaceholderText: "#858585",
    pdfHeaderBar: "#4d4d4d",
    pdfHeaderForeground: "#ffffff",
    pdfPlaceholderLine: "rgba(255, 255, 255, 0.25)",
    activeFocusHighlight: "#007fd4"
};

let themeTokensDirty = true;
let THEME_CATEGORY_COLORS = {};

function refreshThemeTokens() {
    themeTokensDirty = false;
    const light = isLightTheme();
    ACCENT_SEARCH = getThemeColor("--tv-accent-search", "#dc267f");
    ACCENT_INSPECT = getThemeColor("--tv-accent-inspect", "#785ef0");
    ACCENT_RECENCY = getThemeColor("--tv-accent-recency", "#fe6100");

    TILE_BACKGROUND = getThemeColor("--vscode-editor-background", light ? "#ffffff" : "#1e1e24");
    
    TILE_LABEL_COLOR = {
        searchMatch: ACCENT_SEARCH,
        error: getThemeColor("--vscode-list-errorForeground", light ? "#e51400" : "#f14c4c"),
        active: getThemeColor("--vscode-foreground", light ? "#000000" : "#ffffff"),
        normal: getThemeColor("--vscode-descriptionForeground", light ? "#616161" : "#a0a0a5"),
        modified: getThemeColor("--vscode-gitDecoration-modifiedResourceForeground", light ? "#895503" : "#e2c08d"),
        added: getThemeColor("--vscode-gitDecoration-untrackedResourceForeground", light ? "#22863a" : "#73c991")
    };

    BORDER_STYLES = {
        searchMatch: { color: ACCENT_SEARCH, width: 2.5 },
        active:      { color: getThemeColor("--vscode-focusBorder", "#007fd4"), width: 2.5 },
        open:        { color: ACCENT_RECENCY, width: 1.8 },
        dragging:    { color: "#648fff", width: 1.8 },
        default:     { color: getThemeColor("--vscode-widget-border", light ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.08)"), width: 1 }
    };

    CLOSE_BTN_COLOR = getThemeColor("--vscode-descriptionForeground", light ? "#616161" : "#707075");

    MEDIA_CONFIG = {
        tileBackground: getThemeColor("--vscode-editor-background", light ? "#ffffff" : "#1e1e24"),
        imageTileBackground: getThemeColor("--vscode-editorWidget-background", light ? "#f3f3f3" : "#252526"),
        imageTilePlaceholderText: getThemeColor("--vscode-descriptionForeground", light ? "#616161" : "#858585"),
        pdfHeaderBar: getThemeColor("--vscode-badge-background", light ? "#e0e0e0" : "#4d4d4d"),
        pdfHeaderForeground: getThemeColor("--vscode-badge-foreground", light ? "#333333" : "#ffffff"),
        pdfPlaceholderLine: getThemeColor("--vscode-widget-border", light ? "rgba(0, 0, 0, 0.15)" : "rgba(255, 255, 255, 0.25)"),
        activeFocusHighlight: getThemeColor("--vscode-focusBorder", "#007fd4")
    };

    const commentColor = getThemeColor("--vscode-editorComment-foreground", light ? "#008000" : "#6a9955");
    const editorFgColor = getThemeColor("--vscode-editor-foreground", light ? "#333333" : "#cccccc");
    const editorDefaultFgColor = getThemeColor("--vscode-editor-foreground", light ? "#333333" : "#d4d4d4");

    THEME_CATEGORY_COLORS = {
        "key": light ? "#001080" : "#9cdcfe",
        "comment": commentColor,
        "string": light ? "#a31515" : "#ce9178",
        "number": light ? "#098658" : "#b5cea8",
        "control-flow": light ? "#af00db" : "#c586c0",
        "keyword": light ? "#0000ff" : "#569cd6",
        "operator": editorFgColor,
        "normal": editorFgColor,
        "function": light ? "#795e26" : "#dcdcaa",
        "type": light ? "#267f99" : "#4ec9b0",
        "heading": light ? "#0000ff" : "#9cdcfe",
        "variable": light ? "#001080" : "#9cdcfe",
        "property": light ? "#001080" : "#9cdcfe",
        "css-property": light ? "#001080" : "#9cdcfe",
        "attribute": light ? "#001080" : "#9cdcfe",
        "selector": light ? "#800000" : "#ce9178",
        "css-value": light ? "#800000" : "#ce9178",
        "tag": light ? "#800000" : "#569cd6",
        "tag-bracket": light ? "#800000" : "#808080",
        "default": editorDefaultFgColor
    };
}

// Initial theme token resolution
refreshThemeTokens();

// Robust color -> rgba(...) parser supporting hex, rgb, rgba, and hsl
function withAlpha(color, alpha) {
    if (!color) return `rgba(0, 0, 0, ${alpha})`;
    const s = String(color).trim();
    if (s.startsWith("#")) {
        const clean = s.replace("#", "");
        let r = 0, g = 0, b = 0;
        if (clean.length === 3) {
            r = parseInt(clean[0] + clean[0], 16);
            g = parseInt(clean[1] + clean[1], 16);
            b = parseInt(clean[2] + clean[2], 16);
        } else {
            r = parseInt(clean.substring(0, 2), 16) || 0;
            g = parseInt(clean.substring(2, 4), 16) || 0;
            b = parseInt(clean.substring(4, 6), 16) || 0;
        }
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    const rgbMatch = s.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbMatch) {
        return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
    }
    return s;
}

const ICONS = {
    folder: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:var(--vscode-foreground,#cccccc);"><path d="M1.75 3.75C1.75 3.06 2.31 2.5 3 2.5H6.05C6.46 2.5 6.84 2.69 7.09 3.01L7.91 4.09C8.16 4.41 8.54 4.6 8.95 4.6H13C13.69 4.6 14.25 5.16 14.25 5.85V12.4C14.25 13.09 13.69 13.65 13 13.65H3C2.31 13.65 1.75 13.09 1.75 12.4V3.75Z" fill="currentColor" fill-opacity="0.08"/></svg>',
    file: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:var(--vscode-descriptionForeground,#8a8a93);"><path d="M3.5 2C2.67 2 2 2.67 2 3.5V12.5C2 13.33 2.67 14 3.5 14H12.5C13.33 14 14 13.33 14 12.5V5.5L10.5 2H3.5Z"/><path d="M10.5 2V5.5H14"/><path d="M5 8.5H11M5 11H8.5" stroke-linecap="round"/></svg>',
    workspace: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:var(--vscode-foreground,#e0e0e5);"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6H14M6 6V14"/></svg>',
    rootFiles: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:var(--vscode-descriptionForeground,#8a8a93);"><rect x="4.5" y="2" width="8.5" height="11" rx="1.5"/><path d="M2.5 5.5V13.5C2.5 14.05 2.95 14.5 3.5 14.5H10.5"/><path d="M7 6H10.5M7 8.5H9.5"/></svg>',
    ignoreFolder: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:var(--vscode-descriptionForeground,#8a8a93);"><path d="M1.75 3.75C1.75 3.06 2.31 2.5 3 2.5H6.05C6.46 2.5 6.84 2.69 7.09 3.01L7.91 4.09C8.16 4.41 8.54 4.6 8.95 4.6H13C13.69 4.6 14.25 5.16 14.25 5.85V12.4C14.25 13.09 13.69 13.65 13 13.65H3C2.31 13.65 1.75 13.09 1.75 12.4V3.75Z"/><path d="M3.25 13L12.75 3.25" stroke-linecap="round"/></svg>',
    ignoreFile: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:var(--vscode-descriptionForeground,#8a8a93);"><path d="M3.5 2C2.67 2 2 2.67 2 3.5V12.5C2 13.33 2.67 14 3.5 14H12.5C13.33 14 14 13.33 14 12.5V5.5L10.5 2H3.5Z"/><path d="M10.5 2V5.5H14"/><path d="M3.5 12.5L12.5 3.5" stroke-linecap="round"/></svg>',
    remove: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 4L12 12M12 4L4 12"/></svg>',
    empty: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.35;margin-bottom:8px;"><circle cx="12" cy="12" r="9"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    chevronRight: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><path d="M6 3.5l4.5 4.5L6 12.5V3.5z"/></svg>',
    chevronDown: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><path d="M3.5 6l4.5 4.5L12.5 6H3.5z"/></svg>'
};

let data = null;
let statusText = "Loading Thumbview...";
let activeFileUri = null;
let focusedFolder = ""; // empty means root

let currentIgnorePatterns = [];
const optimisticPatternCounts = {};
const expandedNavigatorFolders = new Set();
const collapsedNavigatorFolders = new Set();

function getParentFolderPath(folderPath) {
    const clean = folderPath.replace(/\/+$/, "");
    const lastSlash = clean.lastIndexOf("/");
    if (lastSlash === -1) return null;
    return clean.substring(0, lastSlash + 1);
}

function getFolderSegmentName(folderPath) {
    const clean = folderPath.replace(/\/+$/, "");
    const lastSlash = clean.lastIndexOf("/");
    return lastSlash === -1 ? clean + "/" : clean.substring(lastSlash + 1) + "/";
}

function isFolderVisibleInTree(folderPath, collapsedSet) {
    let parent = getParentFolderPath(folderPath);
    while (parent) {
        if (collapsedSet.has(parent)) {
            return false;
        }
        parent = getParentFolderPath(parent);
    }
    return true;
}
let openFiles = []; // Array of open file URIs (orange borders)
let openFilesSet = new Set();
let cursorLocations = {}; // Map of file URIs to current cursor line numbers

const CLOSE_BUTTON_PADDING = 4; // px

// Canvas layout margins for the root/subfolder grid — reserve space above the tiles
// for the breadcrumb bar, below for bottom padding, and on the sides for edge padding.
const GRID_TOP_MARGIN = 64;
const GRID_BOTTOM_MARGIN = 40;
const GRID_SIDE_MARGIN = 16;

const DRAG_THRESHOLD = 5; // px
let candidateFile = null;
let candidateFolder = null;
let draggingFile = null;
let draggingFolder = null;
let dragGrabOffset = null;
let cursorPos = null;
let dragRafId = null;
let dragTargetFile = null;
let dragTarget = null;
let dragTargetFolder = null;
let dragTargetBreadcrumb = null;
let activeRenderGrid = null;
let dragBackgroundCanvas = null;
let cachedDragBackgroundCanvas = null;
const fileTokenCache = new Map();
let clipboardItem = null;

let hoveredFile = null;

const slotOccupancy = new Map();
const fileById = new Map();
const fileByUri = new Map();

let matchCase = false;
let matchWholeWord = false;
let useRegex = false;
let rawSearchQuery = "";   // original case, trimmed
let searchQuery = "";      // lowercase, trimmed. kept for the existing fast substring path
let searchRegex = null;    // compiled only when useRegex or matchWholeWord is on
let searchInvalid = false; // true when the user's regex fails to compile

/** Converts a mouse event's screen coordinates to coordinates local to the canvas element. */
function getCanvasPos(event) {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    return { px, py };
}

/** True if (px, py) falls inside rect's {x, y, w, h} box, optionally grown by pad px on each side. */
function pointInRect(rect, px, py, pad = 0) {
    return rect.x - pad <= px && px <= rect.x + rect.w + pad &&
           rect.y - pad <= py && py <= rect.y + rect.h + pad;
}

/** Returns the file containing px, py if it exists, else returns null. */
function findFileAt(px, py) {
    if (!data || !data.layout) return null;

    // Fast O(1) grid slot lookup when in standard root grid mode
    if (!focusedFolder && data.layout.cols > 0 && data.layout.rows > 0) {
        const rectW = canvas.clientWidth || window.innerWidth;
        const rectH = canvas.clientHeight || window.innerHeight;
        const availableW = rectW - (GRID_SIDE_MARGIN * 2);
        const availableH = rectH - GRID_TOP_MARGIN - GRID_BOTTOM_MARGIN;
        if (availableW > 0 && availableH > 0) {
            const cellW = availableW / data.layout.cols;
            const cellH = availableH / data.layout.rows;
            const col = Math.floor((px - GRID_SIDE_MARGIN) / cellW);
            const row = Math.floor((py - GRID_TOP_MARGIN) / cellH);
            if (col >= 0 && col < data.layout.cols && row >= 0 && row < data.layout.rows) {
                const file = slotOccupancy.get(`${col},${row}`);
                if (file && file._cell && pointInRect(file._cell, px, py)) {
                    return file;
                }
            }
        }
    }

    const filteredFiles = getFilteredFiles();
    for (let i = 0; i < filteredFiles.length; i++) {
        const file = filteredFiles[i];
        const c = file._cell;
        if (c && pointInRect(c, px, py)) {
            return file;
        }
    }
    return null;
}

function clamp(num, min, max) {
    return Math.min(Math.max(num, min), max);
}

function findNearestSlot(px, py) {
    const rectW = canvas.clientWidth || window.innerWidth;
    const rectH = canvas.clientHeight || window.innerHeight;
    const availableW = rectW - (GRID_SIDE_MARGIN * 2);
    const availableH = rectH - GRID_TOP_MARGIN - GRID_BOTTOM_MARGIN;

    const grid = activeRenderGrid || {
        cols: data?.layout?.cols || 1,
        rows: data?.layout?.rows || 1,
        cellW: availableW / Math.max(1, data?.layout?.cols || 1),
        cellH: availableH / Math.max(1, data?.layout?.rows || 1)
    };

    const col = Math.floor((px - GRID_SIDE_MARGIN) / grid.cellW);
    const row = Math.floor((py - GRID_TOP_MARGIN) / grid.cellH);

    const col_clamped = clamp(col, 0, grid.cols - 1);
    const row_clamped = clamp(row, 0, grid.rows - 1);

    let file = null;
    let item = null;
    if (grid.isFolderCards && grid.orderedItems && grid.layout && grid.layout.slots) {
        const slotIdx = grid.layout.slots.findIndex(s => s[0] === col_clamped && s[1] === row_clamped);
        if (slotIdx !== -1 && slotIdx < grid.orderedItems.length && grid.orderedItems[slotIdx]) {
            item = grid.orderedItems[slotIdx];
            if (item.type === "file") file = item.file;
        }
    } else if (grid.isFolderView && grid.files) {
        if (grid.layout && grid.layout.placements) {
            for (const p of grid.layout.placements) {
                if (p.slots && p.slots.some(s => s[0] === col_clamped && s[1] === row_clamped)) {
                    file = p.file;
                    break;
                }
            }
        } else if (grid.layout && grid.layout.slots) {
            if (grid.folderOrder) {
                const slotIdx = grid.layout.slots.findIndex(s => s[0] === col_clamped && s[1] === row_clamped);
                if (slotIdx !== -1 && slotIdx < grid.folderOrder.length && grid.folderOrder[slotIdx]) {
                    file = grid.files.find(f => f.id === grid.folderOrder[slotIdx]) || null;
                }
            } else {
                for (let i = 0; i < grid.files.length; i++) {
                    const s = grid.layout.slots[i];
                    if (s && s[0] === col_clamped && s[1] === row_clamped) {
                        file = grid.files[i];
                        break;
                    }
                }
            }
        }
    } else {
        file = slotOccupancy.get(`${col_clamped},${row_clamped}`) ?? null;
    }

    return {
        cellW: grid.cellW,
        cellH: grid.cellH,
        col: col_clamped,
        row: row_clamped,
        file: file,
        item: item,
        gridCols: grid.cols
    };
}

/** Recomputes dragTargetFile from the live drag cursor position (cursorPos); called on every throttled mousemove while dragging. */
function updateDragTarget() {
    if ((!draggingFile && !draggingFolder) || !cursorPos) return;

    dragTargetFolder = null;
    dragTargetBreadcrumb = null;
    dragTarget = findNearestSlot(cursorPos.px, cursorPos.py);
    dragTargetFile = dragTarget?.file ?? null;
}

/** Resets all drag-related module state and cancels any pending drag animation frame. */
function clearDragState() {
    candidateFile = null;
    candidateFolder = null;
    draggingFile = null;
    draggingFolder = null;
    dragGrabOffset = null;
    dragTarget = null;
    dragTargetFile = null;
    dragTargetFolder = null;
    dragTargetBreadcrumb = null;
    dragBackgroundCanvas = null;

    if (dragRafId !== null) {
        cancelAnimationFrame(dragRafId);
        dragRafId = null;
    }
}

let searchDebounceTimer = null;
/** Re-renders after a search input change, debounced by 80ms unless immediate rendering is requested. */
function triggerSearchRender(immediate = false) {
    if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
    }
    if (immediate) {
        render();
    } else {
        searchDebounceTimer = setTimeout(() => {
            render();
        }, 80);
    }
}

/** Escapes regex-special characters so a literal string can be embedded in a RegExp pattern. */
function escapeRegExp(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/** Builds a line's syntax-highlighted HTML from its tokens, optionally wrapping search-match substrings in a highlight span. */
function buildLineHtml(tokens, highlightRegex) {
    let html = "";
    for (const tok of tokens) {
        let escapedText = tok.text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        if (highlightRegex) {
            highlightRegex.lastIndex = 0;
            if (highlightRegex.test(tok.text)) {
                highlightRegex.lastIndex = 0;
                escapedText = escapedText.replace(highlightRegex, m =>
                    `<span style="background: ${withAlpha(ACCENT_SEARCH, 0.45)}; border-radius: 2px; padding: 0 2px;">${m}</span>`
                );
            }
        }

        const color = colorForCategory(tok.category, tok.isKey);
        html += `<span style="color: ${color}">${escapedText}</span>`;
    }
    return html || " ";
}


/**
 * Recompiles searchQuery/searchRegex from the raw input text and the match-case/whole-word/regex toggles.
 * The regex/whole-word pattern-building here is duplicated in extension.ts's "jump" message handler
 * (used to flash matching lines in the document after a jump) — keep both in sync.
 */
function rebuildSearchState(value) {
    rawSearchQuery = value.trim();
    searchQuery = rawSearchQuery.toLowerCase();
    searchInvalid = false;
    searchRegex = null;

    if (rawSearchQuery && (useRegex || matchWholeWord)) {
        let pattern = useRegex ? rawSearchQuery : escapeRegExp(rawSearchQuery);
        if (matchWholeWord) pattern = `\\b(?:${pattern})\\b`;
        try {
            searchRegex = new RegExp(pattern, matchCase ? "" : "i");
        } catch (e) {
            searchInvalid = true;
        }
    }

    searchInputFld.classList.toggle('regex-error', searchInvalid);
}

/**
 * True if the current search query matches this line, checked against whichever of the
 * original/lowered pair the active toggles call for. Kept as a pair so plain substring
 * search stays on the fast pre-lowercased path.
 */
function textMatches(original, lowered) {
    if (!rawSearchQuery || searchInvalid) return false;
    if (searchRegex) return searchRegex.test(original);
    return matchCase ? original.includes(rawSearchQuery) : lowered.includes(searchQuery);
}

// Setup search inputs
const searchInputFld = document.getElementById("search-input");
const matchCaseBtn = document.getElementById("search-match-case");
const matchWordBtn = document.getElementById("search-match-word");
const useRegexBtn = document.getElementById("search-use-regex");
const clearSearchBtn = document.getElementById("clear-search");

searchInputFld.addEventListener("input", e => {
    rebuildSearchState(e.target.value);
    clearSearchBtn.style.display = searchQuery ? "block" : "none";
    triggerSearchRender(false);
});

// Clicking a search-container button blurs #search-input by default, which triggers its
// :focus width transition (180px -> 240px) mid-click; the resulting layout shift moves the
// button out from under the pointer before mouseup, so the browser's click never fires on
// the first press. Suppressing the default mousedown focus change keeps the input focused
// and the layout still, so the click lands normally.
for (const btn of [matchCaseBtn, matchWordBtn, useRegexBtn, clearSearchBtn]) {
    btn.addEventListener("mousedown", e => e.preventDefault());
}

matchCaseBtn.addEventListener("click", () => toggleMatchCase());

matchWordBtn.addEventListener("click", () => toggleMatchWord());

useRegexBtn.addEventListener("click", () => toggleRegex());

clearSearchBtn.addEventListener("click", () => clearSearch());

/** Toggles case-sensitive search and re-renders with the new search state. */
function toggleMatchCase() {
    matchCase = !matchCase;
    rebuildSearchState(searchInputFld.value);
    matchCaseBtn.classList.toggle('active');
    triggerSearchRender(true);
}

/** Toggles regex search mode and re-renders with the new search state. */
function toggleRegex() {
    useRegex = !useRegex;
    rebuildSearchState(searchInputFld.value);
    useRegexBtn.classList.toggle('active');
    triggerSearchRender(true);
}

/** Toggles whole-word search matching and re-renders with the new search state. */
function toggleMatchWord() {
    matchWholeWord = !matchWholeWord;
    rebuildSearchState(searchInputFld.value);
    matchWordBtn.classList.toggle('active');
    triggerSearchRender(true);
}

/** Clears the search input/state and re-renders. */
function clearSearch() {
    searchInputFld.value = "";
    rebuildSearchState("");
    clearSearchBtn.style.display = "none";
    triggerSearchRender(true);
}

// Capture global keystrokes and type directly into search box
window.addEventListener("keydown", event => {
    // Checked before the activeElement/modifier bailouts below so these fire whether
    // focus is on the search input or anywhere else in the webview (e.g. the canvas).
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const cmd = event.key.toLowerCase();
        if        (cmd === 'c') {
            event.preventDefault();
            toggleMatchCase();
            return;
        } else if (cmd === 'w') {
            event.preventDefault();
            toggleMatchWord();
            return;
        } else if (cmd === 'x') {
            event.preventDefault();
            toggleRegex();
            return;
        }
    }

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.tagName === "SELECT" || activeEl.isContentEditable)) {
        if (activeEl !== searchInputFld) {
            return;
        }
    }

    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key === 'Backspace') {
            event.preventDefault();
            clearSearch();
            return;
        }
    }

    if (activeEl === searchInputFld) {
        return;
    }

    if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
    }

    if (event.key.length === 1) {
        event.preventDefault();
        searchInputFld.focus();
        searchInputFld.value += event.key;
        rebuildSearchState(searchInputFld.value);
        clearSearchBtn.style.display = searchQuery ? "block" : "none";
        triggerSearchRender(false);
    } else if (event.key === "Backspace") {
        event.preventDefault();
        searchInputFld.focus();
        searchInputFld.value = searchInputFld.value.slice(0, -1);
        rebuildSearchState(searchInputFld.value);
        clearSearchBtn.style.display = searchQuery ? "block" : "none";
        triggerSearchRender(false);
    }
});

let resizeRafId = null;

/** Resyncs the canvas backing-store size to the (DPR-scaled) window size and re-renders; retries via rAF while the tab is hidden/backgrounded. */
function resize() {
    if (window.innerWidth < 100 || window.innerHeight < 100) {
        // Webview tab is hidden or backgrounded; ignore transient collapsed dimensions
        if (!resizeRafId) {
            resizeRafId = requestAnimationFrame(() => {
                resizeRafId = null;
                resize();
            });
        }
        return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
}

window.addEventListener("resize", resize);

// Handle canvas context loss gracefully (e.g. GPU crash on Linux Wayland/Mesa drivers)
canvas.addEventListener("contextlost", (event) => {
    event.preventDefault();
    console.warn("Thumbview Canvas context lost. Waiting for restoration...");
});

canvas.addEventListener("contextrestored", () => {
    console.log("Thumbview Canvas context restored.");
    resize();
});

// Host -> webview protocol (extension.ts is the sender in each case): "status" (loading/
// error text), "data" (the full file/layout payload), "activeFile" (URI of the focused
// editor), "openState" (open tab URIs + cursor lines). No shared type with extension.ts
// — see CLAUDE.md's "Cross-module interface" note.
let hoverLineCache = {}; // Cache of fetched line ranges for long files { uri: { lineIdx: lineObj } }
let pendingHoverRequest = null;
let viewLocations = {}; // Map of file URIs to current visible range { startLine, endLine }

window.addEventListener("message", event => {
    const msg = event.data;

    if (msg.command === "status") {
        statusText = msg.text;
        if (msg.clearData) {
            data = null;
            hoverLineCache = {};
        }
        if (!data) {
            drawStatus();
        }
    }

    if (msg.command === "focusWebview") {
        window.focus();
    }

    // Hide/show webview content during zen mode transitions so the user
    // doesn't see the canvas at the wrong size (hideForTransition from
    // extension.ts onDidChangeViewState enter path — keep in sync)
    if (msg.command === "hideForTransition") {
        document.body.style.opacity = "0";
    }
    if (msg.command === "showAfterTransition") {
        document.body.style.opacity = "1";
    }

    if (msg.command === "data") {
        data = msg;
        currentIgnorePatterns = msg.ignorePatterns || [];
        for (const k of Object.keys(optimisticPatternCounts)) {
            if (data.ignorePatternCounts && typeof data.ignorePatternCounts[k] === "number") {
                delete optimisticPatternCounts[k];
            }
        }
        statusText = "";
        hoverLineCache = {};
        slotOccupancy.clear();
        fileById.clear();
        fileByUri.clear();
        if (data && data.files) {
            for (let fIdx = 0; fIdx < data.files.length; fIdx++) {
                const f = data.files[fIdx];
                fileById.set(f.id, f);
                fileByUri.set(f.uri, f);
                f._lowerPath = f.path ? f.path.toLowerCase() : "";
                const lang = detectLang(f.path);

                const cacheKey = `${f.id}:${f.lineCount || (f.lines ? f.lines.length : 0)}:${f.lines && f.lines[0] ? f.lines[0].text : ""}`;
                const cached = fileTokenCache.get(cacheKey);

                if (cached) {
                    f._combinedText = cached.combinedText;
                    f._combinedTextOriginal = cached.combinedTextOriginal;
                    f._avgLineChars = cached.avgLineChars;
                    f._lowerFullLines = cached.lowerFullLines;
                    if (f.lines && cached.lines) {
                        for (let lIdx = 0; lIdx < f.lines.length && lIdx < cached.lines.length; lIdx++) {
                            f.lines[lIdx]._lowerText = cached.lines[lIdx].lowerText;
                            f.lines[lIdx]._tokens = cached.lines[lIdx].tokens;
                        }
                    }
                } else {
                    const textArr = [];
                    const textArrOriginal = [];
                    if (f.path) textArr.push(f.path.toLowerCase());
                    const cachedLines = [];
                    if (f.lines) {
                        for (let lIdx = 0; lIdx < f.lines.length; lIdx++) {
                            const l = f.lines[lIdx];
                            const lower = l.text ? l.text.toLowerCase() : "";
                            l._lowerText = lower;
                            l._tokens = tokenizeLine(l.text ? l.text.trimStart() : "", lang);
                            textArr.push(lower);
                            textArrOriginal.push(l.text || "");
                            cachedLines.push({ lowerText: lower, tokens: l._tokens });
                        }
                        let totalChars = 0;
                        let validCount = 0;
                        for (let k = 0; k < Math.min(f.lines.length, 50); k++) {
                            const len = f.lines[k]?.text?.length || 0;
                            if (len > 0) {
                                totalChars += len;
                                validCount++;
                            }
                        }
                        f._avgLineChars = validCount > 0 ? Math.min(100, Math.max(45, Math.round(totalChars / validCount))) : 65;
                    }
                    if (f.fullLines) {
                        f._lowerFullLines = f.fullLines.map(str => {
                            const lower = str.toLowerCase();
                            textArr.push(lower);
                            return lower;
                        });
                        textArrOriginal.push(...f.fullLines);
                    }
                    f._combinedText = textArr.join("\n");
                    f._combinedTextOriginal = textArrOriginal.join("\n");

                    fileTokenCache.set(cacheKey, {
                        combinedText: f._combinedText,
                        combinedTextOriginal: f._combinedTextOriginal,
                        avgLineChars: f._avgLineChars,
                        lowerFullLines: f._lowerFullLines,
                        lines: cachedLines
                    });
                }

                if (f.slots) {
                    for (const [col, row] of f.slots) {
                        slotOccupancy.set(`${col},${row}`, f);
                    }
                } else if (f.slot) {
                    slotOccupancy.set(`${f.slot[0]},${f.slot[1]}`, f);
                }
            }
        }
        if (msg.openKeybinding) {
            const kbdLabel = document.getElementById("open-shortcut-label");
            if (kbdLabel) {
                kbdLabel.textContent = msg.openKeybinding;
            }
            const kbdLabel2 = document.getElementById("open-shortcut-label-2");
            if (kbdLabel2) {
                kbdLabel2.textContent = msg.openKeybinding;
            }
        }
        updateSettingsModalState();
        updateIgnoresPopover();
        updateFoldersPopover();
        render();
    }

    if (msg.command === "activeFile") {
        activeFileUri = msg.uri;
        render();
    }

    if (msg.command === "openState") {
        if ("activeFileUri" in msg) {
            activeFileUri = msg.activeFileUri;
        }
        if ("openFiles" in msg) {
            openFiles = msg.openFiles;
            openFilesSet = new Set(openFiles);
        }
        viewLocations = msg.viewLocations || {};
        render();
    }

    if (msg.command === "setFocusedFolder") {
        setFocusedFolderWithHistory(msg.folder || "");
    }

    if (msg.command === "hoverLines") {
        if (!hoverLineCache[msg.uri]) {
            hoverLineCache[msg.uri] = {};
        }
        if (msg.lines && Array.isArray(msg.lines)) {
            for (let idx = 0; idx < msg.lines.length; idx++) {
                hoverLineCache[msg.uri][msg.start + idx] = msg.lines[idx];
            }
            const f = fileByUri.get(msg.uri);
            if (f) delete f._widestLineWidth;
        }
        if (lastMousePos && isCtrlDown) {
            updateHoverTooltip();
        }
    }
});

/**
 * Packs nCells items into a near-16:9 grid, returning {rows, cols, slots}. Duplicate of
 * layout.ts's buildStableGrid (uniform_grid mode only) — used here only to lay out a
 * focused folder's subset of files (see render() below), since the host never computes
 * a layout for that subset. Keep in sync with layout.ts by hand.
 */
function buildStableGrid(nCells, targetAspect = 1.777) {
    let rows = 1;
    let cols = Math.max(2, Math.ceil(rows * targetAspect));

    const slots = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            slots.push([c, r]);
        }
    }

    while (slots.length < nCells) {
        const errCol = Math.abs((cols + 1) / rows - targetAspect);
        const errRow = Math.abs(cols / (rows + 1) - targetAspect);

        if (errCol <= errRow) {
            const newCol = cols;
            for (let r = 0; r < rows; r++) {
                slots.push([newCol, r]);
            }
            cols++;
        } else {
            const newRow = rows;
            for (let c = 0; c < cols; c++) {
                slots.push([c, newRow]);
            }
            rows++;
        }
    }

    return {
        rows,
        cols,
        slots
    };
}

function cellsNeeded(lineCount, baseLinesPerCell = 60, compressionPct = 0.05) {
    if (lineCount <= baseLinesPerCell) {
        return 1;
    }
    const repLines = Math.max(lineCount * compressionPct, baseLinesPerCell);
    return Math.ceil(repLines / baseLinesPerCell);
}

function buildSpanningGridLocal(files, targetAspect = 1.777, folderOrder = null, extraCols = 0, extraRows = 0, baseLinesPerCell = 60, compressionPct = 0.05) {
    const allocations = {};
    let actualCells = 0;
    let maxNCells = 1;

    for (const f of files) {
        const nCells = f.nCells || (f.lineCount ? cellsNeeded(f.lineCount, baseLinesPerCell, compressionPct) : 1);
        allocations[f.id] = nCells;
        actualCells += nCells;
        if (nCells > maxNCells) {
            maxNCells = nCells;
        }
    }

    const calculatedRows = Math.max(1, Math.round(Math.sqrt(Math.max(actualCells, files.length, 1) / targetAspect)));
    const wrapRows = Math.max(calculatedRows, maxNCells);

    const filesById = new Map(files.map(f => [f.id, f]));
    let orderToIterate = [];
    if (folderOrder && Array.isArray(folderOrder) && folderOrder.length > 0) {
        orderToIterate = [...folderOrder];
        const seenIds = new Set(folderOrder.filter(Boolean));
        const newFiles = files.filter(f => !seenIds.has(f.id));
        let newIdx = 0;
        for (let i = 0; i < orderToIterate.length && newIdx < newFiles.length; i++) {
            if (!orderToIterate[i]) {
                orderToIterate[i] = newFiles[newIdx++].id;
            }
        }
        while (newIdx < newFiles.length) {
            orderToIterate.push(newFiles[newIdx++].id);
        }
    } else {
        orderToIterate = files.map(f => f.id);
    }

    let currCol = 0;
    let currRow = 0;
    let maxRowUsed = 1;
    const placements = [];

    for (const fid of orderToIterate) {
        const file = fid ? filesById.get(fid) : null;
        const nCells = fid ? (allocations[fid] || 1) : 1;
        const mustBreak = currRow > 0 && currRow + nCells > wrapRows;

        if (mustBreak) {
            currCol++;
            currRow = 0;
        }

        if (file) {
            const slots = [];
            for (let i = 0; i < nCells; i++) {
                slots.push([currCol, currRow + i]);
            }

            placements.push({
                file,
                col: currCol,
                row: currRow,
                nCells,
                slots
            });
        }

        currRow += nCells;
        if (currRow > maxRowUsed) {
            maxRowUsed = currRow;
        }
    }

    const reqCols = currCol + 1;
    const finalRows = Math.max(1, maxRowUsed) + extraRows;
    const finalCols = Math.max(2, reqCols, Math.ceil(finalRows * targetAspect)) + extraCols;

    return {
        rows: finalRows,
        cols: finalCols,
        wrapRows: wrapRows,
        placements
    };
}

const breadcrumbHistory = [""];
let breadcrumbHistoryIndex = 0;

/** Sets focusedFolder, tracks history stack, and triggers breadcrumbs & render update. */
function setFocusedFolderWithHistory(folder, recordHistory = true) {
    const target = folder || "";
    if (recordHistory && target !== breadcrumbHistory[breadcrumbHistoryIndex]) {
        breadcrumbHistory.splice(breadcrumbHistoryIndex + 1);
        breadcrumbHistory.push(target);
        breadcrumbHistoryIndex = breadcrumbHistory.length - 1;
    }
    focusedFolder = target;
    updateBreadcrumbs();
    render();
}

/** Navigates back one step in breadcrumb history, or goes up to parent folder. */
function handleBreadcrumbBack() {
    if (breadcrumbHistoryIndex > 0) {
        breadcrumbHistoryIndex--;
        setFocusedFolderWithHistory(breadcrumbHistory[breadcrumbHistoryIndex], false);
        return true;
    } else if (focusedFolder) {
        if (focusedFolder === "(root files)/") {
            setFocusedFolderWithHistory("", false);
        } else {
            const segments = focusedFolder.split("/").filter(Boolean);
            segments.pop();
            const parent = segments.length > 0 ? segments.join("/") + "/" : "";
            setFocusedFolderWithHistory(parent, false);
        }
        return true;
    }
    return false;
}

/** Navigates forward one step in breadcrumb history. */
function handleBreadcrumbForward() {
    if (breadcrumbHistoryIndex < breadcrumbHistory.length - 1) {
        breadcrumbHistoryIndex++;
        setFocusedFolderWithHistory(breadcrumbHistory[breadcrumbHistoryIndex], false);
        return true;
    }
    return false;
}

/** Rebuilds the breadcrumb trail DOM for the current focusedFolder, each segment clickable to refocus. */
function updateBreadcrumbs() {
    const container = document.getElementById("breadcrumbs");
    if (!focusedFolder) {
        container.style.display = "none";
        return;
    }
    container.style.display = "flex";
    container.innerHTML = "";

    const rootSpan = document.createElement("span");
    rootSpan.className = "breadcrumb-item";
    rootSpan.innerText = "root";
    rootSpan.onclick = () => {
        setFocusedFolderWithHistory("");
    };
    container.appendChild(rootSpan);

    if (focusedFolder === "(root files)/") {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-separator";
        sep.innerText = "/";
        container.appendChild(sep);

        const segmentSpan = document.createElement("span");
        segmentSpan.className = "breadcrumb-item";
        segmentSpan.innerText = "root files only";
        container.appendChild(segmentSpan);
        return;
    }

    const segments = focusedFolder.split("/").filter(Boolean);
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-separator";
        sep.innerText = "/";
        container.appendChild(sep);

        currentPath += segments[i] + "/";
        const pathRef = currentPath;

        const segmentSpan = document.createElement("span");
        segmentSpan.className = "breadcrumb-item";
        segmentSpan.innerText = segments[i];
        segmentSpan.onclick = () => {
            setFocusedFolderWithHistory(pathRef);
        };
        container.appendChild(segmentSpan);
    }
}

/** Returns the file list to render/hit-test against (currently unfiltered — all of data.files). */
function getFilteredFiles() {
    if (!data) return [];
    return data.files;
}

/**
 * Groups files by their immediate child subfolder relative to basePath.
 * Returns { folders: [{name, path, fileCount, files}], rootFiles: [file...] }.
 * Small folders (<= 2 files) are kept as rootFiles to avoid 1-file or 2-file folder cards.
 */
function getSubfolderGroups(files, basePath) {
    const groups = {};
    const rootFiles = [];
    const orderedItems = [];
    const seenFolders = new Set();

    for (const f of files) {
        const relPath = basePath ? f.path.substring(basePath.length) : f.path;
        const slashIdx = relPath.indexOf("/");
        if (slashIdx === -1) {
            rootFiles.push(f);
        } else {
            const folderName = relPath.substring(0, slashIdx);
            const folderPath = (basePath || "") + folderName + "/";
            if (!groups[folderPath]) {
                groups[folderPath] = { name: folderName, path: folderPath, folderPath: folderPath, fileCount: 0, files: [] };
            }
            groups[folderPath].fileCount++;
            groups[folderPath].files.push(f);
        }
    }

    const validFolders = new Set();
    for (const grp of Object.values(groups)) {
        if (grp.fileCount <= 2) {
            rootFiles.push(...grp.files);
        } else {
            validFolders.add(grp.path);
        }
    }

    for (const f of files) {
        const relPath = basePath ? f.path.substring(basePath.length) : f.path;
        const slashIdx = relPath.indexOf("/");
        if (slashIdx === -1) {
            orderedItems.push({ type: "file", file: f, id: f.id });
        } else {
            const folderName = relPath.substring(0, slashIdx);
            const folderPath = (basePath || "") + folderName + "/";
            if (validFolders.has(folderPath)) {
                if (!seenFolders.has(folderPath)) {
                    seenFolders.add(folderPath);
                    orderedItems.push({ type: "folder", card: groups[folderPath], id: "folder:" + folderPath });
                }
            } else {
                orderedItems.push({ type: "file", file: f, id: f.id });
            }
        }
    }

    const folders = Object.values(groups).filter(g => validFolders.has(g.path));
    return { folders, rootFiles, orderedItems };
}

/** Paints the loading/error status screen shown before repository data has arrived. */
function drawStatus() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = getThemeColor("--vscode-editor-background", "#18181c");
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    ctx.fillStyle = getThemeColor("--vscode-foreground", "#e1e1e6");
    ctx.font = "16px system-ui";
    ctx.fillText(statusText, 24, 74);

    ctx.fillStyle = getThemeColor("--vscode-descriptionForeground", "#707075");
    ctx.font = "12px system-ui";
    ctx.fillText("Waiting for repository data...", 24, 100);
}

/** Infers a coarse language id from a file path's extension, used to pick a tokenizer. */
function detectLang(path) {
    if (!path) return 'plaintext';
    const filename = path.split('/').pop().toLowerCase();
    if (filename === '.gitignore' || filename === 'license' || filename.startsWith('license.')) {
        return 'plaintext';
    }
    const ext = filename.includes('.') ? filename.split('.').pop() : '';
    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
    if (!ext || ext === 'txt' || ext === 'log' || ext === 'conf' || ext === 'ini' || ext === 'env') {
        return 'plaintext';
    }
    if (ext === 'css' || ext === 'scss' || ext === 'less') return 'css';
    if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg' || ext === 'vue') return 'html';
    if (ext === 'json' || ext === 'jsonc' || ext === 'json5' || filename.endsWith('rc') || filename.includes('json')) return 'json';
    if (ext === 'py') return 'python';
    return 'js';
}

/** Dispatches to one of five small regex-based tokenizers by detected language. */
function tokenizeLine(text, lang) {
    if (!text) return [];
    if (lang === 'plaintext') return [{ text, category: 'normal', isKey: false }];
    if (lang === 'markdown') return tokenizeMarkdown(text);
    if (lang === 'css') return tokenizeCSS(text);
    if (lang === 'html') return tokenizeHTML(text);
    if (lang === 'json') return tokenizeJSON(text);
    return tokenizeJS(text, lang);
}

/** Tokenizes a line of JSON into colorable spans, marking string tokens that precede a ':' as object keys. */
function tokenizeJSON(text) {
    const tokens = [];
    const regex = /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}()\[\]:,]|\s+|.)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const val = match[0];
        let cat = "normal";
        if (val.startsWith("//") || val.startsWith("/*")) {
            cat = "comment";
        } else if (val.startsWith('"') && val.endsWith('"') && val.length > 1) {
            cat = "string";
        } else if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(val)) {
            cat = "number";
        } else if (/^(true|false|null)$/.test(val)) {
            cat = "keyword";
        } else if (/^[{}()\[\]:,]$/.test(val)) {
            cat = "normal";
        }
        tokens.push({ text: val, category: cat, isKey: false });
    }

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].category === "string") {
            let n = i + 1;
            while (n < tokens.length && /^\s+$/.test(tokens[n].text)) n++;
            if (n < tokens.length && tokens[n].text === ":") {
                tokens[i].isKey = true;
            }
        }
    }
    return tokens;
}

/** Tokenizes a line of Markdown into colorable spans (headings, quotes, lists, emphasis, code, links). */
function tokenizeMarkdown(text) {
    const tokens = [];

    if (/^\s*(```|~~~)/.test(text)) {
        return [{ text, category: "keyword", isKey: false }];
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(text)) {
        return [{ text, category: "keyword", isKey: false }];
    }

    let remaining = text;

    const headerMatch = remaining.match(/^(#{1,6}\s*)/);
    if (headerMatch) {
        tokens.push({ text: headerMatch[1], category: "heading", isKey: false });
        remaining = remaining.slice(headerMatch[1].length);
    } else {
        const bqMatch = remaining.match(/^(\s*>\s*)/);
        if (bqMatch) {
            tokens.push({ text: bqMatch[1], category: "comment", isKey: false });
            remaining = remaining.slice(bqMatch[1].length);
        } else {
            const listMatch = remaining.match(/^(\s*(?:[-*+]|\d+\.)\s+)/);
            if (listMatch) {
                tokens.push({ text: listMatch[1], category: "keyword", isKey: false });
                remaining = remaining.slice(listMatch[1].length);
            }
        }
    }

    const regex = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<!\w)[*_][^*_]+[*_](?!\w)|\[[^\]]+\]\([^)]+\)|<\/?[a-zA-Z][^>]*>|\s+|[^\s`*_\[<]+)/g;
    let match;
    while ((match = regex.exec(remaining)) !== null) {
        const val = match[0];
        let cat = headerMatch ? "heading" : "normal";

        if (val.startsWith('`') && val.endsWith('`') && val.length > 1) {
            cat = "string";
        } else if (val.startsWith('**') || val.startsWith('__')) {
            cat = "keyword";
        } else if ((val.startsWith('*') || val.startsWith('_')) && val.length > 1 && (val.endsWith('*') || val.endsWith('_'))) {
            cat = "variable";
        } else if (val.startsWith('[') && val.includes('](')) {
            const splitIdx = val.indexOf('](');
            const label = val.slice(0, splitIdx + 1);
            const url = val.slice(splitIdx + 1);
            tokens.push({ text: label, category: "type", isKey: false });
            tokens.push({ text: url, category: "string", isKey: false });
            continue;
        } else if (val.startsWith('<') && val.endsWith('>')) {
            cat = "tag";
        }

        tokens.push({ text: val, category: cat, isKey: false });
    }

    return tokens.length > 0 ? tokens : [{ text, category: "normal", isKey: false }];
}

/**
 * Tokenizes a line of CSS into colorable spans. A single regex splits the line into
 * candidate tokens (comments/strings/@rules/colors/units/identifiers/punctuation), then
 * each token is classified by shape. A trailing pass re-labels a value/selector token as
 * "function" if it's immediately followed by "(" (e.g. `rgba(`, `calc(`).
 */
function tokenizeCSS(text) {
    const tokens = [];
    const regex = /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[\w-]+|!important|#[\da-fA-F]{3,8}\b|\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt)?|:[\w-]+|\.[\w-]+|[\w-]+|[{}();:,>+~\[\]*=]|\s+|.)/g;
    let match;
    let afterColon = false;
    const trimmed = text.trim();
    const isDecl = /[\w-]+\s*:/.test(trimmed);

    while ((match = regex.exec(text)) !== null) {
        const val = match[0];
        let cat = "normal";
        if (val.startsWith('/*')) { cat = "comment"; }
        else if (val.startsWith('"') || val.startsWith("'")) { cat = "string"; }
        else if (val.startsWith('@')) { cat = "control-flow"; }
        else if (val === '!important') { cat = "keyword"; }
        else if (val === ':') { cat = "normal"; afterColon = true; }
        else if (val === ';' || val === '{' || val === '}') { cat = "normal"; afterColon = false; }
        else if (/^#[\da-fA-F]{3,8}$/.test(val)) { cat = "number"; }
        else if (/^\d/.test(val)) { cat = "number"; }
        else if (val.startsWith(':')) { cat = "selector"; }
        else if (val.startsWith('.') && !afterColon) { cat = "selector"; }
        else if (/^[\w-]+$/.test(val)) {
            if (isDecl && !afterColon) { cat = "css-property"; }
            else if (afterColon) { cat = "css-value"; }
            else { cat = "selector"; }
        }
        tokens.push({ text: val, category: cat, isKey: false });
    }
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].category === 'css-value' || tokens[i].category === 'selector') {
            let n = i + 1;
            while (n < tokens.length && /^\s+$/.test(tokens[n].text)) n++;
            if (n < tokens.length && tokens[n].text === '(') tokens[i].category = 'function';
        }
    }
    return tokens;
}

/**
 * Tokenizes a line of HTML into colorable spans. Same single-regex-then-classify approach
 * as tokenizeCSS, tracking a small bit of state (inTag/seenTagName) across matches to tell
 * a tag name from an attribute name.
 */
function tokenizeHTML(text) {
    const tokens = [];
    const regex = /(<!--[\s\S]*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<\/?|\/?>|=|&\w+;|[\w:-]+|\s+|.)/g;
    let match;
    let inTag = false;
    let seenTagName = false;
    while ((match = regex.exec(text)) !== null) {
        const val = match[0];
        let cat = "normal";
        if (val.startsWith('<!--')) {
            cat = "comment"; // HTML comments <!-- --> (green #6a9955)
        } else if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
            (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
            cat = "string"; // Attribute values "val" (orange #ce9178)
        } else if (val === '<' || val === '</' || val === '>' || val === '/>' || val === '=') {
            cat = "tag-bracket"; // Brackets & equals < > </ /> = (gray #808080)
            if (val === '<' || val === '</') {
                inTag = true;
                seenTagName = false;
            }
            if (val === '>' || val === '/>') {
                inTag = false;
            }
        } else if (inTag && /^[\w:-]+$/.test(val)) {
            cat = seenTagName ? "attribute" : "tag"; // Tag name (blue #569cd6) vs Attribute name (cyan #9cdcfe)
            seenTagName = true;
        } else if (val.startsWith('&') && val.endsWith(';')) {
            cat = "keyword"; // HTML Entities &nbsp; (purple/blue #c586c0)
        }

        tokens.push({ text: val, category: cat, isKey: false });
    }
    return tokens;
}

/**
 * Tokenizes a line of JS/TS/most C-like languages (plus a separate Python keyword list)
 * into colorable spans, picked by a single shared regex per lang (JSON reuses this path).
 * After the initial token pass, a second loop re-labels tokens using their neighbors:
 * identifier-after-"." becomes "property", identifier-before-"(" becomes "function", and
 * (JSON only) a string immediately before ":" becomes a highlighted key.
 */
function tokenizeJS(text, lang) {
    const isJson = lang === 'json';
    const isPy = lang === 'python';
    const regex = isPy
        ? /(#.*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:class|def|lambda|import|from|as|if|elif|else|for|while|return|try|except|finally|raise|with|yield|pass|break|continue|and|or|not|in|is|True|False|None|self|async|await|global|nonlocal)\b|\b\d+\b|[+\-*\/%=<>!&|^~:@]+|\w+|\s+|.)/g
        : /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:class|interface|struct|impl|type|enum|function|def|fn|func|const|let|var|this|self|import|export|from|using|require|if|else|elif|for|while|return|switch|case|break|continue|try|catch|finally|public|private|protected|async|await|void|int|float|double|char|string|boolean|bool|any|number|package|module|namespace|new|null|undefined|true|false|typeof|instanceof)\b|\b\d+\b|[+\-*\/%=<>!&|^~:]+|\w+|\s+|.)/g;

    let match;
    const tokens = [];
    while ((match = regex.exec(text)) !== null) {
        const val = match[0];
        let cat = "normal";
        if (val.startsWith("//") || (isPy && val.startsWith("#")) || val.startsWith("/*")) { cat = "comment"; }
        else if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
            (val.startsWith("'") && val.endsWith("'") && val.length > 1) ||
            (val.startsWith("`") && val.endsWith("`") && val.length > 1) ||
            val.startsWith('"""') || val.startsWith("'''")) { cat = "string"; }
        else if (/^\d+$/.test(val)) { cat = "number"; }
        else if (/^(if|else|elif|for|while|return|switch|case|break|continue|try|catch|except|finally|raise|with|yield|pass|and|or|not|in|is)$/.test(val)) { cat = "control-flow"; }
        else if (/^(class|interface|struct|impl|type|enum|function|def|fn|func|const|let|var|this|self|import|export|from|using|require|public|private|protected|async|await|void|int|float|double|char|string|boolean|bool|any|number|package|module|namespace|new|null|undefined|true|false|typeof|instanceof|lambda|global|nonlocal|as|True|False|None)$/.test(val)) { cat = "keyword"; }
        else if (/^[+\-*\/%=<>!&|^~:@]+$/.test(val)) { cat = "operator"; }
        else if (/^\w+$/.test(val)) { cat = /^[A-Z]/.test(val) ? "type" : "variable"; }

        if (cat === "comment") {
            const parts = val.split(/(@\w+)/g);
            for (const p of parts) {
                if (p.startsWith("@")) tokens.push({ text: p, category: "keyword", isKey: false });
                else if (p) tokens.push({ text: p, category: "comment", isKey: false });
            }
        } else {
            tokens.push({ text: val, category: cat, isKey: false });
        }
    }

    for (let i = 0; i < tokens.length; i++) {
        // Property access: word after .
        if (tokens[i].text === "." && i + 1 < tokens.length &&
            (tokens[i + 1].category === "variable" || tokens[i + 1].category === "type")) {
            tokens[i + 1].category = "property";
        }
        // Function declarations & calls: word before ( or word after function/def/fn
        if (tokens[i].category === "variable" || tokens[i].category === "type" || tokens[i].category === "property" || tokens[i].category === "keyword") {
            let n = i + 1;
            while (n < tokens.length && /^\s+$/.test(tokens[n].text)) n++;
            if (n < tokens.length && tokens[n].text === "(") {
                tokens[i].category = "function";
            }
            if ((tokens[i].text === "function" || tokens[i].text === "def" || tokens[i].text === "fn" || tokens[i].text === "func") && n < tokens.length) {
                if (tokens[n].category === "variable" || tokens[n].category === "type" || tokens[n].category === "property") {
                    tokens[n].category = "function";
                }
            }
        }
        // JSON string keys
        if (isJson && tokens[i].category === "string") {
            let n = i + 1;
            while (n < tokens.length && /^\s+$/.test(tokens[n].text)) n++;
            if (n < tokens.length && tokens[n].text === ":") tokens[i].isKey = true;
        }
        // JS object keys: variable before :
        if (!isJson && tokens[i].category === "variable") {
            let n = i + 1;
            while (n < tokens.length && /^\s+$/.test(tokens[n].text)) n++;
            if (n < tokens.length && tokens[n].text === ":") tokens[i].category = "property";
        }
    }
    return tokens;
}

/** Maps a token's syntax category (and isKey flag) to the hex color used to draw it. */
function colorForCategory(category, isKey) {
    if (isKey) return THEME_CATEGORY_COLORS["key"] || (isLightTheme() ? "#001080" : "#9cdcfe");
    return THEME_CATEGORY_COLORS[category] || THEME_CATEGORY_COLORS["default"] || "#cccccc";
}

let imageCache = {}; // keyed by media URI; cleared on repository data updates (see "data" handler)

/** Draws img into the x,y,w,h rect scaled to fit while preserving its aspect ratio (object-fit: contain), background-filling the rest. */
function drawAspectFit(ctx, img, x, y, w, h, bgStyle = null) {
    const fillBg = bgStyle || (MEDIA_CONFIG ? MEDIA_CONFIG.tileBackground : "#1e1e24");
    const imgWidth = img.naturalWidth || img.width;
    const imgHeight = img.naturalHeight || img.height;

    if (!imgWidth || !imgHeight) {
        ctx.drawImage(img, x, y, w, h);
        return;
    }

    const imgAspect = imgWidth / imgHeight;
    const containerAspect = w / h;

    let drawW, drawH;
    if (imgAspect > containerAspect) {
        drawW = w;
        drawH = w / imgAspect;
    } else {
        drawH = h;
        drawW = h * imgAspect;
    }

    const drawX = x + (w - drawW) / 2;
    const drawY = y + (h - drawH) / 2;

    ctx.fillStyle = fillBg;
    ctx.fillRect(x, y, w, h);
    ctx.drawImage(img, drawX, drawY, drawW, drawH);
}

const THUMBNAIL_MAX_LINE_PITCH = 16;
const THUMBNAIL_MAX_LINE_CHARS = 100;
const THUMBNAIL_MIN_AVG_CHARS = 45;
const THUMBNAIL_DEFAULT_AVG_CHARS = 65;
const THUMBNAIL_SAMPLE_LINE_LIMIT = 50;
const THUMBNAIL_WIDTH_BUDGET_FACTOR = 0.92;
const THUMBNAIL_CHAR_ASPECT_RATIO = 0.58;
const THUMBNAIL_LINE_HEIGHT_RATIO = 0.88;
const THUMBNAIL_MAX_FONT_SIZE = 13;
const THUMBNAIL_MIN_FONT_SIZE = 3.2;
const THUMBNAIL_MIN_TEXT_PITCH = 1.5;
const THUMBNAIL_INDENT_MAX_RATIO = 0.4;
const THUMBNAIL_LINE_WIDTH_RATIO = 0.7;
const THUMBNAIL_TEXT_VERTICAL_RATIO = 0.85;
const THUMBNAIL_TEXT_FONT_RATIO = 0.95;
const THUMBNAIL_BLOCK_MIN_HEIGHT = 0.7;
const THUMBNAIL_SEARCH_MATCH_HEIGHT = 2.0;
const THUMBNAIL_GIT_LINE_MIN_HEIGHT = 1.5;
const THUMBNAIL_GIT_GUTTER_WIDTH = 2.5;
const THUMBNAIL_GIT_DELETED_HEIGHT = 2.0;
const THUMBNAIL_VIEWPORT_MIN_HEIGHT = 4.0;

const GIT_STYLES = {
    modifiedBg: "rgba(59, 130, 246, 0.14)",
    modifiedGutter: "rgba(59, 130, 246, 0.75)",
    addedBg: "rgba(34, 197, 94, 0.14)",
    addedGutter: "rgba(34, 197, 94, 0.75)",
    deletedLine: "rgba(239, 68, 68, 0.85)",
    badgeModified: "#3b82f6",
    badgeAdded: "#22c55e",
};

const ERROR_STYLES = {
    errorBg: "rgba(239, 68, 68, 0.22)",
    errorGutter: "rgba(239, 68, 68, 0.85)",
    badgeError: "#ef4444",
};

const THEME_COLORS = {
    tileBackground: getThemeColor("--vscode-editor-background", "#1e1e24"),
    imageTileBackground: getThemeColor("--vscode-editorWidget-background", "#252526"),
    imageTilePlaceholderText: getThemeColor("--vscode-descriptionForeground", "#858585"),
    pdfHeaderBar: getThemeColor("--vscode-badge-background", "#4d4d4d"),
    pdfHeaderForeground: getThemeColor("--vscode-badge-foreground", "#ffffff"),
    pdfPlaceholderLine: getThemeColor("--vscode-widget-border", "rgba(255, 255, 255, 0.25)"),
    searchMatchHighlight: withAlpha(ACCENT_SEARCH, 0.28),
    activeFocusHighlight: getThemeColor("--vscode-focusBorder", "#007fd4"),
    viewportBandOverlay: "rgba(255, 255, 255, 0.08)",
};

const PDF_PREVIEW = {
    barHeight: 14,
    labelFont: "9px system-ui, sans-serif",
    labelOffsetX: 6,
    labelOffsetY: 10,
    mockLinePitch: 4,
    mockLineHeight: 2,
    mockLineStartOffsetY: 18,
    mockLinePaddingX: 12,
    mockLineContentOffset: 6,
    maxMockLines: 12,
};

// MARK: drawThumbnail
/**
 * Draws one file's thumbnail into the given cell rect, one row per source line scaled to
 * fit the cell height (stepY).
 */
function drawThumbnail(file, x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    if (file.isImage) {
        const shouldRenderMedia = data && data.renderMediaThumbnails !== false;
        if (shouldRenderMedia && file.mediaUri) {
            if (!imageCache[file.mediaUri]) {
                const img = new Image();
                const cacheBuster = (file.mediaUri.includes("?") ? "&" : "?") + "v=" + Date.now();
                img.src = file.mediaUri + cacheBuster;
                img.onload = () => render();
                imageCache[file.mediaUri] = img;
            }
            const img = imageCache[file.mediaUri];
            if (img.complete && img.naturalWidth > 0) {
                drawAspectFit(ctx, img, x, y, w, h);
                ctx.restore();
                return;
            }
        }
        ctx.fillStyle = THEME_COLORS.imageTileBackground;
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = THEME_COLORS.imageTilePlaceholderText;
        ctx.font = "10px system-ui";
        ctx.fillText("[Image]", x + 6, y + h / 2);
        ctx.restore();
        return;
    }

    if (file.isPdf) {
        const shouldRenderMedia = data && data.renderMediaThumbnails !== false;
        if (shouldRenderMedia && file.mediaUri) {
            if (!imageCache[file.mediaUri]) {
                if (typeof pdfjsLib !== "undefined") {
                    imageCache[file.mediaUri] = "loading";
                    if (window.PDF_WORKER_URI) {
                        pdfjsLib.GlobalWorkerOptions.workerSrc = window.PDF_WORKER_URI;
                    }
                    const loadingTask = pdfjsLib.getDocument({
                        url: file.mediaUri,
                        withCredentials: false
                    });
                    loadingTask.promise.then(pdf => {
                        return pdf.getPage(1);
                    }).then(page => {
                        const viewport = page.getViewport({ scale: 0.5 });
                        const pdfCanvas = document.createElement("canvas");
                        const pdfCtx = pdfCanvas.getContext("2d");
                        pdfCanvas.width = viewport.width;
                        pdfCanvas.height = viewport.height;
                        const renderContext = {
                            canvasContext: pdfCtx,
                            viewport: viewport
                        };
                        return page.render(renderContext).promise.then(() => {
                            const img = new Image();
                            img.onload = () => {
                                imageCache[file.mediaUri] = img;
                                render();
                            };
                            img.onerror = () => {
                                imageCache[file.mediaUri] = "error";
                            };
                            img.src = pdfCanvas.toDataURL("image/jpeg", 0.7);
                        });
                    }).catch(err => {
                        console.error("PDF RENDER ERROR:", err);
                        imageCache[file.mediaUri] = "error";
                    });
                }
            }
            const cachedPdfImg = imageCache[file.mediaUri];
            if (cachedPdfImg && cachedPdfImg !== "error" && cachedPdfImg !== "loading" && cachedPdfImg.complete && cachedPdfImg.naturalWidth > 0) {
                drawAspectFit(ctx, cachedPdfImg, x, y, w, h);
                ctx.restore();
                return;
            }
        }

        ctx.fillStyle = THEME_COLORS.tileBackground;
        ctx.fillRect(x, y, w, h);

        ctx.fillStyle = THEME_COLORS.pdfHeaderBar;
        ctx.fillRect(x, y, w, PDF_PREVIEW.barHeight);
        ctx.fillStyle = THEME_COLORS.pdfHeaderForeground;
        ctx.font = PDF_PREVIEW.labelFont;
        ctx.fillText("PDF - Page 1", x + PDF_PREVIEW.labelOffsetX, y + PDF_PREVIEW.labelOffsetY);

        ctx.fillStyle = THEME_COLORS.pdfPlaceholderLine;
        const availableMockHeight = h - PDF_PREVIEW.barHeight - PDF_PREVIEW.labelOffsetX;
        const maxMockLines = Math.min(PDF_PREVIEW.maxMockLines, Math.floor(availableMockHeight / PDF_PREVIEW.mockLinePitch));
        for (let pLine = 0; pLine < maxMockLines; pLine++) {
            const lineW = ((pLine * 37) % 60 + 35) / 100 * (w - PDF_PREVIEW.mockLinePaddingX);
            ctx.fillRect(x + PDF_PREVIEW.mockLineContentOffset, y + PDF_PREVIEW.mockLineStartOffsetY + pLine * PDF_PREVIEW.mockLinePitch, lineW, PDF_PREVIEW.mockLineHeight);
        }

        ctx.restore();
        return;
    }

    const lines = file.lines || [];
    const lineCount = Math.max(lines.length, 1);
    const stepY = Math.min(h / lineCount, THUMBNAIL_MAX_LINE_PITCH);
    const maxLineChars = THUMBNAIL_MAX_LINE_CHARS;

    const targetLineChars = Math.min(maxLineChars, Math.max(THUMBNAIL_MIN_AVG_CHARS, file._avgLineChars || THUMBNAIL_DEFAULT_AVG_CHARS));
    const fontForWidth = (w * THUMBNAIL_WIDTH_BUDGET_FACTOR) / (targetLineChars * THUMBNAIL_CHAR_ASPECT_RATIO);
    const fontForHeight = stepY * THUMBNAIL_LINE_HEIGHT_RATIO;
    const rawFontSize = Math.min(fontForHeight, fontForWidth, THUMBNAIL_MAX_FONT_SIZE);
    const fontSize = Math.max(THUMBNAIL_MIN_FONT_SIZE, Math.floor(rawFontSize * 10) / 10);
    const useText = fontSize >= THUMBNAIL_MIN_FONT_SIZE && stepY >= THUMBNAIL_MIN_TEXT_PITCH;

    if (useText) {
        ctx.font = `${fontSize}px Consolas, "Courier New", monospace`;
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineText = line?.text || "";

        let isMatchedLine = false;
        if (rawSearchQuery && !searchInvalid && lineText) {
            if (file.fullLines && file.lineCount > lines.length) {
                const step = file.lineCount / lines.length;
                const startLineIdx = Math.floor(i * step);
                const endLineIdx = Math.min(Math.floor((i + 1) * step), file.fullLines.length);
                for (let fullI = startLineIdx; fullI < endLineIdx; fullI++) {
                    const orig = file.fullLines[fullI];
                    const lower = file._lowerFullLines ? file._lowerFullLines[fullI] : orig.toLowerCase();
                    if (textMatches(orig, lower)) {
                        isMatchedLine = true;
                        break;
                    }
                }
            } else {
                const lower = line._lowerText !== undefined ? line._lowerText : lineText.toLowerCase();
                isMatchedLine = textMatches(lineText, lower);
            }
        }

        let isErrorLine = false;
        if (file.errorLines) {
            if (file.lineCount && file.lineCount > lines.length) {
                const step = file.lineCount / lines.length;
                const startLineIdx = Math.floor(i * step);
                const endLineIdx = Math.max(startLineIdx + 1, Math.min(Math.floor((i + 1) * step), file.lineCount));
                for (let fullI = startLineIdx; fullI < endLineIdx; fullI++) {
                    if (file.errorLines[fullI]) {
                        isErrorLine = true;
                        break;
                    }
                }
            } else {
                isErrorLine = !!file.errorLines[i];
            }
        }

        const gitType = (file.gitStatus === "untracked" || file.gitStatus === "added")
            ? "added"
            : (file.gitChanges ? file.gitChanges[i] : undefined);

        if (isMatchedLine) {
            ctx.fillStyle = THEME_COLORS.searchMatchHighlight;
            ctx.fillRect(
                x,
                y + i * stepY,
                w,
                Math.max(stepY, THUMBNAIL_SEARCH_MATCH_HEIGHT)
            );
            ctx.fillStyle = ACCENT_SEARCH;
            ctx.fillRect(
                x,
                y + i * stepY,
                THUMBNAIL_GIT_GUTTER_WIDTH,
                Math.max(stepY, THUMBNAIL_SEARCH_MATCH_HEIGHT)
            );
        } else if (isErrorLine) {
            ctx.fillStyle = ERROR_STYLES.errorBg;
            ctx.fillRect(x, y + i * stepY, w, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
            ctx.fillStyle = ERROR_STYLES.errorGutter;
            ctx.fillRect(x, y + i * stepY, THUMBNAIL_GIT_GUTTER_WIDTH, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
        } else if (gitType === "modified") {
            ctx.fillStyle = GIT_STYLES.modifiedBg;
            ctx.fillRect(x, y + i * stepY, w, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
            ctx.fillStyle = GIT_STYLES.modifiedGutter;
            ctx.fillRect(x, y + i * stepY, THUMBNAIL_GIT_GUTTER_WIDTH, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
        } else if (gitType === "added") {
            ctx.fillStyle = GIT_STYLES.addedBg;
            ctx.fillRect(x, y + i * stepY, w, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
            ctx.fillStyle = GIT_STYLES.addedGutter;
            ctx.fillRect(x, y + i * stepY, THUMBNAIL_GIT_GUTTER_WIDTH, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
        } else if (gitType === "removed") {
            ctx.fillStyle = GIT_STYLES.deletedLine;
            const triY = y + i * stepY;
            const triH = Math.max(stepY, 3);
            const triW = THUMBNAIL_GIT_GUTTER_WIDTH + 1.5;
            ctx.beginPath();
            ctx.moveTo(x, triY);
            ctx.lineTo(x + triW, triY + triH / 2);
            ctx.lineTo(x, triY + triH);
            ctx.closePath();
            ctx.fill();
        }

        if (!line || !lineText) {
            continue;
        }

        const indent = line.indent || 0;
        const startX = x + Math.min(indent / maxLineChars, THUMBNAIL_INDENT_MAX_RATIO) * w;
        const trimmedText = lineText.trimStart();
        const lineTextLength = trimmedText.length;
        if (lineTextLength === 0) {
            continue;
        }

        const lineW = Math.min(lineTextLength / maxLineChars, 1.0) * w * THUMBNAIL_LINE_WIDTH_RATIO;
        const tokens = line._tokens || tokenizeLine(trimmedText, detectLang(file.path));
        const totalTextChars = Math.max(lineTextLength, 1);

        let currentX = startX;
        for (const tok of tokens) {
            if (currentX >= x + w) break;

            ctx.fillStyle = colorForCategory(tok.category, tok.isKey);
            if (useText) {
                ctx.fillText(tok.text, currentX, y + i * stepY + Math.min(stepY * THUMBNAIL_TEXT_VERTICAL_RATIO, fontSize * THUMBNAIL_TEXT_FONT_RATIO));
                currentX += ctx.measureText(tok.text).width;
            } else {
                const tokLen = tok.text.length;
                const tokW = (tokLen / totalTextChars) * lineW;

                ctx.fillRect(
                    currentX,
                    y + i * stepY,
                    Math.min(tokW, x + w - currentX),
                    Math.max(stepY, THUMBNAIL_BLOCK_MIN_HEIGHT)
                );
                currentX += tokW;
            }
        }
    }

    // Highlight editor visible viewport range in transparent gray overlay if file is open
    const isFileOpen = openFiles.includes(file.uri);
    if (isFileOpen && (file.uri in viewLocations)) {
        const totalRealLines = Math.max(file.lineCount || lines.length, 1);
        const viewLoc = viewLocations[file.uri];
        const startL = Math.max(0, Math.min(viewLoc.startLine, totalRealLines - 1));
        const endL = Math.max(startL, Math.min(viewLoc.endLine, totalRealLines - 1));

        const startRatio = startL / totalRealLines;
        const endRatio = (endL + 1) / totalRealLines;

        const thumbnailY = y;
        const thumbnailH = h;

        const bandY = thumbnailY + startRatio * thumbnailH;
        const bandH = Math.max((endRatio - startRatio) * thumbnailH, THUMBNAIL_VIEWPORT_MIN_HEIGHT);

        // Store bounding rect of view band on cell for click detection
        file._cell._viewBand = {
            y: bandY,
            h: bandH
        };

        ctx.fillStyle = THEME_COLORS.viewportBandOverlay;
        ctx.fillRect(
            x,
            bandY,
            w,
            Math.min(bandH, thumbnailY + thumbnailH - bandY)
        );
    } else if (file._cell) {
        delete file._cell._viewBand;
    }

    ctx.restore();
}

/**
 * Truncates a file path to fit maxWidth, preferring to drop leading directory segments
 * ("...dir/file.ts") over the filename itself. Binary-searches the cut point in the
 * directory portion rather than trimming a character at a time, since ctx.measureText
 * is comparatively expensive and this runs once per visible card per frame.
 */
function fitPathText(path, maxWidth) {
    if (ctx.measureText(path).width <= maxWidth) {
        return path;
    }
    const parts = path.split("/");
    const filename = parts.pop();
    const directory = parts.join("/");

    if (ctx.measureText(filename).width > maxWidth) {
        let fitName = filename;
        while (fitName.length > 0 && ctx.measureText(fitName + "...").width > maxWidth) {
            fitName = fitName.slice(0, -1);
        }
        return fitName + "...";
    }

    let left = 1;
    let right = directory.length;
    let bestFit = "..." + filename;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const candidate = directory.substring(0, mid) + "..." + filename;
        if (ctx.measureText(candidate).width <= maxWidth) {
            bestFit = candidate;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return bestFit;
}

// MARK: drawBorder
const TILE_PADDING = 4;       // inset from cell edge to the card's fill/stroke rect
const TILE_DIM_ALPHA = 0.15;  // opacity applied when a tile is unfocused or being dragged
const TILE_LABEL_FONT = "10px system-ui, sans-serif";
const TILE_LABEL_OFFSET_X = 10;
const TILE_LABEL_OFFSET_Y = 18;
const TILE_LABEL_WIDTH_MARGIN = 36; // reserved space so the label doesn't run under the close button
const TILE_THUMBNAIL_OFFSET_X = 10;
const TILE_THUMBNAIL_OFFSET_Y = 24;
const TILE_THUMBNAIL_WIDTH_MARGIN = 20;
const TILE_THUMBNAIL_HEIGHT_MARGIN = 34;

/** Strokes a tile's priority-ordered border: search match > active > open > default. */
function drawTileBorder(x, y, w, h, isSearchMatch, isActive, isOpen) {
    const style = isSearchMatch ? BORDER_STYLES.searchMatch
        : isActive ? BORDER_STYLES.active
        : isOpen ? BORDER_STYLES.open
        : BORDER_STYLES.default;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.strokeRect(x + TILE_PADDING, y + TILE_PADDING, w - TILE_PADDING * 2, h - TILE_PADDING * 2);
}

// MARK: drawCloseBtn
const CLOSE_BTN_SIZE = 12;
const CLOSE_BTN_MARGIN_RIGHT = 20;
const CLOSE_BTN_MARGIN_TOP = 10;
const CLOSE_BTN_GLYPH_Y_OFFSET = 8;
const CLOSE_BTN_FONT = "12px system-ui, sans-serif";

/** Draws the '×' close button on an open tile and stores its hit-box on file._closeBtn. */
function drawCloseBtn(file, x, y, w) {
    const closeBtnX = x + w - CLOSE_BTN_MARGIN_RIGHT;
    const closeBtnY = y + CLOSE_BTN_MARGIN_TOP;
    file._closeBtn = { x: closeBtnX, y: closeBtnY, w: CLOSE_BTN_SIZE, h: CLOSE_BTN_SIZE };

    ctx.fillStyle = CLOSE_BTN_COLOR;
    ctx.font = CLOSE_BTN_FONT;
    ctx.fillText("×", closeBtnX, closeBtnY + CLOSE_BTN_GLYPH_Y_OFFSET);
}

// MARK: drawFileTile
/** Draws one file's tile: background, border, label, close button, and thumbnail; stores file._cell for hit-testing and dims the tile if dimForFocus is set or it's the file currently being dragged. */
function drawFileTile(file, x, y, w, h, dimForFocus) {
    file._cell = { x, y, w, h };

    const queryActive = !!searchQuery && !searchInvalid;
    const isSearchMatch = queryActive && textMatches(file._combinedTextOriginal, file._combinedText);
    const isActive = file.uri === activeFileUri;
    const isOpen = openFilesSet.has(file.uri);

    ctx.save();
    if (dimForFocus || file === draggingFile) {
        ctx.globalAlpha = TILE_DIM_ALPHA;
    }

    ctx.fillStyle = TILE_BACKGROUND;
    ctx.fillRect(x + TILE_PADDING, y + TILE_PADDING, w - TILE_PADDING * 2, h - TILE_PADDING * 2);

    drawTileBorder(x, y, w, h, isSearchMatch, isActive, isOpen);

    let labelColor = TILE_LABEL_COLOR.normal;
    if (isSearchMatch) {
        labelColor = TILE_LABEL_COLOR.searchMatch;
    } else if (file.hasError) {
        labelColor = TILE_LABEL_COLOR.error;
    } else if (file.gitStatus === "modified") {
        labelColor = TILE_LABEL_COLOR.modified;
    } else if (file.gitStatus === "added" || file.gitStatus === "untracked") {
        labelColor = TILE_LABEL_COLOR.added;
    } else if (isActive) {
        labelColor = TILE_LABEL_COLOR.active;
    }

    ctx.fillStyle = labelColor;
    ctx.font = TILE_LABEL_FONT;

    const maxLabelWidth = isOpen ? (w - TILE_LABEL_WIDTH_MARGIN) : (w - 16);
    if (file._lastCellW !== w || !file._fittedLabel) {
        file._lastCellW = w;
        file._fittedLabel = fitPathText(file.path, maxLabelWidth);
    }
    ctx.fillText(file._fittedLabel, x + TILE_LABEL_OFFSET_X, y + TILE_LABEL_OFFSET_Y);

    if (isOpen) {
        drawCloseBtn(file, x, y, w);
    } else {
        delete file._closeBtn;
    }

    drawThumbnail(
        file,
        x + TILE_THUMBNAIL_OFFSET_X,
        y + TILE_THUMBNAIL_OFFSET_Y,
        Math.max(1, w - TILE_THUMBNAIL_WIDTH_MARGIN),
        Math.max(1, h - TILE_THUMBNAIL_HEIGHT_MARGIN)
    );

    ctx.restore();
}

// MARK: render
/** Redraws the whole canvas for the current data/filter/search/drag state — clears, computes grid geometry, then dispatches to one of three per-tile rendering modes (subfolder cards, folder drill-down, or the normal root grid). */
function render() {
    if (!ctx) {
        return;
    }

    const rectW = canvas.clientWidth || window.innerWidth;
    const rectH = canvas.clientHeight || window.innerHeight;

    if (rectW < 200 || rectH < 200) {
        // Tab container is transitionally backgrounded or hidden
        if (!resizeRafId) {
            resizeRafId = requestAnimationFrame(() => {
                resizeRafId = null;
                render();
            });
        }
        return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.floor(rectW * dpr);
    const targetH = Math.floor(rectH * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        dragBackgroundCanvas = null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (themeTokensDirty) {
        refreshThemeTokens();
    }
    const light = isLightTheme();

    if ((draggingFile || draggingFolder) && dragBackgroundCanvas) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(dragBackgroundCanvas, 0, 0);
        ctx.restore();
        drawDragOverlays();
        return;
    }

    if (!data) {
        drawStatus();
        return;
    }

    ctx.clearRect(0, 0, rectW, rectH);
    ctx.fillStyle = getThemeColor("--vscode-editor-background", light ? "#f8f8f8" : "#18181c");
    ctx.fillRect(0, 0, rectW, rectH);

    const filteredFiles = getFilteredFiles();
    if (filteredFiles.length === 0) {
        ctx.fillStyle = getThemeColor("--vscode-descriptionForeground", light ? "#717171" : "#707075");
        ctx.font = "14px system-ui";
        ctx.fillText("No files match the active folder or search query.", 24, 80);
        return;
    }

    // At root, use the host's own layout/slots (data.layout, file.slot) as sent in the
    // "data" message — supports both uniform_grid and spanning_grid modes. Once a
    // folder is focused, that's a subset the host never laid out, so it's repacked
    // on the fly with the local buildStableGrid duplicate (uniform_grid shape only).
    // Use the host-assigned layout geometry and slots (file.slot) for all views so
    // grid geometry and cell slots remain 100% stable when files or subfolders are ignored.
    const gridCols = data.layout.cols;
    const gridRows = data.layout.rows;

    const availableW = rectW - (GRID_SIDE_MARGIN * 2);
    const availableH = rectH - GRID_TOP_MARGIN - GRID_BOTTOM_MARGIN;
    const overviewAspect = availableW / Math.max(1, availableH);

    const rootCellW = availableW / gridCols;
    const rootCellH = availableH / gridRows;

    const MIN_CELL_W = data && typeof data.minCellWidth === "number" ? data.minCellWidth : 60;
    const MIN_CELL_H = data && typeof data.minCellHeight === "number" ? data.minCellHeight : 40;

    let hasTallFileOverflow = false;
    if (data && data.files) {
        for (let i = 0; i < data.files.length; i++) {
            const f = data.files[i];
            const slot = f.slot;
            const nCells = f.nCells || 1;
            const fileH = rootCellH * nCells;
            if (fileH > availableH) {
                hasTallFileOverflow = true;
                break;
            }
            if (slot && typeof slot[1] === "number") {
                const y = GRID_TOP_MARGIN + slot[1] * rootCellH;
                if (y + fileH > rectH || y > rectH) {
                    hasTallFileOverflow = true;
                    break;
                }
            }
        }
    }

    const rootCellsTooSmall = rootCellW < MIN_CELL_W || rootCellH < MIN_CELL_H || hasTallFileOverflow;

    // If root tiles are NOT too small (rootCellsTooSmall === false), individual file tiles
    // are visible in their stable root grid slots — selecting a directory lowlights non-selected files.
    // If root tiles ARE too small (rootCellsTooSmall === true), directories have shrunk into
    // folder thumbnail cards — selecting a directory opens/drills down into that folder.
    const shouldOpenFolder = !!(focusedFolder && rootCellsTooSmall);

    const scopedFiles = shouldOpenFolder
        ? data.files.filter(f => f.path && (focusedFolder === "(root files)/" ? !f.path.includes("/") : f.path.startsWith(focusedFolder)))
        : data.files;

    let cellsTooSmall = false;
    let localFolderGrid = null;
    let localSpanningLayout = null;
    let folderCellW = rootCellW;
    let folderCellH = rootCellH;

    const extraCols = (data && data.extraCols) || 0;
    const extraRows = (data && data.extraRows) || 0;
    const isSpanningMode = data && (data.mode === "spanning_grid" || data.layoutMode === "spanning_grid");

    if (shouldOpenFolder) {
        const folderOrder = (data && data.folderOrders && data.folderOrders[focusedFolder]) || null;
        if (isSpanningMode) {
            localSpanningLayout = buildSpanningGridLocal(scopedFiles, overviewAspect, folderOrder, extraCols, extraRows);
            folderCellW = availableW / Math.max(1, localSpanningLayout.cols);
            folderCellH = availableH / Math.max(1, localSpanningLayout.rows);
            let hasDrillDownOverflow = false;
            for (const p of localSpanningLayout.placements) {
                const pfH = p.nCells * folderCellH;
                if (pfH > availableH || GRID_TOP_MARGIN + (p.row + p.nCells) * folderCellH > rectH) {
                    hasDrillDownOverflow = true;
                    break;
                }
            }
            cellsTooSmall = folderCellW < MIN_CELL_W || folderCellH < MIN_CELL_H || hasDrillDownOverflow;
        } else {
            let totalSlots = scopedFiles.length;
            if (folderOrder && Array.isArray(folderOrder) && folderOrder.length > 0) {
                const seenIds = new Set(folderOrder.filter(Boolean));
                const newFilesCount = scopedFiles.filter(f => !seenIds.has(f.id)).length;
                const holesCount = folderOrder.filter(id => !id).length;
                const appendCount = Math.max(0, newFilesCount - holesCount);
                totalSlots = Math.max(scopedFiles.length, folderOrder.length + appendCount);
            }
            localFolderGrid = buildStableGrid(totalSlots, overviewAspect);
            const folderCols = localFolderGrid.cols + extraCols;
            const folderRows = localFolderGrid.rows + extraRows;
            folderCellW = availableW / Math.max(1, folderCols);
            folderCellH = availableH / Math.max(1, folderRows);
            cellsTooSmall = folderCellW < MIN_CELL_W || folderCellH < MIN_CELL_H;
        }
    } else {
        cellsTooSmall = rootCellsTooSmall;
    }

    const queryActive = !!searchQuery && !searchInvalid;

    // Clear stale cell bounding boxes and folder card refs across all files
    for (const f of data.files) {
        delete f._cell;
    }
    // Clear previous folder card click targets
    if (!data._folderCards) data._folderCards = [];
    data._folderCards.length = 0;

    if (cellsTooSmall) {
        // Subfolder card mode: group files into immediate child folders and render each as a clickable card.
        const { folders, rootFiles, orderedItems } = getSubfolderGroups(scopedFiles, focusedFolder === "(root files)/" ? "" : focusedFolder);

        let displayItems = [];
        const itemById = new Map(orderedItems.map(it => [it.id, it]));
        if (data.cardOrder && Array.isArray(data.cardOrder) && data.cardOrder.length > 0) {
            const seenIds = new Set();
            for (const cid of data.cardOrder) {
                if (!cid) {
                    displayItems.push(null);
                } else {
                    const it = itemById.get(cid);
                    if (it) {
                        displayItems.push(it);
                        seenIds.add(cid);
                    } else {
                        displayItems.push(null);
                    }
                }
            }
            for (const it of orderedItems) {
                if (!seenIds.has(it.id)) {
                    displayItems.push(it);
                }
            }
        } else {
            displayItems = orderedItems;
        }

        const totalItems = displayItems.length;
        if (totalItems === 0) return;

        const baseGrid = buildStableGrid(totalItems, overviewAspect);
        const cardCols = baseGrid.cols + extraCols;
        const cardRows = baseGrid.rows + extraRows;
        const localCellW = availableW / Math.max(1, cardCols);
        const localCellH = availableH / Math.max(1, cardRows);

        const cardSlots = [];
        for (let r = 0; r < cardRows; r++) {
            for (let c = 0; c < cardCols; c++) {
                cardSlots.push([c, r]);
            }
        }

        const localGrid = {
            cols: cardCols,
            rows: cardRows,
            slots: cardSlots
        };

        activeRenderGrid = {
            cols: cardCols,
            rows: cardRows,
            cellW: localCellW,
            cellH: localCellH,
            isFolderCards: true,
            layout: localGrid,
            orderedItems: displayItems
        };

        let slotIdx = 0;

        for (const item of displayItems) {
            if (slotIdx >= cardSlots.length) break;
            const slot = cardSlots[slotIdx++];
            if (!item) continue;
            const x = GRID_SIDE_MARGIN + slot[0] * localCellW;
            const y = GRID_TOP_MARGIN + slot[1] * localCellH;

            if (item.type === "folder") {
                const group = item.card;
                if (y + localCellH < -50 || y > rectH + 50) {
                    data._folderCards.push({
                        id: item.id,
                        x: x + 4,
                        y: y + 4,
                        w: localCellW - 8,
                        h: localCellH - 8,
                        folderPath: group.path,
                        group: group,
                        _slot: slot
                    });
                    continue;
                }

                const isFolderMatch = !focusedFolder || (focusedFolder === "(root files)/" ? false : (group.path.startsWith(focusedFolder) || focusedFolder.startsWith(group.path)));

                ctx.save();
                if (!isFolderMatch) ctx.globalAlpha = 0.15;

                // Card background with folder accent
                ctx.fillStyle = TILE_BACKGROUND;
                ctx.fillRect(x + 4, y + 4, localCellW - 8, localCellH - 8);

                ctx.strokeStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.4);
                ctx.lineWidth = 1.5;
                ctx.strokeRect(x + 4, y + 4, localCellW - 8, localCellH - 8);

                // Folder icon accent bar
                ctx.fillStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.15);
                ctx.fillRect(x + 4, y + 4, localCellW - 8, Math.min(22, localCellH - 8));

                // Folder name
                ctx.fillStyle = getThemeColor("--vscode-foreground", light ? "#3730a3" : "#c4b5fd");
                const fontSize = Math.max(8, Math.min(11, localCellW / 12));
                ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
                const maxLabelW = localCellW - 24;
                let label = group.name;
                if (ctx.measureText(label).width > maxLabelW) {
                    while (label.length > 1 && ctx.measureText(label + "…").width > maxLabelW) {
                        label = label.slice(0, -1);
                    }
                    label += "…";
                }
                ctx.fillText(label, x + 10, y + 18);

                // File count
                ctx.fillStyle = getThemeColor("--vscode-descriptionForeground", light ? "#6b7280" : "#707075");
                ctx.font = `${Math.max(7, fontSize - 2)}px system-ui, sans-serif`;
                const countText = `${group.fileCount} file${group.fileCount !== 1 ? "s" : ""}`;
                ctx.fillText(countText, x + 10, y + 18 + fontSize + 2);

                // Mini-mosaic preview of files inside folder (cached spanning layout)
                const mosaicX = x + 8;
                const mosaicY = y + 36;
                const mosaicW = localCellW - 16;
                const mosaicH = localCellH - 46;

                if (mosaicW >= 24 && mosaicH >= 16 && group.files && group.files.length > 0) {
                    const groupFolderOrder = (data && data.folderOrders && data.folderOrders[group.path]) || null;
                    if (isSpanningMode) {
                        const spanningLayout = buildSpanningGridLocal(group.files, overviewAspect, groupFolderOrder, extraCols, extraRows);
                        const miniCols = spanningLayout.cols;
                        const miniRows = spanningLayout.rows;
                        const gap = (miniCols >= 8 || miniRows >= 8) ? 1 : 2;

                        const miniCellW = Math.max(1, (mosaicW - (miniCols - 1) * gap) / miniCols);
                        const miniCellH = Math.max(1, (mosaicH - (miniRows - 1) * gap) / miniRows);

                        for (const placement of spanningLayout.placements) {
                            const pf = placement.file;
                            const miniX = mosaicX + placement.col * (miniCellW + gap);
                            const miniY = mosaicY + placement.row * (miniCellH + gap);
                            const miniFileH = placement.nCells * miniCellH + (placement.nCells - 1) * gap;

                            const isOpen = openFilesSet.has(pf.uri);
                            const isActive = pf.uri === activeFileUri;
                            const isSearchMatch = queryActive && textMatches(pf._combinedTextOriginal, pf._combinedText);

                            ctx.fillStyle = isSearchMatch
                                ? withAlpha(ACCENT_SEARCH, 0.35)
                                : (light ? "#eaeaf0" : "#141418");
                            ctx.fillRect(miniX, miniY, miniCellW, miniFileH);

                            ctx.strokeStyle = isSearchMatch
                                ? ACCENT_SEARCH
                                : (isActive
                                    ? (BORDER_STYLES.active ? BORDER_STYLES.active.color : "#007fd4")
                                    : (isOpen
                                        ? ACCENT_RECENCY
                                        : (light ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.08)")));
                            ctx.lineWidth = (isActive || isSearchMatch) ? 1.5 : 1;
                            ctx.strokeRect(miniX, miniY, miniCellW, miniFileH);

                            if (pf.lines && pf.lines.length > 0 && miniFileH >= 10 && miniCellW >= 8) {
                                const maxLines = Math.min(pf.lines.length, Math.floor((miniFileH - 4) / 2));
                                for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
                                    const line = pf.lines[lineIdx];
                                    const lineY = miniY + 3 + lineIdx * 2;
                                    const lineWidth = Math.max(2, Math.min(miniCellW - 4, (line.length || 20) * (miniCellW / 80)));
                                    const lineIndent = Math.min(4, (line.indent || 0) * 1.2);
                                    ctx.fillStyle = withAlpha(colorForCategory(line.category || "normal", false), 0.75);
                                    ctx.fillRect(miniX + 2 + lineIndent, lineY, Math.max(1, lineWidth - lineIndent), 1);
                                }
                            } else if (miniFileH >= 4 && miniCellW >= 4 && pf.gitStatus) {
                                ctx.fillStyle = pf.gitStatus === "modified"
                                    ? (TILE_LABEL_COLOR.modified || "#e2c08d")
                                    : (TILE_LABEL_COLOR.added || "#73c991");
                                ctx.fillRect(miniX + 1, miniY + 1, Math.min(3, miniCellW - 2), Math.min(3, miniFileH - 2));
                            }
                        }
                    } else {
                        const totalSlots = Math.max(group.files.length, groupFolderOrder ? groupFolderOrder.length : 0);
                        const baseMiniGrid = buildStableGrid(totalSlots, overviewAspect);
                        const miniCols = baseMiniGrid.cols + extraCols;
                        const miniRows = baseMiniGrid.rows + extraRows;
                        const gap = (miniCols >= 8 || miniRows >= 8) ? 1 : 2;

                        const miniCellW = Math.max(1, (mosaicW - (miniCols - 1) * gap) / miniCols);
                        const miniCellH = Math.max(1, (mosaicH - (miniRows - 1) * gap) / miniRows);

                        const miniSlots = [];
                        for (let r = 0; r < miniRows; r++) {
                            for (let c = 0; c < miniCols; c++) {
                                miniSlots.push([c, r]);
                            }
                        }

                        const groupFilesById = new Map(group.files.map(f => [f.id, f]));
                        const orderToUse = groupFolderOrder && groupFolderOrder.length > 0
                            ? groupFolderOrder
                            : group.files.map(f => f.id);

                        for (let mIdx = 0; mIdx < orderToUse.length && mIdx < miniSlots.length; mIdx++) {
                            const fid = orderToUse[mIdx];
                            if (!fid) continue;
                            const pf = groupFilesById.get(fid);
                            if (!pf) continue;
                            const miniSlot = miniSlots[mIdx];
                            const miniX = mosaicX + miniSlot[0] * (miniCellW + gap);
                            const miniY = mosaicY + miniSlot[1] * (miniCellH + gap);

                            const isOpen = openFilesSet.has(pf.uri);
                            const isActive = pf.uri === activeFileUri;
                            const isSearchMatch = queryActive && textMatches(pf._combinedTextOriginal, pf._combinedText);

                            ctx.fillStyle = isSearchMatch
                                ? withAlpha(ACCENT_SEARCH, 0.35)
                                : (light ? "#eaeaf0" : "#141418");
                            ctx.fillRect(miniX, miniY, miniCellW, miniCellH);

                            ctx.strokeStyle = isSearchMatch
                                ? ACCENT_SEARCH
                                : (isActive
                                    ? (BORDER_STYLES.active ? BORDER_STYLES.active.color : "#007fd4")
                                    : (isOpen
                                        ? ACCENT_RECENCY
                                        : (light ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.08)")));
                            ctx.lineWidth = (isActive || isSearchMatch) ? 1.5 : 1;
                            ctx.strokeRect(miniX, miniY, miniCellW, miniCellH);

                            if (pf.lines && pf.lines.length > 0 && miniCellH >= 10 && miniCellW >= 8) {
                                const maxLines = Math.min(pf.lines.length, Math.floor((miniCellH - 4) / 2));
                                for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
                                    const line = pf.lines[lineIdx];
                                    const lineY = miniY + 3 + lineIdx * 2;
                                    const lineWidth = Math.max(2, Math.min(miniCellW - 4, (line.length || 20) * (miniCellW / 80)));
                                    const lineIndent = Math.min(4, (line.indent || 0) * 1.2);
                                    ctx.fillStyle = withAlpha(colorForCategory(line.category || "normal", false), 0.75);
                                    ctx.fillRect(miniX + 2 + lineIndent, lineY, Math.max(1, lineWidth - lineIndent), 1);
                                }
                            } else if (miniCellH >= 4 && miniCellW >= 4 && pf.gitStatus) {
                                ctx.fillStyle = pf.gitStatus === "modified"
                                    ? (TILE_LABEL_COLOR.modified || "#e2c08d")
                                    : (TILE_LABEL_COLOR.added || "#73c991");
                                ctx.fillRect(miniX + 1, miniY + 1, Math.min(3, miniCellW - 2), Math.min(3, miniFileH - 2));
                            }
                        }
                    }
                }

                // Store click target for folder cards
                data._folderCards.push({
                    id: item.id,
                    x: x + 4,
                    y: y + 4,
                    w: localCellW - 8,
                    h: localCellH - 8,
                    folderPath: group.path,
                    group: group,
                    _slot: slot
                });

                ctx.restore();
            } else {
                const file = item.file;
                const fileH = localCellH;
                file._cell = { id: item.id, x, y, w: localCellW, h: fileH, _slot: slot };

                if (y + fileH < -50 || y > rectH + 50) continue;

                const isFolderMatch = !focusedFolder || (focusedFolder === "(root files)/" ? !file.path.includes("/") : file.path.startsWith(focusedFolder));
                const isSearchMatch = queryActive && textMatches(file._combinedTextOriginal, file._combinedText);

                drawFileTile(file, x, y, localCellW, fileH, !isFolderMatch || (queryActive && !isSearchMatch));
            }
        }
    } else if (shouldOpenFolder) {
        // Directory drill-down mode — render all files in focusedFolder as a Thumbview grid
        const cellW = folderCellW;
        const cellH = folderCellH;
        const folderOrder = (data && data.folderOrders && data.folderOrders[focusedFolder]) || null;

        if (isSpanningMode && localSpanningLayout) {
            activeRenderGrid = {
                cols: localSpanningLayout.cols,
                rows: localSpanningLayout.rows,
                wrapRows: localSpanningLayout.wrapRows,
                cellW: folderCellW,
                cellH: folderCellH,
                isFolderView: true,
                files: scopedFiles,
                layout: localSpanningLayout,
                folderOrder: folderOrder
            };

            for (const placement of localSpanningLayout.placements) {
                const file = placement.file;
                const col = placement.col;
                const row = placement.row;
                const nCells = placement.nCells;

                const x = GRID_SIDE_MARGIN + col * cellW;
                const y = GRID_TOP_MARGIN + row * cellH;
                const fileH = cellH * nCells;

                file._cell = { x, y, w: cellW, h: fileH };

                if (y + fileH < -50 || y > rectH + 50) continue;

                const isSearchMatch = queryActive && textMatches(file._combinedTextOriginal, file._combinedText);
                drawFileTile(file, x, y, cellW, fileH, queryActive && !isSearchMatch);
            }
        } else {
            let orderToIterate = [];
            if (folderOrder && Array.isArray(folderOrder) && folderOrder.length > 0) {
                orderToIterate = [...folderOrder];
                const seenIds = new Set(folderOrder.filter(Boolean));
                const newFiles = scopedFiles.filter(f => !seenIds.has(f.id));
                let newIdx = 0;
                for (let i = 0; i < orderToIterate.length && newIdx < newFiles.length; i++) {
                    if (!orderToIterate[i]) {
                        orderToIterate[i] = newFiles[newIdx++].id;
                    }
                }
                while (newIdx < newFiles.length) {
                    orderToIterate.push(newFiles[newIdx++].id);
                }
            } else {
                orderToIterate = scopedFiles.map(f => f.id);
            }

            const totalSlots = Math.max(scopedFiles.length, orderToIterate.length);
            localFolderGrid = buildStableGrid(totalSlots, overviewAspect);

            const folderCols = (localFolderGrid ? localFolderGrid.cols : 1) + extraCols;
            const folderRows = (localFolderGrid ? localFolderGrid.rows : 1) + extraRows;

            activeRenderGrid = {
                cols: folderCols,
                rows: folderRows,
                cellW: folderCellW,
                cellH: folderCellH,
                isFolderView: true,
                files: scopedFiles,
                layout: localFolderGrid,
                folderOrder: folderOrder
            };

            const slots = localFolderGrid ? localFolderGrid.slots : [];
            const scopedFilesById = new Map(scopedFiles.map(f => [f.id, f]));

            for (let i = 0; i < orderToIterate.length && i < slots.length; i++) {
                const fid = orderToIterate[i];
                if (!fid) continue;
                const file = scopedFilesById.get(fid);
                if (!file) continue;
                const slot = slots[i];
                if (!slot) continue;

                const col = slot[0];
                const row = slot[1];

                const x = GRID_SIDE_MARGIN + col * cellW;
                const y = GRID_TOP_MARGIN + row * cellH;
                const fileH = cellH;

                file._cell = { x, y, w: cellW, h: fileH };

                if (y + fileH < -50 || y > rectH + 50) continue;

                const isSearchMatch = queryActive && textMatches(file._combinedTextOriginal, file._combinedText);
                drawFileTile(file, x, y, cellW, fileH, queryActive && !isSearchMatch);
            }
        }
    } else {
        // Normal file tile mode — cells are large enough to render individual thumbnails
        const cellW = rootCellW;
        const cellH = rootCellH;

        activeRenderGrid = {
            cols: gridCols,
            rows: gridRows,
            cellW: rootCellW,
            cellH: rootCellH,
            isRootView: true,
            layout: data.layout
        };

        for (let i = 0; i < filteredFiles.length; i++) {
            const file = filteredFiles[i];
            const slot = file.slot;
            if (!slot) continue;

            const col = slot[0];
            const row = slot[1];
            const nCells = file.nCells || 1;

            const x = GRID_SIDE_MARGIN + col * cellW;
            const y = GRID_TOP_MARGIN + row * cellH;
            const fileH = cellH * nCells;

            file._cell = {
                x,
                y,
                w: cellW,
                h: fileH
            };

            // View Frustum Culling: skip rendering offscreen cards that are outside the visible window
            if (y + fileH < -50 || y > rectH + 50) {
                continue;
            }

            const isFolderMatch = !focusedFolder || (focusedFolder === "(root files)/" ? !file.path.includes("/") : file.path.startsWith(focusedFolder));
            const isSearchMatch = queryActive && textMatches(file._combinedTextOriginal, file._combinedText);

            drawFileTile(file, x, y, cellW, fileH, !isFolderMatch || (queryActive && !isSearchMatch));
        }
    }

    if ((draggingFile || draggingFolder) && !dragBackgroundCanvas && typeof document !== "undefined") {
        if (!cachedDragBackgroundCanvas) {
            cachedDragBackgroundCanvas = document.createElement("canvas");
        }
        if (cachedDragBackgroundCanvas.width !== canvas.width || cachedDragBackgroundCanvas.height !== canvas.height) {
            cachedDragBackgroundCanvas.width = canvas.width;
            cachedDragBackgroundCanvas.height = canvas.height;
        }
        const bgCtx = cachedDragBackgroundCanvas.getContext ? cachedDragBackgroundCanvas.getContext("2d") : null;
        if (bgCtx) {
            bgCtx.drawImage(canvas, 0, 0);
        }
        dragBackgroundCanvas = cachedDragBackgroundCanvas;
    }

    drawDragOverlays();
}

function drawDragOverlays() {
    if (draggingFolder) {
        const ghostW = draggingFolder.w || (activeRenderGrid ? activeRenderGrid.cellW : 120);
        const ghostH = draggingFolder.h || (activeRenderGrid ? activeRenderGrid.cellH : 80);
        const x = cursorPos.px - (dragGrabOffset ? dragGrabOffset.x : 0);
        const y = cursorPos.py - (dragGrabOffset ? dragGrabOffset.y : 0);

        const style = BORDER_STYLES.dragging;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.width;
        ctx.strokeRect(x, y, ghostW, ghostH);
        ctx.fillStyle = style.color;
        ctx.font = TILE_LABEL_FONT;
        ctx.fillText("📁 " + (draggingFolder.name || draggingFolder.folderPath), x + TILE_LABEL_OFFSET_X, y + TILE_LABEL_OFFSET_Y);

        // drop-target outline
        if (dragTarget) {
            ctx.strokeStyle = BORDER_STYLES.active ? BORDER_STYLES.active.color : "#007fd4";
            ctx.lineWidth = 2;
            if (dragTarget.file && dragTarget.file._cell) {
                ctx.strokeRect(
                    dragTarget.file._cell.x,
                    dragTarget.file._cell.y,
                    dragTarget.file._cell.w,
                    dragTarget.file._cell.h
                );
            } else {
                ctx.strokeRect(
                    GRID_SIDE_MARGIN + dragTarget.col * dragTarget.cellW,
                    GRID_TOP_MARGIN + dragTarget.row * dragTarget.cellH,
                    dragTarget.cellW,
                    dragTarget.cellH
                );
            }
        }
    }

    if (draggingFile) {
        // ghost for currently-dragged file
        const ghostW = draggingFile._cell ? draggingFile._cell.w : (activeRenderGrid ? activeRenderGrid.cellW : 100);
        const ghostH = draggingFile._cell ? draggingFile._cell.h : (activeRenderGrid ? activeRenderGrid.cellH : 80);
        const x = cursorPos.px - (dragGrabOffset ? dragGrabOffset.x : 0);
        const y = cursorPos.py - (dragGrabOffset ? dragGrabOffset.y : 0);
        const style = BORDER_STYLES.dragging;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.width;
        ctx.strokeRect(x, y, ghostW, ghostH);
        ctx.fillStyle = style.color;
        ctx.font = TILE_LABEL_FONT;
        ctx.fillText(draggingFile._fittedLabel || draggingFile.path, x + TILE_LABEL_OFFSET_X, y + TILE_LABEL_OFFSET_Y);

        // drop-target outline
        if (dragTarget) {
            ctx.strokeStyle = BORDER_STYLES.active ? BORDER_STYLES.active.color : "#007fd4";
            ctx.lineWidth = 2;
            if (dragTarget.file && dragTarget.file._cell) {
                ctx.strokeRect(
                    dragTarget.file._cell.x,
                    dragTarget.file._cell.y,
                    dragTarget.file._cell.w,
                    dragTarget.file._cell.h
                );
            } else {
                ctx.strokeRect(
                    GRID_SIDE_MARGIN + dragTarget.col * dragTarget.cellW,
                    GRID_TOP_MARGIN + dragTarget.row * dragTarget.cellH,
                    dragTarget.cellW,
                    dragTarget.cellH
                );
            }
        }
    }
}

// Middle-click (auxclick) to close tab
canvas.addEventListener("auxclick", event => {
    if (!data || event.button !== 1) { // 1 = middle mouse button
        return;
    }

    const { px, py } = getCanvasPos(event);
    const targetFile = findFileAt(px, py);
    if (targetFile) {
        const isOpen = openFiles.includes(targetFile.uri);
        if (isOpen) {
            vscode.postMessage({
                command: "close",
                uri: targetFile.uri
            });
        }
    }
});

function isControlModifier(event) {
    if (!event) return false;
    return !!(
        event.ctrlKey || event.metaKey ||
        event.key === "Control" || event.key === "Meta" ||
        event.code === "ControlLeft" || event.code === "ControlRight" ||
        event.code === "MetaLeft" || event.code === "MetaRight"
    );
}

window.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        clearDragState();
        closeAllPopovers();
        if (typeof hideContextMenu === "function") {
            hideContextMenu();
        }
        isCtrlDown = false;
        tooltip.style.display = "none";
        render();
        return;
    }

    const isInputFocused = document.activeElement && (
        document.activeElement.tagName === "INPUT" ||
        document.activeElement.tagName === "TEXTAREA"
    );

    if (!isInputFocused) {
        const isModifier = event.ctrlKey || event.metaKey;
        if (isModifier && (event.key === "v" || event.key === "V")) {
            event.preventDefault();
            const currentTargetFolder = focusedFolder === "(root files)/" ? "" : (focusedFolder || "");
            vscode.postMessage({ command: "pasteItem", targetFolder: currentTargetFolder });
            return;
        }
        if (isModifier && (event.key === "c" || event.key === "C")) {
            if (hoveredFile) {
                event.preventDefault();
                clipboardItem = { uri: hoveredFile.uri, path: hoveredFile.path, isFolder: false, isCut: false };
                vscode.postMessage({ command: "copyFile", uri: hoveredFile.uri });
                return;
            }
        }
        if (isModifier && (event.key === "x" || event.key === "X")) {
            if (hoveredFile) {
                event.preventDefault();
                clipboardItem = { uri: hoveredFile.uri, path: hoveredFile.path, isFolder: false, isCut: true };
                vscode.postMessage({ command: "cutFile", uri: hoveredFile.uri });
                return;
            }
        }
        if (event.key === "Delete" || (event.metaKey && event.key === "Backspace")) {
            if (hoveredFile) {
                event.preventDefault();
                vscode.postMessage({ command: "deleteFile", uri: hoveredFile.uri });
                return;
            }
        }
    }

    if (isControlModifier(event)) {
        isCtrlDown = true;
        updateHoverTooltip();
    }
}, true);

window.addEventListener("keyup", event => {
    if (event.key === "Escape" || event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
    }
    if (!event.ctrlKey && !event.metaKey) {
        isCtrlDown = false;
        tooltip.style.display = "none";
    }
}, true);

window.addEventListener("blur", () => {
    isCtrlDown = false;
    tooltip.style.display = "none";
});

const TOOLTIP_CONFIG = {
    minWidth: 220,
    lineRadius: 12,
    gap: 12,
    viewportMargin: 16,
};

/** Estimates the pixel width the CTRL-hover tooltip needs to fit the widest line/path in file, so its width doesn't jitter as the cursor moves between lines. */
function getFileWidestLineWidth(file) {
    if (!file) return 300;
    if (file._widestLineWidth !== undefined) {
        return file._widestLineWidth;
    }
    let maxCharLen = 0;
    if (file.lines && file.lines.length > 0) {
        for (let i = 0; i < file.lines.length; i++) {
            const l = file.lines[i];
            if (l && l.text && l.text.length > maxCharLen) {
                maxCharLen = l.text.length;
            }
        }
    }
    if (file.fullLines && file.fullLines.length > 0) {
        for (let i = 0; i < file.fullLines.length; i++) {
            const str = file.fullLines[i];
            if (str && str.length > maxCharLen) {
                maxCharLen = str.length;
            }
        }
    }
    const uriCache = hoverLineCache[file.uri];
    if (uriCache) {
        for (const idx in uriCache) {
            const l = uriCache[idx];
            if (l && l.text && l.text.length > maxCharLen) {
                maxCharLen = l.text.length;
            }
        }
    }

    const charWidthPx = 7.9;
    const textWidthPx = Math.ceil((maxCharLen + 4) * charWidthPx) + 32;
    const headerTextLen = (file.path ? file.path.length : 10) + 40;
    const headerWidthPx = Math.ceil(headerTextLen * 7.2) + 24;

    const maxLineWidth = Math.max(textWidthPx, headerWidthPx);
    const maxAllowedWidth = Math.min(750, Math.max(300, window.innerWidth - 32));

    const width = Math.max(TOOLTIP_CONFIG.minWidth, Math.min(maxAllowedWidth, maxLineWidth));
    file._widestLineWidth = width;
    return width;
}

// MARK: updateHoverTooltip
/** Finds the file/line under the cursor during a CTRL-hover and rebuilds the tooltip's HTML, size, and position to show it. */
function updateHoverTooltip() {
    if (!data || !isCtrlDown) {
        tooltip.style.display = "none";
        return;
    }

    if (!cursorPos && lastMousePos) {
        const rect = canvas.getBoundingClientRect();
        cursorPos = { px: lastMousePos.x - rect.left, py: lastMousePos.y - rect.top };
    }

    if (!cursorPos) {
        tooltip.style.display = "none";
        return;
    }

    let hoveredFolderCard = null;
    if (data && data._folderCards) {
        for (const card of data._folderCards) {
            if (pointInRect(card, cursorPos.px, cursorPos.py)) {
                hoveredFolderCard = card;
                break;
            }
        }
    }

    if (hoveredFolderCard) {
        const grp = hoveredFolderCard.group || { name: hoveredFolderCard.folderPath, path: hoveredFolderCard.folderPath, fileCount: 0, files: [] };
        
        let openCount = 0;
        let modifiedCount = 0;
        let errorCount = 0;
        const extCounts = {};

        for (const f of grp.files) {
            if (openFilesSet.has(f.uri)) openCount++;
            if (f.gitStatus === "modified" || f.gitStatus === "added" || f.gitStatus === "untracked") modifiedCount++;
            if (f.hasError) errorCount++;
            const ext = f.path.includes(".") ? f.path.split(".").pop().toLowerCase() : "other";
            extCounts[ext] = (extCounts[ext] || 0) + 1;
        }

        const topExts = Object.entries(extCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([ext, count]) => `${count} .${ext}`)
            .join("   ");

        const statusBadges = [];
        if (openCount > 0) {
            statusBadges.push(`<span style="color: var(--tv-accent-recency, #fe6100); font-weight: 500;">${openCount} open</span>`);
        }
        if (modifiedCount > 0) {
            statusBadges.push(`<span style="color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); font-weight: 500;">${modifiedCount} modified</span>`);
        }
        if (errorCount > 0) {
            statusBadges.push(`<span style="color: var(--vscode-list-errorForeground, #f14c4c); font-weight: 500;">${errorCount} error${errorCount > 1 ? 's' : ''}</span>`);
        }
        if (topExts) {
            statusBadges.push(`<span style="color: var(--vscode-descriptionForeground, #8a8a93);">${topExts}</span>`);
        }

        // Sort files to show open, modified, and main files first
        const sortedFiles = [...grp.files].sort((a, b) => {
            const aOpen = openFilesSet.has(a.uri) ? 2 : 0;
            const bOpen = openFilesSet.has(b.uri) ? 2 : 0;
            const aMod = a.gitStatus ? 1 : 0;
            const bMod = b.gitStatus ? 1 : 0;
            const scoreA = aOpen + aMod;
            const scoreB = bOpen + bMod;
            if (scoreA !== scoreB) return scoreB - scoreA;
            return a.path.localeCompare(b.path);
        });

        const maxPreviewFiles = 9;
        const fileRows = sortedFiles.slice(0, maxPreviewFiles).map(f => {
            const relName = f.path.startsWith(grp.path) ? f.path.substring(grp.path.length) : (f.path.split("/").pop() || f.path);
            const isOpen = openFilesSet.has(f.uri);
            const isAct = f.uri === activeFileUri;

            let textColor = "var(--vscode-foreground, #cccccc)";
            if (f.hasError) {
                textColor = "var(--vscode-list-errorForeground, #f14c4c)";
            } else if (f.gitStatus === "modified") {
                textColor = "var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d)";
            } else if (f.gitStatus === "added" || f.gitStatus === "untracked") {
                textColor = "var(--vscode-gitDecoration-untrackedResourceForeground, #73c991)";
            }

            let statusTag = "";
            if (isAct) {
                statusTag = `<span class="badge" style="background: rgba(0, 127, 212, 0.2); color: #60a5fa; border: 1px solid rgba(0, 127, 212, 0.4); font-size: 9px; padding: 0 4px;">active</span>`;
            } else if (isOpen) {
                statusTag = `<span class="badge" style="background: rgba(254, 97, 0, 0.2); color: #fb923c; border: 1px solid rgba(245, 158, 11, 0.4); font-size: 9px; padding: 0 4px;">open</span>`;
            }

            return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 3px 6px; border-radius: 4px; background: rgba(128, 128, 128, 0.05); font-size: 11px; gap: 8px;">
                <span style="display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace);">
                    ${ICONS.file}
                    <span style="overflow: hidden; text-overflow: ellipsis; color: ${textColor}; font-weight: ${f.gitStatus || f.hasError ? '500' : 'normal'};">${escapeHtml(relName)}</span>
                </span>
                ${statusTag}
            </div>`;
        }).join("");

        const remainingCount = grp.files.length - maxPreviewFiles;
        const moreFooter = remainingCount > 0
            ? `<div style="font-size: 10px; color: var(--vscode-descriptionForeground, #8a8a93); padding: 2px 6px; text-align: center;">+${remainingCount} more in directory</div>`
            : "";

        const summaryBar = statusBadges.length > 0
            ? `<div style="font-size: 11px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 8px; background: rgba(128, 128, 128, 0.08); border-radius: 4px;">${statusBadges.join("")}</div>`
            : "";

        const folderTooltipHtml = `
            <div style="font-family: system-ui, -apple-system, sans-serif; white-space: normal; line-height: 1.4;">
                <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.15)); padding-bottom: 6px; margin-bottom: 8px;">
                    <div style="display: flex; align-items: center; gap: 6px; font-weight: 600; color: var(--vscode-foreground, #ffffff); font-size: 12px;">
                        ${ICONS.folder}
                        <span>${escapeHtml(grp.path)}</span>
                    </div>
                    <span class="badge" style="font-size: 10px; font-weight: 600; padding: 1px 6px;">${grp.fileCount} files</span>
                </div>
                ${summaryBar}
                <div style="display: flex; flex-direction: column; gap: 2px;">
                    ${fileRows}
                    ${moreFooter}
                </div>
            </div>
        `;

        tooltip.innerHTML = folderTooltipHtml;
        const width = 340;
        tooltip.style.width = `${width}px`;
        tooltip.style.display = "block";

        const gap = TOOLTIP_CONFIG.gap;
        const cardCenterX = hoveredFolderCard.x + hoveredFolderCard.w / 2;
        let tx;
        if (cardCenterX > window.innerWidth / 2) {
            tx = hoveredFolderCard.x - gap - width;
            if (tx < TOOLTIP_CONFIG.viewportMargin) tx = TOOLTIP_CONFIG.viewportMargin;
        } else {
            tx = hoveredFolderCard.x + hoveredFolderCard.w + gap;
            if (tx + width > window.innerWidth - TOOLTIP_CONFIG.viewportMargin) {
                tx = window.innerWidth - width - TOOLTIP_CONFIG.viewportMargin;
            }
        }
        const ty = Math.max(
            TOOLTIP_CONFIG.viewportMargin,
            Math.min(window.innerHeight - 260 - TOOLTIP_CONFIG.viewportMargin, hoveredFolderCard.y)
        );
        tooltip.style.left = `${tx}px`;
        tooltip.style.top = `${ty}px`;
        return;
    }

    if (!hoveredFile) {
        hoveredFile = findFileAt(cursorPos.px, cursorPos.py);
    }

    if (!hoveredFile || !hoveredFile._cell || hoveredFile.isImage || hoveredFile.isPdf) {
        tooltip.style.display = "none";
        return;
    }

    const c = hoveredFile._cell;
    const thumbnailTop = c.y + TILE_THUMBNAIL_OFFSET_Y;
    const thumbnailHeight = Math.max(1, c.h - TILE_THUMBNAIL_HEIGHT_MARGIN);
    const totalLines = Math.max(hoveredFile.lineCount || (hoveredFile.lines ? hoveredFile.lines.length : 1), 1);
    const relativeY = Math.max(0, Math.min(1, (cursorPos.py - thumbnailTop) / thumbnailHeight));
    const hoveredLineIdx = Math.max(0, Math.min(totalLines - 1, Math.floor(relativeY * totalLines)));

    const radius = TOOLTIP_CONFIG.lineRadius;
    let start = Math.max(0, hoveredLineIdx - radius);
    let end = Math.min(totalLines - 1, hoveredLineIdx + radius);

    if (start === 0) {
        end = Math.min(totalLines - 1, start + radius * 2);
    }
    if (end === totalLines - 1) {
        start = Math.max(0, end - radius * 2);
    }

    // Check if any required lines are missing from scan results and cache
    let missingLines = false;
    const uriCache = hoverLineCache[hoveredFile.uri] || {};

    for (let i = start; i <= end; i++) {
        if ((!hoveredFile.lines || !hoveredFile.lines[i]) && !uriCache[i]) {
            missingLines = true;
            break;
        }
    }

    if (missingLines) {
        const reqKey = `${hoveredFile.uri}:${start}:${end}`;
        if (pendingHoverRequest !== reqKey) {
            pendingHoverRequest = reqKey;
            vscode.postMessage({
                command: "getHoverLines",
                uri: hoveredFile.uri,
                start,
                end,
                requestId: reqKey
            });
        }
    }

    const isOpen = openFilesSet.has(hoveredFile.uri);
    const closeHint = isOpen ? `<span style="float: right; color: #a0a0a5; font-weight: normal; font-size: 10px;">    Middle-click to close tab</span>` : "";
    let tooltipHtml = `<div class="tooltip-filename">${hoveredFile.path} (Line ${hoveredLineIdx + 1})${closeHint}</div>`;

    for (let i = start; i <= end; i++) {
        const line = (hoveredFile.lines && hoveredFile.lines[i]) ? hoveredFile.lines[i] : uriCache[i];
        const isHoveredLine = i === hoveredLineIdx;
        const lineText = line ? line.text : "Loading line...";
        const lang = detectLang(hoveredFile.path);

        if (line && !line._htmlCache) {
            const tokens = line._tokens || tokenizeLine(lineText.trimStart(), lang);
            line._htmlCache = buildLineHtml(tokens, null);
        }

        let lineHtml;
        if (rawSearchQuery && !searchInvalid && line) {
            const tokens = line._tokens || tokenizeLine(lineText.trimStart(), lang);
            const hl = searchRegex
                ? new RegExp(searchRegex.source, searchRegex.flags.includes("g") ? searchRegex.flags : searchRegex.flags + "g")
                : new RegExp(escapeRegExp(rawSearchQuery), matchCase ? "g" : "gi");
            lineHtml = buildLineHtml(tokens, hl);
        } else {
            lineHtml = (line && line._htmlCache) ? line._htmlCache : lineText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }

        const isMatchLine = rawSearchQuery && !searchInvalid &&
            textMatches(lineText, line && line._lowerText !== undefined ? line._lowerText : lineText.toLowerCase());

        const isErrorLine = hoveredFile.errorLines ? !!hoveredFile.errorLines[i] : false;

        const gitType = (hoveredFile.gitStatus === "untracked" || hoveredFile.gitStatus === "added")
            ? "added"
            : (hoveredFile.gitChanges ? hoveredFile.gitChanges[i] : undefined);

        let bgStyle = "display: block; box-sizing: border-box; width: 100%; min-height: 1.4em;";
        let prefix = "  ";
        let renderedLineHtml = lineHtml;
        let suffix = "";

        if (isErrorLine) {
            const errorMsg = hoveredFile.errorLines && typeof hoveredFile.errorLines[i] === "string" ? hoveredFile.errorLines[i] : "";
            suffix = errorMsg
                ? ` <span style="color: #fca5a5; font-size: 10px; margin-left: 8px; font-style: italic;">[${escapeHtml(errorMsg)}]</span>`
                : ` <span style="color: #fca5a5; font-size: 10px; margin-left: 6px; font-weight: bold;">[Error]</span>`;
        } else if (gitType === "removed") {
            renderedLineHtml = `<span style="text-decoration: line-through; opacity: 0.75;">${lineHtml}</span>`;
        }

        if (isHoveredLine) {
            prefix = `<span style="color: ${ACCENT_INSPECT}; font-weight: bold;">&gt; </span>`;
            if (isMatchLine) {
                bgStyle = `background: ${withAlpha(ACCENT_SEARCH, 0.28)}; display: block; box-sizing: border-box; width: 100%; border-left: 3px solid ${ACCENT_SEARCH}; padding-left: 2px; min-height: 1.4em;`;
            } else if (isErrorLine) {
                prefix = `<span style="color: #ef4444; font-weight: bold;">✕ </span>`;
                bgStyle = "background: rgba(239, 68, 68, 0.28); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid #ef4444; padding-left: 2px; min-height: 1.4em;";
            } else if (gitType === "modified") {
                prefix = `<span style="color: #3b82f6; font-weight: bold;">~ </span>`;
                bgStyle = "background: rgba(59, 130, 246, 0.22); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid #3b82f6; padding-left: 2px; min-height: 1.4em;";
            } else if (gitType === "added") {
                prefix = `<span style="color: #22c55e; font-weight: bold;">+ </span>`;
                bgStyle = "background: rgba(34, 197, 94, 0.22); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid #22c55e; padding-left: 2px; min-height: 1.4em;";
            } else if (gitType === "removed") {
                prefix = `<span style="color: #ef4444; font-weight: bold;">- </span>`;
                bgStyle = "background: rgba(239, 68, 68, 0.22); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid #ef4444; padding-left: 2px; min-height: 1.4em;";
            } else {
                bgStyle = `background: ${withAlpha(ACCENT_INSPECT, 0.18)}; display: block; box-sizing: border-box; width: 100%; border-left: 3px solid ${ACCENT_INSPECT}; padding-left: 2px; min-height: 1.4em;`;
            }
        } else if (isMatchLine) {
            bgStyle = `background: ${withAlpha(ACCENT_SEARCH, 0.2)}; display: block; box-sizing: border-box; width: 100%; border-left: 3px solid ${ACCENT_SEARCH}; padding-left: 2px; min-height: 1.4em;`;
        } else if (isErrorLine) {
            prefix = `<span style="color: #ef4444; font-weight: bold; opacity: 0.85;">✕ </span>`;
            bgStyle = "background: rgba(239, 68, 68, 0.20); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid rgba(239, 68, 68, 0.85); padding-left: 2px; min-height: 1.4em;";
        } else if (gitType === "modified") {
            prefix = `<span style="color: #3b82f6; opacity: 0.85;">~ </span>`;
            bgStyle = "background: rgba(59, 130, 246, 0.14); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid rgba(59, 130, 246, 0.85); padding-left: 2px; min-height: 1.4em;";
        } else if (gitType === "added") {
            prefix = `<span style="color: #22c55e; opacity: 0.85;">+ </span>`;
            bgStyle = "background: rgba(34, 197, 94, 0.14); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid rgba(34, 197, 94, 0.85); padding-left: 2px; min-height: 1.4em;";
        } else if (gitType === "removed") {
            prefix = `<span style="color: #ef4444; opacity: 0.85;">- </span>`;
            bgStyle = "background: rgba(239, 68, 68, 0.12); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid rgba(239, 68, 68, 0.65); padding-left: 2px; min-height: 1.4em;";
        }

        tooltipHtml += `<div style="${bgStyle}">${prefix}${renderedLineHtml}${suffix}</div>`;
    }

    tooltip.innerHTML = tooltipHtml;
    const overlayWidth = getFileWidestLineWidth(hoveredFile);
    tooltip.style.width = `${overlayWidth}px`;
    tooltip.style.display = "block";

    const gap = TOOLTIP_CONFIG.gap;
    const cellCenterX = c.x + c.w / 2;
    let tx;

    if (cellCenterX > window.innerWidth / 2) {
        tx = c.x - gap - overlayWidth;
        if (tx < TOOLTIP_CONFIG.viewportMargin) {
            tx = TOOLTIP_CONFIG.viewportMargin;
        }
    } else {
        tx = c.x + c.w + gap;
        if (tx + overlayWidth > window.innerWidth - TOOLTIP_CONFIG.viewportMargin) {
            tx = window.innerWidth - overlayWidth - TOOLTIP_CONFIG.viewportMargin;
        }
    }

    const ty = Math.max(
        TOOLTIP_CONFIG.viewportMargin,
        Math.min(window.innerHeight - 320 - TOOLTIP_CONFIG.viewportMargin, c.y)
    );

    tooltip.style.left = `${tx}px`;
    tooltip.style.top = `${ty}px`;
}

let lastFocusRequestTime = 0;
/** Asks the extension host to focus the webview when the window lacks OS focus, throttled to once per 500ms. */
function checkWindowFocus() {
    if (!document.hasFocus()) {
        const now = Date.now();
        if (now - lastFocusRequestTime > 500) { // Throttle IPC focus messages
            lastFocusRequestTime = now;
            vscode.postMessage({ command: "focusWindow" });
        }
    }
}

window.addEventListener("mouseenter", checkWindowFocus);

// MARK: mousedown
canvas.addEventListener("mousedown", event => {
    if (event.button !== 0) return; // only fire on left-click
    if (!data) return;
    cursorPos = getCanvasPos(event);

    // is mousedown on a folder
    if (data._folderCards) {
        for (const card of data._folderCards) {
            if (pointInRect(card, cursorPos.px, cursorPos.py)) {
                candidateFolder = { card, startX: cursorPos.px, startY: cursorPos.py };
                dragGrabOffset = { x: cursorPos.px - card.x, y: cursorPos.py - card.y };
                return;
            }
        }
    }

    // is mousedown on a file
    const hitFile = findFileAt(cursorPos.px, cursorPos.py);
    if (hitFile && hitFile._cell) {
        candidateFile = { file: hitFile, startX: cursorPos.px, startY: cursorPos.py };
        dragGrabOffset = { x: cursorPos.px - hitFile._cell.x, y: cursorPos.py - hitFile._cell.y };
        return;
    }
});

// MARK: mousemove
canvas.addEventListener("mousemove", event => {
    checkWindowFocus();

    // Safety check: if no mouse button is pressed, cancel any pending candidate drag
    if ((candidateFile || candidateFolder) && event.buttons === 0) {
        candidateFile = null;
        candidateFolder = null;
    }

    lastMousePos = { x: event.clientX, y: event.clientY };
    cursorPos = getCanvasPos(event);
    hoveredFile = findFileAt(cursorPos.px, cursorPos.py);

    if (candidateFolder && !draggingFolder && !draggingFile) {
        const dx = Math.abs(candidateFolder.startX - cursorPos.px);
        const dy = Math.abs(candidateFolder.startY - cursorPos.py);

        // only start dragging if cursor has moved more than the threshold
        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            draggingFolder = candidateFolder.card;
            candidateFolder = null;
            dragBackgroundCanvas = null;
        }
    }

    if (candidateFile && !draggingFile && !draggingFolder) {
        const dx = Math.abs(candidateFile.startX - cursorPos.px);
        const dy = Math.abs(candidateFile.startY - cursorPos.py);

        // only start dragging if cursor has moved more than the threshold
        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            draggingFile = candidateFile.file;
            candidateFile = null;
            dragBackgroundCanvas = null;
        }
    }
    if (draggingFile || draggingFolder) {
        if (!dragRafId) {
            dragRafId = requestAnimationFrame(() => {
                dragRafId = null;
                updateDragTarget();
                render();
            });
        }

        isCtrlDown = false;
        tooltip.style.display = "none";
        return;
    }

    if (isControlModifier(event)) {
        isCtrlDown = true;
        updateHoverTooltip();
    } else {
        isCtrlDown = false;
        tooltip.style.display = "none";
    }
});

// MARK: mouseup
canvas.addEventListener("mouseup", event => {
    if (event.button !== 0) return; // only fire on left-click
    if (!data) return;
    cursorPos = getCanvasPos(event);

    const activeCandidateFile = candidateFile;
    const activeCandidateFolder = candidateFolder;
    candidateFile = null;
    candidateFolder = null;

    if (draggingFolder) {
        updateDragTarget();

        if (activeRenderGrid && activeRenderGrid.isFolderCards) {
            if (dragTarget && dragTarget.item && dragTarget.item.id !== ("folder:" + draggingFolder.folderPath)) {
                vscode.postMessage({
                    command: "swapCardItems",
                    sourceId: "folder:" + draggingFolder.folderPath,
                    targetId: dragTarget.item.id
                });
            } else if (dragTarget && !dragTarget.item) {
                const slotIdx = activeRenderGrid.layout && activeRenderGrid.layout.slots
                    ? activeRenderGrid.layout.slots.findIndex(s => s[0] === dragTarget.col && s[1] === dragTarget.row)
                    : -1;
                const currentCardIds = activeRenderGrid.orderedItems.map(it => it ? it.id : "");
                vscode.postMessage({
                    command: "swapCardItems",
                    sourceId: "folder:" + draggingFolder.folderPath,
                    targetId: null,
                    targetIsEmpty: true,
                    targetSlotIdx: slotIdx !== -1 ? slotIdx : dragTarget.row * activeRenderGrid.cols + dragTarget.col,
                    maxCapacity: activeRenderGrid.cols * activeRenderGrid.rows,
                    currentCardIds
                });
            }
        } else if (dragTarget) {
            vscode.postMessage({
                command: "reorderFolder",
                sourceFolder: draggingFolder.folderPath,
                targetFolder: dragTarget.file ? dragTarget.file.path : null,
                targetCol: dragTarget.col,
                targetRow: dragTarget.row
            });
        }

        clearDragState();
        render();
        return;
    }

    if (draggingFile) {
        updateDragTarget();

        if (activeRenderGrid && activeRenderGrid.isFolderCards) {
            if (dragTarget && dragTarget.item && dragTarget.item.id !== draggingFile.id) {
                vscode.postMessage({
                    command: "swapCardItems",
                    sourceId: draggingFile.id,
                    targetId: dragTarget.item.id
                });
            } else if (dragTarget && !dragTarget.item) {
                const slotIdx = activeRenderGrid.layout && activeRenderGrid.layout.slots
                    ? activeRenderGrid.layout.slots.findIndex(s => s[0] === dragTarget.col && s[1] === dragTarget.row)
                    : -1;
                const currentCardIds = activeRenderGrid.orderedItems.map(it => it ? it.id : "");
                vscode.postMessage({
                    command: "swapCardItems",
                    sourceId: draggingFile.id,
                    targetId: null,
                    targetIsEmpty: true,
                    targetSlotIdx: slotIdx !== -1 ? slotIdx : dragTarget.row * activeRenderGrid.cols + dragTarget.col,
                    maxCapacity: activeRenderGrid.cols * activeRenderGrid.rows,
                    currentCardIds
                });
            }
        } else if (dragTarget) {
            const slotIdx = (activeRenderGrid && activeRenderGrid.layout && activeRenderGrid.layout.slots)
                ? activeRenderGrid.layout.slots.findIndex(s => s[0] === dragTarget.col && s[1] === dragTarget.row)
                : -1;
            vscode.postMessage({
                command: "reorderFile",
                sourceId: draggingFile.id,
                targetId: dragTarget.file ? dragTarget.file.id : null,
                targetIsEmpty: !dragTarget.file,
                targetCol: dragTarget.col,
                targetRow: dragTarget.row,
                targetSlotIdx: slotIdx,
                targetGridCols: dragTarget.gridCols || data.layout.cols,
                targetGridRows: (activeRenderGrid && activeRenderGrid.rows) || data.layout.rows,
                targetWrapRows: (activeRenderGrid && activeRenderGrid.wrapRows) || undefined,
                focusedFolder: focusedFolder || ""
            });
        }

        clearDragState();
        render();
        return;
    }

    // Check folder card clicks first (subfolder card mode)
    if (data._folderCards && activeCandidateFolder) {
        for (const card of data._folderCards) {
            if (pointInRect(card, cursorPos.px, cursorPos.py) &&
                card.folderPath === activeCandidateFolder.card.folderPath) {
                    setFocusedFolderWithHistory(card.folderPath);
                    return;
                }
        }
    }

    // Three click targets within a file card, checked most-specific first: the '×' close
    // button (only present when the tab is open), the header/path-label strip (isolates
    // that file's parent folder), then the thumbnail body (jumps the real editor to the
    // clicked line — see extension.ts's "jump" handler).
    if (!activeCandidateFile) {
        return;
    }

    const file = activeCandidateFile.file;
    const c = file?._cell;
    if (file && c && pointInRect(c, cursorPos.px, cursorPos.py)) {
        // Check if click was on close '×' button
        const cb = file._closeBtn;
        if (cb && pointInRect(cb, cursorPos.px, cursorPos.py, CLOSE_BUTTON_PADDING)) {
            openFiles = openFiles.filter(u => u !== file.uri);
            render();
            vscode.postMessage({
                command: "close",
                uri: file.uri
            });
            return;
        }

        const headerHeight = 24;
        const isHeaderClick = cursorPos.py < c.y + headerHeight;

        if (isHeaderClick) {
            // Clicked the file path/folder header bar -> isolate parent folder (or root files if in root folder)
            const lastSlash = file.path.lastIndexOf('/');
            if (lastSlash !== -1) {
                const folder = file.path.substring(0, lastSlash + 1);
                setFocusedFolderWithHistory(folder);
            } else {
                setFocusedFolderWithHistory("(root files)/");
            }
            return;
        }

        // Check if user clicked inside the transparent gray view band -> switch directly to existing tab
        if (c._viewBand && cursorPos.py >= c._viewBand.y && cursorPos.py <= c._viewBand.y + c._viewBand.h) {
            vscode.postMessage({
                command: "switchTab",
                uri: file.uri
            });
            return;
        }

        // Clicked inside media card body -> switch/open tab without line jump
        if (file.isImage || file.isPdf) {
            vscode.postMessage({
                command: "switchTab",
                uri: file.uri
            });
            return;
        }

        // Clicked inside the thumbnail body -> jump to line in document
        const thumbnailTop = c.y + headerHeight;
        const thumbnailHeight = Math.max(1, c.h - 34);

        const relativeY = Math.max(
            0,
            Math.min(1, (cursorPos.py - thumbnailTop) / thumbnailHeight)
        );

        const line = Math.floor(relativeY * file.lineCount);

        // query/matchCase/matchWholeWord/useRegex/searchInvalid mirror the search state
        // above so extension.ts's "jump" handler can flash the same lines this webview
        // considers matches — see its handler for the mirrored pattern-building logic.
        vscode.postMessage({
            command: "jump",
            uri: file.uri,
            line,
            query: rawSearchQuery,
            matchCase,
            matchWholeWord,
            useRegex,
            searchInvalid
        });
    }
});

window.addEventListener("mouseup", () => {
    candidateFile = null;
    candidateFolder = null;
});

canvas.addEventListener("mouseleave", () => {
    clearDragState();
    hoveredFile = null;
    render();
});

document.addEventListener("mouseleave", () => {
    isCtrlDown = false;
    cursorPos = null;
    tooltip.style.display = "none";
});

const contextMenu = document.getElementById("context-menu");

/** Hides the custom right-click context menu. */
function hideContextMenu() {
    if (contextMenu) {
        contextMenu.style.display = "none";
    }
}

document.addEventListener("click", event => {
    if (contextMenu && !contextMenu.contains(event.target)) {
        hideContextMenu();
    }
});

canvas.addEventListener("contextmenu", event => {
    event.preventDefault();

    if (draggingFile) {
        clearDragState();
        render();
        return;
    }

    if (!data) return;

    const { px, py } = getCanvasPos(event);

    const filteredFiles = getFilteredFiles();
    let targetFile = null;

    for (const file of filteredFiles) {
        const c = file._cell;
        if (!c) continue;

        if (pointInRect(c, px, py)) {
            targetFile = file;
            break;
        }
    }

    let targetFolderCard = null;
    if (!targetFile && data._folderCards) {
        for (const card of data._folderCards) {
            if (pointInRect(card, px, py)) {
                targetFolderCard = card;
                break;
            }
        }
    }

    tooltip.style.display = "none";

    const isMacPlatform = /Mac|iPod|iPhone|iPad/.test(navigator.platform || "") || /Mac/.test(navigator.userAgent || "");

    function renderMenuItem(id, label, shortcut = "", danger = false) {
        return `<div class="menu-item${danger ? " danger" : ""}" id="${id}"><span class="menu-item-label">${escapeHtml(label)}</span>${shortcut ? `<span class="menu-item-key">${escapeHtml(shortcut)}</span>` : ""}</div>`;
    }

    if (targetFile) {
        contextMenu.innerHTML = `
            ${renderMenuItem("menu-open", "Open")}
            ${renderMenuItem("menu-open-side", "Open to the Side", isMacPlatform ? "⌥Enter" : "Ctrl+Enter")}
            ${renderMenuItem("menu-reveal", "Reveal in Explorer", isMacPlatform ? "⇧⌥R" : "Shift+Alt+R")}
            ${renderMenuItem("menu-open-containing-folder", "Open Containing Folder", isMacPlatform ? "⌥⌘R" : "Ctrl+Alt+R")}
            ${renderMenuItem("menu-open-with", "Open With...")}
            ${renderMenuItem("menu-open-terminal", "Open in Integrated Terminal")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-select-compare", "Select for Compare")}
            ${renderMenuItem("menu-compare-selected", "Compare with Selected")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-open-timeline", "Open Timeline")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-cut", "Cut", isMacPlatform ? "⌘X" : "Ctrl+X")}
            ${renderMenuItem("menu-copy", "Copy", isMacPlatform ? "⌘C" : "Ctrl+C")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-copy-path", "Copy Path", isMacPlatform ? "⌥⌘C" : "Ctrl+Alt+C")}
            ${renderMenuItem("menu-copy-rel-path", "Copy Relative Path", isMacPlatform ? "⇧⌥⌘C" : "Ctrl+Shift+Alt+C")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-run-tests", "Run Tests")}
            ${renderMenuItem("menu-debug-tests", "Debug Tests")}
            ${renderMenuItem("menu-coverage-tests", "Run Tests with Coverage")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-rename", "Rename...", isMacPlatform ? "Enter" : "F2")}
            ${renderMenuItem("menu-delete", "Delete", isMacPlatform ? "⌘⌫" : "Delete", true)}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-ignore", "Ignore in Thumbview")}
        `;

        document.getElementById("menu-open").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "jump", uri: targetFile.uri, line: 0 });
        };
        document.getElementById("menu-open-side").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "openToSide", uri: targetFile.uri });
        };
        document.getElementById("menu-reveal").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "revealInFiles", uri: targetFile.uri });
        };
        document.getElementById("menu-open-containing-folder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "openContainingFolder", uri: targetFile.uri });
        };
        document.getElementById("menu-open-with").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "openWith", uri: targetFile.uri });
        };
        document.getElementById("menu-open-terminal").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "openInTerminal", uri: targetFile.uri });
        };
        document.getElementById("menu-select-compare").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "selectForCompare", uri: targetFile.uri });
        };
        document.getElementById("menu-compare-selected").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "compareWithSelected", uri: targetFile.uri });
        };
        document.getElementById("menu-open-timeline").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "openTimeline", uri: targetFile.uri });
        };
        document.getElementById("menu-cut").onclick = () => {
            hideContextMenu();
            clipboardItem = { uri: targetFile.uri, path: targetFile.path, isFolder: false, isCut: true };
            vscode.postMessage({ command: "cutFile", uri: targetFile.uri });
        };
        document.getElementById("menu-copy").onclick = () => {
            hideContextMenu();
            clipboardItem = { uri: targetFile.uri, path: targetFile.path, isFolder: false, isCut: false };
            vscode.postMessage({ command: "copyFile", uri: targetFile.uri });
        };
        document.getElementById("menu-copy-path").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "copyPath", uri: targetFile.uri });
        };
        document.getElementById("menu-copy-rel-path").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "copyRelativePath", uri: targetFile.uri });
        };
        document.getElementById("menu-run-tests").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "runTests", uri: targetFile.uri });
        };
        document.getElementById("menu-debug-tests").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "debugTests", uri: targetFile.uri });
        };
        document.getElementById("menu-coverage-tests").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "coverageTests", uri: targetFile.uri });
        };
        document.getElementById("menu-rename").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "renameFile", uri: targetFile.uri, path: targetFile.path });
        };
        document.getElementById("menu-delete").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "deleteFile", uri: targetFile.uri });
        };
        document.getElementById("menu-ignore").onclick = () => {
            hideContextMenu();
            if (targetFile && targetFile.path && !isPatternIgnored(targetFile.path)) {
                currentIgnorePatterns.unshift(targetFile.path);
                optimisticPatternCounts[targetFile.path] = 1;
                updateIgnoresPopover();
                updateFoldersPopover();
                const ignoresListEl = document.getElementById("ignores-list");
                if (ignoresListEl) ignoresListEl.scrollTop = 0;
            }
            vscode.postMessage({ command: "ignoreFile", uri: targetFile.uri, path: targetFile.path });
        };
    } else if (targetFolderCard) {
        contextMenu.innerHTML = `
            ${renderMenuItem("menu-open-folder", "Open Folder")}
            ${renderMenuItem("menu-reveal-folder", "Reveal in Explorer", isMacPlatform ? "⇧⌥R" : "Shift+Alt+R")}
            ${renderMenuItem("menu-terminal-folder", "Open in Integrated Terminal")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-new-file-folder", "New File...")}
            ${renderMenuItem("menu-new-subfolder", "New Folder...")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-cut-folder", "Cut Folder", isMacPlatform ? "⌘X" : "Ctrl+X")}
            ${renderMenuItem("menu-copy-folder", "Copy Folder", isMacPlatform ? "⌘C" : "Ctrl+C")}
            ${renderMenuItem("menu-paste-folder", "Paste", isMacPlatform ? "⌘V" : "Ctrl+V")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-copy-folder-path", "Copy Path", isMacPlatform ? "⌥⌘C" : "Ctrl+Alt+C")}
            ${renderMenuItem("menu-copy-folder-rel-path", "Copy Relative Path", isMacPlatform ? "⇧⌥⌘C" : "Ctrl+Shift+Alt+C")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-rename-folder", "Rename...", isMacPlatform ? "Enter" : "F2")}
            ${renderMenuItem("menu-delete-folder", "Delete Folder", isMacPlatform ? "⌘⌫" : "Delete", true)}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-ignore-folder", "Ignore Folder in Thumbview")}
        `;

        document.getElementById("menu-open-folder").onclick = () => {
            hideContextMenu();
            setFocusedFolderWithHistory(targetFolderCard.folderPath);
        };
        document.getElementById("menu-reveal-folder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "revealFolder", folderPath: targetFolderCard.folderPath });
        };
        document.getElementById("menu-terminal-folder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "openFolderInTerminal", folderPath: targetFolderCard.folderPath });
        };
        document.getElementById("menu-new-file-folder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "newFile", targetFolder: targetFolderCard.folderPath });
        };
        document.getElementById("menu-new-subfolder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "newFolder", targetFolder: targetFolderCard.folderPath });
        };
        document.getElementById("menu-cut-folder").onclick = () => {
            hideContextMenu();
            clipboardItem = { folderPath: targetFolderCard.folderPath, isFolder: true, isCut: true };
            vscode.postMessage({ command: "cutFolder", folderPath: targetFolderCard.folderPath });
        };
        document.getElementById("menu-copy-folder").onclick = () => {
            hideContextMenu();
            clipboardItem = { folderPath: targetFolderCard.folderPath, isFolder: true, isCut: false };
            vscode.postMessage({ command: "copyFolder", folderPath: targetFolderCard.folderPath });
        };
        document.getElementById("menu-paste-folder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "pasteItem", targetFolder: targetFolderCard.folderPath });
        };
        document.getElementById("menu-copy-folder-path").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "copyFolderPath", folderPath: targetFolderCard.folderPath });
        };
        document.getElementById("menu-copy-folder-rel-path").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "copyFolderRelativePath", folderPath: targetFolderCard.folderPath });
        };
        document.getElementById("menu-rename-folder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "renameFolder", folderPath: targetFolderCard.folderPath });
        };
        document.getElementById("menu-delete-folder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "deleteFolder", folderPath: targetFolderCard.folderPath });
        };
        document.getElementById("menu-ignore-folder").onclick = () => {
            hideContextMenu();
            const fp = targetFolderCard && targetFolderCard.folderPath;
            if (fp && !isPatternIgnored(fp)) {
                currentIgnorePatterns.unshift(fp);
                if (targetFolderCard.files && targetFolderCard.files.length) {
                    optimisticPatternCounts[fp] = targetFolderCard.files.length;
                }
                updateIgnoresPopover();
                updateFoldersPopover();
                const ignoresListEl = document.getElementById("ignores-list");
                if (ignoresListEl) ignoresListEl.scrollTop = 0;
            }
            vscode.postMessage({ command: "ignoreFolder", folderPath: targetFolderCard.folderPath });
        };
    } else {
        const currentTargetFolder = focusedFolder === "(root files)/" ? "" : (focusedFolder || "");
        contextMenu.innerHTML = `
            ${renderMenuItem("menu-space-new-file", "New File...")}
            ${renderMenuItem("menu-space-new-folder", "New Folder...")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-space-paste", "Paste", isMacPlatform ? "⌘V" : "Ctrl+V")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-space-expand", "Expand Grid Space")}
            ${renderMenuItem("menu-space-reduce", "Reduce Grid Space")}
            <div class="menu-separator"></div>
            ${renderMenuItem("menu-space-reflow", "Reflow Layout")}
            ${focusedFolder ? renderMenuItem("menu-space-root", "Show All Files (Root)") : renderMenuItem("menu-space-refresh", "Refresh View")}
        `;

        document.getElementById("menu-space-new-file").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "newFile", targetFolder: currentTargetFolder });
        };
        document.getElementById("menu-space-new-folder").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "newFolder", targetFolder: currentTargetFolder });
        };
        document.getElementById("menu-space-paste").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "pasteItem", targetFolder: currentTargetFolder });
        };
        document.getElementById("menu-space-expand").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "expandSpace" });
        };
        document.getElementById("menu-space-reduce").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "reduceSpace" });
        };
        document.getElementById("menu-space-reflow").onclick = () => {
            hideContextMenu();
            vscode.postMessage({ command: "reflow" });
        };
        if (focusedFolder) {
            document.getElementById("menu-space-root").onclick = () => {
                hideContextMenu();
                setFocusedFolderWithHistory("");
            };
        } else {
            document.getElementById("menu-space-refresh").onclick = () => {
                hideContextMenu();
                vscode.postMessage({ command: "refresh" });
            };
        }
    }

    contextMenu.style.display = "block";

    let cx = event.clientX;
    let cy = event.clientY;

    if (cx + contextMenu.offsetWidth > window.innerWidth) {
        cx = window.innerWidth - contextMenu.offsetWidth - 8;
    }
    if (cy + contextMenu.offsetHeight > window.innerHeight) {
        cy = window.innerHeight - contextMenu.offsetHeight - 8;
    }

    contextMenu.style.left = `${cx}px`;
    contextMenu.style.top = `${cy}px`;
});

// Re-render canvas automatically when user switches VS Code color theme
const themeObserver = new MutationObserver(() => {
    themeTokensDirty = true;
    refreshThemeTokens();
    render();
});
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });

// Functions for Settings Modal, Folder Navigation, and Ignored Items Popovers

function formatFolderPath(folderPath) {
    const escaped = escapeHtml(folderPath);
    return escaped.replace(/\//g, '<span class="path-sep">/</span>');
}

function updateSettingsModalState() {
    if (!data) return;
    const isSpanning = data.mode === "spanning_grid";
    const spanBtn = document.getElementById("layout-spanning-btn");
    const uniformBtn = document.getElementById("layout-uniform-btn");
    if (spanBtn && uniformBtn) {
        spanBtn.classList.toggle("active", isSpanning);
        uniformBtn.classList.toggle("active", !isSpanning);
    }

    const isSwap = (data.dragReorderMode || "swap") === "swap";
    const swapBtn = document.getElementById("drag-swap-btn");
    const shiftBtn = document.getElementById("drag-shift-btn");
    if (swapBtn && shiftBtn) {
        swapBtn.classList.toggle("active", isSwap);
        shiftBtn.classList.toggle("active", !isSwap);
    }

    const mediaToggle = document.getElementById("media-thumbnails-toggle");
    if (mediaToggle) {
        mediaToggle.checked = data.renderMediaThumbnails !== false;
    }
}

function escapeHtml(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function isPatternIgnored(target) {
    if (!target) return false;
    const clean = target.replace(/\/+$/, "");
    return currentIgnorePatterns.some(p => p === target || p.replace(/\/+$/, "") === clean);
}

function updateIgnoresPopover() {
    const countEl = document.getElementById("ignores-count");
    if (countEl) {
        countEl.textContent = currentIgnorePatterns.length;
    }

    const list = document.getElementById("ignores-list");
    if (!list) return;
    list.innerHTML = "";

    if (currentIgnorePatterns.length === 0) {
        const empty = document.createElement("div");
        empty.className = "popover-empty-state";
        empty.innerHTML = `${ICONS.empty}<div>No active ignore patterns</div><div class="empty-hint">Files and folders matching patterns above are excluded from the grid</div>`;
        list.appendChild(empty);
        return;
    }

    for (const pat of currentIgnorePatterns) {
        const isFolder = pat.endsWith("/") || pat === "(root files)/" || !pat.includes(".");
        const item = document.createElement("div");
        item.className = "popover-item";
        
        const label = document.createElement("div");
        label.style.display = "flex";
        label.style.alignItems = "center";
        label.style.gap = "8px";
        label.style.overflow = "hidden";
        label.style.textOverflow = "ellipsis";
        label.style.whiteSpace = "nowrap";
        label.style.flex = "1";
        label.style.minWidth = "0";

        const iconHtml = isFolder ? ICONS.ignoreFolder : ICONS.ignoreFile;
        const kindBadge = `<span class="pattern-type-badge">${isFolder ? "folder" : "pattern"}</span>`;

        let matchedCount = 0;
        if (data && data.ignorePatternCounts && typeof data.ignorePatternCounts[pat] === "number") {
            matchedCount = data.ignorePatternCounts[pat];
        } else if (optimisticPatternCounts && typeof optimisticPatternCounts[pat] === "number") {
            matchedCount = optimisticPatternCounts[pat];
        }
        const matchedFiles = (data && data.ignoredFilesMap && data.ignoredFilesMap[pat]) || [];
        const countBadge = `<span class="popover-item-count" style="margin-right: 6px; font-size: 10px;" title="${matchedCount} file${matchedCount === 1 ? '' : 's'} matching pattern">${matchedCount} file${matchedCount === 1 ? '' : 's'}</span>`;

        const tooltipText = matchedFiles.length > 0
            ? `${pat} (${matchedCount} file${matchedCount === 1 ? '' : 's'}):\n` + matchedFiles.slice(0, 10).join('\n') + (matchedFiles.length > 10 ? `\n...and ${matchedFiles.length - 10} more` : '')
            : pat;

        label.innerHTML = `${iconHtml}<span class="pattern-text" title="${escapeHtml(tooltipText)}">${escapeHtml(pat)}</span>${kindBadge}${countBadge}`;
        item.appendChild(label);

        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-pattern-btn";
        removeBtn.title = `Remove ignore rule '${pat}'`;
        removeBtn.innerHTML = ICONS.remove;
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            currentIgnorePatterns = currentIgnorePatterns.filter(p => p !== pat && p.replace(/\/+$/, "") !== pat.replace(/\/+$/, ""));
            if (optimisticPatternCounts) delete optimisticPatternCounts[pat];
            updateIgnoresPopover();
            updateFoldersPopover();
            vscode.postMessage({ command: "removeIgnorePattern", pattern: pat });
        };
        item.appendChild(removeBtn);

        list.appendChild(item);
    }
}


function updateFoldersPopover() {
    const list = document.getElementById("folders-list");
    if (!list || !data || !data.files) return;
    list.innerHTML = "";

    // 1. All Workspace Files (Root)
    const allItem = document.createElement("div");
    allItem.className = "popover-item" + (!focusedFolder ? " active" : "");
    allItem.innerHTML = `<span class="item-icon-label">${ICONS.workspace} <span>All Workspace Files (Root)</span></span><span class="popover-item-count">${data.files.length} files</span>`;
    allItem.onclick = () => {
        setFocusedFolderWithHistory("");
        closeAllPopovers();
    };
    list.appendChild(allItem);

    // 2. Root Directory Files Only (pseudo-folder for loose root files)
    const rootOnlyFiles = data.files.filter(f => f.path && !f.path.includes("/"));
    if (rootOnlyFiles.length > 0) {
        const rootItem = document.createElement("div");
        rootItem.className = "popover-item" + (focusedFolder === "(root files)/" ? " active" : "");

        const titleDiv = document.createElement("div");
        titleDiv.style.display = "flex";
        titleDiv.style.alignItems = "center";
        titleDiv.style.gap = "6px";
        titleDiv.style.flex = "1";
        titleDiv.style.minWidth = "0";

        const spacer = document.createElement("span");
        spacer.style.display = "inline-block";
        spacer.style.width = "18px";
        spacer.style.marginRight = "2px";
        spacer.style.flexShrink = "0";
        titleDiv.appendChild(spacer);

        const labelSpan = document.createElement("span");
        labelSpan.className = "item-icon-label";
        labelSpan.innerHTML = `${ICONS.rootFiles} <span>Root Directory Files Only</span>`;
        titleDiv.appendChild(labelSpan);

        const countSpan = document.createElement("span");
        countSpan.className = "popover-item-count";
        countSpan.textContent = `${rootOnlyFiles.length} file${rootOnlyFiles.length === 1 ? "" : "s"}`;
        titleDiv.appendChild(countSpan);

        rootItem.appendChild(titleDiv);

        const isRootIgnored = isPatternIgnored("(root files)/");
        const ignoreBtn = document.createElement("button");
        ignoreBtn.className = "popover-action-btn";
        if (isRootIgnored) {
            ignoreBtn.textContent = "Unignore";
            ignoreBtn.title = "Unignore root directory files";
            ignoreBtn.style.color = "var(--vscode-errorForeground, #f87171)";
            ignoreBtn.onclick = (e) => {
                e.stopPropagation();
                currentIgnorePatterns = currentIgnorePatterns.filter(p => p !== "(root files)/");
                if (optimisticPatternCounts) delete optimisticPatternCounts["(root files)/"];
                updateIgnoresPopover();
                updateFoldersPopover();
                vscode.postMessage({ command: "removeIgnorePattern", pattern: "(root files)/" });
            };
        } else {
            ignoreBtn.textContent = "Ignore";
            ignoreBtn.title = "Ignore root directory files in Thumbview";
            ignoreBtn.onclick = (e) => {
                e.stopPropagation();
                if (!isPatternIgnored("(root files)/")) {
                    currentIgnorePatterns.unshift("(root files)/");
                    optimisticPatternCounts["(root files)/"] = rootOnlyFiles.length;
                    updateIgnoresPopover();
                    updateFoldersPopover();
                    const ignoresListEl = document.getElementById("ignores-list");
                    if (ignoresListEl) ignoresListEl.scrollTop = 0;
                }
                vscode.postMessage({ command: "addIgnorePattern", pattern: "(root files)/" });
            };
        }
        rootItem.appendChild(ignoreBtn);

        rootItem.onclick = () => {
            setFocusedFolderWithHistory("(root files)/");
            closeAllPopovers();
        };
        list.appendChild(rootItem);
    }

    // 3. Collect directory paths and counts
    const folderCounts = new Map();
    for (const f of data.files) {
        if (!f.path) continue;
        const parts = f.path.split("/");
        if (parts.length > 1) {
            let currentPath = "";
            for (let i = 0; i < parts.length - 1; i++) {
                currentPath += parts[i] + "/";
                folderCounts.set(currentPath, (folderCounts.get(currentPath) || 0) + 1);
            }
        }
    }

    const sortedFolders = Array.from(folderCounts.keys()).sort((a, b) => a.localeCompare(b));
    const subfoldersByParent = new Map();
    for (const fp of sortedFolders) {
        const parent = getParentFolderPath(fp);
        if (parent) {
            if (!subfoldersByParent.has(parent)) subfoldersByParent.set(parent, []);
            subfoldersByParent.get(parent).push(fp);
        }
    }

    const countEl = document.getElementById("shown-folders-count");
    if (countEl) {
        countEl.textContent = sortedFolders.length + (rootOnlyFiles.length > 0 ? 1 : 0);
    }

    for (const folderPath of sortedFolders) {
        if (!isFolderVisibleInTree(folderPath, collapsedNavigatorFolders)) {
            continue;
        }

        const count = folderCounts.get(folderPath) || 0;
        const subfolders = subfoldersByParent.get(folderPath) || [];
        const hasSubfolders = subfolders.length > 0;
        const isCollapsed = collapsedNavigatorFolders.has(folderPath);

        const depth = folderPath.split("/").length - 1;
        const indent = Math.max(0, (depth - 1) * 16);

        const item = document.createElement("div");
        item.className = "popover-item" + (focusedFolder === folderPath ? " active" : "");
        item.style.paddingLeft = `${8 + indent}px`;

        const titleDiv = document.createElement("div");
        titleDiv.style.display = "flex";
        titleDiv.style.alignItems = "center";
        titleDiv.style.gap = "4px";
        titleDiv.style.flex = "1";
        titleDiv.style.minWidth = "0";

        if (hasSubfolders) {
            const chevronBtn = document.createElement("button");
            chevronBtn.className = "popover-chevron-btn";
            chevronBtn.style.color = "var(--vscode-foreground, #cccccc)";
            chevronBtn.style.width = "18px";
            chevronBtn.style.height = "18px";
            chevronBtn.style.display = "inline-flex";
            chevronBtn.style.alignItems = "center";
            chevronBtn.style.justifyContent = "center";
            chevronBtn.style.background = "transparent";
            chevronBtn.style.border = "none";
            chevronBtn.style.padding = "0";
            chevronBtn.style.margin = "0 2px 0 0";
            chevronBtn.style.cursor = "pointer";
            chevronBtn.style.flexShrink = "0";
            chevronBtn.innerHTML = isCollapsed ? ICONS.chevronRight : ICONS.chevronDown;
            chevronBtn.title = isCollapsed ? `Expand ${folderPath}` : `Collapse ${folderPath}`;
            chevronBtn.onclick = (e) => {
                e.stopPropagation();
                if (isCollapsed) {
                    collapsedNavigatorFolders.delete(folderPath);
                } else {
                    collapsedNavigatorFolders.add(folderPath);
                }
                updateFoldersPopover();
            };
            titleDiv.appendChild(chevronBtn);
        } else {
            const spacer = document.createElement("span");
            spacer.style.display = "inline-block";
            spacer.style.width = "18px";
            spacer.style.marginRight = "2px";
            spacer.style.flexShrink = "0";
            titleDiv.appendChild(spacer);
        }

        const labelSpan = document.createElement("span");
        labelSpan.className = "item-icon-label";
        labelSpan.style.overflow = "hidden";
        labelSpan.style.textOverflow = "ellipsis";
        labelSpan.style.whiteSpace = "nowrap";
        const displayName = getFolderSegmentName(folderPath);
        labelSpan.innerHTML = `${ICONS.folder} <span class="folder-name-text" title="${escapeHtml(folderPath)}">${escapeHtml(displayName)}</span>`;
        titleDiv.appendChild(labelSpan);

        const countSpan = document.createElement("span");
        countSpan.className = "popover-item-count";
        countSpan.textContent = `${count} file${count === 1 ? "" : "s"}`;
        titleDiv.appendChild(countSpan);

        item.appendChild(titleDiv);

        const isDirIgnored = isPatternIgnored(folderPath);
        const ignoreBtn = document.createElement("button");
        ignoreBtn.className = "popover-action-btn";
        if (isDirIgnored) {
            ignoreBtn.textContent = "Unignore";
            ignoreBtn.title = `Unignore folder '${folderPath}'`;
            ignoreBtn.style.color = "var(--vscode-errorForeground, #f87171)";
            ignoreBtn.onclick = (e) => {
                e.stopPropagation();
                currentIgnorePatterns = currentIgnorePatterns.filter(p => p !== folderPath && p.replace(/\/+$/, "") !== folderPath.replace(/\/+$/, ""));
                updateIgnoresPopover();
                updateFoldersPopover();
                vscode.postMessage({ command: "removeIgnorePattern", pattern: folderPath });
            };
        } else {
            ignoreBtn.textContent = "Ignore";
            ignoreBtn.title = `Ignore folder '${folderPath}' in Thumbview`;
            ignoreBtn.onclick = (e) => {
                e.stopPropagation();
                if (!isPatternIgnored(folderPath)) {
                    currentIgnorePatterns.unshift(folderPath);
                    if (typeof count === "number") {
                        optimisticPatternCounts[folderPath] = count;
                    }
                    updateIgnoresPopover();
                    updateFoldersPopover();
                    const ignoresListEl = document.getElementById("ignores-list");
                    if (ignoresListEl) ignoresListEl.scrollTop = 0;
                }
                vscode.postMessage({ command: "addIgnorePattern", pattern: folderPath });
            };
        }
        item.appendChild(ignoreBtn);

        item.onclick = () => {
            setFocusedFolderWithHistory(folderPath);
            closeAllPopovers();
        };
        list.appendChild(item);
    }
}

// Popover and Modal Elements & Handlers
const foldersBtn = document.getElementById("folders-btn");
const foldersPopover = document.getElementById("folders-popover");
const closeFoldersPopover = document.getElementById("close-folders-popover");
const addIgnoreInput = document.getElementById("add-ignore-input");
const addIgnoreBtn = document.getElementById("add-ignore-btn");

const actionsBtn = document.getElementById("actions-btn");
const actionsModal = document.getElementById("actions-modal");
const closeModal = document.getElementById("close-modal");

function closeAllPopovers() {
    if (foldersPopover) foldersPopover.style.display = "none";
    if (actionsModal) actionsModal.style.display = "none";
    if (foldersBtn) foldersBtn.classList.remove("active");
    if (actionsBtn) actionsBtn.classList.remove("active");
}

if (foldersBtn && foldersPopover) {
    foldersBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = foldersPopover.style.display === "block";
        closeAllPopovers();
        if (!isOpen) {
            updateFoldersPopover();
            updateIgnoresPopover();
            foldersPopover.style.display = "block";
            foldersBtn.classList.add("active");
        }
    };
}
if (closeFoldersPopover && foldersPopover) {
    closeFoldersPopover.onclick = () => {
        foldersPopover.style.display = "none";
        if (foldersBtn) foldersBtn.classList.remove("active");
    };
}

function handleAddIgnore() {
    if (!addIgnoreInput) return;
    const val = addIgnoreInput.value.trim();
    if (val) {
        if (!isPatternIgnored(val)) {
            currentIgnorePatterns.unshift(val);
            updateIgnoresPopover();
            updateFoldersPopover();
            const ignoresListEl = document.getElementById("ignores-list");
            if (ignoresListEl) ignoresListEl.scrollTop = 0;
        }
        vscode.postMessage({ command: "addIgnorePattern", pattern: val });
        addIgnoreInput.value = "";
    }
}
if (addIgnoreBtn) {
    addIgnoreBtn.onclick = handleAddIgnore;
}
if (addIgnoreInput) {
    addIgnoreInput.onkeydown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleAddIgnore();
        }
    };
}

if (actionsBtn && actionsModal) {
    actionsBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = actionsModal.style.display === "block";
        closeAllPopovers();
        if (!isOpen) {
            updateSettingsModalState();
            actionsModal.style.display = "block";
            actionsBtn.classList.add("active");
        }
    };
}
if (closeModal && actionsModal) {
    closeModal.onclick = () => {
        actionsModal.style.display = "none";
        if (actionsBtn) actionsBtn.classList.remove("active");
    };
}

// Settings modal buttons
const layoutSpanningBtn = document.getElementById("layout-spanning-btn");
const layoutUniformBtn = document.getElementById("layout-uniform-btn");
if (layoutSpanningBtn) {
    layoutSpanningBtn.onclick = () => {
        vscode.postMessage({ command: "setLayoutMode", mode: "spanning_grid" });
    };
}
if (layoutUniformBtn) {
    layoutUniformBtn.onclick = () => {
        vscode.postMessage({ command: "setLayoutMode", mode: "uniform_grid" });
    };
}

const dragSwapBtn = document.getElementById("drag-swap-btn");
const dragShiftBtn = document.getElementById("drag-shift-btn");
if (dragSwapBtn) {
    dragSwapBtn.onclick = () => {
        vscode.postMessage({ command: "setDragReorderMode", mode: "swap" });
    };
}
if (dragShiftBtn) {
    dragShiftBtn.onclick = () => {
        vscode.postMessage({ command: "setDragReorderMode", mode: "shift" });
    };
}

const mediaThumbnailsToggle = document.getElementById("media-thumbnails-toggle");
if (mediaThumbnailsToggle) {
    mediaThumbnailsToggle.onchange = () => {
        vscode.postMessage({ command: "setRenderMediaThumbnails", enabled: mediaThumbnailsToggle.checked });
    };
}

const expandGridBtn = document.getElementById("expand-grid-btn");
if (expandGridBtn) {
    expandGridBtn.onclick = () => {
        vscode.postMessage({ command: "expandSpace" });
    };
}

const reduceGridBtn = document.getElementById("reduce-grid-btn");
if (reduceGridBtn) {
    reduceGridBtn.onclick = () => {
        vscode.postMessage({ command: "reduceSpace" });
    };
}

// Side mouse button navigation on breadcrumbs:
// Button 3 = Browser Back, Button 4 = Browser Forward
window.addEventListener("mouseup", event => {
    if (event.button === 3) {
        event.preventDefault();
        event.stopPropagation();
        handleBreadcrumbBack();
    } else if (event.button === 4) {
        event.preventDefault();
        event.stopPropagation();
        handleBreadcrumbForward();
    }
});

window.addEventListener("mousedown", event => {
    if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        event.stopPropagation();
    }
});

window.addEventListener("auxclick", event => {
    if (event.button === 3) {
        event.preventDefault();
        handleBreadcrumbBack();
    } else if (event.button === 4) {
        event.preventDefault();
        handleBreadcrumbForward();
    }
});

const reflowLayoutBtn = document.getElementById("reflow-layout-btn");
if (reflowLayoutBtn) {
    reflowLayoutBtn.onclick = () => {
        vscode.postMessage({ command: "reflow" });
    };
}

const changeHotkeyBtn = document.getElementById("change-hotkey-btn");
if (changeHotkeyBtn) {
    changeHotkeyBtn.onclick = () => {
        vscode.postMessage({ command: "configureHotkey" });
    };
}

document.addEventListener("click", event => {
    const clickedInside =
        (actionsModal && actionsModal.contains(event.target)) ||
        (foldersPopover && foldersPopover.contains(event.target)) ||
        event.target === actionsBtn ||
        event.target === foldersBtn;

    if (!clickedInside) {
        closeAllPopovers();
    }
});

resize();
window.focus();

function checkAndRequestZenMode() {
    const heightDiff = window.outerHeight - window.innerHeight;
    const isAlreadyZen = heightDiff < 30 && window.innerHeight > 300;
    if (!isAlreadyZen) {
        vscode.postMessage({
            command: "ensureZenMode"
        });
    }
}
checkAndRequestZenMode();

vscode.postMessage({
    command: "ready"
});