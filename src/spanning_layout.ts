// Pure-logic module computing variable-height cell allocations and assigning files to column-major grid slots.
// Returns row/col bounding dimensions, wrapRows stride, and per-file cell placements.
import { RepoFile } from "./scanner";
import { cellsNeeded, DEFAULT_BASE_LINES_PER_CELL, DEFAULT_COMPRESSION_PCT, DEFAULT_TARGET_ASPECT, MIN_GRID_ROWS, MIN_GRID_COLS } from "./layout_core";

// cellsNeeded and the layout constants live in layout_core.ts, shared with the webview.
export { cellsNeeded, DEFAULT_BASE_LINES_PER_CELL, DEFAULT_COMPRESSION_PCT, MAX_COMPRESSION_PCT, DEFAULT_TARGET_ASPECT, MIN_GRID_ROWS, MIN_GRID_COLS } from "./layout_core";

// Generic over the file type so callers that pass enriched files (contentVersion, git and
// diagnostics fields) get the same type back in placements.
export interface SpanningPlacement<F extends RepoFile = RepoFile> {
    file: F;
    col: number;
    row: number;
    nCells: number;
    slots: Array<[number, number]>;
}

export interface SpanningLayoutResult<F extends RepoFile = RepoFile> {
    rows: number;
    cols: number;
    placements: SpanningPlacement<F>[];
    allocations: { [id: string]: number };
    wrapRows: number;
    // Grid size before grown tiles overflowed their columns. Readability checks (folder-card
    // collapse) use these so typing into a file can never flip a view into card mode.
    flowRows: number;
    flowCols: number;
}

