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
    dragGrabOffset,
    dragTarget,
    activeRenderGrid,
    currentIgnorePatterns,
    breadcrumb: { history: breadcrumbHistory, index: breadcrumbHistoryIndex }
});
global.setFocusedFolder = (f) => { focusedFolder = f; };
global.updateIgnoresPopover = updateIgnoresPopover;
global.updateFoldersPopover = updateFoldersPopover;
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

console.log("\n=== Test 6: Testing Expand/Reduce Grid Space with Collapsed Folders ===");
global.setFocusedFolder("");
const expandedData = {
    ...sampleData,
    extraCols: 2,
    extraRows: 1
};
messageHandler({ data: expandedData });
const stateExpanded = global.getOverviewState();
const localGrid = stateExpanded.activeRenderGrid;
assert(localGrid, "activeRenderGrid must exist");
console.log("localGrid cols & rows:", { cols: localGrid.cols, rows: localGrid.rows, slotsCount: localGrid.layout?.slots?.length });
assert.strictEqual(localGrid.layout.slots.length, localGrid.cols * localGrid.rows, "cardSlots must cover all expanded grid cells");
console.log("✓ Grid space correctly expanded for collapsed folder cards");

console.log("\n=== Test 7: Testing Folder Drag Grab Offset ===");
const testCard = stateExpanded.data._folderCards[0];
canvasMousedown({
    button: 0,
    clientX: testCard.x + 15,
    clientY: testCard.y + 25,
    preventDefault: () => {}
});
const stateGrab = global.getOverviewState();
console.log("dragGrabOffset:", stateGrab.dragGrabOffset);
assert(stateGrab.dragGrabOffset, "dragGrabOffset should be defined on mousedown");
assert.strictEqual(stateGrab.dragGrabOffset.x, 15, "dragGrabOffset.x should match cursor relative x");
assert.strictEqual(stateGrab.dragGrabOffset.y, 25, "dragGrabOffset.y should match cursor relative y");
console.log("✓ Folder drag grab offset computed correctly without top-left snapping");
canvasMouseup({
    button: 0,
    clientX: testCard.x + 15,
    clientY: testCard.y + 25,
    preventDefault: () => {}
});

console.log("\n=== Test 8: Testing Ignored Patterns Popover and Counts ===");
const popoverData = {
    ...sampleData,
    ignorePatterns: ["src/folder0/", "file_1.ts"],
    ignorePatternCounts: { "src/folder0/": 40, "file_1.ts": 1 },
    ignoredFilesMap: { "src/folder0/": ["src/folder0/file_0.ts"] }
};
messageHandler({ data: popoverData });
global.updateIgnoresPopover();

const ignoresCountEl = mockElements["ignores-count"];
assert.strictEqual(ignoresCountEl.textContent, 2, "Ignores count should be 2");
const ignoresListEl = mockElements["ignores-list"];
assert(ignoresListEl.children.length === 2, "Ignores list should contain 2 items");
console.log("✓ Ignored patterns rendered with correct counts in popover");

console.log("\n=== Test 9: Testing File Navigator (Folders Popover) Optimistic Ignore ===");
global.updateFoldersPopover();
const foldersListEl = mockElements["folders-list"];
assert(foldersListEl.children.length > 0, "Folders list should have active directories");
console.log("Folders list rendered with items:", foldersListEl.children.length);
console.log("✓ File navigator rendered successfully with optimistic ignore support");

console.log("\n=== ALL OVERVIEW DIAGNOSTIC TESTS PASSED ===");

