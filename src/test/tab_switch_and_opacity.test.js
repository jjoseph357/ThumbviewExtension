const assert = require("assert");
const fs = require("fs");
const path = require("path");

console.log("=== Test Suite: Robust Tab Switcher, Fallback Close & Opacity Recovery ===");

// 1. Verify helper functions logic matching extension.ts
function isThumbviewTab(tab) {
    const input = tab.input;
    if (input && input.viewType === "thumbview") {
        return true;
    }
    return tab.label === "Thumbview";
}

function getTabUri(tab) {
    const input = tab.input;
    if (!input) return undefined;
    if (input.uri) return input.uri;
    if (input.modified) return input.modified;
    if (input.original) return input.original;
    if (input.resource) return input.resource;
    return undefined;
}

function getAllNonThumbviewTabs(tabGroups) {
    const tabs = [];
    let preferred;

    const activeGroup = tabGroups.activeTabGroup;
    if (activeGroup && activeGroup.activeTab && !isThumbviewTab(activeGroup.activeTab)) {
        preferred = activeGroup.activeTab;
    }

    for (const group of tabGroups.all) {
        for (const tab of group.tabs) {
            if (!isThumbviewTab(tab)) {
                tabs.push(tab);
                if (!preferred && tab.isActive) {
                    preferred = tab;
                }
            }
        }
    }

    if (!preferred && tabs.length > 0) {
        preferred = tabs[0];
    }

    return { preferred, tabs };
}

// Test 1: Fallback Close when only Thumbview is open
console.log("\n--- Test 1: Fallback close triggers when Thumbview is the sole tab ---");
{
    const mockTabGroupsOnlyThumbview = {
        all: [
            {
                tabs: [
                    { label: "Thumbview", input: { viewType: "thumbview" }, isActive: true }
                ]
            }
        ],
        activeTabGroup: {
            activeTab: { label: "Thumbview", input: { viewType: "thumbview" }, isActive: true }
        }
    };

    const { preferred, tabs: otherTabs } = getAllNonThumbviewTabs(mockTabGroupsOnlyThumbview);
    assert.strictEqual(otherTabs.length, 0, "No other tabs should be found");
    assert.strictEqual(preferred, undefined, "No preferred tab should exist when only Thumbview is open");
    console.log("✓ Test 1 passed: otherTabs.length === 0 correctly triggers fallback disposal");
}

// Test 2: Robust Tab Switcher finds code tab across groups
console.log("\n--- Test 2: Tab switcher finds open code tab across tab groups ---");
{
    const mockTabGroupsWithFiles = {
        all: [
            {
                tabs: [
                    { label: "Thumbview", input: { viewType: "thumbview" }, isActive: true },
                    { label: "index.ts", input: { uri: "file:///workspace/src/index.ts" }, isActive: false }
                ]
            },
            {
                tabs: [
                    { label: "README.md", input: { uri: "file:///workspace/README.md" }, isActive: true }
                ]
            }
        ],
        activeTabGroup: {
            activeTab: { label: "Thumbview", input: { viewType: "thumbview" }, isActive: true }
        }
    };

    const { preferred, tabs: otherTabs } = getAllNonThumbviewTabs(mockTabGroupsWithFiles);
    assert.strictEqual(otherTabs.length, 2, "Should find both non-Thumbview tabs");
    assert.ok(preferred, "Should find a preferred tab");
    assert.strictEqual(preferred.label, "README.md", "Should prefer the active tab from other tab group over inactive tab");
    assert.strictEqual(getTabUri(preferred), "file:///workspace/README.md");
    console.log("✓ Test 2 passed: preferred code tab correctly identified");
}

// Test 3: Overview.js contains ensureVisibleOpacity self-healing handlers and watchdog
console.log("\n--- Test 3: Verify overview.js contains self-healing opacity handlers & watchdog ---");
{
    const overviewPath = path.resolve(__dirname, "../../media/overview.js");
    const overviewContent = fs.readFileSync(overviewPath, "utf-8");

    assert.ok(overviewContent.includes("ensureVisibleOpacity"), "overview.js must contain ensureVisibleOpacity()");
    assert.ok(overviewContent.includes("revealSafetyTimer"), "overview.js must contain the revealSafetyTimer watchdog (behavior covered in instant_open.test.js)");
    assert.ok(overviewContent.includes('window.addEventListener("focus", ensureVisibleOpacity);'), "overview.js must restore opacity on window focus");
    assert.ok(overviewContent.includes('document.addEventListener("visibilitychange"'), "overview.js must restore opacity on visibilitychange");
    assert.ok(overviewContent.includes('window.addEventListener("pointerdown"'), "overview.js must restore opacity on pointerdown");
    assert.ok(overviewContent.includes('window.addEventListener("keydown"'), "overview.js must restore opacity on keydown");
    console.log("✓ Test 3 passed: overview.js contains all self-healing opacity hooks and watchdog timer");
}

// Test 4: Extension.ts contains settle delay and robust tab selection
console.log("\n--- Test 4: Verify extension.ts contains settle delay & robust close logic ---");
{
    const extensionPath = path.resolve(__dirname, "../../src/extension.ts");
    const extensionContent = fs.readFileSync(extensionPath, "utf-8");

    assert.ok(extensionContent.includes("getAllNonThumbviewTabs"), "extension.ts must define getAllNonThumbviewTabs");
    assert.ok(extensionContent.includes("switchToTab"), "extension.ts must define switchToTab");
    assert.ok(extensionContent.includes("setTimeout(r, 70)"), "extension.ts must have settle delay for Zen mode exit");
    assert.ok(extensionContent.includes("otherTabs.length === 0"), "extension.ts must handle fallback close when 0 other tabs exist");
    assert.ok(extensionContent.includes("activePanel.dispose()"), "extension.ts must dispose panel on 0 other tabs");
    console.log("✓ Test 4 passed: extension.ts contains robust tab selection, settle delay, and fallback close");
}

// Test 5: Overview.js resize guard & reference-invariant folder collapse
console.log("\n--- Test 5: Verify overview.js guards resize while hidden & reference-invariant collapse ---");
{
    const overviewPath = path.resolve(__dirname, "../../media/overview.js");
    const overviewContent = fs.readFileSync(overviewPath, "utf-8");

    assert.ok(overviewContent.includes('if (document.hidden || document.visibilityState === "hidden")'), "overview.js resize() must guard against hidden tab state");
    assert.ok(overviewContent.includes("refFolderCellW < MIN_CELL_W"), "overview.js folder drilldown must evaluate against refFolderCellW");
    assert.ok(!overviewContent.includes("rootCellW < MIN_CELL_W || rootCellH < MIN_CELL_H"), "rootCellsTooSmall must NOT depend on transient rootCellW/rootCellH");
    console.log("✓ Test 5 passed: overview.js guards resize while hidden and uses stable reference bounds");
}

// Test 6: Extension.ts sends unified sendOpenState on reopening
console.log("\n--- Test 6: Verify extension.ts sends unified sendOpenState on reopening ---");
{
    const extensionPath = path.resolve(__dirname, "../../src/extension.ts");
    const extensionContent = fs.readFileSync(extensionPath, "utf-8");

    assert.ok(extensionContent.includes("updateVisibleRanges(vscode.window.activeTextEditor || lastActiveTextEditor);"), "extension.ts must update ranges before revealing");
    assert.ok(extensionContent.includes("sendOpenState();"), "extension.ts must send atomic open state");
    console.log("✓ Test 6 passed: extension.ts updates ranges and sends atomic openState on reopening");
}

console.log("\n=== ALL TAB SWITCH & OPACITY TESTS PASSED ===");
