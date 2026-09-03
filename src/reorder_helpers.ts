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
): { newOrder: string[]; rows: number; cols: number } {
    let currCol = 0;
    let currRow = 0;
    const placements: Array<{ id: string; col: number; row: number; nCells: number }> = [];
    const placementBySlot = new Map<string, { id: string; col: number; row: number; nCells: number }>();
    const placementById = new Map<string, { id: string; col: number; row: number; nCells: number }>();

    for (const id of currentOrder) {
        if (!id) {
            currRow += 1;
            continue;
        }
        const nCells = allocations[id] || 1;
        if (currRow > 0 && currRow + nCells > wrapRows) {
            currCol++;
            currRow = 0;
        }
        const p = { id, col: currCol, row: currRow, nCells };
        placements.push(p);
        placementById.set(id, p);
        for (let i = 0; i < nCells; i++) {
            placementBySlot.set(`${currCol},${currRow + i}`, p);
        }
        currRow += nCells;
    }

    const sourcePlacement = placementById.get(sourceId);
    const sourceCells = allocations[sourceId] || 1;
    const sourceCol = sourcePlacement ? sourcePlacement.col : 0;

    let targetPlacement = placementBySlot.get(`${targetCol},${targetRow}`);
    if (targetPlacement && targetPlacement.id === sourceId) {
        targetPlacement = undefined;
    }

    const clamped = clampTargetToGridCapacity(targetCol, targetRow, sourceCells, maxAllowedCols, maxAllowedRows);
    const finalTargetCol = targetPlacement ? targetPlacement.col : clamped.col;
    const finalTargetRow = targetPlacement ? targetPlacement.row : clamped.row;

    let reqRows = wrapRows;
    for (const p of placements) {
        reqRows = Math.max(reqRows, p.row + p.nCells);
    }
    const gridRows = Math.min(maxAllowedRows, Math.max(reqRows, finalTargetRow + sourceCells));
    const maxCol = Math.min(maxAllowedCols - 1, Math.max(currCol, finalTargetCol, sourceCol));

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
                const nCells = allocations[cell] || 1;
                r += nCells;
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
        cols: maxCol + 1
    };
}
