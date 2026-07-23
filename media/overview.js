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

let data = null;
let statusText = "Loading Repository Map...";
let activeFileUri = null;
let searchQuery = "";
let focusedFolder = ""; // empty means root

let openFiles = []; // Array of open file URIs (orange borders)
let openFilesSet = new Set();
let cursorLocations = {}; // Map of file URIs to current cursor line numbers

let searchDebounceTimer = null;
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

// Setup search inputs
const searchInput = document.getElementById("search-input");
const clearSearch = document.getElementById("clear-search");

searchInput.addEventListener("input", e => {
    searchQuery = e.target.value.toLowerCase().trim();
    clearSearch.style.display = searchQuery ? "block" : "none";
    triggerSearchRender(false);
});

clearSearch.addEventListener("click", () => {
    searchInput.value = "";
    searchQuery = "";
    clearSearch.style.display = "none";
    triggerSearchRender(true);
});

// Capture global keystrokes and type directly into search box
window.addEventListener("keydown", event => {
    if (document.activeElement === searchInput) {
        return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
    }

    if (event.key.length === 1) {
        event.preventDefault();
        searchInput.focus();
        searchInput.value += event.key;
        searchQuery = searchInput.value.toLowerCase().trim();
        clearSearch.style.display = searchQuery ? "block" : "none";
        triggerSearchRender(false);
    } else if (event.key === "Backspace") {
        event.preventDefault();
        searchInput.focus();
        searchInput.value = searchInput.value.slice(0, -1);
        searchQuery = searchInput.value.toLowerCase().trim();
        clearSearch.style.display = searchQuery ? "block" : "none";
        triggerSearchRender(false);
    }
});

let resizeRafId = null;

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
        if (!data) {
            drawStatus();
        }
    }

    if (msg.command === "data") {
        data = msg;
        statusText = "";
        hoverLineCache = {};
        if (data && data.files) {
            for (let fIdx = 0; fIdx < data.files.length; fIdx++) {
                const f = data.files[fIdx];
                f._lowerPath = f.path ? f.path.toLowerCase() : "";
                const lang = detectLang(f.path);
                const textArr = [];
                if (f.path) textArr.push(f.path.toLowerCase());
                if (f.lines) {
                    for (let lIdx = 0; lIdx < f.lines.length; lIdx++) {
                        const l = f.lines[lIdx];
                        const lower = l.text ? l.text.toLowerCase() : "";
                        l._lowerText = lower;
                        l._tokens = tokenizeLine(l.text ? l.text.trimStart() : "", lang);
                        textArr.push(lower);
                    }
                }
                if (f.fullLines) {
                    f._lowerFullLines = f.fullLines.map(str => {
                        const lower = str.toLowerCase();
                        textArr.push(lower);
                        return lower;
                    });
                }
                f._combinedText = textArr.join("\n");
            }
        }
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
        }
        // Force hover re-evaluation to update tooltip with newly fetched lines
        if (lastMousePos) {
            updateHoverTooltip(lastMousePos.x, lastMousePos.y);
        }
    }
});

// Duplicate of layout.ts's buildStableGrid (uniform_grid mode only) — used here only
// to lay out a focused folder's subset of files (see render() below), since the host
// never computes a layout for that subset. Keep in sync with layout.ts by hand.
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

function getFilteredFiles() {
    if (!data) return [];
    if (!focusedFolder) return data.files;
    return data.files.filter(f => f.path.startsWith(focusedFolder));
}

function drawStatus() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = "#18181c";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    ctx.fillStyle = "#e1e1e6";
    ctx.font = "16px system-ui";
    ctx.fillText(statusText, 24, 74);

    ctx.fillStyle = "#707075";
    ctx.font = "12px system-ui";
    ctx.fillText("Waiting for repository data...", 24, 100);
}

