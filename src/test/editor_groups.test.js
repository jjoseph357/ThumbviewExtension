// Behavioral tests for split-editor handling (src/editor_groups.ts): what F4 does, where closing
// returns to, and restoring the editor Thumbview covered, against simulated editor groups. The
// main scenario reproduces a real trace: user in the left group, Thumbview's retained panel in the
// right group covering renderer.jsx; closing must leave every group showing code.
const assert = require("assert");
const { loadTs } = require("./helpers/load_ts");

const { decideF4, EditorGroupTracker } = loadTs("../editor_groups.ts");

const TV = { isThumbview: true, label: "Thumbview" };
const file = name => ({ uri: `file:///ws/${name}`, isThumbview: false, label: name });

/** A workbench whose open() switches the group's active tab (and focus unless preserveFocus). */
function fakeWorkbench(groups, { hang = false } = {}) {
    const opens = [];
    const logs = [];
    return {
        opens,
        logs,
        groups: () => groups,
        open: (uri, viewColumn, preserveFocus) => {
            opens.push({ uri, viewColumn, preserveFocus });
            if (hang) {
                return new Promise(() => {});
            }
            const group = viewColumn === "active" ? groups.find(g => g.isActive) : groups.find(g => g.viewColumn === viewColumn);
            let tab = group.tabs.find(t => t.uri === uri);
            if (!tab) {
                tab = { uri, isThumbview: false, label: uri.split("/").pop() };
                group.tabs.push(tab);
            }
            group.activeTab = tab;
            if (!preserveFocus) {
                for (const g of groups) g.isActive = g === group;
            }
            return Promise.resolve();
        },
        log: line => logs.push(line)
    };
}

