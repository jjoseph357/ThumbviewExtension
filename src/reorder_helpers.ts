/**
 * Pure helper functions for tile and card reordering across uniform, spanning, folder, and overview grid modes.
 */

/**
 * Moves an item to an empty slot in an order array.
 * Leaves an empty string ("") at the source index so other items do not reflow.
 * If maxCapacity is given, targetIndex is clamped to maxCapacity - 1 so the array cannot exceed grid bounds.
 */
export function moveItemToEmptySlot(
    order: string[],
    idToMove: string,
    targetIndex: number,
    maxCapacity?: number
): string[] {
    const from = order.indexOf(idToMove);
    if (from === -1) return [...order];

    let clampedTargetIndex = targetIndex;
    if (maxCapacity !== undefined && maxCapacity > 0) {
        clampedTargetIndex = Math.min(targetIndex, maxCapacity - 1);
    }
    if (clampedTargetIndex < 0) clampedTargetIndex = 0;

    const newOrder = [...order];
    newOrder[from] = "";

    while (newOrder.length <= clampedTargetIndex) {
        newOrder.push("");
    }

    newOrder[clampedTargetIndex] = idToMove;

    // Trim trailing empty strings only beyond the last occupied item
    while (newOrder.length > 0 && !newOrder[newOrder.length - 1]) {
        newOrder.pop();
    }

    return newOrder;
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
 * Reorders items in a folder order array (including empty slots "").
 */
export function reorderFolderItems(
    currentOrder: string[],
    sourceId: string,
    targetIsEmpty: boolean,
    targetId: string | null,
    targetSlotIdx: number,
    maxCapacity: number,
    mode: "swap" | "shift"
): string[] {
    if (targetIsEmpty) {
        return moveItemToEmptySlot(currentOrder, sourceId, targetSlotIdx, maxCapacity);
    }

    if (!targetId || targetId === sourceId) return [...currentOrder];

    const fromIdx = currentOrder.indexOf(sourceId);
    const toIdx = currentOrder.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return [...currentOrder];

    const newOrder = [...currentOrder];
    if (mode === "shift") {
        newOrder.splice(fromIdx, 1);
        const newToIdx = newOrder.indexOf(targetId);
        if (newToIdx !== -1) {
            newOrder.splice(newToIdx, 0, sourceId);
        } else {
            newOrder.splice(toIdx, 0, sourceId);
        }
    } else {
        newOrder[fromIdx] = targetId;
        newOrder[toIdx] = sourceId;
    }
    return newOrder;
}

/**
 * Reorders items in a card order array (overview subfolder cards mode, including empty slots "").
 */
export function reorderCardItems(
    currentOrder: string[],
    sourceId: string,
    targetIsEmpty: boolean,
    targetId: string | null,
    targetSlotIdx: number,
    maxCapacity: number
): string[] {
    if (targetIsEmpty) {
        return moveItemToEmptySlot(currentOrder, sourceId, targetSlotIdx, maxCapacity);
    }

    if (!targetId || targetId === sourceId) return [...currentOrder];

    const fromIdx = currentOrder.indexOf(sourceId);
    const toIdx = currentOrder.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return [...currentOrder];

    const newOrder = [...currentOrder];
    newOrder[fromIdx] = targetId;
    newOrder[toIdx] = sourceId;
    return newOrder;
}

/**
 * Expands a 2D spanning order array by adding 1 empty slot at the bottom of each column,
 * and 1 empty column on the right.
 * Guarantees that all existing items maintain their exact (col, row) placements with zero reflow.
 */
// Duplicated logic: keep in sync with media/overview.js expandSpanningGridOrderLocal and reduceSpanningGridOrderLocal
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
// Duplicated logic: keep in sync with media/overview.js reorderSpanningItemsLocal and clampTargetToGridCapacityLocal
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
    const gridRows = maxAllowedRows;
    const maxCol = maxAllowedCols - 1;

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
    const sourceCells = allocations[sourceId] || 1;
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

    const newOrder: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
        let r = 0;
        while (r < gridRows) {
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
        rows: gridRows,
        cols: maxAllowedCols,
        finalTargetCol,
        finalTargetRow,
        sourceCol,
        sourceRow,
        targetPlacement,
        safeSourceRow
    };
}
