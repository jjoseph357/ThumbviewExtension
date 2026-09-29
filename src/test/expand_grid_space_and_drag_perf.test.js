const fs = require("fs");
const path = require("path");
const assert = require("assert");

// Mock browser environment
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
            addEventListener: (event, fn) => {
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
                if (!val) {
                    children.length = 0;
                }
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
    buildSpanningGridLocal,
    reorderSpanningItemsLocal: reorderSpanningItems,
    clampTargetToGridCapacityLocal: clampTargetToGridCapacity
};
`;

const mod = {};
const fn = new Function("module", "exports", code);
fn(mod, mod);
const { buildSpanningGridLocal, reorderSpanningItemsLocal, clampTargetToGridCapacityLocal } = mod.exports;

console.log("=== Test Suite: Expand Grid Space (Zero Reflow & Multi-Axis Expansion) ===");

// Test 1: buildSpanningGridLocal preserves file placements when expanding grid space
console.log("\n=== Test 1: buildSpanningGridLocal preserves file positions when extraCols/extraRows increase ===");
const files = [
    { id: "f1", path: "f1.ts", lineCount: 50 },
    { id: "f2", path: "f2.ts", lineCount: 50 },
    { id: "f3", path: "f3.ts", lineCount: 50 },
    { id: "f4", path: "f4.ts", lineCount: 50 }
];

// Baseline layout with extraCols = 0, extraRows = 0
const baseLayout = buildSpanningGridLocal(files, 16 / 9, null, 0, 0);
console.log("Base layout dimensions:", `cols: ${baseLayout.cols}, rows: ${baseLayout.rows}, wrapRows: ${baseLayout.wrapRows}`);
const basePlacements = baseLayout.placements.map(p => ({ id: p.file.id, col: p.col, row: p.row }));
console.log("Base placements:", basePlacements);

// Expanded layout with extraCols = 1, extraRows = 1
const exp1Layout = buildSpanningGridLocal(files, 16 / 9, null, 1, 1);
console.log("Expanded 1 layout dimensions:", `cols: ${exp1Layout.cols}, rows: ${exp1Layout.rows}, wrapRows: ${exp1Layout.wrapRows}`);
const exp1Placements = exp1Layout.placements.map(p => ({ id: p.file.id, col: p.col, row: p.row }));
console.log("Expanded 1 placements:", exp1Placements);

// Assert: Placements must be 100% identical! NO FILE MAY REFLOW OR REARRANGE!
assert.deepStrictEqual(
    exp1Placements,
    basePlacements,
    "Files MUST maintain exact positions without reflowing when expanding grid space!"
);

// Assert: Grid dimensions must expand in BOTH rows and columns
assert.strictEqual(
    exp1Layout.rows,
    baseLayout.rows + 1,
    `Rows must expand by exactly extraRows: expected ${baseLayout.rows + 1}, got ${exp1Layout.rows}`
);
assert.strictEqual(
    exp1Layout.cols,
    baseLayout.cols + 1,
    `Cols must expand by exactly extraCols: expected ${baseLayout.cols + 1}, got ${exp1Layout.cols}`
);
console.log("✓ Test 1 passed: files maintain exact positions, and both rows and columns expanded by 1");

// Test 2: Multi-step expansion (extraCols = 2, extraRows = 2)
console.log("\n=== Test 2: Multi-step expansion (extraCols = 2, extraRows = 2) ===");
const exp2Layout = buildSpanningGridLocal(files, 16 / 9, null, 2, 2);
const exp2Placements = exp2Layout.placements.map(p => ({ id: p.file.id, col: p.col, row: p.row }));

assert.deepStrictEqual(
    exp2Placements,
    basePlacements,
    "Files MUST maintain exact positions after multi-step grid expansion!"
);
assert.strictEqual(exp2Layout.rows, baseLayout.rows + 2, "Rows must expand by 2");
assert.strictEqual(exp2Layout.cols, baseLayout.cols + 2, "Cols must expand by 2");
console.log("✓ Test 2 passed: multi-step expansion preserves placements and scales both axes");

// Test 3: Dragging file into the newly created bottom row (row = baseLayout.rows)
console.log("\n=== Test 3: Dragging a file into newly added empty bottom row ===");
const currentOrder = basePlacements.map(p => p.id);
const allocations = { f1: 1, f2: 1, f3: 1, f4: 1 };
const targetRow = baseLayout.rows; // newly expanded bottom row
const res = reorderSpanningItemsLocal(
    currentOrder,
    currentOrder,
    allocations,
    "f1",
    0,
    targetRow,
    exp1Layout.cols,
    exp1Layout.rows,
    exp1Layout.wrapRows
);
console.log("Reorder result newOrder:", res.newOrder);
assert.strictEqual(res.finalTargetRow, targetRow, `f1 must occupy row ${targetRow}`);
assert.strictEqual(res.finalTargetCol, 0, "f1 must occupy col 0");

const layoutAfterDrop = buildSpanningGridLocal(files, 16 / 9, res.newOrder, 1, 1, 60, 0.05, res.rows);
const pF1 = layoutAfterDrop.placements.find(p => p.file.id === "f1");
assert.strictEqual(pF1.row, targetRow, `f1 in layout must be at bottom row ${targetRow}`);
console.log(`✓ Test 3 passed: file successfully placed in new bottom row (${targetRow})`);

console.log("\n=== ALL EXPAND GRID SPACE & DRAG TESTS PASSED ===");
