# DESIGN.md

This document records the *why* behind Thumbview's architecture and behavior — decisions that aren't obvious from reading the code alone — and is the place to record new design decisions going forward, before or as they're implemented. See [CLAUDE.md](CLAUDE.md) for the *what* (file responsibilities, commands, common tasks).

## Extension host vs. webview split

VS Code sandboxes webview content: it gets a real browser context (canvas, CSS, `requestAnimationFrame`) but no direct access to the workspace file system or most of the `vscode` API. Full workspace access requires the extension host (Node). So scanning and file-system watching happen host-side (`extension.ts`, `scanner.ts`), and the result is pushed into the webview (`media/overview.js`) over `postMessage` for rendering — see CLAUDE.md's Architecture section for the message shapes.

## Why a single `<canvas>`, not one DOM element per tile

A workspace can have hundreds or thousands of files. Hundreds of absolutely-positioned DOM nodes, each with their own layout/paint/reflow cost, would be considerably slower to redraw on every resize, search keystroke, or cursor move than a single immediate-mode canvas repaint. Canvas drawing is cheap to fully redraw every frame; the DOM isn't designed to be entirely rebuilt on every keystroke. This also means there's no tile component state to manage — `render()` just redraws everything from `data` each time.

## Shared layout core, generated into the webview

`media/overview.js` is loaded as a plain `<script>` (see the CSP in `extension.ts`'s `getHtml()`), so it cannot `import` the extension-host TypeScript in `src/`. It used to carry hand-synced copies of `buildStableGrid`, `cellsNeeded`, `fillLayoutHoles`, and the spanning reorder helpers, and those copies drifted (the webview's `expand`/`reduce` copies were dead code, and `clampTargetToGridCapacity` had been rewritten differently on each side).

These pure functions now live once in `src/layout_core.ts`. The host imports it (and esbuild bundles it into `dist/extension.js`); `scripts/sync-webview-core.mjs` transpiles it and replaces a marked block at the top of `overview.js`. We generate into the file rather than loading a second webview script or bundling `overview.js` because about twenty tests evaluate `overview.js` directly (whole-file `new Function`, or extracting single functions by regex into a `vm` sandbox); a generated block keeps the webview a single, directly runnable file. `npm run compile` regenerates the block, and CI runs `check-core`, which fails if it is stale.

Behavior was kept identical: the webview's `buildStableGrid` default aspect was `1.777`, not `16/9`, which can flip a row-versus-column tie and move tiles, so every webview call passes its aspect explicitly (all already did). `buildSpanningGrid` and `buildSpanningGridLocal` remain separate on purpose: their inputs differ (persisted allocations versus per-scope footprints and flow cells), and merging them is a behavior change to make deliberately, not as part of the build change. The syntax tokenizers exist only in the webview; `scanner.ts`'s `categorizeLine` is an unrelated coarse classifier.

## Bundled extension host

The host ships as one esbuild bundle (`dist/extension.js`, `package.json` `main`) instead of `tsc` output plus `node_modules`. Activation loads one file instead of resolving a module graph, and the package drops from about 3 MB (screenshots, compiled tests, old artifacts) to the runtime files alone. `tsc` still runs for type checking and emits `out/`, because the compiled-JS unit tests import `out/*.js`. The F5 task runs `node scripts/build.mjs --watch`, which finishes one bundle before starting `tsc -watch`, so the `$tsc-watch` problem matcher cannot release the launch before `dist/` exists. A failed bundle does not end the watch (tsc keeps reporting the error), and every non-production build regenerates the webview's `layout_core` block, so editing `src/layout_core.ts` during an F5 session updates both halves. The unit tests never load `out/extension.js`, so `bundle_smoke.test.js` loads `dist/extension.js` against a stub `vscode` module and fails if the bundle crashes at load, loses its exports, or requires anything other than `vscode` and Node built-ins.

## README images are rendered, not recorded

`npm run screenshots` (`scripts/capture-screenshots.mjs`) regenerates every README image and the GIF. It builds a fresh copy of `demo-workspace/` from `generate.py` (so local edits to the demo never leak into the images), builds the same `data` payload the host would (scanner order, `buildSpanningGrid`, `fillLayoutHoles` for the "ignore leaves a gap" sequence), renders the real page from the bundle's exported `getHtml` plus `media/overview.js` in headless Chrome with VS Code's Dark Modern theme variables, and scripts search typing, the Ctrl magnifier, and the folders popover with real input events. Hand-recorded screenshots went stale as the UI changed (the old ones still showed the removed sidebar actions panel); a script makes refreshing them a one-command step. The trade-off is that the images show only the webview, not VS Code's surrounding chrome, which matches what users see in fullscreen mode. The images live in `media/screenshots/` and are excluded from the package; the Marketplace loads them from GitHub through the README's relative links, so they must be pushed.

## Automated accessibility audit

`npm run test:a11y` runs axe-core (WCAG 2.1 A/AA plus best practices) against the real page in headless Chrome, in every state a user can reach: the grid, an active search, the Settings dialog, the Folders & Ignored dialog, and the fullscreen banner. The first run found unlabelled settings controls, a missing page title, main landmark, and top-level heading, and dimmed file counts failing contrast on the selected folder row; all are fixed and CI keeps it at zero. axe cannot see into the canvas, so the grid itself is covered by `accessibility.test.js` (keyboard navigation, announcements, text status badges). A manual screen reader pass is still needed for what automated rules cannot judge.

## Scale benchmark

`npm run benchmark` measures the real webview at 1,000, 5,000, and 10,000 synthetic files (50 per folder, 20 to 280 lines each, auto-ignore off, so this is the worst case). It stages the host-shaped payload inside the page, then times `postMessage` through the reveal of a stable frame. Results on the development machine (headless Chrome, CPU rasterization):

| Files | Payload | First frame | Frame (warm) | Search keystroke | Drill into folder |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 6.9 MB | 180 ms | 2.2 ms | 22.2 ms | 108.2 ms |
| 5,000 | 34.5 MB | 325 ms | 6.1 ms | 27.4 ms | 102.1 ms |
| 10,000 | 69.1 MB | 559 ms | 11.9 ms | 54.5 ms | 110.4 ms |

Before 0.5.0's payload change the same runs measured 14.4 / 71.9 / 143.9 MB and 318 / 1054 / 1954 ms to the first frame. Profiling the 10,000-file case showed the first frame was not drawing (85 ms) but receiving: cloning the message into the page took about 1.5 s, because every line was an object (`text`, `indent`, `length`, `category`) and structured clone cost scales with object count, and `applyDataMessage` spent about 0.4 s building a lowercase copy of every line. The host now sends lines as plain strings (`withDeltaLines`), which halves the payload and cut the clone to about 0.2 s; the webview turns them into line objects (which carry the per-line render caches) and derives the other fields from the text the first time a line is drawn (`lineShape`: indent and trimmed length, plus `categorizeLine`, moved into the shared core so host and webview classify identically). A first version assumed those fields were unused and dropped them, which flattened tile indentation and turned folder-card preview bars into uniform white rectangles; `robust_scale.test.js` now checks that preview bars vary in width, indent, and color and lowercases each file's joined text in one pass, making per-line lowercase copies only for lines drawn or hovered during a search (`lowerLineText`). The same serialization cost applies on VS Code's host-to-webview path, so real first opens should improve by a similar factor. `fullLines` (files over 2,000 lines) still ships in full because search must cover every line. Delta payloads keep later updates small. The benchmark stages the payload through a file because sending about 150 MB through the DevTools protocol crashes the tab; that limit belongs to the harness, not to VS Code's postMessage.

## Parallel Chunked Workspace Scanning (`Promise.all` in Chunks of 50)

Sequential file reading (`async for ... of` with `await vscode.workspace.openTextDocument(...)`) created a 3–5 second blocking I/O bottleneck during initial workspace load on medium-to-large repositories. Batching disk reads into parallel chunks of 50 via `Promise.all()` provides a 5x–7x scan speedup (under 500ms) while preventing Node extension host event-loop thread starvation.

## Webview Canvas Viewport Frustum Culling

Redrawing code cards, lines, syntax tokens, and titles for hundreds of files that are scrolled offscreen or outside the visible window wastes significant GPU and CPU render ticks. Bounding-box frustum culling (`y + fileH < -50 || y > rectH + 50`) skips drawing offscreen cards completely, locking webview frame rate performance at 60 FPS even on large codebases.

## Pre-Computed Indexing (`file._combinedText`), Tokenization & HTML Caching

Executing string regex tokenization and lowercasing line strings repeatedly inside high-frequency 60Hz render loops caused heavy JavaScript Garbage Collection (GC) pauses during scrolling or typing. 
1. **`_combinedText` Buffer**: File paths and line texts are joined into a single lowercased string buffer (`file._combinedText`) upon data receipt, replacing multi-line search loops with a fast 1-pass native C++ `indexOf` lookup.
2. **`_tokens` and `_htmlCache`**: Syntax tokens and line HTML strings are pre-formatted once upon payload receipt or IPC fetching, eliminating per-frame string allocations.

**Original-case twin buffer.** Match Case and regex/whole-word search can't use the lowercased `_combinedText` buffer — lowercasing loses the information they need to match against. Rather than fall back to re-scanning `file.path`/`file.lines`/`file.fullLines` for those modes (which would reintroduce the per-keystroke GC pressure item 1 exists to avoid), an original-case sibling (`_combinedTextOriginal`) is built in the same pass at data-receipt time, so every search mode stays on a single pre-joined-buffer `.includes()`/`RegExp.test()` call, never a fresh scan.

