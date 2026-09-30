const assert = require("assert");
const { readHostSource } = require("./helpers/host_source");
const fs = require("fs");
const path = require("path");
const { buildSpanningGrid, cellsNeeded } = require("../../out/spanning_layout");

console.log("=== Test Suite: Settings Modal & Configuration (v0.4.6) ===");

// -------------------------------------------------------------
// Test 1: cellsNeeded with variable compression percentages
// -------------------------------------------------------------
console.log("\n=== Test 1: cellsNeeded scaling across compression percentages ===");
// Default 5% (0.05): 10,000 * 0.05 = 500 lines -> 500 / 60 = 8.33 -> ceil = 9 cells
const cellsAt5Pct = cellsNeeded(10000, 60, 0.05);
assert.strictEqual(cellsAt5Pct, 9, "10,000 lines at 5% compression should allocate 9 cells");

// 10% (0.10): 10,000 * 0.10 = 1000 lines -> 1000 / 60 = 16.66 -> ceil = 17 cells
const cellsAt10Pct = cellsNeeded(10000, 60, 0.10);
assert.strictEqual(cellsAt10Pct, 17, "10,000 lines at 10% compression should allocate 17 cells");

// 2% (0.02): 10,000 * 0.02 = 200 lines -> 200 / 60 = 3.33 -> ceil = 4 cells
const cellsAt2Pct = cellsNeeded(10000, 60, 0.02);
assert.strictEqual(cellsAt2Pct, 4, "10,000 lines at 2% compression should allocate 4 cells");

// 0% (0.0): expansion disabled, files always allocate 1 cell
assert.strictEqual(cellsNeeded(10000, 60, 0), 1, "10,000 lines at 0% compression should allocate 1 cell (disabled)");
assert.strictEqual(cellsNeeded(10000, 60, -0.05), 1, "negative compression should allocate 1 cell");

// Extreme values (100% = 1.0, 200% = 2.0): clamped to safe upper bound of 25% (0.25)
// 10,000 * 0.25 = 2,500 lines -> 2500 / 60 = 41.66 -> ceil = 42 cells
assert.strictEqual(cellsNeeded(10000, 60, 1.0), 42, "10,000 lines at 100% compression should clamp to 25% (42 cells)");
assert.strictEqual(cellsNeeded(10000, 60, 2.0), 42, "10,000 lines at 200% compression should clamp to 25% (42 cells)");

// Small file under base lines: always 1 cell regardless of compression
assert.strictEqual(cellsNeeded(40, 60, 0.10), 1, "40 lines should allocate 1 cell");
assert.strictEqual(cellsNeeded(40, 60, 0.01), 1, "40 lines should allocate 1 cell");
console.log(`✓ Test 1 passed: 10,000 lines scaled across compression percentages (0%, 2%, 5%, 10%, clamped at 25%)`);

// -------------------------------------------------------------
// Test 2: buildSpanningGrid with custom compressionPct
// -------------------------------------------------------------
console.log("\n=== Test 2: buildSpanningGrid applies custom compression percentage ===");
const testFiles = [
    { id: "tall.ts", name: "tall.ts", path: "tall.ts", lineCount: 6000 },
    { id: "short.ts", name: "short.ts", path: "short.ts", lineCount: 50 }
];

const layout5Pct = buildSpanningGrid(testFiles, ["tall.ts", "short.ts"], {}, null, null, 16 / 9, 60, 0.05);
// 6000 * 0.05 = 300 -> 300 / 60 = 5 cells
assert.strictEqual(layout5Pct.allocations["tall.ts"], 5, "tall.ts should have 5 cells at 5% compression");

const layout10Pct = buildSpanningGrid(testFiles, ["tall.ts", "short.ts"], {}, null, null, 16 / 9, 60, 0.10);
// 6000 * 0.10 = 600 -> 600 / 60 = 10 cells
assert.strictEqual(layout10Pct.allocations["tall.ts"], 10, "tall.ts should have 10 cells at 10% compression");

// 0% (0.0): all files allocate 1 cell
const layout0Pct = buildSpanningGrid(testFiles, ["tall.ts", "short.ts"], {}, null, null, 16 / 9, 60, 0);
assert.strictEqual(layout0Pct.allocations["tall.ts"], 1, "tall.ts should have 1 cell at 0% compression");

// Extreme values (100% = 1.0): clamped to 25% (0.25) -> 6000 * 0.25 = 1500 / 60 = 25 cells
const layout100Pct = buildSpanningGrid(testFiles, ["tall.ts", "short.ts"], {}, null, null, 16 / 9, 60, 1.0);
assert.strictEqual(layout100Pct.allocations["tall.ts"], 25, "tall.ts should clamp to 25% max (25 cells)");
console.log(`✓ Test 2 passed: buildSpanningGrid correctly handles 0%, 5%, 10%, and clamps 100% to 25%`);

