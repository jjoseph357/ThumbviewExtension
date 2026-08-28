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

// Fixed brand accents — single source of truth is src/colors.ts, injected here as
// CSS custom properties by extension.ts. Never hardcode these hexes elsewhere.
const ACCENT_SEARCH = getThemeColor("--tv-accent-search");
const ACCENT_INSPECT = getThemeColor("--tv-accent-inspect");
const ACCENT_RECENCY = getThemeColor("--tv-accent-recency");

// hex -> rgba(...) at a given alpha. Duplicated from src/colors.ts (webview can't
// import it) — keep both in sync by hand.
function withAlpha(hex, alpha) {
    if (!hex) return `rgba(0, 0, 0, ${alpha})`;
    const clean = hex.replace("#", "");
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

let data = null;
let statusText = "Loading Thumbview...";
let activeFileUri = null;
let focusedFolder = ""; // empty means root

let currentIgnorePatterns = [];
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
let dragGrabOffset = null;
let cursorPos = null;
let dragRafId = null;
let dragTargetFile = null;
let dragTarget = null;

let hoveredFile = null;

const slotOccupancy = new Map();

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
    const filteredFiles = getFilteredFiles();
    for (const file of filteredFiles) {
        const c = file._cell;
        if (!c) continue;

        if (pointInRect(c, px, py)) {
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
    const cellW = availableW / data.layout.cols;
    const cellH = availableH / data.layout.rows;
    const col = Math.floor((px - GRID_SIDE_MARGIN) / cellW);
    const row = Math.floor((py - GRID_TOP_MARGIN) / cellH);

    const col_clamped = clamp(col, 0, data.layout.cols - 1);
    const row_clamped = clamp(row, 0, data.layout.rows - 1);
    const file = slotOccupancy.get(`${col_clamped},${row_clamped}`) ?? null;

    return {
        cellW: cellW,
        cellH: cellH,
        col: col_clamped,
        row: row_clamped,
        file: file,
    };
}

/** Recomputes dragTargetFile from the live drag cursor position (cursorPos); called on every throttled mousemove while dragging. */
function updateDragTarget() {
    if (!draggingFile || !cursorPos) return;

    dragTarget = findNearestSlot(cursorPos.px, cursorPos.py);
    dragTargetFile = dragTarget?.file ?? null;
}

/** Resets all drag-related module state and cancels any pending drag animation frame. */
function clearDragState() {
    candidateFile = null;
    draggingFile = null;
    dragGrabOffset = null;
    dragTarget = null;
    dragTargetFile = null;

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
                    `<span style="background: ${withAlpha(ACCENT_SEARCH, 0.45)}; color: #ffffff; font-weight: 600; border-radius: 2px; padding: 0 2px;">${m}</span>`
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

    if (event.ctrlKey && !event.altKey && !event.metaKey) {
        if (event.key === 'Backspace') {
            event.preventDefault();
            clearSearch();
            // NOTE: maybe this should also grab focus for searchInputFld?
            return;
        }
    }

    if (document.activeElement === searchInputFld) {
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
        statusText = "";
        hoverLineCache = {};
        slotOccupancy.clear();
        if (data && data.files) {
            for (let fIdx = 0; fIdx < data.files.length; fIdx++) {
                const f = data.files[fIdx];
                f._lowerPath = f.path ? f.path.toLowerCase() : "";
                const lang = detectLang(f.path);
                const textArr = [];
                const textArrOriginal = [];
                if (f.path) textArr.push(f.path.toLowerCase());
                if (f.lines) {
                    for (let lIdx = 0; lIdx < f.lines.length; lIdx++) {
                        const l = f.lines[lIdx];
                        const lower = l.text ? l.text.toLowerCase() : "";
                        l._lowerText = lower;
                        l._tokens = tokenizeLine(l.text ? l.text.trimStart() : "", lang);
                        textArr.push(lower);
                        textArrOriginal.push(l.text || "");
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
                f._combinedText = textArr.join("\n");                 // lowercased (existing)
                f._combinedTextOriginal = textArrOriginal.join("\n"); // add: same loop, no .toLowerCase()
                if (f.slots) {
                    for (const [col, row] of f.slots) {
                        slotOccupancy.set(`${col},${row}`, f);
                    }
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
        focusedFolder = msg.folder || "";
        updateBreadcrumbs();
        render();
    }

    if (msg.command === "hoverLines") {
        if (!hoverLineCache[msg.uri]) {
            hoverLineCache[msg.uri] = {};
        }
        if (msg.lines && Array.isArray(msg.lines)) {
            for (let idx = 0; idx < msg.lines.length; idx++) {
                hoverLineCache[msg.uri][msg.start + idx] = msg.lines[idx];
            }
            if (data && data.files) {
                const f = data.files.find(file => file.uri === msg.uri);
                if (f) delete f._widestLineWidth;
            }
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
        const newRows = rows + 1;
        const newCols = Math.max(
            cols,
            Math.ceil(newRows * targetAspect)
        );

        for (let r = 0; r < rows; r++) {
            for (let c = cols; c < newCols; c++) {
                slots.push([c, r]);
            }
        }

        for (let r = rows; r < newRows; r++) {
            for (let c = 0; c < newCols; c++) {
                slots.push([c, r]);
            }
        }

        rows = newRows;
        cols = newCols;
    }

    return {
        rows,
        cols,
        slots
    };
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
        focusedFolder = "";
        updateBreadcrumbs();
        render();
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
            focusedFolder = pathRef;
            updateBreadcrumbs();
            render();
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
 */
function getSubfolderGroups(files, basePath) {
    const groups = {};
    const rootFiles = [];

    for (const f of files) {
        const relPath = basePath ? f.path.substring(basePath.length) : f.path;
        const slashIdx = relPath.indexOf("/");
        if (slashIdx === -1) {
            rootFiles.push(f);
        } else {
            const folderName = relPath.substring(0, slashIdx);
            const folderPath = (basePath || "") + folderName + "/";
            if (!groups[folderPath]) {
                groups[folderPath] = { name: folderName, path: folderPath, fileCount: 0, files: [] };
            }
            groups[folderPath].fileCount++;
            groups[folderPath].files.push(f);
        }
    }

    const folders = Object.values(groups).sort((a, b) => b.fileCount - a.fileCount);
    return { folders, rootFiles };
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
    if (isKey) return "#9cdcfe";

    switch (category) {
        case "comment":
            return getThemeColor("--vscode-editorComment-foreground", "#6a9955");
        case "string":
            return "#ce9178";
        case "number":
            return "#b5cea8";
        case "control-flow":
            return "#c586c0";
        case "keyword":
            return "#569cd6";
        case "operator":
        case "normal":
            return getThemeColor("--vscode-editor-foreground", "#cccccc");
        case "function":
            return "#dcdcaa";
        case "type":
            return "#4ec9b0";
        case "heading":
            return "#9cdcfe";
        case "variable":
        case "property":
        case "css-property":
        case "attribute":
            return "#9cdcfe";
        case "selector":
        case "css-value":
            return "#ce9178";
        case "tag":
            return "#569cd6";
        case "tag-bracket":
            return "#808080";
        default:
            return getThemeColor("--vscode-editor-foreground", "#d4d4d4");
    }
}

let imageCache = {}; // keyed by media URI; cleared on repository data updates (see "data" handler)

/** Draws img into the x,y,w,h rect scaled to fit while preserving its aspect ratio (object-fit: contain), background-filling the rest. */
function drawAspectFit(ctx, img, x, y, w, h, bgStyle = "#1e1e24") {
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

    ctx.fillStyle = bgStyle;
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
    deletedLine: "rgba(239, 68, 68, 0.65)",
    badgeModified: "#3b82f6",
    badgeAdded: "#22c55e",
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
    viewportBandOverlay: getThemeColor("--vscode-editor-selectionBackground", "rgba(255, 255, 255, 0.22)"),
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
            ctx.fillRect(x, y + i * stepY, w, Math.max(stepY, THUMBNAIL_GIT_DELETED_HEIGHT));
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
const TILE_BACKGROUND = getThemeColor("--vscode-editor-background", "#1e1e24");
const TILE_LABEL_FONT = "10px system-ui, sans-serif";
const TILE_LABEL_OFFSET_X = 10;
const TILE_LABEL_OFFSET_Y = 18;
const TILE_LABEL_WIDTH_MARGIN = 36; // reserved space so the label doesn't run under the close button
const TILE_LABEL_COLOR = {
    searchMatch: ACCENT_SEARCH,
    active: getThemeColor("--vscode-foreground", "#ffffff"),
    normal: getThemeColor("--vscode-descriptionForeground", "#a0a0a5")
};
const TILE_THUMBNAIL_OFFSET_X = 10;
const TILE_THUMBNAIL_OFFSET_Y = 24;
const TILE_THUMBNAIL_WIDTH_MARGIN = 20;
const TILE_THUMBNAIL_HEIGHT_MARGIN = 34;

const BORDER_STYLES = {
    searchMatch: { color: ACCENT_SEARCH, width: 2.5 },
    active:      { color: getThemeColor("--vscode-focusBorder", "#007fd4"), width: 2.5 },
    open:        { color: ACCENT_RECENCY, width: 1.8 },
    dragging:    { color: "#648fff", width: 1.8 },
    default:     { color: getThemeColor("--vscode-widget-border", "rgba(255, 255, 255, 0.08)"), width: 1 }
};

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
const CLOSE_BTN_COLOR = getThemeColor("--vscode-descriptionForeground", "#707075");

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

    ctx.fillStyle = isSearchMatch ? TILE_LABEL_COLOR.searchMatch : (isActive ? TILE_LABEL_COLOR.active : TILE_LABEL_COLOR.normal);
    ctx.font = TILE_LABEL_FONT;

    if (file._lastCellW !== w || !file._fittedLabel) {
        file._lastCellW = w;
        file._fittedLabel = fitPathText(file.path, w - TILE_LABEL_WIDTH_MARGIN);
    }
    ctx.fillText(file._fittedLabel, x + TILE_LABEL_OFFSET_X, y + TILE_LABEL_OFFSET_Y);

    if (file.gitStatus) {
        ctx.font = "bold 9px system-ui, sans-serif";
        const badgeX = x + w - (isOpen ? TILE_LABEL_WIDTH_MARGIN : 22);
        if (file.gitStatus === "modified") {
            ctx.fillStyle = GIT_STYLES.badgeModified;
            ctx.fillText("M", badgeX, y + TILE_LABEL_OFFSET_Y);
        } else if (file.gitStatus === "added" || file.gitStatus === "untracked") {
            ctx.fillStyle = GIT_STYLES.badgeAdded;
            ctx.fillText(file.gitStatus === "untracked" ? "U" : "A", badgeX, y + TILE_LABEL_OFFSET_Y);
        }
    }

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
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!data) {
        drawStatus();
        return;
    }

    ctx.clearRect(0, 0, rectW, rectH);
    ctx.fillStyle = getThemeColor("--vscode-editor-background", "#18181c");
    ctx.fillRect(0, 0, rectW, rectH);

    const filteredFiles = getFilteredFiles();
    if (filteredFiles.length === 0) {
        ctx.fillStyle = getThemeColor("--vscode-descriptionForeground", "#707075");
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

    const rootCellW = availableW / gridCols;
    const rootCellH = availableH / gridRows;

    // Minimum usable cell size — below this, tiles are too small to read/click,
    // so we switch to subfolder card mode that groups files into clickable folder cards.
    const MIN_CELL_W = data && typeof data.minCellWidth === "number" ? data.minCellWidth : 32;
    const MIN_CELL_H = data && typeof data.minCellHeight === "number" ? data.minCellHeight : 28;

    const rootCellsTooSmall = rootCellW < MIN_CELL_W || rootCellH < MIN_CELL_H;

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
    let folderCellW = rootCellW;
    let folderCellH = rootCellH;

    if (shouldOpenFolder) {
        localFolderGrid = buildStableGrid(scopedFiles.length);
        folderCellW = availableW / Math.max(1, localFolderGrid.cols);
        folderCellH = availableH / Math.max(1, localFolderGrid.rows);
        cellsTooSmall = folderCellW < MIN_CELL_W || folderCellH < MIN_CELL_H;
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
        // Subfolder card mode: group files into immediate child folders and render
        // each as a clickable card. Root-level files get individual tiles. The local
        // buildStableGrid duplicate computes a fresh grid for these items.
        const { folders, rootFiles } = getSubfolderGroups(scopedFiles, focusedFolder === "(root files)/" ? "" : focusedFolder);
        const totalItems = folders.length + rootFiles.length;
        if (totalItems === 0) return;

        const localGrid = buildStableGrid(totalItems);
        const localCellW = availableW / localGrid.cols;
        const localCellH = availableH / localGrid.rows;

        let slotIdx = 0;

        // Render folder cards
        for (const group of folders) {
            if (slotIdx >= localGrid.slots.length) break;
            const slot = localGrid.slots[slotIdx++];
            const x = GRID_SIDE_MARGIN + slot[0] * localCellW;
            const y = GRID_TOP_MARGIN + slot[1] * localCellH;

            if (y + localCellH < -50 || y > rectH + 50) continue;

            const isFolderMatch = !focusedFolder || (focusedFolder === "(root files)/" ? false : (group.path.startsWith(focusedFolder) || focusedFolder.startsWith(group.path)));

            ctx.save();
            if (!isFolderMatch) ctx.globalAlpha = 0.15;

            // Card background with folder accent
            ctx.fillStyle = getThemeColor("--vscode-editor-background", "#1e1e24");
            ctx.fillRect(x + 4, y + 4, localCellW - 8, localCellH - 8);

            ctx.strokeStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.4);
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 4, y + 4, localCellW - 8, localCellH - 8);

            // Folder icon accent bar
            ctx.fillStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.15);
            ctx.fillRect(x + 4, y + 4, localCellW - 8, Math.min(22, localCellH - 8));

            // Folder name
            ctx.fillStyle = getThemeColor("--vscode-foreground", "#c4b5fd");
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
            ctx.fillStyle = getThemeColor("--vscode-descriptionForeground", "#707075");
            ctx.font = `${Math.max(7, fontSize - 2)}px system-ui, sans-serif`;
            const countText = `${group.fileCount} file${group.fileCount !== 1 ? "s" : ""}`;
            ctx.fillText(countText, x + 10, y + 18 + fontSize + 2);

            // Density preview bar — color-coded horizontal bar proportional to file count
            if (localCellH > 50) {
                const barY = y + localCellH - 16;
                const barW = Math.min(localCellW - 20, Math.max(10, (group.fileCount / 50) * (localCellW - 20)));
                const hue = Math.max(0, 270 - group.fileCount * 3);
                ctx.fillStyle = `hsla(${hue}, 60%, 55%, 0.5)`;
                ctx.fillRect(x + 10, barY, barW, 6);
            }

            // Store click target for folder cards
            data._folderCards.push({
                x: x + 4,
                y: y + 4,
                w: localCellW - 8,
                h: localCellH - 8,
                folderPath: group.path
            });

            ctx.restore();
        }

        // Render root-level files as individual tiles in the same grid
        for (const file of rootFiles) {
            if (slotIdx >= localGrid.slots.length) break;
            const slot = localGrid.slots[slotIdx++];
            const col = slot[0];
            const row = slot[1];

            const x = GRID_SIDE_MARGIN + col * localCellW;
            const y = GRID_TOP_MARGIN + row * localCellH;
            const fileH = localCellH;

            file._cell = { x, y, w: localCellW, h: fileH };

            if (y + fileH < -50 || y > rectH + 50) continue;

            const isFolderMatch = !focusedFolder || (focusedFolder === "(root files)/" ? !file.path.includes("/") : file.path.startsWith(focusedFolder));
            const isSearchMatch = queryActive && textMatches(file._combinedTextOriginal, file._combinedText);

            drawFileTile(file, x, y, localCellW, fileH, !isFolderMatch || (queryActive && !isSearchMatch));
        }
    } else if (shouldOpenFolder) {
        // Directory drill-down mode — render all files in focusedFolder as a Thumbview grid
        const slots = localFolderGrid ? localFolderGrid.slots : [];
        const cellW = folderCellW;
        const cellH = folderCellH;

        for (let i = 0; i < scopedFiles.length; i++) {
            const file = scopedFiles[i];
            const slot = slots[i];
            if (!slot) continue;

            const col = slot[0];
            const row = slot[1];
            const nCells = file.nCells || 1;

            const x = GRID_SIDE_MARGIN + col * cellW;
            const y = GRID_TOP_MARGIN + row * cellH;
            const fileH = cellH * nCells;

            file._cell = { x, y, w: cellW, h: fileH };

            if (y + fileH < -50 || y > rectH + 50) continue;

            const isSearchMatch = queryActive && textMatches(file._combinedTextOriginal, file._combinedText);

            drawFileTile(file, x, y, cellW, fileH, queryActive && !isSearchMatch);
        }
    } else {
        // Normal file tile mode — cells are large enough to render individual thumbnails
        const slots = filteredFiles.map(f => f.slot);
        const cellW = rootCellW;
        const cellH = rootCellH;

        for (let i = 0; i < filteredFiles.length; i++) {
            const file = filteredFiles[i];
            const slot = slots[i];
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

    if (draggingFile) {
        // ghost for currently-dragged file
        const x = cursorPos.px - dragGrabOffset.x;
        const y = cursorPos.py - dragGrabOffset.y;
        const style = BORDER_STYLES.dragging;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = style.width;
        ctx.strokeRect(x, y, draggingFile._cell.w, draggingFile._cell.h);
        ctx.fillStyle = style.color;
        ctx.font = TILE_LABEL_FONT;
        ctx.fillText(draggingFile._fittedLabel, x + TILE_LABEL_OFFSET_X, y + TILE_LABEL_OFFSET_Y);

        // drop-target outline
        if (dragTarget.file) {
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

// Middle-click (auxclick) to close tab
canvas.addEventListener("auxclick", event => {
    if (!data || event.button !== 1) { // 1 = middle mouse button
        return;
    }

    const { px, py } = getCanvasPos(event);

    const filteredFiles = getFilteredFiles();
    for (const file of filteredFiles) {
        const c = file._cell;
        if (!c) continue;

        if (
            px >= c.x &&
            px <= c.x + c.w &&
            py >= c.y &&
            py <= c.y + c.h
        ) {
            const isOpen = openFiles.includes(file.uri);
            if (isOpen) {
                vscode.postMessage({
                    command: "close",
                    uri: file.uri
                });
            }
            return;
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

        const gitType = (hoveredFile.gitStatus === "untracked" || hoveredFile.gitStatus === "added")
            ? "added"
            : (hoveredFile.gitChanges ? hoveredFile.gitChanges[i] : undefined);

        let bgStyle = "display: block; box-sizing: border-box; width: 100%; min-height: 1.4em;";
        let prefix = "  ";

        if (isHoveredLine) {
            prefix = `<span style="color: ${ACCENT_INSPECT}; font-weight: bold;">&gt; </span>`;
            if (isMatchLine) {
                bgStyle = `background: ${withAlpha(ACCENT_SEARCH, 0.28)}; display: block; box-sizing: border-box; width: 100%; border-left: 3px solid ${ACCENT_SEARCH}; padding-left: 2px; min-height: 1.4em;`;
            } else if (gitType === "modified") {
                bgStyle = "background: rgba(59, 130, 246, 0.22); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid #3b82f6; padding-left: 2px; min-height: 1.4em;";
            } else if (gitType === "added") {
                bgStyle = "background: rgba(34, 197, 94, 0.22); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid #22c55e; padding-left: 2px; min-height: 1.4em;";
            } else if (gitType === "removed") {
                bgStyle = "background: rgba(239, 68, 68, 0.25); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid #ef4444; padding-left: 2px; min-height: 1.4em;";
            } else {
                bgStyle = `background: ${withAlpha(ACCENT_INSPECT, 0.18)}; display: block; box-sizing: border-box; width: 100%; border-left: 3px solid ${ACCENT_INSPECT}; padding-left: 2px; min-height: 1.4em;`;
            }
        } else if (isMatchLine) {
            bgStyle = `background: ${withAlpha(ACCENT_SEARCH, 0.2)}; display: block; box-sizing: border-box; width: 100%; border-left: 3px solid ${ACCENT_SEARCH}; padding-left: 2px; min-height: 1.4em;`;
        } else if (gitType === "modified") {
            bgStyle = "background: rgba(59, 130, 246, 0.14); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid rgba(59, 130, 246, 0.85); padding-left: 2px; min-height: 1.4em;";
        } else if (gitType === "added") {
            bgStyle = "background: rgba(34, 197, 94, 0.14); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid rgba(34, 197, 94, 0.85); padding-left: 2px; min-height: 1.4em;";
        } else if (gitType === "removed") {
            bgStyle = "background: rgba(239, 68, 68, 0.18); display: block; box-sizing: border-box; width: 100%; border-left: 3px solid rgba(239, 68, 68, 0.85); padding-left: 2px; min-height: 1.4em;";
        }

        tooltipHtml += `<div style="${bgStyle}">${prefix}${lineHtml}</div>`;
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
                    return;
                }
        }
    }

    // is mousedown on a file
    const filteredFiles = getFilteredFiles();
    for (const file of filteredFiles) {
        const c = file._cell;
        if (!c) continue;

        if (pointInRect(c, cursorPos.px, cursorPos.py)) {
                candidateFile = { file, startX: cursorPos.px, startY: cursorPos.py };
                dragGrabOffset = { x: cursorPos.px - c.x, y: cursorPos.py - c.y };
                return;
            }
    }
});

// MARK: mousemove
canvas.addEventListener("mousemove", event => {
    checkWindowFocus();

    lastMousePos = { x: event.clientX, y: event.clientY };
    cursorPos = getCanvasPos(event);
    hoveredFile = findFileAt(cursorPos.px, cursorPos.py);

    if (candidateFile && !draggingFile) {
        const dx = Math.abs(candidateFile.startX - cursorPos.px);
        const dy = Math.abs(candidateFile.startY - cursorPos.py);

        // only start dragging if cursor has moved more than the threshold
        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            draggingFile = candidateFile.file;
            candidateFile = null;
        }
    }
    if (draggingFile) {
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

    if (draggingFile) {
        updateDragTarget();

        // Grid-slot targeting — targetId is the occupied slot's file id, or null when
        // targetIsEmpty; targetCol/targetRow/targetGridCols let the host compute an
        // array index for empty-slot drops without recomputing (and risking disagreeing
        // with) the exact cols value this payload was rendered against. See the
        // "reorderFile" handler in extension.ts (keep both ends in sync).
        vscode.postMessage({
            command: "reorderFile",
            sourceId: draggingFile.id,
            targetId: dragTarget.file ? dragTarget.file.id : null,
            targetIsEmpty: !dragTarget.file,
            targetCol: dragTarget.col,
            targetRow: dragTarget.row,
            targetGridCols: data.layout.cols
        });

        clearDragState();
        render();
        return;
    }

    // Check folder card clicks first (subfolder card mode)
    if (data._folderCards && candidateFolder) {
        for (const card of data._folderCards) {
            if (pointInRect(card, cursorPos.px, cursorPos.py) &&
                card.folderPath === candidateFolder.card.folderPath) {
                    focusedFolder = card.folderPath;
                    updateBreadcrumbs();
                    render();
                    return;
                }
        }
    }

    // Three click targets within a file card, checked most-specific first: the '×' close
    // button (only present when the tab is open), the header/path-label strip (isolates
    // that file's parent folder), then the thumbnail body (jumps the real editor to the
    // clicked line — see extension.ts's "jump" handler).
    if (!candidateFile) {
        candidateFolder = null;
        return;
    }
    const filteredFiles = getFilteredFiles();
    for (const file of filteredFiles) {
        const c = file._cell;
        if (!c) continue;

        if (pointInRect(c, cursorPos.px, cursorPos.py) && file === candidateFile.file) {
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
                    focusedFolder = folder;
                } else {
                    focusedFolder = "(root files)/";
                }
                updateBreadcrumbs();
                render();
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

            return;
        }
    }
    
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

    if (!targetFile) {
        hideContextMenu();
        return;
    }

    tooltip.style.display = "none";

    const isOpen = openFiles.includes(targetFile.uri);

    contextMenu.innerHTML = `
        <div class="menu-item" id="menu-open">Open</div>
        <div class="menu-item" id="menu-open-side">Open to the Side</div>
        <div class="menu-item" id="menu-open-preview">Open Preview</div>
        <div class="menu-separator"></div>
        <div class="menu-item" id="menu-select-compare">Select for Compare</div>
        <div class="menu-item" id="menu-compare-selected">Compare with Selected</div>
        <div class="menu-separator"></div>
        <div class="menu-item" id="menu-reveal">Reveal in Explorer</div>
        <div class="menu-item" id="menu-open-containing-folder">Open Containing Folder</div>
        <div class="menu-separator"></div>
        <div class="menu-item" id="menu-cut">Cut</div>
        <div class="menu-item" id="menu-copy">Copy</div>
        <div class="menu-item" id="menu-copy-path">Copy Path</div>
        <div class="menu-item" id="menu-copy-rel-path">Copy Relative Path</div>
        <div class="menu-separator"></div>
        <div class="menu-item" id="menu-rename">Rename...</div>
        <div class="menu-item danger" id="menu-delete">Delete</div>
        <div class="menu-separator"></div>
        <div class="menu-item" id="menu-ignore">Ignore in Thumbview</div>
    `;

    document.getElementById("menu-open").onclick = () => {
        hideContextMenu();
        vscode.postMessage({ command: "jump", uri: targetFile.uri, line: 0 });
    };

    document.getElementById("menu-open-side").onclick = () => {
        hideContextMenu();
        vscode.postMessage({ command: "openToSide", uri: targetFile.uri });
    };

    document.getElementById("menu-open-preview").onclick = () => {
        hideContextMenu();
        vscode.postMessage({ command: "openPreview", uri: targetFile.uri });
    };

    document.getElementById("menu-select-compare").onclick = () => {
        hideContextMenu();
        vscode.postMessage({ command: "selectForCompare", uri: targetFile.uri });
    };

    document.getElementById("menu-compare-selected").onclick = () => {
        hideContextMenu();
        vscode.postMessage({ command: "compareWithSelected", uri: targetFile.uri });
    };

    document.getElementById("menu-reveal").onclick = () => {
        hideContextMenu();
        vscode.postMessage({ command: "revealInFiles", uri: targetFile.uri });
    };

    document.getElementById("menu-open-containing-folder").onclick = () => {
        hideContextMenu();
        vscode.postMessage({ command: "openContainingFolder", uri: targetFile.uri });
    };

    document.getElementById("menu-cut").onclick = () => {
        hideContextMenu();
        vscode.postMessage({ command: "cutFile", uri: targetFile.uri });
    };

    document.getElementById("menu-copy").onclick = () => {
        hideContextMenu();
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
        vscode.postMessage({ command: "ignoreFile", uri: targetFile.uri, path: targetFile.path });
    };

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
    render();
});
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });

// Functions for Settings Modal, Folder Navigation, and Ignored Items Popovers
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

function updateIgnoresPopover() {
    const badge = document.getElementById("ignores-badge");
    if (badge) {
        badge.textContent = currentIgnorePatterns.length;
    }

    const list = document.getElementById("ignores-list");
    if (!list) return;
    list.innerHTML = "";

    if (currentIgnorePatterns.length === 0) {
        const empty = document.createElement("div");
        empty.style.padding = "16px";
        empty.style.textAlign = "center";
        empty.style.color = "#707075";
        empty.style.fontSize = "12px";
        empty.textContent = "No active ignore patterns";
        list.appendChild(empty);
        return;
    }

    for (const pat of currentIgnorePatterns) {
        const item = document.createElement("div");
        item.className = "popover-item";
        
        const label = document.createElement("span");
        label.textContent = pat;
        item.appendChild(label);

        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-pattern-btn";
        removeBtn.title = "Unignore";
        removeBtn.innerHTML = "&times;";
        removeBtn.onclick = (e) => {
            e.stopPropagation();
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
    allItem.innerHTML = `<span>🌐 All Workspace Files (Root)</span><span class="popover-item-count">${data.files.length} files</span>`;
    allItem.onclick = () => {
        focusedFolder = "";
        updateBreadcrumbs();
        render();
        closeAllPopovers();
    };
    list.appendChild(allItem);

    // 2. Root Directory Files Only
    const rootOnlyFiles = data.files.filter(f => f.path && !f.path.includes("/"));
    if (rootOnlyFiles.length > 0) {
        const rootOnlyItem = document.createElement("div");
        rootOnlyItem.className = "popover-item" + (focusedFolder === "(root files)/" ? " active" : "");
        rootOnlyItem.innerHTML = `<span>📄 Root Directory Files Only</span><span class="popover-item-count">${rootOnlyFiles.length} file${rootOnlyFiles.length === 1 ? "" : "s"}</span>`;
        rootOnlyItem.onclick = () => {
            focusedFolder = "(root files)/";
            updateBreadcrumbs();
            render();
            closeAllPopovers();
        };
        list.appendChild(rootOnlyItem);
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

    const sortedFolders = Array.from(folderCounts.keys()).sort();
    for (const folderPath of sortedFolders) {
        const count = folderCounts.get(folderPath);
        const item = document.createElement("div");
        item.className = "popover-item" + (focusedFolder === folderPath ? " active" : "");
        
        const indent = Math.max(0, (folderPath.split("/").length - 2) * 12);
        item.style.paddingLeft = `${10 + indent}px`;
        
        const titleDiv = document.createElement("div");
        titleDiv.style.display = "flex";
        titleDiv.style.alignItems = "center";
        titleDiv.style.gap = "6px";
        titleDiv.style.flex = "1";
        titleDiv.style.minWidth = "0";
        titleDiv.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📁 ${folderPath}</span><span class="popover-item-count">${count} file${count === 1 ? "" : "s"}</span>`;
        item.appendChild(titleDiv);

        const ignoreBtn = document.createElement("button");
        ignoreBtn.className = "popover-action-btn";
        ignoreBtn.title = `Ignore folder '${folderPath}' in Thumbview`;
        ignoreBtn.textContent = "Ignore";
        ignoreBtn.onclick = (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: "addIgnorePattern", pattern: folderPath });
        };
        item.appendChild(ignoreBtn);

        item.onclick = () => {
            focusedFolder = folderPath;
            updateBreadcrumbs();
            render();
            closeAllPopovers();
        };
        list.appendChild(item);
    }
}

// Popover and Modal Elements & Handlers
const foldersBtn = document.getElementById("folders-btn");
const foldersPopover = document.getElementById("folders-popover");
const closeFoldersPopover = document.getElementById("close-folders-popover");

const ignoresBtn = document.getElementById("ignores-btn");
const ignoresPopover = document.getElementById("ignores-popover");
const closeIgnoresPopover = document.getElementById("close-ignores-popover");
const addIgnoreInput = document.getElementById("add-ignore-input");
const addIgnoreBtn = document.getElementById("add-ignore-btn");

const actionsBtn = document.getElementById("actions-btn");
const actionsModal = document.getElementById("actions-modal");
const closeModal = document.getElementById("close-modal");

function closeAllPopovers() {
    if (foldersPopover) foldersPopover.style.display = "none";
    if (ignoresPopover) ignoresPopover.style.display = "none";
    if (actionsModal) actionsModal.style.display = "none";
    if (foldersBtn) foldersBtn.classList.remove("active");
    if (ignoresBtn) ignoresBtn.classList.remove("active");
    if (actionsBtn) actionsBtn.classList.remove("active");
}

if (foldersBtn && foldersPopover) {
    foldersBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = foldersPopover.style.display === "flex";
        closeAllPopovers();
        if (!isOpen) {
            updateFoldersPopover();
            foldersPopover.style.display = "flex";
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

if (ignoresBtn && ignoresPopover) {
    ignoresBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = ignoresPopover.style.display === "flex";
        closeAllPopovers();
        if (!isOpen) {
            updateIgnoresPopover();
            ignoresPopover.style.display = "flex";
            ignoresBtn.classList.add("active");
        }
    };
}
if (closeIgnoresPopover && ignoresPopover) {
    closeIgnoresPopover.onclick = () => {
        ignoresPopover.style.display = "none";
        if (ignoresBtn) ignoresBtn.classList.remove("active");
    };
}

function handleAddIgnore() {
    if (!addIgnoreInput) return;
    const val = addIgnoreInput.value.trim();
    if (val) {
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
        (ignoresPopover && ignoresPopover.contains(event.target)) ||
        event.target === actionsBtn ||
        event.target === foldersBtn ||
        event.target === ignoresBtn;

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