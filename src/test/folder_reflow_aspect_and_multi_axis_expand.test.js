const fs = require("fs");
const path = require("path");
const assert = require("assert");

console.log("=== Test Suite: Folder Card Reflow Aspect Ratio & Multi-Axis Grid Expansion ===");

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
    buildSpanningGridLocal,
    setFocusedFolder: (folder) => { focusedFolder = folder; },
    handleMessage: (msg) => window._listeners["message"]({ data: msg }),
    getReflowBtn: () => document.getElementById("reflow-layout-btn"),
    getMenuReflow: () => document.getElementById("menu-space-reflow")
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
    buildSpanningGridLocal,
    setFocusedFolder,
    handleMessage,
    getReflowBtn
} = mod.exports;

// -----------------------------------------------------------------------------
// Test 1: Folder reflow utilizes 100% canvas width with 0 empty ghost columns
// -----------------------------------------------------------------------------
console.log("\n=== Test 1: Folder Reflow Aspect Ratio & Zero Ghost Columns ===");

const files12 = Array.from({ length: 12 }, (_, i) => ({
    id: `src/file_${i}.ts`,
    path: `src/file_${i}.ts`,
    uri: `file:///src/file_${i}.ts`,
    lineCount: 50,
    nCells: 1
}));

const layout12 = buildSpanningGridLocal(files12, 16 / 9, null, 0, 0);
console.log(`12 files layout dimensions: ${layout12.cols} cols x ${layout12.rows} rows`);

// Assert: 12 files pack into 4 cols x 3 rows
assert.strictEqual(layout12.cols, 4, "12 files must occupy exactly 4 columns (not 6 columns with 1/3 empty void)");
assert.strictEqual(layout12.rows, 3, "12 files must occupy 3 rows");

// Calculate tile aspect ratio on 1920x1080 canvas
const canvasAvailW = 1920 - 48;
const canvasAvailH = 1080 - 80;
const tileW = canvasAvailW / layout12.cols;
const tileH = canvasAvailH / layout12.rows;
const tileAspect = tileW / tileH;
console.log(`Tile aspect ratio: ${tileAspect.toFixed(3)}:1 (tileW: ${tileW.toFixed(1)}px, tileH: ${tileH.toFixed(1)}px)`);

assert(
    tileAspect >= 1.2,
    `Tile aspect ratio must be widescreen (>= 1.2), got ${tileAspect.toFixed(3)}:1. Files are no longer vertically squished!`
);

// Check that every column contains files
const occupiedCols = new Set(layout12.placements.map(p => p.col));
assert.strictEqual(occupiedCols.size, layout12.cols, "Every column must be occupied - 0 ghost columns on the right!");
console.log("✓ Test 1 passed: 100% canvas width utilized, no empty 1/3 right void, widescreen tile aspect ratio preserved");

// -----------------------------------------------------------------------------
// Test 2: Expand Grid inside folder card expands BOTH height and width
// -----------------------------------------------------------------------------
console.log("\n=== Test 2: Expand Grid Space Multi-Axis Expansion Inside Folder Card ===");

handleMessage({
    command: "data",
    mode: "spanning_grid",
    files: files12,
    extraCols: 0,
    extraRows: 0,
    minCellWidth: 400,
    minCellHeight: 300,
    folderExtraCols: {},
    folderExtraRows: {},
    folderOrders: {},
    folderWrapRows: {},
    layout: { cols: 4, rows: 3 }
});

setFocusedFolder("src/");
render();

const initialGrid = getActiveRenderGrid();
console.log(`Initial folder view: ${initialGrid.cols} cols x ${initialGrid.rows} rows`);
assert.strictEqual(initialGrid.cols, 4, "Initial folder view cols must be 4");
assert.strictEqual(initialGrid.rows, 3, "Initial folder view rows must be 3");

const initialPlacements = initialGrid.layout.placements.map(p => ({ id: p.file.id, col: p.col, row: p.row }));