function detectLang(path) {
    if (!path) return 'plaintext';
    const filename = path.split('/').pop().toLowerCase();
    if (filename === '.gitignore' || filename === 'license' || filename.startsWith('license.')) {
        return 'plaintext';
    }
    const ext = filename.includes('.') ? filename.split('.').pop() : '';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (!ext || ext === 'txt' || ext === 'log' || ext === 'conf' || ext === 'ini' || ext === 'env') {
        return 'plaintext';
    }
    if (ext === 'css' || ext === 'scss' || ext === 'less') return 'css';
    if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg' || ext === 'vue') return 'html';
    if (ext === 'json') return 'json';
    if (ext === 'py') return 'python';
    return 'js';
}

// Dispatches to one of three small regex-based tokenizers by detected language.
// This is a real (if approximate) syntax highlighter, independent of scanner.ts's
// coarse per-line categorizer — see this file's header comment.
function tokenizeLine(text, lang) {
    if (!text) return [];
    if (lang === 'plaintext') return [{ text, category: 'normal', isKey: false }];
    if (lang === 'markdown') return tokenizeMarkdown(text);
    if (lang === 'css') return tokenizeCSS(text);
    if (lang === 'html') return tokenizeHTML(text);
    return tokenizeJS(text, lang);
}

function tokenizeMarkdown(text) {
    const tokens = [];
    // Split markdown line into granular syntax elements (headers, hash symbols, code spans, bold, italic, links, lists, blockquotes)
    const regex = /(^#{1,6}\s+.*|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|[*_][^*_]+[*_]|\[[^\]]+\]|\([^)]+\)|^\s*[-*+]\s+|^\s*\d+\.\s+|>.*|\s+|.)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const val = match[0];
        let cat = "normal";
        if (val.startsWith('#')) {
            cat = "tag"; // In VS Code, Markdown headers (e.g. # Title) use dark blue markup.heading (#569cd6)
        } else if (val.startsWith('`') && val.endsWith('`') && val.length > 1) {
            cat = "string"; // Inline code (`code`) uses string orange (#ce9178)
        } else if (val.startsWith('**') || val.startsWith('__')) {
            cat = "keyword"; // Bold text uses markup.bold keyword purple/blue (#569cd6 / #c586c0)
        } else if ((val.startsWith('*') || val.startsWith('_')) && val.length > 1) {
            cat = "variable"; // Italic text uses cyan/variable (#9cdcfe)
        } else if (val.startsWith('[')) {
            cat = "type"; // Link text [text] uses teal/class (#4ec9b0)
        } else if (val.startsWith('(') && val.endsWith(')')) {
            cat = "string"; // Link URL (url) uses string orange (#ce9178)
        } else if (/^\s*[-*+]\s+/.test(val) || /^\s*\d+\.\s+/.test(val)) {
            cat = "keyword"; // List markers (-, *, 1.) use keyword blue (#569cd6)
        } else if (val.startsWith('>')) {
            cat = "comment"; // Blockquotes (> quote) use comment green (#6a9955)
        }

        tokens.push({ text: val, category: cat, isKey: false });
    }
    return tokens;
}

// Single regex splits the line into candidate tokens (comments/strings/@rules/colors/
// units/identifiers/punctuation), then each token is classified by shape. A trailing
// pass re-labels a value/selector token as "function" if it's immediately followed by
// "(" (e.g. `rgba(`, `calc(`).
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

// Same single-regex-then-classify approach as tokenizeCSS, tracking a small bit of
// state (inTag/seenTagName) across matches to tell a tag name from an attribute name.
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

// Covers JS/TS/most C-like languages plus a separate Python keyword list, picked by a
// single shared regex per lang (JSON reuses the JS path). After the initial token pass,
// a second loop re-labels tokens using their neighbors: identifier-after-"." becomes
// "property", identifier-before-"(" becomes "function", and (JSON only) a string
// immediately before ":" becomes a highlighted key.
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

function getThemeColor(varName, fallbackHex) {
    const val = getComputedStyle(document.body).getPropertyValue(varName).trim();
    return val || fallbackHex;
}

