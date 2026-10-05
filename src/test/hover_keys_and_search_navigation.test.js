// Behavioral tests for pointer and keyboard targeting in the webview: the hover outline (a positioned
// element, so hovering never repaints the canvas), copy/cut/delete/rename acting only on a target the
// user can see, ⌘⌫ never deleting, Enter/ArrowDown from the search box into the matches, the
// auto-hidden folders chip, the per-frame raster budget, and the tokenizer families.
const assert = require("assert");
const { loadOverview } = require("./helpers/overview_harness");

global.MouseEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const h = loadOverview(["tokenizeLine", "detectLang", "render", "completeReveal"]);
const { onMessage, flushFrames, postedMessages, fireWindow, fireElement, mockElement } = h;
const { getData, tokenizeLine, detectLang } = h.exports;

h.resizeTo(1600, 900);
flushFrames();
// 3 x 2 uniform grid: f0 f1 f2 / f3 f4 f5; f1 and f4 contain "needle".
const files = Array.from({ length: 6 }, (_, i) => ({
    id: `f${i}.ts`, path: `src/f${i}.ts`, uri: `file:///ws/src/f${i}.ts`, lineCount: 3, contentVersion: 1,
    lines: [{ text: i % 3 === 1 ? `const needle${i} = ${i};` : `const v${i} = ${i};` }], slot: [i % 3, Math.floor(i / 3)]
}));
const payload = extra => ({ command: "data", mode: "uniform_grid", files, layout: { cols: 3, rows: 2 }, ...extra });
onMessage({ data: payload() });
flushFrames();

const key = (k, extra = {}) => fireWindow("keydown", { key: k, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra });
const outline = mockElement("hover-outline");
const centerOf = f => ({ clientX: f._cell.x + f._cell.w / 2, clientY: f._cell.y + f._cell.h / 2, buttons: 0 });
const hover = f => fireElement("map", "mousemove", centerOf(f));

console.log("--- Test 1: hovering a tile outlines it without repainting the canvas ---");
const f2 = getData().files.find(f => f.id === "f2.ts");
const clears = h.counts.clearRect;
hover(f2);
assert.strictEqual(outline.style.display, "block", "the hovered tile is outlined");
assert.strictEqual(outline.style.left, `${f2._cell.x}px`);
assert.strictEqual(outline.style.width, `${f2._cell.w}px`);
assert.strictEqual(h.canvas.style.cursor, "pointer");
assert.strictEqual(h.counts.clearRect, clears, "moving the outline does not redraw the grid");
fireElement("map", "mouseleave");
assert.strictEqual(outline.style.display, "none", "leaving the grid removes the outline");
assert.strictEqual(h.canvas.style.cursor, "");
console.log("✓ Test 1 passed");

console.log("--- Test 2: copy, cut, delete, rename, and open-to-side act only on the outlined tile ---");
postedMessages.length = 0;
key("Delete");
key("c", { ctrlKey: true });
key("F2");
assert(!postedMessages.some(m => ["deleteFile", "copyFile", "renameFile"].includes(m.command)), "nothing is targeted, so nothing happens");
hover(f2);
key("Delete");
key("x", { ctrlKey: true });
key("F2");
key("Enter", { ctrlKey: true });
const commands = postedMessages.map(m => `${m.command}:${m.uri}`);
for (const c of ["deleteFile", "cutFile", "renameFile", "openToSide"]) {
    assert(commands.includes(`${c}:file:///ws/src/f2.ts`), `${c} acts on the outlined tile (${commands.join(", ")})`);
}
assert(!postedMessages.some(m => m.command === "jump"), "Ctrl+Enter opens to the side without also opening in place");
postedMessages.length = 0;
key("Backspace", { metaKey: true });
assert(!postedMessages.some(m => m.command === "deleteFile"), "⌘⌫ clears the search; it never deletes the hovered file");
fireElement("map", "mouseleave");
console.log("✓ Test 2 passed");

