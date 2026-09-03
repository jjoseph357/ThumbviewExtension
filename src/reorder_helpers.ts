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