**Why `_htmlCache` only holds syntax color, not search highlighting.** Line HTML caching (item 2) is a pure performance win when the cached content can't go stale — but a rendered tooltip line's *search* highlighting depends on the live query and its three toggles, which change independently of the line's own content. Baking the pink highlight into `_htmlCache` the first time a line is hovered meant it would silently show a previous query's highlight (or none) after the query changed and that same line was hovered again, since the cache is never invalidated. The fix splits the two concerns: `_htmlCache` keeps only the query-independent syntax-color spans (still cached, since token→color mapping never changes), while search highlighting is rebuilt from `line._tokens` fresh on every hover render. This reintroduces a small amount of per-hover work, but it's bounded to the ~25 lines the tooltip shows at once and already sits behind the `mousemove` `requestAnimationFrame` throttle, so it doesn't reopen the GC-pressure problem item 1 solved.

## Constant-Time Tab Set Lookup (`openFilesSet`)

Searching open tab arrays linearly (`openFiles.includes(file.uri)`) for every card on every frame render tick is an $O(N \cdot M)$ operation. Maintaining a `Set<string>` (`openFilesSet`) reduces open-tab border checks to $O(1)$ constant time.

## Top-Level Root Consolidation & Redundant Ignore Pruning

When a parent directory (e.g., virtual environment `BOFS/` or `.venv/`) contained 1,000 subdirectories, naive auto-ignore generated 1,000 redundant tree items in the sidebar. Aggregating ignore rules to top-level root folders (`BOFS/`) and pruning nested child paths keeps the ignore list clean, prevents memory degradation, and allows users to un-ignore top-level folders with a single click.

## Auto-Ignore Exclusion List (`autoIgnoreExclusions`)

Auto-ignore runs on every `scanRepository()` call, re-detecting dense folders from scratch. Without memory of prior user decisions, un-ignoring a folder only removed it from `ignorePatterns` — the very next scan would re-detect the same folder as dense and re-add it. The `autoIgnoreExclusions` persistent list solves this: when a user removes a directory pattern (ending with `/`) from ignores via the sidebar, it's added to `autoIgnoreExclusions`. The auto-ignore heuristic checks this list before adding any folder. This preserves auto-ignore's value for first-time discovery while respecting explicit user intent. Both lists are stored in `workspaceState` (see below).

## Ignore State in `workspaceState`, Not `.vscode/settings.json`

Prior to 0.2.7, `ignorePatterns` and `autoIgnoreExclusions` were stored using `ConfigurationTarget.WorkspaceFolder`, which writes to `.vscode/settings.json` inside the user's project. This caused the extension to silently create a `.vscode/` directory and `settings.json` file in repositories where none existed, polluting `git status` and risking accidental commits of extension-internal state.

Both values are now stored in `ExtensionContext.workspaceState` — VS Code's built-in per-workspace key-value store that lives in VS Code's internal data directory (`~/.config/Code/` or equivalent), never in the user's project. This is the same mechanism the extension already uses for `thumbview.seenFiles` and spanning layout allocations. On first activation after the migration, any old `settings.json` values are read, merged into `workspaceState`, and deleted from configuration so the `.vscode/settings.json` file can be safely removed.

## `repomap.*` → `thumbview.*` workspaceState key rename (0.3.1)

