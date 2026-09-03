const fs = require("fs");
const path = require("path");
const assert = require("assert");

// Mock browser environment
const listeners = {};
const mockElement = (id) => ({
    id,
    style: {},
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    appendChild: () => {},
    addEventListener: (event, fn) => {
        listeners[id + ":" + event] = fn;
    },
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getContext: () => mockCtx,
    clientWidth: 800,
    clientHeight: 600
});

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
    createElement: (tag) => mockElement(tag),
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
global.getOverviewState = () => ({
    data,
    focusedFolder,
    draggingFolder,
    dragTarget,
    activeRenderGrid,
    breadcrumb: { history: breadcrumbHistory, index: breadcrumbHistoryIndex }
});
global.setFocusedFolder = (f) => { focusedFolder = f; };
`;

try {
    eval(code);
    console.log("✓ Evaluated overview.js successfully");
} catch (e) {
    console.error("✗ Failed to eval overview.js:", e);
    process.exit(1);
}

// Check window message listener
const messageHandler = windowListeners["message"];
assert(messageHandler, "Window message listener should be registered");

// Synthesize a dense workspace with 200 files in subfolders, so rootCellsTooSmall is true
const files = [];
for (let i = 0; i < 200; i++) {
    const folder = `src/folder${i % 5}/`;
    files.push({
        id: `file_${i}`,
        path: `${folder}file_${i}.ts`,
        uri: `file:///workspace/${folder}file_${i}.ts`,
        lineCount: 50,
        nCells: 1,
        lines: [{ text: "const x = 1;", category: "keyword" }]
    });
}

// Post layout update
const sampleData = {
    command: "data",
    files,
    layout: {
        cols: 25,
        rows: 8,
        cellW: 10, // < MIN_CELL_W (32)
        cellH: 10, // < MIN_CELL_H (28)
        slots: []
    },
    layoutMode: "spanning_grid",
    openFiles: [],
    activeFile: null,
    previewMode: "full",
    enableCodeCompression: true,
    baseLinesPerCell: 60,
    compressionPct: 0.05
};

console.log("\n=== Test 1: Simulating Webview Message Update ===");
try {
    messageHandler({ data: sampleData });
    console.log("✓ Processed layout update without crashing");
} catch (e) {
    console.error("✗ Crash on layout update:", e);
}

console.log("\n=== Test 2: Checking Folder Cards and Mini Mosaic ===");
const state = global.getOverviewState();
console.log("data._folderCards count:", state.data?._folderCards?.length);
const folderCards = state.data?._folderCards || [];
assert(folderCards.length > 0, "Expected folder cards to be generated in subfolder card mode");
console.log("✓ Folder cards generated:", folderCards.length);

const firstCard = folderCards[0];
console.log("First card folderPath:", firstCard.folderPath);
console.log("First card rect:", { x: firstCard.x, y: firstCard.y, w: firstCard.w, h: firstCard.h });

console.log("\n=== Test 3: Clicking to Drill Down into Folder Card ===");
const canvasMousedown = listeners["map:mousedown"];
const canvasMouseup = listeners["map:mouseup"];
assert(canvasMousedown && canvasMouseup, "Mousedown and mouseup listeners must exist");

// Simulate click on first card
const clickEventDown = {
    button: 0,
    clientX: firstCard.x + 10,
    clientY: firstCard.y + 10,
    preventDefault: () => {}
};
canvasMousedown(clickEventDown);

const clickEventUp = {
    button: 0,
    clientX: firstCard.x + 10,
    clientY: firstCard.y + 10,
    preventDefault: () => {}
};
canvasMouseup(clickEventUp);

const stateAfterClick = global.getOverviewState();
console.log("Focused folder after click:", stateAfterClick.focusedFolder);
assert.strictEqual(stateAfterClick.focusedFolder, firstCard.folderPath, "Should drill down into clicked folder");
console.log("✓ Drilled down into folder successfully");

console.log("\n=== Test 4: Testing Drag Target and Outline ===");
// Reset to root
global.setFocusedFolder("");
messageHandler({ data: sampleData });

// Simulate drag on folder card
canvasMousedown({
    button: 0,
    clientX: firstCard.x + 10,
    clientY: firstCard.y + 10,
    preventDefault: () => {}
});

// Move mouse beyond DRAG_THRESHOLD (5px)
const canvasMousemove = listeners["map:mousemove"];
canvasMousemove({
    clientX: firstCard.x + 50,
    clientY: firstCard.y + 50,
    buttons: 1,
    preventDefault: () => {}
});

const stateDuringDrag = global.getOverviewState();
console.log("draggingFolder:", !!stateDuringDrag.draggingFolder);
console.log("dragTarget:", stateDuringDrag.dragTarget);

assert(stateDuringDrag.dragTarget, "dragTarget must be computed during drag");
console.log("✓ Drag target found:", { col: stateDuringDrag.dragTarget.col, row: stateDuringDrag.dragTarget.row });

// Complete drag in Test 4
canvasMouseup({
    button: 0,
    clientX: firstCard.x + 50,
    clientY: firstCard.y + 50,
    preventDefault: () => {}
});

console.log("\n=== Test 5: Testing Mouse Side Button Breadcrumb Navigation ===");
// Click first card to navigate into src/
canvasMousedown(clickEventDown);
canvasMouseup(clickEventUp);
console.log("Current breadcrumb state:", global.getOverviewState().breadcrumb);
assert.strictEqual(global.getOverviewState().focusedFolder, "src/", "Should be drilled into src/");

// Trigger back button (button 3)
const windowMouseup = windowListeners["mouseup"];
assert(windowMouseup, "window mouseup listener must exist");

windowMouseup({
    button: 3,
    preventDefault: () => {},
    stopPropagation: () => {}
});

console.log("Focused folder after back mouse button (3):", `"${global.getOverviewState().focusedFolder}"`);
console.log("Breadcrumb state after back:", global.getOverviewState().breadcrumb);
assert.strictEqual(global.getOverviewState().focusedFolder, "", "Back button should navigate back to root");
console.log("✓ Back side mouse button navigated to root");

// Trigger forward button (button 4)
windowMouseup({
    button: 4,
    preventDefault: () => {},
    stopPropagation: () => {}
});

console.log("Focused folder after forward mouse button (4):", `"${global.getOverviewState().focusedFolder}"`);
assert.strictEqual(global.getOverviewState().focusedFolder, "src/", "Forward button should navigate forward to src/");
console.log("✓ Forward side mouse button navigated back to src/");

console.log("\n=== ALL OVERVIEW DIAGNOSTIC TESTS PASSED ===");
