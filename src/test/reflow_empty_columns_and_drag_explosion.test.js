const assert = require("assert");
const fs = require("fs");
const path = require("path");

console.log("=== Test Suite: Reflow Ghost Columns & Grid Zoom Explosion Fix (v0.4.7) ===");

// -----------------------------------------------------------------------------
// Vertical Slice 1: Seam 1 - buildSpanningGrid in src/spanning_layout.ts
// -----------------------------------------------------------------------------
console.log("\n=== Slice 1: Seam 1 - Zero Ghost Columns on Reflow ===");

const { buildSpanningGrid } = require("../../out/spanning_layout.js");

// Test 1a: 12 files pack into 4 cols x 3 rows with 0 empty columns
const files12 = Array.from({ length: 12 }, (_, i) => ({
    id: `file_${i}`,
    path: `src/file_${i}.ts`,
    uri: `file:///src/file_${i}.ts`,
    lineCount: 50
}));
const res12 = buildSpanningGrid(files12, files12.map(f => f.id));
const usedCols12 = Math.max(...res12.placements.map(p => p.col)) + 1;
console.log(`12 files: cols=${res12.cols}, rows=${res12.rows}, usedCols=${usedCols12}`);
assert.strictEqual(
    res12.cols,
    usedCols12,
    `12 files must have zero empty ghost columns on the right (cols=${res12.cols}, usedCols=${usedCols12})`
);

// Test 1b: 68 files with tall files (e.g. 68 files, some spanning -> ~76 cells)
const files68 = Array.from({ length: 68 }, (_, i) => ({
    id: `file_${i}`,
    path: `src/file_${i}.ts`,
    uri: `file:///src/file_${i}.ts`,
    lineCount: i < 8 ? 1500 : 50 // 8 files are 2 cells tall = 76 cells total
}));
const res68 = buildSpanningGrid(files68, files68.map(f => f.id));
const usedCols68 = Math.max(...res68.placements.map(p => p.col)) + 1;
console.log(`68 files (76 cells): cols=${res68.cols}, rows=${res68.rows}, usedCols=${usedCols68}`);
assert.strictEqual(
    res68.cols,
    usedCols68,
    `68 files must completely fill the space with zero empty columns on the right (cols=${res68.cols}, usedCols=${usedCols68})`
);

// Test 1c: Sweeping 1..100 files, verify cols strictly matches usedCols for all n >= 2
for (let n = 2; n <= 100; n++) {
    const filesN = Array.from({ length: n }, (_, i) => ({
        id: `file_${i}`,
        path: `src/file_${i}.ts`,
        uri: `file:///src/file_${i}.ts`,
        lineCount: 50
    }));
    const resN = buildSpanningGrid(filesN, filesN.map(f => f.id));
    const usedColsN = Math.max(...resN.placements.map(p => p.col)) + 1;
    assert.strictEqual(
        resN.cols,
        usedColsN,
        `File count ${n} has ${resN.cols - usedColsN} empty ghost columns on the right! cols=${resN.cols}, usedCols=${usedColsN}`
    );
}

console.log("✓ Slice 1 passed: Zero empty ghost columns across all file counts");

// -----------------------------------------------------------------------------
// Vertical Slice 2: Seam 2 - Column Stride & Preserved Positions in reorderSpanningItems
// -----------------------------------------------------------------------------
console.log("\n=== Slice 2: Seam 2 - Column Stride Stability in reorderSpanningItems ===");

const { reorderSpanningItems } = require("../../out/reorder_helpers.js");

// Test 2a: When maxAllowedRows > wrapRows (e.g. extraRows > 0), dragging within columns preserves column boundaries
const files12_order = files12.map(f => f.id);
const allocs12 = {};
for (const f of files12) allocs12[f.id] = 1;

// wrapRows = 3, maxAllowedRows = 4 (extraRows = 1), maxAllowedCols = 4
// Drag file_0 to col 0, row 1
const reorder12 = reorderSpanningItems(files12_order, files12_order, allocs12, "file_0", 0, 1, 4, 4, 3);
assert.strictEqual(reorder12.newOrder.filter(Boolean).length, 12, "All 12 files must be preserved in newOrder");

