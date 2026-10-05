// Runs axe-core (WCAG 2.1 A/AA rules) against the real webview page in headless Chrome, in each
// state a user can reach: the grid, an active search, the settings dialog, the folders dialog,
// the shortcut legend, the fullscreen banner, and the context menu opened from the keyboard (whose
// focus movement and Escape are checked too). Exits non-zero on any violation. axe cannot see inside the canvas;
// the grid's keyboard and screen reader behavior is covered by src/test/accessibility.test.js.
//   npm run test:a11y              (needs Chrome or Chromium, python3)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, launchChrome, openThumbviewPage, root, scratchDir, send, settle, writeThumbviewPage } from "./lib/webview_page.mjs";

const { dir, cleanup } = scratchDir("thumbview-a11y-");
const { initial, openState } = demoWorkspace(dir);
const pagePath = writeThumbviewPage(dir);
const browser = await launchChrome();
// Evaluated over the DevTools protocol: the page CSP (rightly) blocks injected script tags.
const axeSource = readFileSync(join(root, "node_modules", "axe-core", "axe.min.js"), "utf8");

const STATES = [
    ["grid", async () => {}],
    ["search", async page => {
        await page.keyboard.type("order");
        await settle(400);
    }],
    ["settings dialog", async page => {
        await page.click("#actions-btn");
        await settle(300);
    }],
    ["folders dialog", async page => {
        await page.click("#folders-btn");
        await settle(300);
    }],
    ["shortcut legend", async page => {
        await send(page, { ...initial.message, showShortcutLegend: true });
        await settle(200);
    }],
    ["fullscreen banner", async page => {
        await send(page, { command: "fullscreenNotice", keybinding: "F4" });
        await settle(200);
    }],
    // The context menu from the keyboard: Shift+F10 focuses its first item, arrows move, and axe
    // then checks the open menu's roles.
    ["context menu", async page => {
        await openMenuFromKeyboard(page);
        const first = await focusedMenuItem(page);
        await page.keyboard.press("ArrowDown");
        const second = await focusedMenuItem(page);
        if (!first || !second || first === second) {
            throw new Error(`keyboard focus did not move through the menu (${first} -> ${second})`);
        }
    }],
    ["context menu closed with Escape", async page => {
        await openMenuFromKeyboard(page);
        await page.keyboard.press("Escape");
        const state = await page.evaluate(() => ({
            hidden: document.getElementById("context-menu").style.display === "none",
            focus: document.activeElement && document.activeElement.id
        }));
        if (!state.hidden || state.focus !== "map") {
            throw new Error(`Escape must close the menu and return focus to the grid (${JSON.stringify(state)})`);
        }
    }]
];

async function openMenuFromKeyboard(page) {
    await page.focus("#map");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.down("Shift");
    await page.keyboard.press("F10");
    await page.keyboard.up("Shift");
    await settle(200);
}

function focusedMenuItem(page) {
    return page.evaluate(() => {
        const el = document.activeElement;
        return el && el.getAttribute("role") === "menuitem" ? el.id : null;
    });
}

let failures = 0;
try {
    for (const [name, enter] of STATES) {
        const page = await openThumbviewPage(browser, pagePath, { width: 1280, height: 800, messages: [initial.message, openState], settleMs: 600 });
        try {
            await enter(page);
        } catch (err) {
            failures++;
            console.log(`✗ ${name}: ${err.message}`);
            await page.close();
            continue;
        }
        await page.evaluate(axeSource);
        const result = await page.evaluate(() => window.axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] }
        }));
        if (result.violations.length === 0) {
            console.log(`✓ ${name}: no violations (${result.passes.length} rules passed)`);
        } else {
            failures += result.violations.length;
            console.log(`✗ ${name}: ${result.violations.length} violation(s)`);
            for (const v of result.violations) {
                console.log(`  - [${v.impact}] ${v.id}: ${v.help}`);
                for (const node of v.nodes.slice(0, 5)) {
                    console.log(`      ${node.target.join(" ")}  ${node.failureSummary.split("\n").slice(1).join(" ").trim()}`);
                }
            }
        }
        await page.close();
    }
} finally {
    await browser.close();
    cleanup();
}
process.exit(failures > 0 ? 1 : 0);