console.log("--- Test 3: Enter and ArrowDown in the search box reach the matches ---");
const searchBox = mockElement("search-input");
searchBox.value = "needle";
fireElement("search-input", "input", { target: searchBox });
flushFrames();
postedMessages.length = 0;
fireElement("search-input", "keydown", { key: "Enter", preventDefault() {} });
const opened = postedMessages.find(m => m.command === "jump");
assert(opened && opened.uri === "file:///ws/src/f1.ts", `Enter opens the first match in reading order (${opened && opened.uri})`);
postedMessages.length = 0;
fireElement("search-input", "keydown", { key: "ArrowDown", preventDefault() {} });
assert(!postedMessages.some(m => m.command === "jump"), "ArrowDown only moves focus");
assert(mockElement("sr-status").textContent.startsWith("src/f1.ts"), "the first match is focused and announced");
key("ArrowDown");
assert(mockElement("sr-status").textContent.startsWith("src/f4.ts"), "arrows move between matches only (f4 is below f1)");
key("ArrowRight");
assert(mockElement("sr-status").textContent.startsWith("src/f4.ts"), "no match to the right: focus stays");
assert(mockElement("sr-status").textContent.includes("column 2 of 3, 2 of 2 in the column"), `the focused tile's place is announced (${mockElement("sr-status").textContent})`);
key("Escape");
let selected = false;
searchBox.select = () => { selected = true; };
key("f", { ctrlKey: true });
assert(selected, "Ctrl+F goes to the search box");
console.log("✓ Test 3 passed");

console.log("--- Test 4: the auto-hidden folders chip ---");
mockElement("fullscreen-notice").hidden = true; // as in the page markup
const chip = mockElement("auto-hidden-chip");
const chipLabel = mockElement("auto-hidden-open");
onMessage({ data: payload({ autoHiddenFolders: ["tests/", "docs/"], autoHiddenDismissed: "" }) });
assert.strictEqual(chip.hidden, false, "shown while folders are auto-hidden");
assert.strictEqual(chipLabel.textContent, "2 folders auto-hidden");
onMessage({ data: payload({ autoHiddenFolders: ["tests/", "docs/"], autoHiddenDismissed: "docs/\ntests/" }) });
assert.strictEqual(chip.hidden, true, "dismissed for this set of folders");
onMessage({ data: payload({ autoHiddenFolders: ["tests/", "docs/", "data/"], autoHiddenDismissed: "docs/\ntests/" }) });
assert.strictEqual(chip.hidden, false, "a new auto-hidden folder brings it back");
onMessage({ data: payload({ autoHiddenFolders: [] }) });
assert.strictEqual(chip.hidden, true);
onMessage({ data: payload({ autoHiddenFolders: ["tests/"] }) });
mockElement("fullscreen-notice").hidden = false;
onMessage({ data: payload({ autoHiddenFolders: ["tests/"] }) });
assert.strictEqual(chip.hidden, true, "never stacked with the fullscreen banner");
console.log("✓ Test 4 passed");

console.log("--- Test 5: after the reveal, one frame rasterizes tiles only within its budget ---");
h.exports.completeReveal();
let now = 0;
const realNow = performance.now;
Object.defineProperty(global, "performance", { value: { now: () => (now += 5) }, configurable: true, writable: true });
const many = Array.from({ length: 30 }, (_, i) => ({
    id: `m${i}.ts`, path: `m/m${i}.ts`, uri: `file:///ws/m/m${i}.ts`, lineCount: 20, contentVersion: 1,
    lines: Array.from({ length: 20 }, (_, l) => ({ text: `let m${i}_${l} = ${l};` })), slot: [i % 6, Math.floor(i / 6)]
}));
const canvasesBefore = h.counts.offscreenCanvas;
onMessage({ data: { command: "data", mode: "uniform_grid", files: many, layout: { cols: 6, rows: 5 } } });
flushFrames(1); // the frame the data message scheduled, with every clock read costing 5 ms
const rasterized = h.counts.offscreenCanvas - canvasesBefore;
assert(rasterized > 0 && rasterized < 30, `a frame rasterizes some tiles, not all 30 (${rasterized})`);
assert(h.rafQueue.length > 0, "the rest are scheduled for following frames");
Object.defineProperty(global, "performance", { value: { now: realNow }, configurable: true, writable: true });
flushFrames(60);
assert.strictEqual(h.counts.offscreenCanvas - canvasesBefore, 30, "every tile is rasterized within a few frames");
console.log("✓ Test 5 passed");

console.log("--- Test 5b: after a resize, a tile past the budget shows its last raster scaled, not bars ---");
let drawn = 0;
const realDrawImage = h.mockCtx.drawImage;
h.mockCtx.drawImage = (img) => { if (img && img.width > 0) drawn++; };
h.resizeTo(1500, 850);
Object.defineProperty(global, "performance", { value: { now: () => (now += 5) }, configurable: true, writable: true });
h.exports.render();
Object.defineProperty(global, "performance", { value: { now: realNow }, configurable: true, writable: true });
h.mockCtx.drawImage = realDrawImage;
assert(drawn >= 30, `every tile is drawn from an image, new or previous (${drawn})`);
flushFrames(60);
console.log("✓ Test 5b passed");

