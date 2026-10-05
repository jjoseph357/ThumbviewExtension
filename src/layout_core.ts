// Single source of the pure functions shared by the extension host and the webview: grid slot
// packing, spanning cell counts, hole filling, spanning drag reorders, and line classification.
// The host imports this module; `npm run sync-core` transpiles it into the generated block of
// media/overview.js (the webview is unbundled), and `npm run check-core` fails if that block is
// stale. Keep it dependency-free: no imports, no vscode, no DOM.

export const DEFAULT_TARGET_ASPECT = 16 / 9;
export const MIN_GRID_ROWS = 1;
export const MIN_GRID_COLS = 2;
export const DEFAULT_BASE_LINES_PER_CELL = 60;
export const DEFAULT_COMPRESSION_PCT = 0.05;
export const MAX_COMPRESSION_PCT = 0.25;

/** Packs nCells items into a near-targetAspect grid, returning {rows, cols, slots} in fill order. */
export function buildStableGrid(
    nCells: number,
    targetAspect = DEFAULT_TARGET_ASPECT
) {
    let rows = MIN_GRID_ROWS;
    let cols = Math.max(MIN_GRID_COLS, Math.ceil(rows * targetAspect));

    const slots: Array<[number, number]> = [];

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

/** Vertical cells a file of lineCount lines spans in spanning mode. */
export function cellsNeeded(
    lineCount: number,
    baseLinesPerCell = DEFAULT_BASE_LINES_PER_CELL,
    compressionPct = DEFAULT_COMPRESSION_PCT
): number {
    if (lineCount <= baseLinesPerCell || compressionPct <= 0) {
        return 1;
    }
    const clampedPct = Math.min(compressionPct, MAX_COMPRESSION_PCT);
    const repLines = Math.max(lineCount * clampedPct, baseLinesPerCell);
    return Math.ceil(repLines / baseLinesPerCell);
}

export interface HoleFillResult {
    order: string[];
    // Minimum cell count for ids that filled a taller hole (see fillLayoutHoles).
    footprints: { [id: string]: number };
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
export function fillLayoutHoles(
    order: string[],
    liveIds: string[],
    cellsOf: (id: string) => number = () => 1,
    holeCellsOf: (id: string) => number = () => 1
): HoleFillResult {
    const live = new Set(liveIds);
    const present = new Set(order.filter(Boolean));
    const result = [...order];
    const footprints: { [id: string]: number } = {};
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
export function clampTargetToGridCapacity(
    targetCol: number,
    targetRow: number,
    spanCells: number,
    maxCols: number,
    maxRows: number
): { col: number; row: number } {
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
export function expandSpanningGridOrder(
    currentOrder: string[],
    allocations: { [id: string]: number },
    oldCols: number,
    oldRows: number
): { newOrder: string[]; cols: number; rows: number } {
    const newCols = oldCols + 1;
    const newRows = oldRows + 1;

    const grid: string[][] = [];
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
        if (currCol >= oldCols) break;
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

    const newOrder: string[] = [];
    for (let c = 0; c < newCols; c++) {
        let r = 0;
        while (r < newRows) {
            if (c < oldCols && r < oldRows) {
                const cell = grid[c][r];
                if (cell) {
                    newOrder.push(cell);
                    const n = allocations[cell] || 1;
                    r += n;
                } else {
                    newOrder.push("");
                    r += 1;
                }
            } else {
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
export function reduceSpanningGridOrder(
    currentOrder: string[],
    allocations: { [id: string]: number },
    oldCols: number,
    oldRows: number,
    minCols: number,
    minRows: number
): { newOrder: string[]; cols: number; rows: number } {
    const newCols = Math.max(minCols, oldCols - 1);
    const newRows = Math.max(minRows, oldRows - 1);
    if (newCols === oldCols && newRows === oldRows) {
        return { newOrder: [...currentOrder], cols: oldCols, rows: oldRows };
    }

    const grid: string[][] = [];
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
        if (currCol >= oldCols) break;
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

    const newOrder: string[] = [];
    for (let c = 0; c < newCols; c++) {
        let r = 0;
        while (r < newRows) {
            const cell = grid[c][r];
            if (cell) {
                newOrder.push(cell);
                const n = allocations[cell] || 1;
                r += n;
            } else {
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
export function reorderSpanningItems(
    activeIds: string[],
    currentOrder: string[],
    allocations: { [id: string]: number },
    sourceId: string,
    targetCol: number,
    targetRow: number,
    maxAllowedCols: number,
    maxAllowedRows: number,
    wrapRows: number
): {
    newOrder: string[];
    rows: number;
    cols: number;
    finalTargetCol: number;
    finalTargetRow: number;
    sourceCol: number;
    sourceRow: number;
    targetPlacement?: { id: string; col: number; row: number; nCells: number };
    safeSourceRow: number;
    rejected: boolean;
} {
    type Placement = { id: string; col: number; row: number; nCells: number };
    const placements: Placement[] = [];
    const placementById = new Map<string, Placement>();
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
    const unchanged = (rejected: boolean) => ({
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
    const occupant: Array<Array<Placement | undefined>> = [];
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
    const wholeSpan = (c: number, start: number, end: number): { start: number; end: number } => {
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
    const tilesIn = (c: number, start: number, end: number): Placement[] => {
        const out: Placement[] = [];
        for (let r = start; r < end && r < gridRows; r++) {
            const p = occupant[c][r];
            if (p && !out.includes(p)) out.push(p);
        }
        return out;
    };
    const moves = new Map<Placement, { col: number; row: number }>();

    const sameColumnOverlap = tc === source.col && tr < source.row + h && source.row < tr + h;
    if (!sameColumnOverlap) {
        // Two blocks of equal height, each made of whole tiles and empty cells, trade places.
        let rStart = tr;
        let height = h;
        let target = { start: tr, end: tr + h };
        let src = { start: source.row, end: source.row + h };
        for (let guard = 0; ; guard++) {
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
    } else {
        // Within one column: the source takes [tr, tr + h); the other tiles of the span keep their
        // order and fill the remaining cells, top to bottom, never split by the source.
        const span = wholeSpan(tc, Math.min(source.row, tr), Math.max(source.row, tr) + h);
        if (span.end > gridRows) {
            return unchanged(true);
        }
        const others: Array<Placement | null> = [];
        for (let r = span.start; r < span.end; r++) {
            const p = occupant[tc][r];
            if (p === source) continue;
            if (!p) others.push(null);
            else if (p.row === r) others.push(p);
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
            if (item) moves.set(item, { col: tc, row: r });
            r += n;
        }
    }

    const finalPlacements = placements.map(p => ({ ...p, ...(moves.get(p) || {}) }));
    const movedSource = finalPlacements.find(p => p.id === sourceId)!;
    let effectiveWrapRows = wrapRows;
    for (const p of finalPlacements) {
        effectiveWrapRows = Math.max(effectiveWrapRows, p.row + p.nCells);
    }

    // Serialize column-major, every column effectiveWrapRows tall, so every tile keeps its cell.
    const cell: string[][] = [];
    for (let c = 0; c <= maxCol; c++) {
        cell.push(new Array(effectiveWrapRows).fill(""));
    }
    const startsAt = new Map<string, Placement>();
    for (const p of finalPlacements) {
        startsAt.set(`${p.col},${p.row}`, p);
    }
    const newOrder: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
        let r = 0;
        while (r < effectiveWrapRows) {
            const p = startsAt.get(`${c},${r}`);
            if (p) {
                newOrder.push(p.id);
                r += p.nCells;
            } else {
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
export function displayToFlowRow(
    order: string[],
    flowCells: { [id: string]: number },
    displayCells: { [id: string]: number },
    wrapRows: number,
    col: number,
    displayRow: number
): number {
    let c = 0;
    let flow = 0;
    let display = 0;
    for (const id of order) {
        const f = id ? (flowCells[id] || 1) : 1;
        const g = id ? (displayCells[id] || f) : 1;
        if (flow > 0 && flow + f > wrapRows) {
            if (c === col) break;
            c++;
            flow = 0;
            display = 0;
        }
        if (c > col) break;
        if (c === col && displayRow < display + g) {
            return flow + Math.min(Math.max(0, displayRow - display), f - 1);
        }
        flow += f;
        display += g;
    }
    return c === col ? flow + Math.max(0, displayRow - display) : displayRow;
}

export type LineCategory = "comment" | "import" | "function" | "class" | "control-flow" | "normal";

/**
 * Coarse per-line category from leading or contained keywords, not a real parser. Colors the
 * line bars of folder card previews; the host sends only line text, so the webview derives it.
 */
export function categorizeLine(line: string): LineCategory {
    const trimmed = line.trim();
    if (!trimmed) {
        return "normal";
    }

    if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("'''") ||
        trimmed.startsWith("\"\"\"")
    ) {
        return "comment";
    }

    if (
        trimmed.startsWith("import ") ||
        trimmed.startsWith("export ") ||
        trimmed.startsWith("from ") ||
        trimmed.startsWith("using ") ||
        trimmed.includes("require(")
    ) {
        return "import";
    }

    if (
        trimmed.startsWith("class ") ||
        trimmed.startsWith("interface ") ||
        trimmed.startsWith("struct ") ||
        trimmed.startsWith("impl ") ||
        trimmed.startsWith("type ")
    ) {
        return "class";
    }

    if (
        trimmed.startsWith("function ") ||
        trimmed.startsWith("def ") ||
        trimmed.startsWith("fn ") ||
        trimmed.startsWith("func ")
    ) {
        return "function";
    }

    if (
        trimmed.includes("if ") ||
        trimmed.includes("for ") ||
        trimmed.includes("while ") ||
        trimmed.includes("return") ||
        trimmed.includes("switch") ||
        trimmed.includes("else") ||
        trimmed.includes("elif") ||
        trimmed.includes("catch") ||
        trimmed.includes("try")
    ) {
        return "control-flow";
    }

    return "normal";
}