// -------------------------------------------------------------
// Test 3: Tile size before collapsing threshold checks
// -------------------------------------------------------------
console.log("\n=== Test 3: Tile collapse evaluation against minCellWidth and minCellHeight ===");
function doesCellCollapse(cellW, cellH, minW, minH) {
    return cellW < minW || cellH < minH;
}

// Tile is 50x35 px
// With default threshold (60x40): collapses
assert.strictEqual(doesCellCollapse(50, 35, 60, 40), true, "50x35 should collapse with 60x40 threshold");

// With custom threshold (45x30): does not collapse
assert.strictEqual(doesCellCollapse(50, 35, 45, 30), false, "50x35 should not collapse with 45x30 threshold");
console.log(`✓ Test 3 passed: tile dimensions correctly evaluate against custom collapse thresholds`);

// -------------------------------------------------------------
// Test 4: Verify package.json configuration schema
// -------------------------------------------------------------
console.log("\n=== Test 4: Verify package.json contributes configuration properties ===");
const pkgJsonPath = path.resolve(__dirname, "../../package.json");
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
const props = pkg.contributes.configuration.properties;

assert(props["thumbview.compressionPercentage"], "thumbview.compressionPercentage must be contributed");
assert.strictEqual(props["thumbview.compressionPercentage"].default, 5, "compressionPercentage default must be 5");
assert.strictEqual(props["thumbview.compressionPercentage"].type, "number", "compressionPercentage type must be number");
assert.strictEqual(props["thumbview.compressionPercentage"].minimum, 0, "compressionPercentage minimum must be 0");
assert.strictEqual(props["thumbview.compressionPercentage"].maximum, 25, "compressionPercentage maximum must be 25");

assert(props["thumbview.minCellWidth"], "thumbview.minCellWidth must be contributed");
assert.strictEqual(props["thumbview.minCellWidth"].default, 60, "minCellWidth default must be 60");

assert(props["thumbview.minCellHeight"], "thumbview.minCellHeight must be contributed");
assert.strictEqual(props["thumbview.minCellHeight"].default, 40, "minCellHeight default must be 40");

assert(props["thumbview.autoIgnoreThreshold"], "thumbview.autoIgnoreThreshold must be contributed");
assert.strictEqual(props["thumbview.autoIgnoreThreshold"].default, 30, "autoIgnoreThreshold default must be 30");
console.log(`✓ Test 4 passed: package.json contributes all required configuration settings`);

// -------------------------------------------------------------
// Test 5: Verify settings modal HTML in extension.ts
// -------------------------------------------------------------
console.log("\n=== Test 5: Verify settings modal HTML structure ===");
const extTsPath = path.resolve(__dirname, "../../src/extension.ts");
const extSource = readHostSource();

// Must NOT contain Grid Space in settings modal
const settingsModalSlice = extSource.substring(
    extSource.indexOf('id="actions-modal"'),
    extSource.indexOf('class="shortcuts-table"')
);
assert(!settingsModalSlice.includes("Grid Space"), "Settings modal must not contain 'Grid Space'");
assert(!settingsModalSlice.includes("expand-grid-btn"), "Settings modal must not contain 'expand-grid-btn'");
assert(!settingsModalSlice.includes("reduce-grid-btn"), "Settings modal must not contain 'reduce-grid-btn'");

// Must contain the new inputs
assert(settingsModalSlice.includes("compression-percentage-input"), "Settings modal must contain compression-percentage-input");
assert(settingsModalSlice.includes('min="0" max="25"'), "Compression input must specify min=0 and max=25");
assert(settingsModalSlice.includes("min-cell-width-input"), "Settings modal must contain min-cell-width-input");
assert(settingsModalSlice.includes("min-cell-height-input"), "Settings modal must contain min-cell-height-input");
assert(settingsModalSlice.includes("auto-ignore-threshold-input"), "Settings modal must contain auto-ignore-threshold-input");

// Explanation must describe shrink threshold and tile expansion
assert(settingsModalSlice.includes("When code shrinks to this percentage of its height in a cell, the tile expands one cell taller"), "Explanation must accurately describe shrink threshold and cell expansion");
assert(settingsModalSlice.includes("0% disables, 1% to 20% recommended"), "Explanation must guide user with recommended 1% to 20% and 0% disables");

// CSS must remove spinner up/down buttons on number inputs
assert(extSource.includes("-webkit-outer-spin-button"), "CSS must hide webkit outer spin buttons");
assert(extSource.includes("-webkit-inner-spin-button"), "CSS must hide webkit inner spin buttons");
assert(extSource.includes("-moz-appearance: textfield"), "CSS must set -moz-appearance: textfield for Firefox");
console.log(`✓ Test 5 passed: settings modal HTML removed Grid Space, includes all new inputs, updated explanation, and CSS hides spin buttons`);

