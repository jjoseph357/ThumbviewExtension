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

// Mock vscode module for scanner
const Module = require("module");
const origRequire = Module.prototype.require;
let mockFindFiles = null;
Module.prototype.require = function(request) {
    if (request === "vscode") {
        return {
            // file_discovery.ts falls back to findFiles(new RelativePattern(folder, "**/*"), …) when git is unavailable.
            RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
            workspace: {
                findFiles: async (inc, exc) => mockFindFiles ? mockFindFiles(inc, exc) : [],
                workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
                getConfiguration: () => ({ get: () => 30 }),
                asRelativePath: (p) => {
                    const raw = p.fsPath || p;
                    return raw.replace(/^\/workspace\//, "");
                },
                fs: { stat: async () => ({ size: 500 }) },
                openTextDocument: async () => ({ lineCount: 20, lineAt: () => ({ text: "const x = 1;" }) })
            },
            window: {
                showInformationMessage: () => {}
            }
        };
    }
    return origRequire.apply(this, arguments);
};

// Test 1: computeAutoIgnorePatterns with nested source copy folders
console.log("=== Test 1: Auto-ignore must NOT ignore nested source copy folders ===");
const { computeAutoIgnorePatterns } = require("../../out/scanner");

const userFiles = [
    // src/ has 38 files
    ...Array.from({ length: 38 }, (_, i) => `src/file_${i}.ts`),
    // src/src copy/ has 38 files
    ...Array.from({ length: 38 }, (_, i) => `src/src copy/file_${i}.ts`),
    // src/src copy 2/ has NO direct files, but contains src/src copy 2/src copy 3/ with 38 files
    ...Array.from({ length: 38 }, (_, i) => `src/src copy 2/src copy 3/file_${i}.ts`),
    // Dense assets leaf folder (non-source)
    ...Array.from({ length: 40 }, (_, i) => `assets/icons/icon_${i}.svg`)
];

const denseFolders = computeAutoIgnorePatterns(userFiles, 30, [], []);
console.log("Dense folders computed:", denseFolders);

assert.strictEqual(
    denseFolders.includes("src/src copy 2/src copy 3/"),
    false,
    "Leaf folder inside src/ must NOT be auto-ignored"
);
assert.strictEqual(
    denseFolders.includes("src/src copy/"),
    false,
    "Source copy folder must NOT be auto-ignored"
);
assert.strictEqual(
    denseFolders.includes("assets/icons/"),
    true,
    "Non-source assets folder with 40 files SHOULD be auto-ignored"
);
console.log("✓ Test 1 passed: Source folders are preserved and non-source dense folders are ignored");

// Load overview.js
const overviewPath = path.join(__dirname, "../../media/overview.js");
let code = fs.readFileSync(overviewPath, "utf8");
code += `
global.getOverviewState = () => ({
    data,
    activeRenderGrid
});
global.updateFoldersPopover = updateFoldersPopover;
`;
eval(code);

// Test 2: Active Directories collapsible tree in overview.js
console.log("\n=== Test 2: Active Directories hierarchical tree and chevron visibility ===");

mockElement("folders-popover");
const foldersListEl = mockElement("folders-list");
mockElement("ignores-list");
mockElement("ignores-count");
mockElement("shown-folders-count");

const testData = {
    command: "data",
    files: [
        // 2 root files
        { id: "r1", path: "package.json", uri: "file:///workspace/package.json", lineCount: 50 },
        { id: "r2", path: "README.md", uri: "file:///workspace/README.md", lineCount: 20 },
        // src/ direct files
        { id: "s1", path: "src/index.ts", uri: "file:///workspace/src/index.ts", lineCount: 30 },
        // src/src copy/ files
        { id: "sc1", path: "src/src copy/file1.ts", uri: "file:///workspace/src/src copy/file1.ts", lineCount: 30 },
        // src/src copy 2/ has NO direct files, only nested child src/src copy 2/src copy 3/
        { id: "sc3_1", path: "src/src copy 2/src copy 3/nested.ts", uri: "file:///workspace/src/src copy 2/src copy 3/nested.ts", lineCount: 30 }
    ],
    layout: { cols: 10, rows: 5, cellW: 40, cellH: 30, slots: [] },
    ignorePatterns: [],
    minCellWidth: 1000,
    minCellHeight: 1000
};

windowListeners["message"]({ data: testData });
global.updateFoldersPopover();

console.log("Active Directories child element count:", foldersListEl.children.length);

function getRecursiveText(node) {
    if (!node) return "";
    let res = (node.textContent || "") + " " + (node.innerHTML || "");
    if (node.children) {
        for (const child of node.children) {
            res += " " + getRecursiveText(child);
        }
    }
    return res;
}

// 1. Files must NOT be shown in Active Directories
for (const child of foldersListEl.children) {
    const text = getRecursiveText(child);
    assert.strictEqual(
        text.includes("package.json"),
        false,
        "package.json file must NOT be rendered in Active Directories"
    );
    assert.strictEqual(
        text.includes("nested.ts"),
        false,
        "nested.ts file must NOT be rendered in Active Directories"
    );
}
console.log("✓ Files are not shown in Active Directories");

// 2. Folder without direct files (src/src copy 2/) MUST display an expand/collapse arrow because it has subfolders
let copy2Item = null;
let copy3Item = null;
let srcItem = null;

for (const child of foldersListEl.children) {
    const text = getRecursiveText(child);
    if (text.includes("src copy 3")) {
        copy3Item = child;
    } else if (text.includes("src copy 2")) {
        copy2Item = child;
    } else if (text.includes("src") && !text.includes("copy")) {
        srcItem = child;
    }
}

assert(srcItem, "src/ folder item must exist in Active Directories");
assert(copy2Item, "src/src copy 2/ folder item must exist in Active Directories");
assert(copy3Item, "src/src copy 2/src copy 3/ folder item must exist in Active Directories");

// Check chevrons
function findChevronBtn(node) {
    if (!node) return null;
    if (node.classList && node.classList.contains("popover-chevron-btn")) return node;
    if (node.className && node.className.includes("popover-chevron-btn")) return node;
    if (node.children) {
        for (const c of node.children) {
            const found = findChevronBtn(c);
            if (found) return found;
        }
    }
    return null;
}

const copy2Chevron = findChevronBtn(copy2Item);
assert(
    copy2Chevron,
    "Folder without direct files (src/src copy 2/) MUST display expand/collapse arrow because it contains subfolders"
);
console.log("✓ Folder without direct files displays chevron arrow");

// 3. Leaf folder (src/src copy 2/src copy 3/) has NO subfolders, so it should NOT have a chevron
const copy3Chevron = findChevronBtn(copy3Item);
assert.strictEqual(
    copy3Chevron,
    null,
    "Leaf folder without subfolders should display a spacer instead of a chevron"
);
console.log("✓ Leaf folder displays spacer instead of chevron");

// 4. Clicking parent folder arrow (src/) toggles visibility of nested child folders
const srcChevron = findChevronBtn(srcItem);
assert(srcChevron, "src/ folder must have a chevron arrow");

console.log("Clicking src/ chevron to collapse...");
srcChevron.onclick({ stopPropagation: () => {} });

// After collapsing src/, neither src copy 2 nor src copy 3 should be in foldersListEl
let copy2AfterCollapse = null;
for (const child of foldersListEl.children) {
    const text = getRecursiveText(child);
    if (text.includes("src copy 2")) {
        copy2AfterCollapse = child;
        break;
    }
}
assert.strictEqual(
    copy2AfterCollapse,
    null,
    "Collapsing parent folder (src/) must hide all nested child folders"
);
console.log("✓ Collapsing parent folder hides all nested child folders");

// Clicking src/ chevron again expands it
console.log("Clicking src/ chevron to expand...");
// Find srcItem again since popover rerendered
for (const child of foldersListEl.children) {
    const text = getRecursiveText(child);
    if (text.includes("src") && !text.includes("copy")) {
        srcItem = child;
        break;
    }
}
const srcChevronAfter = findChevronBtn(srcItem);
srcChevronAfter.onclick({ stopPropagation: () => {} });

let copy2AfterExpand = null;
for (const child of foldersListEl.children) {
    const text = getRecursiveText(child);
    if (text.includes("src copy 2")) {
        copy2AfterExpand = child;
        break;
    }
}
assert(
    copy2AfterExpand,
    "Expanding parent folder (src/) must restore nested child folders"
);
console.log("✓ Expanding parent folder restores nested child folders");

// Test 3: scanRepository prunes redundant child ignore rules while preserving user-added rules
console.log("\n=== Test 3: Redundant child ignore rules are pruned and user rules are preserved ===");
const { scanRepository } = require("../../out/scanner");

(async () => {
    mockFindFiles = async () => [
        { fsPath: "/workspace/src/App.jsx", toString: () => "file:///workspace/src/App.jsx" },
        { fsPath: "/workspace/src/src copy/App.jsx", toString: () => "file:///workspace/src/src copy/App.jsx" },
        { fsPath: "/workspace/src/src copy 2/src copy 3/App.jsx", toString: () => "file:///workspace/src/src copy 2/src copy 3/App.jsx" },
        { fsPath: "/workspace/out/main.js", toString: () => "file:///workspace/out/main.js" }
    ];

    let persistedIgnore = null;
    const initialIgnore = {
        ignorePatterns: ["out/", "node_modules/", "src/src copy 2/src copy 3/", "src/src copy 2/"],
        autoIgnoreExclusions: []
    };

    const scanned = await scanRepository(initialIgnore, async (updated) => {
        persistedIgnore = updated;
    });

    assert(persistedIgnore, "persistIgnore should be called to clean redundant rules");
    assert(
        !persistedIgnore.ignorePatterns.includes("src/src copy 2/src copy 3/"),
        "Redundant child rule src/src copy 2/src copy 3/ must be pruned because src/src copy 2/ covers it"
    );
    assert(
        persistedIgnore.ignorePatterns.includes("src/src copy 2/"),
        "User rule src/src copy 2/ must be preserved in ignorePatterns"
    );
    assert(
        persistedIgnore.ignorePatterns.includes("out/"),
        "out/ rule must be preserved"
    );

    const scannedPaths = scanned.map(f => f.path);
    assert(
        !scannedPaths.includes("src/src copy 2/src copy 3/App.jsx"),
        "src/src copy 2/src copy 3/App.jsx must remain ignored under src/src copy 2/"
    );
    assert(
        !scannedPaths.includes("out/main.js"),
        "out/main.js must remain ignored"
    );
    console.log("✓ Redundant child ignore patterns pruned and user rules preserved");

    console.log("\n=== ALL COLLAPSIBLE TREE & SCANNER TESTS PASSED ===");
})();