function colorForCategory(category, isKey) {
    if (isKey) return getThemeColor("--vscode-symbolIcon-propertyForeground", getThemeColor("--vscode-editorLineNumber-activeForeground", "#9cdcfe"));

    switch (category) {
        case "comment":
            return getThemeColor("--vscode-editorComment-foreground", "#6a9955");
        case "string":
            return getThemeColor("--vscode-symbolIcon-stringForeground", getThemeColor("--vscode-charts-orange", "#ce9178"));
        case "number":
            return getThemeColor("--vscode-symbolIcon-numberForeground", getThemeColor("--vscode-charts-green", "#b5cea8"));
        case "control-flow":
            return getThemeColor("--vscode-symbolIcon-keywordForeground", getThemeColor("--vscode-charts-purple", "#c586c0"));
        case "keyword":
            return getThemeColor("--vscode-symbolIcon-keywordForeground", getThemeColor("--vscode-charts-blue", "#569cd6"));
        case "operator":
        case "normal":
            return getThemeColor("--vscode-editor-foreground", "#cccccc");
        case "function":
            return getThemeColor("--vscode-symbolIcon-functionForeground", getThemeColor("--vscode-charts-yellow", "#dcdcaa"));
        case "type":
            return getThemeColor("--vscode-symbolIcon-classForeground", getThemeColor("--vscode-charts-teal", "#4ec9b0"));
        case "variable":
        case "property":
        case "css-property":
        case "attribute":
            return getThemeColor("--vscode-symbolIcon-variableForeground", getThemeColor("--vscode-symbolIcon-propertyForeground", "#9cdcfe"));
        case "selector":
        case "css-value":
            return getThemeColor("--vscode-symbolIcon-stringForeground", "#ce9178");
        case "tag":
            return getThemeColor("--vscode-symbolIcon-elementForeground", getThemeColor("--vscode-symbolIcon-keywordForeground", "#569cd6"));
        case "tag-bracket":
            return getThemeColor("--vscode-editor-foreground", "#808080");
        default:
            return getThemeColor("--vscode-editor-foreground", "#d4d4d4");
    }
}

// Draws one file's minimap into the given cell rect, one row per source line scaled to
// fit the cell height (stepY). Below a ~2.5px-per-line threshold there isn't room to
// render real glyphs, so each token is drawn as a flat colored rect proportional to its
let imageCache = {};

