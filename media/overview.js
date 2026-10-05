// Webview/browser-side counterpart to extension.ts (the "host"). Receives postMessage
// data from the host and re-tokenizes/redraws everything to a single <canvas> on
// every render() call — there is no virtual DOM or per-tile element, for performance
// with large workspaces. Not compiled/bundled: loaded as-is via a nonce'd <script> tag
// (see extension.ts's getHtml), so it can't `import` the extension-host TypeScript in
// src/. The pure layout functions it shares with the host (buildStableGrid, cellsNeeded,
// fillLayoutHoles, the spanning reorders) are generated into the block below from
// src/layout_core.ts; tokenizeJS/tokenizeCSS/tokenizeHTML are webview-only.

// ---- BEGIN GENERATED from src/layout_core.ts by `npm run sync-core`. Do not edit here. ----
// Single source of the pure functions shared by the extension host and the webview: grid slot
// packing, spanning cell counts, hole filling, spanning drag reorders, and line classification.
// The host imports this module; `npm run sync-core` transpiles it into the generated block of
// media/overview.js (the webview is unbundled), and `npm run check-core` fails if that block is
// stale. Keep it dependency-free: no imports, no vscode, no DOM.
const DEFAULT_TARGET_ASPECT = 16 / 9;
const MIN_GRID_ROWS = 1;
const MIN_GRID_COLS = 2;
const DEFAULT_BASE_LINES_PER_CELL = 60;
const DEFAULT_COMPRESSION_PCT = 0.05;
const MAX_COMPRESSION_PCT = 0.25;
/** Packs nCells items into a near-targetAspect grid, returning {rows, cols, slots} in fill order. */
function buildStableGrid(nCells, targetAspect = DEFAULT_TARGET_ASPECT) {
    let rows = MIN_GRID_ROWS;
    let cols = Math.max(MIN_GRID_COLS, Math.ceil(rows * targetAspect));
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
        }
        else {
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
/** Vertical cells a file of lineCount lines spans in spanning mode. */
function cellsNeeded(lineCount, baseLinesPerCell = DEFAULT_BASE_LINES_PER_CELL, compressionPct = DEFAULT_COMPRESSION_PCT) {
    if (lineCount <= baseLinesPerCell || compressionPct <= 0) {
        return 1;
    }
    const clampedPct = Math.min(compressionPct, MAX_COMPRESSION_PCT);
    const repLines = Math.max(lineCount * clampedPct, baseLinesPerCell);
    return Math.ceil(repLines / baseLinesPerCell);
}
/**
 * Returns `order` with each id in `liveIds` that it lacks placed into the earliest hole it fits
 * in, or appended when none fits. A hole is an id no longer in `liveIds` (ignored or deleted);
 * `""` entries are deliberate user gaps and are never filled. A new file of n cells may take a
 * hole of H >= n cells; when H > n it is recorded in `footprints` with H, and spanning layouts
 * give it max(n, footprint) cells, so it occupies exactly the hole's cells (content at the top,
 * empty space below) and the column-major flow, including column breaks, is unchanged: nothing
 * else moves. Unfilled holes keep their stale id, so an unignored file whose hole is still free
 * returns to its exact slot. Never trims or compacts.
 */
function fillLayoutHoles(order, liveIds, cellsOf = () => 1, holeCellsOf = () => 1) {
    const live = new Set(liveIds);
    const present = new Set(order.filter(Boolean));
    const result = [...order];
    const footprints = {};
    let searchFrom = 0;
    for (const id of liveIds) {
        if (present.has(id)) {
            continue;
        }
        const need = Math.max(1, cellsOf(id));
        let placed = false;
        for (let i = searchFrom; i < result.length; i++) {
            const entry = result[i];
            if (!entry || live.has(entry)) {
                continue;
            }
            const holeCells = Math.max(1, holeCellsOf(entry));
            if (holeCells >= need) {
                result[i] = id;
                if (holeCells > need) {
                    footprints[id] = holeCells;
                }
                placed = true;
                if (need === 1) {
                    // Every earlier hole would have fit a one-cell item, so none remain before i.
                    searchFrom = i + 1;
                }
                break;
            }
        }
        if (!placed) {
            result.push(id);
        }
        present.add(id);
    }
    return { order: result, footprints };
}
/**
 * Clamps target column and row to the existing grid capacity.
 * Ensures dragging tiles cannot exceed the grid bounds and cannot expand the grid space.
 */
function clampTargetToGridCapacity(targetCol, targetRow, spanCells, maxCols, maxRows) {
    const safeMaxCols = Math.max(1, maxCols);
    const safeMaxRows = Math.max(1, maxRows);
    const clampedCol = Math.max(0, Math.min(targetCol, safeMaxCols - 1));
    const maxAllowedRow = Math.max(0, safeMaxRows - spanCells);
    const clampedRow = Math.max(0, Math.min(targetRow, maxAllowedRow));
    return { col: clampedCol, row: clampedRow };
}
/**
 * Expands a 2D spanning order array by adding 1 empty slot at the bottom of each column,
 * and 1 empty column on the right.
 * Guarantees that all existing items maintain their exact (col, row) placements with zero reflow.
 */
function expandSpanningGridOrder(currentOrder, allocations, oldCols, oldRows) {
    const newCols = oldCols + 1;
    const newRows = oldRows + 1;
    const grid = [];
    for (let c = 0; c < oldCols; c++) {
        grid.push(new Array(oldRows).fill(""));
    }
    let currCol = 0;
    let currRow = 0;
    for (const id of currentOrder) {
        const nCells = id ? (allocations[id] || 1) : 1;
        if (currRow > 0 && currRow + nCells > oldRows) {
            currCol++;
            currRow = 0;
        }
        if (currCol >= oldCols)
            break;
        if (!id) {
            currRow += 1;
            continue;
        }
        for (let i = 0; i < nCells; i++) {
            if (currRow + i < oldRows) {
                grid[currCol][currRow + i] = id;
            }
        }
        currRow += nCells;
    }
    const newOrder = [];
    for (let c = 0; c < newCols; c++) {
        let r = 0;
        while (r < newRows) {
            if (c < oldCols && r < oldRows) {
                const cell = grid[c][r];
                if (cell) {
                    newOrder.push(cell);
                    const n = allocations[cell] || 1;
                    r += n;
                }
                else {
                    newOrder.push("");
                    r += 1;
                }
            }
            else {
                newOrder.push("");
                r += 1;
            }
        }
    }
    while (newOrder.length > 0 && !newOrder[newOrder.length - 1]) {
        newOrder.pop();
    }
    return {
        newOrder,
        cols: newCols,
        rows: newRows
    };
}
/**
 * Reduces a 2D spanning order array by removing 1 row from the bottom of each column,
 * and 1 column from the right, if extra space allows.
 */
function reduceSpanningGridOrder(currentOrder, allocations, oldCols, oldRows, minCols, minRows) {
    const newCols = Math.max(minCols, oldCols - 1);
    const newRows = Math.max(minRows, oldRows - 1);
    if (newCols === oldCols && newRows === oldRows) {
        return { newOrder: [...currentOrder], cols: oldCols, rows: oldRows };
    }
    const grid = [];
    for (let c = 0; c < oldCols; c++) {
        grid.push(new Array(oldRows).fill(""));
    }
    let currCol = 0;
    let currRow = 0;
    for (const id of currentOrder) {
        const nCells = id ? (allocations[id] || 1) : 1;
        if (currRow > 0 && currRow + nCells > oldRows) {
            currCol++;
            currRow = 0;
        }
        if (currCol >= oldCols)
            break;
        if (!id) {
            currRow += 1;
            continue;
        }
        for (let i = 0; i < nCells; i++) {
            if (currRow + i < oldRows) {
                grid[currCol][currRow + i] = id;
            }
        }
        currRow += nCells;
    }
    const newOrder = [];
    for (let c = 0; c < newCols; c++) {
        let r = 0;
        while (r < newRows) {
            const cell = grid[c][r];
            if (cell) {
                newOrder.push(cell);
                const n = allocations[cell] || 1;
                r += n;
            }
            else {
                newOrder.push("");
                r += 1;
            }
        }
    }
    while (newOrder.length > 0 && !newOrder[newOrder.length - 1]) {
        newOrder.pop();
    }
    return {
        newOrder,
        cols: newCols,
        rows: newRows
    };
}
/**
 * Moves `sourceId` in a spanning (column-major) order so its top lands at (targetCol, targetRow),
 * both in flow cells. The source's cells and an equal-height block of cells at the target trade
 * places, empty cells included: [1;1;0] onto [2;0;0] gives [2;0;0] and [1;1;0]; onto [2;3;0] gives
 * [2;3;0] and [1;1;0]; dropped on the 3 of [2;3;0] gives [2;1;1] and [3;0;0]. A block never splits
 * a tile: both blocks grow to whole tiles (so dragging either of two tiles onto the other swaps the
 * same blocks). A move within one column shifts the tiles in between around it, in order. Nothing
 * outside the two blocks moves. `rejected` is true when no such move exists (a tile would be split,
 * or a block leaves the grid); the order is then returned unchanged.
 */
function reorderSpanningItems(activeIds, currentOrder, allocations, sourceId, targetCol, targetRow, maxAllowedCols, maxAllowedRows, wrapRows) {
    const placements = [];
    const placementById = new Map();
    let col = 0;
    let row = 0;
    let maxColUsed = 0;
    for (const id of currentOrder) {
        const nCells = id ? (allocations[id] || 1) : 1;
        if (row > 0 && row + nCells > wrapRows) {
            col++;
            row = 0;
        }
        if (id) {
            const p = { id, col, row, nCells };
            placements.push(p);
            placementById.set(id, p);
            maxColUsed = Math.max(maxColUsed, col);
        }
        row += nCells;
    }
    const maxCol = Math.max(maxAllowedCols - 1, maxColUsed);
    const gridRows = Math.max(maxAllowedRows, wrapRows);
    const unchanged = (rejected) => ({
        newOrder: [...currentOrder],
        rows: wrapRows,
        cols: Math.max(maxAllowedCols, maxCol + 1),
        finalTargetCol: source ? source.col : 0,
        finalTargetRow: source ? source.row : 0,
        sourceCol: source ? source.col : 0,
        sourceRow: source ? source.row : 0,
        targetPlacement: undefined,
        safeSourceRow: source ? source.row : 0,
        rejected
    });
    const source = placementById.get(sourceId);
    if (!source) {
        return unchanged(true);
    }
    const h = source.nCells;
    const tc = Math.max(0, Math.min(maxCol, targetCol));
    const tr = Math.max(0, Math.min(gridRows - h, targetRow));
    if (tc === source.col && tr === source.row) {
        return unchanged(false);
    }
    // occupant[c][r]: the placement covering that cell, if any.
    const occupant = [];
    for (let c = 0; c <= maxCol; c++) {
        occupant.push(new Array(gridRows).fill(undefined));
    }
    for (const p of placements) {
        for (let i = 0; i < p.nCells && p.row + i < gridRows; i++) {
            occupant[p.col][p.row + i] = p;
        }
    }
    const targetPlacement = occupant[tc][tr] && occupant[tc][tr] !== source ? occupant[tc][tr] : undefined;
    // Grows [start, end) in column c until no tile crosses either edge.
    const wholeSpan = (c, start, end) => {
        for (;;) {
            const top = start < gridRows ? occupant[c][start] : undefined;
            const bottom = end - 1 >= 0 && end - 1 < gridRows ? occupant[c][end - 1] : undefined;
            const newStart = top && top.row < start ? top.row : start;
            const newEnd = bottom && bottom.row + bottom.nCells > end ? bottom.row + bottom.nCells : end;
            if (newStart === start && newEnd === end) {
                return { start, end };
            }
            start = newStart;
            end = newEnd;
        }
    };
    const tilesIn = (c, start, end) => {
        const out = [];
        for (let r = start; r < end && r < gridRows; r++) {
            const p = occupant[c][r];
            if (p && !out.includes(p))
                out.push(p);
        }
        return out;
    };
    const moves = new Map();
    const sameColumnOverlap = tc === source.col && tr < source.row + h && source.row < tr + h;
    if (!sameColumnOverlap) {
        // Two blocks of equal height, each made of whole tiles and empty cells, trade places.
        let rStart = tr;
        let height = h;
        let target = { start: tr, end: tr + h };
        let src = { start: source.row, end: source.row + h };
        for (let guard = 0;; guard++) {
            target = wholeSpan(tc, rStart, rStart + height);
            src = wholeSpan(source.col, source.row, source.row + Math.max(height, target.end - target.start));
            const next = Math.max(target.end - target.start, src.end - src.start);
            if (target.end > gridRows || src.end > gridRows || guard > gridRows) {
                return unchanged(true);
            }
            if (next === target.end - target.start && next === src.end - src.start) {
                break;
            }
            rStart = target.start;
            height = next;
        }
        // In one column, the blocks must not overlap after growing.
        if (tc === source.col && target.start < src.end && src.start < target.end) {
            return unchanged(true);
        }
        for (const p of tilesIn(tc, target.start, target.end)) {
            moves.set(p, { col: source.col, row: p.row - target.start + src.start });
        }
        for (const p of tilesIn(source.col, src.start, src.end)) {
            moves.set(p, { col: tc, row: p.row - src.start + target.start });
        }
    }
    else {
        // Within one column: the source takes [tr, tr + h); the other tiles of the span keep their
        // order and fill the remaining cells, top to bottom, never split by the source.
        const span = wholeSpan(tc, Math.min(source.row, tr), Math.max(source.row, tr) + h);
        if (span.end > gridRows) {
            return unchanged(true);
        }
        const others = [];
        for (let r = span.start; r < span.end; r++) {
            const p = occupant[tc][r];
            if (p === source)
                continue;
            if (!p)
                others.push(null);
            else if (p.row === r)
                others.push(p);
        }
        let r = span.start;
        moves.set(source, { col: tc, row: tr });
        for (const item of others) {
            const n = item ? item.nCells : 1;
            if (r < tr + h && r + n > tr) {
                r = tr + h;
            }
            if (r + n > span.end) {
                return unchanged(true);
            }
            if (item)
                moves.set(item, { col: tc, row: r });
            r += n;
        }
    }
    const finalPlacements = placements.map(p => ({ ...p, ...(moves.get(p) || {}) }));
    const movedSource = finalPlacements.find(p => p.id === sourceId);
    let effectiveWrapRows = wrapRows;
    for (const p of finalPlacements) {
        effectiveWrapRows = Math.max(effectiveWrapRows, p.row + p.nCells);
    }
    // Serialize column-major, every column effectiveWrapRows tall, so every tile keeps its cell.
    const cell = [];
    for (let c = 0; c <= maxCol; c++) {
        cell.push(new Array(effectiveWrapRows).fill(""));
    }
    const startsAt = new Map();
    for (const p of finalPlacements) {
        startsAt.set(`${p.col},${p.row}`, p);
    }
    const newOrder = [];
    for (let c = 0; c <= maxCol; c++) {
        let r = 0;
        while (r < effectiveWrapRows) {
            const p = startsAt.get(`${c},${r}`);
            if (p) {
                newOrder.push(p.id);
                r += p.nCells;
            }
            else {
                newOrder.push("");
                r += 1;
            }
        }
    }
    // Padding is trimmed, never below the order's original length: a shorter order can shrink
    // the grid and move every tile (spatial stability).
    while (newOrder.length > currentOrder.length && !newOrder[newOrder.length - 1]) {
        newOrder.pop();
    }
    return {
        newOrder,
        rows: effectiveWrapRows,
        cols: Math.max(maxAllowedCols, maxCol + 1),
        finalTargetCol: movedSource.col,
        finalTargetRow: movedSource.row,
        sourceCol: source.col,
        sourceRow: source.row,
        targetPlacement,
        safeSourceRow: source.row,
        rejected: false
    };
}
/**
 * The flow row under a drawn (display) row in one column of a spanning order. Tiles are drawn at
 * their current height, so below a file that grew or shrank the drawn rows no longer equal the flow
 * rows a reorder works in; drops convert with this. Past a column's last entry, rows map one to one.
 */
function displayToFlowRow(order, flowCells, displayCells, wrapRows, col, displayRow) {
    let c = 0;
    let flow = 0;
    let display = 0;
    for (const id of order) {
        const f = id ? (flowCells[id] || 1) : 1;
        const g = id ? (displayCells[id] || f) : 1;
        if (flow > 0 && flow + f > wrapRows) {
            if (c === col)
                break;
            c++;
            flow = 0;
            display = 0;
        }
        if (c > col)
            break;
        if (c === col && displayRow < display + g) {
            return flow + Math.min(Math.max(0, displayRow - display), f - 1);
        }
        flow += f;
        display += g;
    }
    return c === col ? flow + Math.max(0, displayRow - display) : displayRow;
}
/**
 * Coarse per-line category from leading or contained keywords, not a real parser. Colors the
 * line bars of folder card previews; the host sends only line text, so the webview derives it.
 */
function categorizeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
        return "normal";
    }
    if (trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("'''") ||
        trimmed.startsWith("\"\"\"")) {
        return "comment";
    }
    if (trimmed.startsWith("import ") ||
        trimmed.startsWith("export ") ||
        trimmed.startsWith("from ") ||
        trimmed.startsWith("using ") ||
        trimmed.includes("require(")) {
        return "import";
    }
    if (trimmed.startsWith("class ") ||
        trimmed.startsWith("interface ") ||
        trimmed.startsWith("struct ") ||
        trimmed.startsWith("impl ") ||
        trimmed.startsWith("type ")) {
        return "class";
    }
    if (trimmed.startsWith("function ") ||
        trimmed.startsWith("def ") ||
        trimmed.startsWith("fn ") ||
        trimmed.startsWith("func ")) {
        return "function";
    }
    if (trimmed.includes("if ") ||
        trimmed.includes("for ") ||
        trimmed.includes("while ") ||
        trimmed.includes("return") ||
        trimmed.includes("switch") ||
        trimmed.includes("else") ||
        trimmed.includes("elif") ||
        trimmed.includes("catch") ||
        trimmed.includes("try")) {
        return "control-flow";
    }
    return "normal";
}
// ---- END GENERATED from src/layout_core.ts ----

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
    active: { color: "#007fd4", width: 2.5 },
    open: { color: "#fe6100", width: 1.8 },
    dragging: { color: "#648fff", width: 1.8 },
    default: { color: "rgba(255, 255, 255, 0.08)", width: 1 }
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
        active: { color: getThemeColor("--vscode-focusBorder", "#007fd4"), width: 2.5 },
        open: { color: ACCENT_RECENCY, width: 1.8 },
        dragging: { color: "#648fff", width: 1.8 },
        default: { color: getThemeColor("--vscode-widget-border", light ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.08)"), width: 1 }
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

// Robust color -> rgba(...) parser supporting hex, rgb, rgba, and hsl. Memoized: the renderer calls
// it per tile with a handful of theme colors, and parsing showed up in first-frame profiles. Pure
// function of its arguments, so theme changes need no invalidation (new colors are new keys).
const withAlphaCache = new Map();
function withAlpha(color, alpha) {
    const key = `${color}|${alpha}`;
    let result = withAlphaCache.get(key);
    if (result === undefined) {
        result = withAlphaUncached(color, alpha);
        if (withAlphaCache.size > 512) withAlphaCache.clear();
        withAlphaCache.set(key, result);
    }
    return result;
}

function withAlphaUncached(color, alpha) {
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
let openFilesVersion = 0; // bumped whenever openFiles changes; part of the folder mosaic cache key
let cursorLocations = {}; // Map of file URIs to current cursor line numbers

const CLOSE_BUTTON_PADDING = 4; // px

// Canvas layout margins for the root/subfolder grid — reserve space above the tiles
// for the breadcrumb bar, below for bottom padding, and on the sides for edge padding.
const GRID_TOP_MARGIN = 64;
const GRID_BOTTOM_MARGIN = 40;
const GRID_SIDE_MARGIN = 16;
const BASE_GRID_ASPECT = 16 / 9;
const REF_CANVAS_W = 1200;
const REF_CANVAS_H = 800;

const DRAG_THRESHOLD = 3; // px
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
let pendingDataMsg = null;
// Search index per file id, reused while the host's contentVersion is unchanged. Entries for
// files missing from a payload are evicted so the map stays bounded by the workspace size.
const fileTokenCache = new Map();
let dataVersion = 0; // increments per "data" payload; part of the folder mosaic cache key
/**
 * LRU cache of offscreen canvases bounded by entry count and by pixel memory. Canvas backing
 * stores are often GPU textures, and entry-count limits alone let large drill-down tiles pin
 * hundreds of MB (the user saw GPU-process crashes while spamming F4). Evicted canvases are
 * shrunk to 0x0 so their memory is released immediately instead of at the next GC.
 */
class CanvasLRU {
    constructor(maxEntries, maxBytes) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.bytes = 0;
        this.map = new Map();
    }
    get size() { return this.map.size; }
    get(key) {
        const canvas = this.map.get(key);
        if (canvas) {
            // Refresh recency: Map iteration order is insertion order.
            this.map.delete(key);
            this.map.set(key, canvas);
        }
        return canvas;
    }
    set(key, canvas) {
        this.delete(key);
        this.map.set(key, canvas);
        this.bytes += (canvas.width || 0) * (canvas.height || 0) * 4;
        while (this.map.size > 1 && (this.map.size > this.maxEntries || this.bytes > this.maxBytes)) {
            this.delete(this.map.keys().next().value);
        }
    }
    delete(key) {
        const canvas = this.map.get(key);
        if (!canvas) return;
        this.map.delete(key);
        this.bytes -= (canvas.width || 0) * (canvas.height || 0) * 4;
        canvas.width = 0;
        canvas.height = 0;
    }
    clear() {
        for (const key of [...this.map.keys()]) this.delete(key);
        this.bytes = 0;
    }
}

const MAX_TILE_CACHE_ENTRIES = 500;
const MAX_TILE_CACHE_BYTES = 64 * 1024 * 1024;
const tileRasterCache = new CanvasLRU(MAX_TILE_CACHE_ENTRIES, MAX_TILE_CACHE_BYTES);
// Keyed by mosaicCacheKey, not stored on the group: getSubfolderGroups() rebuilds group objects every render.
const MAX_MOSAIC_CACHE_ENTRIES = 300;
const MAX_MOSAIC_CACHE_BYTES = 32 * 1024 * 1024;
const mosaicCache = new CanvasLRU(MAX_MOSAIC_CACHE_ENTRIES, MAX_MOSAIC_CACHE_BYTES);
let clipboardItem = null;

let hoveredFile = null;
const IS_MAC = typeof navigator !== "undefined" && (/Mac|iPod|iPhone|iPad/.test(navigator.platform || "") || /Mac/.test(navigator.userAgent || ""));
// The pointer hover outline (updateHoverOutline): its element, the file it marks, and its last rect.
const hoverOutline = document.getElementById("hover-outline");
let hoverOutlineFile = null;
let hoverOutlineKey = "";
// The folder whose tokens are being prepared on hover (schedulePrewarm).
let prewarmTimer = null;
let prewarmPath = null;
// Last pointer position in client coordinates (the Ctrl magnifier anchors to it) and whether
// Ctrl is held. Previously implicit globals; declared so reads before the first event are safe.
let lastMousePos = null;
let isCtrlDown = false;
let hoverSnappedTarget = null;
let hoverScrollOffset = 0;
let lastHoveredFileUri = null;
let wheelMousePos = null;
let lastWheelTime = 0;

const slotOccupancy = new Map();
const userReorderedFileSlots = new Map();
const fileById = new Map();
const fileByUri = new Map();

let matchCase = false;
let matchWholeWord = false;
let useRegex = false;
let rawSearchQuery = "";   // original case, trimmed
let searchQuery = "";      // lowercase, trimmed. kept for the existing fast substring path
let searchRegex = null;    // compiled only when useRegex or matchWholeWord is on
let searchInvalid = false; // true when the user's regex fails to compile
// Per-file search results are memoized per search state (fileMatchesSearch). narrowFromGeneration is
// the previous state when the new plain query only extends it, so files that missed it are skipped.
let searchGeneration = 0;
let narrowFromGeneration = -1;
let lastPlainSearch = null; // { query, matchCase } of the previous plain search, for narrowing

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
        const rectW = getViewportW();
        const rectH = getViewportH();
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

    // In focused folder mode, test only the files currently rendered in the active grid
    const candidateFiles = (focusedFolder && activeRenderGrid && activeRenderGrid.files)
        ? activeRenderGrid.files
        : ((focusedFolder && activeRenderGrid && activeRenderGrid.orderedItems)
            ? activeRenderGrid.orderedItems.filter(it => it && it.file).map(it => it.file)
            : getFilteredFiles());
    for (let i = 0; i < candidateFiles.length; i++) {
        const file = candidateFiles[i];
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
    const rectW = getViewportW();
    const rectH = getViewportH();
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
        if (grid.isSpanning && grid.layout.placements) {
            for (const p of grid.layout.placements) {
                if (p.slots && p.slots.some(s => s[0] === col_clamped && s[1] === row_clamped)) {
                    item = p.item || p.file;
                    if (item && item.type === "file") file = item.file;
                    break;
                }
            }
        } else {
            const slotIdx = grid.layout.slots.findIndex(s => s[0] === col_clamped && s[1] === row_clamped);
            if (slotIdx !== -1 && slotIdx < grid.orderedItems.length && grid.orderedItems[slotIdx]) {
                item = grid.orderedItems[slotIdx];
                if (item.type === "file") file = item.file;
            }
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
    // The target is where the dragged tile's top-left cell would land (the cursor minus where the
    // tile was grabbed, rounded to the nearest cell), not the cell under the cursor: a two-tall tile
    // grabbed by its lower half and moved down one row moves one row, not two.
    const probe = findNearestSlot(cursorPos.px, cursorPos.py);
    if (dragGrabOffset && probe && probe.cellW > 0 && probe.cellH > 0) {
        dragTarget = findNearestSlot(
            cursorPos.px - dragGrabOffset.x + probe.cellW / 2,
            cursorPos.py - dragGrabOffset.y + probe.cellH / 2
        );
    } else {
        dragTarget = probe;
    }
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

    if (pendingDataMsg) {
        const msgToApply = pendingDataMsg;
        pendingDataMsg = null;
        applyDataMessage(msgToApply);
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
    scheduleSearchAnnouncement();
}

let searchAnnounceTimer = null;
/** Announces the search result count once typing pauses, so screen readers are not flooded per keystroke. */
function scheduleSearchAnnouncement() {
    if (searchAnnounceTimer) clearTimeout(searchAnnounceTimer);
    searchAnnounceTimer = setTimeout(() => {
        searchAnnounceTimer = null;
        if (!data || typeof announce !== "function") return;
        if (!searchQuery) {
            announce("Search cleared");
        } else if (searchInvalid) {
            announce("Invalid regular expression");
        } else {
            const count = data.files.filter(f => fileMatchesSearch(f)).length;
            announce(count === 0 ? "No files match" : `${count} file${count === 1 ? "" : "s"} match`);
        }
    }, 500);
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

    const plain = !useRegex && !matchWholeWord && rawSearchQuery !== "";
    const folded = matchCase ? rawSearchQuery : searchQuery;
    narrowFromGeneration = plain && lastPlainSearch && lastPlainSearch.matchCase === matchCase && folded.includes(lastPlainSearch.query)
        ? searchGeneration
        : -1;
    lastPlainSearch = plain ? { query: folded, matchCase } : null;
    searchGeneration++;
    hoverSnappedTarget = null;
    hoverScrollOffset = 0;
    wheelMousePos = null;
    if (isCtrlDown) updateHoverTooltip();

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

/** Search matches over a cached folder mosaic: the tint and outline a match used to bake in, as one path. */
let mosaicMatchFill = null;
function drawMosaicSearchOverlay(tileRects, mosaicX, mosaicY) {
    if (!tileRects) return;
    let any = false;
    ctx.beginPath();
    for (const r of tileRects) {
        // By id: a cached mosaic outlives payloads, and the current file object carries the search memo.
        const file = fileById.get(r.id);
        if (!file || !fileMatchesSearch(file)) continue;
        ctx.rect(mosaicX + r.x, mosaicY + r.y, r.w, r.h);
        any = true;
    }
    if (!any) return;
    mosaicMatchFill ??= withAlpha(ACCENT_SEARCH, 0.45);
    ctx.fillStyle = mosaicMatchFill;
    ctx.fill();
    ctx.strokeStyle = ACCENT_SEARCH;
    ctx.lineWidth = 2.0;
    ctx.stroke();
}

/**
 * textMatches over a whole file, memoized per search state. Payload files are fresh objects, so a
 * content change can never reuse a stale result.
 */
function fileMatchesSearch(file) {
    if (file._searchGen === searchGeneration) return file._searchHit;
    const hit = file._searchGen === narrowFromGeneration && !file._searchHit
        ? false
        : textMatches(matchCase || searchRegex ? combinedOriginalText(file) : "", file._combinedText);
    file._searchGen = searchGeneration;
    file._searchHit = hit;
    return hit;
}

// Setup search inputs
const searchInputFld = document.getElementById("search-input");
const matchCaseBtn = document.getElementById("search-match-case");
const matchWordBtn = document.getElementById("search-match-word");
const useRegexBtn = document.getElementById("search-use-regex");
const clearSearchBtn = document.getElementById("clear-search");

// From the search box: Enter opens the first match, ArrowDown moves to it so the arrows (limited to
// matches, navigationTargets) and Enter take over. Reading order, like Home.
searchInputFld.addEventListener("keydown", event => {
    if ((event.key !== "Enter" && event.key !== "ArrowDown") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!data || !rawSearchQuery || searchInvalid) return;
    // A folder card first opens the folder (Enter), where the matching files are then reachable.
    const first = readingOrder(searchMatchTargets())[0];
    event.preventDefault();
    if (!first) {
        announce("No matching files on screen");
        return;
    }
    canvas.focus();
    focusKeyboardTarget(first);
    if (event.key === "Enter") activateKeyboardTarget(first);
});

searchInputFld.addEventListener("input", e => {
    studyNote("searchEdit");
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
    studyNote("searchToggle");
    matchCase = !matchCase;
    rebuildSearchState(searchInputFld.value);
    matchCaseBtn.classList.toggle('active');
    matchCaseBtn.setAttribute("aria-pressed", String(matchCase));
    triggerSearchRender(true);
}

/** Toggles regex search mode and re-renders with the new search state. */
function toggleRegex() {
    studyNote("searchToggle");
    useRegex = !useRegex;
    rebuildSearchState(searchInputFld.value);
    useRegexBtn.classList.toggle('active');
    useRegexBtn.setAttribute("aria-pressed", String(useRegex));
    triggerSearchRender(true);
}

/** Toggles whole-word search matching and re-renders with the new search state. */
function toggleMatchWord() {
    studyNote("searchToggle");
    matchWholeWord = !matchWholeWord;
    rebuildSearchState(searchInputFld.value);
    matchWordBtn.classList.toggle('active');
    matchWordBtn.setAttribute("aria-pressed", String(matchWholeWord));
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
        if (cmd === 'c') {
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

    // Keys typed in the context menu operate the menu (its own keydown listener), never search.
    if (contextMenuHasFocus()) {
        return;
    }

    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key === 'Backspace') {
            event.preventDefault();
            clearSearch();
            return;
        }
        // Ctrl+F / ⌘F: Thumbview's search box, where VS Code users look for find.
        if ((event.key === 'f' || event.key === 'F') && !event.shiftKey) {
            event.preventDefault();
            searchInputFld.focus();
            if (typeof searchInputFld.select === "function") searchInputFld.select();
            return;
        }
    }

    if (activeEl === searchInputFld) {
        return;
    }

    if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
    }

    if (event.key === " " && activeEl && activeEl.tagName === "BUTTON") {
        // Space presses a focused button (toolbar, dialogs, the fullscreen banner) instead of typing.
        return;
    }

    if (event.key === " " && kbMode && currentKeyboardTarget()) {
        // Space activates the keyboard-focused tile (the grid handler below), as screen reader
        // users expect in an application widget; it only starts a search when nothing is focused.
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

let renderRafId = null;

// Single source of truth for the canvas's CSS size. Fed by a ResizeObserver so layout,
// hit testing, and the backing store never disagree during a Zen mode window expansion.
let viewportW = 0;
let viewportH = 0;
function getViewportW() {
    return viewportW || canvas.clientWidth || window.innerWidth;
}
function getViewportH() {
    return viewportH || canvas.clientHeight || window.innerHeight;
}

/** Coalesces bursts of state updates (data, openState, activeFile, resize) into one render per animation frame. */
function scheduleRender() {
    if (renderRafId) return;
    renderRafId = requestAnimationFrame(() => {
        renderRafId = null;
        render();
    });
}

/** Schedules a render at the current viewport size; render() resyncs the backing store. Tile and mosaic cache keys include their pixel size, so stale sizes age out of the LRU instead of forcing a full re-raster on the first frame after a resize. */
function resize() {
    if (document.hidden || document.visibilityState === "hidden") {
        // Webview tab is hidden or backgrounded; do NOT resize or re-render to background dimensions
        return;
    }
    scheduleRender();
}

let resizeSnapshotCanvas = null;

/**
 * Stretches the last painted frame to the new viewport size. Called from the ResizeObserver
 * callback, which runs after layout but before paint, so the frame painted at the new size is
 * already full-size instead of the previous frame sitting in the top-left corner while the
 * sharp render runs on the next animation frame. The zero-reflow layout scales cells in
 * proportion to the viewport, so the stretched frame closely matches the real one.
 */
function stretchLastFrameToViewport() {
    if (!data || !canvas.width || !canvas.height || document.hidden || isFrameFrozen()) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.floor(viewportW * dpr);
    const targetH = Math.floor(viewportH * dpr);
    if (targetW < 1 || targetH < 1 || (targetW === canvas.width && targetH === canvas.height)) return;
    try {
        if (!resizeSnapshotCanvas) resizeSnapshotCanvas = document.createElement("canvas");
        resizeSnapshotCanvas.width = canvas.width;
        resizeSnapshotCanvas.height = canvas.height;
        resizeSnapshotCanvas.getContext("2d").drawImage(canvas, 0, 0);
        canvas.width = targetW;
        canvas.height = targetH;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(resizeSnapshotCanvas, 0, 0, targetW, targetH);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Release the full-window snapshot now; holding it doubles canvas memory between resizes.
        resizeSnapshotCanvas.width = 0;
        resizeSnapshotCanvas.height = 0;
        dragBackgroundCanvas = null;
    } catch (e) {
        // A stale-frame stretch is cosmetic; the scheduled render repaints regardless.
    }
}

function updateViewportSize(width, height) {
    const w = Math.round(width);
    const h = Math.round(height);
    if (w === viewportW && h === viewportH) return;
    viewportW = w;
    viewportH = h;
    tryFastReveal();
    stretchLastFrameToViewport();
    resize();
}

if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(entries => {
        const rect = entries[entries.length - 1].contentRect;
        updateViewportSize(rect.width, rect.height);
    }).observe(canvas);
} else {
    window.addEventListener("resize", () => updateViewportSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight));
}

// Handle canvas context loss gracefully (e.g. GPU crash on Linux Wayland/Mesa drivers)
canvas.addEventListener("contextlost", (event) => {
    event.preventDefault();
    console.warn("Thumbview Canvas context lost. Waiting for restoration...");
});

canvas.addEventListener("contextrestored", () => {
    console.log("Thumbview Canvas context restored.");
    resize();
});

// The page is hidden (opacity 0) at first load and again whenever the host hides it for a
// Zen transition (hideForTransition). It reveals itself only after a data render has held the
// same viewport size for two frames, so neither the first open nor a rapid reopen ever shows a
// frame laid out for a transitional editor size. Fallback timers guarantee it cannot stay blank.
const INITIAL_REVEAL_STATUS_DELAY_MS = 400;
const INITIAL_REVEAL_MAX_DELAY_MS = 2500;
const TRANSITION_REVEAL_MAX_DELAY_MS = 1500;
let revealPending = true;
// Tile rasters drawn per frame are bounded once the page has been revealed (the reveal itself shows
// complete tiles); the rest show drawTilePlaceholder and render() schedules another frame.
const RASTER_FRAME_BUDGET_MS = 12;
let rasterBudgetEndsAt = Infinity;
let rasterDeferred = false;
// Each file's most recent tile raster ({ canvas, sig }), drawn scaled while its raster at a new size
// waits for a later frame. The canvases belong to tileRasterCache; one it evicted is 0x0 and skipped.
const lastTileRaster = new Map();
// Optional pdf.js loading (requestPdfJs, near drawThumbnail) waits for the first reveal.
let hasRevealedOnce = false;
let pdfJsState = "idle"; // "idle" | "wanted" | "scheduled" | "loading" | "ready" | "failed"
let pdfJsUrgent = false;
// Set while the host is mid-transition (after hideForTransition), so a render during a Zen step
// cannot count as "stable". Cleared only by the host's showAfterTransition for the latest
// transition id, which it sends once its layout commands and settle delays have finished.
let revealBlockedByTransition = false;
let latestTransitionId = 0;
let revealSafetyTimer = null;
document.body.style.opacity = "0";

/** Reveals the page and ends the pending gate. */
function completeReveal() {
    if (!revealPending) return;
    revealPending = false;
    beginStudyEpisode("reveal");
    hasRevealedOnce = true;
    maybeStartPdfJs();
    revealBlockedByTransition = false;
    revealNeedsSettleTime = false;
    hiddenSinceArm = false;
    panelHiddenByHost = false;
    // A fallback reveal (safety timer, user input) can happen while drawing was frozen at an old
    // size; always repaint at the current size. The render records lastRevealedW/H.
    scheduleRender();
    if (revealSafetyTimer) {
        clearTimeout(revealSafetyTimer);
        revealSafetyTimer = null;
    }
    ensureVisibleOpacity();
}

// While backgrounded the safety timer keeps polling instead of relying on a visibilitychange
// event. Once visible again it restarts the full transition delay rather than revealing at once,
// because becoming visible usually means a reopen transition is still expanding the editor.
const REVEAL_SAFETY_POLL_MS = 500;

function armRevealSafetyTimer(delayMs, sawHidden = false) {
    if (revealSafetyTimer) clearTimeout(revealSafetyTimer);
    revealSafetyTimer = setTimeout(() => {
        revealSafetyTimer = null;
        if (!revealPending) return;
        if (document.hidden) {
            armRevealSafetyTimer(REVEAL_SAFETY_POLL_MS, true);
            return;
        }
        if (sawHidden) {
            armRevealSafetyTimer(TRANSITION_REVEAL_MAX_DELAY_MS);
            return;
        }
        completeReveal();
    }, delayMs);
}

/** Hides the page until the next render at a stable size (see checkRevealStable). */
function armReveal() {
    revealPending = true;
    revealBlockedByTransition = true;
    revealNeedsSettleTime = true;
    document.body.style.opacity = "0";
    armRevealSafetyTimer(TRANSITION_REVEAL_MAX_DELAY_MS);
}

// Fast reopen: while a transition hides the page, drawing is frozen (see isFrameFrozen), so the
// canvas still holds the last frame the user saw. When the page comes back at exactly that size
// the frame is still correct and is shown at once, instead of waiting ~200ms for the host's
// settled signal plus the stability window (the "black flash"). Only after the page was actually
// hidden: during a close the panel is still visible at the old size and must stay hidden.
let lastRevealedW = 0;
let lastRevealedH = 0;
let hiddenSinceArm = false;
// Set by the host's panelHidden (e.g. after a jump covers Thumbview without hiding the page);
// cleared when the panel is shown again. Rendering a backgrounded panel only risks overwriting
// the last shown frame with one at a transitional size.
let panelHiddenByHost = false;

/** True while a transition hides a previously shown page, or the panel is backgrounded: renders and stretches would overwrite the frame the fast reopen path wants to show again. */
function isFrameFrozen() {
    if (lastRevealedW <= 0) return false;
    return (revealPending && revealBlockedByTransition) || panelHiddenByHost || switchingAway;
}

// Set when a click opens a file ("jump"/"switchTab"): Thumbview is about to be covered while VS
// Code rebuilds its layout on the same thread, so repaints of the whole grid (from openState
// updates or the resize) would only slow that down. Cleared once the host reports the panel
// hidden, when it is shown again, on any input, or after SWITCH_FREEZE_MAX_MS if the open failed
// and Thumbview stayed on screen.
const SWITCH_FREEZE_MAX_MS = 2000;
let switchingAway = false;
let switchFreezeTimer = null;

function endSwitchFreeze() {
    if (switchFreezeTimer) {
        clearTimeout(switchFreezeTimer);
        switchFreezeTimer = null;
    }
    if (!switchingAway) return;
    switchingAway = false;
    if (!panelHiddenByHost) scheduleRender();
}

/** Posts a message that opens a file over Thumbview (extension.ts "jump" / "switchTab"), freezing drawing first. */
// Usage study (STUDY.md): one summary per visit ("studyEpisode"), collected only while the host says
// the user joined (payload studyActive). Counts interactions and times; never records text (the
// search query only as its length). Ends with a jump or tab switch, or as dismissed when hidden.
let studyActive = false;
let studyEpisode = null;
/**
 * Starts a visit's clock. source "reveal": the page just appeared (completeReveal); "shown": the host
 * showed the panel (studyVisitStart), which starts the clock at once unless a reveal is still pending
 * (the reveal then sets it); "interaction": the fallback, when neither was seen.
 */
function beginStudyEpisode(source) {
    if (!studyActive) return;
    const now = performance.now();
    if (studyEpisode) {
        // A reveal after the host's start marks the moment the page actually became visible.
        if (source === "reveal" && studyEpisode.revealedAt === null && studyEpisode.firstActionAt === null) {
            studyEpisode.revealedAt = now;
            studyEpisode.revealedAtEpoch = Date.now();
            studyEpisode.startSource = "reveal";
        }
        return;
    }
    const waitsForReveal = source === "shown" && revealPending;
    studyEpisode = {
        revealedAt: source === "interaction" || waitsForReveal ? null : now,
        // Wall clock of the reveal, for the host's F4-to-reveal latency (study.ts reveal_latency_ms).
        revealedAtEpoch: source === "reveal" ? Date.now() : null,
        startSource: waitsForReveal ? "reveal" : source,
        startedAt: now, firstActionAt: null,
        focusedMs: 0, focusSince: typeof document.hasFocus === "function" && document.hasFocus() ? now : null,
        searchEdits: 0, searchToggles: 0, hovered: new Set(), magnifierUses: 0,
        folderDrillIns: 0, folderBackOuts: 0, keyboardMoves: 0
    };
}
// Focused time: a panel left open beside the code is visible but idle.
window.addEventListener("focus", () => {
    if (studyEpisode && studyEpisode.focusSince === null) studyEpisode.focusSince = performance.now();
});
window.addEventListener("blur", () => {
    if (studyEpisode && studyEpisode.focusSince !== null) {
        studyEpisode.focusedMs += performance.now() - studyEpisode.focusSince;
        studyEpisode.focusSince = null;
    }
});
function studyNote(kind, id) {
    if (!studyActive) return;
    if (!studyEpisode) beginStudyEpisode("interaction"); // no reveal or host start was seen
    const e = studyEpisode;
    if (kind === "hover") {
        e.hovered.add(id);
        return;
    }
    if (e.firstActionAt === null) e.firstActionAt = performance.now();
    if (kind === "searchEdit") e.searchEdits++;
    else if (kind === "searchToggle") e.searchToggles++;
    else if (kind === "magnifier") e.magnifierUses++;
    else if (kind === "drillIn") e.folderDrillIns++;
    else if (kind === "backOut") e.folderBackOuts++;
    else if (kind === "keyboard") e.keyboardMoves++;
}
function endStudyEpisode(outcome, method, file) {
    if (studyActive && !studyEpisode && outcome !== "dismissed") {
        // A choice with no visit in progress (e.g. Enter before anything else was seen) still counts.
        beginStudyEpisode("interaction");
    }
    const e = studyEpisode;
    studyEpisode = null;
    if (!studyActive || !e) return;
    const now = performance.now();
    const focusedMs = e.focusedMs + (e.focusSince !== null ? now - e.focusSince : 0);
    const slot = file && (file.slot || (file.slots && file.slots[0]));
    const queryActive = !!rawSearchQuery && !searchInvalid;
    vscode.postMessage({
        command: "studyEpisode",
        outcome,
        method,
        uri: file ? file.uri : undefined,
        sinceRevealMs: e.revealedAt === null ? null : now - e.revealedAt,
        revealedAtEpochMs: e.revealedAtEpoch,
        focusedMs,
        startSource: e.startSource,
        firstActionMs: e.firstActionAt === null ? null : e.firstActionAt - e.startedAt,
        searchUsed: e.searchEdits > 0 || queryActive,
        searchEdits: e.searchEdits,
        queryLength: rawSearchQuery.length,
        searchToggles: e.searchToggles,
        searchMatchCount: queryActive && data && data.files ? data.files.filter(fileMatchesSearch).length : 0,
        targetMatchedSearch: !!(file && queryActive && fileMatchesSearch(file)),
        tilesHovered: e.hovered.size,
        magnifierUses: e.magnifierUses,
        folderDrillIns: e.folderDrillIns,
        folderBackOuts: e.folderBackOuts,
        keyboardMoves: e.keyboardMoves,
        targetCol: slot ? slot[0] : null,
        targetRow: slot ? slot[1] : null,
        gridCols: data && data.layout ? data.layout.cols : null,
        gridRows: data && data.layout ? data.layout.rows : null,
        folderCardsView: !!(typeof activeRenderGrid !== "undefined" && activeRenderGrid && activeRenderGrid.isFolderCards),
        // Where the choice was made: the root grid, an opened folder, or a view of folder cards.
        viewKind: (typeof activeRenderGrid !== "undefined" && activeRenderGrid && activeRenderGrid.isFolderCards) ? "cards" : (focusedFolder ? "folder" : "root"),
        focusedFolderDepth: focusedFolder ? focusedFolder.split("/").filter(Boolean).length : 0,
        fileCount: data && data.files ? data.files.length : 0
    });
}

function postSwitchAway(msg) {
    // studyMethod: how the target was chosen ("keyboard", "view_band"; default a click).
    const { studyMethod, ...hostMsg } = msg;
    endStudyEpisode(msg.command === "jump" ? "jump" : "switch_tab", studyMethod || "click", fileByUri.get(msg.uri) || null);
    msg = hostMsg;
    switchingAway = true;
    if (switchFreezeTimer) clearTimeout(switchFreezeTimer);
    switchFreezeTimer = setTimeout(endSwitchFreeze, SWITCH_FREEZE_MAX_MS);
    vscode.postMessage(msg);
}

function markPanelShown() {
    endSwitchFreeze();
    if (!panelHiddenByHost) return;
    panelHiddenByHost = false;
    scheduleRender();
}

function tryFastReveal() {
    if (!revealPending || !hiddenSinceArm || document.hidden || !lastRevealedW) return;
    if (getViewportW() === lastRevealedW && getViewportH() === lastRevealedH) {
        completeReveal();
        scheduleRender();
    }
}

/** The host finished its layout transition: let the next stable-size render reveal the page. */
function endRevealTransitionBlock() {
    tryFastReveal();
    revealBlockedByTransition = false;
    if (revealPending) scheduleRender();
}

/** True for a transition message older than the latest one seen (e.g. a delayed show from a previous close). Records newer ids. */
function isStaleTransition(msg) {
    if (typeof msg.transitionId !== "number") return false;
    if (msg.transitionId < latestTransitionId) return true;
    latestTransitionId = msg.transitionId;
    return false;
}

/** Keyboard/pointer input reveals a pending page only once no host transition is in flight; during one, the safety timer is the fallback. */
function revealOnUserInput() {
    if (!revealBlockedByTransition) completeReveal();
}

// After a host transition the size must also hold for this long: the host's "settled" signal
// follows fixed sleeps, and on a slow machine Zen/maximize can still be animating.
const TRANSITION_REVEAL_STABLE_MS = 120;
let revealNeedsSettleTime = false;

/** Called after each data render while a reveal is pending; reveals once the size is stable (two frames, plus TRANSITION_REVEAL_STABLE_MS after a transition). */
function checkRevealStable(renderedW, renderedH) {
    const start = performance.now();
    const tick = () => {
        if (!revealPending || revealBlockedByTransition || document.hidden) return;
        // A changed size means the ResizeObserver has already scheduled a render at the new
        // size, which calls back here once that size holds.
        if (getViewportW() !== renderedW || getViewportH() !== renderedH) return;
        if (revealNeedsSettleTime && performance.now() - start < TRANSITION_REVEAL_STABLE_MS) {
            requestAnimationFrame(tick);
            return;
        }
        completeReveal();
    };
    requestAnimationFrame(() => requestAnimationFrame(tick));
}

setTimeout(() => {
    // Nothing to lay out yet (first scan still running): show the loading status instead of a blank panel.
    if (!data && !document.hidden) completeReveal();
}, INITIAL_REVEAL_STATUS_DELAY_MS);
armRevealSafetyTimer(INITIAL_REVEAL_MAX_DELAY_MS);

function ensureVisibleOpacity() {
    if (revealPending) {
        return;
    }
    if (document.body.style.opacity !== "1") {
        document.body.style.opacity = "1";
    }
}

window.addEventListener("focus", ensureVisibleOpacity);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && revealPending) {
        hiddenSinceArm = true;
    }
    if (document.visibilityState === "visible") {
        tryFastReveal();
        markPanelShown();
        if (revealPending) {
            // Becoming visible happens before the host's settle delays finish, so it only
            // restarts the fallback timer; showAfterTransition is what unblocks the reveal.
            armRevealSafetyTimer(TRANSITION_REVEAL_MAX_DELAY_MS);
        }
        ensureVisibleOpacity();
        resize();
    }
});
// User input reveals a pending page, except mid-transition: spamming the open key (F4) sends
// keydowns to the focused webview while Zen mode is still expanding.
window.addEventListener("pointerdown", revealOnUserInput, true);
// Input means Thumbview is still in front (e.g. the open failed), so it must draw again. Capture
// phase: runs before the handler that may post the next jump and set the freeze again.
window.addEventListener("keydown", endSwitchFreeze, true);
window.addEventListener("pointerdown", endSwitchFreeze, true);
window.addEventListener("keydown", revealOnUserInput, true);
window.addEventListener("pointerdown", ensureVisibleOpacity, true);
window.addEventListener("keydown", ensureVisibleOpacity, true);