// Unpack newOrder using buildSpanningGrid with wrapRows = reorder12.rows
const unpacked12 = buildSpanningGrid(files12, reorder12.newOrder, allocs12, reorder12.rows);
// Verify file_3 is at col 1, row 0 (NOT shifted to row 1!)
const file3 = unpacked12.placements.find(p => p.file.id === "file_3");
assert(file3, "file_3 must exist in placements");
assert.strictEqual(file3.col, 1, `file_3 should be in col 1, got col ${file3.col}`);
assert.strictEqual(file3.row, 0, `file_3 should be at row 0 (not displaced by extraRows padding!), got row ${file3.row}`);

// Test 2b: Dragging file in 68-file layout to an empty column on the right with extraCols > 0
const files68_order = files68.map(f => f.id);
const allocs68 = {};
for (const f of files68) allocs68[f.id] = f.lineCount > 1000 ? 2 : 1;
const wrapRows68 = res68.wrapRows;
const maxAllowedCols68 = res68.cols + 2; // extraCols = 2
const maxAllowedRows68 = res68.rows + 1; // extraRows = 1
const targetEmptyCol = res68.cols; // first empty column to the right
const reorder68 = reorderSpanningItems(files68_order, files68_order, allocs68, "file_0", targetEmptyCol, 0, maxAllowedCols68, maxAllowedRows68, wrapRows68);
assert.strictEqual(reorder68.newOrder.filter(Boolean).length, 68, "All 68 files must be preserved in newOrder");

const unpacked68 = buildSpanningGrid(files68, reorder68.newOrder, allocs68, reorder68.rows);
assert.strictEqual(unpacked68.placements.length, 68, "All 68 files must be placed");
const moved0 = unpacked68.placements.find(p => p.file.id === "file_0");
assert(moved0, "file_0 must be found");
assert.strictEqual(moved0.col, targetEmptyCol, `file_0 must be at col ${targetEmptyCol}`);
assert.strictEqual(moved0.row, 0, "file_0 must be at row 0");

// Check that file_1 stayed in col 0 at row 2
const file1_68 = unpacked68.placements.find(p => p.file.id === "file_1");
assert(file1_68, "file_1 must be found");
assert.strictEqual(file1_68.col, 0, "file_1 must remain in col 0");
assert.strictEqual(file1_68.row, 2, "file_1 must maintain its exact row 2 placement");

console.log("✓ Slice 2 passed: Column stride preserved with zero displacement");

// -----------------------------------------------------------------------------
// Vertical Slice 3: Seam 3 - Webview Root View State & Drag Pipeline
// -----------------------------------------------------------------------------
console.log("\n=== Slice 3: Seam 3 - Webview Root View wrapRows & Drag Pipeline ===");

// Set up mock DOM environment
const listeners = {};
const mockElements = {};
const mockElement = (id) => {
    if (!mockElements[id]) {
        let _innerHTML = "";
        const children = [];
        const el = {
            id,
            style: {},
            classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
            appendChild: (child) => children.push(child),
            children,
            textContent: "",
            value: "",
            _listeners: {},
            addEventListener: (event, fn) => {
                el._listeners[event] = fn;
                listeners[id + ":" + event] = fn;
            },
            contains: () => false,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
            getContext: () => mockCtx,
            clientWidth: 1920,
            clientHeight: 1080
        };
        Object.defineProperty(el, "innerHTML", {
            get: () => _innerHTML,
            set: (val) => {
                _innerHTML = val;
                if (!val) children.length = 0;
            }
        });
        mockElements[id] = el;
    }
    return mockElements[id];
};

const calls = [];
const mockCtx = {
    save: () => {},
    restore: () => {},
    fillRect: (...args) => calls.push({ type: "fillRect", args }),
    strokeRect: (...args) => calls.push({ type: "strokeRect", args }),
    fillText: (...args) => calls.push({ type: "fillText", args }),
    measureText: (text) => ({ width: text.length * 6 }),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    arc: () => {},
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    drawImage: () => {},
    clearRect: () => {},
    setLineDash: () => {},
    setTransform: () => {},
    scale: () => {},
    lineWidth: 1,
    fillStyle: "#000",
    strokeStyle: "#000",
    font: "10px sans-serif",
    globalAlpha: 1
};