// character length instead ("useText" branch below) — this is what makes small tiles
// still readable as a rough shape/density map rather than unreadable tiny text.
function drawMinimap(file, x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    if (file.isImage) {
        const shouldRenderMedia = data && data.renderMediaThumbnails !== false;
        if (shouldRenderMedia && file.mediaUri) {
            if (!imageCache[file.mediaUri]) {
                const img = new Image();
                img.src = file.mediaUri;
                img.onload = () => render();
                imageCache[file.mediaUri] = img;
            }
            const img = imageCache[file.mediaUri];
            if (img.complete && img.naturalWidth > 0) {
                // Compressed/scaled image thumbnail tile
                ctx.drawImage(img, x, y, w, h);
                ctx.restore();
                return;
            }
        }
        ctx.fillStyle = "#252526";
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = "#858585";
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
                // Draw actual visual PDF Page 1 snapshot image
                ctx.drawImage(cachedPdfImg, x, y, w, h);
                ctx.restore();
                return;
            }
        }

        ctx.fillStyle = "#1e1e24";
        ctx.fillRect(x, y, w, h);

        ctx.fillStyle = "#e11d48"; // Crimson PDF header bar
        ctx.fillRect(x, y, w, 14);
        ctx.fillStyle = "#ffffff";
        ctx.font = "9px system-ui, sans-serif";
        ctx.fillText("PDF - Page 1", x + 6, y + 10);

        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        for (let pLine = 0; pLine < Math.min(12, Math.floor((h - 20) / 4)); pLine++) {
            const lineW = ((pLine * 37) % 60 + 35) / 100 * (w - 12);
            ctx.fillRect(x + 6, y + 18 + pLine * 4, lineW, 2);
        }

        ctx.restore();
        return;
    }

    const lines = file.lines || [];
    const lineCount = Math.max(lines.length, 1);
    const stepY = h / lineCount;
    const maxLineChars = 120;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.text) {
            continue;
        }

        const indent = line.indent;
        const startX = x + Math.min(indent / maxLineChars, 0.4) * w;

        const trimmedText = line.text.trimStart();
        const lineTextLength = trimmedText.length;
        if (lineTextLength === 0) {
            continue;
        }

        const lineW = Math.min(lineTextLength / maxLineChars, 1.0) * w * 0.7;

        let isMatchedLine = false;
        if (searchQuery) {
            const checkFull = file._lowerFullLines || file.fullLines;
            if (checkFull && file.lineCount > lines.length) {
                const step = file.lineCount / lines.length;
                const startLineIdx = Math.floor(i * step);
                const endLineIdx = Math.min(Math.floor((i + 1) * step), checkFull.length);
                for (let fullI = startLineIdx; fullI < endLineIdx; fullI++) {
                    const str = file._lowerFullLines ? checkFull[fullI] : checkFull[fullI].toLowerCase();
                    if (str.includes(searchQuery)) {
                        isMatchedLine = true;
                        break;
                    }
                }
            } else {
                const lText = line._lowerText !== undefined ? line._lowerText : line.text.toLowerCase();
                isMatchedLine = lText.includes(searchQuery);
            }
        }

        if (isMatchedLine) {
            ctx.fillStyle = "#ec4899"; // Highlight pink for search match
            ctx.fillRect(
                x,
                y + i * stepY,
                w,
                Math.max(stepY, 2.0)
            );
        } else {
            const tokens = line._tokens || tokenizeLine(trimmedText, detectLang(file.path));
            const totalTextChars = Math.max(lineTextLength, 1);

            const useText = stepY >= 3;
            if (useText) {
                // For small files (few lines), keep font size small (5px) so much more line width is visible
                const isSmallFile = lines.length <= 50 || stepY > 4;
                const fontSize = isSmallFile ? 5 : Math.min(10, Math.max(4, Math.floor(stepY * 0.85)));
                ctx.font = `${fontSize}px Consolas, monospace`;
            }

            let currentX = startX;
            for (const tok of tokens) {
                if (currentX >= x + w) break;

                ctx.fillStyle = colorForCategory(tok.category, tok.isKey);
                if (useText) {
                    ctx.fillText(tok.text, currentX, y + i * stepY + Math.min(stepY * 0.8, 8));
                    currentX += ctx.measureText(tok.text).width;
                } else {
                    const tokLen = tok.text.length;
                    const tokW = (tokLen / totalTextChars) * lineW;

                    ctx.fillRect(
                        currentX,
                        y + i * stepY,
                        Math.min(tokW, x + w - currentX),
                        Math.max(stepY, 0.7)
                    );
                    currentX += tokW;
                }
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

        const minimapY = y;
        const minimapH = h;

        const bandY = minimapY + startRatio * minimapH;
        const bandH = Math.max((endRatio - startRatio) * minimapH, 4.0);

        // Store bounding rect of view band on cell for click detection
        file._cell._viewBand = {
            y: bandY,
            h: bandH
        };

        ctx.fillStyle = "rgba(255, 255, 255, 0.22)"; // Transparent gray viewport overlay
        ctx.fillRect(
            x,
            bandY,
            w,
            Math.min(bandH, minimapY + minimapH - bandY)
        );
    } else if (file._cell) {
        delete file._cell._viewBand;
    }

    ctx.restore();
}