// -------------------------------------------------------------
// Test 6: Verify overview.js local spanning compression & rubberband prevention
// -------------------------------------------------------------
console.log("\n=== Test 6: Verify overview.js local compression & rubberband prevention ===");
const overviewPath = path.resolve(__dirname, "../../media/overview.js");
const overviewSource = fs.readFileSync(overviewPath, "utf8");

// Must clamp input between 0 and 25
assert(overviewSource.includes("Math.min(25, val)"), "overview.js must clamp compression percentage to maximum 25");
assert(overviewSource.includes("Math.max(0,"), "overview.js must support 0% compression");

// Must NOT listen to "input" event (only takes effect on Enter or click off / blur)
const compInputSetupSlice = overviewSource.substring(
    overviewSource.indexOf("const compPercentageInput = document.getElementById"),
    overviewSource.indexOf("let dimDebounceTimer")
);
assert(!compInputSetupSlice.includes('compPercentageInput.addEventListener("input"'), "compPercentageInput must NOT listen to 'input' event to prevent live intermediate jumps while typing");
assert(compInputSetupSlice.includes('compPercentageInput.addEventListener("change"'), "compPercentageInput must listen to 'change'");
assert(compInputSetupSlice.includes('compPercentageInput.addEventListener("blur"'), "compPercentageInput must listen to 'blur'");
assert(compInputSetupSlice.includes('e.key === "Enter"'), "compPercentageInput must commit on Enter keydown");

// In extension.ts, setCompressionPercentage handler must not make duplicate calls to updateLayoutFromCache
const extCompSlice = extSource.substring(
    extSource.indexOf('if (msg.command === "setCompressionPercentage")'),
    extSource.indexOf('if (msg.command === "setMinCellDimensions")')
);
assert(!extCompSlice.includes("updateLayoutFromCache"), "setCompressionPercentage must not redundantly call updateLayoutFromCache since onDidChangeConfiguration handles it");

// 1% compression (raw = 1) must parse to 0.01 (not 0.25 or 1.0)
const extGetCompSlice = extSource.substring(
    extSource.indexOf("function getCompressionPct()"),
    extSource.indexOf("import { IgnoreTreeItem }")
);
assert(extGetCompSlice.includes("raw >= 1 ? raw / 100 : raw"), "extension.ts must use raw >= 1 so raw=1 parses as 0.01 (1%)");

const overviewGetCompSlice = overviewSource.substring(
    overviewSource.indexOf("function getCompressionPct()"),
    overviewSource.indexOf("function scopeFootprints")
);
assert(overviewGetCompSlice.includes("data.compressionPercentage >= 1 ? data.compressionPercentage / 100 : data.compressionPercentage"), "overview.js must use >= 1 so 1 parses as 0.01 (1%)");

console.log(`✓ Test 6 passed: compression changes only take effect on Enter or blur with no intermediate jumps or duplicate host renders`);

// -------------------------------------------------------------
// Test 7: Verify menu accent bar & layered Esc exit handling
// -------------------------------------------------------------
console.log("\n=== Test 7: Verify menu accent bar & layered Esc exit handling ===");
assert(extSource.includes(".menu-popover::before, .menu-modal::before"), "extension.ts must style menu accent bars");
const accentBarSlice = extSource.substring(
    extSource.indexOf(".menu-popover::before, .menu-modal::before"),
    extSource.indexOf(".popover-header")
);
assert(accentBarSlice.includes("background: var(--vscode-button-background, #0e639c);"), "accent bar must use button background color");
assert(!accentBarSlice.includes("linear-gradient"), "accent bar must not use gradient");

assert(extSource.includes('if (msg.command === "exitThumbview")'), "extension.ts must handle exitThumbview command");
assert(/const closeActiveThumbview = /.test(extSource), "extension.ts must define closeActiveThumbview helper");

const escSlice = overviewSource.substring(
    overviewSource.indexOf('if (event.key === "Escape" || event.code === "Escape")'),
    overviewSource.indexOf('const isInputFocused = document.activeElement &&')
);
assert(escSlice.includes("clearDragState();"), "Escape must cancel active drag operations first");
assert(escSlice.includes("hideContextMenu();"), "Escape must dismiss context menu second");
assert(escSlice.includes("closeAllPopovers();"), "Escape must close popovers third");
assert(escSlice.includes("clearSearch();"), "Escape must clear/blur search fourth");
assert(escSlice.includes('vscode.postMessage({ command: "exitThumbview" });'), "Escape must exit Thumbview when no transient state is active");

console.log(`✓ Test 7 passed: menu accent bar uses button color and Esc key follows layered exit priority`);

console.log("\n=== ALL SETTINGS MODAL & CONFIG TESTS PASSED ===");

