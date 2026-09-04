const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Mock browser environment to test overview.js logic
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

global.document = {
    body: {
        classList: { contains: () => false },
        style: {}
    },
    getElementById: (id) => mockElement(id),
    createElement: (tag) => {
        const children = [];
        const el = {
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
        return el;
    },
    addEventListener: () => {},
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
let code = fs.readFileSync(overviewPath, "utf8");
code += `
global.buildSpanningGridLocal = buildSpanningGridLocal;
global.getOverviewState = () => ({
    data,
    activeRenderGrid
});
global.render = render;
global.setFocusedFolderWithHistory = setFocusedFolderWithHistory;
`;

eval(code);

console.log("=== Test 1: buildSpanningGridLocal with newly added files when folderOrder exists ===");

const existingFiles = [
    { id: "f1", path: "src/file1.ts", lineCount: 20 },
    { id: "f2", path: "src/file2.ts", lineCount: 30 }
];

const folderOrder = ["f1", "f2"];

// User copies and pastes a new folder with files into src/
const newFiles = [
    ...existingFiles,
    { id: "f3", path: "src/pasted/file3.ts", lineCount: 25 },
    { id: "f4", path: "src/pasted/file4.ts", lineCount: 40 }
];

const layout = global.buildSpanningGridLocal(newFiles, 1.777, folderOrder);
console.log("Placements count:", layout.placements.length, "Total files:", newFiles.length);

const placedIds = layout.placements.map(p => p.file.id);
console.log("Placed file IDs:", placedIds);

assert.strictEqual(
    placedIds.includes("f3"),
    true,
    "buildSpanningGridLocal must include newly added file f3 even if folderOrder exists"
);
assert.strictEqual(
    placedIds.includes("f4"),
    true,
    "buildSpanningGridLocal must include newly added file f4 even if folderOrder exists"
);
assert.strictEqual(
    layout.placements.length,
    newFiles.length,
    `All ${newFiles.length} files should be placed, but only ${layout.placements.length} were placed`
);
console.log("✓ Test 1 passed: buildSpanningGridLocal includes new files");

console.log("\n=== Test 2: Uniform Grid folder drill-down with newly added files when folderOrder exists ===");

const initialData = {
    command: "data",
    mode: "uniform_grid",
    files: newFiles.map(f => ({ ...f, uri: "file:///" + f.path })),
    layout: { cols: 4, rows: 2, cellW: 40, cellH: 30, slots: [[0,0], [1,0], [2,0], [3,0]] },
    folderOrders: {
        "src/": ["f1", "f2"]
    },
    ignorePatterns: [],
    minCellWidth: 1000,
    minCellHeight: 1000
};

// Set focusedFolder to src/ so shouldOpenFolder is true
windowListeners["message"]({ data: initialData });
global.setFocusedFolderWithHistory("src/");
global.render();

const renderedFiles = global.getOverviewState().data.files;
for (const f of renderedFiles) {
    assert(
        f._cell,
        `File ${f.id} (${f.path}) must have a _cell assigned during render in folder view, but got: ${JSON.stringify(f._cell)}`
    );
}

console.log("✓ Test 2 passed: uniform grid folder view renders all new files");

console.log("\n=== Test 3: Auto-ignore directory candidate selection ===");

const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function(request) {
    if (request === "vscode") {
        return {
            workspace: {
                getConfiguration: () => ({ get: () => 30 }),
                asRelativePath: (p) => p.fsPath || p
            },
            window: {
                showInformationMessage: () => {}
            }
        };
    }
    return origRequire.apply(this, arguments);
};

// Import auto-ignore heuristic
const { computeAutoIgnorePatterns } = require("../../out/scanner");

const workspaceRelativeFiles = [
    // 10 files in src/
    ...Array.from({ length: 10 }, (_, i) => `src/file_${i}.ts`),
    // 25 files in src/pasted/
    ...Array.from({ length: 25 }, (_, i) => `src/pasted/sub_${i}.ts`)
];

// With threshold 30, src/ has 10 direct files, src/pasted has 25 direct files.
// Neither folder has >30 direct files. src/ should NOT be auto-ignored!
const denseFolders = computeAutoIgnorePatterns(workspaceRelativeFiles, 30, [], []);
console.log("Computed denseFolders:", denseFolders);

assert.strictEqual(
    denseFolders.includes("src/"),
    false,
    "Parent folder src/ must NOT be auto-ignored when a subfolder is pasted into it!"
);

console.log("✓ Test 3 passed: parent folder is not auto-ignored");

console.log("\n=== Test 4: Dense non-source leaf directory auto-ignored ===");
const denseLeafFiles = [
    ...Array.from({ length: 40 }, (_, i) => `assets/icons/icon_${i}.svg`)
];
const denseLeafResult = computeAutoIgnorePatterns(denseLeafFiles, 30, [], []);
console.log("Dense leaf folders:", denseLeafResult);
assert(
    denseLeafResult.includes("assets/icons/"),
    "assets/icons/ with 40 direct files should be auto-ignored"
);
console.log("✓ Test 4 passed: dense leaf folder is auto-ignored");

console.log("\n=== Test 5: Library folder is auto-ignored regardless of count ===");
const libFiles = [
    "vendor/bundle/setup.rb",
    "vendor/bundle/lib.rb"
];
const libResult = computeAutoIgnorePatterns(libFiles, 30, [], []);
console.log("Lib folders:", libResult);
assert(
    libResult.some(f => f.startsWith("vendor/")),
    "vendor/ directory should be auto-ignored as a library directory"
);
console.log("✓ Test 5 passed: library folder is auto-ignored");

console.log("\n=== Test 6: folderOrder with holes fills holes first and then appends ===");
const orderWithHoles = ["f1", "", "f2"];
const threeFiles = [
    { id: "f1", path: "src/file1.ts", lineCount: 20 },
    { id: "f2", path: "src/file2.ts", lineCount: 30 },
    { id: "f3", path: "src/file3.ts", lineCount: 15 },
    { id: "f4", path: "src/file4.ts", lineCount: 25 }
];
const holeLayout = global.buildSpanningGridLocal(threeFiles, 1.777, orderWithHoles);
const holePlacedIds = holeLayout.placements.map(p => p.file.id);
console.log("Hole placements IDs:", holePlacedIds);
assert.strictEqual(holePlacedIds[0], "f1");
assert.strictEqual(holePlacedIds[1], "f3", "f3 should fill the hole at index 1");
assert.strictEqual(holePlacedIds[2], "f2");
assert.strictEqual(holePlacedIds[3], "f4", "f4 should append after f2");
console.log("✓ Test 6 passed: holes are filled first and new files append cleanly");
