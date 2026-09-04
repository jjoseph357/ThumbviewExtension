const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { buildSpanningGrid } = require("../../out/spanning_layout");

console.log("=== Test Suite: Unignore Large Folder Layout & Subfolder Cards ===");

// -------------------------------------------------------------
// Test 1: buildSpanningGrid must add files to rows in addition to columns when files increase
// -------------------------------------------------------------
console.log("\n=== Test 1: Spanning Grid aspect ratio & row utilization after adding files ===");

// Simulate 10 files initially (small workspace or dense folder ignored)
const initialFiles = Array.from({ length: 10 }, (_, i) => ({
    id: `file_${i}`,
    path: `file_${i}.ts`,
    lineCount: 30
}));
const initialLayout = buildSpanningGrid(initialFiles, initialFiles.map(f => f.id));
console.log("Initial layout (10 files):", {
    rows: initialLayout.rows,
    cols: initialLayout.cols,
    wrapRows: initialLayout.wrapRows
});
assert.strictEqual(initialLayout.wrapRows, 2, "Initial 10 files should wrap at 2 rows");

// Now simulate unignoring a folder with 70 files (total 80 files)
const unignoredFiles = Array.from({ length: 70 }, (_, i) => ({
    id: `large_folder/file_${i}`,
    path: `large_folder/file_${i}.ts`,
    lineCount: 30
}));
const allFiles = [...initialFiles, ...unignoredFiles];
const allOrder = allFiles.map(f => f.id);

// Passing savedGridRows = 2 (the saved state before unignoring)
const newLayout = buildSpanningGrid(allFiles, allOrder, {}, initialLayout.wrapRows);
const maxRowPlaced = Math.max(...newLayout.placements.map(p => p.row));
const maxColPlaced = Math.max(...newLayout.placements.map(p => p.col));

console.log("New layout after unignoring 70 files (total 80):", {
    rows: newLayout.rows,
    cols: newLayout.cols,
    wrapRows: newLayout.wrapRows,
    maxRowPlaced,
    maxColPlaced,
    actualRowsUsed: maxRowPlaced + 1
});

// The grid MUST add files to rows (wrapRows >= 6 for 80 files)
assert(
    newLayout.wrapRows >= 6,
    `wrapRows MUST expand for 80 files! Expected >= 6, got ${newLayout.wrapRows}`
);
assert(
    maxRowPlaced >= 5,
    `Files must be placed into rows in addition to columns! Expected maxRowPlaced >= 5, got ${maxRowPlaced}`
);
// The grid MUST NOT have phantom empty rows at the bottom (rows should match maxRowPlaced + 1)
assert(
    newLayout.rows <= maxRowPlaced + 2,
    `Grid must not leave bottom half empty! rows: ${newLayout.rows}, maxRowPlaced + 1: ${maxRowPlaced + 1}`
);
// Columns should not sprawl out excessively
assert(
    newLayout.cols <= 20,
    `Grid cols must not sprawl out! Expected cols <= 20, got ${newLayout.cols}`
);

console.log("✓ Test 1 passed: files added to rows and columns without empty vertical space");

// -------------------------------------------------------------
// Test 2: Subfolder cards must appear when total files produce small cells (< 60x40)
// -------------------------------------------------------------
console.log("\n=== Test 2: Subfolder cards trigger in overview webview for large file count ===");

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
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
            getContext: () => mockCtx,
            clientWidth: 1200,
            clientHeight: 800
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

const mockCtx = {
    save: () => {},
    restore: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    fillText: () => {},
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
    innerWidth: 1200,
    innerHeight: 800,
    outerWidth: 1200,
    outerHeight: 800,
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
            onclick: null
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

global.acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => ({}),
    setState: () => {}
});

global.requestAnimationFrame = (fn) => fn();
global.cancelAnimationFrame = () => {};

// Load overview.js
const overviewPath = path.join(__dirname, "../../media/overview.js");
const code = fs.readFileSync(overviewPath, "utf8");
eval(code);

// Create 200 files grouped into 4 folders
const workspaceFiles = [];
for (let i = 0; i < 200; i++) {
    const folder = `folder_${i % 4}/`;
    workspaceFiles.push({
        id: `file_${i}`,
        path: `${folder}file_${i}.ts`,
        uri: `file:///workspace/${folder}file_${i}.ts`,
        lineCount: 40,
        nCells: 1,
        lines: [{ text: "export const a = 1;", category: "keyword" }]
    });
}

// Generate layout for 200 files
const spanningLayout200 = buildSpanningGrid(workspaceFiles, workspaceFiles.map(f => f.id));
const msgHandler = windowListeners["message"];
assert(msgHandler, "Window message listener should be registered");

const samplePayload = {
    command: "data",
    mode: "spanning_grid",
    files: workspaceFiles.map((f, i) => ({
        ...f,
        slot: [spanningLayout200.placements[i]?.col ?? 0, spanningLayout200.placements[i]?.row ?? 0],
        slots: spanningLayout200.placements[i]?.slots ?? [[0, 0]]
    })),
    layout: {
        cols: spanningLayout200.cols,
        rows: spanningLayout200.rows
    },
    openFiles: [],
    activeFile: null
};

msgHandler({ data: samplePayload });

const folderCards = samplePayload._folderCards || [];
console.log("Folder cards generated for 200 files with default settings:", folderCards.length);
assert(
    folderCards.length >= 4,
    `Expected at least 4 folder cards for 200 files across 4 folders, got: ${folderCards.length}`
);

console.log("✓ Test 2 passed: subfolder cards generated for large file count");
console.log("\n=== ALL UNIGNORE & FOLDER CARD TESTS PASSED ===");