console.log("--- Test 6: tokenizer families ---");
const cats = (path, line) => tokenizeLine(line, detectLang(path)).filter(t => t.text.trim()).map(t => `${t.text}:${t.category}`);
assert.deepStrictEqual(cats("ci.yaml", "name: it's fine # note"), ["name:property", "::operator", "it:variable", "':normal", "s:variable", "fine:variable", "# note:comment"], "YAML: # comments, an apostrophe is not a string");
assert(cats("run.sh", 'echo "$HOME" # done').includes("# done:comment"));
assert(cats("main.go", 'fmt.Println("hi") // note').includes("// note:comment"));
assert.deepStrictEqual(cats("io.c", "#include <stdio.h>"), ["#include <stdio.h>:keyword"], "C preprocessor lines");
assert(cats("lib.rs", "fn f<'a>(x: &'a str)").every(t => !t.endsWith(":string")), "Rust lifetimes are not strings");
assert(cats("q.sql", "SELECT id FROM t -- all").includes("-- all:comment"));
assert(cats("q.sql", "select id").includes("select:keyword"), "SQL keywords in any case");
assert(cats("i.php", "<?php $x = 1; # c").includes("$x:variable"));
assert.strictEqual(detectLang("Dockerfile"), "hash");
assert.strictEqual(detectLang(".bashrc"), "hash");
assert.strictEqual(detectLang(".npmrc"), "plaintext", "ini dotfiles are not JSON");
assert.strictEqual(detectLang(".eslintrc"), "json");
assert.strictEqual(detectLang("app.tsx"), "js");
assert.strictEqual(detectLang("json_utils.py"), "python", "a name containing json is not JSON");
assert.strictEqual(detectLang("jsonParser.ts"), "js");
assert.strictEqual(detectLang("package.json.bak"), "json");
for (const [file, lang] of [["a.ml", "ml"], ["a.fsx", "ml"], ["core.clj", "lisp"], ["a.erl", "percent"], ["paper.tex", "percent"], ["m.vb", "vb"], ["Main.hs", "dash"], ["a.jl", "hash"]]) {
    assert.strictEqual(detectLang(file), lang, file);
}
assert(cats("a.ml", "let x = (* note *) 1").includes("(* note *):comment"));
assert(cats("core.clj", "(defn f [x] ; note").includes("; note:comment"));
console.log("✓ Test 6 passed");

console.log("--- Test 7: in folder-card view, search Enter and ArrowDown reach the card holding a match ---");
const cardFiles = [];
for (let i = 0; i < 1200; i++) {
    const folder = `pkg${i % 3}`;
    cardFiles.push({
        id: `${folder}/c${i}.ts`, path: `${folder}/c${i}.ts`, uri: `file:///ws/${folder}/c${i}.ts`, lineCount: 2, contentVersion: 1,
        lines: [{ text: i === 1100 ? "const uniqueTarget = 1;" : `const c${i} = ${i};` }], slot: [i % 40, Math.floor(i / 40)]
    });
}
onMessage({ data: { command: "data", mode: "uniform_grid", files: cardFiles, layout: { cols: 40, rows: 30 } } });
flushFrames();
assert(getData()._folderCards && getData()._folderCards.length > 0, "the root shows folder cards");
searchBox.value = "uniquetarget";
fireElement("search-input", "input", { target: searchBox });
flushFrames();
fireElement("search-input", "keydown", { key: "ArrowDown", preventDefault() {} });
const said = mockElement("sr-status").textContent;
assert(said.startsWith("Folder pkg2/"), `the card holding the match is focused (${said})`);
console.log("✓ Test 7 passed");

console.log("--- Test 8: CTRL hover snaps onto search match targets and mouse wheel scrolls surroundings ---");
const testFile = {
    id: "targetFile.ts", path: "src/targetFile.ts", uri: "file:///ws/src/targetFile.ts", lineCount: 20, contentVersion: 1,
    lines: Array.from({ length: 20 }, (_, i) => ({ text: (i === 5 || i === 15) ? "const specialMatch = 42;" : `const otherVar${i} = ${i};` })),
    slot: [0, 0]
};
onMessage({ data: { command: "data", mode: "uniform_grid", files: [testFile], layout: { cols: 1, rows: 1 } } });
flushFrames();