export function buildSpanningGrid<F extends RepoFile>(
    files: F[],
    seenFileOrder: string[],
    existingAllocations: { [id: string]: number } = {},
    savedGridRows: number | null = null,
    forceBreakBeforeId: string | null = null,
    targetAspect = DEFAULT_TARGET_ASPECT,
    baseLinesPerCell = DEFAULT_BASE_LINES_PER_CELL,
    compressionPct = DEFAULT_COMPRESSION_PCT,
    displayCells: { [id: string]: number } | null = null
): SpanningLayoutResult<F> {
    // `allocations` are flow cells: they decide column membership and are frozen once a file is
    // placed. `displayCells` (default: the same) are the tile heights actually drawn. A file that
    // grows or shrinks pushes the files below it within its column, but no file changes column;
    // an overflowing column adds rows (and columns, keeping the cell aspect) instead of wrapping.
    const allocations: { [id: string]: number } = { ...existingAllocations };
    const filesById = new Map<string, F>();
    for (const f of files) {
        filesById.set(f.id, f);
    }

    let totalCells = 0;
    let maxNCells = 1;
    for (const fid of seenFileOrder) {
        if (!fid) {
            continue;
        }
        if (!allocations[fid]) {
            const f = filesById.get(fid);
            allocations[fid] = f ? cellsNeeded(f.lineCount, baseLinesPerCell, compressionPct) : 1;
        }
        totalCells += allocations[fid];
        if (allocations[fid] > maxNCells) {
            maxNCells = allocations[fid];
        }
    }

    const calculatedRows = Math.max(MIN_GRID_ROWS, Math.round(Math.sqrt(Math.max(totalCells, files.length, 1) / targetAspect)));
    // A saved column height is kept, always: it freezes which column every file sits in. It used to
    // be replaced by a new height whenever the grid grew wide (files added), which re-wrapped every
    // column and moved every tile; the webview's buildSpanningGridLocal never did, so the two also
    // disagreed. Columns added by growth are the price of stability (Reflow Layout resets them).
    const wrapRows = savedGridRows && savedGridRows > 0 ? Math.max(savedGridRows, maxNCells) : Math.max(calculatedRows, maxNCells);

    let currCol = 0;
    let currRow = 0;        // flow position: decides column breaks
    let currDisplayRow = 0; // drawn position: follows current tile heights
    let maxRowUsed = 1;
    let maxFlowRowUsed = 1;
    const placements: SpanningPlacement<F>[] = [];

    for (const fid of seenFileOrder) {
        const file = fid ? filesById.get(fid) : undefined;
        const nCells = fid ? (allocations[fid] || 1) : 1;
        const shownCells = fid && displayCells && displayCells[fid] ? displayCells[fid] : nCells;

        const mustBreak = fid === forceBreakBeforeId
            ? currRow > 0
            : currRow > 0 && currRow + nCells > wrapRows;

        if (mustBreak) {
            currCol++;
            currRow = 0;
            currDisplayRow = 0;
        }

        if (file) {
            const slots: Array<[number, number]> = [];
            for (let i = 0; i < shownCells; i++) {
                slots.push([currCol, currDisplayRow + i]);
            }

            placements.push({
                file,
                col: currCol,
                row: currDisplayRow,
                nCells: shownCells,
                slots
            });
        }

        currRow += nCells;
        currDisplayRow += file ? shownCells : nCells;
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
    const naturalColsNeeded = Math.ceil(totalCells / wrapRows);
    const baseCols = Math.max(MIN_GRID_COLS, naturalColsNeeded);
    const finalRows = Math.max(MIN_GRID_ROWS, reqRows);
    let finalCols = Math.max(baseCols, reqCols);
    // Rows added only because grown tiles overflow their columns: add columns in proportion so
    // cells keep their aspect ratio instead of being squashed vertically.
    const flowRows = Math.max(MIN_GRID_ROWS, Math.min(finalRows, Math.max(wrapRows, maxFlowRowUsed)));
    const flowCols = finalCols;
    if (finalRows > flowRows) {
        finalCols = Math.max(finalCols, Math.ceil(finalCols * finalRows / flowRows));
    }

    return {
        rows: finalRows,
        cols: finalCols,
        placements,
        allocations,
        wrapRows,
        flowRows,
        flowCols
    };
}

/**
 * Integrates newly discovered or unignored files into an existing spanning grid layout.
 * Guarantees that all existing file cards maintain their exact (col, row) coordinates,
 * while new files are placed in empty rows below existing cards and in new columns to the right.
 */
export function integrateNewFilesPreservingPositions(
    existingPlacements: SpanningPlacement[],
    newFileIds: string[],
    allocations: { [id: string]: number },
    targetAspect = DEFAULT_TARGET_ASPECT
): { newOrder: string[]; wrapRows: number } {
    if (existingPlacements.length === 0) {
        const totalCells = newFileIds.reduce((sum, id) => sum + (allocations[id] || 1), 0);
        const maxNCells = newFileIds.reduce((max, id) => Math.max(max, allocations[id] || 1), 1);
        const calculatedRows = Math.max(MIN_GRID_ROWS, Math.round(Math.sqrt(Math.max(totalCells, 1) / targetAspect)));
        return {
            newOrder: [...newFileIds],
            wrapRows: Math.max(calculatedRows, maxNCells)
        };
    }

    let maxCol = 0;
    let maxRow = 0;
    let maxNCells = 1;

    for (const p of existingPlacements) {
        if (p.col > maxCol) maxCol = p.col;
        const bottom = p.row + p.nCells;
        if (bottom > maxRow) maxRow = bottom;
        if (p.nCells > maxNCells) maxNCells = p.nCells;
    }

    for (const id of newFileIds) {
        const n = allocations[id] || 1;
        if (n > maxNCells) maxNCells = n;
    }

    let existingCells = 0;
    for (const p of existingPlacements) {
        existingCells += p.nCells;
    }
    let newCells = 0;
    for (const id of newFileIds) {
        newCells += (allocations[id] || 1);
    }
    const totalCells = existingCells + newCells;

    const idealRows = Math.max(maxRow, Math.round(Math.sqrt(totalCells / targetAspect)));
    const wrapRows = Math.max(idealRows, maxNCells);

    const targetCols = Math.max(maxCol + 1, Math.ceil(totalCells / wrapRows), Math.ceil(wrapRows * targetAspect));

    const grid: string[][] = [];
    const maxColsToAlloc = Math.max(targetCols, maxCol + 1 + Math.ceil(newCells / Math.max(1, wrapRows)) + 2);
    for (let c = 0; c < maxColsToAlloc; c++) {
        grid.push(new Array(wrapRows).fill(""));
    }

    for (const p of existingPlacements) {
        for (let i = 0; i < p.nCells; i++) {
            if (p.col < grid.length && p.row + i < wrapRows) {
                grid[p.col][p.row + i] = p.file.id;
            }
        }
    }

    let newFileIdx = 0;

    // Pass 1: fill empty rows in existing columns (below existing cards)
    for (let c = 0; c <= maxCol && newFileIdx < newFileIds.length; c++) {
        let r = 0;
        while (r < wrapRows && newFileIdx < newFileIds.length) {
            if (!grid[c][r]) {
                const nextId = newFileIds[newFileIdx];
                const n = allocations[nextId] || 1;
                let fits = true;
                if (r + n > wrapRows) {
                    fits = false;
                } else {
                    for (let i = 0; i < n; i++) {
                        if (grid[c][r + i]) {
                            fits = false;
                            break;
                        }
                    }
                }

                if (fits) {
                    for (let i = 0; i < n; i++) {
                        grid[c][r + i] = nextId;
                    }
                    newFileIdx++;
                    r += n;
                } else {
                    r++;
                }
            } else {
                r++;
            }
        }
    }

    // Pass 2: fill new columns to the right
    let currCol = maxCol + 1;
    while (newFileIdx < newFileIds.length) {
        while (currCol >= grid.length) {
            grid.push(new Array(wrapRows).fill(""));
        }
        let r = 0;
        while (r < wrapRows && newFileIdx < newFileIds.length) {
            const nextId = newFileIds[newFileIdx];
            const n = allocations[nextId] || 1;
            if (r + n <= wrapRows) {
                for (let i = 0; i < n; i++) {
                    grid[currCol][r + i] = nextId;
                }
                newFileIdx++;
                r += n;
            } else {
                break;
            }
        }
        currCol++;
    }

    let lastUsedCol = 0;
    for (let c = grid.length - 1; c >= 0; c--) {
        if (grid[c].some(Boolean)) {
            lastUsedCol = c;
            break;
        }
    }

    const newOrder: string[] = [];
    for (let c = 0; c <= lastUsedCol; c++) {
        let r = 0;
        while (r < wrapRows) {
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
        wrapRows
    };
}

