const fs = require("fs");
const path = require("path");
const assert = require("assert");

console.log("=== Test Suite: Expand & Reduce Grid Space (Pure Zoom, Zero Reflow, Aspect Ratio Preservation) ===");

// Set up mock browser environment
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
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
            getContext: () => mockCtx,
            clientWidth: 800,
            clientHeight: 600
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
    innerWidth: 800,
    innerHeight: 600,
    outerWidth: 800,
    outerHeight: 600,
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
            width: 800,
            height: 600
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

// Load overview.js
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
    setFocusedFolder: (folder) => { focusedFolder = folder; },
    handleMessage: (msg) => window._listeners["message"]({ data: msg })
};
`;

const mod = {};
const fn = new Function("module", "exports", code);
fn(mod, mod);
const {
    render,
    getData,
    setData,
    getActiveRenderGrid,
    triggerExpandSpace,
    triggerReduceSpace,
    setFocusedFolder,
    handleMessage
} = mod.exports;

// Initialize with 6 files in 2 rows x 3 columns
const testFiles = [
    { id: "a", path: "src/a.ts", uri: "file:///src/a.ts", lineCount: 50, slot: [0, 0], nCells: 1, slots: [[0, 0]] },
    { id: "b", path: "src/b.ts", uri: "file:///src/b.ts", lineCount: 50, slot: [0, 1], nCells: 1, slots: [[0, 1]] },
    { id: "c", path: "src/c.ts", uri: "file:///src/c.ts", lineCount: 50, slot: [1, 0], nCells: 1, slots: [[1, 0]] },
    { id: "d", path: "src/d.ts", uri: "file:///src/d.ts", lineCount: 50, slot: [1, 1], nCells: 1, slots: [[1, 1]] },
    { id: "e", path: "src/e.ts", uri: "file:///src/e.ts", lineCount: 50, slot: [2, 0], nCells: 1, slots: [[2, 0]] },
    { id: "f", path: "src/f.ts", uri: "file:///src/f.ts", lineCount: 50, slot: [2, 1], nCells: 1, slots: [[2, 1]] }
];

handleMessage({
    command: "data",
    mode: "spanning_grid",
    files: testFiles,
    extraCols: 0,
    extraRows: 0,
    layout: { cols: 3, rows: 2 }
});

console.log("\n=== Test 1: Base layout before Expand ===");
let d = getData();
const basePlacements = d.files.map(f => ({ id: f.id, slot: [...f.slot] }));
const baseGrid = getActiveRenderGrid();
console.log("Base grid dimensions:", `cols: ${baseGrid.cols}, rows: ${baseGrid.rows}`);
console.log("Base file slots:", basePlacements);
assert.strictEqual(baseGrid.cols, 3, "Base cols must be 3");
assert.strictEqual(baseGrid.rows, 2, "Base rows must be 2");

console.log("\n=== Test 2: Expand Grid Space (Zoom Out) ===");
// Trigger expand space
triggerExpandSpace();

d = getData();
const expandedGrid = getActiveRenderGrid();
console.log("Expanded grid dimensions:", `cols: ${expandedGrid.cols}, rows: ${expandedGrid.rows}`);
const expandedPlacements = d.files.map(f => ({ id: f.id, slot: [...f.slot] }));
console.log("Expanded file slots:", expandedPlacements);

// 1. Assert: Cols and rows both increase by exactly 1 (maintaining aspect ratio)
assert.strictEqual(expandedGrid.cols, 4, "Cols must expand from 3 to 4");
assert.strictEqual(expandedGrid.rows, 3, "Rows must expand from 2 to 3");

// 2. Assert: Placements MUST NOT REFLOW! Every single file must maintain its exact relative coordinates!
assert.deepStrictEqual(
    expandedPlacements,
    basePlacements,
    "Files MUST maintain exact relative coordinates after Expand Grid Space with ZERO reflow!"
);

// 3. Assert: In canvas pixel space, cells are smaller and tiles shift towards top-left
const baseCellW = (800 - 48) / 3;
const baseCellH = (600 - 80) / 2;
const newCellW = (800 - 48) / 4;
const newCellH = (600 - 80) / 3;
assert(newCellW < baseCellW, "Cell width must decrease on zoom out");
assert(newCellH < baseCellH, "Cell height must decrease on zoom out");

const fileF = d.files.find(f => f.id === "f");
assert(fileF._cell.x < 24 + 2 * baseCellW, "File f x-coordinate must move towards top-left (smaller x)");
assert(fileF._cell.y < 40 + 1 * baseCellH, "File f y-coordinate must move towards top-left (smaller y)");
console.log("✓ Test 2 passed: files maintain exact positions, cols/rows + 1, and tiles move towards top-left!");

console.log("\n=== Test 3: Multi-step expansion (expand again) ===");
triggerExpandSpace();
const exp2Grid = getActiveRenderGrid();
assert.strictEqual(exp2Grid.cols, 5, "Cols must expand to 5");
assert.strictEqual(exp2Grid.rows, 4, "Rows must expand to 4");
const exp2Placements = getData().files.map(f => ({ id: f.id, slot: [...f.slot] }));
assert.deepStrictEqual(exp2Placements, basePlacements, "Files must remain 100% stable after second expansion!");
console.log("✓ Test 3 passed: multi-step expansion preserves placements with zero reflow");

console.log("\n=== Test 4: Reduce Grid Space (Zoom In) ===");
// Reduce once: 5x4 -> 4x3
triggerReduceSpace();
const red1Grid = getActiveRenderGrid();
assert.strictEqual(red1Grid.cols, 4, "Cols must reduce from 5 to 4");
assert.strictEqual(red1Grid.rows, 3, "Rows must reduce from 4 to 3");
const red1Placements = getData().files.map(f => ({ id: f.id, slot: [...f.slot] }));
assert.deepStrictEqual(red1Placements, basePlacements, "Files must remain 100% stable on reduce!");

// Reduce second time: 4x3 -> 3x2 (back to base)
triggerReduceSpace();
const red2Grid = getActiveRenderGrid();
assert.strictEqual(red2Grid.cols, 3, "Cols must reduce back to 3");
assert.strictEqual(red2Grid.rows, 2, "Rows must reduce back to 2");
const red2Placements = getData().files.map(f => ({ id: f.id, slot: [...f.slot] }));
assert.deepStrictEqual(red2Placements, basePlacements, "Files must remain 100% stable back at base dimensions!");
console.log("✓ Test 4 passed: Reduce Grid Space zooms back in with zero reflow and zero file loss!");

console.log("\n=== Test 5: Safety Boundary Clamping on Reduce ===");
// Trying to reduce below base placed boundaries must be safely clamped
triggerReduceSpace();
const clampedGrid = getActiveRenderGrid();
assert.strictEqual(clampedGrid.cols, 3, "Cols must not reduce below base bounding box (3)");
assert.strictEqual(clampedGrid.rows, 2, "Rows must not reduce below base bounding box (2)");
console.log("✓ Test 5 passed: reduce is safely clamped at placed file boundaries");

console.log("\n=== Test 6: Folder Drill-Down View Zero Reflow ===");
setFocusedFolder("src/");
d = getData();
d.minCellWidth = 400;
d.folderOrders = { "src/": ["a", "b", "c", "d", "e", "f"] };
render();
const folderBaseGrid = getActiveRenderGrid();
const folderBasePlacements = folderBaseGrid.layout.placements.map(p => ({ id: p.file.id, col: p.col, row: p.row }));
console.log("Folder base placements:", folderBasePlacements);

triggerExpandSpace();
const folderExpGrid = getActiveRenderGrid();
const folderExpPlacements = folderExpGrid.layout.placements.map(p => ({ id: p.file.id, col: p.col, row: p.row }));
console.log("Folder expanded placements:", folderExpPlacements);

assert.deepStrictEqual(
    folderExpPlacements,
    folderBasePlacements,
    "Folder drill-down files MUST NOT reflow when expanding grid space!"
);
assert.strictEqual(folderExpGrid.cols, folderBaseGrid.cols + 1, "Folder cols must expand by 1");
assert.strictEqual(folderExpGrid.rows, folderBaseGrid.rows + 1, "Folder rows must expand by 1");
console.log("✓ Test 6 passed: folder drill-down view maintains exact file positions with zero reflow!");

console.log("\n=== ALL EXPAND & REDUCE GRID ZOOM TESTS PASSED ===");