(async () => {
    console.log("=== Test Suite: Split editors (editor_groups.ts) ===");

    console.log("\n--- Test 1: what F4 does ---");
    const base = { panelExists: true, panelActive: false, panelVisible: false, recentlyOpened: false, fullscreenActive: false, fullscreenOnOpen: true };
    assert.strictEqual(decideF4({ ...base, panelExists: false }), "create");
    assert.strictEqual(decideF4({ ...base, panelActive: true, panelVisible: true }), "close", "a focused Thumbview closes");
    assert.strictEqual(decideF4({ ...base, recentlyOpened: true }), "close", "a replay right after our own open closes (panel.active lags)");
    assert.strictEqual(decideF4({ ...base, panelVisible: true, fullscreenOnOpen: false }), "focus-in-place",
        "tab mode: visible beside the code is focused where it is, never moved over the code");
    assert.strictEqual(decideF4({ ...base, panelVisible: true, fullscreenActive: true }), "focus-in-place", "already fullscreen: just focus it");
    assert.strictEqual(decideF4({ ...base, panelVisible: true }), "reopen", "fullscreen mode, not fullscreen yet: reopen enters fullscreen");
    assert.strictEqual(decideF4(base), "reopen", "hidden: reopen");
    console.log("✓ Test 1 passed");

    console.log("\n--- Test 2: the reported trace: Thumbview opens in the other group, closing leaves code in both ---");
    const left = { viewColumn: 1, isActive: true, tabs: [file("StudySession.js"), file("StudyRepository.js")] };
    left.activeTab = left.tabs[1];
    const right = { viewColumn: 2, isActive: false, tabs: [file("App.jsx"), file("renderer.jsx"), TV, file("main.js")] };
    right.activeTab = right.tabs[1];
    const wb = fakeWorkbench([left, right]);
    const tracker = new EditorGroupTracker(wb);
    // F4 pressed while typing in the left group.
    tracker.recordReturnPoint({ uri: "file:///ws/StudyRepository.js", viewColumn: 1 }, 1);
    const snapshot = tracker.snapshot();
    // Thumbview is revealed in its own (right) group, covering renderer.jsx.
    right.activeTab = TV;
    for (const g of [left, right]) g.isActive = g === right;
    tracker.recordCovered(snapshot, 2);
    // F4 again: close.
    assert.strictEqual(await tracker.returnToEditor(), "opened");
    assert.strictEqual(left.activeTab.label, "StudyRepository.js");
    assert.strictEqual(left.isActive, true, "focus is back where the user was");
    assert.strictEqual(right.activeTab, TV, "the right group still shows Thumbview at this point");
    assert.strictEqual(await tracker.restoreCovered(), "opened");
    assert.strictEqual(right.activeTab.label, "renderer.jsx", "the covered editor is put back");
    assert.strictEqual(left.isActive, true, "restoring does not steal focus");
    assert(![left, right].some(g => g.activeTab.isThumbview), "no group is left showing Thumbview");
    assert(wb.opens.every(o => o.viewColumn !== undefined), "opens target a group explicitly");
    console.log("✓ Test 2 passed");

    console.log("\n--- Test 3: return point for an editor hidden behind Thumbview uses Thumbview's group ---");
    tracker.recordReturnPoint({ uri: "file:///ws/renderer.jsx", viewColumn: undefined }, 2);
    assert.deepStrictEqual(tracker.returnPoint, { uri: "file:///ws/renderer.jsx", viewColumn: 2 });
    tracker.recordReturnPoint(undefined, 2);
    assert.strictEqual(tracker.returnPoint, undefined, "no editor (e.g. Settings UI) records nothing");
    assert.strictEqual(await tracker.returnToEditor(), "failed", "so the close path uses its fallbacks");
    console.log("✓ Test 3 passed");

    console.log("\n--- Test 4: a return point whose group was closed opens in the focused group, not a new split ---");
    const solo = { viewColumn: 1, isActive: true, tabs: [file("a.ts")] };
    solo.activeTab = solo.tabs[0];
    const wb4 = fakeWorkbench([solo]);
    const t4 = new EditorGroupTracker(wb4);
    t4.recordReturnPoint({ uri: "file:///ws/b.ts", viewColumn: 2 }, 2);
    assert.strictEqual(await t4.returnToEditor(), "opened");
    assert.strictEqual(wb4.opens[0].viewColumn, "active");
    console.log("✓ Test 4 passed");

    console.log("\n--- Test 5: an open that never settles times out instead of holding the layout lock ---");
    const g5 = { viewColumn: 1, isActive: true, tabs: [file("a.ts")] };
    g5.activeTab = g5.tabs[0];
    const t5 = new EditorGroupTracker(fakeWorkbench([g5], { hang: true }), 30);
    t5.recordReturnPoint({ uri: "file:///ws/a.ts", viewColumn: 1 }, 1);
    const started = Date.now();
    assert.strictEqual(await t5.returnToEditor(), "timeout", "the caller learns the open may still land, so it starts no second one");
    assert(Date.now() - started < 1000);
    console.log("✓ Test 5 passed");

    console.log("\n--- Test 6: nothing to restore when Thumbview is alone in its group or not showing ---");
    const aloneGroup = { viewColumn: 1, isActive: false, tabs: [TV], activeTab: TV };
    const codeGroup = { viewColumn: 2, isActive: true, tabs: [file("x.ts")] };
    codeGroup.activeTab = codeGroup.tabs[0];
    const wb6 = fakeWorkbench([aloneGroup, codeGroup]);
    const t6 = new EditorGroupTracker(wb6);
    assert.strictEqual(await t6.restoreCovered(), "nothing");
    assert(wb6.logs.some(l => l.includes("alone in group 1")), "and says so in the trace");
    const hiddenGroup = { viewColumn: 1, isActive: true, tabs: [file("a.ts"), TV] };
    hiddenGroup.activeTab = hiddenGroup.tabs[0];
    const wb6b = fakeWorkbench([hiddenGroup]);
    assert.strictEqual(await new EditorGroupTracker(wb6b).restoreCovered(), "nothing", "Thumbview not showing: nothing to do");
    assert.strictEqual(wb6b.opens.length, 0);
    console.log("✓ Test 6 passed");

    console.log("\n--- Test 7: the covered editor wins over the group's first other editor ---");
    const g7 = { viewColumn: 1, isActive: false, tabs: [file("first.ts"), file("covered.ts"), TV] };
    g7.activeTab = g7.tabs[1];
    const other7 = { viewColumn: 2, isActive: true, tabs: [file("y.ts")] };
    other7.activeTab = other7.tabs[0];
    const t7 = new EditorGroupTracker(fakeWorkbench([g7, other7]));
    const snap7 = t7.snapshot();
    g7.activeTab = TV;
    t7.recordCovered(snap7, 1);
    await t7.restoreCovered();
    assert.strictEqual(g7.activeTab.label, "covered.ts");
    console.log("✓ Test 7 passed");

    console.log("\nAll split editor tests passed.");
    process.exit(0);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
