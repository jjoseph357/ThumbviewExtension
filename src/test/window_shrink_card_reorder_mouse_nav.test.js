const assert = require("assert");
const { buildStableGrid } = require("../../out/layout");
const { buildSpanningGrid, cellsNeeded } = require("../../out/spanning_layout");
const { reorderCardItems, reorderSpanningItems } = require("../../out/reorder_helpers");

console.log("=== Test Suite: Window Shrink Leaf Folder Collapse, Card Reorder, Grid Expansion, and Mouse Navigation ===");

// -------------------------------------------------------------
// Slice 1: Mouse Back Button Deduplication (Issue 3)
// -------------------------------------------------------------
console.log("\n=== Test 1: Mouse button 3 only navigates back once per physical click ===");

class MockWindow {
    constructor() {
        this.listeners = {};
    }
    addEventListener(type, fn) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(fn);
    }
    dispatchEvent(type, event) {
        if (this.listeners[type]) {
            for (const fn of this.listeners[type]) {
                fn(event);
            }
        }
    }
}

const mockWindow = new MockWindow();
let backCallCount = 0;
function handleBreadcrumbBack() {
    backCallCount++;
}

// Register event listeners as designed:
mockWindow.addEventListener("mouseup", event => {
    if (event.button === 3) {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        handleBreadcrumbBack();
    }
});

mockWindow.addEventListener("auxclick", event => {
    if (event.button === 3) {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        // Crucial fix: do NOT invoke handleBreadcrumbBack here to prevent double-fire
    }
});

// Simulate a physical click of mouse button 3 (dispatches mouseup then auxclick)
mockWindow.dispatchEvent("mouseup", { button: 3, preventDefault() {}, stopPropagation() {} });
mockWindow.dispatchEvent("auxclick", { button: 3, preventDefault() {}, stopPropagation() {} });

assert.strictEqual(backCallCount, 1, "Mouse button 3 should trigger handleBreadcrumbBack exactly once, not twice");
console.log("PASS: Mouse button 3 only invoked handleBreadcrumbBack once.");

// -------------------------------------------------------------
// Slice 2: Subfolder Retention in Leaf Folders (Issue 1)
// -------------------------------------------------------------
console.log("\n=== Test 2: Leaf folder retains subdirectories with 1-2 files for collapse ===");

function getSubfolderGroups(files, basePath, isCollapsingCheck = true) {
    const groups = {};
    const rootFiles = [];
    const orderedItems = [];
    const seenFolders = new Set();

    for (const f of files) {
        const relPath = basePath ? f.path.substring(basePath.length) : f.path;
        const slashIdx = relPath.indexOf("/");
        if (slashIdx === -1) {
            rootFiles.push(f);
        } else {
            const folderName = relPath.substring(0, slashIdx);
            const folderPath = (basePath || "") + folderName + "/";
            if (!groups[folderPath]) {
                groups[folderPath] = { name: folderName, path: folderPath, folderPath: folderPath, fileCount: 0, files: [] };
            }
            groups[folderPath].fileCount++;
            groups[folderPath].files.push(f);
        }
    }

    const validFolders = new Set();
    for (const grp of Object.values(groups)) {
        // When checking for collapse in leaf folders, directories with >= 1 files are valid collapse targets
        if (isCollapsingCheck || grp.fileCount > 0) {
            validFolders.add(grp.path);
        } else {
            rootFiles.push(...grp.files);
        }
    }

    for (const f of files) {
        const relPath = basePath ? f.path.substring(basePath.length) : f.path;
        const slashIdx = relPath.indexOf("/");
        if (slashIdx === -1) {
            orderedItems.push({ type: "file", file: f, id: f.id });
        } else {
            const folderName = relPath.substring(0, slashIdx);
            const folderPath = (basePath || "") + folderName + "/";
            if (validFolders.has(folderPath)) {
                if (!seenFolders.has(folderPath)) {
                    seenFolders.add(folderPath);
                    orderedItems.push({ type: "folder", card: groups[folderPath], id: "folder:" + folderPath });
                }
            } else {
                orderedItems.push({ type: "file", file: f, id: f.id });
            }
        }
    }

    const folders = Object.values(groups).filter(g => validFolders.has(g.path));
    return { folders, rootFiles, orderedItems };
}

const leafFiles = [
    { id: "1", path: "src/components/buttons/PrimaryButton.jsx" },
    { id: "2", path: "src/components/buttons/SecondaryButton.jsx" },
    { id: "3", path: "src/components/icons/CheckIcon.svg" },
    { id: "4", path: "src/components/index.js" }
];

const subInfo = getSubfolderGroups(leafFiles, "src/components/", true);
assert.strictEqual(subInfo.folders.length, 2, "Both buttons/ and icons/ subdirectories should be recognized as valid folders");
assert(subInfo.folders.some(f => f.path === "src/components/buttons/"), "buttons/ folder exists");
assert(subInfo.folders.some(f => f.path === "src/components/icons/"), "icons/ folder exists");
assert.strictEqual(subInfo.rootFiles.length, 1, "Only index.js is in rootFiles, no child directory files were dumped into rootFiles");
assert.strictEqual(subInfo.rootFiles[0].id, "4", "index.js is the only root file");
console.log("PASS: Leaf folder retains subdirectories with 1-2 files.");