const windowListeners = {};
global.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    outerWidth: 1920,
    outerHeight: 1080,
    devicePixelRatio: 1,
    _listeners: windowListeners,
    addEventListener: (event, fn) => {
        windowListeners[event] = fn;
    },
    removeEventListener: () => {},
    focus: () => {}
};

global.MutationObserver = class {
    observe() {}
    disconnect() {}
};

const docListeners = {};
global.document = {
    body: {
        classList: { contains: () => false },
        style: {}
    },
    getElementById: (id) => mockElement(id),
    createElement: (tag) => {
        const children = [];
        return {
            tag,
            style: {},
            classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
            appendChild: (child) => children.push(child),
            children,
            innerHTML: "",
            textContent: "",
            title: "",
            onclick: null,
            getContext: () => mockCtx,
            width: 1920,
            height: 1080
        };
    },
    _listeners: docListeners,
    addEventListener: (event, fn) => {
        docListeners[event] = fn;
    },
    hasFocus: () => true
};

global.getComputedStyle = () => ({
    getPropertyValue: () => ""
});

const postedMessages = [];
global.acquireVsCodeApi = () => ({
    postMessage: (msg) => postedMessages.push(msg),
    getState: () => ({}),
    setState: () => {}
});

global.requestAnimationFrame = (fn) => fn();
global.cancelAnimationFrame = () => {};

// Load media/overview.js
const overviewPath = path.join(__dirname, "../../media/overview.js");
let code = fs.readFileSync(overviewPath, "utf8");
code += `
module.exports = {
    render,
    getData: () => data,
    setData: (d) => { data = d; },
    getActiveRenderGrid: () => activeRenderGrid,
    triggerExpandSpace,
    triggerReduceSpace,
    handleMessage: (msg) => window._listeners["message"]({ data: msg })
};
`;

const mod = {};
new Function("module", "exports", code)(mod, mod);
const {
    render,
    getData,
    getActiveRenderGrid,
    triggerExpandSpace,
    triggerReduceSpace,
    handleMessage
} = mod.exports;

// Test 3a: Receive data in root spanning mode with 68 files
const filesWithSlots68 = res68.placements.map(p => ({
    ...p.file,
    slot: [p.col, p.row],
    nCells: p.nCells,
    slots: p.slots
}));

handleMessage({
    command: "data",
    mode: "spanning_grid",
    files: filesWithSlots68,
    fileOrder: files68_order,
    extraCols: 0,
    extraRows: 0,
    layout: {
        cols: res68.cols,
        rows: res68.rows,
        wrapRows: res68.wrapRows
    }
});

render();

const rootGrid = getActiveRenderGrid();
console.log(`Root grid: cols=${rootGrid.cols}, rows=${rootGrid.rows}, wrapRows=${rootGrid.wrapRows}`);
assert.strictEqual(rootGrid.wrapRows, res68.wrapRows, `activeRenderGrid.wrapRows must equal layout.wrapRows (${res68.wrapRows}), not undefined!`);

// Test 3b: Triggering Expand and Reduce keeps all 68 files 100% stable with zero reflow
triggerExpandSpace();
const expandedData = getData();
assert.strictEqual(expandedData.files.length, 68, "All 68 files must remain after expand");
const expGrid = getActiveRenderGrid();
assert.strictEqual(expGrid.cols, res68.cols + 1, "Cols must expand by 1");
assert.strictEqual(expGrid.rows, res68.rows + 1, "Rows must expand by 1");
assert.strictEqual(expGrid.wrapRows, res68.wrapRows, "wrapRows must remain stable on expand");

triggerReduceSpace();
const reducedData = getData();
assert.strictEqual(reducedData.files.length, 68, "All 68 files must remain after reduce");
const redGrid = getActiveRenderGrid();
assert.strictEqual(redGrid.cols, res68.cols, "Cols must return to base cols");
assert.strictEqual(redGrid.rows, res68.rows, "Rows must return to base rows");
assert.strictEqual(redGrid.wrapRows, res68.wrapRows, "wrapRows must remain stable on reduce");

console.log("✓ Slice 3 passed: Webview Root View wrapRows & drag pipeline stable");