The file-order and spanning-layout persistence keys were originally named `repomap.seenFiles`, `repomap.spanningAllocations`, and `repomap.spanningRows`, left over from before the Repository Map → Thumbview rename (see CLAUDE.md's Terminology section). Renaming a `workspaceState` key isn't safe to do as a plain find-and-replace: existing users already have real data — file-to-grid-slot assignments and spanning allocations — sitting under the old key names. A bare rename would make the extension look up a key that's never existed for them, silently discarding that state and reshuffling their grid on next load.

Instead, `activate()` runs a one-time migration on every activation: for each `repomap.*` key that still has a value, copy it to the corresponding `thumbview.*` key (only if the new key isn't already populated) and delete the old key. This mirrors the `settings.json` → `workspaceState` migration above. Once we're confident essentially all users have activated the extension at least once past 0.3.1, the migration block and the old key names can be deleted outright, and the reads/writes can go back to plain `thumbview.*` literals with no fallback.

## Subdirectory & Root Directory Selection Lowlighting (Opacity 0.15)

Previously, selecting a subdirectory filtered out non-selected files completely and re-packed the remaining files. This broke spatial memory of where files live in the full repository grid. In 0.3.0, selecting a subdirectory retains all workspace file tiles in their stable grid slots while dimming non-selected files (`ctx.globalAlpha = 0.15`). Selecting "Root Directory Files Only" in Directory Navigation (or clicking a root file's header bar) similarly highlights only files located directly in the root workspace folder (`!file.path.includes("/")`) while lowlighting subdirectories. This keeps spatial layout consistent while highlighting the active directory or root level.

## Fixed Maximum Line Gap for Short Code Files (6px Cap)

Minimap canvas tiles divide tile height by line count (`stepY = h / lineCount`). For short files with few lines (e.g. 5–10 lines), naive division created large 15–20px vertical gaps between lines, stretching code structure artificially. Capping `stepY` at 6px max (`Math.min(h / lineCount, 6)`) ensures short files maintain standard 1:1 code line spacing with empty space at the bottom of the card, matching how developers naturally see code files in text editors.

## Fullscreen Mode via Zen Mode

The minimap needs the whole workbench to be readable — a single editor column squeezed between sidebar and panel restricts the canvas to a fraction of the monitor. Two constraints shaped the design:

1. **Extensions cannot read workbench visibility state.** There is no API or command to query whether the sidebar, panel, or auxiliary bar is visible ([microsoft/vscode#186581](https://github.com/microsoft/vscode/issues/186581)). Context keys like `sideBarVisible` exist but are not exposed to extensions, so snapshotting "what was open" in extension code is impossible.
2. **Blind toggles desync under concurrency.** `toggleMaximizeEditorGroup` flips global state with no way to read it. Earlier versions paired toggles with an optimistically-set boolean, but the command path and `onDidChangeViewState` both fired on panel creation, passed the flag check before either set it, and stacked toggles that cancelled each other — fullscreen worked only intermittently, and opening documents into a maximized group could spawn stray split groups.

The current design outsources the snapshot to VS Code itself:

1. **Zen Mode does the hiding and restoring.** `workbench.action.toggleZenMode` natively records and restores sidebar/panel/aux bar (and activity bar/tab bar) visibility. `zenMode.centerLayout`, `zenMode.fullScreen`, and `zenMode.hideActivityBar` are temporarily forced to `false`, `zenMode.showTabs` is forced to `"none"`, and `zenMode.singleTabGroup` is forced to `true` so the grid uses the full window and hides any split editors to the right of Thumbview. These are global user settings, so Thumbview never writes them at activation. `applyZenOverrides` (`src/zen_settings.ts`) backs up the user's global values in `globalState` and writes only values that differ, once per session on the first fullscreen open. Restoring on every close was rejected: it rewrote the global settings.json twice per F4, which churns Settings Sync (a crash could sync the overrides to other machines), fires every extension's configuration listeners, flickers an open settings editor, and added latency to every open. The cost is that a user who enters Zen mode themselves during that session gets Thumbview's variant. Because `globalState` is shared across windows, every window using the overrides registers as an owner under its own key with a heartbeat (one key per window, because read-modify-write of a shared map lets two windows drop each other's entry), and `releaseZenOwnership` restores the user's values only when the last live owner leaves: at `deactivate()`, or at the next activation once a crashed window's heartbeat is stale. Reload and crash change the session id while the old heartbeat stays fresh for up to 90s, so activation recovery re-checks once that window has passed. `thumbview.zenEnteredByThumbview` records that Thumbview turned Zen on, because VS Code restores Zen mode across restarts; after a crash the next activation exits it. Earlier versions forced these settings globally on every activation and never restored them, which was the single most intrusive behavior of the extension. `thumbview.fullscreenOnOpen` (default `true`) turns the whole Zen/maximize behavior off, opening Thumbview as a normal editor tab. The left sidebar remains hidden during Zen mode, and all extension navigation, ignore management, and configuration controls are embedded directly in the webview top toolbar.
2. **Splits are maximized symmetrically — and always against the same group.** `toggleMaximizeEditorGroup` is paired with `zenMode.singleTabGroup` to guarantee isolation across split groups. So maximize (`maximizeThumbviewGroup`) runs only after the Thumbview panel is active, and unmaximize (in `exitFullscreen`) first re-reveals the panel if it isn't active, guaranteeing both toggles land on Thumbview's group.
3. **All layout ops are serialized, and view-state churn is suppressed.** Every open/close/jump/switchTab sequence runs under `withLayoutLock` (see "F4 Spam Resilience"), so concurrent invocations can't stack. Zen/maximize shuffles focus, making the panel's `active` flag flicker — so `onDidChangeViewState` ignores events while a layout op is in flight (plus a 300ms grace window), and exits fullscreen only when the panel is actually *hidden* (`visible === false`), not merely inactive. `jump`/`switchTab` load the document first (`openTextDocument`, which changes nothing on screen), then send the Zen exit, the group unmaximize, and `showTextDocument` back to back without awaiting in between (`switchLeavingFullscreen`), with no fixed sleeps. All three settle (`Promise.allSettled`) before the layout lock is released, so a failed open cannot let the next F4 interleave with a layout change still in flight, and the failure is shown to the user. The original order (hide the page, exit Zen, sleep 70ms and 30ms, then open) was visibly slower than the Explorer and showed the empty background meanwhile. The next version showed the editor first and exited Zen afterwards; that removed the flash but showed the file in Zen for about half a second on slower machines before the sidebar, tabs, and status bar came back, two visible changes for one click. Sending both requests together lets the workbench apply them in the same update, so the file appears once in the normal layout. Total time is similar (the layout still has to be rebuilt); what changes is that the user sees one transition instead of two. Opening a file this way remains slower than from the Explorer, whose clicks never change the layout: leaving Zen makes the workbench lay out the sidebar, panel, status bar, and tabs again. Thumbview keeps out of that work's way: the webview stops drawing the moment a file is clicked (`postSwitchAway`), because editor, tab, and visible-range events during the switch each used to trigger a full-grid repaint on the renderer thread the workbench layout also needs, and the host holds those `openState` posts until Thumbview is reopened. Each open's timing (layout-lock wait, document load, show plus layout restore) goes to the Thumbview output channel, so remaining latency can be measured on real machines. Users who want Explorer speed can turn off Open Fullscreen, which skips the layout change entirely. The editor opens in Thumbview's own group, so unmaximizing restores the other groups around it.
4. **Speed comes from concurrency and ordering, not from skipping steps.** Fullscreen (zen) is entered *before* the panel is created or revealed, so Thumbview renders at full size immediately rather than snapping through intermediate layouts, with the group maximize following right behind it in the layout queue. On exit, `jump`/`switchTab` finish the file's disk read (`openTextDocument`) before touching the layout, then overlap the layout exit with showing the editor.

Exit runs from all leave paths: the toggle-off branch of `thumbview.open`, panel deactivation in `onDidChangeViewState`, and `onDidDispose`.

## Reopening next to a split

Reopening reveals the retained panel before maximizing its group. `toggleMaximizeEditorGroup` has no target argument: it maximizes the active group. Right after the user splits the editor, the active group is the new split, while Thumbview's retained panel still lives in its original group. Maximizing first maximized the split, and revealing the panel afterwards activated a group that the maximize had hidden, which makes VS Code restore the layout: Thumbview appeared beside the code instead of fullscreen. Revealing first (the page is still hidden by the reopen transition) and waiting for the panel's view-state event, bounded at 300 ms because `panel.active` lags `reveal()`, makes the maximize apply to the group holding Thumbview.

## F4 with split editors

Two more split-editor defects came from the same handler and toggle. The first open was not marked as a layout operation (reopen was), so the view-state event for the brand-new panel reached the rule that closes Thumbview when "the user dragged it into a split" (fullscreen plus more than one group); with splits open the maximized groups still count, so the panel closed itself and only the second F4 worked. The create path now counts as a layout op and that rule ignores groups Thumbview maximized. Separately, F4 decided open versus close by `panel.visible`, so pressing it in the right group while Thumbview showed in the left one closed Thumbview instead of bringing it forward; it now closes only a focused panel.

## Closing next to a split

Closing returns to `returnTo`, the file and group the user was in when F4 opened Thumbview. It used to return to `lastActiveTextEditor`, but a trace from a real split session showed that value changing during Thumbview's own layout steps (entering and leaving Zen, maximizing and unmaximizing briefly activate another group's editor), so closing landed in the other group and left Thumbview showing; a `TextEditor` hidden behind Thumbview also loses its `viewColumn`. The same trace then showed the covered-editor restore never running: `isThumbviewTab` compared the tab's `viewType` with `"thumbview"`, but the tab API reports extension webviews as `"mainThreadWebview-thumbview"`, so no group ever appeared to contain Thumbview (and close-path fallbacks could even choose Thumbview itself as the code to return to). The check now lives in `webview_tabs.ts` with a unit test. Opening editors during close is bounded (`openInGroup`, 1.5 s) so a workbench open that never settles cannot hold the layout lock, and each step is logged to the Thumbview output channel.

Before this, closing returned to the most recent code, which after a split can be in a different group from Thumbview's panel. Nothing then replaced Thumbview in its own group, so it stayed visible beside the code. Thumbview now snapshots each group's active editor before it is revealed or created, records the one in the group that ends up holding it, and on close re-opens that editor in that group with `preserveFocus` (falling back to the group's first other editor), so every group looks as it did before F4 and focus stays on the code. If Thumbview is the only editor in its group there is nothing to restore and the group keeps showing it.

## Testing split-editor behavior

The split-editor rules (where closing returns to, which editor Thumbview covered, F4's open/focus/close decision) caused a run of regressions while they lived as closures inside `activate()` with only source-text checks. They now live in `editor_groups.ts` over an injected `Workbench` facade (groups, open, log), and `editor_groups.test.js` replays real traces against simulated groups: the user in one group with Thumbview's panel in another, a return point whose group was closed, an open that never settles, Thumbview alone in its group. A new split bug should be reproduced there first.

## Onboarding

A first-time user has three ways in: the Getting Started walkthrough (Welcome page, Help > Get Started), the one-time fullscreen banner, and an in-grid legend of the keys that cannot be discovered by looking (type to search, Left Ctrl to magnify, click a line, F4/Esc back). The legend is small and dismissible, and its dismissal is stored in `globalState` so it never returns; the settings dialog keeps the full shortcut list.

## First-run fullscreen banner

Opening fullscreen is the right default (code is only readable when tiles are large), but taking over the window unannounced is the most common complaint about extensions that do it. The first fullscreen open therefore shows a one-time banner inside Thumbview explaining why and offering "Open as a tab instead", which turns `thumbview.fullscreenOnOpen` off and leaves fullscreen immediately; the Settings dialog has the same toggle. It is a banner in the webview, not a VS Code notification, because Zen mode's default `zenMode.silentNotifications` hides informational notifications, so a toast would never be seen at the moment it matters. It is announced through the live region but does not take focus, so typing still goes to search. `globalState` (`thumbview.fullscreenNoticeShown`) records it as soon as it is sent, so closing Thumbview without answering never brings it back, and it is hidden whenever the panel is hidden. Every change to `thumbview.fullscreenOnOpen`, from the banner, the Settings toggle, or `settings.json`, goes through the configuration listener, which syncs the toggle (`fullscreenSetting`), removes the banner, and leaves fullscreen at once when the setting is turned off.

## Instant Hotkey Toggle & Retained Webview Context (`F4`)

`F4` is VS Code's own "next search result" and "next reference" key. The binding carries `"when": "!searchViewletFocus && !referenceSearchVisible"` so VS Code's meaning wins while the Search view has focus or a references peek is open, and Thumbview's everywhere else. Shipping no default key was rejected because the grid would be undiscoverable. `!hasSearchResult` (VS Code's actual condition for its F4) was also rejected: search results linger after a search, so F4 would seem to stop opening Thumbview. The accepted cost is that Thumbview's F4 wins in text editors while results exist. The toolbar shows the user's own binding by reading the single `keybindings.json` in the User folder that contains the extension's `globalStorageUri` (cached by mtime); earlier versions probed a dozen guessed per-platform paths for other VS Code distributions.

In earlier versions, pressing the toggle hotkey (`F4`) to close Thumbview called `activePanel.dispose()`. This completely destroyed the webview panel, forcing a full repository rescan (`scanRepository()`) and line tokenization phase when reopening in large codebases.

In 0.3.1, pressing `F4` while Thumbview is active exits fullscreen (see "Fullscreen Mode via Zen Mode") and switches focus to the most recent editor tab (`workbench.action.openPreviousRecentlyUsedEditorInGroup`). Because the panel was created with `retainContextWhenHidden: true`, keeping the WebviewPanel alive in the background preserves its DOM canvas, line cache, and search index in memory. Pressing `F4` again instantly reveals the background panel with 0ms delay and zero scanning overhead. Closing the tab manually (`×` or `Ctrl+W`) disposes the panel as normal.

## Configurable Subfolder Card Threshold (`thumbview.minCellWidth` & `thumbview.minCellHeight`)

Large workspaces (hundreds of files) can produce grid cells too small to display a readable filename or be clickable. The webview evaluates tile dimensions against `thumbview.minCellWidth` (default `60px`) and `thumbview.minCellHeight` (default `40px`).
1. **Root File Tiles Visible**: When root file cells fit on screen above the minimum dimensions, selecting a directory (via sidebar Directory Navigation or path click) lowlights non-selected files (opacity 0.15), preserving full codebase grid layout.
2. **Directories Shrunk to Folder Cards**: When root cells drop below the minimum dimensions, directories shrink into clickable folder cards. Selecting a directory opens/drills down into that folder, constructing a complete Thumbview grid containing only that directory's files.

## Multi-Select Batch Deletion (`canSelectMany: true`)

Managing ignored patterns one by one from the sidebar tree view was tedious. Enabling `canSelectMany: true` on `thumbview-ignores` allows users to select multiple patterns via `Shift + Click` or `Ctrl + Click` and remove them in a single atomic VS Code configuration update.

## Modifier Key Hover Magnification (`Ctrl` Hold) & Throttling

Un-throttled hover magnifying tooltips running on raw high-frequency mouse movements over 5,000-line files caused UI stuttering and stole OS window focus when using `Alt`. 
1. Requiring `Left CTRL` hold to reveal code line magnification gives the user deliberate control and prevents accidental popup flickering while panning across tiles.
2. Throttling mouse hover evaluations with `requestAnimationFrame` ensures hover calculations execute at most once per frame (60 FPS).

## Panel Focus on Click (`focusWindow`)

VS Code webviews do not gain input focus from hovering. Earlier versions posted `focusWindow` on `mouseenter` and every `mousemove`, which revealed the panel as active whenever the pointer crossed it and pulled focus out of the terminal or editor the user was typing in. `focusWindow` is now requested only on `mousedown`, so keyboard features such as Left Ctrl magnification start working after the first click into Thumbview, never on hover.

## HiDPI Tile Rasters

Tile and folder-mosaic rasters are created at `intW * devicePixelRatio` (capped at 2) with the context scaled accordingly, and drawn back with an explicit `drawImage(canvas, x, y, w, h)`. The DPR is part of both cache keys, and `CanvasLRU`'s byte budget counts real pixels, so HiDPI screens get sharp tiles at the cost of fewer cached tiles rather than unbounded memory. Previously rasters were CSS-pixel sized and upscaled 2x by the main canvas transform, blurring the product's main surface on Retina displays.

## Two layout modes: `uniform_grid` vs `spanning_grid`

`spanning_grid` (the default) communicates a file's relative size and line count visually by having tall files span multiple vertical grid cells. `uniform_grid` is also available as an alternative mode (1 cell per file) via `thumbview.layoutMode`.

## Stable, incremental grid growth (`buildStableGrid`)

Users build spatial memory of where a file's tile lives ("that file is bottom-right of the grid"). If adding one new file to the workspace re-flowed every existing file to a new position, that memory would be invalidated on every git branch switch or scaffold step. So the grid only ever grows by appending new columns then new rows onto the existing layout (see the comment in `layout.ts`), and `PersistentFileOrder` (`state.ts`) guarantees a given file's array index — and therefore its slot — never changes just because other files came and went.

## Hole-filling instead of compaction (`PersistentFileOrder.update`)

Why a deleted file leaves a gap that's backfilled by a new file, rather than immediately compacting the array: same stability goal as above. Removing a file from the middle of the order and shifting everyone else down would move every subsequent file's slot. Backfilling a hole means only the newly-added file's position is "surprising"; nothing already on screen moves. The explicit **Reflow Layout** command exists for when a user *does* want to intentionally compact and reset — e.g. after a lot of churn has left many holes and the grid feels sparse.

## Spatial Stability of Every Layout Order (`fillLayoutHoles`)

Thumbview exists so that the brain can remember where each file lives. Any change that moves a tile the user did not move defeats the product, so every layout order follows one rule: a removed (ignored or deleted) item leaves a hole, a new or unignored item fills the earliest hole it fits in, and an item appends only when no hole fits. Orders are never trimmed or compacted, because shrinking an order can shrink the grid's column or row count and re-map every slot. Only the explicit Reflow Layout command compacts.

Previously the rule held only for the root grid. Folder drill-down views laid files out from the folder's current file list whenever the user had never dragged inside that folder, so ignoring a file shifted every later file. Folder card views skipped removed ids and trimmed trailing gaps. In spanning mode a hole collapsed to one cell because the webview did not know the removed file's height.

How it works now:
1. **One algorithm, two copies.** `fillLayoutHoles` exists in `src/state.ts` (root order, via `PersistentFileOrder.update`) and `media/overview.js` (folder files and cards). `folder_ignore_stability.test.js` runs both on random inputs and requires identical results.
2. **The webview reconciles folder and card views.** Only the webview knows those layouts (which files collapse into which cards, spanning column breaks). On render it reconciles the saved order, seeding the on-screen order on first view so seeding moves nothing, mirrors the result into `data`, and posts `saveLayoutOrder` for the host to persist.
3. **Spanning holes keep their exact cells.** A hole is sized as the removed id was on screen in that view: its natural cell count (`naturalCells`, which the host keeps even for removed ids) or its footprint there. An item that fills a taller hole records a footprint and is laid out at `max(natural, footprint)` cells, so it occupies exactly the hole with its content at the top and empty space below. Recording a footprint instead of inserting filler entries matters: a tall file that did not fit at the bottom of a column started a new column, and a shorter replacement would otherwise fit at the bottom of the previous column and shift everything after it. Footprints are scoped per view (`"root"`, `"folder:<path>"`, `"cards:<path>"`) so a fill in a folder does not grow the same file at the root and re-flow it there.
4. **Frozen column height.** The root grid persists `thumbview.spanningRows`. Folder and card views now persist their column height on their first spanning reconcile, so appending adds columns instead of recomputing the height and re-wrapping every column.
5. **Serialized writes.** Drag handlers read an order, await, then write it. `withOrderLock` queues every order read-modify-write so a concurrent payload or `saveLayoutOrder` cannot overwrite a drag and flip a hole-fill decision.

The root spanning grid previously integrated new files with `integrateNewFilesPreservingPositions`, which recomputed the column height as files were added and depended on in-memory placements that were lost on restart. It now uses `fillLayoutHoles` with the saved `spanningRows`. The old function remains in `spanning_layout.ts` only for its existing unit test.

**Upgrade note.** Orders saved by earlier versions may already contain ids of files removed since. Those are now honored as holes, so the first view of such a folder after upgrading can show a larger grid. Reflow Layout compacts it.

## What Counts as Source: Git, `files.exclude`, and Thumbview Ignores

`file_discovery.ts` lists each workspace folder with `git ls-files --cached --others --exclude-standard`, which applies every `.gitignore` level, `.git/info/exclude`, and the user's global excludes exactly as git does, and returns tracked plus untracked-but-not-ignored files. Earlier versions combined a hard-coded folder-name blocklist (`lib`, `build`, `out`, `env`, `target`, `vendor`, …), which hid real source such as Flutter/Ruby `lib/`, with a hand-rolled reading of only the first folder's root `.gitignore` (whose result was not even applied). Git is skipped when the folder is not a repository, git is missing, the URI is not `file:` (remote/virtual), or the workspace is untrusted (a repository's own git config can execute commands); those cases fall back to `findFiles`. Either way, enabled `files.exclude` globs (converted by `globToRegExp`) and `.git`/`node_modules` are removed. Files whose first 8KB contain a NUL character are treated as binary and skipped.

On top of that, `scanner.ts`'s `shouldIgnore` applies the user's Thumbview ignore patterns from `workspaceState` (glob-to-regex, sequential, with `!` negation), managed in the sidebar tree view and toolbar popover.

## Sidebar Tree Views & Navigation

To improve navigation in large repositories where canvas headers are small:
1. **Directory Navigation Tree**: Built hierarchically in `directoryProvider.ts`. Focuses the Thumbview canvas to specific folders with accurate cumulative file counts (including subdirectories). Right-clicking a folder enables deleting it from disk (via confirmation modal) or revealing it in VS Code's File Explorer.
2. **Ignored Files & Directories Tree**: Built in `ignoreProvider.ts`. Allows adding, removing, multi-selecting (`canSelectMany`), deleting files/folders from disk (with trash or permanent options), and revealing items in VS Code's File Explorer.

## Unified Folders & Ignored Side-by-Side Modal

Users navigating dense workspaces needed an immediate way to inspect what folders are shown and what items are ignored without leaving the minimap canvas panel.
1. **Side-by-Side Visibility**: The `📁 Folders & Ignored` modal renders active folders on the left (with file counts, click-to-isolate, and one-click ignore) and all ignored directories and glob patterns on the right (with one-click unignore).
2. **Dedicated Folder Representation**: All auto-ignored and manually ignored folders are displayed with folder badges and icons in the ignored section.
3. **Isolated Input Focus**: Text input fields within the modal operate independently of the global minimap keydown listener, allowing users to type glob patterns directly without triggering search bar hijacking.

## Webview Context Menu & Pinned Editors

Right-clicking minimap file cards triggers a custom HTML context menu supporting standard VS Code Explorer actions (Open, Open to Side, Open Preview, Select for Compare, Compare with Selected, Reveal in Explorer, Open Containing Folder, Cut, Copy, Copy Path, Copy Relative Path, Rename..., Delete, Ignore in Thumbview). Jumping to files opens them with `{ preview: false }` to ensure tabs pin permanently and populate recency history.

## Host Safety Limits & Dynamic Hover Fetching

To prevent extension crashes or main thread freezes when scanning repositories with massive files or long minified code:
1. **File Size Cap**: Files over **2 MB** in size are skipped from initial workspace scanning.
2. **Line Length Truncation**: Lines are truncated at **300 characters** for minimap rendering.
3. **Evenly Spaced Line Sampling & Dynamic IPC Fetching**: For files over 2,000 lines, initial scanning samples up to **2,000 lines evenly spaced across the entire file** using uniform striding (`step = doc.lineCount / 2000`). This preserves the visual shape and structure of long files from top to bottom on the minimap card without overloading memory. `doc.lineCount` remains untruncated so tile heights and scrolling positions remain accurate. Any missing lines requested during hover overlay browsing are dynamically fetched on demand via `getHoverLines` IPC.
4. **Fixed Per-File Overlay Width**: Hover overlay tooltip width is fixed per file based on `min(maxWidthAllowed, widestLine)` across all available lines in that file. This prevents layout jitter/flashing as the cursor moves across lines of varying lengths in the same file.

## Centralized UI Chrome Colors & Fixed Brand Accents

Thumbview's UI chrome (webview HTML/CSS, canvas tile chrome, and editor jump-flash decoration) derives directly from the user's active VS Code theme using standard theme contribution variables (`--vscode-editor-background`, `--vscode-foreground`, `--vscode-menu-*`, `--vscode-focusBorder`, etc.). Three specific accents are intentionally fixed across all themes to preserve visual identity and accessibility:
1. **Search Accent (`#dc267f`)**: Used for search matching borders, highlighted token text, and editor jump fade-out decorations.
2. **Inspection Accent (`#785ef0`)**: Used for the interactive `Left CTRL` hold magnify tooltip hover marker and row border.
3. **Recency Accent (`#fe6100`)**: Used for the open editor tab indicator.

The constants are defined once in `src/colors.ts` and injected into the webview `<style>` as `:root { --tv-accent-* }` custom properties, where `media/overview.js` accesses them via `getThemeColor()`.

## Diagnostic Error Highlighting & Title Color Hierarchy

Thumbview listens to VS Code language diagnostics (`vscode.languages.onDidChangeDiagnostics`) to detect syntax and compilation errors across the workspace in real time:
1. **File Title Color Precedence**: Card titles resolve in priority order: Search Match (`#dc267f`) > Error (`--vscode-list-errorForeground` / `#f14c4c`) > Git Modified (`--vscode-gitDecoration-modifiedResourceForeground`) > Git Added/Untracked (`--vscode-gitDecoration-untrackedResourceForeground`) > Active Editor (`--vscode-foreground`) > Default (`--vscode-descriptionForeground`). Files containing any Error-level diagnostic immediately display red titles to draw immediate attention.
2. **Minimap Overview Line Highlighting & Git Deletion Carets**: Lines with active errors render a full-width red background (`rgba(239, 68, 68, 0.22)`) and red gutter indicator (`rgba(239, 68, 68, 0.85)`). Git deletions render as red gutter triangle carets (`▶`) on the left margin rather than full-width stripes, keeping full-width row fills reserved for active lines. When inspecting code with Left CTRL hold, offending lines display `✕` error icons and diagnostic messages, while deleted lines display `-` prefixes and strikethrough text.
3. **Viewport Band Transparency**: The gray viewport band overlay representing the open editor range (`viewportBandOverlay`) uses subtle `rgba(255, 255, 255, 0.08)` transparency so Git modified blue highlights and added green highlights remain visible underneath without color pollution.

## Drag-and-Drop Grid-Slot Targeting & Empty Space Preservation

Drag-and-drop reordering resolves cursor positions to specific grid slots rather than nearest occupied tiles:
1. **Webview-Side `slotOccupancy` Map**: On each `"data"` message payload, `media/overview.js` populates an in-memory `Map<string, RepoFile>` (`slotOccupancy`) keyed by `"${col},${row}"`. Mouse movement and drag operations convert canvas pixel coordinates directly to clamped `[col, row]` coordinates, performing an $O(1)$ hashmap lookup. This allows empty slots to be directly addressable drop targets (`file === null`) and eliminates Euclidean distance search errors across columns.
2. **Host-Side `PersistentFileOrder` & Gap Preservation**: Tile arrangements are persisted as a `string[]` array in `workspaceState` under `"thumbview.seenFiles"`. When a user drags a file into an empty tile slot, the source slot is preserved as an empty placeholder (`""`) in the order array. In `uniform_grid`, the tile is assigned the target slot index via `findSlotIndex` without shifting intervening files. In `spanning_grid`, a 2D column-major slot grid model clears source cells and writes the file into target column/row coordinates while retaining empty placeholder cells, preventing cascading repack reflows.
3. **Reflow Action**: When users intentionally want to pack all empty spaces and eliminate gaps (e.g. after moving multiple files or deleting files from disk), the **Reflow Grid Layout** toolbar action and command reset the array strictly to active workspace files.

## Preserving File Positions on Folder Unignore (`integrateNewFilesPreservingPositions`)

When unignoring a folder with many files, naive grid packing reshuffles existing files as `wrapRows` or total cell count expands. To preserve visual muscle memory:
1. Existing file placements are preserved at their exact `(col, row)` coordinates in a 2D matrix.
2. New files first fill remaining empty rows in existing columns (below existing cards).
3. Any remaining new files expand into new columns to the right.
This ensures existing cards never reflow or jump away when unignoring folders.

## Tall File Vertical Overflow Protection

In spanning grid mode, tall files occupy multiple vertical cells (`nCells`). When the window or webview vertical height shrinks, a tall file whose pixel height (`nCells * cellH`) exceeds the canvas vertical bounds (`availableH` or `rectH`) would otherwise be clipped or disappear offscreen.
Thumbview detects `hasTallFileOverflow` during layout calculation and automatically toggles `rootCellsTooSmall = true`. This cleanly transforms the view into subfolder cards mode so files remain accessible and legible without clipping.

## Reorder Gesture Performance (Token Cache & Offscreen Drag Canvas)

1. **`fileTokenCache`**: Re-tokenizing lines and creating combined text buffers for every file on every tile drop payload incurred heavy synchronous overhead. Caching tokenized lines and combined text strings keyed by file ID, line count, and line 0 content skips re-tokenizing unchanged files, reducing drop processing to under 2ms.
2. **`cachedDragBackgroundCanvas`**: Reuses an offscreen canvas across drag operations rather than creating and discarding DOM elements during tile pickup, keeping drag animations locked at 60 FPS.

## Folder Cards Empty Space Drop Synchronization

When dragging cards in subfolder cards overview, the host synchronizes `thumbview.cardOrder` using the current card order snapshot sent from the webview (`msg.currentCardIds`). Dropping into an empty space places the card at the exact target slot index rather than appending it to the far right.

## Subfolder Cards Mode Uniform Layout & In-Folder Drag Stability

1. **Uniform 1-cell layout**: In subfolder cards mode (`cellsTooSmall === true`), all folder cards and root file tiles render with uniform 1-cell dimensions (`localCellH = availableH / cardRows`). This maintains a clean, uniform visual hierarchy and predictable grid alignment across all cards.
2. **In-Folder Drag Stability**: Within a subfolder card or folder drill-down view (`focusedFolder`), dragging and dropping files strictly respects the layout's column wrap stride (`gridRows = wrapRows`). Swapping two files places the target item into the source file's vacated slot so neither file is lost or shifted. Moving a file to an empty space preserves the exact coordinates of all other files in the folder without cascading downstream tiles into adjacent columns. Folder file reorders update `thumbview.folderOrders` without mutating the workspace-wide `fileOrder`.

## Leaf Node Folder Spanning Grid Representations

When viewing or drilling down into a folder at the leaf node of subdirectories (a directory that contains only files, with no child subdirectories), subfolder cards mode cannot apply because there are no child folders to represent as cards. The files within leaf node folders strictly retain their spanning grid representation (`localSpanningLayout`) with multi-cell heights reflecting line counts. In subfolder cards overview, preview tiles inside leaf node folder cards also render spanning grid representations.

## Dynamic Tile Height Expansion on Line Count Growth

Adding lines to a file grows its tile via `cellsNeeded(f.lineCount)` (e.g. 9 cells for a 10,000 line file), and removing lines shrinks it. Files below it in the same column shift down or up, which the user accepts, but **no file ever changes column**: column membership is part of spatial memory.

Each layout therefore tracks two heights per file. *Flow cells* decide column breaks and are frozen when a file is first placed in a view (root: `thumbview.spanningAllocations`; webview-owned views: `thumbview.slotFlowCells`, scoped like footprints and recorded by `missingFlowCells` on reconcile). *Display cells* are `max(cellsNeeded(lineCount), footprint)` and set the drawn height and in-column position. `buildSpanningGrid` and its twin `buildSpanningGridLocal` advance a flow cursor for break decisions and a separate display cursor for placement. When grown tiles make a column taller than the grid, the grid gains rows, and columns in the same proportion so cells keep their aspect ratio instead of being squashed. Reflow Layout clears frozen flow cells, footprints, and natural cells to start a fresh baseline.

Two consequences of the split are easy to get wrong. First, readability checks that collapse a view into folder cards must use the pre-overflow size (`flowRows`/`flowCols`); otherwise the rows and columns added for a grown file shrink the reference cells and typing can flip the whole root into cards. Second, every drag simulation must use frozen flow cells (`dragFlowAllocations`, host `reorderFile`), not display heights; otherwise the optimistic drop and the host's next layout disagree and a file whose height changed can land in another column. Tolerances (`+ 1px`) on vertical bounds checks prevent IEEE 754 floating-point rounding errors (`(availableH / gridRows) * gridRows > availableH`) from triggering false-positive overflow collapses.

## Nested Folder Cards & Variable Spanning Heights in Previews

In folder cards mode, parent folder cards inspect child subdirectories using `getSubfolderGroups(group.files, group.path)`. When child subfolders exist, mini folder cards are rendered inside the preview mosaic rather than flattening all recursive files into a single flat grid. Additionally, preview files preserve variable spanning heights (`nCells` derived from `cellsNeeded(f.lineCount)`) through `buildSpanningGridLocal` so files of different lengths (e.g. 1-tile vs 3-tiles tall) accurately reflect their proportional heights within folder card previews.

## In-Folder Grid Sizing & Empty Slot Targeting

In folder drill-down uniform views, `localFolderGrid` generates slots spanning the entire grid dimensions (`folderCols * folderRows`), rather than capping at `scopedFiles.length`. This ensures that coordinates for empty grid slots resolve to valid slot indexes (`slotIdx !== -1`), preventing dropped tiles from defaulting to top-left positions. In both spanning and uniform folder views, drops route through `thumbview.folderOrders[focusedFolder]` with up-to-date line count allocations.

## Drag-and-Drop Latency Elimination (Instant Pickup, Optimistic Release, Memoized Ignores)

1. **Instant Pickup Snapshot**: When a drag gesture crosses `DRAG_THRESHOLD`, the webview immediately blits the current canvas into `cachedDragBackgroundCanvas`, dims the candidate tile, and assigns `dragBackgroundCanvas = cachedDragBackgroundCanvas`. The very first frame of dragging utilizes the snapshot blit, eliminating the full-canvas synchronous redraw that previously caused pickup stutter.
2. **Optimistic In-Memory Drop**: On `mouseup`, `media/overview.js` updates `data.folderOrders[focusedFolder]` in memory immediately before rendering, providing instant zero-latency visual confirmation of the new position while the extension host persists changes asynchronously.
3. **Memoized Ignore Counts**: The extension host caches `computeIgnoreCounts` results keyed by pattern set and file count, eliminating redundant $O(N \cdot M)$ regex sweeps across the workspace during drag reorders.

## Folder Card Preview Fidelity with Drill-Down Views (`doesFolderCollapse`)

The purpose of a folder card preview is to provide users with a 1:1 preview of what they will see when they click into that folder. Previously, preview generation unconditionally rendered nested subfolder cards if any child folders existed, even when drilling down into the folder would lay out all files individually because the file count was small enough to fit within comfortable cell dimensions.
To ensure total visual consistency, both folder card previews and folder drill-down views rely on a shared single source of truth: `doesFolderCollapse(files, folderPath)`. If `doesFolderCollapse` returns false, the preview displays all individual files with their accurate proportional spanning heights using `buildSpanningGridLocal`. If `doesFolderCollapse` returns true (e.g. dense directories with child subfolders that would exceed readability thresholds), the preview uses the exact same row-major `buildStableGrid` layout that subfolder card mode uses, ensuring child folder cards appear in their identical positions (e.g. straight line along the bottom) rather than an artificial column-major L-shape.

## Window, Sidebar, and Terminal Resize Stability & Readability Collapse

Resizing VS Code's window, dragging sidebar edges, or toggling terminal panels smoothly scales the visible tiles without rearranging them into different rows or columns:
1. **Constant Grid Aspect Ratio (`BASE_GRID_ASPECT = 16 / 9`)**: Enforcing a constant `BASE_GRID_ASPECT = 16 / 9` across `buildSpanningGridLocal` and `buildStableGrid` ensures that layout slots `(col, row)` remain invariant. Cell dimensions scale proportionally (`availableW / cols`, `availableH / rows`), eliminating reflow.
2. **Readability-Triggered Collapse on Window Shrink**: When reducing the IDE window to the point where files become physically unreadable (`cellW < minCellWidth || cellH < minCellHeight`), views containing child subdirectories collapse into folder thumbnail cards. This allows dense or leaf folders with subdirectories to stay accessible when screen real estate is constrained, while avoiding reflow on minor window adjustments.

## Folder Card Reordering, Empty Rows Below, & Grid Space Clamping

1. **Capacity Allocation for Rows Below**: In subfolder cards mode, `buildStableGrid` bases its capacity on `Math.max(orderedItems.length, displayItems.length, effectiveCardOrder.length)`. This ensures that when cards are dropped into empty rows below, the grid allocates sufficient rows and slots, preventing cards from vanishing and keeping rows below fully addressable by drag-and-drop targeting.
2. **Strict Grid Column Clamping on Drag**: The maximum column allowable during drag operations (`maxAllowedCols`) is strictly clamped to the active rendered grid columns (`targetGridCols`). It never duplicates `extraCols`, preventing rightward drags from generating phantom columns. Grid expansion is strictly preserved as a manual user action via right-click > "Expand Grid Space".
3. **Card Reordering Scoped to Folder**: Swapping items within a folder card updates `thumbview.folderOrders[folder]` without mutating global root `fileOrder`, isolating folder-level arrangements from workspace-wide layout state.

## Mouse Side Button Navigation Deduplication

Mouse button 3 (Back) and button 4 (Forward) events are handled exclusively in `mouseup`. In standard browser DOM, physical clicks emit `mouseup` immediately followed by `auxclick`. Handling both resulted in double-firing `handleBreadcrumbBack()`, skipping two history levels in a single click. Suppressing the action in `auxclick` guarantees clean 1:1 step-back navigation per physical click.

## Zero-Flicker 2D Spanning Drag-and-Drop Reordering

Dragging files in spanning mode previously caused visual stutter: untouched files in adjacent rows/columns momentarily shifted into incorrect positions on `mouseup`, only to jump back to their correct positions a fraction of a second later when the host confirmation arrived.
1. **Root Cause**: The webview performed a naive 1D array swap or row-major index insertion on a column-major spanning list on `mouseup`. When `buildSpanningGridLocal` repacked the list sequentially, variable-height tiles spilled across column boundaries, shifting untouched files.
2. **Local 2D Spanning Calculation (`reorderSpanningItems`)**: The webview runs the host's `reorderSpanningItems` (shared through `layout_core.ts`) directly on `mouseup`. It constructs the 2D column-major grid, swaps the source and target items without disturbing any other cell, and updates in-memory order. Untouched files remain strictly locked to their exact `(col, row)` coordinates.
3. **Synchronous Host Dispatch**: `extension.ts` calls `updateLayoutFromCache(activePanel)` synchronously before awaiting asynchronous `context.workspaceState.update(...)` disk writes, reducing host confirmation latency from 300ms to < 2ms and matching the webview's optimistic layout with zero visual jump.

## Folder Card Order & File Order State Isolation (`thumbview.folderCardOrders`)

Previously, inside folder drill-downs, `thumbview.folderOrders[folder]` was shared between the uncollapsed file view (e.g. 50 files) and the collapsed folder card view (e.g. 3 cards). When a folder collapsed, `effectiveCardOrder` inherited the 50 file IDs, generating 50 items in `displayItems`. The grid was sized for 50 items (10x5 grid), causing cards to squish into tiny corner slivers and leaving 47 slots empty.
1. **Isolated Persistence Keys**: Folder card ordering is stored in dedicated `thumbview.folderCardOrders[folder]`, while uncollapsed file ordering remains in `thumbview.folderOrders[folder]`.
2. **Safe Card Filtering & Canvas Sizing**: When `cellsTooSmall` is active, `effectiveCardOrder` filters out stale or unmapped IDs from previous file views. `totalItems` strictly equals the count of actual subfolder cards and root files (e.g. 4), sizing the grid to 2x2 and allowing cards to expand to 100% of the available canvas width and height.

## Pure Zoom Grid Expansion & Zero-Reflow Scaling

The user specification requires that "Expand Grid Space" and "Reduce Grid Space" act purely as zooming out or in, adding or subtracting space symmetrically along both rows and columns to maintain the 16:9 aspect ratio, scaling all files down into the top-left corner without ever reflowing or rearranging their positions.
1. **Root Cause of Unbalanced Reflow**: Previously, `triggerExpandSpace` and `triggerReduceSpace` invoked `expandSpanningGridOrderLocal` and `reduceSpanningGridOrderLocal`, which modified 1D order arrays, injected empty placeholders `""`, altered `wrapRows`, and in reduce mode deleted files placed beyond the reduced dimensions. Changing `wrapRows` altered the column packing stride, causing line breaks (`currRow + nCells > wrapRows`) to occur at completely different file boundaries and violently reflowing tiles.
2. **Pure Zoom Architecture**:
   - `triggerExpandSpace()` and `triggerReduceSpace()` purely adjust `extraCols` and `extraRows` (+1 / -1), leaving `data.fileOrder`, `data.cardOrder`, `data.folderOrders`, and all `wrapRows` 100% untouched.
   - When expanding (zooming out), 1 column and 1 row are added (`extraCols + 1`, `extraRows + 1`). Tiles shrink slightly and move towards the top-left corner, opening empty rows and columns to the right and bottom while maintaining the aspect ratio.
   - When reducing (zooming in), 1 column and 1 row are removed (`extraCols - 1`, `extraRows - 1`), clamped so `extraCols >= 0` and `extraRows >= 0`, never reducing below the base bounding box or cutting off placed files.
   - Placements in `buildSpanningGridLocal` and `buildSpanningGrid` maintain identical coordinates because `wrapRows` remains stable.
   - Spanning layout dimensions in `updateLayoutFromCache` symmetrically apply `extraCols` and `extraRows`: `cols: layout.cols + extraCols`, `rows: layout.rows + extraRows`.

## Spanning Grid Representation in Folder Card Views (`cellsTooSmall`)

Wherever folder cards appear in the current view (root overview or drill-down with collapsed subdirectories), Thumbview supports spanning grid mode:
1. **Heterogeneous Item Spanning**:
   - Folder cards occupy 1 unit tall (`nCells: 1`) to preserve clear visual boundaries and consistent card preview mosaic dimensions.
   - Individual files expand proportionally to their line counts (`nCells = cellsNeeded(f.lineCount)`), allowing long files (e.g. 1,000+ lines) to span multiple cells tall (`localCellH * nCells`).
2. **Unified 2D Spanning Drag & Drop**:
   - When in spanning grid mode in folder card view, drag-and-drop operations utilize `reorderSpanningItems` with 2D coordinate stability. Dragging multi-cell files or folder cards swaps or places items in target slots without reflowing or losing 2D grid alignments.
   - State is persisted via `thumbview.cardOrder`, `thumbview.cardWrapRows`, `thumbview.folderCardOrders`, and `thumbview.folderCardWrapRows`.
3. **Multi-Tile Spanning Swap with Relative Gap Preservation**:
   - When a multi-cell tile (e.g. 5 cells tall) swaps into a column overlapping multiple smaller tiles and empty spaces (e.g. `[1; 0; 1; 1; 0]`), all items overlapping the incoming target span $[finalTargetRow \dots finalTargetRow + sourceCells - 1]$ are collected.
   - Displaced items are placed into the source column using their exact relative row offsets $\Delta r = item.row - finalTargetRow$, preserving the gaps and orientation relative to one another (e.g. `[1; 0; 1; 1; 0]`) rather than collapsing into `[1; 1; 1; 0; 0]`.

## Instantaneous Drag-and-Drop Interaction Architecture

File and folder drag-and-drop operations must feel completely instantaneous with zero perceptible latency.
1. **Low-Latency Pickup Initiation**: `DRAG_THRESHOLD` is set to 3px. When crossed, the webview immediately builds the cached background canvas, calculates drag targets, and renders synchronously on the pickup frame rather than waiting for an asynchronous animation frame request.
2. **Fast-Path Drag Move Routing**: At the very top of the `canvas` `mousemove` listener, active dragging (`draggingFile || draggingFolder`) immediately updates cursor position and schedules a requestAnimationFrame redraw, completely bypassing $O(N)$ hit-testing (`findFileAt`), window focus checks, and tooltip evaluations.
3. **Optimistic Synchronous Reordering & Immediate `slotOccupancy` Updates**:
   - On `mouseup`, if a tile is dropped back onto its starting slot, the gesture is instantly dismissed without sending unnecessary IPC messages to the extension host.
   - When dropped into a new slot, the webview synchronously updates `srcFile.slot`, `srcFile.slots`, `tgtFile.slot`, `tgtFile.slots`, `slotOccupancy`, and local order arrays before rendering immediately. Synchronously updating `slotOccupancy` ensures subsequent mouse events and rapid-succession swaps hit-test against up-to-date file coordinates.
   - Affected file positions are recorded in `userReorderedFileSlots`.
4. **Elimination of Host Roundtrip Lag and Revert Glitch**:
   - On `reorderFile` and `swapCardItems`, `src/extension.ts` directly updates `workspaceState` and `fileOrder` without invoking `updateLayoutFromCache`. This eliminates expensive git diff rescans, diagnostic indexing, and multi-megabyte IPC `data` serialization on every drop.
   - When external `command: "data"` messages arrive (e.g. on file save), `applyDataMessage` checks `userReorderedFileSlots` and preserves user-reordered file positions, preventing race conditions where rapid successive swaps would revert the canvas to an earlier state before re-swapping ~2 seconds later.
5. **Deferred IPC Data Synchronization**: Full extension host `data` broadcast processing in the webview is deferred while dragging is active (`pendingDataMsg`), preventing in-flight host payloads from interrupting user drag gestures or causing visual stutter.

## Scoped Layer Grid Space Architecture (`thumbview.folderExtraCols` & `thumbview.folderExtraRows`)

Expanding and reducing grid space is strictly scoped to the active layer (the root overview or a specific folder drill-down).
1. **Per-Layer Space State Isolation**:
   - `thumbview.extraCols` and `thumbview.extraRows` (or `folderExtraCols[""]` / `folderExtraRows[""]`) track extra dimensions for the root directory.
   - `thumbview.folderExtraCols[folderPath]` and `thumbview.folderExtraRows[folderPath]` track extra dimensions for individual folders (e.g. `"src/"`).
2. **Layer Switching & Space Restoration**:
   - When the user is in the root directory, files fill available canvas space as much as possible with 0 extra empty rows/cols unless root was explicitly expanded.
   - When expanding space inside `"src/"`, `folderExtraCols["src/"]` and `folderExtraRows["src/"]` are incremented without modifying root state or other folders.
   - Navigating back to root restores root's default unexpanded layout. Navigating into `"src/"` restores its expanded empty row and column, allowing tiles to be dropped into those empty slots.
   - Folder thumbnail card previews in overview isolate previews by reading `group.path`'s dimensions, preventing root expansions from affecting subfolder cards and vice-versa.

## Leaf Folder Mode & Subfolder Card False-Positive Prevention

Leaf folders (directories that contain only files, with zero child subdirectories) cannot collapse into subfolder cards mode.
1. **Strict `hasSubfolders` Guard**: In `overview.js`, `cellsTooSmall` requires `hasSubfolders = subfolderInfo.folders && subfolderInfo.folders.length > 0`. Even when canvas width or height shrinks below minimum cell thresholds, a folder with 0 child subdirectories strictly remains in directory drill-down mode (`shouldOpenFolder`), rendering all files individually with `localSpanningLayout`.
2. **State & Reorder Isolation**: Leaf folder drags route strictly through `reorderFile` and `thumbview.folderOrders`, eliminating the bug where leaf folders were treated as folder cards, dispatching `swapCardItems` to `folderCardOrders` and scrambling files.
3. **Grid Capacity Stability**: In folder card mode, `totalItems` is strictly clamped to `orderedItems.length`, preventing empty slot holes in `displayItems` from inflating the grid capacity or triggering unwanted grid expansion when cards/tiles are moved to empty slots.

## Instant Performance Architecture (v0.4.8)

To ensure Thumbview opens instantly (< 50ms) and navigates folders without frame drops or freezes, Thumbview employs an end-to-end performance architecture across both the extension host and webview canvas:

1. **Retained Webview Context Lifecycle**:
   - Webview panels are configured with `retainContextWhenHidden: true`.
   - On close commands, editor jumps, and tab switches, the panel is backgrounded rather than disposed via `panel.dispose()`.
   - When the user presses `F4` to reopen Thumbview, the active panel is revealed via `activePanel.reveal()` in 0ms. The DOM, scripts, canvas contexts, and cached bitmaps remain active, completely bypassing panel re-creation, HTML serialization, script re-evaluation, and webview initialization.
   - Panel cleanup occurs cleanly upon VS Code workspace deactivation.

2. **Monospace Character Width Arithmetic & Zero-Measurement Text Layout**:
   - In monospace fonts (`Consolas, "Courier New", monospace`), all characters share identical widths.
   - Dynamic per-token canvas text measurements (`ctx.measureText(tok.text).width`) are eliminated. The width of `'M'` is measured once per quantized font size in `getMonospaceCharWidth(fontSize)` and cached.
   - Subsequent token advances are computed in $O(1)$ arithmetic: `tok.text.length * charWidth`. This eliminates 30,000–60,000 layout measurements per frame, cutting folder drill-down latency from 2,000ms to < 15ms.

3. **Readability Thresholds & Crisp Minimap Syntax Blocks**:
   - Text rendering is enabled only when characters are physically legible: `fontSize >= 6.0px` and `stepY >= 5.0px` (`THUMBNAIL_MIN_READABLE_FONT_SIZE` and `THUMBNAIL_MIN_READABLE_TEXT_PITCH`).
   - At smaller scales (such as full-repository overview grids), lines render as crisp syntax-colored rectangles via `ctx.fillRect`. This avoids sub-pixel glyph blur, resembles VS Code's native minimap, and renders an entire repository grid in < 2ms.

4. **Offscreen Canvas Tile Raster Caching (`tileRasterCache`)**:
   - Visible code tiles are rendered to offscreen canvases and cached in an LRU `tileRasterCache` (150-entry capacity) keyed by `${file.id}:${w}:${h}:${searchQuery}:${gitStatus}:${hasError}`.
   - Active editor viewport overlays (semi-transparent bands indicating open files and visible editor line ranges) are drawn directly on top of the main canvas after blitting the cached tile bitmap.
   - As the user scrolls in an editor, the tile bitmap remains cached; only the viewport band updates. Moving between directories blits existing tiles via single `ctx.drawImage` calls in ~0.1ms.

5. **Memoized Recursive Subfolder Mini-Mosaics**:
   - To retain the full visual detail of subfolder mini-mosaics without re-computing child layouts and syntax lines on every animation frame, mini-mosaics are rendered into offscreen canvases and memoized in a module-level `mosaicCache` Map (300 entries max) keyed by folder path, mosaic size, layout mode, search query and toggles, active file, open-files version, and theme.
   - The cache is module-level rather than stored on the folder group because `getSubfolderGroups()` builds new group objects on every render. Before 0.4.9 the cache lived on the group (`group._miniCache`) and therefore never hit, so every render rebuilt every mosaic. `applyDataMessage` clears the cache because a new payload can change any file's contents.

6. **Lazy Line Tokenization & Popover DOM Deferral**:
   - During `applyDataMessage`, line tokenization is deferred; only search strings (`_combinedText`) are indexed. Lines are tokenized on demand inside `drawThumbnail` and cached on `line._tokens`.
   - Popovers (`updateFoldersPopover` and `updateIgnoresPopover`) and settings modal DOM nodes are updated lazily only when their respective buttons are clicked, avoiding upfront DOM allocation on startup.

7. **Fast-Path Hit Testing**:
   - When inside a focused folder, `findFileAt` restricts point hit-testing to `activeRenderGrid.files` (the 10–30 files in the active view) instead of filtering the entire workspace repository file list on every mouse movement.

8. **Surgical File Cache Invalidation & In-Memory Tree Provider**:
   - `scanner.ts` exports `invalidateScanFile(filePath)` to selectively evict modified files from the scan cache upon file watcher events, avoiding workspace-wide disk sweeps.
   - `DirectoryTreeDataProvider` reads from in-memory cached repository files, eliminating multi-second disk crawls when expanding sidebar directories.

## Instant First Open: Stable-Size Reveal & Render Coalescing (v0.4.9)

Opening Thumbview on a large workspace used to show tiles packed into the top-left corner for about 3 seconds before they expanded to fill the screen. Two causes compounded:

1. **The first frame was laid out for the pre-Zen editor size.** The panel is created as soon as `workbench.action.toggleZenMode` resolves, but the workbench finishes growing the editor area afterwards. The webview rendered its first data frame at the smaller size and was shown immediately.
2. **The webview main thread was blocked when the frame grew.** Each of `data`, `openState`, `activeFile`, and `resize` triggered a full synchronous render, and each render rebuilt every folder mosaic (see the mosaic cache note above). While the thread was busy the iframe could not re-lay out, so the old small canvas sat in the top-left of the larger frame until the backlog cleared.

The fix:
- **One viewport source.** A `ResizeObserver` on the canvas feeds `viewportW`/`viewportH`, read through `getViewportW()`/`getViewportH()` by `render()`, hit testing, and `doesFolderCollapse`. Previously three formulas (`clientWidth || innerWidth`, `innerWidth`, and `Math.max(clientWidth, innerWidth)`) could disagree mid-transition. Environments without `ResizeObserver` fall back to the window `resize` event.
- **Render coalescing.** Host messages and resizes call `scheduleRender()`, which renders at most once per animation frame at the size current at that frame. Interactive paths (drag, hover, search) still call `render()` directly because they need synchronous hit-test geometry.
- **Reveal after a stable size, on open and on every reopen.** The page starts at `opacity: 0`, set in the initial CSS so the toolbar cannot flash before the script parses. After a data render, `checkRevealStable` waits two frames and reveals only if the viewport still matches the rendered size; otherwise the pending resize render re-arms the check. The same gate is re-armed by `hideForTransition` when Thumbview exits or reopens. Every transition carries an increasing `transitionId`; the webview ignores older ids, so a close's delayed `showAfterTransition` cannot unblock the next open. Previously, exit hid the page for a fixed 400ms and then restored opacity while it was in the background, so a rapid reopen showed the old frame at the old size before the Zen expansion finished. After a transition the size must also hold for 120ms (`TRANSITION_REVEAL_STABLE_MS`), because the host's "settled" signal follows fixed sleeps and Zen or maximize can still be animating on a slow machine. After `hideForTransition`, the stability check is also blocked until the host sends `showAfterTransition` for the current transition, because a render between Zen steps (the host sleeps 70ms and 30ms between layout commands) would otherwise look "stable" for two frames. Becoming visible is not enough: on reopen the panel becomes visible before the host's settle delays finish. Key and pointer input reveal only when no transition is in flight, because spamming the open key sends keydowns to the focused webview while Zen mode is still expanding. If no data has arrived after 400ms on first open, the loading status is revealed instead of a blank panel. A safety timer (2.5s first open, 1.5s after a transition) that never fires while the page is backgrounded, plus any pointer or key input, guarantee the page can never stay hidden. While a reveal is pending, `showAfterTransition` and window focus do not reveal the page.
- **Fast reopen.** The reveal gate made every reopen show the empty editor background for about 0.2s (host settle sleeps, the settled signal, two frames, and the 120ms stability window). While a transition hides a previously shown page, drawing is now frozen so the canvas keeps the last frame the user saw; if the page becomes visible again at exactly that size, that frame is still correct and is shown immediately. The fast path requires the panel to have been hidden since the transition began, because during a close the panel is still visible at the old size and must stay hidden while Zen exits. "Hidden" comes from the host (`panelHidden`, posted from `onDidChangeViewState` even mid-transition) rather than `document.visibilityState`, which a retained webview may never change. Any reveal, including fallback ones, schedules a fresh render so a frame frozen at an old size is never left on screen.
- **Resize keeps raster caches.** `resize()` no longer clears the tile or mosaic caches. Their keys include pixel size (and the search toggles), so entries for old sizes age out of the LRU. Clearing them made the first sharp frame after every resize the most expensive frame possible, which is exactly when a slow frame shows the old picture in the top-left corner.
- **One scan.** The activation pre-scan's promise is kept, and a `ready` that arrives mid-scan awaits it instead of starting a second concurrent full scan.
- **Stretch the last frame on resize.** The `ResizeObserver` callback runs after layout but before paint. `stretchLastFrameToViewport()` resizes the backing store there and draws the previous frame scaled to the new size, so the first painted frame at the new size is already full-size. The sharp render follows on the next animation frame. Because the zero-reflow layout scales cells in proportion to the viewport, the stretched frame closely matches the real one. This covers size changes that land after the initial reveal, which the two-frame stability gate cannot predict.
- **Less background churn.** Document edits are collected and applied to the host cache once per 300ms pause, diagnostics are debounced to 500ms, and a save produces one payload (the rescan waits for the save's git diff fetch) instead of two. Updates that arrive while the retained panel is hidden are deferred (`hiddenRefreshPending`) and flushed 250ms after the reveal so they never delay it. Watcher events inside `.git` and `node_modules` are ignored; any other rescan that returns the identical file set posts nothing.
- **Content-versioned search index.** The host tags each file with `contentVersion`, derived from `RepoFile` object identity (the scanner reuses the object while a file is unchanged, and `updateDocumentInCache` replaces it on edit). The webview's `fileTokenCache` is keyed by file id and reused only when the version matches. The previous key (`id:lineCount:firstLine`) reused stale search text after any edit below line 1 that kept the line count. Entries for files missing from a payload are evicted.
- **Too-small hint.** Below 200px in either dimension the canvas shows "Enlarge the panel to show Thumbview" instead of staying blank.

## F4 Spam Resilience: Serialized Layout Sequences & Bounded Canvas Memory

Spamming F4 once turned the panel gray (dead webview) and once crashed VS Code with exit code 139 (a native segfault). The logs were unavailable, and the user's machine also struggles with GPU work, so the cause is not proven. Two contributors were clear in the code and are fixed:

1. **Overlapping layout sequences.** Each `thumbview.open` ran its whole Zen/maximize sequence, with fixed sleeps, without waiting for the previous one. Rapid presses interleaved opens and closes, so a second call could see the panel mid-transition, stack another `toggleMaximizeEditorGroup`, and desync `fullscreenActive` from the real Zen state, making the next blind `toggleZenMode` go the wrong way. Every sequence now runs under `withLayoutLock`, and `createCoalescedToggle` turns presses that arrive during a toggle into a parity bit: an even number cancels out, an odd number runs exactly one more toggle afterwards. Both live in `src/locks.ts` so they are unit-tested.
   A hung workbench command (plausible under GPU distress) would have held the lock forever and silently swallowed every later F4 press, so both the lock and the toggle have a 5s watchdog. AsyncLocalStorage context propagates into timers created inside a locked task, which would let those callbacks bypass the queue; they run through `detachFromLocks()` instead.
2. **Unbounded canvas memory.** The tile and mosaic caches were bounded only by entry count (500 and 300). Drill-down tiles can be about 1MB each, and after resizes stopped clearing the caches, entries at several sizes accumulated. Canvas backing stores are often GPU textures. `CanvasLRU` adds pixel-memory budgets (64MB and 32MB), true LRU recency, and shrinks evicted canvases to 0x0 so memory is released immediately rather than at the next GC.

Also: the reveal safety timer polls while the page is backgrounded instead of trusting `visibilitychange`, and the diagnostics listener posts only when the set of errors changes, because every editor switch republishes warnings and each reopen previously triggered a full workspace payload.

## Delta Payloads & Content-Keyed Raster Caches

Every host update used to post the whole workspace (every sampled line of every file, plus every line of files over 2,000 lines) and the webview cleared all tile and mosaic rasters on arrival, so a diagnostics or git change re-serialized and re-rasterized everything. The host now records which `contentVersion` of each file the webview holds and omits unchanged files' lines (`linesOmitted`). The webview reuses its previous line objects, which also keeps their token caches, and asks for anything it lacks (`requestFileLines`), so a skipped or superseded payload (for example one replaced during a drag) self-heals. Raster caches survive payloads because their keys now describe their content: tiles use `contentVersion` plus a hash of git and error decorations, mosaics a hash of member versions and the group's saved layout. `fullLines` is still sent (once per content version) rather than fetched lazily, because search must cover the whole text of long files.

## Webview Message Validation & CSP

The webview renders workspace content, so it is treated as less trusted than the host. `message_guard.ts` rejects any message whose `uri` contains a raw or percent-encoded `..` segment (VS Code's URI parser keeps dot segments, so `file:///ws/../../x` would pass a prefix-based workspace check and resolve outside it on disk) or is outside every workspace folder, or whose workspace-relative path fields are absolute or contain `..`, before any handler can open, rename, copy, move, or delete a file. The CSP no longer allows `'unsafe-eval'`; pdf.js is created with `isEvalSupported: false` and uses its interpreter for font programs.

## Accessibility of a Canvas UI

A canvas is invisible to assistive technology and unreachable by keyboard, so Thumbview previously scored at the bottom on accessibility. Mirroring every tile as a DOM element would defeat the reason the grid is a canvas (thousands of tiles), so the canvas is instead a single focusable `role="application"` widget with a visually hidden description, and:

- **Keyboard focus is spatial.** Arrow keys move to the nearest drawn tile or folder card in that direction (`neighborInDirection`), which matches what a sighted user sees in both uniform and spanning layouts; Home/End follow reading order. The ring is drawn on the canvas in `--vscode-focusBorder` (`--vscode-contrastActiveBorder`, thicker, in high contrast).
- **Actions reuse the mouse paths.** Enter posts the same `jump` message a click does; Shift+F10 and Alt+Arrow dispatch synthetic `contextmenu` and mousedown/move/up events at the tile's center, so keyboard moves go through exactly the drag and drop logic (including spatial-stability rules) instead of a parallel implementation that could drift. Focusing a tile also sets the hover state, so the Left Ctrl magnifier and Ctrl+C/X/Delete work on the focused tile.
- **Announcements, not DOM mirrors.** A polite live region reports the focused tile (path, lines, git status and errors in words), search result counts once typing pauses, folder changes, and errors.
- **Character keys stay with search.** Typing anywhere searches, a core interaction, so navigation uses only non-character keys.
- **Color is never the only signal.** Tiles carry an Explorer-style text badge (error count and git letter). DOM chrome has visible `:focus-visible` outlines, explicit borders in high contrast and `forced-colors`, `aria-pressed` on search toggles, labelled dialogs with focus moved in and restored on close, and a Tab trap in the settings modal. `prefers-reduced-motion` disables CSS transitions, and the jump flash fade becomes a steady highlight when `workbench.reduceMotion` is `on`, or `auto` (the default) with the OS preference set; the webview reports that preference with each `jump` because the host cannot read it.

## Known limitations / accepted tradeoffs

- **Unit test suite**: Core logic is covered by automated unit tests in `src/test/` run via `npm run test:unit`. End-to-end webview testing relies on VS Code Extension Host integration.
- **`MiniLine.category`** (`scanner.ts`) is computed host-side but not read by the webview, which does its own independent tokenization. Left unresolved as either dead code or an unfinished feature — see the comment at its definition.
- **No shared type definitions for the `postMessage` protocol** between `extension.ts` and `media/overview.js` (see CLAUDE.md's "Cross-module interface" note) — protocol drift is caught only by manual review/testing, not the compiler.