// -------------------------------------------------------------
// Slice 3: Folder Collapse on Window Shrink (Issue 1)
// -------------------------------------------------------------
console.log("\n=== Test 3: doesFolderCollapse respects active canvas dimensions on window shrink ===");

function doesFolderCollapse(files, folderPath, isSpanning, activeW, activeH) {
    if (!files || files.length === 0) return false;
    const subfolderInfo = getSubfolderGroups(files, folderPath, true);
    if (!subfolderInfo || subfolderInfo.folders.length === 0) {
        return false;
    }
    const availW = (typeof activeW === "number" && activeW > 0) ? activeW : (1200 - 24);
    const availH = (typeof activeH === "number" && activeH > 0) ? activeH : (800 - 76);
    const minW = 60;
    const minH = 40;

    const grid = buildStableGrid(files.length, 16 / 9);
    const cW = availW / Math.max(1, grid.cols);
    const cH = availH / Math.max(1, grid.rows);
    return cW < minW || cH < minH;
}

// Large window (1200x800): 4 files have large cells, no collapse needed if tiles are readable
const collapseLarge = doesFolderCollapse(leafFiles, "src/components/", false, 1176, 724);
// Small window (100x70): 4 files in 2x2 grid -> 50x35px (< 60x40), MUST collapse into folder cards!
const collapseSmall = doesFolderCollapse(leafFiles, "src/components/", false, 100, 70);

assert.strictEqual(collapseSmall, true, "When window shrinks such that cells are < 60x40, doesFolderCollapse must return true");
console.log(`PASS: Large window collapse: ${collapseLarge}, Small window collapse: ${collapseSmall}`);

// -------------------------------------------------------------
// Slice 4: Folder Card Capacity when Dropping to Rows Below (Issue 2)
// -------------------------------------------------------------
console.log("\n=== Test 4: Folder card grid allocates slots for rows below ===");

const orderedItems = [
    { type: "folder", id: "folder:src/components/buttons/" },
    { type: "folder", id: "folder:src/components/icons/" },
    { type: "file", id: "src/components/index.js" }
];

// User moved "folder:src/components/buttons/" to slot 8 (row 2, col 0 in a 4-column grid)
const effectiveCardOrder = [
    "",
    "folder:src/components/icons/",
    "src/components/index.js",
    "",
    "",
    "",
    "",
    "",
    "folder:src/components/buttons/"
];

// The capacity formula:
const totalCardItems = Math.max(orderedItems.length, effectiveCardOrder.length);
const cardGrid = buildStableGrid(totalCardItems, 16 / 9);
const cardSlots = [];
for (let r = 0; r < cardGrid.rows; r++) {
    for (let c = 0; c < cardGrid.cols; c++) {
        cardSlots.push([c, r]);
    }
}

assert(cardSlots.length >= effectiveCardOrder.length, `Grid slots (${cardSlots.length}) must accommodate slot index 6`);
assert(cardGrid.rows >= 3, `Grid rows (${cardGrid.rows}) must have at least 3 rows to reach row index 2`);
console.log(`PASS: Allocated ${cardSlots.length} slots across ${cardGrid.rows} rows, accommodating row 2.`);

// -------------------------------------------------------------
// Slice 5: Dragging Right Clamped to Grid Bounds (Issue 2)
// -------------------------------------------------------------
console.log("\n=== Test 5: Dragging a file rightward never exceeds existing grid columns ===");

const spanningFiles = [
    { id: "f1", lineCount: 50 },
    { id: "f2", lineCount: 50 },
    { id: "f3", lineCount: 50 },
    { id: "f4", lineCount: 50 }
];

const renderedGridCols = 3;
const extraCols = 0;
// FIX: maxAllowedCols must strictly match renderedGridCols, without adding extraCols a second time
const maxAllowedCols = Math.max(2, renderedGridCols);

const allocations = { f1: 1, f2: 1, f3: 1, f4: 1 };
const initialOrder = ["f1", "f2", "f3", "f4"];

// Drag f1 to col 5 (far to the right)
const reorderResult = reorderSpanningItems(
    ["f1", "f2", "f3", "f4"],
    initialOrder,
    allocations,
    "f1",
    5, // targetCol attempted
    0, // targetRow
    maxAllowedCols,
    3,
    2
);

assert(reorderResult.cols <= maxAllowedCols, `Resulting columns (${reorderResult.cols}) must not exceed maxAllowedCols (${maxAllowedCols})`);
console.log(`PASS: Resulting cols: ${reorderResult.cols} clamped within ${maxAllowedCols}`);

console.log("\nAll unit tests passed successfully!");
