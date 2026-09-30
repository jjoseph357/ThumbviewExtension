// Behavioral tests for src/panel_session.ts: when editor-state updates to the webview are held,
// and when the split-editor return point is recorded or dropped, across the ways a user leaves and
// comes back to Thumbview (F4, clicking a tile, clicking its tab, Ctrl+Tab).
const assert = require("assert");
const { loadTs } = require("./helpers/load_ts");

const { PanelSession } = loadTs("../panel_session.ts");

const shownByUser = { visible: true, active: true, layoutOpInFlight: false };
const shownDuringOurOp = { visible: true, active: true, layoutOpInFlight: true };
const hiddenByUser = { visible: false, active: false, layoutOpInFlight: false };
const hiddenByOurOp = { visible: false, active: false, layoutOpInFlight: true };

console.log("=== Test Suite: Panel session (panel_session.ts) ===");

console.log("\n--- Test 1: clicking a tile holds editor updates; returning by tab click releases them ---");
{
    const session = new PanelSession();
    session.switchStarted();
    assert.strictEqual(session.openStateHeld, true, "no full-grid updates while the file opens over Thumbview");
    session.viewStateChanged(hiddenByOurOp, false);
    assert.strictEqual(session.openStateHeld, true, "still held while hidden");
    const actions = session.viewStateChanged(shownByUser, false);
    assert.strictEqual(actions.releaseHold, true, "held updates are sent again");
    assert.strictEqual(session.openStateHeld, false, "and editor tracking resumes (was stuck until the next F4)");
    console.log("✓ Test 1 passed");
}

console.log("\n--- Test 2: a return within the grace window after a jump still releases and records ---");
{
    const session = new PanelSession();
    session.switchStarted();
    const actions = session.viewStateChanged(shownDuringOurOp, false);
    assert.strictEqual(actions.releaseHold, true, "released even while the jump's layout op is still winding down");
    assert.strictEqual(actions.recordReturnPoint, true, "and the editor just left is recorded as the return point");
    console.log("✓ Test 2 passed");
}

console.log("\n--- Test 3: F4's own return point is not overwritten when its reveal shows the panel ---");
{
    const session = new PanelSession();
    const actions = session.viewStateChanged(shownDuringOurOp, true);
    assert.strictEqual(actions.recordReturnPoint, false, "F4 recorded it before revealing; the reveal must not replace it");
    console.log("✓ Test 3 passed");
}

console.log("\n--- Test 4: leaving on the user's own drops a return point that would be stale ---");
{
    const session = new PanelSession();
    assert.strictEqual(session.viewStateChanged(hiddenByUser, true).clearReturnPoint, true,
        "clicking another tab: the next return must come from where the user is then");
    assert.strictEqual(session.viewStateChanged(hiddenByOurOp, true).clearReturnPoint, false,
        "Thumbview's own close uses the point itself, then clears it");
    assert.strictEqual(session.viewStateChanged(hiddenByUser, false).clearReturnPoint, false, "nothing to clear");
    console.log("✓ Test 4 passed");
}

console.log("\n--- Test 5: a failed open or a new panel never leaves updates held ---");
{
    const session = new PanelSession();
    session.switchStarted();
    session.switchFailed();
    assert.strictEqual(session.openStateHeld, false, "Thumbview stayed in front");
    session.switchStarted();
    session.shown();
    assert.strictEqual(session.openStateHeld, false, "panel recreated or reopened");
    const unfocused = session.viewStateChanged({ visible: true, active: false, layoutOpInFlight: false }, false);
    assert.strictEqual(unfocused.recordReturnPoint, false, "visible beside the code but not focused: the user did not come back to it");
    console.log("✓ Test 5 passed");
}

console.log("\nAll panel session tests passed.");
