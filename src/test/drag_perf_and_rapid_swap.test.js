const fs = require("fs");
const path = require("path");
const assert = require("assert");

console.log("=== Test Suite: Drag-and-Drop Instantaneous Responsiveness & Rapid Swap Stability ===");

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
    slotOccupancy,
    findFileAt,
    findNearestSlot,
    render,
    getData: () => data,
    setData: (d) => { data = d; },
    getDraggingFile: () => draggingFile,
    setDraggingFile: (f) => { draggingFile = f; },
    getDragTarget: () => dragTarget,
    setDragTarget: (t) => { dragTarget = t; },
    getCursorPos: () => cursorPos,
    setCursorPos: (cp) => { cursorPos = cp; },
    clearDragState,
    handleMessage: (msg) => window._listeners["message"]({ data: msg }),
    handleMouseUp: (evt = {}) => {
        const fn = canvas._listeners && canvas._listeners["mouseup"];
        if (fn) fn(Object.assign({ button: 0, clientX: 0, clientY: 0, preventDefault: () => {} }, evt));
    }
};
`;

const mod = {};
const fn = new Function("module", "exports", code);
fn(mod, mod);
const {
    slotOccupancy,
    findFileAt,
    findNearestSlot,
    render,
    getData,
    setData,
    setDraggingFile,
    setDragTarget,
    setCursorPos,
    handleMessage,
    handleMouseUp
} = mod.exports;

// Initialize data payload with 4 files in a 2x2 grid
const initialFiles = [
    { id: "f1", path: "f1.ts", uri: "file:///f1.ts", lineCount: 50, slot: [0, 0], nCells: 1, slots: [[0, 0]] },
    { id: "f2", path: "f2.ts", uri: "file:///f2.ts", lineCount: 50, slot: [0, 1], nCells: 1, slots: [[0, 1]] },
    { id: "f3", path: "f3.ts", uri: "file:///f3.ts", lineCount: 50, slot: [1, 0], nCells: 1, slots: [[1, 0]] },
    { id: "f4", path: "f4.ts", uri: "file:///f4.ts", lineCount: 50, slot: [1, 1], nCells: 1, slots: [[1, 1]] }
];

handleMessage({
    command: "data",
    mode: "spanning_grid",
    files: initialFiles,
    layout: { cols: 2, rows: 2 }
});

console.log("\n=== Test 1: Initial state and slotOccupancy ===");
const fAt00 = slotOccupancy.get("0,0");
const fAt01 = slotOccupancy.get("0,1");
assert.strictEqual(fAt00.id, "f1", "slot 0,0 must be f1 initially");
assert.strictEqual(fAt01.id, "f2", "slot 0,1 must be f2 initially");
console.log("✓ Initial slotOccupancy is correct: [0,0]=f1, [0,1]=f2");

console.log("\n=== Test 2: Synchronous slotOccupancy update on mouseup ===");
// Simulate dragging f1 to swap with f2 at [0, 1]
const d = getData();
const f1 = d.files.find(f => f.id === "f1");
const f2 = d.files.find(f => f.id === "f2");
setDraggingFile(f1);
setCursorPos({ px: 100, py: 350 }); // slot [0, 1]
setDragTarget({
    col: 0,
    row: 1,
    file: f2,
    cellW: 400,
    cellH: 300,
    gridCols: 2
});

// Perform drop (mouseup)
handleMouseUp({ clientX: 100, clientY: 350 });

// Assert: f1 and f2 slots must be swapped in memory
assert.deepStrictEqual(f1.slot, [0, 1], "f1 slot must be [0, 1] immediately on mouseup");
assert.deepStrictEqual(f2.slot, [0, 0], "f2 slot must be [0, 0] immediately on mouseup");

// Assert: slotOccupancy MUST be updated synchronously without waiting for host IPC!
const occ00 = slotOccupancy.get("0,0");
const occ01 = slotOccupancy.get("0,1");
assert.strictEqual(occ00.id, "f2", "slotOccupancy at 0,0 must be updated to f2 synchronously on mouseup");
assert.strictEqual(occ01.id, "f1", "slotOccupancy at 0,1 must be updated to f1 synchronously on mouseup");
console.log("✓ Test 2 passed: slotOccupancy is updated synchronously on mouseup!");

console.log("\n=== Test 3: Rapid succession file swaps (Swap 1 then Swap 2) ===");
// Now immediately swap f3 and f4 at [1,0] and [1,1] before any host response arrives!
const f3 = d.files.find(f => f.id === "f3");
const f4 = d.files.find(f => f.id === "f4");
setDraggingFile(f3);
setCursorPos({ px: 500, py: 350 }); // slot [1, 1]
setDragTarget({
    col: 1,
    row: 1,
    file: f4,
    cellW: 400,
    cellH: 300,
    gridCols: 2
});

handleMouseUp({ clientX: 500, clientY: 350 });

// Assert: Swap 2 took effect immediately
assert.deepStrictEqual(f3.slot, [1, 1], "f3 slot must be [1, 1] immediately after Swap 2");
assert.deepStrictEqual(f4.slot, [1, 0], "f4 slot must be [1, 0] immediately after Swap 2");
assert.strictEqual(slotOccupancy.get("1,0").id, "f4", "slotOccupancy at 1,0 must be f4");
assert.strictEqual(slotOccupancy.get("1,1").id, "f3", "slotOccupancy at 1,1 must be f3");

console.log("\n=== Test 4: Stale host data message must NOT revert Swap 2 ===");
// Suppose the host finished processing Swap 1 and sends back a data message that only has Swap 1
// (i.e. f3 is still at [1,0] and f4 is at [1,1] because host hasn't processed Swap 2 yet)
const staleHostDataMsg = {
    command: "data",
    mode: "spanning_grid",
    files: [
        { id: "f1", path: "f1.ts", uri: "file:///f1.ts", lineCount: 50, slot: [0, 1], nCells: 1, slots: [[0, 1]] },
        { id: "f2", path: "f2.ts", uri: "file:///f2.ts", lineCount: 50, slot: [0, 0], nCells: 1, slots: [[0, 0]] },
        { id: "f3", path: "f3.ts", uri: "file:///f3.ts", lineCount: 50, slot: [1, 0], nCells: 1, slots: [[1, 0]] }, // STALE!
        { id: "f4", path: "f4.ts", uri: "file:///f4.ts", lineCount: 50, slot: [1, 1], nCells: 1, slots: [[1, 1]] }  // STALE!
    ],
    layout: { cols: 2, rows: 2 }
};

// Webview receives the stale message
handleMessage(staleHostDataMsg);

// ASSERT: Swap 2 MUST NOT be reverted! f3 must STILL be at [1,1] and f4 at [1,0]!
const currentF3 = getData().files.find(f => f.id === "f3");
const currentF4 = getData().files.find(f => f.id === "f4");
assert.deepStrictEqual(currentF3.slot, [1, 1], "f3 slot MUST NOT revert to stale [1, 0]!");
assert.deepStrictEqual(currentF4.slot, [1, 0], "f4 slot MUST NOT revert to stale [1, 1]!");
assert.strictEqual(slotOccupancy.get("1,1").id, "f3", "slotOccupancy at 1,1 must remain f3!");
assert.strictEqual(slotOccupancy.get("1,0").id, "f4", "slotOccupancy at 1,0 must remain f4!");

console.log("✓ Test 4 passed: stale host data message did NOT revert rapid Swap 2!");

console.log("\n=== ALL DRAG PERF & RAPID SWAP TESTS PASSED ===");
