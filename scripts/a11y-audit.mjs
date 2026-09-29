// Runs axe-core (WCAG 2.1 A/AA rules) against the real webview page in headless Chrome, in each
// state a user can reach: the grid, an active search, the settings dialog, the folders dialog,
// the shortcut legend, and the fullscreen banner. Exits non-zero on any violation. axe cannot see inside the canvas;
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
    }]
];

let failures = 0;
try {
    for (const [name, enter] of STATES) {
        const page = await openThumbviewPage(browser, pagePath, { width: 1280, height: 800, messages: [initial.message, openState], settleMs: 600 });
        await enter(page);
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