searchBox.value = "specialMatch";
fireElement("search-input", "input", { target: searchBox });
flushFrames();

const f = getData().files.find(file => file.id === "targetFile.ts");
const tooltip = mockElement("hover-tooltip");
const stepY = Math.min((f._cell.h - 34) / 20, 16);
const target1Y = f._cell.y + 24 + 5 * stepY + stepY / 2;
const target2Y = f._cell.y + 24 + 15 * stepY + stepY / 2;

// 1. Move mouse near target 1 (line 5) with ctrlKey: true
fireElement("map", "mousemove", { clientX: f._cell.x + f._cell.w / 2, clientY: target1Y, buttons: 0, ctrlKey: true });
assert.strictEqual(tooltip.style.display, "block", "tooltip is displayed on CTRL hover");
assert(tooltip.innerHTML.includes("(Line 6)"), `tooltip snapped to target 1 (line 6): ${tooltip.innerHTML}`);
assert(tooltip.innerHTML.includes("MATCH 1 of 2"), `tooltip shows MATCH 1 of 2 badge: ${tooltip.innerHTML}`);

// 2. Small cursor movement (2px) towards target 2 stays stuck to target 1 (hysteresis)
fireElement("map", "mousemove", { clientX: f._cell.x + f._cell.w / 2, clientY: target1Y + 2, buttons: 0, ctrlKey: true });
assert(tooltip.innerHTML.includes("(Line 6)"), `stays stuck to target 1 on small movement: ${tooltip.innerHTML}`);

// 3. Mouse wheel scrolling while holding CTRL steps directly between search results (Match 1 -> Match 2)
fireWindow("wheel", { deltaY: 100, preventDefault() {}, stopPropagation() {} });
assert(tooltip.innerHTML.includes("MATCH 2 of 2"), `wheel stepped to target 2: ${tooltip.innerHTML}`);
assert(tooltip.innerHTML.includes("(Line 16)"), `tooltip filename shows target 2 line 16: ${tooltip.innerHTML}`);

// 4. Wheeling past the last match scrolls into surrounding lines (+2 lines)
fireWindow("wheel", { deltaY: 100, preventDefault() {}, stopPropagation() {} });
assert(tooltip.innerHTML.includes("MATCH 2 of 2: L16 (+2)"), `scrolling past end scrolls surroundings: ${tooltip.innerHTML}`);
assert(tooltip.innerHTML.includes("(Line 18)"), `tooltip filename shows scrolled line 18: ${tooltip.innerHTML}`);

// 5. Click while scrolled jumps to the scrolled line (17, 0-indexed)
postedMessages.length = 0;
fireElement("map", "mousedown", { clientX: f._cell.x + f._cell.w / 2, clientY: target1Y, button: 0, ctrlKey: true });
fireElement("map", "mouseup", { clientX: f._cell.x + f._cell.w / 2, clientY: target1Y, button: 0, ctrlKey: true });
const scrolledJumpMsg = postedMessages.find(m => m.command === "jump");
assert(scrolledJumpMsg, "jump message posted on click after scroll");
assert.strictEqual(scrolledJumpMsg.line, 17, `clicked while scrolled jumps to line 17, got ${scrolledJumpMsg.line}`);

// 6. Wheel back up returns from surroundings to target 2
fireWindow("wheel", { deltaY: -100, preventDefault() {}, stopPropagation() {} });
assert(tooltip.innerHTML.includes("MATCH 2 of 2"), `scrolled back to target 2: ${tooltip.innerHTML}`);
assert(tooltip.innerHTML.includes("(Line 16)"), `tooltip filename shows line 16 again: ${tooltip.innerHTML}`);

// 7. Mouse wheel up steps back to Match 1
fireWindow("wheel", { deltaY: -100, preventDefault() {}, stopPropagation() {} });
assert(tooltip.innerHTML.includes("MATCH 1 of 2"), `wheel stepped back to target 1: ${tooltip.innerHTML}`);
assert(tooltip.innerHTML.includes("(Line 6)"), `tooltip filename shows line 6 again: ${tooltip.innerHTML}`);

// 8. Shift+wheel scrolls surrounding lines directly (+5 lines)
fireWindow("wheel", { deltaY: 100, shiftKey: true, preventDefault() {}, stopPropagation() {} });
assert(tooltip.innerHTML.includes("MATCH 1 of 2: L6 (+5)"), `shift+wheel scrolls surroundings directly: ${tooltip.innerHTML}`);
assert(tooltip.innerHTML.includes("(Line 11)"), `tooltip filename shows scrolled line 11: ${tooltip.innerHTML}`);