// Truncates a file path to fit maxWidth, preferring to drop leading directory segments
// ("...dir/file.ts") over the filename itself. Binary-searches the cut point in the
// directory portion rather than trimming a character at a time, since ctx.measureText
// is comparatively expensive and this runs once per visible card per frame.
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
        ctx.fillStyle = "#707075";
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
    const slots = filteredFiles.map(f => f.slot);

    const topMargin = 64;
    const bottomMargin = 40;
    const sideMargin = 16;

    const availableW = rectW - (sideMargin * 2);
    const availableH = rectH - topMargin - bottomMargin;

    const cellW = availableW / gridCols;
    const cellH = availableH / gridRows;

    const queryActive = !!searchQuery;

    // Clear stale cell bounding boxes across all files
    for (const f of data.files) {
        delete f._cell;
    }

    for (let i = 0; i < filteredFiles.length; i++) {
        const file = filteredFiles[i];
        const slot = slots[i];
        if (!slot) continue;

        const col = slot[0];
        const row = slot[1];
        const nCells = file.nCells || 1;

        const x = sideMargin + col * cellW;
        const y = topMargin + row * cellH;
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

        const isSearchMatch = queryActive && (file._combinedText ? file._combinedText.includes(searchQuery) : (file.path.toLowerCase().includes(searchQuery)));

        const isActive = file.uri === activeFileUri;
        const isOpen = openFilesSet.has(file.uri);

        ctx.save();

        if (queryActive && !isSearchMatch) {
            ctx.globalAlpha = 0.15;
        }

        // Draw card background
        ctx.fillStyle = "#1e1e24";
        ctx.fillRect(x + 4, y + 4, cellW - 8, fileH - 8);

        // Border rendering prioritisation
        if (queryActive && isSearchMatch) {
            ctx.strokeStyle = "#ec4899"; // Pink search match border
            ctx.lineWidth = 2.5;
        } else if (isActive) {
            ctx.strokeStyle = "#a855f7"; // Purple active border
            ctx.lineWidth = 2.5;
        } else if (isOpen) {
            ctx.strokeStyle = "#f97316"; // Orange open tab border
            ctx.lineWidth = 1.8;
        } else {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
            ctx.lineWidth = 1;
        }
        ctx.strokeRect(x + 4, y + 4, cellW - 8, fileH - 8);

        ctx.fillStyle = isSearchMatch ? "#ec4899" : (isActive ? "#ffffff" : "#a0a0a5");
        ctx.font = "10px system-ui, sans-serif";

        if (file._lastCellW !== cellW || !file._fittedLabel) {
            file._lastCellW = cellW;
            file._fittedLabel = fitPathText(file.path, cellW - 36);
        }

        ctx.fillText(file._fittedLabel, x + 10, y + 18);

        // Draw close '×' button if tab is open
        if (isOpen) {
            const closeBtnX = x + cellW - 20;
            const closeBtnY = y + 10;
            file._closeBtn = {
                x: closeBtnX,
                y: closeBtnY,
                w: 12,
                h: 12
            };

            ctx.fillStyle = "#707075";
            ctx.font = "12px system-ui, sans-serif";
            ctx.fillText("×", closeBtnX, closeBtnY + 8);
        } else {
            delete file._closeBtn;
        }

        drawMinimap(
            file,
            x + 10,
            y + 24,
            Math.max(1, cellW - 20),
            Math.max(1, fileH - 34)
        );

        ctx.restore();
    }
}

// Three click targets within a card, checked most-specific first: the '×' close
// button (only present when the tab is open), the header/path-label strip (isolates
// that file's parent folder), then the minimap body (jumps the real editor to the
// clicked line — see extension.ts's "jump" handler).
canvas.addEventListener("click", event => {
    if (!data) {
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

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
            // Check if click was on close '×' button
            const cb = file._closeBtn;
            if (cb && px >= cb.x - 4 && px <= cb.x + cb.w + 4 && py >= cb.y - 4 && py <= cb.y + cb.h + 4) {
                openFiles = openFiles.filter(u => u !== file.uri);
                render();
                vscode.postMessage({
                    command: "close",
                    uri: file.uri
                });
                return;
            }

            const headerHeight = 24;
            const isHeaderClick = py < c.y + headerHeight;

            if (isHeaderClick) {
                // Clicked the file path/folder header bar -> isolate parent folder
                const lastSlash = file.path.lastIndexOf('/');
                if (lastSlash !== -1) {
                    const folder = file.path.substring(0, lastSlash + 1);
                    focusedFolder = folder;
                    updateBreadcrumbs();
                    render();
                }
                return;
            }

            // Check if user clicked inside the transparent gray view band -> switch directly to existing tab
            if (c._viewBand && py >= c._viewBand.y && py <= c._viewBand.y + c._viewBand.h) {
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

            // Clicked inside the minimap body -> jump to line in document
            const minimapTop = c.y + headerHeight;
            const minimapHeight = Math.max(1, c.h - 34);

            const relativeY = Math.max(
                0,
                Math.min(1, (py - minimapTop) / minimapHeight)
            );

            const line = Math.floor(relativeY * file.lineCount);

            vscode.postMessage({
                command: "jump",
                uri: file.uri,
                line,
                query: searchQuery
            });

            return;
        }
    }
});

