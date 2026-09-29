// Single source of the pure layout functions shared by the extension host and the webview:
// grid slot packing, spanning cell counts, hole filling, and spanning drag reorders.
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
 * Reorders items in a 2D spanning grid layout, placing sourceId at targetCol, targetRow.
 * Preserves empty holes in the column-major grid and respects capacity constraints.
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
} {
    let maxColUsed = maxAllowedCols - 1;
    let scanCol = 0;
    let scanRow = 0;
    for (const id of currentOrder) {
        const nCells = id ? (allocations[id] || 1) : 1;
        if (scanRow > 0 && scanRow + nCells > wrapRows) {
            scanCol++;
            scanRow = 0;
        }
        if (id && scanCol > maxColUsed) {
            maxColUsed = scanCol;
        }
        scanRow += nCells;
    }

    const maxCol = Math.max(maxAllowedCols - 1, maxColUsed);
    const sourceCells = allocations[sourceId] || 1;
    const gridRows = Math.max(maxAllowedRows, wrapRows);

    let currCol = 0;
    let currRow = 0;
    const placements: Array<{ id: string; col: number; row: number; nCells: number }> = [];
    const placementBySlot = new Map<string, { id: string; col: number; row: number; nCells: number }>();
    const placementById = new Map<string, { id: string; col: number; row: number; nCells: number }>();

    for (const id of currentOrder) {
        const nCells = id ? (allocations[id] || 1) : 1;
        if (currRow > 0 && currRow + nCells > wrapRows) {
            currCol++;
            currRow = 0;
        }
        if (currCol > maxCol) break;
        if (!id) {
            currRow += 1;
            continue;
        }
        const p = { id, col: currCol, row: currRow, nCells };
        placements.push(p);
        placementById.set(id, p);
        for (let i = 0; i < nCells; i++) {
            if (currRow + i < gridRows) {
                placementBySlot.set(`${currCol},${currRow + i}`, p);
            }
        }
        currRow += nCells;
    }

    const sourcePlacement = placementById.get(sourceId);
    const sourceCol = sourcePlacement ? sourcePlacement.col : 0;
    const sourceRow = sourcePlacement ? sourcePlacement.row : 0;

    let targetPlacement = placementBySlot.get(`${targetCol},${targetRow}`);
    if (targetPlacement && targetPlacement.id === sourceId) {
        targetPlacement = undefined;
    }

    const clamped = clampTargetToGridCapacity(targetCol, targetRow, sourceCells, maxAllowedCols, maxAllowedRows);
    const maxAllowedRow = Math.max(0, maxAllowedRows - sourceCells);
    const finalTargetCol = targetPlacement ? targetPlacement.col : clamped.col;
    const finalTargetRow = targetPlacement ? Math.min(targetPlacement.row, maxAllowedRow) : clamped.row;

    const grid: string[][] = [];
    for (let c = 0; c <= maxCol; c++) {
        grid.push(new Array(gridRows).fill(""));
    }
    for (const p of placements) {
        for (let i = 0; i < p.nCells; i++) {
            if (p.row + i < gridRows && p.col <= maxCol) {
                grid[p.col][p.row + i] = p.id;
            }
        }
    }

    for (let c = 0; c <= maxCol; c++) {
        for (let r = 0; r < gridRows; r++) {
            if (grid[c][r] === sourceId) {
                grid[c][r] = "";
            }
        }
    }

    // Identify all items overlapping the target span [finalTargetRow ... finalTargetRow + sourceCells - 1] in finalTargetCol
    const displacedPlacements: Array<{ id: string; col: number; row: number; nCells: number }> = [];
    const seenDisplacedIds = new Set<string>();

    for (let i = 0; i < sourceCells; i++) {
        const r = finalTargetRow + i;
        if (r < gridRows && finalTargetCol <= maxCol) {
            const cellId = grid[finalTargetCol][r];
            if (cellId && cellId !== sourceId && !seenDisplacedIds.has(cellId)) {
                seenDisplacedIds.add(cellId);
                const p = placementById.get(cellId);
                if (p) displacedPlacements.push(p);
            }
        }
    }
    if (targetPlacement && targetPlacement.id !== sourceId && !seenDisplacedIds.has(targetPlacement.id)) {
        seenDisplacedIds.add(targetPlacement.id);
        displacedPlacements.push(targetPlacement);
    }

    // Clear sourceId and all displaced items from the grid
    for (let c = 0; c <= maxCol; c++) {
        for (let r = 0; r < gridRows; r++) {
            if (grid[c][r] === sourceId || seenDisplacedIds.has(grid[c][r])) {
                grid[c][r] = "";
            }
        }
    }

    // Place displaced items into sourceCol, preserving relative offsets and gaps
    let safeSourceRow = sourceRow;
    let curSourceR = sourceRow;
    for (const p of displacedPlacements) {
        const relOffset = p.row - finalTargetRow;
        let destR = (sourceCells >= p.nCells && relOffset >= 0)
            ? (sourceRow + relOffset)
            : curSourceR;
        destR = Math.min(destR, Math.max(0, gridRows - p.nCells));
        for (let i = 0; i < p.nCells; i++) {
            if (sourceCol <= maxCol && destR + i < gridRows) {
                grid[sourceCol][destR + i] = p.id;
            }
        }
        curSourceR = destR + p.nCells;
    }
    if (displacedPlacements.length > 0) {
        safeSourceRow = Math.min(sourceRow, Math.max(0, gridRows - displacedPlacements[0].nCells));
    }

    for (let i = 0; i < sourceCells; i++) {
        if (finalTargetCol <= maxCol && finalTargetRow + i < gridRows) {
            grid[finalTargetCol][finalTargetRow + i] = sourceId;
        }
    }

    const effectiveWrapRows = Math.max(wrapRows, finalTargetRow + sourceCells);

    const newOrder: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
        let r = 0;
        while (r < effectiveWrapRows) {
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
        rows: effectiveWrapRows,
        cols: Math.max(maxAllowedCols, maxCol + 1),
        finalTargetCol,
        finalTargetRow,
        sourceCol,
        sourceRow,
        targetPlacement,
        safeSourceRow
    };
}