// Expand 1
triggerExpandSpace();
const expGrid1 = getActiveRenderGrid();
console.log(`After Expand 1: ${expGrid1.cols} cols x ${expGrid1.rows} rows`);
assert.strictEqual(expGrid1.cols, 5, "Cols must increase by 1 (4 -> 5)");
assert.strictEqual(expGrid1.rows, 4, "Rows must increase by 1 (3 -> 4) - Height MUST NOT be frozen!");

const exp1Placements = expGrid1.layout.placements.map(p => ({ id: p.file.id, col: p.col, row: p.row }));
assert.deepStrictEqual(
    exp1Placements,
    initialPlacements,
    "Tiles must maintain exact positions relative to each other with zero reflow!"
);

// Expand 2
triggerExpandSpace();
const expGrid2 = getActiveRenderGrid();
console.log(`After Expand 2: ${expGrid2.cols} cols x ${expGrid2.rows} rows`);
assert.strictEqual(expGrid2.cols, 6, "Cols must increase by 1 (5 -> 6)");
assert.strictEqual(expGrid2.rows, 5, "Rows must increase by 1 (4 -> 5) - Multi-axis height and width expanded!");

console.log("✓ Test 2 passed: Expand Grid scales both height and width symmetrically, maintaining relative positions");

// -----------------------------------------------------------------------------
// Test 3: Reflow inside folder card resets folder dimensions and subsequent expand works
// -----------------------------------------------------------------------------
console.log("\n=== Test 3: Reflow Layout Inside Folder Card Resets Dimensions Cleanly ===");

// Click toolbar reflow button
const reflowBtn = getReflowBtn();
assert(reflowBtn, "Reflow layout toolbar button must exist");
reflowBtn.onclick();

// Verify client-side folder caches are cleared
const dataAfterReflow = getData();
assert.strictEqual(dataAfterReflow.folderExtraCols["src/"], undefined, "folderExtraCols['src/'] must be cleared");
assert.strictEqual(dataAfterReflow.folderExtraRows["src/"], undefined, "folderExtraRows['src/'] must be cleared");
// Reflow clears the saved column height; the next render re-freezes it at the fresh natural
// value (reconcileFolderFileOrder) so later additions cannot re-wrap the new baseline.
assert(
    dataAfterReflow.folderWrapRows["src/"] === undefined || dataAfterReflow.folderWrapRows["src/"] === 3,
    "folderWrapRows['src/'] must be reset to the natural base rows"
);

const gridAfterReflow = getActiveRenderGrid();
console.log(`Grid after folder reflow: ${gridAfterReflow.cols} cols x ${gridAfterReflow.rows} rows`);
assert.strictEqual(gridAfterReflow.cols, 4, "Cols must reset back to 4 base columns");
assert.strictEqual(gridAfterReflow.rows, 3, "Rows must reset back to 3 base rows");

// Verify postMessage sent reflow command with focusedFolder
const lastMsg = postedMessages[postedMessages.length - 1];
assert.strictEqual(lastMsg.command, "reflow", "Must send reflow command to host");
assert.strictEqual(lastMsg.focusedFolder, "src/", "Must pass focusedFolder = 'src/' to host");

// Now press Expand Grid after reflow
triggerExpandSpace();
const gridAfterExpPostReflow = getActiveRenderGrid();
console.log(`Grid after expand post-reflow: ${gridAfterExpPostReflow.cols} cols x ${gridAfterExpPostReflow.rows} rows`);
assert.strictEqual(gridAfterExpPostReflow.cols, 5, "Cols must expand from 4 to 5 after reflow");
assert.strictEqual(gridAfterExpPostReflow.rows, 4, "Rows must expand from 3 to 4 after reflow - Height expands properly!");

console.log("✓ Test 3 passed: Reflow resets folder dimensions and subsequent expansion scales both axes symmetrically");

console.log("\n=== ALL FOLDER REFLOW & MULTI-AXIS EXPANSION TESTS PASSED ===");