// 9. Shift+wheel back up returns offset to 0
fireWindow("wheel", { deltaY: -100, shiftKey: true, preventDefault() {}, stopPropagation() {} });
assert(tooltip.innerHTML.includes("MATCH 1 of 2"), `shift-wheeled back to target 1: ${tooltip.innerHTML}`);
assert(tooltip.innerHTML.includes("(Line 6)"), `tooltip filename shows line 6 again: ${tooltip.innerHTML}`);

// 10. Move cursor clearly close to target 2 -> snaps smoothly to target 2 (line 15, display Line 16)
fireElement("map", "mousemove", { clientX: f._cell.x + f._cell.w / 2, clientY: target2Y, buttons: 0, ctrlKey: true });
assert(tooltip.innerHTML.includes("(Line 16)"), `snapped to target 2 (line 16): ${tooltip.innerHTML}`);

// 11. Click on target 2 jumps to line 15 (0-based)
postedMessages.length = 0;
fireElement("map", "mousedown", { clientX: f._cell.x + f._cell.w / 2, clientY: target2Y, button: 0, ctrlKey: true });
fireElement("map", "mouseup", { clientX: f._cell.x + f._cell.w / 2, clientY: target2Y, button: 0, ctrlKey: true });
const jump2Msg = postedMessages.find(m => m.command === "jump");
assert(jump2Msg, "jump message posted on click target 2");
assert.strictEqual(jump2Msg.line, 15, `clicked while snapped to target 2 jumps to line 15, got ${jump2Msg.line}`);

// 12. Release Ctrl key
fireWindow("keyup", { ctrlKey: false, metaKey: false, key: "Control" });
assert.strictEqual(tooltip.style.display, "none", "releasing Ctrl hides the tooltip");

console.log("✓ Test 8 passed");

console.log("--- Test 9: A file with >100 matches allows hovering all matches to the end (reaches last match) ---");
key("Escape");
const largeMatchFile = {
    id: "largeMatchFile.ts", path: "src/largeMatchFile.ts", uri: "file:///ws/src/largeMatchFile.ts", lineCount: 150, contentVersion: 1,
    lines: Array.from({ length: 150 }, (_, i) => ({ text: `const needleLarge = ${i};` })),
    slot: [0, 0]
};
onMessage({ data: { command: "data", mode: "uniform_grid", files: [largeMatchFile], layout: { cols: 1, rows: 1 } } });
flushFrames();

searchBox.value = "needleLarge";
fireElement("search-input", "input", { target: searchBox });
flushFrames();

const lf = getData().files.find(file => file.id === "largeMatchFile.ts");
const lTop = lf._cell.y + 24;
const lBottom = lf._cell.y + lf._cell.h - 12;

// Hover near the top of the file -> MATCH 1 of 150
fireElement("map", "mousemove", { clientX: lf._cell.x + lf._cell.w / 2, clientY: lTop + 2, buttons: 0, ctrlKey: true });
assert(tooltip.innerHTML.includes("MATCH 1 of 150"), `hovering at top shows first match: ${tooltip.innerHTML}`);

// Hover near the middle of the file -> around MATCH 75 of 150
const lMid = (lTop + lBottom) / 2;
fireElement("map", "mousemove", { clientX: lf._cell.x + lf._cell.w / 2, clientY: lMid, buttons: 0, ctrlKey: true });
const midMatch = tooltip.innerHTML.match(/MATCH (\d+) of 150/);
assert(midMatch, "shows match badge in middle of file");
const midIdx = parseInt(midMatch[1], 10);
assert(midIdx >= 60 && midIdx <= 90, `middle hover snaps near middle match (got ${midIdx})`);

// Hover near the end of the file -> MUST show MATCH 150 of 150 (not stuck at match 16!)
fireElement("map", "mousemove", { clientX: lf._cell.x + lf._cell.w / 2, clientY: lBottom, buttons: 0, ctrlKey: true });
assert(tooltip.innerHTML.includes("MATCH 150 of 150"), `hovering at end of file shows last match: ${tooltip.innerHTML}`);

fireWindow("keyup", { ctrlKey: false, metaKey: false, key: "Control" });
console.log("✓ Test 9 passed");

console.log("\nAll hover, key, and search navigation tests passed.");
process.exit(0);