// Middle-click (auxclick) to close tab
canvas.addEventListener("auxclick", event => {
    if (!data || event.button !== 1) { // 1 = middle mouse button
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

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

let isCtrlDown = false;
let hoverRafId = null;

window.addEventListener("keydown", event => {
    if (event.key === "Control" || event.ctrlKey) {
        isCtrlDown = true;
        if (lastMousePos) {
            updateHoverTooltip(lastMousePos.x, lastMousePos.y);
        }
    }
});

window.addEventListener("keyup", event => {
    if (event.key === "Control" || !event.ctrlKey) {
        isCtrlDown = false;
        tooltip.style.display = "none";
    }
});

function updateHoverTooltip(clientX, clientY) {
    if (!data) return;

    if (!isCtrlDown) {
        tooltip.style.display = "none";
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    const filteredFiles = getFilteredFiles();
    let hoveredFile = null;
    let hoveredLineIdx = -1;

    for (const file of filteredFiles) {
        const c = file._cell;
        if (!c) continue;

        if (
            px >= c.x &&
            px <= c.x + c.w &&
            py >= c.y &&
            py <= c.y + c.h
        ) {
            hoveredFile = file;
            const minimapTop = c.y + 24;
            const minimapHeight = Math.max(1, c.h - 34);

            const relativeY = Math.max(
                0,
                Math.min(1, (py - minimapTop) / minimapHeight)
            );

            hoveredLineIdx = Math.floor(relativeY * file.lineCount);
            break;
        }
    }

    if (hoveredFile && (hoveredFile.isImage || hoveredFile.isPdf)) {
        tooltip.style.display = "none";
        return;
    }

    if (hoveredFile && hoveredLineIdx >= 0 && hoveredLineIdx < hoveredFile.lineCount) {
        const radius = 12;
        let start = hoveredLineIdx - radius;
        let end = hoveredLineIdx + radius;

        if (start < 0) {
            end = Math.min(hoveredFile.lineCount - 1, end + (-start));
            start = 0;
        }
        if (end >= hoveredFile.lineCount) {
            start = Math.max(0, start - (end - (hoveredFile.lineCount - 1)));
            end = hoveredFile.lineCount - 1;
        }

        // Check if any required lines are missing from scan results and cache
        let missingLines = false;
        const uriCache = hoverLineCache[hoveredFile.uri] || {};

        for (let i = start; i <= end; i++) {
            if (!hoveredFile.lines[i] && !uriCache[i]) {
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
            const line = hoveredFile.lines[i] || uriCache[i];
            const isHoveredLine = i === hoveredLineIdx;
            const lineText = line ? line.text : "Loading line...";
            const lang = detectLang(hoveredFile.path);

            if (line && !line._htmlCache) {
                const tokens = line._tokens || tokenizeLine(lineText.trimStart(), lang);
                let lineHtml = "";
                for (const tok of tokens) {
                    let escapedText = tok.text
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;");

                    if (searchQuery && tok.text.toLowerCase().includes(searchQuery)) {
                        const escapedQuery = searchQuery.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                        const regex = new RegExp(`(${escapedQuery})`, 'gi');
                        escapedText = escapedText.replace(regex, `<span style="background: rgba(236, 72, 153, 0.35); color: #f472b6; font-weight: 600; border-radius: 2px; padding: 0 2px;">$1</span>`);
                    }

                    const color = colorForCategory(tok.category, tok.isKey);
                    lineHtml += `<span style="color: ${color}">${escapedText}</span>`;
                }
                line._htmlCache = lineHtml || " ";
            }

            const lineHtml = (line && line._htmlCache) ? line._htmlCache : lineText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const isMatchLine = searchQuery && lineText.toLowerCase().includes(searchQuery);
            let bgStyle = "";
            let prefix = "  ";

            if (isHoveredLine) {
                prefix = `<span style="color: #a855f7; font-weight: bold;">&gt; </span>`;
                if (isMatchLine) {
                    bgStyle = "background: rgba(236, 72, 153, 0.28); display: inline-block; width: 100%; border-left: 3px solid #ec4899; padding-left: 2px;";
                } else {
                    bgStyle = "background: rgba(168, 85, 247, 0.18); display: inline-block; width: 100%; border-left: 3px solid #a855f7; padding-left: 2px;";
                }
            } else if (isMatchLine) {
                bgStyle = "background: rgba(236, 72, 153, 0.2); display: inline-block; width: 100%; border-left: 3px solid #ec4899; padding-left: 2px;";
            }

            tooltipHtml += `<div style="${bgStyle}">${prefix}${lineHtml}</div>`;
        }

        tooltip.innerHTML = tooltipHtml;
        tooltip.style.display = "block";

        const c = hoveredFile._cell;
        const gap = 12;
        const cellCenterX = c.x + c.w / 2;
        let tx;

        if (cellCenterX > window.innerWidth / 2) {
            // Right half of screen -> place to the left of the tile
            tx = c.x - gap - tooltip.offsetWidth;
            if (tx < 16) {
                // If overflowing left edge, clamp to viewport margin
                tx = 16;
            }
        } else {
            // Left half of screen -> place to the right of the tile
            tx = c.x + c.w + gap;
            if (tx + tooltip.offsetWidth > window.innerWidth - 16) {
                // If overflowing right edge, clamp to viewport margin
                tx = window.innerWidth - tooltip.offsetWidth - 16;
            }
        }

        let ty = clientY + 16;
        if (ty + tooltip.offsetHeight > window.innerHeight - 16) {
            ty = window.innerHeight - tooltip.offsetHeight - 16;
        }
        ty = Math.max(16, ty);

        tooltip.style.left = `${tx}px`;
        tooltip.style.top = `${ty}px`;
    } else {
        tooltip.style.display = "none";
    }
}

let lastFocusRequestTime = 0;
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
canvas.addEventListener("mousemove", event => {
    checkWindowFocus();
    lastMousePos = { x: event.clientX, y: event.clientY };
    if (!hoverRafId) {
        hoverRafId = requestAnimationFrame(() => {
            hoverRafId = null;
            updateHoverTooltip(event.clientX, event.clientY);
        });
    }
});

canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
});

const contextMenu = document.getElementById("context-menu");

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
    if (!data) return;

    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    const filteredFiles = getFilteredFiles();
    let targetFile = null;

    for (const file of filteredFiles) {
        const c = file._cell;
        if (!c) continue;

        if (
            px >= c.x &&
            px <= c.x + c.w &&
            py >= c.y &&
            py <= c.y + c.h
        ) {
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

// Actions & Shortcuts Modal Toggle
const actionsBtn = document.getElementById("actions-btn");
const actionsModal = document.getElementById("actions-modal");
const closeModal = document.getElementById("close-modal");

if (actionsBtn && actionsModal) {
    actionsBtn.onclick = (e) => {
        e.stopPropagation();
        actionsModal.style.display = actionsModal.style.display === "block" ? "none" : "block";
    };
}
if (closeModal && actionsModal) {
    closeModal.onclick = () => {
        actionsModal.style.display = "none";
    };
}
document.addEventListener("click", event => {
    if (actionsModal && actionsModal.style.display === "block" && !actionsModal.contains(event.target) && event.target !== actionsBtn) {
        actionsModal.style.display = "none";
    }
});

resize();

vscode.postMessage({
    command: "ready"
});