// Host -> webview protocol (extension.ts is the sender in each case): "status" (loading/
// error text), "data" (the full file/layout payload), "activeFile" (URI of the focused
// editor), "openState" (open tab URIs + cursor lines). No shared type with extension.ts
// — see CLAUDE.md's "Cross-module interface" note.
let hoverLineCache = {}; // Cache of fetched line ranges for long files { uri: { lineIdx: lineObj } }
let pendingHoverRequest = null;
let viewLocations = {}; // Map of file URIs to current visible range { startLine, endLine }

/** Installs a host "data" payload: indexes files for search/hit testing and schedules a render. Also used to flush a payload deferred during a drag. */
/** 32-bit FNV-1a hash of a string, for compact cache-key signatures. */
function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

/**
 * Signature of everything a folder mosaic draws beyond its size and view state: member content
 * and decorations, plus the group's own saved layout. Lets mosaics survive unrelated payloads.
 */
function groupMosaicSignature(group) {
    let members = "";
    for (const f of group.files) {
        members += `${f.id}|${f.contentVersion}${f._linesPending ? "p" : ""}|${f._decoSig}\n`;
    }
    const p = group.path;
    const scopeState = data ? JSON.stringify([
        data.folderOrders && data.folderOrders[p],
        data.folderCardOrders && data.folderCardOrders[p],
        data.folderWrapRows && data.folderWrapRows[p],
        data.folderExtraCols && data.folderExtraCols[p],
        data.folderExtraRows && data.folderExtraRows[p],
        data.slotFootprints && data.slotFootprints[`folder:${p}`],
        data.slotFlowCells && data.slotFlowCells[`folder:${p}`]
    ]) : "";
    return hashString(members) + hashString(scopeState);
}

/**
 * Fills a line's indent, trimmed length, and category (categorizeLine, shared core) from its text
 * on first use. The host sends only line text (withDeltaLines), so these are derived here, once
 * per line and only for lines that are drawn. Tiles use the indent; folder card previews draw each
 * line as a bar from all three.
 */
function lineShape(line) {
    if (line.length === undefined) {
        const text = line.text || "";
        line.indent = text.length - text.trimStart().length;
        line.length = text.trimEnd().length;
        line.category = categorizeLine(text);
    }
    return line;
}

/** A line's lowercase text for search matching, computed on first use and kept on the line. */
function lowerLineText(line) {
    if (line._lowerText === undefined) {
        line._lowerText = (line.text || "").toLowerCase();
    }
    return line._lowerText;
}

/**
 * Original-case search text, needed only by Match Case, Whole Word, and regex searches, so it is built
 * on first use instead of for every file (it was a full extra copy of the workspace's text). Only the
 * lowercase index (_combinedText) is built eagerly, because plain search is the common case.
 */
function combinedOriginalText(f) {
    if (f._combinedTextOriginal === undefined) {
        const parts = (f.lines || []).map(line => line.text || "");
        if (f.fullLines) parts.push(...f.fullLines);
        f._combinedTextOriginal = parts.join("\n");
    }
    return f._combinedTextOriginal;
}

/** Lowercase copies of a long file's full lines, built on the first search that needs them. */
function lowerFullLines(f) {
    if (!f._lowerFullLines) f._lowerFullLines = f.fullLines.map(str => str.toLowerCase());
    return f._lowerFullLines;
}

/**
 * Builds a file's search text (_combinedText, lowercase and original) and line statistics, reusing the
 * cached index while contentVersion is unchanged. A file whose text is still streaming is indexed by
 * path only and never cached, so its real text is indexed when it arrives.
 */
