const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Mock vscode module for scanner testing
const Module = require("module");
const origRequire = Module.prototype.require;

const mockFiles = [
    { fsPath: "/workspace/src/index.ts", toString: () => "file:///workspace/src/index.ts" },
    { fsPath: "/workspace/src copy/index.ts", toString: () => "file:///workspace/src%20copy/index.ts" },
    { fsPath: "/workspace/src copy/core/Pane.jsx", toString: () => "file:///workspace/src%20copy/core/Pane.jsx" }
];

Module.prototype.require = function(request) {
    if (request === "vscode") {
        return {
            workspace: {
                workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
                getConfiguration: () => ({ get: (k) => k === "autoIgnoreThreshold" ? 30 : undefined }),
                asRelativePath: (p) => {
                    const str = typeof p === "string" ? p : p.fsPath;
                    return str.replace(/^\/workspace\//, "").replace(/\\/g, "/");
                },
                findFiles: async () => mockFiles,
                fs: {
                    stat: async () => ({ mtime: 1000, size: 100 }),
                    readFile: async () => Buffer.from("console.log('hello');")
                }
            },
            window: {
                showInformationMessage: () => {},
                showErrorMessage: () => {}
            },
            Uri: {
                file: (p) => ({ fsPath: p, toString: () => "file://" + p })
            }
        };
    }
    return origRequire.apply(this, arguments);
};

// Mock fs.existsSync and readFileSync for /workspace/.gitignore
const origExistsSync = fs.existsSync;
const origReadFileSync = fs.readFileSync;
const origStat = fs.promises.stat;

fs.existsSync = function(p) {
    if (typeof p === "string" && p.includes(".gitignore")) return false;
    return origExistsSync.apply(this, arguments);
};

fs.promises.stat = async function(p) {
    return { mtimeMs: 1000, size: 100 };
};

const { scanRepository } = require("../../out/scanner");

async function runTests() {
    console.log("=== Test 1: scanRepository must NOT prune user-ignored 'src copy/' pattern during reflow/rescan ===");
    
    let persistedState = null;
    const initialIgnoreState = {
        ignorePatterns: ["src copy/"],
        autoIgnoreExclusions: []
    };

    const persistIgnore = async (updated) => {
        persistedState = updated;
    };

    const files = await scanRepository(initialIgnoreState, persistIgnore);
    
    console.log("Returned files count:", files.length);
    console.log("Returned file paths:", files.map(f => f.path));
    console.log("Persisted state:", persistedState);

    // If 'src copy/' was pruned, persistedState will be { ignorePatterns: [] } or files will include 'src copy/index.ts'
    const hasSrcCopy = files.some(f => f.path.startsWith("src copy/"));
    assert.strictEqual(
        hasSrcCopy,
        false,
        "Files under 'src copy/' MUST be ignored when 'src copy/' is in ignorePatterns"
    );

    if (persistedState) {
        assert(
            persistedState.ignorePatterns.some(p => p === "src copy/" || p === "src copy"),
            `persistedState MUST retain 'src copy/'! Got: ${JSON.stringify(persistedState.ignorePatterns)}`
        );
    }

    console.log("✓ Test 1 passed: 'src copy/' is retained in ignorePatterns and files are excluded");

    console.log("\n=== Test 2: PersistentFileOrder preserves user empty slots when new files are added ===");
    const { PersistentFileOrder } = require("../../out/state");
    const order = new PersistentFileOrder();
    // User moves a tile and leaves empty space at index 0
    order.setOrder(["", "f1", "f2"]);
    
    // New file f3 is discovered
    order.update(["f1", "f2", "f3"]);
    const updatedOrder = order.getOrder();
    console.log("Updated order after new file added:", updatedOrder);

    assert.strictEqual(
        updatedOrder[0],
        "",
        "Index 0 was deliberately left empty by the user; new files must NOT overwrite it!"
    );
    assert.strictEqual(
        updatedOrder.includes("f3"),
        true,
        "New file f3 must be included in the order"
    );
    console.log("✓ Test 2 passed: PersistentFileOrder preserves empty slots when new files arrive");

    console.log("\n=== Test 3: buildSpanningGrid preserves explicit row stride when savedGridRows is given ===");
    const { buildSpanningGrid } = require("../../out/spanning_layout");
    const sampleFiles = [
        { id: "f1", lineCount: 20 },
        { id: "f2", lineCount: 20 },
        { id: "f3", lineCount: 20 }
    ];
    // Placed in a 6-row column grid:
    // col 0: f1, f2
    // col 1: f3 placed at row 4
    const spanningOrder = ["f1", "f2", "", "", "", "", "", "", "", "", "f3"];
    // With savedGridRows = 6, f3 should be in col 1 row 4
    const layout = buildSpanningGrid(sampleFiles, spanningOrder, {}, 6);
    const p3 = layout.placements.find(p => p.file.id === "f3");
    console.log("f3 placement:", p3 ? { col: p3.col, row: p3.row } : "NOT FOUND");
    assert(p3, "f3 must be placed");
    assert.strictEqual(p3.col, 1, "f3 should be in column 1");
    assert.strictEqual(p3.row, 4, "f3 should be at row 4");
    console.log("✓ Test 3 passed: buildSpanningGrid preserves explicit column stride and empty slots");

    console.log("\n=== Test 4: colorForCategory uses O(1) table lookup without DOM getComputedStyle queries ===");
    let getComputedStyleCount = 0;
    global.window = {
        innerWidth: 800,
        innerHeight: 600,
        devicePixelRatio: 1,
        addEventListener: () => {},
        focus: () => {}
    };
    global.MutationObserver = class {
        observe() {}
        disconnect() {}
    };
    const postedMessages = [];
    const mockElements = {};
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
        scale: () => {}
    };
    const canvasMock = {
        id: "map",
        getContext: () => mockCtx,
        style: {},
        addEventListener: () => {},
        classList: { add: () => {}, remove: () => {} },
        width: 800,
        height: 600,
        clientWidth: 800,
        clientHeight: 600
    };
    mockElements["map"] = canvasMock;
    mockElements["canvas"] = canvasMock;
    global.acquireVsCodeApi = () => ({
        postMessage: (m) => postedMessages.push(m),
        getState: () => ({}),
        setState: () => {}
    });
    global.document = {
        body: {
            classList: { contains: () => false },
            style: {}
        },
        getElementById: (id) => {
            if (!mockElements[id]) {
                mockElements[id] = { id, style: {}, onclick: null, innerHTML: "", textContent: "", classList: { add: () => {}, remove: () => {} }, addEventListener: () => {} };
            }
            return mockElements[id];
        },
        createElement: () => ({ getContext: () => mockCtx, style: {}, classList: { add: () => {}, remove: () => {} } }),
        addEventListener: () => {},
        hasFocus: () => true
    };
    global.getComputedStyle = () => {
        getComputedStyleCount++;
        return { getPropertyValue: () => "#1e1e24" };
    };

    const overviewCode = fs.readFileSync(path.join(__dirname, "../../media/overview.js"), "utf8");
    let overviewEnv = {};
    eval(`(function() {
        ${overviewCode}
        overviewEnv.colorForCategory = colorForCategory;
        overviewEnv.refreshThemeTokens = refreshThemeTokens;
        overviewEnv.THEME_CATEGORY_COLORS = THEME_CATEGORY_COLORS;
    })()`);

    overviewEnv.refreshThemeTokens();
    const initialCalls = getComputedStyleCount;
    // Query colors for 1000 syntax tokens (common token categories)
    const testCategories = ["comment", "keyword", "string", "number", "function", "variable", "operator", "normal"];
    for (let i = 0; i < 1000; i++) {
        const cat = testCategories[i % testCategories.length];
        const color = overviewEnv.colorForCategory(cat, false);
        assert(color, `Color should be returned for ${cat}`);
    }
    const keyColor = overviewEnv.colorForCategory("string", true);
    assert(keyColor, "Key color should be returned");

    assert.strictEqual(
        getComputedStyleCount,
        initialCalls,
        `colorForCategory must NOT invoke getComputedStyle during rendering! Invoked: ${getComputedStyleCount - initialCalls}`
    );
    console.log("✓ Test 4 passed: colorForCategory executed 1000 token color lookups with 0 DOM queries");

    console.log("\n=== Test 5: Context menu 'Refresh View' sends 'refresh' command to host ===");

    // Verify in overview.js source that menu-space-refresh triggers { command: "refresh" }
    assert(
        overviewCode.includes('document.getElementById("menu-space-refresh").onclick'),
        "menu-space-refresh click handler must be present"
    );
    assert(
        overviewCode.includes('vscode.postMessage({ command: "refresh" })'),
        "menu-space-refresh must post command 'refresh' to host"
    );
    console.log("✓ Test 5 passed: menu-space-refresh posts 'refresh' to host to clear cache and rescan");
}

runTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});

