"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cellsNeeded = cellsNeeded;
exports.buildSpanningGrid = buildSpanningGrid;
function cellsNeeded(lineCount, baseLinesPerCell = 60, compressionPct = 0.10) {
    if (lineCount <= baseLinesPerCell) {
        return 1;
    }
    const repLines = Math.max(lineCount * compressionPct, baseLinesPerCell);
    return Math.ceil(repLines / baseLinesPerCell);
}
function buildSpanningGrid(files, seenFileOrder, existingAllocations = {}, savedGridRows = null, targetAspect = 1.777, baseLinesPerCell = 60, compressionPct = 0.10) {
    const allocations = { ...existingAllocations };
    const filesById = new Map();
    for (const f of files) {
        filesById.set(f.id, f);
    }
    // Build per-file info in seen_files order
    const fileInfo = [];
    for (const fid of seenFileOrder) {
        let n = allocations[fid];
        if (!n) {
            const f = filesById.get(fid);
            n = f ? cellsNeeded(f.lineCount, baseLinesPerCell, compressionPct) : 1;
            allocations[fid] = n;
        }
        const f = filesById.get(fid);
        fileInfo.push({
            id: fid,
            nCells: n,
            file: f
        });
    }
    // Determine grid rows to approximate target aspect ratio if not set
    let gridRows = savedGridRows;
    if (!gridRows || gridRows < 1) {
        let totalCellsEstimate = 0;
        for (const fid of Object.keys(allocations)) {
            totalCellsEstimate += allocations[fid];
        }
        if (totalCellsEstimate === 0) {
            totalCellsEstimate = files.length || 1;
        }
        gridRows = Math.max(1, Math.round(Math.sqrt(totalCellsEstimate / targetAspect)));
    }
    // Column-major placement
    let currCol = 0;
    let currRow = 0;
    const placements = [];
    for (const item of fileInfo) {
        // Start a new column if this file's cells don't fit in the current column
        if (currRow > 0 && currRow + item.nCells > gridRows) {
            currCol++;
            currRow = 0;
        }
        if (item.file) {
            const slots = [];
            for (let i = 0; i < item.nCells; i++) {
                slots.push([currCol, currRow + i]);
            }
            placements.push({
                file: item.file,
                col: currCol,
                row: currRow,
                nCells: item.nCells,
                slots
            });
        }
        currRow += item.nCells;
    }
    const actualCols = currCol + 1;
    return {
        rows: gridRows,
        cols: actualCols,
        placements,
        allocations
    };
}
//# sourceMappingURL=spanning_layout.js.map