function indexFileText(f) {
    const cachedEntry = fileTokenCache.get(f.id);
    const cached = cachedEntry && f.contentVersion !== undefined && cachedEntry.contentVersion === f.contentVersion
        ? cachedEntry
        : null;

    if (cached) {
        f._combinedText = cached.combinedText;
        f._avgLineChars = cached.avgLineChars;
    } else {
        // One lowercase pass over the joined text instead of one per line: per-line
        // lowercase copies (_lowerText) are made lazily, only for lines drawn or hovered
        // while a search is active (see lowerLineText).
        const textArrOriginal = [];
        if (f.lines) {
            for (let lIdx = 0; lIdx < f.lines.length; lIdx++) {
                textArrOriginal.push(f.lines[lIdx].text || "");
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
            f._avgLineChars = validCount > 0 ? Math.min(100, Math.max(10, Math.round(totalChars / validCount))) : 50;
        }
        if (f.fullLines) {
            textArrOriginal.push(...f.fullLines);
        }
        const combinedOriginal = textArrOriginal.join("\n");
        // Same string as lowercasing each part and joining: the path, then every line.
        const lowerParts = [];
        if (f.path) lowerParts.push(f.path.toLowerCase());
        if (textArrOriginal.length > 0) lowerParts.push(combinedOriginal.toLowerCase());
        f._combinedText = lowerParts.join("\n");

        if (f._linesPending) return;
        fileTokenCache.set(f.id, {
            contentVersion: f.contentVersion,
            combinedText: f._combinedText,
            avgLineChars: f._avgLineChars
        });
    }
}

/**
 * Text for files a "data" payload marked pending (see withDeltaLines/streamPendingLines in
 * extension.ts). Fields: { files: { id, contentVersion, lines: string[], fullLines? }[] }. Applied to
 * the current data and to a payload deferred by a drag; stale versions are ignored.
 */
function applyFileLinesMessage(msg) {
    if (!Array.isArray(msg.files)) return;
    let changed = false;
    const deferred = pendingDataMsg && pendingDataMsg.files ? new Map(pendingDataMsg.files.map(f => [f.id, f])) : null;
    for (const entry of msg.files) {
        const f = fileById.get(entry.id);
        if (f && f._linesPending && f.contentVersion === entry.contentVersion) {
            f.lines = entry.lines.map(text => ({ text }));
            f.fullLines = entry.fullLines;
            delete f._linesPending;
            indexFileText(f);
            // Search memos were computed without this text.
            f._searchGen = -1;
            f._matchedLinesGen = -1;
            changed = true;
        }
        const d = deferred && deferred.get(entry.id);
        if (d && d.linesPending && d.contentVersion === entry.contentVersion) {
            d.lines = entry.lines;
            d.fullLines = entry.fullLines;
            delete d.linesPending;
        }
    }
    if (changed) scheduleRender();
    maybeStartPdfJs();
}

function applyDataMessage(msg) {
    if (msg.isReflow) {
        userReorderedFileSlots.clear();
    }
    // Delta payloads omit lines for files whose contentVersion the webview already holds.
    const previousById = new Map(fileById);
    const missingLines = [];
    data = msg;
    data._version = ++dataVersion;
    // Raster caches are not cleared here: tile keys carry contentVersion and a decoration
    // signature, mosaic keys a group signature, so unchanged tiles survive every payload.
    if (userReorderedFileSlots.size > 0 && data && data.files) {
        for (let fIdx = 0; fIdx < data.files.length; fIdx++) {
            const f = data.files[fIdx];
            const saved = userReorderedFileSlots.get(f.id);
            if (saved) {
                f.slot = [...saved.slot];
                f.slots = saved.slots ? saved.slots.map(s => [...s]) : [[...saved.slot]];
            }
        }
        // A pin only bridges the payload that may already be in flight when a tile is dropped; the
        // host's own layout of the new order follows, and must never be overridden for longer.
        userReorderedFileSlots.clear();
    }
    currentIgnorePatterns = msg.ignorePatterns || [];
    studyActive = msg.studyActive === true;
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
            if (f.linesOmitted || f.linesPending) {
                const prev = previousById.get(f.id);
                if (prev && prev.contentVersion === f.contentVersion && prev.lines && !prev._linesPending) {
                    f.lines = prev.lines;
                    f.fullLines = prev.fullLines;
                } else if (f.linesPending) {
                    // Text follows in "fileLines" chunks (applyFileLinesMessage); the tile is placed now.
                    f.lines = [];
                    f._linesPending = true;
                } else {
                    missingLines.push(f.id);
                }
                delete f.linesPending;
            } else if (f.lines && f.lines.length > 0 && typeof f.lines[0] === "string") {
                // The host sends lines as plain strings (a fraction of the size and clone time of
                // objects); line objects carry the per-line render caches (_tokens, _htmlCache).
                f.lines = f.lines.map(text => ({ text }));
            }
            f._decoSig = hashString(JSON.stringify([
                f.gitStatus || "",
                f.gitChanges || null,
                f.errorLines ? Object.keys(f.errorLines) : null
            ]));
            fileById.set(f.id, f);
            fileByUri.set(f.uri, f);
            f._lowerPath = f.path ? f.path.toLowerCase() : "";
            indexFileText(f);

            if (f.slots) {
                for (const [col, row] of f.slots) {
                    slotOccupancy.set(`${col},${row}`, f);
                }
            } else if (f.slot) {
                slotOccupancy.set(`${f.slot[0]},${f.slot[1]}`, f);
            }
        }
        for (const id of fileTokenCache.keys()) {
            if (!fileById.has(id)) {
                fileTokenCache.delete(id);
            }
        }
        if (missingLines.length > 0) {
            // E.g. a delta arrived after a payload that was superseded during a drag.
            vscode.postMessage({ command: "requestFileLines", ids: missingLines });
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
    syncShortcutLegend();
    syncAutoHiddenChip();
    if (actionsModal && actionsModal.style.display === "block") {
        updateSettingsModalState();
    }
    if (foldersPopover && foldersPopover.style.display === "block") {
        updateIgnoresPopover();
        updateFoldersPopover();
    }
    keepPendingRootOrder(msg);
    scheduleRender();
}

// The root order of the last drop, until a payload shows the host has processed it: each drop
// carries reorderSeq, and the host echoes the last one it processed in every payload (data
// reorderSeq). An older payload (built before the drop, or before a second quick drop) must not put
// tiles back where they were. The time limit only guards against a host that never answers.
const PENDING_REORDER_MAX_MS = 3000;
let reorderSeq = 0;
let pendingRootOrder = null;
let pendingRootWrap = null;
let pendingRootSince = 0;
let pendingRootSeq = 0;
function keepPendingRootOrder(msg) {
    if (!pendingRootOrder || !data || !data.files) return;
    const isSpanning = data.mode === "spanning_grid" || data.layoutMode === "spanning_grid";
    const caughtUp = typeof msg.reorderSeq === "number" && msg.reorderSeq >= pendingRootSeq;
    if (!isSpanning || msg.isReflow || caughtUp || performance.now() - pendingRootSince > PENDING_REORDER_MAX_MS) {
        pendingRootOrder = null;
        return;
    }
    data.fileOrder = [...pendingRootOrder];
    relayoutRootSpanning(pendingRootWrap);
}

window.addEventListener("message", event => {
    const msg = event.data;

    if (msg.command === "status") {
        statusText = msg.text;
        if (typeof msg.text === "string" && msg.text.startsWith("Error") && typeof announce === "function") {
            announce(msg.text);
        }
        if (msg.clearData) {
            data = null;
            hoverLineCache = {};
        }
        if (!data) {
            // render() sizes the backing store before delegating to drawStatus().
            scheduleRender();
        }
    }

    if (msg.command === "focusWebview") {
        window.focus();
    }

    // Hide/show webview content during zen mode transitions so the user
    // doesn't see the canvas at the wrong size (hideForTransition from
    // extension.ts onDidChangeViewState enter path — keep in sync)
    if (msg.command === "hideForTransition" && !isStaleTransition(msg)) {
        // Stays hidden through the exit and the next reopen until a stable-size frame exists.
        armReveal();
        if (msg.fromHidden) {
            // Reopen of a panel that was hidden (e.g. after a jump, which does not hide the page):
            // the last shown frame is intact, so the fast reopen path may use it.
            hiddenSinceArm = true;
        }
    }
    if (msg.command === "fullscreenNotice") {
        // extension.ts maybeShowFullscreenNotice: { keybinding }. Sent once per install.
        showFullscreenNotice(msg.keybinding);
    }
    if (msg.command === "fullscreenSetting") {
        // extension.ts: { enabled }, after thumbview.fullscreenOnOpen changes from anywhere.
        const fsToggleEl = document.getElementById("fullscreen-toggle");
        if (fsToggleEl) fsToggleEl.checked = msg.enabled !== false;
        hideFullscreenNotice();
    }
    if (msg.command === "panelHidden") {
        // Host signal (onDidChangeViewState): the panel was backgrounded. Retained webviews may be
        // hidden without document.visibilityState changing, so the fast reopen path relies on this.
        panelHiddenByHost = true;
        // The study visit does not end here: Zen and maximize steps hide the panel briefly. The host
        // sends "studyVisitEnd" once it stays hidden.
        // The hidden-panel freeze takes over from the click's switch freeze.
        endSwitchFreeze();
        // The one-time banner does not come back with the retained page.
        hideFullscreenNotice();
        if (revealPending) hiddenSinceArm = true;
    }
    if (msg.command === "showAfterTransition" && !isStaleTransition(msg)) {
        markPanelShown();
        endRevealTransitionBlock();
        ensureVisibleOpacity();
    }

    if (msg.command === "studyVisitEnd") {
        // extension.ts: the panel stayed hidden past the flicker window (no fields). A jump already
        // ended its visit in postSwitchAway, so this only ends visits left without choosing.
        endStudyEpisode("dismissed", "none", null);
    }

    if (msg.command === "studyVisitStart") {
        // extension.ts studyShown: the host showed the panel (no fields).
        beginStudyEpisode("shown");
    }

    if (msg.command === "fileLines") {
        applyFileLinesMessage(msg);
    }

    if (msg.command === "data") {
        if (draggingFile || draggingFolder) {
            pendingDataMsg = msg;
            return;
        }
        applyDataMessage(msg);
    }

    if (msg.command === "activeFile") {
        activeFileUri = msg.uri;
        scheduleRender();
    }

    if (msg.command === "openState") {
        if ("activeFileUri" in msg) {
            activeFileUri = msg.activeFileUri;
        }
        if ("openFiles" in msg) {
            openFiles = msg.openFiles;
            openFilesSet = new Set(openFiles);
            openFilesVersion++;
        }
        viewLocations = msg.viewLocations || {};
        scheduleRender();
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

function getCompressionPct() {
    if (typeof data !== "undefined" && data) {
        if (typeof data.compressionPercentage === "number") {
            if (data.compressionPercentage <= 0) return 0;
            const pct = data.compressionPercentage >= 1 ? data.compressionPercentage / 100 : data.compressionPercentage;
            return Math.max(0, Math.min(0.25, pct));
        }
        if (typeof data.compressionPct === "number") {
            if (data.compressionPct <= 0) return 0;
            return Math.max(0, Math.min(0.25, data.compressionPct));
        }
    }
    return 0.05;
}

/** Footprints (minimum cells for items that filled a taller hole) for a layout scope: "folder:<path>", "cards:<path>", or "root". Mirrors extension.ts slotFootprints. */
function scopeFootprints(scopeKey) {
    return (typeof data !== "undefined" && data && data.slotFootprints && data.slotFootprints[scopeKey]) || null;
}

/** Frozen flow cells (column-membership heights) for a layout scope. Mirrors extension.ts slotFlowCells. */
function scopeFlowCells(scopeKey) {
    return (typeof data !== "undefined" && data && data.slotFlowCells && data.slotFlowCells[scopeKey]) || null;
}

/** Cells an ignored/deleted id occupied in a scope: its frozen flow cells there, else its natural height (host naturalCells) or footprint, so the hole matches the layout. */
function spanningHoleCells(fid, footprints = null, flowCells = null) {
    if (flowCells && flowCells[fid]) return flowCells[fid];
    const natural = (typeof data !== "undefined" && data && data.naturalCells && data.naturalCells[fid]) || 1;
    return Math.max(natural, (footprints && footprints[fid]) || 0);
}

// Twin of spanning_layout.ts buildSpanningGrid's flow/display split: `allocations` are flow cells
// (frozen per scope in `flowCells`, deciding column membership) and `displayCells` are drawn
// heights. A growing or shrinking file pushes files within its column but never re-wraps them;
// an overflowing column adds rows, plus columns in proportion to keep the cell aspect.
function buildSpanningGridLocal(files, targetAspect = 1.777, folderOrder = null, extraCols = 0, extraRows = 0, baseLinesPerCell = 60, compressionPct = (typeof getCompressionPct === "function" ? getCompressionPct() : 0.05), savedWrapRows = null, footprints = null, flowCells = null) {
    const allocations = {};
    const displayCells = {};
    let actualCells = 0;
    let maxNCells = 1;

    for (const f of files) {
        const natural = f.lineCount ? cellsNeeded(f.lineCount, baseLinesPerCell, compressionPct) : (f.nCells || 1);
        // An item that filled a taller hole displays at least the hole's cells.
        const shown = Math.max(natural, (footprints && footprints[f.id]) || 0);
        displayCells[f.id] = shown;
        const nCells = (flowCells && flowCells[f.id]) || shown;
        allocations[f.id] = nCells;
        actualCells += nCells;
        if (nCells > maxNCells) {
            maxNCells = nCells;
        }
    }

    // Holes left by ignored/deleted files count toward the grid size exactly like the host's
    // buildSpanningGrid counts stale ids, so ignoring a file changes neither wrapRows nor columns.
    if (folderOrder && Array.isArray(folderOrder)) {
        const liveIds = new Set(files.map(f => f.id));
        for (const fid of folderOrder) {
            if (!fid || liveIds.has(fid)) continue;
            const holeCells = spanningHoleCells(fid, footprints, flowCells);
            allocations[fid] = holeCells;
            actualCells += holeCells;
            if (holeCells > maxNCells) {
                maxNCells = holeCells;
            }
        }
    }

    const calculatedRows = (typeof buildStableGrid === "function")
        ? Math.max(1, buildStableGrid(Math.max(actualCells, files.length, 1), targetAspect).rows)
        : Math.max(1, Math.round(Math.sqrt(Math.max(actualCells, files.length, 1) / targetAspect)));
    const baseRows = Math.max(1, calculatedRows, maxNCells);
    const naturalColsNeeded = Math.ceil(actualCells / baseRows);
    const baseCols = Math.max(2, naturalColsNeeded);
    const finalRows = baseRows + extraRows;
    const finalCols = baseCols + extraCols;
    const wrapRows = (savedWrapRows && savedWrapRows > 0) ? Math.max(savedWrapRows, maxNCells) : baseRows;

    const filesById = new Map(files.map(f => [f.id, f]));
    let orderToIterate = [];
    if (folderOrder && Array.isArray(folderOrder) && folderOrder.length > 0) {
        // Files missing from the order fill holes left by removed files, never "" gaps the user left
        // (fillLayoutHoles, the one stability rule shared with the host).
        orderToIterate = fillLayoutHoles(folderOrder, files.map(f => f.id), id => allocations[id] || 1, id => spanningHoleCells(id, footprints, flowCells)).order;
    } else {
        orderToIterate = files.map(f => f.id);
    }

    let currCol = 0;
    let currRow = 0;        // flow position: decides column breaks
    let currDisplayRow = 0; // drawn position: follows current tile heights
    let maxRowUsed = 1;
    let maxFlowRowUsed = 1;
    const placements = [];

    for (const fid of orderToIterate) {
        const file = fid ? filesById.get(fid) : null;
        const nCells = fid ? (allocations[fid] || 1) : 1;
        const shownCells = file ? (displayCells[fid] || nCells) : nCells;
        const mustBreak = currRow > 0 && currRow + nCells > wrapRows;

        if (mustBreak) {
            currCol++;
            currRow = 0;
            currDisplayRow = 0;
        }

        if (file) {
            const slots = [];
            for (let i = 0; i < shownCells; i++) {
                slots.push([currCol, currDisplayRow + i]);
            }

            placements.push({
                file: file.file || file,
                item: file.item || file,
                col: currCol,
                row: currDisplayRow,
                nCells: shownCells,
                slots
            });
        }

        currRow += nCells;
        currDisplayRow += shownCells;
        if (currDisplayRow > maxRowUsed) {
            maxRowUsed = currDisplayRow;
        }
        if (currRow > maxFlowRowUsed) {
            maxFlowRowUsed = currRow;
        }
    }

    let maxPlacementCol = 0;
    let maxPlacementRow = 0;
    for (const p of placements) {
        if (p.col > maxPlacementCol) maxPlacementCol = p.col;
        const bottom = p.row + p.nCells;
        if (bottom > maxPlacementRow) maxPlacementRow = bottom;
    }
    const reqCols = placements.length > 0 ? (maxPlacementCol + 1) : (currCol + 1);
    const reqRows = placements.length > 0 ? maxPlacementRow : maxRowUsed;
    let resolvedCols = Math.max(finalCols, reqCols);
    const resolvedRows = Math.max(finalRows, reqRows);
    // Rows added only because grown tiles overflow their columns: add columns in proportion.
    const flowRows = Math.max(1, Math.min(resolvedRows, Math.max(finalRows, maxFlowRowUsed)));
    const flowCols = resolvedCols;
    if (resolvedRows > flowRows) {
        resolvedCols = Math.max(resolvedCols, Math.ceil(resolvedCols * resolvedRows / flowRows));
    }

    const gridSlots = [];
    for (let r = 0; r < resolvedRows; r++) {
        for (let c = 0; c < resolvedCols; c++) {
            gridSlots.push([c, r]);
        }
    }

    return {
        rows: resolvedRows,
        cols: resolvedCols,
        wrapRows: wrapRows,
        // Pre-overflow size: readability/collapse checks use it (see spanning_layout.ts flowRows).
        flowRows,
        flowCols,
        placements,
        slots: gridSlots
    };
}

const breadcrumbHistory = [""];
let breadcrumbHistoryIndex = 0;

/** Sets focusedFolder, tracks history stack, and triggers breadcrumbs & render update. */
function setFocusedFolderWithHistory(folder, recordHistory = true) {
    studyNote(folder ? "drillIn" : "backOut");
    if (pdfJsState === "wanted" || pdfJsState === "idle") pdfJsUrgent = true;
    const target = folder || "";
    if (recordHistory && target !== breadcrumbHistory[breadcrumbHistoryIndex]) {
        breadcrumbHistory.splice(breadcrumbHistoryIndex + 1);
        breadcrumbHistory.push(target);
        breadcrumbHistoryIndex = breadcrumbHistory.length - 1;
    }
    focusedFolder = target;
    updateBreadcrumbs();
    render();
    if (typeof announce === "function") {
        announce(target ? `Showing folder ${target === "(root files)/" ? "root files" : target}` : "Showing all files");
    }
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

/**
 * Determines whether a folder's contents collapse into subfolder cards.
 * Uses a stable reference canvas size (REF_CANVAS_W x REF_CANVAS_H) and BASE_GRID_ASPECT
 * so folder card previews and folder drill-down views match 100% and never reflow on window resize.
 */
function doesFolderCollapse(files, folderPath, isSpanning, activeW, activeH) {
    if (!files || files.length === 0) return false;
    const subfolderInfo = getSubfolderGroups(files, folderPath);
    if (!subfolderInfo || subfolderInfo.folders.length === 0) {
        return false;
    }
    const canvasW = (typeof activeW === "number" && activeW > 0)
        ? activeW
        : (getViewportW() - (GRID_SIDE_MARGIN * 2));
    const canvasH = (typeof activeH === "number" && activeH > 0)
        ? activeH
        : (getViewportH() - GRID_TOP_MARGIN - GRID_BOTTOM_MARGIN);
    const availW = Math.max(50, canvasW);
    const availH = Math.max(50, canvasH);
    const minW = (typeof data !== "undefined" && data && typeof data.minCellWidth === "number") ? data.minCellWidth : 40;
    const minH = (typeof data !== "undefined" && data && typeof data.minCellHeight === "number") ? data.minCellHeight : 28;
    const spanningMode = typeof isSpanning === "boolean"
        ? isSpanning
        : (typeof data !== "undefined" && data && (data.mode === "spanning_grid" || data.layoutMode === "spanning_grid"));
    if (spanningMode) {
        const layout = buildSpanningGridLocal(files, BASE_GRID_ASPECT, null, 0, 0, 60, getCompressionPct(), null, scopeFootprints(`folder:${folderPath}`), scopeFlowCells(`folder:${folderPath}`));
        // Flow size only: a file growing (drawn taller) never makes a folder collapse into cards.
        const cW = availW / Math.max(1, layout.flowCols || layout.cols);
        const flowCH = availH / Math.max(1, layout.flowRows || layout.rows);
        return cW < minW || flowCH < minH;
    } else {
        const grid = buildStableGrid(files.length, BASE_GRID_ASPECT);
        const cW = availW / Math.max(1, grid.cols);
        const cH = availH / Math.max(1, grid.rows);
        return cW < minW || cH < minH;
    }
}

const MIN_RENDER_VIEWPORT = 200;

/** Paints a centered hint instead of an unreadable grid when the panel is narrower or shorter than MIN_RENDER_VIEWPORT. */
function drawTooSmall(w, h) {
    ctx.fillStyle = getThemeColor("--vscode-editor-background", "#18181c");
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = getThemeColor("--vscode-descriptionForeground", "#707075");
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Enlarge the panel to show Thumbview", w / 2, h / 2);
    ctx.textAlign = "left";
}

/** Paints the loading/error status screen shown before repository data has arrived. */
function drawStatus() {
    ctx.clearRect(0, 0, getViewportW(), getViewportH());
    ctx.fillStyle = getThemeColor("--vscode-editor-background", "#18181c");
    ctx.fillRect(0, 0, getViewportW(), getViewportH());

    ctx.fillStyle = getThemeColor("--vscode-foreground", "#e1e1e6");
    ctx.font = "16px system-ui";
    ctx.fillText(statusText, 24, 74);

    ctx.fillStyle = getThemeColor("--vscode-descriptionForeground", "#707075");
    ctx.font = "12px system-ui";
    ctx.fillText("Waiting for repository data...", 24, 100);
}

/** Infers a coarse language id from a file path's extension, used to pick a tokenizer. */
// File extensions and names per tokenizer family (tokenizeLine). Unknown extensions fall back to js.
const LANG_BY_EXT = (() => {
    const map = {};
    const add = (lang, exts) => exts.split(" ").forEach(e => { map[e] = lang; });
    add("clike", "go rs java cs c h cpp cc cxx hpp hh hxx kt kts swift scala sc dart m mm zig groovy gradle proto sol cu glsl hlsl frag vert");
    add("php", "php phtml");
    add("hash", "yml yaml sh bash zsh fish ksh rb rake gemspec toml r pl pm ps1 psm1 ex exs nix cmake tf tfvars hcl mk dockerfile containerfile jl cr nim coffee");
    add("dash", "sql lua hs lhs elm purs ada adb ads vhd vhdl");
    add("ml", "ml mli fs fsi fsx");
    add("lisp", "clj cljs cljc edn el lisp lsp scm ss rkt fnl");
    add("percent", "erl hrl tex sty cls bib pro");
    add("vb", "vb vbs bas frm");
    return map;
})();
const JS_EXTS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);
const JSON_RC_FILES = new Set([".babelrc", ".eslintrc", ".prettierrc", ".stylelintrc", ".swcrc", ".jshintrc", ".lintstagedrc", ".nycrc", ".mocharc"]);
const HASH_FILES = new Set(["dockerfile", "containerfile", "makefile", "gnumakefile", "gemfile", "rakefile", "procfile", "vagrantfile", "brewfile", ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile"]);

/** detectLang for a file, cached on it (detection per drawn line cost several ms per folder). */
function fileLang(file) {
    if (file._langPath !== file.path) {
        file._lang = detectLang(file.path);
        file._langPath = file.path;
    }
    return file._lang;
}

/** Picks a tokenizer family for a path by file name, then extension. */
function detectLang(path) {
    if (!path) return 'plaintext';
    const filename = path.split('/').pop().toLowerCase();
    if (filename === '.gitignore' || filename === 'license' || filename.startsWith('license.')) {
        return 'plaintext';
    }
    if (JSON_RC_FILES.has(filename)) return 'json';
    if (HASH_FILES.has(filename) || filename.startsWith('dockerfile.') || filename.endsWith('.dockerfile')) return 'hash';
    // Other dotfiles named *rc (.npmrc, .vimrc, .yarnrc) are ini or their own formats, not JSON.
    if (filename.startsWith('.') && filename.endsWith('rc') && !filename.slice(1).includes('.')) return 'plaintext';
    const ext = filename.includes('.') ? filename.split('.').pop() : '';
    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
    if (!ext || ext === 'txt' || ext === 'log' || ext === 'conf' || ext === 'ini' || ext === 'env') {
        return 'plaintext';
    }
    if (ext === 'css' || ext === 'scss' || ext === 'less') return 'css';
    if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg' || ext === 'vue') return 'html';
    if (ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'map') return 'json';
    if (ext === 'py' || ext === 'pyi') return 'python';
    if (LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
    // Names like package.json.bak or composer.json.tmpl hold JSON; source files that merely mention
    // json in their name (json_utils.py, jsonParser.ts) never get here.
    if (!JS_EXTS.has(ext) && filename.includes('json')) return 'json';
    return 'js';
}

/** Dispatches to a small regex-based tokenizer by detected language family. */
function tokenizeLine(text, lang) {
    if (!text) return [];
    if (lang === 'plaintext') return [{ text, category: 'normal', isKey: false }];
    if (lang === 'markdown') return tokenizeMarkdown(text);
    if (lang === 'css') return tokenizeCSS(text);
    if (lang === 'html') return tokenizeHTML(text);
    if (lang === 'json') return tokenizeJSON(text);
    if (FAMILY_TOKENIZERS[lang]) return tokenizeFamily(text, FAMILY_TOKENIZERS[lang]);
    return tokenizeJS(text, lang);
}

/** Tokenizes a line of JSON into colorable spans, marking string tokens that precede a ':' as object keys. */
function tokenizeJSON(text) {
    const tokens = [];
    const regex = /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*(?:"|$)|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}()\[\]:,]|\s+|.)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const val = match[0];
        let cat = "normal";
        if (val.startsWith("//") || val.startsWith("/*")) {
            cat = "comment";
        } else if (val.startsWith('"')) {
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
        ? /(#.*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|\b(?:class|def|lambda|import|from|as|if|elif|else|for|while|return|try|except|finally|raise|with|yield|pass|break|continue|and|or|not|in|is|True|False|None|self|async|await|global|nonlocal)\b|\b\d+\b|[+\-*\/%=<>!&|^~:@]+|\w+|\s+|.)/g
        : /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|`(?:\\.|[^`\\])*(?:`|$)|\b(?:class|interface|struct|impl|type|enum|function|def|fn|func|const|let|var|this|self|import|export|from|using|require|if|else|elif|for|while|return|switch|case|break|continue|try|catch|finally|public|private|protected|async|await|void|int|float|double|char|string|boolean|bool|any|number|package|module|namespace|new|null|undefined|true|false|typeof|instanceof)\b|\b\d+\b|[+\-*\/%=<>!&|^~:]+|\w+|\s+|.)/g;

    let match;
    const tokens = [];
    while ((match = regex.exec(text)) !== null) {
        const val = match[0];
        let cat = "normal";
        if (val.startsWith("//") || (isPy && val.startsWith("#")) || val.startsWith("/*")) { cat = "comment"; }
        else if (val.startsWith('"') || val.startsWith("'") || val.startsWith("`") ||
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

    return annotateTokens(tokens, isJson);
}

/** Second pass shared by the code tokenizers: property access, calls and declarations, object keys. */
function annotateTokens(tokens, isJson) {
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

const words = list => new Set(list.split(" "));
/**
 * Tokenizer families beyond JS/Python: one regex per family (comments and strings first, so their
 * contents never color as code) plus keyword sets. Comments are `#` (hash), `--` (dash), or C-style.
 */
const FAMILY_TOKENIZERS = {
    clike: {
        regex: /(\/\/.*|\/\*[\s\S]*?(?:\*\/|$)|^\s*#\s*[a-z]+\b.*|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\]){1,2}'|`(?:\\.|[^`\\])*(?:`|$)|\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?[a-zA-Z]*\b|[+\-*\/%=<>!&|^~:?]+|\w+|\s+|.)/g,
        comment: v => v.startsWith("//") || v.startsWith("/*"),
        directive: v => /^\s*#/.test(v),
        control: words("if else for foreach while do return switch case default break continue goto try catch finally throw throws match loop when guard defer select go yield await"),
        keywords: words("class interface struct impl trait enum union type typedef fn func fun function def val var let const mut static final abstract virtual override sealed readonly volatile extern inline unsafe pub public private protected internal package import use using namespace module mod crate extends implements where new delete this self super null nil none true false void int long short float double char bool boolean string byte auto unsigned signed sizeof async chan map range object companion data operator constexpr template typename"),
    },
    php: {
        regex: /(\/\/.*|#(?!\[).*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|<\?php|\?>|\$\w+|\b\d+(?:\.\d+)?\b|[+\-*\/%=<>!&|^~:?.]+|\w+|\s+|.)/g,
        comment: v => v.startsWith("//") || v.startsWith("#") || v.startsWith("/*"),
        directive: v => v === "<?php" || v === "?>",
        variable: v => v.startsWith("$"),
        control: words("if else elseif for foreach while do return switch case default break continue try catch finally throw match yield"),
        keywords: words("class interface trait enum function fn const var public private protected static abstract final readonly namespace use extends implements new echo print require require_once include include_once null true false self parent array callable"),
    },
    hash: {
        regex: /(#.*|"(?:\\.|[^"\\])*(?:"|$)|(?<![\w])'[^']*(?:'|$)|\$\{[^}]*\}?|\$\w+|\b\d+(?:\.\d+)?\b|[+\-*\/%=<>!&|^~:]+|[\w-]+|\s+|.)/g,
        comment: v => v.startsWith("#"),
        variable: v => v.startsWith("$"),
        control: words("if then else elif fi for in do done while until case esac return unless begin rescue ensure yield break next continue and or not when"),
        keywords: words("function local export source alias declare readonly def class module end require require_relative include extend self nil true false yes no null lambda proc attr_reader attr_accessor"),
    },
    ml: {
        regex: /(\(\*[\s\S]*?(?:\*\)|$)|\/\/.*|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\]){1,2}'|\b\d+(?:\.\d+)?\b|[+\-*\/%=<>!&|^~:?.@]+|\w+'*|\s+|.)/g,
        comment: v => v.startsWith("(*") || v.startsWith("//"),
        control: words("if then else elif match with when for while do done to downto try finally raise yield return begin end"),
        keywords: words("let rec in fun function type of module struct sig open val mutable and or not new member static abstract override interface namespace true false null unit"),
    },
    lisp: {
        regex: /(;.*|"(?:\\.|[^"\\])*(?:"|$)|#?\(|\)|\b-?\d+(?:\.\d+)?\b|:[\w\-*?!<>=\/.+]+|[\w\-*?!<>=\/.+]+|\s+|.)/g,
        comment: v => v.startsWith(";"),
        variable: v => v.startsWith(":"),
        control: words("if when unless cond case and or not loop recur do let let* try catch finally throw"),
        keywords: words("defn defn- def defmacro defun defvar defparameter define lambda fn ns require import use quote nil true false t"),
    },
    percent: {
        regex: /(%.*|"(?:\\.|[^"\\])*(?:"|$)|\\[a-zA-Z]+|\b\d+(?:\.\d+)?\b|[+\-*\/=<>!|^~:.]+|\w+|\s+|.)/g,
        comment: v => v.startsWith("%"),
        directive: v => v.startsWith("\\"),
        control: words("if case of receive after when end try catch throw begin"),
        keywords: words("fun module export import record define include spec type true false"),
    },
    vb: {
        regex: /('.*|\bREM\b.*|"(?:""|[^"])*(?:"|$)|\b\d+(?:\.\d+)?\b|[+\-*\/=<>&^\\.]+|\w+|\s+|.)/gi,
        comment: v => v.startsWith("'") || /^rem\b/i.test(v),
        caseInsensitive: true,
        control: words("if then else elseif end for each next while wend do loop until select case return exit try catch finally throw and or not"),
        keywords: words("dim as sub function class module public private protected friend shared static const new set get let property byval byref nothing true false integer string boolean double object imports namespace"),
    },
    dash: {
        regex: /(--.*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|\\.|[^'\\])*(?:'|$)|"(?:\\.|[^"\\])*(?:"|$)|\b\d+(?:\.\d+)?\b|[+\-*\/%=<>!|~^.]+|\w+|\s+|.)/g,
        comment: v => v.startsWith("--") || v.startsWith("/*"),
        caseInsensitive: true,
        control: words("if then else elseif end for while repeat until return break case when and or not in is exists"),
        keywords: words("select from where join left right inner outer full cross on group by order having limit offset insert into values update set delete create alter drop table view index primary key foreign references unique default constraint as distinct union all with begin commit rollback grant revoke null true false local function nil"),
    },
};

/** Tokenizes one line with a FAMILY_TOKENIZERS entry, then runs the shared annotateTokens pass. */
function tokenizeFamily(text, family) {
    const tokens = [];
    family.regex.lastIndex = 0;
    let match;
    while ((match = family.regex.exec(text)) !== null) {
        const val = match[0];
        const word = family.caseInsensitive ? val.toLowerCase() : val;
        let cat = "normal";
        if (family.comment(val)) cat = "comment";
        else if (family.directive && family.directive(val)) cat = "keyword";
        // A lone quote (a Rust lifetime, an apostrophe in YAML or shell text) is not a string.
        else if ((val[0] === '"' || val[0] === "'" || val[0] === "`") && val.length > 1) cat = "string";
        else if (family.variable && family.variable(val)) cat = "variable";
        else if (/^\d/.test(val)) cat = "number";
        else if (family.control.has(word)) cat = "control-flow";
        else if (family.keywords.has(word)) cat = "keyword";
        else if (/^[+\-*\/%=<>!&|^~:?.]+$/.test(val)) cat = "operator";
        else if (/^[\w-]+$/.test(val)) cat = /^[A-Z]/.test(val) ? "type" : "variable";
        tokens.push({ text: val, category: cat, isKey: false });
    }
    return annotateTokens(tokens, false);
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
const THUMBNAIL_TARGET_READABLE_CHARS = 80;
const THUMBNAIL_MIN_TARGET_CHARS = 20;
const THUMBNAIL_DEFAULT_TARGET_CHARS = 50;
const THUMBNAIL_SAMPLE_LINE_LIMIT = 50;
const THUMBNAIL_WIDTH_BUDGET_FACTOR = 0.95;
const THUMBNAIL_CHAR_ASPECT_RATIO = 0.58;
const THUMBNAIL_LINE_HEIGHT_RATIO = 0.88;
const THUMBNAIL_MAX_FONT_SIZE = 13;
const THUMBNAIL_MIN_FONT_SIZE = 3.2;
const THUMBNAIL_MIN_TEXT_PITCH = 1.5;
const THUMBNAIL_MIN_READABLE_FONT_SIZE = 8.0;
const THUMBNAIL_MIN_READABLE_TEXT_PITCH = 8.0;
const THUMBNAIL_MIN_READABLE_WIDTH = 45;

const monospaceCharWidthCache = new Map();
function getMonospaceCharWidth(fontSize) {
    const quantized = Math.round(fontSize * 10) / 10;
    let w = monospaceCharWidthCache.get(quantized);
    if (w === undefined) {
        ctx.save();
        ctx.font = `${quantized}px Consolas, "Courier New", monospace`;
        w = ctx.measureText("M").width || (quantized * THUMBNAIL_CHAR_ASPECT_RATIO);
        ctx.restore();
        monospaceCharWidthCache.set(quantized, w);
    }
    return w;
}
const THUMBNAIL_INDENT_MAX_RATIO = 0.4;
const THUMBNAIL_LINE_WIDTH_RATIO = 0.7;
const THUMBNAIL_TEXT_VERTICAL_RATIO = 0.85;
const THUMBNAIL_TEXT_FONT_RATIO = 0.95;
const THUMBNAIL_BLOCK_MIN_HEIGHT = 0.7;
const THUMBNAIL_SEARCH_MATCH_HEIGHT = 3.5;
const THUMBNAIL_SEARCH_GUTTER_WIDTH = 3.5;
const THUMBNAIL_SEARCH_RULER_WIDTH = 4.0;
const THUMBNAIL_GIT_LINE_MIN_HEIGHT = 1.5;
const THUMBNAIL_GIT_GUTTER_WIDTH = 2.5;
const THUMBNAIL_GIT_DELETED_HEIGHT = 2.0;
const THUMBNAIL_VIEWPORT_MIN_HEIGHT = 4.0;

// Filled from the theme by applyDecorationThemeColors (the editor's own gutter and error colors, so
// tiles match the editor, light, and high-contrast themes); these literals are only fallbacks.
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

/** Re-reads git and error decoration colors from the theme into GIT_STYLES and ERROR_STYLES (in place). */
function applyDecorationThemeColors() {
    const modified = getThemeColor("--vscode-editorGutter-modifiedBackground", "#3b82f6");
    const added = getThemeColor("--vscode-editorGutter-addedBackground", "#22c55e");
    const deleted = getThemeColor("--vscode-editorGutter-deletedBackground", "#ef4444");
    const error = getThemeColor("--vscode-editorError-foreground", "#ef4444");
    Object.assign(GIT_STYLES, {
        modifiedBg: withAlpha(modified, 0.14),
        modifiedGutter: withAlpha(modified, 0.75),
        addedBg: withAlpha(added, 0.14),
        addedGutter: withAlpha(added, 0.75),
        deletedLine: withAlpha(deleted, 0.85),
        badgeModified: modified,
        badgeAdded: added
    });
    Object.assign(ERROR_STYLES, {
        errorBg: withAlpha(error, 0.22),
        errorGutter: withAlpha(error, 0.85),
        badgeError: error
    });
}

const THEME_COLORS = {
    tileBackground: getThemeColor("--vscode-editor-background", "#1e1e24"),
    imageTileBackground: getThemeColor("--vscode-editorWidget-background", "#252526"),
    imageTilePlaceholderText: getThemeColor("--vscode-descriptionForeground", "#858585"),
    pdfHeaderBar: getThemeColor("--vscode-badge-background", "#4d4d4d"),
    pdfHeaderForeground: getThemeColor("--vscode-badge-foreground", "#ffffff"),
    pdfPlaceholderLine: getThemeColor("--vscode-widget-border", "rgba(255, 255, 255, 0.25)"),
    searchMatchHighlight: withAlpha(ACCENT_SEARCH, 0.48),
    activeFocusHighlight: getThemeColor("--vscode-focusBorder", "#007fd4"),
    viewportBandOverlay: "rgba(255, 255, 255, 0.08)",
};

applyDecorationThemeColors();

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
// pdf.js is optional and about 1.7 MB with its worker, so it never runs on the first-open path. It
// loads after the first reveal, once streamed text has arrived, when the page is idle; hovering a
// PDF or drilling into a folder may start it sooner, still after the reveal. Until then PDF tiles
// show their placeholder. Both files are ES modules (media/pdfjs/, pdf.js 6), loaded as nonce'd
// module scripts.
function textStreamPending() {
    return !!pendingDataMsg || !!(data && data.files && data.files.some(f => f._linesPending));
}
/** A PDF tile was drawn (urgent: the user hovered a PDF or drilled into a folder). */
function requestPdfJs(urgent) {
    if (!window.PDF_JS_URI || pdfJsState === "ready" || pdfJsState === "failed") return;
    if (urgent) pdfJsUrgent = true;
    if (pdfJsState === "idle") pdfJsState = "wanted";
    maybeStartPdfJs();
}
/** Called whenever a condition may have cleared: a PDF was drawn, the first reveal, a text chunk. */
const PDF_STREAM_WAIT_MAX_MS = 3000;
let pdfStreamWaitTimer = null;
function maybeStartPdfJs() {
    if (pdfJsState !== "wanted" || !hasRevealedOnce) return;
    if (!pdfJsUrgent && textStreamPending()) {
        // The text stream normally ends within a second or two; a file whose text never arrives
        // must not keep PDF previews from ever loading.
        if (!pdfStreamWaitTimer) {
            pdfStreamWaitTimer = setTimeout(() => {
                pdfJsUrgent = true;
                maybeStartPdfJs();
            }, PDF_STREAM_WAIT_MAX_MS);
        }
        return;
    }
    pdfJsState = "scheduled";
    whenIdle(loadPdfJs);
}
/** The idle callback loadPdfJs and the PDF page queue use, with a timer fallback. */
function whenIdle(callback) {
    if (typeof requestIdleCallback === "function") requestIdleCallback(callback, { timeout: 2000 });
    else setTimeout(callback, 200);
}
// First pages render one at a time, each in an idle slot: the page's own share (loading, drawing the
// canvas, encoding the snapshot) stays small, and so does parsing when the worker fell back to this thread.
let pdfPageQueue = Promise.resolve();
function queuePdfFirstPage(mediaUri) {
    pdfPageQueue = pdfPageQueue.then(() => new Promise(resolve => whenIdle(resolve))).then(() => {
        // pdf.js 6 never compiles code at runtime (the webview CSP has no 'unsafe-eval' either). No
        // wasmUrl: WebAssembly would need 'wasm-unsafe-eval', so JPEG 2000 images inside a PDF are skipped.
        const loadingTask = pdfjsLib.getDocument({ url: mediaUri, withCredentials: false });
        return loadingTask.promise.then(pdf => pdf.getPage(1)).then(page => {
            const viewport = page.getViewport({ scale: 0.5 });
            const pdfCanvas = document.createElement("canvas");
            pdfCanvas.width = viewport.width;
            pdfCanvas.height = viewport.height;
            return page.render({ canvasContext: pdfCanvas.getContext("2d"), viewport }).promise.then(() => {
                const img = new Image();
                img.onload = () => {
                    imageCache[mediaUri] = img;
                    scheduleRender();
                };
                img.onerror = () => {
                    imageCache[mediaUri] = "error";
                };
                img.src = pdfCanvas.toDataURL("image/jpeg", 0.7);
            });
        });
    }).catch(err => {
        console.error("PDF RENDER ERROR:", err);
        reportPdf("warn", `page 1 could not be rendered: ${err && err.message ? err.message : err}`);
        imageCache[mediaUri] = "error";
    });
}

const PDF_WORKER_START_TIMEOUT_MS = 3000;
/**
 * Reports a PDF preview stage to the Thumbview output channel (extension.ts "pdfStatus"
 * { level: "info" | "warn", text }), so a missing preview comes with its reason in user reports.
 */
function reportPdf(level, text) {
    const message = text instanceof Error ? text.message : (text && text.type ? `${text.type} event` : String(text));
    vscode.postMessage({ command: "pdfStatus", level, text: message.slice(0, 300) });
}
/**
 * Starts pdf.js's worker off this thread. A webview cannot start a Worker from a resource URL (another
 * origin), but it can from a blob: URL (CSP worker-src blob:) holding the fetched source. pdf.js does
 * not check that a supplied port works, so this waits for the worker's own "ready" message; it
 * rejects on an error or silence, and loadPdfJs falls back to running the worker on this thread.
 */
function startPdfWorker() {
    return fetch(window.PDF_WORKER_URI).then(response => {
        if (!response.ok) throw new Error(`pdf.js worker: HTTP ${response.status}`);
        return response.text();
    }).then(source => new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(url, { type: "module" });
        const fail = err => {
            clearTimeout(timer);
            worker.terminate();
            URL.revokeObjectURL(url);
            reject(err);
        };
        const timer = setTimeout(() => fail(new Error("pdf.js worker did not start")), PDF_WORKER_START_TIMEOUT_MS);
        worker.addEventListener("error", fail, { once: true });
        worker.addEventListener("message", () => {
            clearTimeout(timer);
            worker.removeEventListener("error", fail);
            resolve(worker);
        }, { once: true });
    }));
}
function loadPdfJs() {
    pdfJsState = "loading";
    const loadModule = src => new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.type = "module";
        // The CSP allows only nonce'd scripts (no script-src host), so this one needs it too.
        if (window.PDF_JS_NONCE) script.nonce = window.PDF_JS_NONCE;
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
    loadModule(window.PDF_JS_URI)
        .then(() => startPdfWorker().catch(err => {
            console.warn("Thumbview: PDF previews render on the page's thread:", err);
            reportPdf("warn", `worker did not start (${err && err.message ? err.message : err && err.type ? `${err.type} event` : err}); rendering on the page's thread`);
            return null;
        }))
        .then(worker => {
            if (worker) {
                pdfjsLib.GlobalWorkerOptions.workerPort = worker;
                return;
            }
            // Fallback: the worker module defines globalThis.pdfjsWorker, which pdf.js then runs on
            // this thread (its own fallback imports the worker without the nonce, which the CSP blocks).
            pdfjsLib.GlobalWorkerOptions.workerSrc = window.PDF_WORKER_URI;
            return window.pdfjsWorker ? undefined : loadModule(window.PDF_WORKER_URI);
        })
        .then(() => {
            pdfJsState = "ready";
            reportPdf("info", `pdf.js ${pdfjsLib.version || ""} loaded (${pdfjsLib.GlobalWorkerOptions.workerPort ? "worker thread" : "page thread"})`);
            scheduleRender();
        })
        .catch(err => {
            pdfJsState = "failed";
            reportPdf("warn", `pdf.js could not load: ${err && err.message ? err.message : err && err.type ? `${err.type} event (script blocked or missing)` : err}`);
        });
}

/** True when sampled line i of the file (or any full line it stands for) matches the current search. */
function sampledLineMatches(file, lines, i) {
    const line = lines[i];
    const lineText = line?.text || "";
    if (!rawSearchQuery || searchInvalid || !lineText) return false;
    if (file.fullLines && file.lineCount > lines.length) {
        const step = file.lineCount / lines.length;
        const startLineIdx = Math.floor(i * step);
        const endLineIdx = Math.min(Math.floor((i + 1) * step), file.fullLines.length);
        for (let fullI = startLineIdx; fullI < endLineIdx; fullI++) {
            const orig = file.fullLines[fullI];
            const lower = lowerFullLines(file)[fullI];
            if (textMatches(orig, lower)) return true;
        }
        return false;
    }
    return textMatches(lineText, lowerLineText(line));
}

/** Indices of the file's sampled lines that match the current search, memoized per search state. */
function matchedLineIndices(file) {
    if (file._matchedLinesGen === searchGeneration) return file._matchedLines;
    const lines = file.lines || [];
    const result = [];
    if (fileMatchesSearch(file)) {
        for (let i = 0; i < lines.length; i++) {
            if (sampledLineMatches(file, lines, i)) result.push(i);
        }
    }
    file._matchedLinesGen = searchGeneration;
    file._matchedLines = result;
    return result;
}

/**
 * Resolves search match targets for a file as exact real line numbers and sampled visual line indices.
 * Memoized per search generation and fullLines state.
 */
function getSearchTargetsForFile(file) {
    if (!rawSearchQuery || searchInvalid || !file || !fileMatchesSearch(file)) return [];
    const hasFullLines = !!(file.fullLines && file.fullLines.length > 0);
    if (file._searchTargetsGen === searchGeneration && file._searchTargets && file._searchTargetsHasFullLines === hasFullLines) {
        return file._searchTargets;
    }
    const lines = file.lines || [];
    if (lines.length === 0) return [];
    const sampledIndices = matchedLineIndices(file);
    if (sampledIndices.length === 0) return [];

    const isSampled = !!(file.lineCount && file.lineCount > lines.length);
    const targets = [];
    const seenLines = new Set();

    if (isSampled && hasFullLines) {
        const step = file.lineCount / lines.length;
        const lower = lowerFullLines(file);
        for (const s of sampledIndices) {
            const startLineIdx = Math.floor(s * step);
            const endLineIdx = Math.min(Math.floor((s + 1) * step), file.fullLines.length);
            for (let fullI = startLineIdx; fullI < endLineIdx; fullI++) {
                const orig = file.fullLines[fullI];
                const low = lower ? lower[fullI] : (orig ? orig.toLowerCase() : "");
                if (textMatches(orig, low)) {
                    if (!seenLines.has(fullI)) {
                        seenLines.add(fullI);
                        targets.push({
                            fileUri: file.uri,
                            sampledIdx: s,
                            realLineIdx: fullI
                        });
                    }
                }
            }
        }
    } else {
        const stride = isSampled ? file.lineCount / lines.length : 1;
        for (const s of sampledIndices) {
            const realLineIdx = isSampled
                ? Math.max(0, Math.min(file.lineCount - 1, Math.floor(s * stride)))
                : s;
            if (!seenLines.has(realLineIdx)) {
                seenLines.add(realLineIdx);
                targets.push({
                    fileUri: file.uri,
                    sampledIdx: s,
                    realLineIdx
                });
            }
        }
    }

    file._searchTargetsGen = searchGeneration;
    file._searchTargetsHasFullLines = hasFullLines;
    file._searchTargets = targets;
    return targets;
}

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
                    queuePdfFirstPage(file.mediaUri);
                } else {
                    requestPdfJs(false);
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

    /**
     * Search highlights drawn on the main canvas over a cached tile raster, so rasters stay valid while
     * the query changes (one keystroke used to re-rasterize every visible tile). The translucent band goes
     * over the raster, so a match still reads as a match on a line that also has a git or error
     * background (drawn under it, it was blended into those), then the solid gutter mark.
     */
    function drawSearchLineBands(file, x, y, w, h, stepY) {
        const indices = matchedLineIndices(file);
        if (indices.length === 0) return;
        const bandH = Math.max(stepY, THUMBNAIL_SEARCH_MATCH_HEIGHT);
        const rightX = x + w - THUMBNAIL_SEARCH_RULER_WIDTH;

        // Translucent highlight band across the code thumbnail
        ctx.fillStyle = THEME_COLORS.searchMatchHighlight;
        for (const i of indices) {
            const top = y + i * stepY;
            if (top >= y + h) break;
            ctx.fillRect(x, top, w, Math.min(bandH, y + h - top));
        }

        // High-contrast solid markers: left gutter mark and right-edge overview ruler tick
        ctx.fillStyle = ACCENT_SEARCH;
        for (const i of indices) {
            const top = y + i * stepY;
            if (top >= y + h) break;
            const curH = Math.min(bandH, y + h - top);
            ctx.fillRect(x, top, THUMBNAIL_SEARCH_GUTTER_WIDTH, curH);
            ctx.fillRect(rightX, top, THUMBNAIL_SEARCH_RULER_WIDTH, curH);
        }
    }

    function renderFileThumbnailContent(targetCtx, file, originX, originY, w, h, useText, fontSize, stepY, bakeSearch = true) {
        const lines = file.lines || [];
        const maxLineChars = THUMBNAIL_MAX_LINE_CHARS;

        if (useText) {
            targetCtx.font = `${fontSize}px Consolas, "Courier New", monospace`;
        }

        const charWidth = useText ? getMonospaceCharWidth(fontSize) : 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineText = line?.text || "";

            const isMatchedLine = bakeSearch && sampledLineMatches(file, lines, i);

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

            let gitType = (file.gitStatus === "untracked" || file.gitStatus === "added")
                ? "added"
                : undefined;
            if (!gitType && file.gitChanges) {
                if (file.lineCount && file.lineCount > lines.length) {
                    const step = file.lineCount / lines.length;
                    const startLineIdx = Math.floor(i * step);
                    const endLineIdx = Math.max(startLineIdx + 1, Math.min(Math.floor((i + 1) * step), file.lineCount));
                    for (let fullI = startLineIdx; fullI < endLineIdx; fullI++) {
                        if (file.gitChanges[fullI]) {
                            gitType = file.gitChanges[fullI];
                            break;
                        }
                    }
                } else {
                    gitType = file.gitChanges[i];
                }
            }

            if (isMatchedLine) {
                targetCtx.fillStyle = THEME_COLORS.searchMatchHighlight;
                targetCtx.fillRect(
                    originX,
                    originY + i * stepY,
                    w,
                    Math.max(stepY, THUMBNAIL_SEARCH_MATCH_HEIGHT)
                );
                targetCtx.fillStyle = ACCENT_SEARCH;
                targetCtx.fillRect(
                    originX,
                    originY + i * stepY,
                    THUMBNAIL_SEARCH_GUTTER_WIDTH,
                    Math.max(stepY, THUMBNAIL_SEARCH_MATCH_HEIGHT)
                );
                targetCtx.fillRect(
                    originX + w - THUMBNAIL_SEARCH_RULER_WIDTH,
                    originY + i * stepY,
                    THUMBNAIL_SEARCH_RULER_WIDTH,
                    Math.max(stepY, THUMBNAIL_SEARCH_MATCH_HEIGHT)
                );
            } else if (isErrorLine) {
                targetCtx.fillStyle = ERROR_STYLES.errorBg;
                targetCtx.fillRect(originX, originY + i * stepY, w, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
                targetCtx.fillStyle = ERROR_STYLES.errorGutter;
                targetCtx.fillRect(originX, originY + i * stepY, THUMBNAIL_GIT_GUTTER_WIDTH, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
            } else if (gitType === "modified") {
                targetCtx.fillStyle = GIT_STYLES.modifiedBg;
                targetCtx.fillRect(originX, originY + i * stepY, w, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
                targetCtx.fillStyle = GIT_STYLES.modifiedGutter;
                targetCtx.fillRect(originX, originY + i * stepY, THUMBNAIL_GIT_GUTTER_WIDTH, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
            } else if (gitType === "added") {
                targetCtx.fillStyle = GIT_STYLES.addedBg;
                targetCtx.fillRect(originX, originY + i * stepY, w, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
                targetCtx.fillStyle = GIT_STYLES.addedGutter;
                targetCtx.fillRect(originX, originY + i * stepY, THUMBNAIL_GIT_GUTTER_WIDTH, Math.max(stepY, THUMBNAIL_GIT_LINE_MIN_HEIGHT));
            } else if (gitType === "removed") {
                targetCtx.fillStyle = GIT_STYLES.deletedLine;
                const triY = originY + i * stepY;
                const triH = Math.max(stepY, 3);
                const triW = THUMBNAIL_GIT_GUTTER_WIDTH + 1.5;
                targetCtx.beginPath();
                targetCtx.moveTo(originX, triY);
                targetCtx.lineTo(originX + triW, triY + triH / 2);
                targetCtx.lineTo(originX, triY + triH);
                targetCtx.closePath();
                targetCtx.fill();
            }

            if (!line || !lineText) {
                continue;
            }

            const indent = lineShape(line).indent || 0;
            const startX = originX + (useText ? Math.min(indent * charWidth, w * THUMBNAIL_INDENT_MAX_RATIO) : Math.min(indent / maxLineChars, THUMBNAIL_INDENT_MAX_RATIO) * w);
            const trimmedText = lineText.trimStart();
            const lineTextLength = trimmedText.length;
            if (lineTextLength === 0) {
                continue;
            }

            const lineW = Math.min(lineTextLength / maxLineChars, 1.0) * w * THUMBNAIL_LINE_WIDTH_RATIO;
            const tokens = line._tokens || (line._tokens = tokenizeLine(trimmedText, fileLang(file)));
            const totalTextChars = Math.max(lineTextLength, 1);

            let currentX = startX;
            for (const tok of tokens) {
                if (currentX >= originX + w) break;

                targetCtx.fillStyle = colorForCategory(tok.category, tok.isKey);
                if (useText) {
                    targetCtx.fillText(tok.text, currentX, originY + i * stepY + Math.min(stepY * THUMBNAIL_TEXT_VERTICAL_RATIO, fontSize * THUMBNAIL_TEXT_FONT_RATIO));
                    currentX += tok.text.length * charWidth;
                } else {
                    const tokLen = tok.text.length;
                    const tokW = (tokLen / totalTextChars) * lineW;

                    targetCtx.fillRect(
                        currentX,
                        originY + i * stepY,
                        Math.min(tokW, originX + w - currentX),
                        Math.max(stepY, THUMBNAIL_BLOCK_MIN_HEIGHT)
                    );
                    currentX += tokW;
                }
            }
        }
    }

    const lines = file.lines || [];
    const lineCount = Math.max(lines.length, 1);
    const stepY = Math.min(h / lineCount, THUMBNAIL_MAX_LINE_PITCH);

    const targetLineChars = Math.min(THUMBNAIL_TARGET_READABLE_CHARS, Math.max(THUMBNAIL_MIN_TARGET_CHARS, file._avgLineChars || THUMBNAIL_DEFAULT_TARGET_CHARS));
    const fontForWidth = (w * THUMBNAIL_WIDTH_BUDGET_FACTOR) / (targetLineChars * THUMBNAIL_CHAR_ASPECT_RATIO);
    const fontForHeight = stepY * THUMBNAIL_LINE_HEIGHT_RATIO;
    const rawFontSize = Math.min(fontForHeight, fontForWidth, THUMBNAIL_MAX_FONT_SIZE);
    const fontSize = Math.max(THUMBNAIL_MIN_FONT_SIZE, Math.floor(rawFontSize * 10) / 10);
    const useText = fontSize >= THUMBNAIL_MIN_READABLE_FONT_SIZE && stepY >= THUMBNAIL_MIN_READABLE_TEXT_PITCH && w >= THUMBNAIL_MIN_READABLE_WIDTH;

    const intW = Math.round(w);
    const intH = Math.round(h);
    const useRasterCache = intW >= 30 && intH >= 30;
    // Rasterize at device pixels so tiles stay sharp on HiDPI screens; CanvasLRU budgets real pixels.
    const rasterDpr = Math.min(window.devicePixelRatio || 1, 2);
    // Content and decorations, without size: lastTileRaster stands in across sizes for the same content.
    const tileContentSig = `${file.contentVersion}${file._linesPending ? "p" : ""}:${file._decoSig}`;
    const tileKey = useRasterCache ? `${file.id}:${intW}:${intH}:${rasterDpr}:${tileContentSig}` : null;
    // Rasters never include search highlights (see drawSearchLineBands); the query is not in the key.
    const searchBands = useRasterCache && rawSearchQuery && !searchInvalid;

    let cached = tileKey ? tileRasterCache.get(tileKey) : null;
    if (cached) {
        ctx.drawImage(cached, x, y, intW, intH);
    } else if (useRasterCache && performance.now() > rasterBudgetEndsAt) {
        // Over this frame's budget (render): the file's last raster of the same content scaled to
        // the new size (a resize), else a cheap outline of its code (a folder never drawn at this
        // size); the real raster follows on a later frame, so nothing waits for every tile.
        const previous = lastTileRaster.get(file.id);
        if (previous && previous.sig === tileContentSig && previous.canvas.width > 0) {
            ctx.drawImage(previous.canvas, x, y, intW, intH);
        } else {
            drawTilePlaceholder(file, x, y, w, h, stepY);
        }
        rasterDeferred = true;
    } else {
        let offscreen = null;
        let offCtx = null;
        if (useRasterCache) {
            try {
                offscreen = document.createElement("canvas");
                offscreen.width = Math.round(intW * rasterDpr);
                offscreen.height = Math.round(intH * rasterDpr);
                offCtx = offscreen.getContext("2d");
                offCtx.setTransform(rasterDpr, 0, 0, rasterDpr, 0, 0);
            } catch (e) {
                offscreen = null;
                offCtx = null;
            }
        }

        const targetCtx = offCtx || ctx;
        const originX = offCtx ? 0 : x;
        const originY = offCtx ? 0 : y;

        // With bands drawn over it, highlights are never baked in (also when the raster allocation
        // failed and lines go straight to the main canvas).
        renderFileThumbnailContent(targetCtx, file, originX, originY, w, h, useText, fontSize, stepY, !searchBands);

        if (offscreen && offCtx) {
            tileRasterCache.set(tileKey, offscreen);
            lastTileRaster.set(file.id, { canvas: offscreen, sig: tileContentSig });
            ctx.drawImage(offscreen, x, y, intW, intH);
        }
    }
    if (searchBands) drawSearchLineBands(file, x, y, w, h, stepY);

    // Highlight editor visible viewport range in transparent gray overlay if file is open
    const isFileOpen = openFilesSet.has(file.uri);
    if (isFileOpen && (file.uri in viewLocations)) {
        const totalRealLines = Math.max(file.lineCount || lines.length, 1);
        const viewLoc = viewLocations[file.uri];
        const startL = Math.max(0, Math.min(viewLoc.startLine, totalRealLines - 1));
        const endL = Math.max(startL, Math.min(viewLoc.endLine, totalRealLines - 1));

        const startRatio = startL / totalRealLines;
        const endRatio = (endL + 1) / totalRealLines;

        const thumbnailY = y;
        const thumbnailH = h;
        const contentH = Math.min(thumbnailH, lines.length * stepY);

        const bandY = thumbnailY + startRatio * contentH;
        const bandH = Math.max((endRatio - startRatio) * contentH, THUMBNAIL_VIEWPORT_MIN_HEIGHT);

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
            Math.min(bandH, thumbnailY + contentH - bandY)
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
const GIT_STATUS_LETTER = { modified: "M", added: "A", untracked: "U", deleted: "D" };

/** Explorer-style status text for a tile, e.g. "2, M": error count then git letter. Empty when clean. */
function tileStatusBadge(file) {
    const parts = [];
    if (file.errorCount > 0) parts.push(String(file.errorCount));
    if (file.gitStatus && GIT_STATUS_LETTER[file.gitStatus]) parts.push(GIT_STATUS_LETTER[file.gitStatus]);
    return parts.join(", ");
}

function drawFileTile(file, x, y, w, h, dimForFocus) {
    file._cell = { x, y, w, h };

    const queryActive = !!searchQuery && !searchInvalid;
    const isSearchMatch = queryActive && fileMatchesSearch(file);
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

    // Status as text, not only color (like the Explorer): error count and git letter.
    const badge = tileStatusBadge(file);
    const badgeW = badge ? ctx.measureText(badge).width + 6 : 0;
    const labelRight = isOpen ? (w - TILE_LABEL_WIDTH_MARGIN) : (w - 16);
    const maxLabelWidth = labelRight - badgeW;
    if (file._lastCellW !== w || file._lastBadge !== badge || !file._fittedLabel) {
        file._lastCellW = w;
        file._lastBadge = badge;
        file._fittedLabel = fitPathText(file.path, maxLabelWidth);
    }
    ctx.fillText(file._fittedLabel, x + TILE_LABEL_OFFSET_X, y + TILE_LABEL_OFFSET_Y);
    if (badge && maxLabelWidth > 20) {
        ctx.fillText(badge, x + TILE_LABEL_OFFSET_X + labelRight - badgeW + 6, y + TILE_LABEL_OFFSET_Y);
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

function sameOrder(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if ((a[i] || "") !== (b[i] || "")) return false;
    }
    return true;
}

/** Spanning cell count for a file, matching buildSpanningGridLocal's allocation. */
function spanningCellsForFile(f) {
    if (!f) return 1;
    return f.lineCount ? cellsNeeded(f.lineCount, 60, getCompressionPct()) : (f.nCells || 1);
}

/**
 * Mirrors a reconciled layout order (and any new footprints) into `data` and asks the host to
 * persist it (extension.ts "saveLayoutOrder": { scope: "folderFiles" | "folderCards" |
 * "rootCards", folder, ids, footprints, wrapRows, flowCells }).
 */
function requestLayoutOrderSave(scope, folder, ids, footprints = {}, wrapRows = null, flowCells = {}) {
    if (!data) return;
    if (Object.keys(flowCells).length > 0) {
        const flowKey = scope === "folderFiles" ? `folder:${folder}` : `cards:${scope === "folderCards" ? folder : ""}`;
        if (!data.slotFlowCells) data.slotFlowCells = {};
        data.slotFlowCells[flowKey] = { ...(data.slotFlowCells[flowKey] || {}), ...flowCells };
    }
    if (typeof wrapRows === "number") {
        if (scope === "rootCards") {
            data.cardWrapRows = wrapRows;
        } else {
            const wrapKey = scope === "folderCards" ? "folderCardWrapRows" : "folderWrapRows";
            if (!data[wrapKey]) data[wrapKey] = {};
            data[wrapKey][folder] = wrapRows;
        }
    }
    if (Object.keys(footprints).length > 0) {
        const scopeKey = scope === "folderFiles" ? `folder:${folder}` : `cards:${scope === "folderCards" ? folder : ""}`;
        if (!data.slotFootprints) data.slotFootprints = {};
        data.slotFootprints[scopeKey] = { ...(data.slotFootprints[scopeKey] || {}), ...footprints };
    }
    if (scope === "rootCards") {
        data.cardOrder = [...ids];
    } else {
        const key = scope === "folderCards" ? "folderCardOrders" : "folderOrders";
        if (!data[key]) data[key] = {};
        data[key][folder] = [...ids];
    }
    vscode.postMessage({ command: "saveLayoutOrder", scope, folder, ids: [...ids], footprints, wrapRows, flowCells });
}

/**
 * Flow cells to freeze for live items that have none yet in a scope: their current display
 * height. Once frozen, later growth only changes display height, never column membership.
 */
function missingFlowCells(liveIds, cellsOf, footprints, frozen) {
    const out = {};
    for (const id of liveIds) {
        if (frozen && frozen[id]) continue;
        out[id] = Math.max(cellsOf(id), (footprints && footprints[id]) || 0);
    }
    return out;
}

/**
 * Cell counts for simulating a spanning drag in a layout scope: frozen flow cells (what decides
 * columns in the real layout), including holes in `order`. Using display heights here made the
 * optimistic drop and the host's next layout disagree, and could move files between columns.
 */
function dragFlowAllocations(scopeKey, items, order) {
    const frozen = scopeFlowCells(scopeKey) || {};
    const fp = scopeFootprints(scopeKey);
    const allocations = {};
    for (const it of items) {
        if (!it) continue;
        allocations[it.id] = it.type === "folder"
            ? 1
            : (frozen[it.id] || Math.max(spanningCellsForFile(it.file), (fp && fp[it.id]) || 0));
    }
    for (const id of order || []) {
        if (id && allocations[id] === undefined) {
            allocations[id] = spanningHoleCells(id, fp, frozen);
        }
    }
    return allocations;
}

/** Spanning layout items for card mode (folder cards are one cell). */
function cardLayoutItems(items) {
    return items.filter(Boolean).map(it => {
        if (it.type === "folder") {
            return { id: it.id, type: "folder", item: it, card: it.card, nCells: 1 };
        }
        const f = it.file;
        const nCells = (f.nCells && f.nCells > 1) ? f.nCells : (f.lineCount ? cellsNeeded(f.lineCount, 60, getCompressionPct()) : (f.nCells || 1));
        return { id: it.id, type: "file", item: it, file: f, lineCount: f.lineCount, nCells };
    });
}

/**
 * Keeps a drill-down folder's file order spatially stable. The first view saves the order on
 * screen; later views fill holes left by ignored/deleted files with new files (height-aware in
 * spanning mode) instead of letting later files shift. The webview owns this because only it
 * knows folder layouts; the host just stores the result.
 */
function reconcileFolderFileOrder(folder, files, spanning) {
    const saved = data.folderOrders && data.folderOrders[folder];
    const liveIds = files.map(f => f.id);
    const fp = scopeFootprints(`folder:${folder}`);
    const flow = scopeFlowCells(`folder:${folder}`);
    const onScreen = (!saved || saved.length === 0) ? liveIds : saved;
    const { order: next, footprints } = (!saved || saved.length === 0)
        ? { order: liveIds, footprints: {} }
        : fillLayoutHoles(saved, liveIds,
            spanning ? (id => spanningCellsForFile(fileById.get(id))) : undefined,
            spanning ? (id => spanningHoleCells(id, fp, flow)) : undefined);
    const newFlow = spanning
        ? missingFlowCells(liveIds, id => spanningCellsForFile(fileById.get(id)), { ...(fp || {}), ...footprints }, flow)
        : {};
    // Freeze the column height the user is looking at: otherwise appending files recomputes it
    // and every column re-wraps. The root grid does the same with thumbview.spanningRows.
    const savedWrap = data.folderWrapRows && data.folderWrapRows[folder];
    const wrapRows = spanning && !savedWrap
        ? buildSpanningGridLocal(files, BASE_GRID_ASPECT, onScreen, 0, 0, 60, getCompressionPct(), null, fp, flow).wrapRows
        : null;
    if (!sameOrder(saved, next) || wrapRows || Object.keys(newFlow).length > 0) {
        requestLayoutOrderSave("folderFiles", folder, next, footprints, wrapRows, newFlow);
    }
}

// MARK: render
/** Redraws the whole canvas for the current data/filter/search/drag state — clears, computes grid geometry, then dispatches to one of three per-tile rendering modes (subfolder cards, folder drill-down, or the normal root grid). */
function render() {
    rasterDeferred = false;
    rasterBudgetEndsAt = revealPending ? Infinity : performance.now() + RASTER_FRAME_BUDGET_MS;
    renderScene();
    rasterBudgetEndsAt = Infinity;
    drawKeyboardFocus();
    updateHoverOutline(true);
    if (rasterDeferred) scheduleRender();
}

/** A tile whose raster waits for a later frame: one bar per visible line (indent and length), no text. */
function drawTilePlaceholder(file, x, y, w, h, stepY) {
    const lines = file.lines || [];
    const pitch = Math.max(2, stepY || 4);
    const count = Math.min(lines.length, Math.floor(h / pitch));
    const charW = w / 100;
    ctx.save();
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < count; i++) {
        const shape = lineShape(lines[i]);
        if (!shape.length) continue;
        const indent = Math.min(shape.indent || 0, 40);
        ctx.fillStyle = colorForCategory(shape.category || "normal", false);
        ctx.fillRect(x + 2 + indent * charW, y + i * pitch + pitch * 0.25, Math.max(1, Math.min(w - 4, (shape.length - indent) * charW)), Math.max(1, pitch * 0.5));
    }
    ctx.restore();
}

function renderScene() {
    if (!ctx || isFrameFrozen()) {
        // Frozen: keep the last shown frame for the fast reopen path (tryFastReveal). The block
        // lifts on reveal or showAfterTransition, which schedule a fresh render.
        return;
    }

    const rectW = getViewportW();
    const rectH = getViewportH();

    if (!revealPending) {
        // The size of the frame the user is looking at; the fast reopen path compares against it.
        lastRevealedW = rectW;
        lastRevealedH = rectH;
    }

    if (document.hidden || document.visibilityState === "hidden" || rectW < 1 || rectH < 1) {
        // Tab container is backgrounded or collapsed. The ResizeObserver and visibilitychange
        // handler re-render once it has a usable size, so no retry loop here.
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

    if (rectW < MIN_RENDER_VIEWPORT || rectH < MIN_RENDER_VIEWPORT) {
        drawTooSmall(rectW, rectH);
        if (revealPending && data) {
            checkRevealStable(rectW, rectH);
        }
        return;
    }

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

    if (revealPending) {
        checkRevealStable(rectW, rectH);
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

    const rootCellW = availableW / gridCols;
    const rootCellH = availableH / gridRows;

    const MIN_CELL_W = data && typeof data.minCellWidth === "number" ? data.minCellWidth : 40;
    const MIN_CELL_H = data && typeof data.minCellHeight === "number" ? data.minCellHeight : 28;

    // Evaluate rootCellsTooSmall against stable reference canvas bounds (REF_CANVAS_W x REF_CANVAS_H)
    // so resizing the window, sidebars, or terminal never flips the mode or reflows tiles into cards.
    const refAvailableW = REF_CANVAS_W - (GRID_SIDE_MARGIN * 2);
    const refAvailableH = REF_CANVAS_H - GRID_TOP_MARGIN - GRID_BOTTOM_MARGIN;
    const refCellW = refAvailableW / gridCols;
    const refCellH = refAvailableH / gridRows;

    // Only adding files or lowering the minimum tile size may turn the root into folder cards (the
    // largest possible layout change). The check therefore uses the pre-overflow flow size (a file
    // growing adds rows only past it) without Expand Grid Space's extra columns and rows, and the
    // fixed reference canvas, so resizing the window never flips it either.
    const rootExtraCols = (data.folderExtraCols && typeof data.folderExtraCols[""] === "number") ? data.folderExtraCols[""] : (data.extraCols || 0);
    const rootExtraRows = (data.folderExtraRows && typeof data.folderExtraRows[""] === "number") ? data.folderExtraRows[""] : (data.extraRows || 0);
    // The host's size without extras (baseFlowCols/Rows). Subtracting the webview's extra counts from
    // the host's totals broke on Reduce Grid Space: the webview lowers its counts at once while the
    // totals still include the old extras, so the grid looked a column wider and flipped into cards.
    const refFlowCellW = refAvailableW / Math.max(1, data.layout.baseFlowCols || ((data.layout.flowCols || gridCols) - rootExtraCols));
    const refFlowCellH = refAvailableH / Math.max(1, data.layout.baseFlowRows || ((data.layout.flowRows || gridRows) - rootExtraRows));
    const rootCellsTooSmall = refFlowCellW < MIN_CELL_W || refFlowCellH < MIN_CELL_H;

    // Opening/focusing a directory drills down into that folder so its files span the canvas.
    const shouldOpenFolder = !!focusedFolder;

    const scopedFiles = shouldOpenFolder
        ? data.files.filter(f => f.path && (focusedFolder === "(root files)/" ? !f.path.includes("/") : f.path.startsWith(focusedFolder)))
        : data.files;

    const effectiveBasePath = shouldOpenFolder
        ? (focusedFolder === "(root files)/" ? "" : focusedFolder)
        : "";

    const subfolderInfo = getSubfolderGroups(scopedFiles, effectiveBasePath);
    const hasSubfolders = subfolderInfo.folders && subfolderInfo.folders.length > 0;

    let cellsTooSmall = false;
    let localFolderGrid = null;
    let localSpanningLayout = null;
    let folderCellW = rootCellW;
    let folderCellH = rootCellH;

    const currentLayer = focusedFolder || "";
    const extraCols = (data && data.folderExtraCols && typeof data.folderExtraCols[currentLayer] === "number")
        ? data.folderExtraCols[currentLayer]
        : (currentLayer === "" ? ((data && data.extraCols) || 0) : 0);
    const extraRows = (data && data.folderExtraRows && typeof data.folderExtraRows[currentLayer] === "number")
        ? data.folderExtraRows[currentLayer]
        : (currentLayer === "" ? ((data && data.extraRows) || 0) : 0);
    const isSpanningMode = data && (data.mode === "spanning_grid" || data.layoutMode === "spanning_grid");

    if (shouldOpenFolder) {
        reconcileFolderFileOrder(focusedFolder, scopedFiles, isSpanningMode);
        const folderOrder = (data && data.folderOrders && data.folderOrders[focusedFolder]) || null;
        const folderWrapRows = (data && data.folderWrapRows && data.folderWrapRows[focusedFolder]) || null;
        if (isSpanningMode) {
            localSpanningLayout = buildSpanningGridLocal(scopedFiles, BASE_GRID_ASPECT, folderOrder, extraCols, extraRows, 60, (typeof getCompressionPct === "function" ? getCompressionPct() : 0.05), folderWrapRows, scopeFootprints(`folder:${focusedFolder}`), scopeFlowCells(`folder:${focusedFolder}`));
            folderCellW = availableW / Math.max(1, localSpanningLayout.cols);
            folderCellH = availableH / Math.max(1, localSpanningLayout.rows);
        } else {
            const totalSlots = Math.max(scopedFiles.length, folderOrder ? folderOrder.length : 0);
            localFolderGrid = buildStableGrid(totalSlots, BASE_GRID_ASPECT);
            const folderCols = localFolderGrid.cols + extraCols;
            const folderRows = localFolderGrid.rows + extraRows;
            folderCellW = availableW / Math.max(1, folderCols);
            folderCellH = availableH / Math.max(1, folderRows);
        }
        // Pre-overflow size, so growth never flips a folder into card mode (see rootCellsTooSmall).
        // Without Expand Grid Space's extra columns and rows: expanding never flips a folder into cards.
        const refFolderCols = isSpanningMode ? (localSpanningLayout ? Math.max(1, localSpanningLayout.flowCols - extraCols) : 1) : (localFolderGrid ? localFolderGrid.cols : 1);
        const refFolderRows = isSpanningMode ? (localSpanningLayout ? Math.max(1, localSpanningLayout.flowRows - extraRows) : 1) : (localFolderGrid ? localFolderGrid.rows : 1);
        const refFolderCellW = refAvailableW / Math.max(1, refFolderCols);
        const refFolderCellH = refAvailableH / Math.max(1, refFolderRows);
        cellsTooSmall = hasSubfolders && (doesFolderCollapse(scopedFiles, effectiveBasePath, isSpanningMode) || refFolderCellW < MIN_CELL_W || refFolderCellH < MIN_CELL_H);
    } else {
        cellsTooSmall = hasSubfolders && rootCellsTooSmall;
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
        const { folders, rootFiles, orderedItems } = subfolderInfo;

        const itemById = new Map(orderedItems.map(it => [it.id, it]));
        // Card orders follow the same spatial-stability rule as file orders: an item that
        // disappears (ignored file, folder dissolved) leaves a hole, new items fill the earliest
        // hole they fit in, and nothing is trimmed. See fillLayoutHoles.
        const cardScope = shouldOpenFolder ? "folderCards" : "rootCards";
        const savedCardOrder = shouldOpenFolder
            ? (focusedFolder && data.folderCardOrders && data.folderCardOrders[focusedFolder])
            : data.cardOrder;
        const liveCardIds = orderedItems.map(it => it.id);
        const cardCellsOf = id => {
            const it = itemById.get(id);
            return it && it.type === "file" ? spanningCellsForFile(it.file) : 1;
        };
        const cardFootprintsKey = `cards:${shouldOpenFolder ? focusedFolder : ""}`;
        const cardFp = scopeFootprints(cardFootprintsKey);
        const cardFlow = scopeFlowCells(cardFootprintsKey);
        const { order: effectiveCardOrder, footprints: newCardFootprints } = (!savedCardOrder || savedCardOrder.length === 0)
            ? { order: liveCardIds, footprints: {} }
            : fillLayoutHoles(savedCardOrder, liveCardIds,
                isSpanningMode ? cardCellsOf : undefined,
                isSpanningMode ? (id => spanningHoleCells(id, cardFp, cardFlow)) : undefined);
        const newCardFlow = isSpanningMode
            ? missingFlowCells(liveCardIds, cardCellsOf, { ...(cardFp || {}), ...newCardFootprints }, cardFlow)
            : {};
        const savedCardWrap = shouldOpenFolder
            ? (data.folderCardWrapRows && data.folderCardWrapRows[focusedFolder])
            : data.cardWrapRows;
        // Freeze the card column height on first spanning view (see reconcileFolderFileOrder).
        const freezeCardWrap = isSpanningMode && !savedCardWrap
            ? buildSpanningGridLocal(cardLayoutItems(orderedItems), BASE_GRID_ASPECT,
                (!savedCardOrder || savedCardOrder.length === 0) ? liveCardIds : savedCardOrder,
                0, 0, 60, getCompressionPct(), null, cardFp, cardFlow).wrapRows
            : null;
        if (!sameOrder(savedCardOrder, effectiveCardOrder) || freezeCardWrap || Object.keys(newCardFlow).length > 0) {
            requestLayoutOrderSave(cardScope, focusedFolder, effectiveCardOrder, newCardFootprints, freezeCardWrap, newCardFlow);
        }
        const displayItems = effectiveCardOrder.map(cid => (cid && itemById.get(cid)) || null);

        const totalItems = orderedItems.length;
        if (totalItems === 0) return;

        const cardWrapRows = (shouldOpenFolder && focusedFolder && data.folderCardWrapRows && data.folderCardWrapRows[focusedFolder])
            ? data.folderCardWrapRows[focusedFolder]
            : (shouldOpenFolder ? null : (data.cardWrapRows || null));

        let cardCols, cardRows, localCellW, localCellH, cardSlots;
        let localSpanningLayout = null;
        let itemsToRender = [];

        if (isSpanningMode) {
            const spanningItems = cardLayoutItems(displayItems);

            localSpanningLayout = buildSpanningGridLocal(
                spanningItems,
                BASE_GRID_ASPECT,
                effectiveCardOrder,
                extraCols,
                extraRows,
                60,
                (typeof getCompressionPct === "function" ? getCompressionPct() : 0.05),
                cardWrapRows,
                cardFp,
                cardFlow
            );

            cardCols = localSpanningLayout.cols;
            cardRows = localSpanningLayout.rows;
            localCellW = availableW / Math.max(1, cardCols);
            localCellH = availableH / Math.max(1, cardRows);
            cardSlots = localSpanningLayout.slots;

            activeRenderGrid = {
                cols: cardCols,
                rows: cardRows,
                wrapRows: localSpanningLayout.wrapRows,
                cellW: localCellW,
                cellH: localCellH,
                isFolderCards: true,
                isSpanning: true,
                layout: localSpanningLayout,
                orderedItems: displayItems,
                spanningItems: spanningItems,
                focusedFolder: shouldOpenFolder ? focusedFolder : null
            };

            itemsToRender = localSpanningLayout.placements.map(p => ({
                item: p.item,
                slot: [p.col, p.row],
                nCells: p.nCells
            }));
        } else {
            const baseGrid = buildStableGrid(totalItems, BASE_GRID_ASPECT);
            cardCols = baseGrid.cols + extraCols;
            cardRows = baseGrid.rows + extraRows;
            localCellW = availableW / Math.max(1, cardCols);
            localCellH = availableH / Math.max(1, cardRows);

            cardSlots = [...baseGrid.slots];
            const existingSlotsSet = new Set(cardSlots.map(s => `${s[0]},${s[1]}`));
            for (let r = 0; r < cardRows; r++) {
                for (let c = 0; c < cardCols; c++) {
                    const key = `${c},${r}`;
                    if (!existingSlotsSet.has(key)) {
                        cardSlots.push([c, r]);
                        existingSlotsSet.add(key);
                    }
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
                isSpanning: false,
                layout: localGrid,
                orderedItems: displayItems,
                focusedFolder: shouldOpenFolder ? focusedFolder : null
            };

            let slotIdx = 0;
            for (const item of displayItems) {
                if (slotIdx >= cardSlots.length) break;
                const slot = cardSlots[slotIdx++];
                if (item) {
                    itemsToRender.push({ item, slot, nCells: 1 });
                }
            }
        }

        for (const entry of itemsToRender) {
            const { item, slot, nCells } = entry;
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
                    const mosaicWInt = Math.round(mosaicW);
                    const mosaicHInt = Math.round(mosaicH);
                    const mosaicDpr = Math.min(window.devicePixelRatio || 1, 2);
                    // No search state in the key: matches are drawn over the cached mosaic from its
                    // recorded mini-tile rects (drawMosaicSearchOverlay), so typing reuses every mosaic.
                    const mosaicCacheKey = `${group.path}:${mosaicWInt}:${mosaicHInt}:${mosaicDpr}:${isSpanningMode}:${activeFileUri}:${openFilesVersion}:${light ? 1 : 0}:${groupMosaicSignature(group)}`;

                    const cachedMosaic = mosaicCache.get(mosaicCacheKey);
                    if (cachedMosaic) {
                        ctx.drawImage(cachedMosaic, mosaicX, mosaicY, mosaicWInt, mosaicHInt);
                        if (queryActive) drawMosaicSearchOverlay(cachedMosaic._tileRects, mosaicX, mosaicY);
                    } else {
                        const tileRects = [];
                        let miniOffscreen = null;
                        let miniCtx = null;
                        try {
                            // Device-pixel raster for HiDPI sharpness (see drawThumbnail's rasterDpr).
                            miniOffscreen = document.createElement("canvas");
                            miniOffscreen.width = Math.round(mosaicWInt * mosaicDpr);
                            miniOffscreen.height = Math.round(mosaicHInt * mosaicDpr);
                            miniCtx = miniOffscreen.getContext("2d");
                            miniCtx.setTransform(mosaicDpr, 0, 0, mosaicDpr, 0, 0);
                        } catch (e) {
                            miniOffscreen = null;
                            miniCtx = null;
                        }

                        const targetMiniCtx = miniCtx || ctx;
                        const originMosaicX = miniCtx ? 0 : mosaicX;
                        const originMosaicY = miniCtx ? 0 : mosaicY;

                        const willCollapse = doesFolderCollapse(group.files, group.path, isSpanningMode);
                        const groupFolderOrder = willCollapse
                            ? ((data && data.folderCardOrders && data.folderCardOrders[group.path]) || null)
                            : ((data && data.folderOrders && data.folderOrders[group.path]) || null);
                        const childSubfolderInfo = getSubfolderGroups(group.files, group.path);
                        const previewItems = willCollapse
                            ? childSubfolderInfo.orderedItems
                            : group.files.map(f => ({ type: "file", file: f, id: f.id }));

                        if (!willCollapse && isSpanningMode) {
                            const itemsToLayout = previewItems.map(it => {
                                if (it.type === "folder") {
                                    return { id: it.id, item: it, isFolder: true, nCells: 1 };
                                }
                                const f = it.file;
                                const nCells = (f.nCells && f.nCells > 1) ? f.nCells : (f.lineCount ? cellsNeeded(f.lineCount, 60, getCompressionPct()) : (f.nCells || 1));
                                return { id: it.id, item: it, file: f, lineCount: f.lineCount, nCells };
                            });
                            const groupFolderWrapRows = (data && data.folderWrapRows && data.folderWrapRows[group.path]) || null;
                            const groupFolderExtraCols = (data && data.folderExtraCols && typeof data.folderExtraCols[group.path] === "number")
                                ? data.folderExtraCols[group.path]
                                : 0;
                            const groupFolderExtraRows = (data && data.folderExtraRows && typeof data.folderExtraRows[group.path] === "number")
                                ? data.folderExtraRows[group.path]
                                : 0;
                            const spanningLayout = buildSpanningGridLocal(itemsToLayout, BASE_GRID_ASPECT, groupFolderOrder, groupFolderExtraCols, groupFolderExtraRows, 60, (typeof getCompressionPct === "function" ? getCompressionPct() : 0.05), groupFolderWrapRows, scopeFootprints(`folder:${group.path}`), scopeFlowCells(`folder:${group.path}`));
                            const miniCols = spanningLayout.cols;
                            const miniRows = spanningLayout.rows;
                            const gap = (miniCols >= 8 || miniRows >= 8) ? 1 : 2;

                            const miniCellW = Math.max(1, (mosaicW - (miniCols - 1) * gap) / miniCols);
                            const miniCellH = Math.max(1, (mosaicH - (miniRows - 1) * gap) / miniRows);

                            for (const placement of spanningLayout.placements) {
                                const miniX = originMosaicX + placement.col * (miniCellW + gap);
                                const miniY = originMosaicY + placement.row * (miniCellH + gap);
                                const miniFileH = placement.nCells * miniCellH + (placement.nCells - 1) * gap;

                                if (placement.item && placement.item.type === "folder") {
                                    targetMiniCtx.fillStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.15);
                                    targetMiniCtx.fillRect(miniX, miniY, miniCellW, miniFileH);

                                    targetMiniCtx.strokeStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.5);
                                    targetMiniCtx.lineWidth = 1;
                                    targetMiniCtx.strokeRect(miniX, miniY, miniCellW, miniFileH);

                                    targetMiniCtx.fillStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.35);
                                    targetMiniCtx.fillRect(miniX, miniY, miniCellW, Math.min(6, miniFileH));

                                    if (miniCellW >= 24 && miniFileH >= 12 && placement.item.card) {
                                        targetMiniCtx.fillStyle = getThemeColor("--vscode-foreground", light ? "#3730a3" : "#c4b5fd");
                                        const miniFont = `${Math.max(6, Math.min(8, miniCellW / 8))}px system-ui, sans-serif`;
                                        targetMiniCtx.font = miniFont;
                                        let miniLabel = placement.item.card.name;
                                        while (miniLabel.length > 1 && targetMiniCtx.measureText(miniLabel).width > miniCellW - 4) {
                                            miniLabel = miniLabel.slice(0, -1);
                                        }
                                        targetMiniCtx.fillText(miniLabel, miniX + 2, miniY + Math.min(10, miniFileH - 2));
                                    }
                                    continue;
                                }

                                const pf = placement.file;
                                if (!pf) continue;
                                const isOpen = openFilesSet.has(pf.uri);
                                const isActive = pf.uri === activeFileUri;
                                // Baked in only when drawing straight to the screen (no mosaic raster).
                                const isSearchMatch = !miniCtx && queryActive && fileMatchesSearch(pf);
                                if (miniCtx) tileRects.push({ id: pf.id, x: miniX, y: miniY, w: miniCellW, h: miniFileH });

                                targetMiniCtx.fillStyle = isSearchMatch
                                    ? withAlpha(ACCENT_SEARCH, 0.45)
                                    : (light ? "#eaeaf0" : "#141418");
                                targetMiniCtx.fillRect(miniX, miniY, miniCellW, miniFileH);

                                targetMiniCtx.strokeStyle = isSearchMatch
                                    ? ACCENT_SEARCH
                                    : (isActive
                                        ? (BORDER_STYLES.active ? BORDER_STYLES.active.color : "#007fd4")
                                        : (isOpen
                                            ? ACCENT_RECENCY
                                            : (light ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.08)")));
                                targetMiniCtx.lineWidth = isSearchMatch ? 2.0 : (isActive ? 1.5 : 1);
                                targetMiniCtx.strokeRect(miniX, miniY, miniCellW, miniFileH);

                                if (pf.lines && pf.lines.length > 0 && miniFileH >= 10 && miniCellW >= 8) {
                                    const maxLines = Math.min(pf.lines.length, Math.floor((miniFileH - 4) / 2));
                                    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
                                        const line = lineShape(pf.lines[lineIdx]);
                                        const lineY = miniY + 3 + lineIdx * 2;
                                        const lineWidth = Math.max(2, Math.min(miniCellW - 4, (line.length || 20) * (miniCellW / 80)));
                                        const lineIndent = Math.min(4, (line.indent || 0) * 1.2);
                                        targetMiniCtx.fillStyle = withAlpha(colorForCategory(line.category || "normal", false), 0.75);
                                        targetMiniCtx.fillRect(miniX + 2 + lineIndent, lineY, Math.max(1, lineWidth - lineIndent), 1);
                                    }
                                } else if (miniFileH >= 4 && miniCellW >= 4 && pf.gitStatus) {
                                    targetMiniCtx.fillStyle = pf.gitStatus === "modified"
                                        ? (TILE_LABEL_COLOR.modified || "#e2c08d")
                                        : (TILE_LABEL_COLOR.added || "#73c991");
                                    targetMiniCtx.fillRect(miniX + 1, miniY + 1, Math.min(3, miniCellW - 2), Math.min(3, miniFileH - 2));
                                }
                            }
                        } else {
                            const totalSlots = Math.max(previewItems.length, groupFolderOrder ? groupFolderOrder.length : 0);
                            const baseMiniGrid = buildStableGrid(totalSlots, BASE_GRID_ASPECT);
                            const groupFolderExtraCols = (data && data.folderExtraCols && typeof data.folderExtraCols[group.path] === "number")
                                ? data.folderExtraCols[group.path]
                                : 0;
                            const groupFolderExtraRows = (data && data.folderExtraRows && typeof data.folderExtraRows[group.path] === "number")
                                ? data.folderExtraRows[group.path]
                                : 0;
                            const miniCols = baseMiniGrid.cols + groupFolderExtraCols;
                            const miniRows = baseMiniGrid.rows + groupFolderExtraRows;
                            const gap = (miniCols >= 8 || miniRows >= 8) ? 1 : 2;

                            const miniCellW = Math.max(1, (mosaicW - (miniCols - 1) * gap) / miniCols);
                            const miniCellH = Math.max(1, (mosaicH - (miniRows - 1) * gap) / miniRows);

                            const miniSlots = [];
                            for (let r = 0; r < miniRows; r++) {
                                for (let c = 0; c < miniCols; c++) {
                                    miniSlots.push([c, r]);
                                }
                            }

                            const itemsById = new Map(previewItems.map(it => [it.id, it]));
                            const orderToUse = groupFolderOrder && groupFolderOrder.length > 0
                                ? groupFolderOrder
                                : previewItems.map(it => it.id);

                            for (let mIdx = 0; mIdx < orderToUse.length && mIdx < miniSlots.length; mIdx++) {
                                const fid = orderToUse[mIdx];
                                if (!fid) continue;
                                const pit = itemsById.get(fid);
                                if (!pit) continue;
                                const miniSlot = miniSlots[mIdx];
                                const miniX = originMosaicX + miniSlot[0] * (miniCellW + gap);
                                const miniY = originMosaicY + miniSlot[1] * (miniCellH + gap);

                                if (pit.type === "folder") {
                                    targetMiniCtx.fillStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.15);
                                    targetMiniCtx.fillRect(miniX, miniY, miniCellW, miniCellH);

                                    targetMiniCtx.strokeStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.5);
                                    targetMiniCtx.lineWidth = 1;
                                    targetMiniCtx.strokeRect(miniX, miniY, miniCellW, miniCellH);

                                    targetMiniCtx.fillStyle = withAlpha(getThemeColor("--vscode-focusBorder", "#a855f7"), 0.35);
                                    targetMiniCtx.fillRect(miniX, miniY, miniCellW, Math.min(6, miniCellH));

                                    if (miniCellW >= 24 && miniCellH >= 12 && pit.card) {
                                        targetMiniCtx.fillStyle = getThemeColor("--vscode-foreground", light ? "#3730a3" : "#c4b5fd");
                                        const miniFont = `${Math.max(6, Math.min(8, miniCellW / 8))}px system-ui, sans-serif`;
                                        targetMiniCtx.font = miniFont;
                                        let miniLabel = pit.card.name;
                                        while (miniLabel.length > 1 && targetMiniCtx.measureText(miniLabel).width > miniCellW - 4) {
                                            miniLabel = miniLabel.slice(0, -1);
                                        }
                                        targetMiniCtx.fillText(miniLabel, miniX + 2, miniY + Math.min(10, miniCellH - 2));
                                    }
                                    continue;
                                }

                                const pf = pit.file;
                                if (!pf) continue;
                                const isOpen = openFilesSet.has(pf.uri);
                                const isActive = pf.uri === activeFileUri;
                                // Baked in only when drawing straight to the screen (no mosaic raster).
                                const isSearchMatch = !miniCtx && queryActive && fileMatchesSearch(pf);
                                if (miniCtx) tileRects.push({ id: pf.id, x: miniX, y: miniY, w: miniCellW, h: miniCellH });

                                targetMiniCtx.fillStyle = isSearchMatch
                                    ? withAlpha(ACCENT_SEARCH, 0.45)
                                    : (light ? "#eaeaf0" : "#141418");
                                targetMiniCtx.fillRect(miniX, miniY, miniCellW, miniCellH);

                                targetMiniCtx.strokeStyle = isSearchMatch
                                    ? ACCENT_SEARCH
                                    : (isActive
                                        ? (BORDER_STYLES.active ? BORDER_STYLES.active.color : "#007fd4")
                                        : (isOpen
                                            ? ACCENT_RECENCY
                                            : (light ? "rgba(0, 0, 0, 0.1)" : "rgba(255, 255, 255, 0.08)")));
                                targetMiniCtx.lineWidth = isSearchMatch ? 2.0 : (isActive ? 1.5 : 1);
                                targetMiniCtx.strokeRect(miniX, miniY, miniCellW, miniCellH);

                                if (pf.lines && pf.lines.length > 0 && miniCellH >= 10 && miniCellW >= 8) {
                                    const maxLines = Math.min(pf.lines.length, Math.floor((miniCellH - 4) / 2));
                                    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
                                        const line = lineShape(pf.lines[lineIdx]);
                                        const lineY = miniY + 3 + lineIdx * 2;
                                        const lineWidth = Math.max(2, Math.min(miniCellW - 4, (line.length || 20) * (miniCellW / 80)));
                                        const lineIndent = Math.min(4, (line.indent || 0) * 1.2);
                                        targetMiniCtx.fillStyle = withAlpha(colorForCategory(line.category || "normal", false), 0.75);
                                        targetMiniCtx.fillRect(miniX + 2 + lineIndent, lineY, Math.max(1, lineWidth - lineIndent), 1);
                                    }
                                } else if (miniCellH >= 4 && miniCellW >= 4 && pf.gitStatus) {
                                    targetMiniCtx.fillStyle = pf.gitStatus === "modified"
                                        ? (TILE_LABEL_COLOR.modified || "#e2c08d")
                                        : (TILE_LABEL_COLOR.added || "#73c991");
                                    targetMiniCtx.fillRect(miniX + 1, miniY + 1, Math.min(3, miniCellW - 2), Math.min(3, miniCellH - 2));
                                }
                            }
                        }

                        if (miniOffscreen && miniCtx) {
                            miniOffscreen._tileRects = tileRects;
                            mosaicCache.set(mosaicCacheKey, miniOffscreen);
                            ctx.drawImage(miniOffscreen, mosaicX, mosaicY, mosaicWInt, mosaicHInt);
                            if (queryActive) drawMosaicSearchOverlay(tileRects, mosaicX, mosaicY);
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
                const fileH = localCellH * nCells;
                file._cell = { id: item.id, x, y, w: localCellW, h: fileH, _slot: slot };

                if (y + fileH < -50 || y > rectH + 50) continue;

                const isFolderMatch = !focusedFolder || (focusedFolder === "(root files)/" ? !file.path.includes("/") : file.path.startsWith(focusedFolder));
                const isSearchMatch = queryActive && fileMatchesSearch(file);

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

                const isSearchMatch = queryActive && fileMatchesSearch(file);
                drawFileTile(file, x, y, cellW, fileH, queryActive && !isSearchMatch);
            }
        } else {
            let orderToIterate = [];
            if (folderOrder && Array.isArray(folderOrder) && folderOrder.length > 0) {
                // Files missing from the order fill holes left by removed files, never "" gaps the user left
                // (fillLayoutHoles, the one stability rule shared with the host).
                orderToIterate = fillLayoutHoles(folderOrder, scopedFiles.map(f => f.id)).order;
            } else {
                orderToIterate = scopedFiles.map(f => f.id);
            }

            const totalSlots = Math.max(scopedFiles.length, folderOrder ? folderOrder.length : 0);
            localFolderGrid = buildStableGrid(totalSlots, BASE_GRID_ASPECT);

            const folderCols = (localFolderGrid ? localFolderGrid.cols : 1) + extraCols;
            const folderRows = (localFolderGrid ? localFolderGrid.rows : 1) + extraRows;

            const folderSlots = [...localFolderGrid.slots];
            const existingFolderSlotsSet = new Set(folderSlots.map(s => `${s[0]},${s[1]}`));
            for (let r = 0; r < folderRows; r++) {
                for (let c = 0; c < folderCols; c++) {
                    const key = `${c},${r}`;
                    if (!existingFolderSlotsSet.has(key)) {
                        folderSlots.push([c, r]);
                        existingFolderSlotsSet.add(key);
                    }
                }
            }
            localFolderGrid.slots = folderSlots;
            localFolderGrid.cols = folderCols;
            localFolderGrid.rows = folderRows;

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

            const slots = folderSlots;
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

                const isSearchMatch = queryActive && fileMatchesSearch(file);
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
            wrapRows: (data.layout && data.layout.wrapRows) || data.layout.rows,
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
            const isSearchMatch = queryActive && fileMatchesSearch(file);

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
        ctx.fillText((draggingFolder.name || draggingFolder.folderPath), x + TILE_LABEL_OFFSET_X, y + TILE_LABEL_OFFSET_Y);

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
            } else if (dragTarget.item && dragTarget.item.type === "folder") {
                const fc = data._folderCards && data._folderCards.find(c => c.id === dragTarget.item.id);
                if (fc) {
                    ctx.strokeRect(fc.x, fc.y, fc.w, fc.h);
                } else {
                    ctx.strokeRect(
                        GRID_SIDE_MARGIN + dragTarget.col * dragTarget.cellW,
                        GRID_TOP_MARGIN + dragTarget.row * dragTarget.cellH,
                        dragTarget.cellW,
                        dragTarget.cellH
                    );
                }
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
            } else if (dragTarget.item && dragTarget.item.type === "folder") {
                const fc = data._folderCards && data._folderCards.find(c => c.id === dragTarget.item.id);
                if (fc) {
                    ctx.strokeRect(fc.x, fc.y, fc.w, fc.h);
                } else {
                    ctx.strokeRect(
                        GRID_SIDE_MARGIN + dragTarget.col * dragTarget.cellW,
                        GRID_TOP_MARGIN + dragTarget.row * dragTarget.cellH,
                        dragTarget.cellW,
                        dragTarget.cellH
                    );
                }
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
        const isOpen = openFilesSet.has(targetFile.uri);
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

        // 1. Cancel active drag operation
        const isDragging = draggingFile !== null || draggingFolder !== null || candidateFile !== null || candidateFolder !== null;
        if (isDragging) {
            clearDragState();
            render();
            return;
        }

        // 2. Dismiss open context menu
        const menuEl = document.getElementById("context-menu");
        if (menuEl && menuEl.style.display !== "none" && menuEl.style.display !== "") {
            if (typeof hideContextMenu === "function") {
                hideContextMenu();
            } else {
                menuEl.style.display = "none";
            }
            return;
        }

        // 3. Close open popovers / modals (Settings, Folders & Ignored)
        const foldersPopoverEl = document.getElementById("folders-popover");
        const actionsModalEl = document.getElementById("actions-modal");
        const isPopoverOpen = (foldersPopoverEl && foldersPopoverEl.style.display !== "none" && foldersPopoverEl.style.display !== "") ||
            (actionsModalEl && actionsModalEl.style.display !== "none" && actionsModalEl.style.display !== "");
        if (isPopoverOpen) {
            closeAllPopovers();
            return;
        }

        // 4. Clear search query or unfocus search input
        const searchInput = document.getElementById("search-input");
        const isSearchActive = searchInput && (document.activeElement === searchInput || (searchInput.value && searchInput.value.length > 0));
        if (isSearchActive) {
            clearSearch();
            searchInput.blur();
            return;
        }

        // 5. Exit Thumbview
        isCtrlDown = false;
        hoverSnappedTarget = null;
        hoverScrollOffset = 0;
        lastHoveredFileUri = null;
        wheelMousePos = null;
        if (typeof tooltip !== "undefined" && tooltip) {
            tooltip.style.display = "none";
        }
        vscode.postMessage({ command: "exitThumbview" });
        return;
    }

    const isInputFocused = document.activeElement && (
        document.activeElement.tagName === "INPUT" ||
        document.activeElement.tagName === "TEXTAREA"
    );

    if (!isInputFocused && !contextMenuHasFocus()) {
        const isModifier = event.ctrlKey || event.metaKey;
        // Copy, cut, and delete act only on a tile the user can see is targeted: the keyboard focus
        // ring, or the pointer's hover outline (updateHoverOutline).
        const shownTarget = shownActionTarget();
        if (isModifier && (event.key === "v" || event.key === "V")) {
            event.preventDefault();
            const currentTargetFolder = focusedFolder === "(root files)/" ? "" : (focusedFolder || "");
            vscode.postMessage({ command: "pasteItem", targetFolder: currentTargetFolder });
            return;
        }
        if (isModifier && (event.key === "c" || event.key === "C")) {
            if (shownTarget) {
                event.preventDefault();
                clipboardItem = { uri: shownTarget.uri, path: shownTarget.path, isFolder: false, isCut: false };
                vscode.postMessage({ command: "copyFile", uri: shownTarget.uri });
                return;
            }
        }
        if (isModifier && (event.key === "x" || event.key === "X")) {
            if (shownTarget) {
                event.preventDefault();
                clipboardItem = { uri: shownTarget.uri, path: shownTarget.path, isFolder: false, isCut: true };
                vscode.postMessage({ command: "cutFile", uri: shownTarget.uri });
                return;
            }
        }
        // Not ⌘⌫ on macOS: that clears the search (the toolbar's Clear Search), and a delete prompt
        // for whatever tile the pointer rests on would be a surprise. Mac users have fn+Delete (⌦).
        // The context menu's Rename (F2) and Open to the Side (Ctrl+Enter, ⌘Enter on macOS, as in the
        // Explorer). Stops propagation so the grid's Enter does not also open the file.
        if (event.key === "F2" && !isModifier && !event.altKey && shownTarget) {
            event.preventDefault();
            event.stopPropagation();
            vscode.postMessage({ command: "renameFile", uri: shownTarget.uri, path: shownTarget.path });
            return;
        }
        if (event.key === "Enter" && (IS_MAC ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && shownTarget) {
            event.preventDefault();
            event.stopPropagation();
            vscode.postMessage({ command: "openToSide", uri: shownTarget.uri });
            return;
        }
        if (event.key === "Delete") {
            if (shownTarget) {
                event.preventDefault();
                vscode.postMessage({ command: "deleteFile", uri: shownTarget.uri });
                return;
            }
        }
    }

    if (isControlModifier(event)) {
        if (!isCtrlDown && hoveredFile) studyNote("magnifier");
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
        hoverSnappedTarget = null;
        hoverScrollOffset = 0;
        lastHoveredFileUri = null;
        wheelMousePos = null;
    }
}, true);

window.addEventListener("blur", () => {
    isCtrlDown = false;
    tooltip.style.display = "none";
    hoverSnappedTarget = null;
    hoverScrollOffset = 0;
    lastHoveredFileUri = null;
    wheelMousePos = null;
});

window.addEventListener("wheel", event => {
    if (!isCtrlDown || !hoveredFile) return;
    if (tooltip && tooltip.style.display !== "none") {
        event.preventDefault();
        event.stopPropagation();
        const delta = Math.sign(event.deltaY);
        if (delta === 0) return;

        lastWheelTime = Date.now();
        wheelMousePos = cursorPos ? { px: cursorPos.px, py: cursorPos.py } : null;

        const searchTargets = getSearchTargetsForFile(hoveredFile);
        if (searchTargets.length > 1 && !event.shiftKey) {
            // When multiple search results exist, wheel steps directly between results!
            let curIdx = hoverSnappedTarget ? searchTargets.indexOf(hoverSnappedTarget) : -1;
            if (curIdx === -1) {
                curIdx = delta > 0 ? 0 : searchTargets.length - 1;
                hoverSnappedTarget = searchTargets[curIdx];
                hoverScrollOffset = 0;
            } else if (delta > 0 && curIdx < searchTargets.length - 1 && hoverScrollOffset >= 0) {
                // Step to next match
                hoverSnappedTarget = searchTargets[curIdx + 1];
                hoverScrollOffset = 0;
            } else if (delta < 0 && curIdx > 0 && hoverScrollOffset <= 0) {
                // Step to previous match
                hoverSnappedTarget = searchTargets[curIdx - 1];
                hoverScrollOffset = 0;
            } else {
                // Past the end, before the beginning, or returning to match: scroll surroundings!
                hoverScrollOffset += delta * 2;
            }
            updateHoverTooltip();
        } else {
            // Single target, no search target, or Shift+wheel: scroll surrounding lines
            const step = event.shiftKey ? 5 : 2;
            hoverScrollOffset += delta * step;
            updateHoverTooltip();
        }
    }
}, { passive: false });

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
            if (l && l.text) {
                const len = l.text.includes("\t") ? l.text.replace(/\t/g, "    ").length : l.text.length;
                if (len > maxCharLen) {
                    maxCharLen = len;
                }
            }
        }
    }
    if (file.fullLines && file.fullLines.length > 0) {
        for (let i = 0; i < file.fullLines.length; i++) {
            const str = file.fullLines[i];
            if (str) {
                const len = str.includes("\t") ? str.replace(/\t/g, "    ").length : str.length;
                if (len > maxCharLen) {
                    maxCharLen = len;
                }
            }
        }
    }
    const uriCache = hoverLineCache[file.uri];
    if (uriCache) {
        for (const idx in uriCache) {
            const l = uriCache[idx];
            if (l && l.text) {
                const len = l.text.includes("\t") ? l.text.replace(/\t/g, "    ").length : l.text.length;
                if (len > maxCharLen) {
                    maxCharLen = len;
                }
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
        hoverSnappedTarget = null;
        hoverScrollOffset = 0;
        wheelMousePos = null;
        return;
    }

    if (lastHoveredFileUri !== hoveredFile.uri) {
        lastHoveredFileUri = hoveredFile.uri;
        hoverSnappedTarget = null;
        hoverScrollOffset = 0;
        wheelMousePos = null;
    }

    const c = hoveredFile._cell;
    const thumbnailTop = c.y + TILE_THUMBNAIL_OFFSET_Y;
    const thumbnailHeight = Math.max(1, c.h - TILE_THUMBNAIL_HEIGHT_MARGIN);
    const lines = hoveredFile.lines || [];
    const lineCount = Math.max(lines.length, 1);
    const stepY = Math.min(thumbnailHeight / lineCount, THUMBNAIL_MAX_LINE_PITCH);
    const codeHeight = Math.min(thumbnailHeight, lineCount * stepY);
    const cursorOffsetY = Math.max(0, cursorPos.py - thumbnailTop);
    const visualLinesCount = lines.length;
    const visualLineIdx = Math.max(0, Math.min(visualLinesCount - 1, Math.floor(cursorOffsetY / stepY)));

    const isSampled = !!(hoveredFile.lineCount && hoveredFile.lineCount > lines.length);
    const totalLines = Math.max(hoveredFile.lineCount || lines.length, 1);
    let hoveredLineIdx;

    const searchTargets = getSearchTargetsForFile(hoveredFile);
    if (searchTargets.length > 0) {
        if (searchTargets.length === 1) {
            hoverSnappedTarget = searchTargets[0];
        } else {
            const numTargets = searchTargets.length;
            const effectiveYs = new Array(numTargets);
            // Group targets sharing the same sampled visual line so each gets a distinct, reachable vertical band
            let groupStart = 0;
            while (groupStart < numTargets) {
                let groupEnd = groupStart + 1;
                while (groupEnd < numTargets && searchTargets[groupEnd].sampledIdx === searchTargets[groupStart].sampledIdx) {
                    groupEnd++;
                }
                const groupCount = groupEnd - groupStart;
                const s = searchTargets[groupStart].sampledIdx;
                const bandTop = thumbnailTop + s * stepY;
                const bandHeight = stepY;
                for (let k = 0; k < groupCount; k++) {
                    effectiveYs[groupStart + k] = bandTop + ((k + 0.5) / groupCount) * bandHeight;
                }
                groupStart = groupEnd;
            }

            const minGap = Math.min(4, Math.max(0.1, (codeHeight - 1) / Math.max(1, numTargets - 1)));
            // Forward pass: ensure monotonic progression with minGap
            effectiveYs[0] = Math.max(thumbnailTop, effectiveYs[0]);
            for (let t = 1; t < numTargets; t++) {
                effectiveYs[t] = Math.max(effectiveYs[t - 1] + minGap, effectiveYs[t]);
            }
            // Backward pass: squeeze from thumbnail bottom so matches never overflow the file
            effectiveYs[numTargets - 1] = Math.min(thumbnailTop + codeHeight, effectiveYs[numTargets - 1]);
            for (let t = numTargets - 2; t >= 0; t--) {
                effectiveYs[t] = Math.min(effectiveYs[t], effectiveYs[t + 1] - minGap);
            }
            for (let t = 0; t < numTargets; t++) {
                effectiveYs[t] = Math.max(thumbnailTop, effectiveYs[t]);
            }

            let closestTarget = searchTargets[0];
            let closestDist = Math.abs(cursorPos.py - effectiveYs[0]);
            for (let t = 1; t < numTargets; t++) {
                const dist = Math.abs(cursorPos.py - effectiveYs[t]);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestTarget = searchTargets[t];
                }
            }

            const HYSTERESIS_PX = Math.min(3, minGap * 0.75);
            const isActivelyWheeling = (Date.now() - lastWheelTime < 400) && wheelMousePos && Math.hypot(cursorPos.px - wheelMousePos.px, cursorPos.py - wheelMousePos.py) < 20;
            if (isActivelyWheeling) {
                // Keep wheel-selected target while user is rolling the wheel
            } else {
                wheelMousePos = null;
                if (hoverSnappedTarget && hoverSnappedTarget.fileUri === hoveredFile.uri) {
                    const curIdx = searchTargets.indexOf(hoverSnappedTarget);
                    if (curIdx !== -1) {
                        const curDist = Math.abs(cursorPos.py - effectiveYs[curIdx]);
                        if (closestDist < curDist - HYSTERESIS_PX) {
                            hoverSnappedTarget = closestTarget;
                            hoverScrollOffset = 0;
                        }
                    } else {
                        hoverSnappedTarget = closestTarget;
                        hoverScrollOffset = 0;
                    }
                } else {
                    hoverSnappedTarget = closestTarget;
                    hoverScrollOffset = 0;
                }
            }
        }
        hoveredLineIdx = hoverSnappedTarget.realLineIdx;
    } else {
        hoverSnappedTarget = null;
        if (isSampled) {
            const stride = hoveredFile.lineCount / lines.length;
            hoveredLineIdx = Math.max(0, Math.min(hoveredFile.lineCount - 1, Math.floor(visualLineIdx * stride)));
        } else {
            hoveredLineIdx = Math.max(0, Math.min(totalLines - 1, visualLineIdx));
        }
    }

    const centerLineIdx = Math.max(0, Math.min(totalLines - 1, hoveredLineIdx + hoverScrollOffset));
    hoverScrollOffset = centerLineIdx - hoveredLineIdx;

    const radius = TOOLTIP_CONFIG.lineRadius;
    let start = Math.max(0, centerLineIdx - radius);
    let end = Math.min(totalLines - 1, centerLineIdx + radius);

    if (start === 0) {
        end = Math.min(totalLines - 1, start + radius * 2);
    }
    if (end === totalLines - 1) {
        start = Math.max(0, end - radius * 2);
    }

    // Check if any required lines are missing from scan results and cache
    let missingLines = false;
    const uriCache = hoverLineCache[hoveredFile.uri] || (hoverLineCache[hoveredFile.uri] = {});

    for (let i = start; i <= end; i++) {
        let hasLine = false;
        if (hoveredFile.fullLines && hoveredFile.fullLines[i] !== undefined) {
            hasLine = true;
        } else if (uriCache[i]) {
            hasLine = true;
        } else if (!isSampled && hoveredFile.lines && hoveredFile.lines[i]) {
            hasLine = true;
        }
        if (!hasLine) {
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
    let targetBadge = "";
    if (hoverSnappedTarget) {
        const totalTargets = searchTargets.length;
        const curIdx = searchTargets.indexOf(hoverSnappedTarget);
        const matchLabel = totalTargets > 1 ? `MATCH ${curIdx >= 0 ? curIdx + 1 : 1} of ${totalTargets}` : "MATCH";
        if (hoverScrollOffset === 0) {
            targetBadge = ` <span style="background: ${withAlpha(ACCENT_SEARCH, 0.28)}; color: ${ACCENT_SEARCH}; border: 1px solid ${withAlpha(ACCENT_SEARCH, 0.6)}; border-radius: 3px; padding: 1px 5px; font-size: 10px; font-weight: 600; margin-left: 6px;">${matchLabel}</span>`;
        } else {
            const sign = hoverScrollOffset > 0 ? "+" : "";
            targetBadge = ` <span style="background: ${withAlpha(ACCENT_SEARCH, 0.28)}; color: ${ACCENT_SEARCH}; border: 1px solid ${withAlpha(ACCENT_SEARCH, 0.6)}; border-radius: 3px; padding: 1px 5px; font-size: 10px; font-weight: 600; margin-left: 6px;">${matchLabel}: L${hoveredLineIdx + 1} (${sign}${hoverScrollOffset})</span>`;
        }
    } else if (hoverScrollOffset !== 0) {
        const sign = hoverScrollOffset > 0 ? "+" : "";
        targetBadge = ` <span style="color: #a0a0a5; font-size: 10px; margin-left: 6px;">(${sign}${hoverScrollOffset})</span>`;
    }
    let tooltipHtml = `<div class="tooltip-filename">${escapeHtml(hoveredFile.path)} (Line ${centerLineIdx + 1})${targetBadge}${closeHint}</div>`;

    for (let i = start; i <= end; i++) {
        let line = null;
        if (hoveredFile.fullLines && hoveredFile.fullLines[i] !== undefined) {
            if (!uriCache[i]) {
                uriCache[i] = { text: hoveredFile.fullLines[i] };
            }
            line = uriCache[i];
        } else if (uriCache[i]) {
            line = uriCache[i];
        } else if (!isSampled && hoveredFile.lines && hoveredFile.lines[i]) {
            line = hoveredFile.lines[i];
        }

        const isHoveredLine = i === centerLineIdx;
        const lineText = line ? (typeof line.text === "string" ? line.text : String(line)) : "Loading line...";
        const lang = fileLang(hoveredFile);

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

        const isMatchLine = (rawSearchQuery && !searchInvalid &&
            textMatches(lineText, line && typeof line === "object" ? lowerLineText(line) : lineText.toLowerCase())) ||
            (hoverSnappedTarget && i === hoverSnappedTarget.realLineIdx);

        const isErrorLine = hoveredFile.errorLines ? !!hoveredFile.errorLines[i] : false;

        const gitType = (hoveredFile.gitStatus === "untracked" || hoveredFile.gitStatus === "added")
            ? "added"
            : (hoveredFile.gitChanges ? hoveredFile.gitChanges[i] : undefined);

        const indentMatch = lineText.match(/^[ \t]*/);
        const indentStr = indentMatch ? indentMatch[0].replace(/\t/g, "    ") : "";

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

        tooltipHtml += `<div style="${bgStyle}">${prefix}${indentStr}${renderedLineHtml}${suffix}</div>`;
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
/**
 * Asks the extension host to focus the panel when the webview lacks focus, throttled to once per
 * 500ms. Called only on click: requesting focus on hover pulled focus away from the terminal or
 * editor the user was typing in.
 */
function checkWindowFocus() {
    if (!document.hasFocus()) {
        const now = Date.now();
        if (now - lastFocusRequestTime > 500) { // Throttle IPC focus messages
            lastFocusRequestTime = now;
            vscode.postMessage({ command: "focusWindow" });
        }
    }
}


// Keyboard access to the canvas grid. The grid can hold thousands of tiles on one canvas, so
// instead of a DOM element per tile the canvas is a single focusable widget: arrow keys move a
// keyboard focus between the tiles/cards currently drawn (by position on screen), a polite live
// region announces the focused item, and actions reuse the mouse paths (jump message, context
// menu and drag handlers via synthetic events) so behavior cannot drift. Printable keys keep
// going to search, so only non-character keys are used here.
const srStatus = document.getElementById("sr-status");
let kbFocusKey = null;
let kbMode = false;
let syntheticPointer = false;

/** OS reduced-motion preference; sent with "jump" so the host honors workbench.reduceMotion "auto". */
function prefersReducedMotion() {
    try {
        return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
        return false;
    }
}

/** Screen-reader announcement through the polite live region. */
function announce(text) {
    if (!srStatus || !text) return;
    // Alternate a trailing no-break space so repeating the same text is still announced.
    srStatus.textContent = srStatus.textContent === text ? text + "\u00a0" : text;
}

/** Items the keyboard can focus in the current view: folder cards and drawn file tiles. */
function keyboardTargets() {
    const out = [];
    if (!data) return out;
    for (const card of data._folderCards || []) {
        out.push({ key: `card:${card.id}`, kind: "folder", rect: { x: card.x, y: card.y, w: card.w, h: card.h }, card });
    }
    for (const f of data.files || []) {
        if (f._cell) out.push({ key: `file:${f.id}`, kind: "file", rect: f._cell, file: f });
    }
    return out;
}

/** Matching tiles on screen, and folder cards holding a match (large workspaces show cards). */
function searchMatchTargets(all = keyboardTargets()) {
    if (!rawSearchQuery || searchInvalid) return [];
    return all.filter(t => t.kind === "file"
        ? fileMatchesSearch(t.file)
        : !!(t.card && t.card.group && t.card.group.files && t.card.group.files.some(fileMatchesSearch)));
}

/** While a search has matches on screen, arrow keys move only between them. */
function navigationTargets() {
    const all = keyboardTargets();
    const matches = searchMatchTargets(all);
    return matches.length > 0 ? matches : all;
}

function currentKeyboardTarget() {
    if (!kbFocusKey) return null;
    return keyboardTargets().find(t => t.key === kbFocusKey) || null;
}

function targetCenterClient(t) {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + t.rect.x + t.rect.w / 2, y: rect.top + t.rect.y + Math.min(t.rect.h / 2, 40) };
}

/**
 * Where a target sits on screen, for screen readers: its column, and its place within that column.
 * Columns are fixed in both layout modes (tall files only lengthen a column), so this stays true
 * where a row number would not.
 */
function describePosition(t) {
    const targets = keyboardTargets();
    const columns = [...new Set(targets.map(o => Math.round(o.rect.x)))].sort((a, b) => a - b);
    const x = Math.round(t.rect.x);
    const inColumn = targets.filter(o => Math.round(o.rect.x) === x).sort((a, b) => a.rect.y - b.rect.y);
    const col = columns.indexOf(x) + 1;
    const pos = inColumn.findIndex(o => o.key === t.key) + 1;
    return col > 0 && pos > 0 ? `column ${col} of ${columns.length}, ${pos} of ${inColumn.length} in the column` : "";
}

function describeTarget(t) {
    if (t.kind === "folder") {
        const g = t.card.group;
        const count = g && typeof g.fileCount === "number" ? `, ${g.fileCount} file${g.fileCount === 1 ? "" : "s"}` : "";
        const where = describePosition(t);
        return `Folder ${t.card.folderPath}${count}${where ? `, ${where}` : ""}. Press Enter to open.`;
    }
    const f = t.file;
    const parts = [f.path, `${f.lineCount || 0} lines`];
    const statusWord = { modified: "modified", added: "added", untracked: "untracked", deleted: "deleted" }[f.gitStatus];
    if (statusWord) parts.push(statusWord);
    if (f.errorCount > 0) parts.push(`${f.errorCount} error${f.errorCount === 1 ? "" : "s"}`);
    if (openFilesSet.has(f.uri)) parts.push("open in editor");
    if (searchQuery && !searchInvalid && fileMatchesSearch(f)) parts.push("matches search");
    const where = describePosition(t);
    if (where) parts.push(where);
    return parts.join(", ");
}

function focusKeyboardTarget(t, announceIt = true) {
    studyNote("keyboard");
    if (!t) return;
    kbMode = true;
    kbFocusKey = t.key;
    const center = targetCenterClient(t);
    lastMousePos = { x: center.x, y: center.y };
    // Existing hover-based shortcuts (Ctrl magnifier, Ctrl+C/X, Delete) act on the focused tile.
    hoveredFile = t.kind === "file" ? t.file : null;
    if (announceIt) announce(describeTarget(t));
    render();
    if (isCtrlDown && hoveredFile) updateHoverTooltip();
}

/** Nearest item in a direction: must lie ahead of the current center; ties prefer alignment. */
function neighborInDirection(from, targets, dx, dy) {
    const fc = { x: from.rect.x + from.rect.w / 2, y: from.rect.y + from.rect.h / 2 };
    let best = null;
    let bestScore = Infinity;
    for (const t of targets) {
        if (t.key === from.key) continue;
        const c = { x: t.rect.x + t.rect.w / 2, y: t.rect.y + t.rect.h / 2 };
        const ahead = dx !== 0 ? (c.x - fc.x) * dx : (c.y - fc.y) * dy;
        if (ahead <= 1) continue;
        const across = dx !== 0 ? Math.abs(c.y - fc.y) : Math.abs(c.x - fc.x);
        const score = ahead + across * 2;
        if (score < bestScore) {
            bestScore = score;
            best = t;
        }
    }
    return best;
}

function readingOrder(targets) {
    return [...targets].sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
}

function dispatchPointer(type, point, extra = {}) {
    syntheticPointer = true;
    try {
        canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button: 0, buttons: type === "mouseup" ? 0 : 1, ...extra }));
    } finally {
        syntheticPointer = false;
    }
}

/** Keyboard alternative to dragging: replays the mouse drag gesture one cell in a direction. */
function moveFocusedTile(t, dx, dy) {
    const grid = activeRenderGrid;
    if (!grid || !grid.cellW || !grid.cellH) return;
    const start = targetCenterClient(t);
    const end = { x: start.x + dx * grid.cellW, y: start.y + dy * grid.cellH };
    dispatchPointer("mousedown", start);
    dispatchPointer("mousemove", { x: start.x + dx * (DRAG_THRESHOLD + 2), y: start.y + dy * (DRAG_THRESHOLD + 2) });
    dispatchPointer("mousemove", end);
    dispatchPointer("mouseup", end);
    const moved = keyboardTargets().find(k => k.key === t.key);
    if (moved) {
        focusKeyboardTarget(moved, false);
        announce(`Moved ${t.kind === "folder" ? t.card.folderPath : t.file.path}`);
    }
}

function activateKeyboardTarget(t) {
    if (t.kind === "folder") {
        setFocusedFolderWithHistory(t.card.folderPath); // announces the folder
        const first = readingOrder(keyboardTargets())[0];
        if (first) focusKeyboardTarget(first, false);
        return;
    }
    postSwitchAway({
        command: "jump",
        studyMethod: "keyboard",
        uri: t.file.uri,
        line: 0,
        query: rawSearchQuery,
        matchCase,
        matchWholeWord,
        useRegex,
        searchInvalid,
        reduceMotion: prefersReducedMotion()
    });
}

window.addEventListener("keydown", event => {
    const activeEl = document.activeElement;
    if (activeEl && activeEl !== document.body && activeEl !== canvas) return;
    if (!data) return;
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const targets = navigationTargets();
    if (targets.length === 0) return;
    let current = currentKeyboardTarget();

    if (arrows[event.key] && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (!current) {
            focusKeyboardTarget(readingOrder(targets)[0]);
            return;
        }
        const [dx, dy] = arrows[event.key];
        if (event.altKey) {
            moveFocusedTile(current, dx, dy);
            return;
        }
        const next = neighborInDirection(current, targets, dx, dy);
        if (next) focusKeyboardTarget(next);
        return;
    }
    if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const ordered = readingOrder(targets);
        focusKeyboardTarget(event.key === "Home" ? ordered[0] : ordered[ordered.length - 1]);
        return;
    }
    if (!current) return;
    if (event.key === "Enter" || (event.key === " " && kbMode)) {
        event.preventDefault();
        activateKeyboardTarget(current);
        return;
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        dispatchPointer("contextmenu", targetCenterClient(current), { button: 2, buttons: 0 });
    }
});

/** Focus ring for the keyboard-focused item, drawn over every frame while keyboard mode is on. */
function drawKeyboardFocus() {
    if (!kbMode || !ctx || !data || document.hidden || isFrameFrozen()) return;
    const t = currentKeyboardTarget();
    if (!t) return;
    const highContrast = document.body.classList.contains("vscode-high-contrast") || document.body.classList.contains("vscode-high-contrast-light");
    ctx.save();
    ctx.strokeStyle = getThemeColor(highContrast ? "--vscode-contrastActiveBorder" : "--vscode-focusBorder", "#007fd4");
    ctx.lineWidth = highContrast ? 3 : 2;
    ctx.setLineDash([]);
    ctx.strokeRect(t.rect.x + 1, t.rect.y + 1, t.rect.w - 2, t.rect.h - 2);
    ctx.restore();
}

// Pointer hover feedback: an outline over the hovered tile or folder card, drawn as a positioned
// element so moving the pointer never repaints the canvas. Keyboard use shows the focus ring instead.
function hoveredFolderCardAt(pos) {
    if (!pos || !data || !data._folderCards) return null;
    for (const card of data._folderCards) {
        if (pointInRect(card, pos.px, pos.py)) return card;
    }
    return null;
}
/** Shows the outline for what the pointer is over; `resolve` re-runs the hit test after a render moved tiles. */
function updateHoverOutline(resolve) {
    if (!hoverOutline) return;
    const active = !kbMode && !draggingFile && !draggingFolder && cursorPos && data && !isFrameFrozen();
    if (active && resolve) hoveredFile = findFileAt(cursorPos.px, cursorPos.py);
    const card = active && !hoveredFile ? hoveredFolderCardAt(cursorPos) : null;
    schedulePrewarm(card);
    const rect = !active ? null : (hoveredFile && hoveredFile._cell) || card;
    hoverOutlineFile = rect && hoveredFile ? hoveredFile : null;
    canvas.style.cursor = rect ? "pointer" : "";
    const key = rect ? `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}` : "";
    if (key === hoverOutlineKey) return;
    hoverOutlineKey = key;
    if (!rect) {
        hoverOutline.style.display = "none";
        return;
    }
    hoverOutline.style.borderColor = BORDER_STYLES.dragging.color;
    hoverOutline.style.left = `${rect.x}px`;
    hoverOutline.style.top = `${rect.y}px`;
    hoverOutline.style.width = `${rect.w}px`;
    hoverOutline.style.height = `${rect.h}px`;
    hoverOutline.style.display = "block";
}
// Resting on a folder card prepares its files' syntax tokens in idle time, so a click that opens it
// spends its frames drawing rather than tokenizing. Only lines a tile can show are tokenized.
const PREWARM_DELAY_MS = 150;
const PREWARM_SLICE_MS = 6;
const PREWARM_MAX_FILES = 300;
const PREWARM_LINES_PER_FILE = 120;
function schedulePrewarm(card) {
    const path = card && card.group ? card.folderPath : null;
    if (path === prewarmPath) return;
    prewarmPath = path;
    if (prewarmTimer) clearTimeout(prewarmTimer);
    prewarmTimer = null;
    if (!path) return;
    prewarmTimer = setTimeout(() => {
        prewarmTimer = null;
        const files = (card.group.files || []).slice(0, PREWARM_MAX_FILES);
        let fileIdx = 0;
        let lineIdx = 0;
        const step = () => {
            if (prewarmPath !== path) return;
            const until = performance.now() + PREWARM_SLICE_MS;
            while (fileIdx < files.length && performance.now() < until) {
                const f = files[fileIdx];
                const lines = f && !f._linesPending && f.lines ? f.lines : [];
                const end = Math.min(lines.length, PREWARM_LINES_PER_FILE);
                for (let n = 0; lineIdx < end && n < 40; lineIdx++, n++) {
                    const line = lines[lineIdx];
                    // Same text and cache as renderFileThumbnailContent.
                    const trimmed = line && typeof line.text === "string" ? line.text.trimStart() : "";
                    if (trimmed && !line._tokens) line._tokens = tokenizeLine(trimmed, fileLang(f));
                }
                if (lineIdx >= end) {
                    fileIdx++;
                    lineIdx = 0;
                }
            }
            if (fileIdx < files.length) whenIdle(step);
        };
        whenIdle(step);
    }, PREWARM_DELAY_MS);
}

/** The file copy, cut, and delete keys act on: the keyboard-focused tile, or the outlined hovered tile. */
function shownActionTarget() {
    if (kbMode) {
        const t = currentKeyboardTarget();
        return t && t.file ? t.file : null;
    }
    return hoverOutlineFile && hoverOutlineFile === hoveredFile ? hoveredFile : null;
}

// MARK: mousedown
canvas.addEventListener("mousedown", event => {
    if (!syntheticPointer && kbMode) {
        // Pointer use hides the keyboard focus ring until the keyboard is used again.
        kbMode = false;
        render();
    }
    checkWindowFocus();
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
    // Fast path: if actively dragging, skip heavy hover checks, window focus, and tooltips
    if (draggingFile || draggingFolder) {
        if (event.buttons === 0) {
            clearDragState();
            render();
            return;
        }
        cursorPos = getCanvasPos(event);
        lastMousePos = { x: event.clientX, y: event.clientY };
        if (!dragRafId) {
            dragRafId = requestAnimationFrame(() => {
                dragRafId = null;
                updateDragTarget();
                render();
            });
        }
        isCtrlDown = false;
        hoverSnappedTarget = null;
        hoverScrollOffset = 0;
        lastHoveredFileUri = null;
        tooltip.style.display = "none";
        return;
    }

    // Safety check: if no mouse button is pressed, cancel any pending candidate drag
    if ((candidateFile || candidateFolder) && event.buttons === 0) {
        candidateFile = null;
        candidateFolder = null;
    }

    lastMousePos = { x: event.clientX, y: event.clientY };
    cursorPos = getCanvasPos(event);
    hoveredFile = findFileAt(cursorPos.px, cursorPos.py);
    updateHoverOutline(false);
    if (hoveredFile && studyActive) studyNote("hover", hoveredFile.id);
    if (hoveredFile && hoveredFile.isPdf) requestPdfJs(true);

    if (candidateFolder && !draggingFolder && !draggingFile) {
        const dx = Math.abs(candidateFolder.startX - cursorPos.px);
        const dy = Math.abs(candidateFolder.startY - cursorPos.py);

        // only start dragging if cursor has moved more than the threshold
        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            draggingFolder = candidateFolder.card;
            if (typeof document !== "undefined") {
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
                    const c = candidateFolder.card;
                    if (c && typeof c.x === "number") {
                        const dpr = Math.min(window.devicePixelRatio || 1, 2);
                        bgCtx.save();
                        bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
                        bgCtx.fillStyle = withAlpha(TILE_BACKGROUND, 0.7);
                        bgCtx.fillRect(c.x, c.y, c.w, c.h);
                        bgCtx.restore();
                    }
                }
                dragBackgroundCanvas = cachedDragBackgroundCanvas;
            }
            candidateFolder = null;
            updateDragTarget();
            render();
            return;
        }
    }

    if (candidateFile && !draggingFile && !draggingFolder) {
        const dx = Math.abs(candidateFile.startX - cursorPos.px);
        const dy = Math.abs(candidateFile.startY - cursorPos.py);

        // only start dragging if cursor has moved more than the threshold
        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            draggingFile = candidateFile.file;
            if (typeof document !== "undefined") {
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
                    const c = candidateFile.file._cell;
                    if (c && typeof c.x === "number") {
                        const dpr = Math.min(window.devicePixelRatio || 1, 2);
                        bgCtx.save();
                        bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
                        bgCtx.fillStyle = withAlpha(TILE_BACKGROUND, 0.7);
                        bgCtx.fillRect(c.x, c.y, c.w, c.h);
                        bgCtx.restore();
                    }
                }
                dragBackgroundCanvas = cachedDragBackgroundCanvas;
            }
            candidateFile = null;
            updateDragTarget();
            render();
            return;
        }
    }

    if (isControlModifier(event)) {
        isCtrlDown = true;
        updateHoverTooltip();
    } else {
        isCtrlDown = false;
        tooltip.style.display = "none";
        hoverSnappedTarget = null;
        hoverScrollOffset = 0;
        lastHoveredFileUri = null;
        wheelMousePos = null;
    }
});

/** The drop row of a folder-card drag in flow rows (cards are drawn at their current heights). */
function cardFlowTargetRow(order, allocations, wrapRows) {
    const displayCellsById = {};
    if (activeRenderGrid && activeRenderGrid.layout && activeRenderGrid.layout.placements) {
        for (const p of activeRenderGrid.layout.placements) {
            const id = p.item && p.item.id;
            if (id) displayCellsById[id] = p.nCells;
        }
    }
    return displayToFlowRow(order, allocations, displayCellsById, wrapRows, dragTarget.col, dragTarget.row);
}

/**
 * Lays every root tile out again from data.fileOrder (after a drop), as the host's buildSpanningGrid
 * will: flow cells decide columns, current heights decide drawn rows. Updates slots and slotOccupancy.
 */
function relayoutRootSpanning(wrapRows) {
    if (!data || !data.files) return;
    const layout = buildSpanningGridLocal(data.files, BASE_GRID_ASPECT, data.fileOrder, 0, 0, 60, getCompressionPct(), wrapRows, scopeFootprints("root"), scopeFlowCells("root"));
    slotOccupancy.clear();
    for (const p of layout.placements) {
        const f = p.file;
        f.slot = [p.col, p.row];
        f.slots = p.slots.map(s => [...s]);
        f.nCells = p.nCells;
        for (const s of f.slots) slotOccupancy.set(`${s[0]},${s[1]}`, f);
    }
    if (data.layout) {
        // The grid keeps the host's size and grows only where a tile now reaches past it. The local
        // builder's own rows/cols come from its folder sizing (an aspect formula unlike the host's),
        // which right after a reflow added an empty row until the host's next payload.
        let right = 0;
        let bottom = 0;
        for (const p of layout.placements) {
            right = Math.max(right, p.col + 1);
            bottom = Math.max(bottom, p.row + p.nCells);
        }
        data.layout.wrapRows = wrapRows;
        data.layout.cols = Math.max(data.layout.cols || 1, right);
        data.layout.rows = Math.max(data.layout.rows || 1, bottom);
    }
}

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
            const targetFocusedFolder = activeRenderGrid.focusedFolder || (focusedFolder || null);
            const currentCardIds = (targetFocusedFolder && data.folderCardOrders && data.folderCardOrders[targetFocusedFolder])
                ? data.folderCardOrders[targetFocusedFolder]
                : ((data.cardOrder && data.cardOrder.length > 0)
                    ? data.cardOrder
                    : activeRenderGrid.orderedItems.map(it => it ? it.id : ""));
            const sourceCardId = "folder:" + draggingFolder.folderPath;

            if (activeRenderGrid.isSpanning && dragTarget) {
                const scopedItems = activeRenderGrid.spanningItems || activeRenderGrid.orderedItems.filter(Boolean);
                const scopedIds = scopedItems.map(it => it.id);
                const allocations = dragFlowAllocations(`cards:${targetFocusedFolder || ""}`, scopedItems, currentCardIds);
                const wrapRows = activeRenderGrid.wrapRows || (data.layout && data.layout.wrapRows) || (data.layout && data.layout.rows) || 1;
                const maxAllowedCols = activeRenderGrid.cols;
                const maxAllowedRows = activeRenderGrid.rows;

                const res = reorderSpanningItems(
                    scopedIds,
                    currentCardIds,
                    allocations,
                    sourceCardId,
                    dragTarget.col,
                    cardFlowTargetRow(currentCardIds, allocations, wrapRows),
                    maxAllowedCols,
                    maxAllowedRows,
                    wrapRows
                );

                if (res.rejected) {
                    // No swap exists without splitting a card: it goes back where it was.
                    announce("Not enough room to move the folder there");
                    clearDragState();
                    render();
                    return;
                }

                if (targetFocusedFolder) {
                    if (!data.folderCardOrders) data.folderCardOrders = {};
                    data.folderCardOrders[targetFocusedFolder] = res.newOrder;
                    if (!data.folderCardWrapRows) data.folderCardWrapRows = {};
                    data.folderCardWrapRows[targetFocusedFolder] = res.rows;
                } else {
                    data.cardOrder = res.newOrder;
                    data.cardWrapRows = res.rows;
                }

                vscode.postMessage({
                    command: "swapCardItems",
                    sourceId: sourceCardId,
                    targetId: dragTarget.item ? dragTarget.item.id : null,
                    targetIsEmpty: !dragTarget.item,
                    targetCol: dragTarget.col,
                    targetRow: dragTarget.row,
                    currentCardIds: res.newOrder,
                    isSpanning: true,
                    wrapRows: res.rows,
                    focusedFolder: targetFocusedFolder || ""
                });
            } else {
                let updatedCardOrder = [...currentCardIds];
                const fromIdx = updatedCardOrder.indexOf(sourceCardId);
                if (dragTarget && dragTarget.item && dragTarget.item.id !== sourceCardId) {
                    const toIdx = updatedCardOrder.indexOf(dragTarget.item.id);
                    if (fromIdx !== -1 && toIdx !== -1) {
                        updatedCardOrder[fromIdx] = dragTarget.item.id;
                        updatedCardOrder[toIdx] = sourceCardId;
                    }
                    if (targetFocusedFolder) {
                        if (!data.folderCardOrders) data.folderCardOrders = {};
                        data.folderCardOrders[targetFocusedFolder] = updatedCardOrder;
                    } else {
                        data.cardOrder = updatedCardOrder;
                    }
                    vscode.postMessage({
                        command: "swapCardItems",
                        sourceId: sourceCardId,
                        targetId: dragTarget.item.id,
                        currentCardIds: updatedCardOrder,
                        focusedFolder: targetFocusedFolder || ""
                    });
                } else if (dragTarget && !dragTarget.item) {
                    const slotIdx = activeRenderGrid.layout && activeRenderGrid.layout.slots
                        ? activeRenderGrid.layout.slots.findIndex(s => s[0] === dragTarget.col && s[1] === dragTarget.row)
                        : -1;
                    const targetSlot = slotIdx !== -1 ? slotIdx : dragTarget.row * activeRenderGrid.cols + dragTarget.col;
                    if (targetSlot >= 0) {
                        const cardOrderLengthBefore = updatedCardOrder.length;
                        if (fromIdx !== -1) updatedCardOrder[fromIdx] = "";
                        while (updatedCardOrder.length <= targetSlot) {
                            updatedCardOrder.push("");
                        }
                        updatedCardOrder[targetSlot] = sourceCardId;
                        // Padding is trimmed, never below the original length: a shorter order can shrink
                        // the card grid and move every card (spatial stability). Only Reflow Layout compacts.
                        while (updatedCardOrder.length > cardOrderLengthBefore && !updatedCardOrder[updatedCardOrder.length - 1]) {
                            updatedCardOrder.pop();
                        }
                    }
                    if (targetFocusedFolder) {
                        if (!data.folderCardOrders) data.folderCardOrders = {};
                        data.folderCardOrders[targetFocusedFolder] = updatedCardOrder;
                    } else {
                        data.cardOrder = updatedCardOrder;
                    }
                    vscode.postMessage({
                        command: "swapCardItems",
                        sourceId: sourceCardId,
                        targetId: null,
                        targetIsEmpty: true,
                        targetSlotIdx: targetSlot,
                        maxCapacity: activeRenderGrid.cols * activeRenderGrid.rows,
                        currentCardIds: updatedCardOrder,
                        focusedFolder: targetFocusedFolder || ""
                    });
                }
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
            const targetFocusedFolder = activeRenderGrid.focusedFolder || (focusedFolder || null);
            const currentCardIds = (targetFocusedFolder && data.folderCardOrders && data.folderCardOrders[targetFocusedFolder])
                ? data.folderCardOrders[targetFocusedFolder]
                : ((data.cardOrder && data.cardOrder.length > 0)
                    ? data.cardOrder
                    : activeRenderGrid.orderedItems.map(it => it ? it.id : ""));
            const sourceCardId = draggingFile.id;

            if (dragTarget && dragTarget.item && dragTarget.item.id === sourceCardId) {
                clearDragState();
                render();
                return;
            }

            if (activeRenderGrid.isSpanning && dragTarget) {
                const scopedItems = activeRenderGrid.spanningItems || activeRenderGrid.orderedItems.filter(Boolean);
                const scopedIds = scopedItems.map(it => it.id);
                const allocations = dragFlowAllocations(`cards:${targetFocusedFolder || ""}`, scopedItems, currentCardIds);
                const wrapRows = activeRenderGrid.wrapRows || (data.layout && data.layout.wrapRows) || (data.layout && data.layout.rows) || 1;
                const maxAllowedCols = activeRenderGrid.cols;
                const maxAllowedRows = activeRenderGrid.rows;

                const res = reorderSpanningItems(
                    scopedIds,
                    currentCardIds,
                    allocations,
                    sourceCardId,
                    dragTarget.col,
                    cardFlowTargetRow(currentCardIds, allocations, wrapRows),
                    maxAllowedCols,
                    maxAllowedRows,
                    wrapRows
                );

                if (res.rejected) {
                    // No swap exists without splitting a card: it goes back where it was.
                    announce("Not enough room to move the folder there");
                    clearDragState();
                    render();
                    return;
                }

                if (targetFocusedFolder) {
                    if (!data.folderCardOrders) data.folderCardOrders = {};
                    data.folderCardOrders[targetFocusedFolder] = res.newOrder;
                    if (!data.folderCardWrapRows) data.folderCardWrapRows = {};
                    data.folderCardWrapRows[targetFocusedFolder] = res.rows;
                } else {
                    data.cardOrder = res.newOrder;
                    data.cardWrapRows = res.rows;
                }

                vscode.postMessage({
                    command: "swapCardItems",
                    sourceId: sourceCardId,
                    targetId: dragTarget.item ? dragTarget.item.id : null,
                    targetIsEmpty: !dragTarget.item,
                    targetCol: dragTarget.col,
                    targetRow: dragTarget.row,
                    currentCardIds: res.newOrder,
                    isSpanning: true,
                    wrapRows: res.rows,
                    focusedFolder: targetFocusedFolder || ""
                });
            } else {
                let updatedCardOrder = [...currentCardIds];
                const fromIdx = updatedCardOrder.indexOf(sourceCardId);
                if (dragTarget && dragTarget.item && dragTarget.item.id !== sourceCardId) {
                    const toIdx = updatedCardOrder.indexOf(dragTarget.item.id);
                    if (fromIdx !== -1 && toIdx !== -1) {
                        updatedCardOrder[fromIdx] = dragTarget.item.id;
                        updatedCardOrder[toIdx] = sourceCardId;
                    }
                    if (targetFocusedFolder) {
                        if (!data.folderCardOrders) data.folderCardOrders = {};
                        data.folderCardOrders[targetFocusedFolder] = updatedCardOrder;
                    } else {
                        data.cardOrder = updatedCardOrder;
                    }
                    vscode.postMessage({
                        command: "swapCardItems",
                        sourceId: sourceCardId,
                        targetId: dragTarget.item.id,
                        currentCardIds: updatedCardOrder,
                        focusedFolder: targetFocusedFolder || ""
                    });
                } else if (dragTarget && !dragTarget.item) {
                    const slotIdx = activeRenderGrid.layout && activeRenderGrid.layout.slots
                        ? activeRenderGrid.layout.slots.findIndex(s => s[0] === dragTarget.col && s[1] === dragTarget.row)
                        : -1;
                    const targetSlot = slotIdx !== -1 ? slotIdx : dragTarget.row * activeRenderGrid.cols + dragTarget.col;
                    if (targetSlot >= 0) {
                        const cardOrderLengthBefore = updatedCardOrder.length;
                        if (fromIdx !== -1) updatedCardOrder[fromIdx] = "";
                        while (updatedCardOrder.length <= targetSlot) {
                            updatedCardOrder.push("");
                        }
                        updatedCardOrder[targetSlot] = sourceCardId;
                        // Padding is trimmed, never below the original length: a shorter order can shrink
                        // the card grid and move every card (spatial stability). Only Reflow Layout compacts.
                        while (updatedCardOrder.length > cardOrderLengthBefore && !updatedCardOrder[updatedCardOrder.length - 1]) {
                            updatedCardOrder.pop();
                        }
                    }
                    if (targetFocusedFolder) {
                        if (!data.folderCardOrders) data.folderCardOrders = {};
                        data.folderCardOrders[targetFocusedFolder] = updatedCardOrder;
                    } else {
                        data.cardOrder = updatedCardOrder;
                    }
                    vscode.postMessage({
                        command: "swapCardItems",
                        sourceId: sourceCardId,
                        targetId: null,
                        targetIsEmpty: true,
                        targetSlotIdx: targetSlot,
                        maxCapacity: activeRenderGrid.cols * activeRenderGrid.rows,
                        currentCardIds: updatedCardOrder,
                        focusedFolder: targetFocusedFolder || ""
                    });
                }
            }
        } else if (dragTarget) {
            // Dropped where it already is: nothing to do. Only the top cell counts; a tall tile moved
            // down by one row still covers its old cells, and that move must happen.
            const srcCell = draggingFile._cell;
            const srcTopCol = srcCell && dragTarget.cellW ? Math.round((srcCell.x - GRID_SIDE_MARGIN) / dragTarget.cellW) : null;
            const srcTopRow = srcCell && dragTarget.cellH ? Math.round((srcCell.y - GRID_TOP_MARGIN) / dragTarget.cellH) : null;
            const droppedInPlace = srcTopCol !== null
                ? dragTarget.col === srcTopCol && dragTarget.row === srcTopRow
                : !!(dragTarget.file && dragTarget.file.id === draggingFile.id);
            if (droppedInPlace) {
                clearDragState();
                render();
                return;
            }

            const slotIdx = (activeRenderGrid && activeRenderGrid.layout && activeRenderGrid.layout.slots)
                ? activeRenderGrid.layout.slots.findIndex(s => s[0] === dragTarget.col && s[1] === dragTarget.row)
                : -1;
            const targetSlotIdx = slotIdx !== -1 ? slotIdx : (dragTarget.row * (dragTarget.gridCols || (activeRenderGrid && activeRenderGrid.cols) || 1) + dragTarget.col);

            // Optimistically update in-memory order for instant zero-latency visual response
            const isSpanning = !!(data && (data.mode === "spanning_grid" || data.layoutMode === "spanning_grid"));
            let spanningRes = null;
            if (isSpanning) {
                const scopedFiles = (activeRenderGrid && activeRenderGrid.files)
                    ? activeRenderGrid.files
                    : (data.files || []);
                const scopedIds = scopedFiles.map(f => f.id);
                const currentOrder = focusedFolder
                    ? ((data.folderOrders && data.folderOrders[focusedFolder]) ? [...data.folderOrders[focusedFolder]] : [...scopedIds])
                    : (data.fileOrder ? [...data.fileOrder] : [...scopedIds]);
                const allocations = dragFlowAllocations(
                    focusedFolder ? `folder:${focusedFolder}` : "root",
                    scopedFiles.map(f => ({ id: f.id, type: "file", file: f })),
                    currentOrder
                );
                const wrapRows = (activeRenderGrid && activeRenderGrid.wrapRows) || (data.layout && data.layout.wrapRows) || (data.layout && data.layout.rows) || 1;
                const maxAllowedCols = (activeRenderGrid && activeRenderGrid.cols) || (data.layout && data.layout.cols) || 2;
                const maxAllowedRows = (activeRenderGrid && activeRenderGrid.rows) || (data.layout && data.layout.rows) || 2;

                // The drop row is drawn (display) rows; files that grew or shrank make those differ
                // from the flow rows the reorder works in, so convert in the target column.
                const displayCellsById = {};
                if (activeRenderGrid && activeRenderGrid.layout && activeRenderGrid.layout.placements) {
                    for (const p of activeRenderGrid.layout.placements) {
                        if (p.file) displayCellsById[p.file.id] = p.nCells;
                    }
                } else {
                    for (const f of scopedFiles) displayCellsById[f.id] = f.nCells || allocations[f.id] || 1;
                }
                const flowTargetRow = displayToFlowRow(currentOrder, allocations, displayCellsById, wrapRows, dragTarget.col, dragTarget.row);

                spanningRes = reorderSpanningItems(
                    scopedIds,
                    currentOrder,
                    allocations,
                    draggingFile.id,
                    dragTarget.col,
                    flowTargetRow,
                    maxAllowedCols,
                    maxAllowedRows,
                    wrapRows
                );

                if (spanningRes.rejected) {
                    // No swap exists without splitting a tile: the tile goes back where it was.
                    announce("Not enough room to move the file there");
                    clearDragState();
                    render();
                    return;
                }

                if (focusedFolder) {
                    if (!data.folderOrders) data.folderOrders = {};
                    data.folderOrders[focusedFolder] = spanningRes.newOrder;
                    if (!data.folderWrapRows) data.folderWrapRows = {};
                    data.folderWrapRows[focusedFolder] = spanningRes.rows;
                } else {
                    data.fileOrder = spanningRes.newOrder;
                    // Every tile from the new order, laid out as the host will (buildSpanningGridLocal is
                    // the twin of its buildSpanningGrid). Moving only the two swapped tiles, and pinning
                    // them over later payloads, drew them over tiles the host had placed elsewhere.
                    relayoutRootSpanning(spanningRes.rows);
                    pendingRootOrder = [...spanningRes.newOrder];
                    pendingRootWrap = spanningRes.rows;
                    pendingRootSince = performance.now();
                    pendingRootSeq = reorderSeq + 1; // the seq of the reorderFile posted below
                }
            } else if (focusedFolder) {
                if (!data.folderOrders) data.folderOrders = {};
                let currentOrder = data.folderOrders[focusedFolder] ? [...data.folderOrders[focusedFolder]] : [];
                if (currentOrder.length === 0 && activeRenderGrid && activeRenderGrid.files) {
                    currentOrder = activeRenderGrid.files.map(f => f.id);
                }
                const srcIdx = currentOrder.indexOf(draggingFile.id);
                if (dragTarget.file) {
                    const tgtIdx = currentOrder.indexOf(dragTarget.file.id);
                    if (srcIdx !== -1 && tgtIdx !== -1) {
                        if (dragReorderMode === "shift") {
                            const [item] = currentOrder.splice(srcIdx, 1);
                            currentOrder.splice(tgtIdx, 0, item);
                        } else {
                            const tmp = currentOrder[srcIdx];
                            currentOrder[srcIdx] = currentOrder[tgtIdx];
                            currentOrder[tgtIdx] = tmp;
                        }
                    }
                } else if (targetSlotIdx >= 0) {
                    while (currentOrder.length <= targetSlotIdx) {
                        currentOrder.push("");
                    }
                    if (srcIdx !== -1) {
                        currentOrder[srcIdx] = "";
                    }
                    currentOrder[targetSlotIdx] = draggingFile.id;
                }
                data.folderOrders[focusedFolder] = currentOrder;
            } else {
                const srcFile = data.files ? data.files.find(f => f.id === draggingFile.id) : null;
                const tgtFile = dragTarget.file ? (data.files ? data.files.find(f => f.id === dragTarget.file.id) : null) : null;

                if (srcFile && tgtFile && srcFile.slot && tgtFile.slot) {
                    const oldSrcSlot = [...srcFile.slot];
                    const oldTgtSlot = [...tgtFile.slot];

                    srcFile.slot = oldTgtSlot;
                    srcFile.slots = [oldTgtSlot];

                    tgtFile.slot = oldSrcSlot;
                    tgtFile.slots = [oldSrcSlot];

                    slotOccupancy.set(`${oldTgtSlot[0]},${oldTgtSlot[1]}`, srcFile);
                    slotOccupancy.set(`${oldSrcSlot[0]},${oldSrcSlot[1]}`, tgtFile);

                    userReorderedFileSlots.set(srcFile.id, { slot: [...srcFile.slot], slots: [[...srcFile.slot]] });
                    userReorderedFileSlots.set(tgtFile.id, { slot: [...tgtFile.slot], slots: [[...tgtFile.slot]] });

                    if (data.fileOrder && Array.isArray(data.fileOrder)) {
                        const sIdx = data.fileOrder.indexOf(srcFile.id);
                        const tIdx = data.fileOrder.indexOf(tgtFile.id);
                        if (sIdx !== -1 && tIdx !== -1) {
                            const tmp = data.fileOrder[sIdx];
                            data.fileOrder[sIdx] = data.fileOrder[tIdx];
                            data.fileOrder[tIdx] = tmp;
                        }
                    }
                } else if (srcFile) {
                    const oldSrcSlot = srcFile.slot ? [...srcFile.slot] : null;
                    if (oldSrcSlot) {
                        if (slotOccupancy.get(`${oldSrcSlot[0]},${oldSrcSlot[1]}`) === srcFile) {
                            slotOccupancy.delete(`${oldSrcSlot[0]},${oldSrcSlot[1]}`);
                        }
                    }
                    const newSlot = [dragTarget.col, dragTarget.row];
                    srcFile.slot = newSlot;
                    srcFile.slots = [newSlot];
                    slotOccupancy.set(`${newSlot[0]},${newSlot[1]}`, srcFile);

                    userReorderedFileSlots.set(srcFile.id, { slot: [...srcFile.slot], slots: [[...srcFile.slot]] });

                    if (data.fileOrder && Array.isArray(data.fileOrder) && targetSlotIdx >= 0) {
                        const sIdx = data.fileOrder.indexOf(srcFile.id);
                        while (data.fileOrder.length <= targetSlotIdx) {
                            data.fileOrder.push("");
                        }
                        if (sIdx !== -1) {
                            data.fileOrder[sIdx] = "";
                        }
                        data.fileOrder[targetSlotIdx] = srcFile.id;
                    }
                }
            }

            vscode.postMessage({
                command: "reorderFile",
                sourceId: draggingFile.id,
                targetId: dragTarget.file ? dragTarget.file.id : null,
                targetIsEmpty: !dragTarget.file,
                targetCol: dragTarget.col,
                targetRow: dragTarget.row,
                targetSlotIdx: targetSlotIdx,
                targetGridCols: dragTarget.gridCols || (activeRenderGrid && activeRenderGrid.cols) || data.layout.cols,
                targetGridRows: (activeRenderGrid && activeRenderGrid.rows) || data.layout.rows,
                targetWrapRows: (activeRenderGrid && activeRenderGrid.wrapRows) || undefined,
                currentOrder: spanningRes ? spanningRes.newOrder : undefined,
                wrapRows: spanningRes ? spanningRes.rows : undefined,
                // Echoed by the host in later payloads (data reorderSeq), see keepPendingRootOrder.
                reorderSeq: ++reorderSeq,
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
            openFilesSet.delete(file.uri);
            openFilesVersion++;
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
            postSwitchAway({
                command: "switchTab",
                studyMethod: "view_band",
                uri: file.uri
            });
            return;
        }

        // Clicked inside media card body -> switch/open tab without line jump
        if (file.isImage || file.isPdf) {
            postSwitchAway({
                command: "switchTab",
                uri: file.uri
            });
            return;
        }

        // Clicked inside the thumbnail body -> jump to line in document
        const thumbnailTop = c.y + headerHeight;
        const thumbnailHeight = Math.max(1, c.h - 34);
        const lines = file.lines || [];
        const lineCount = Math.max(lines.length, 1);
        const stepY = Math.min(thumbnailHeight / lineCount, THUMBNAIL_MAX_LINE_PITCH);
        const cursorOffsetY = Math.max(0, cursorPos.py - thumbnailTop);
        const visualLinesCount = lines.length;
        const visualLineIdx = Math.max(0, Math.min(visualLinesCount - 1, Math.floor(cursorOffsetY / stepY)));

        let line = visualLineIdx;
        if (file.lineCount && file.lineCount > lines.length) {
            const stride = file.lineCount / lines.length;
            line = Math.max(0, Math.min(file.lineCount - 1, Math.floor(visualLineIdx * stride)));
        } else {
            const totalLines = Math.max(file.lineCount || lines.length, 1);
            line = Math.max(0, Math.min(totalLines - 1, visualLineIdx));
        }

        if (isCtrlDown && hoverSnappedTarget && hoverSnappedTarget.fileUri === file.uri) {
            const totalLines = Math.max(file.lineCount || lines.length, 1);
            line = Math.max(0, Math.min(totalLines - 1, hoverSnappedTarget.realLineIdx + hoverScrollOffset));
        } else if (isCtrlDown && hoverScrollOffset !== 0 && lastHoveredFileUri === file.uri) {
            const totalLines = Math.max(file.lineCount || lines.length, 1);
            line = Math.max(0, Math.min(totalLines - 1, line + hoverScrollOffset));
        }

        // query/matchCase/matchWholeWord/useRegex/searchInvalid mirror the search state
        // above so extension.ts's "jump" handler can flash the same lines this webview
        // considers matches — see its handler for the mirrored pattern-building logic.
        postSwitchAway({
            command: "jump",
            uri: file.uri,
            line,
            query: rawSearchQuery,
            matchCase,
            matchWholeWord,
            useRegex,
            searchInvalid,
            reduceMotion: prefersReducedMotion()
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
    cursorPos = null;
    hoverSnappedTarget = null;
    hoverScrollOffset = 0;
    lastHoveredFileUri = null;
    wheelMousePos = null;
    render();
});

document.addEventListener("mouseleave", () => {
    isCtrlDown = false;
    cursorPos = null;
    tooltip.style.display = "none";
    hoverSnappedTarget = null;
    hoverScrollOffset = 0;
    lastHoveredFileUri = null;
    wheelMousePos = null;
});

const contextMenu = document.getElementById("context-menu");

/** Hides the custom right-click context menu, returning keyboard focus to the grid if it was in the menu. */
function hideContextMenu() {
    if (contextMenu) {
        const hadFocus = contextMenu.contains(document.activeElement);
        contextMenu.style.display = "none";
        if (hadFocus) canvas.focus();
    }
}

/** True while keyboard focus is inside the context menu (search typing and file keys stand aside). */
function contextMenuHasFocus() {
    return !!(contextMenu && document.activeElement && contextMenu.contains(document.activeElement));
}

// Keyboard use of the context menu: Up/Down/Home/End move between items, Enter or Space runs one,
// Escape or Tab closes it and returns to the grid.
if (contextMenu) {
    contextMenu.addEventListener("keydown", event => {
        const items = [...contextMenu.querySelectorAll('[role="menuitem"]')];
        if (items.length === 0) return;
        const index = items.indexOf(document.activeElement);
        let next = null;
        if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
        else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
        else if (event.key === "Home") next = items[0];
        else if (event.key === "End") next = items[items.length - 1];
        else if ((event.key === "Enter" || event.key === " ") && index !== -1) {
            event.preventDefault();
            event.stopPropagation();
            items[index].click();
            return;
        } else if (event.key === "Escape" || event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            hideContextMenu();
            return;
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        next.focus();
    });
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
        return `<div class="menu-item${danger ? " danger" : ""}" id="${id}" role="menuitem" tabindex="-1"><span class="menu-item-label">${escapeHtml(label)}</span>${shortcut ? `<span class="menu-item-key" aria-hidden="true">${escapeHtml(shortcut)}</span>` : ""}</div>`;
    }

    if (targetFile) {
        contextMenu.innerHTML = `
            ${renderMenuItem("menu-open", "Open")}
            ${renderMenuItem("menu-open-side", "Open to the Side", isMacPlatform ? "⌘Enter" : "Ctrl+Enter")}
            ${renderMenuItem("menu-reveal", "Reveal in Explorer")}
            ${renderMenuItem("menu-open-containing-folder", "Open Containing Folder")}
            ${renderMenuItem("menu-open-with", "Open With...")}
            ${renderMenuItem("menu-open-terminal", "Open in Integrated Terminal")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-select-compare", "Select for Compare")}
            ${renderMenuItem("menu-compare-selected", "Compare with Selected")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-open-timeline", "Open Timeline")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-cut", "Cut", isMacPlatform ? "⌘X" : "Ctrl+X")}
            ${renderMenuItem("menu-copy", "Copy", isMacPlatform ? "⌘C" : "Ctrl+C")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-copy-path", "Copy Path")}
            ${renderMenuItem("menu-copy-rel-path", "Copy Relative Path")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-run-tests", "Run Tests")}
            ${renderMenuItem("menu-debug-tests", "Debug Tests")}
            ${renderMenuItem("menu-coverage-tests", "Run Tests with Coverage")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-rename", "Rename...", "F2")}
            ${renderMenuItem("menu-delete", "Delete", isMacPlatform ? "⌦" : "Delete", true)}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-ignore", "Ignore in Thumbview")}
        `;

        document.getElementById("menu-open").onclick = () => {
            hideContextMenu();
            postSwitchAway({ command: "jump", uri: targetFile.uri, line: 0 });
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
            ${renderMenuItem("menu-reveal-folder", "Reveal in Explorer")}
            ${renderMenuItem("menu-terminal-folder", "Open in Integrated Terminal")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-new-file-folder", "New File...")}
            ${renderMenuItem("menu-new-subfolder", "New Folder...")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-cut-folder", "Cut Folder")}
            ${renderMenuItem("menu-copy-folder", "Copy Folder")}
            ${renderMenuItem("menu-paste-folder", "Paste")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-copy-folder-path", "Copy Path")}
            ${renderMenuItem("menu-copy-folder-rel-path", "Copy Relative Path")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-rename-folder", "Rename...")}
            ${renderMenuItem("menu-delete-folder", "Delete Folder", "", true)}
            <div class="menu-separator" role="separator"></div>
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
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-space-paste", "Paste", isMacPlatform ? "⌘V" : "Ctrl+V")}
            <div class="menu-separator" role="separator"></div>
            ${renderMenuItem("menu-space-expand", "Expand Grid Space")}
            ${renderMenuItem("menu-space-reduce", "Reduce Grid Space")}
            <div class="menu-separator" role="separator"></div>
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
            triggerExpandSpace();
        };
        document.getElementById("menu-space-reduce").onclick = () => {
            hideContextMenu();
            triggerReduceSpace();
        };
        document.getElementById("menu-space-reflow").onclick = () => {
            hideContextMenu();
            userReorderedFileSlots.clear();
            const targetFolder = focusedFolder === "(root files)/" ? "" : (focusedFolder || "");
            if (targetFolder) {
                if (data) {
                    if (data.folderOrders) delete data.folderOrders[targetFolder];
                    if (data.folderWrapRows) delete data.folderWrapRows[targetFolder];
                    if (data.folderCardOrders) delete data.folderCardOrders[targetFolder];
                    if (data.folderCardWrapRows) delete data.folderCardWrapRows[targetFolder];
                    if (data.folderExtraCols) delete data.folderExtraCols[targetFolder];
                    if (data.folderExtraRows) delete data.folderExtraRows[targetFolder];
                }
            } else if (data) {
                data.folderOrders = {};
                data.folderWrapRows = {};
                data.folderCardOrders = {};
                data.folderCardWrapRows = {};
                data.folderExtraCols = {};
                data.folderExtraRows = {};
                data.extraCols = 0;
                data.extraRows = 0;
            }
            render();
            vscode.postMessage({ command: "reflow", focusedFolder: targetFolder });
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
    // Opened from the keyboard (Shift+F10, the Menu key): focus the first item. From the mouse the
    // menu itself takes focus, so the arrow keys still reach it and typing does not go to search.
    const firstItem = contextMenu.querySelector('[role="menuitem"]');
    if (syntheticPointer && firstItem) firstItem.focus();
    else contextMenu.focus();
});

// Re-render canvas automatically when user switches VS Code color theme. VS Code signals a theme
// change through body's class and its style attribute (the --vscode-* variables), but the reveal gate
// also writes body.style.opacity on every hide and reveal; reacting to that cleared every tile and
// mosaic raster on each reopen. Only a change to the class or to the style minus opacity counts.
const themeSignature = () => `${document.body.className}|${(document.body.getAttribute?.("style") || "").replace(/opacity\s*:[^;]*;?/g, "")}`;
let lastThemeSignature = themeSignature();
const themeObserver = new MutationObserver(() => {
    const signature = themeSignature();
    if (signature === lastThemeSignature) return;
    lastThemeSignature = signature;
    themeTokensDirty = true;
    refreshThemeTokens();
    applyDecorationThemeColors();
    tileRasterCache.clear();
    mosaicCache.clear();
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

    const fsToggle = document.getElementById("fullscreen-toggle");
    if (fsToggle) {
        fsToggle.checked = data.fullscreenOnOpen !== false;
    }

    const compInput = document.getElementById("compression-percentage-input");
    if (compInput && document.activeElement !== compInput) {
        compInput.value = (typeof data.compressionPercentage === "number") ? data.compressionPercentage : 5;
    }

    const minWInput = document.getElementById("min-cell-width-input");
    if (minWInput && document.activeElement !== minWInput) {
        minWInput.value = (typeof data.minCellWidth === "number") ? data.minCellWidth : 40;
    }

    const minHInput = document.getElementById("min-cell-height-input");
    if (minHInput && document.activeElement !== minHInput) {
        minHInput.value = (typeof data.minCellHeight === "number") ? data.minCellHeight : 28;
    }

    const autoIgnoreInput = document.getElementById("auto-ignore-threshold-input");
    if (autoIgnoreInput && document.activeElement !== autoIgnoreInput) {
        autoIgnoreInput.value = (typeof data.autoIgnoreThreshold === "number") ? data.autoIgnoreThreshold : 30;
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
    const hadFocusInside = [foldersPopover, actionsModal].some(el => el && el.contains(document.activeElement));
    const opener = actionsModal && actionsModal.style.display === "block" ? actionsBtn : foldersBtn;
    if (foldersPopover) foldersPopover.style.display = "none";
    if (actionsModal) actionsModal.style.display = "none";
    if (foldersBtn) {
        foldersBtn.classList.remove("active");
        foldersBtn.setAttribute("aria-expanded", "false");
    }
    if (actionsBtn) {
        actionsBtn.classList.remove("active");
        actionsBtn.setAttribute("aria-expanded", "false");
    }
    // Return keyboard focus to the button that opened the dialog, as dialogs are expected to.
    if (hadFocusInside && opener) opener.focus();
}

/** Opens a toolbar dialog: marks its button expanded and moves focus to its first control. */
function openToolbarDialog(dialog, button) {
    dialog.style.display = "block";
    button.classList.add("active");
    button.setAttribute("aria-expanded", "true");
    const first = dialog.querySelector("button, input, select, [tabindex]:not([tabindex='-1'])");
    if (first) first.focus();
}

/** Keeps Tab / Shift+Tab inside an open modal dialog. */
function trapFocus(dialog) {
    dialog.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(dialog.querySelectorAll("button, input, select, [tabindex]:not([tabindex='-1'])"))
            .filter(el => !el.disabled && el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
}
if (actionsModal) trapFocus(actionsModal);

if (foldersBtn && foldersPopover) {
    foldersBtn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = foldersPopover.style.display === "block";
        closeAllPopovers();
        if (!isOpen) {
            updateFoldersPopover();
            updateIgnoresPopover();
            openToolbarDialog(foldersPopover, foldersBtn);
        }
    };
}
if (closeFoldersPopover && foldersPopover) {
    closeFoldersPopover.onclick = () => closeAllPopovers();
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
            openToolbarDialog(actionsModal, actionsBtn);
        }
    };
}
if (closeModal && actionsModal) {
    closeModal.onclick = () => closeAllPopovers();
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

// The in-grid legend of non-obvious keys (extension.ts showShortcutLegend), until dismissed.
const shortcutLegend = document.getElementById("shortcut-legend");
let shortcutLegendDismissed = false;

function syncShortcutLegend() {
    if (!shortcutLegend || !data) return;
    const keyEl = document.getElementById("shortcut-legend-key");
    if (keyEl && data.openKeybinding) keyEl.textContent = data.openKeybinding;
    shortcutLegend.hidden = shortcutLegendDismissed || data.showShortcutLegend !== true;
}

const shortcutLegendClose = document.getElementById("shortcut-legend-close");
if (shortcutLegendClose) {
    shortcutLegendClose.onclick = () => {
        shortcutLegendDismissed = true;
        if (shortcutLegend) shortcutLegend.hidden = true;
        // extension.ts "dismissShortcutLegend" (no fields): remembered across sessions.
        vscode.postMessage({ command: "dismissShortcutLegend" });
        canvas.focus();
    };
}

// "N folders auto-hidden" (extension.ts autoHiddenFolders): auto-ignore can hide a real folder on the
// first open, and Zen mode silences the notification that says so. Opens Folders & Ignored; the
// close button hides it until the set of auto-hidden folders changes.
const autoHiddenChip = document.getElementById("auto-hidden-chip");
const autoHiddenOpen = document.getElementById("auto-hidden-open");
const autoHiddenSignature = folders => [...folders].sort().join("\n");
let autoHiddenDismissedLocally = null;

function syncAutoHiddenChip() {
    if (!autoHiddenChip || !autoHiddenOpen || !data) return;
    const folders = Array.isArray(data.autoHiddenFolders) ? data.autoHiddenFolders : [];
    const signature = autoHiddenSignature(folders);
    const dismissed = signature === data.autoHiddenDismissed || signature === autoHiddenDismissedLocally;
    // Never stacked with the one-time fullscreen banner (bottom center); shown once it is gone.
    const bannerShown = typeof fullscreenNotice !== "undefined" && fullscreenNotice && !fullscreenNotice.hidden;
    autoHiddenChip.hidden = folders.length === 0 || dismissed || bannerShown;
    if (autoHiddenChip.hidden) return;
    const label = folders.length === 1 ? `1 folder auto-hidden (${folders[0].replace(/\/$/, "")})` : `${folders.length} folders auto-hidden`;
    if (autoHiddenOpen.textContent !== label) autoHiddenOpen.textContent = label;
}
if (autoHiddenOpen) {
    autoHiddenOpen.onclick = () => {
        const btn = document.getElementById("folders-btn");
        if (btn) btn.click();
    };
}
const autoHiddenClose = document.getElementById("auto-hidden-close");
if (autoHiddenClose) {
    autoHiddenClose.onclick = () => {
        const signature = autoHiddenSignature(Array.isArray(data && data.autoHiddenFolders) ? data.autoHiddenFolders : []);
        autoHiddenDismissedLocally = signature;
        if (autoHiddenChip) autoHiddenChip.hidden = true;
        // extension.ts settings_actions "dismissAutoHiddenChip" { signature }.
        vscode.postMessage({ command: "dismissAutoHiddenChip", signature });
        canvas.focus();
    };
}

const fullscreenNotice = document.getElementById("fullscreen-notice");
const fullscreenToggle = document.getElementById("fullscreen-toggle");

/** Shows the one-time fullscreen banner (extension.ts "fullscreenNotice"); announced, not focused, so it never interrupts typing. */
function showFullscreenNotice(keybinding) {
    if (!fullscreenNotice || !fullscreenNotice.hidden) return;
    const keyEl = document.getElementById("fullscreen-notice-key");
    if (keyEl && keybinding) keyEl.textContent = keybinding;
    fullscreenNotice.hidden = false;
    const text = document.getElementById("fullscreen-notice-text");
    if (text) announce(text.textContent);
    syncAutoHiddenChip();
}

function hideFullscreenNotice() {
    if (fullscreenNotice) fullscreenNotice.hidden = true;
    syncAutoHiddenChip();
}

const fullscreenKeepBtn = document.getElementById("fullscreen-notice-keep");
if (fullscreenKeepBtn) {
    fullscreenKeepBtn.onclick = () => {
        hideFullscreenNotice();
        vscode.postMessage({ command: "dismissFullscreenNotice" });
        canvas.focus();
    };
}
const fullscreenTabBtn = document.getElementById("fullscreen-notice-tab");
if (fullscreenTabBtn) {
    fullscreenTabBtn.onclick = () => {
        hideFullscreenNotice();
        if (fullscreenToggle) fullscreenToggle.checked = false;
        vscode.postMessage({ command: "setFullscreenOnOpen", enabled: false });
        announce("Thumbview will open as a tab. Change this in Settings.");
        canvas.focus();
    };
}
if (fullscreenToggle) {
    fullscreenToggle.onchange = () => {
        hideFullscreenNotice();
        vscode.postMessage({ command: "setFullscreenOnOpen", enabled: fullscreenToggle.checked });
    };
}

const mediaThumbnailsToggle = document.getElementById("media-thumbnails-toggle");
if (mediaThumbnailsToggle) {
    mediaThumbnailsToggle.onchange = () => {
        vscode.postMessage({ command: "setRenderMediaThumbnails", enabled: mediaThumbnailsToggle.checked });
    };
}

function triggerExpandSpace() {
    const layer = focusedFolder || "";
    if (data) {
        if (!data.folderExtraCols) data.folderExtraCols = {};
        if (!data.folderExtraRows) data.folderExtraRows = {};
        const curCols = ((data.folderExtraCols[layer]) || (layer === "" ? (data.extraCols || 0) : 0));
        const curRows = ((data.folderExtraRows[layer]) || (layer === "" ? (data.extraRows || 0) : 0));
        data.folderExtraCols[layer] = curCols + 1;
        data.folderExtraRows[layer] = curRows + 1;
        if (layer === "") {
            data.extraCols = (data.extraCols || 0) + 1;
            data.extraRows = (data.extraRows || 0) + 1;
            if (data.layout) {
                data.layout.cols = (data.layout.cols || 1) + 1;
                data.layout.rows = (data.layout.rows || 1) + 1;
            }
        }

        render();
    }
    vscode.postMessage({
        command: "expandSpace",
        focusedFolder: layer
    });
}

function triggerReduceSpace() {
    const layer = focusedFolder || "";
    if (data) {
        if (!data.folderExtraCols) data.folderExtraCols = {};
        if (!data.folderExtraRows) data.folderExtraRows = {};
        const curCols = ((data.folderExtraCols[layer]) || (layer === "" ? (data.extraCols || 0) : 0));
        const curRows = ((data.folderExtraRows[layer]) || (layer === "" ? (data.extraRows || 0) : 0));

        if (curCols <= 0 && curRows <= 0) {
            return;
        }

        const newCols = Math.max(0, curCols - 1);
        const newRows = Math.max(0, curRows - 1);
        data.folderExtraCols[layer] = newCols;
        data.folderExtraRows[layer] = newRows;

        if (layer === "") {
            const oldExtraCols = data.extraCols || 0;
            const oldExtraRows = data.extraRows || 0;
            data.extraCols = newCols;
            data.extraRows = newRows;
            if (data.layout) {
                if (oldExtraCols > 0) {
                    data.layout.cols = Math.max(1, (data.layout.cols || 1) - (oldExtraCols - newCols));
                }
                if (oldExtraRows > 0) {
                    data.layout.rows = Math.max(1, (data.layout.rows || 1) - (oldExtraRows - newRows));
                }
            }
        }

        render();
    }
    vscode.postMessage({
        command: "reduceSpace",
        focusedFolder: layer
    });
}

function applyLocalSpanningCompression(pct) {
    if (!data || !data.files || (data.mode !== "spanning_grid" && data.layoutMode !== "spanning_grid")) return;
    const clampedPct = Math.max(0, Math.min(0.25, pct));
    for (const f of data.files) {
        f.nCells = f.lineCount ? cellsNeeded(f.lineCount, 60, clampedPct) : 1;
    }
    const order = data.files.map(f => f.id);
    const extraCols = data.extraCols || 0;
    const extraRows = data.extraRows || 0;
    const layout = buildSpanningGridLocal(data.files, BASE_GRID_ASPECT, order, extraCols, extraRows, 60, clampedPct, null, scopeFootprints("root"));
    if (layout && layout.placements) {
        data.layout = {
            cols: layout.cols,
            rows: layout.rows
        };
        const slotMap = new Map(layout.placements.map(p => [p.file.id, [p.col, p.row]]));
        const cellsMap = new Map(layout.placements.map(p => [p.file.id, p.nCells]));
        const slotsMap = new Map(layout.placements.map(p => [p.file.id, p.slots]));
        slotOccupancy.clear();
        for (const f of data.files) {
            if (slotMap.has(f.id)) {
                f.slot = slotMap.get(f.id);
            }
            if (cellsMap.has(f.id)) {
                f.nCells = cellsMap.get(f.id);
            }
            if (slotsMap.has(f.id)) {
                f.slots = slotsMap.get(f.id);
                for (const [col, row] of f.slots) {
                    slotOccupancy.set(`${col},${row}`, f);
                }
            }
        }
    }
    userReorderedFileSlots.clear();
}

const compPercentageInput = document.getElementById("compression-percentage-input");
if (compPercentageInput) {
    const handleCompCommit = () => {
        let val = parseInt(compPercentageInput.value, 10);
        if (isNaN(val)) val = 0;
        val = Math.max(0, Math.min(25, val));
        compPercentageInput.value = val;
        if (data && data.compressionPercentage === val) {
            return;
        }
        if (data) {
            data.compressionPercentage = val;
        }
        vscode.postMessage({ command: "setCompressionPercentage", value: val });
    };

    compPercentageInput.addEventListener("change", handleCompCommit);
    compPercentageInput.addEventListener("blur", handleCompCommit);
    compPercentageInput.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            compPercentageInput.blur();
        }
    });
}

let dimDebounceTimer = null;
const minCellWInput = document.getElementById("min-cell-width-input");
const minCellHInput = document.getElementById("min-cell-height-input");
if (minCellWInput && minCellHInput) {
    const handleDimInput = () => {
        let w = parseInt(minCellWInput.value, 10);
        let h = parseInt(minCellHInput.value, 10);
        if (!isNaN(w) && w >= 10 && !isNaN(h) && h >= 10) {
            if (data) {
                data.minCellWidth = w;
                data.minCellHeight = h;
                render();
            }
            clearTimeout(dimDebounceTimer);
            dimDebounceTimer = setTimeout(() => {
                vscode.postMessage({ command: "setMinCellDimensions", minCellWidth: w, minCellHeight: h });
            }, 300);
        }
    };

    const handleDimCommit = () => {
        let w = parseInt(minCellWInput.value, 10);
        let h = parseInt(minCellHInput.value, 10);
        if (isNaN(w) || w < 10) w = 10;
        if (w > 500) w = 500;
        if (isNaN(h) || h < 10) h = 10;
        if (h > 500) h = 500;
        minCellWInput.value = w;
        minCellHInput.value = h;
        if (data) {
            data.minCellWidth = w;
            data.minCellHeight = h;
            render();
        }
        clearTimeout(dimDebounceTimer);
        vscode.postMessage({ command: "setMinCellDimensions", minCellWidth: w, minCellHeight: h });
    };

    minCellWInput.addEventListener("input", handleDimInput);
    minCellHInput.addEventListener("input", handleDimInput);
    minCellWInput.addEventListener("change", handleDimCommit);
    minCellHInput.addEventListener("change", handleDimCommit);
    minCellWInput.addEventListener("blur", handleDimCommit);
    minCellHInput.addEventListener("blur", handleDimCommit);
    minCellWInput.addEventListener("keydown", e => { if (e.key === "Enter") minCellWInput.blur(); });
    minCellHInput.addEventListener("keydown", e => { if (e.key === "Enter") minCellHInput.blur(); });
}

const autoIgnoreInput = document.getElementById("auto-ignore-threshold-input");
if (autoIgnoreInput) {
    const handleAutoIgnoreChange = () => {
        let val = parseInt(autoIgnoreInput.value, 10);
        if (isNaN(val) || val < 0) val = 0;
        if (val > 10000) val = 10000;
        autoIgnoreInput.value = val;
        if (data) data.autoIgnoreThreshold = val;
        vscode.postMessage({ command: "setAutoIgnoreThreshold", threshold: val });
    };
    autoIgnoreInput.addEventListener("change", handleAutoIgnoreChange);
    autoIgnoreInput.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            autoIgnoreInput.blur();
        }
    });
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
    if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        event.stopPropagation();
    }
});

const reflowLayoutBtn = document.getElementById("reflow-layout-btn");
if (reflowLayoutBtn) {
    reflowLayoutBtn.onclick = () => {
        userReorderedFileSlots.clear();
        const targetFolder = focusedFolder === "(root files)/" ? "" : (focusedFolder || "");
        if (targetFolder) {
            if (data) {
                if (data.folderOrders) delete data.folderOrders[targetFolder];
                if (data.folderWrapRows) delete data.folderWrapRows[targetFolder];
                if (data.folderCardOrders) delete data.folderCardOrders[targetFolder];
                if (data.folderCardWrapRows) delete data.folderCardWrapRows[targetFolder];
                if (data.folderExtraCols) delete data.folderExtraCols[targetFolder];
                if (data.folderExtraRows) delete data.folderExtraRows[targetFolder];
            }
        } else if (data) {
            data.folderOrders = {};
            data.folderWrapRows = {};
            data.folderCardOrders = {};
            data.folderCardWrapRows = {};
            data.folderExtraCols = {};
            data.folderExtraRows = {};
            data.extraCols = 0;
            data.extraRows = 0;
        }
        render();
        vscode.postMessage({ command: "reflow", focusedFolder: targetFolder });
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

vscode.postMessage({
    command: "ready"
});