# Change Log

All notable changes to the "thumbview" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.6] - 2026-10-06

### Added
- **Sequential study participant ID allocation**: enrolled participants are assigned a sequential ID (starting from `P-101`) directly from the `precision.usask.ca` telemetry database to paste into demographic and exit surveys.
- **Precision database telemetry inspection CLI**: added `view_data.sh` script to quickly inspect summary counts, participant rosters, recent episodes, and Nginx client IPs on `precision.usask.ca`.

### Changed
- **Read-only participant ID in Thumbview settings**: participant IDs are locked to read-only in the UI with a single-click Copy button to prevent ID collisions and survey data contamination. Removed manual ID override commands.
- **Backwards-compatible participant ID schema**: PostgreSQL schema migrations now support generic text participant IDs (`P-xxx`, UUIDs, legacy `auto-*`), with automated sequence alignment past existing numeric IDs.

## [0.5.5] - 2026-10-06

### Added
- **Study participant ID configuration in settings**: enter or update your study participant ID directly from the Thumbview Settings modal (`actions-modal`), and quickly open study status or review the consent form.

### Fixed
- **Settings modal scroll clipping**: dialog box sizing and max-height constraints now use `box-sizing: border-box` and adjusted padding so the scroll container never overflows the modal frame, allowing the bottom `thumbview-issues` link to be fully visible and reachable across all viewport sizes.
- **Consent form code block contrast**: fixed syntax block contrast in the informed consent document for dark and light theme readability.

## [0.5.4] - 2026-10-06

### Changed
- **Research study telemetry server and schema v2**: migrated study telemetry backend to a dedicated Canadian server (`precision.usask.ca` at the University of Saskatchewan) with an updated relational schema for research data governance. Telemetry metrics now use typed, direct spatial and navigation indicators (`time_to_target_ms`, `reaction_time_ms`, `slot_col`, `slot_row`, `target_position_changed`).

## [0.5.3] - 2026-10-05

### Added
- **Mouse wheel stepping between search results**: when holding `Ctrl` over a file with multiple search matches, rolling the mouse wheel steps directly between results (`MATCH 1 of N` → `MATCH 2 of N`...), while rolling past the boundaries scrolls through surrounding lines. `Shift`+wheel scrolls surrounding lines directly.
- **Research study enrollment on first open**: prompts users on first open via a modal dialog to participate in spatial navigation telemetry, with one-click enablement if VS Code telemetry is off.

### Fixed
- **Hover search snapping in files with large match sets**: in files with 100+ matches, target hit areas are dynamically bounded within the thumbnail using a forward-backward squeeze distribution, so moving the cursor to the end of the file reaches the very last match instead of being stuck at Match 16.
- **Adaptive snap hysteresis and wheel stability**: snap hysteresis scales with match density so intermediate matches are easily reachable without skipping, and mouse micro-movements during active wheel rolling no longer disrupt match stepping.

## [0.5.2] - 2026-10-01

### Added
- **Opt-in research study on spatial code navigation**: participate to help evaluate code maps for an academic study (see `STUDY.md`). Telemetry is strictly opt-in, pseudonymous, and never collects code, file names, or search queries.
- **Hovering a tile outlines it** and shows a pointer cursor, so you can see which file `Ctrl+C`, `Ctrl+X`, `Delete`, `F2`, and `Ctrl+Enter` will act on.
- **From search to the results without the mouse.** `Enter` in the search box opens the first match; `↓` moves to it, and the arrow keys then move between matches only.
- **`F2` renames and `Ctrl+Enter` (`⌘Enter` on macOS) opens to the side**, as the context menu always claimed.
- **Raising `thumbview.autoIgnoreThreshold` shows folders it had hidden** that no longer exceed it (0 shows all of them). Your own ignores are never touched.
- **A chip says when folders were auto-hidden** ("3 folders auto-hidden"), so a folder that disappeared on the first open is never a mystery. Click it to review them in Folders & Ignored, or close it.
- **A one-time hint after installing** tells you to press `F4`.
- **Better syntax colors** for Go, Rust, Java, C#, C and C++, Kotlin, Swift, PHP, shell, YAML, TOML, Ruby, Julia, Dockerfiles, Makefiles, SQL, Lua, Haskell, OCaml, F#, Clojure and other Lisps, Erlang, LaTeX, and Visual Basic (comments, strings, and keywords).
- **The context menu works from the keyboard**: `Shift+F10` opens it on the focused tile, the arrow keys move, `Enter` runs an item, and `Escape` closes it.
- **`Ctrl+F` (`⌘F`) jumps to the search box**, and in folder-card view `Enter` and `↓` from search reach the folder that holds the match.
- **Screen readers hear where a tile is** (its column and its place in the column).

### Changed
- **Opening a folder paints immediately.** Tiles that are not ready yet show an outline of their code for a moment instead of holding up the whole view (in our benchmark, about 20 ms instead of 130 ms to the first picture), and resting the pointer on a folder card prepares its files.
- **PDF previews render off the main thread** with pdf.js 6, so they never make Thumbview stutter.
- **`F4` in your own Zen mode** opens Thumbview inside it and leaves Zen mode on when Thumbview closes.
- **Less work in the background.** Typing while Thumbview is hidden no longer updates its copy of the file until you open it again, and windows where Thumbview was never opened ignore file and diagnostics events entirely.
- **The context menu lists only shortcuts that work.**
- **Auto-ignoring folders no longer shows a notification**; the in-grid chip replaces it.
- **Commands appear under the "Thumbview" category** in the Command Palette and Keyboard Shortcuts, and the tile-size and auto-ignore settings have valid ranges.

### Fixed
- **PDF previews render in VS Code.** The PDF renderer used a JavaScript feature that VS Code's built-in browser does not have yet, so every preview failed; Thumbview now ships the renderer's build for older browsers.
- **Dragging tiles of different heights swaps exactly what you expect.** The tile you drag and the same-height block of cells where you drop it (files and empty space alike) trade places, and nothing else moves. Earlier, a tall tile could be drawn over others, untouched tiles could move, and the arrangement could change again when the next update arrived.
- **A two-tall tile moves down by one row** when you drag it one row; it used to need the cursor two rows down because the drop followed the cursor instead of the tile's top edge.
- **Dropping on empty space below a file that grew** puts the tile exactly there and moves nothing else.
- **Reduce Grid Space never turns the grid into folder cards.**
- **The first move after Reflow Layout no longer adds an empty row** at the bottom of the grid.
- **Adding files never changes how tall the columns are**, so it never moves existing tiles (Reflow Layout resets column height).
- **Your arrangement survives restarting VS Code.** Every empty slot you left by dragging tiles came back closed after a restart, shifting the tiles after it; the saved layout is now restored exactly.
- **Swapping tiles of different heights no longer moves unrelated tiles.** A tall tile displaced by a short one could overwrite tiles below it, which then reappeared in the far-right column or overlapped other tiles. Displaced tiles now go only to free space, and every other tile stays where it is.
- **New files no longer fill empty slots you left on purpose** inside folders.
- **Expanding the grid space or a file growing never turns the grid into folder cards.** Only adding files can; and views fall into folder cards less readily (the default minimum tile size is now 40 x 28 px, was 60 x 40).
- **PDF previews**: if a file's text never finishes streaming, PDF previews load anyway after 3 seconds, and any PDF preview failure is written to **View > Output > Thumbview** with its reason.
- **Moving the last tile, or dragging a folder card into empty space, no longer shrinks the grid** and shifts every other tile.
- **New files in a folder no longer fill gaps you left on purpose** when you drag a tile in that folder.
- **`.npmrc`, `.bashrc`, and other `rc` files** are no longer colored as JSON, and neither are source files with "json" in their name (such as `json_utils.py`).
- **Closing a file without saving it no longer leaves the discarded edits on its tile.**
- **Resizing Thumbview no longer flashes simplified tiles**; tiles keep their picture, scaled, until the sharp one is drawn.

### Security
- **pdf.js updated from 3.11 to 6.3**, which fixes CVE-2024-4367 (Thumbview was not exposed: it already disabled the affected code path).
- **Rename, delete, move, copy, and new-file commands check real paths**, so a symlinked folder inside the workspace that points elsewhere cannot be used to change files outside it.
- **Layout orders sent by the page are validated** before they are saved.

## [0.5.1] - 2026-09-30

### Changed
- **Readable text in Thumbview tiles.** Short or spacious files render readable text (at 8px to 13px font size) budgeted up to 80 characters of line width. Denser files, smaller tiles, and single-line minified files (such as source maps or bundles) cleanly transition to crisp syntax-colored minimap rectangles when text would fall below the 8px readability threshold.
- **Saving no longer makes Thumbview rescan your workspace.** A save or an outside edit re-reads just that file; only creating or deleting files lists the workspace again. Build output that Thumbview does not show (such as a gitignored `out/`) no longer causes any work.
- **Nothing runs in the background for a hidden Thumbview.** Git markers refresh only while Thumbview is visible, or once when you reopen it, including after commits and branch switches.
- **The first F4 is instant.** In workspaces where you have used Thumbview, it scans a few seconds after VS Code starts, instead of on the first F4. Workspaces where you never open Thumbview are never scanned.
- **Faster typing and search in large workspaces.** Search keystrokes are about 4 to 7 times faster (search highlights no longer force tiles and folder previews to redraw), layout state is written only when it changes, and ignore rules are compiled once per scan.
- **Large workspaces open faster.** Thumbview shows the full grid right away and fills in file contents over the next moment, instead of waiting for every file's text (the first message at 10,000 files went from about 70 MB to 8 MB). Tiles never move while contents arrive.
- **Less memory.** Extra copies of file text for Match Case and regex search are made only when you use those options.
- **Your `.gitignore` is no longer copied into Thumbview's ignore list.** Git already applies it; copies from earlier versions are removed once. Without git (Restricted Mode, remote or virtual folders), each folder's root `.gitignore` is still applied.
- **Commands that only work from a tree item are hidden from the Command Palette.**
- **Quieter commands.** Changing the layout or reorder mode, reflowing, and expanding or reducing grid space confirm in the status bar instead of a notification.
- **Git and error colors follow your theme** (the editor's gutter and error colors).

### Fixed
- **⌘⌫ on macOS only clears the search.** It used to also ask to delete the file under the pointer. Delete a file with fn+Delete (⌦) or from the context menu.
- **PDF previews show the first page again, without slowing down opening Thumbview.** The PDF renderer now loads after Thumbview has opened and finished filling in file contents, instead of before every first open in workspaces that contain PDFs.
- **`.map` source map syntax coloring follows theme.** Source maps (`.js.map`, `.css.map`, `.map`) are recognized as JSON, so keys, strings, and punctuation use theme colors in both hover previews and thumbnail tiles.
- **`lib/`, `env/`, and `libraries/` folders are no longer auto-ignored by name**, so Flutter, Ruby, and Elixir projects show their source. Dependency and cache folders such as `vendor/`, `.venv/`, and `__pycache__/` still are. Folders that earlier versions already auto-ignored stay ignored until you unignore them.
- **`thumbview.autoIgnoreThreshold: 0` now turns auto-ignore off completely**, as documented.
- **After a crash, your Zen mode settings are restored when VS Code starts**, not the next time you open Thumbview.
- **Editing `.gitignore`, `files.exclude`, or `search.exclude` updates the grid right away.**
- **Creating files in ignored folders** (build output, caches, editor swap files) no longer makes Thumbview rescan.
- **Workspaces with images no longer rescan and resend everything** on every file change.
- **Reopening Thumbview no longer redraws every tile from scratch.** Showing and hiding the panel was mistaken for a theme change, which threw away all cached tile images.
- **Deleting or moving a folder removes its tiles right away.**
- **Search matches stay visible on lines that also show a git change or an error.**
- **Auto-ignore messages and the README pointed to sidebar views that no longer exist**; they now point to the Folders & Ignored menu.

## [0.5.0] - 2026-09-29

### Added
- **Getting started walkthrough** (Help > Get Started) with screenshots, and a small in-grid legend of the key shortcuts that clicks pass through, shown until you dismiss it.
- **Timing and diagnostics** in View > Output > Thumbview: initial scan, first data, each file open, and F4 decisions.
- **Choose fullscreen or tab on first use**: the first fullscreen open shows a short banner explaining why Thumbview goes fullscreen, with **Open as a tab instead**. Settings now has an **Open Fullscreen** toggle.
- **Keyboard and screen reader support**: move between tiles with the arrow keys (Home/End for first/last), open with Enter, open the context menu with Shift+F10, move a tile with Alt+Arrow, and hold Ctrl to magnify the focused tile. The focused tile, search result counts, and folder changes are announced to screen readers. Toolbar controls and dialogs are labelled, dialogs move focus in and back out, and focus is always visible.
- **Status badges**: tiles show error counts and git status as text (for example `2, M`), not only as color.
- **High contrast and reduced motion**: high contrast themes and forced colors get explicit borders and outlines; animations respect reduced-motion settings.
- **`thumbview.fullscreenOnOpen` setting** (default on): turn it off to open Thumbview as a normal editor tab without Zen mode or maximizing editor groups.

### Changed
- **Feedback goes through the Marketplace Q&A tab**; the listing no longer links to the source repository.
- **Smaller, faster-loading package**: the extension now ships as a single bundled file with only its runtime assets, instead of compiled sources, screenshots, and build leftovers.
- **Marketplace listing**: added a description, categories, keywords, license, and links, an animated demo and current screenshots, plus README sections on accessibility, what Thumbview changes in VS Code, and limits.
- **Space opens the keyboard-focused tile**, like Enter. With no tile focused, Space still types into search.
- **Reduced motion follows your operating system** when `workbench.reduceMotion` is `auto`.
- **The 10,000-file limit keeps files already on the grid**, so new files elsewhere can never push a visible tile out.
- **Permanently deleting** a file or folder from Thumbview now asks for a second confirmation; Move to Trash remains the first choice.
- **Very large workspaces**: after auto-ignore, Thumbview shows at most 10,000 files and says so, and it also honors VS Code's `search.exclude` setting.
- **Thumbview shows what your project considers source.** Files are listed with your `.gitignore` rules (every level, via git) and VS Code's `files.exclude` instead of a fixed list of folder names, so folders such as `lib/`, `build/`, `env/`, or `target/` appear unless you ignore them. `.git` and `node_modules` are always skipped. Binary files are skipped. All folders of a multi-root workspace are scanned.
- **Restricted Mode and virtual workspaces are supported (limited)**: git is not run in untrusted workspaces, and remote/virtual files are read through VS Code's file system API.
- **Thumbview no longer changes your settings when VS Code starts.** The Zen mode settings it needs are applied the first time you open Thumbview in a session and your own values are restored when VS Code shuts down (or on the next start after a crash). Opening and closing Thumbview no longer rewrites your settings file, and a second VS Code window no longer undoes the first window's settings.
- **F4 keeps its VS Code meaning in Search and References.** Thumbview's F4 does not fire while the Search view has focus or a references peek is open.
- **Hovering Thumbview no longer takes focus** from the editor or terminal; click into Thumbview to focus it.
- **Sharp tiles on high-resolution screens**: tiles and folder previews are drawn at device pixel resolution.
- The toolbar reads your Thumbview shortcut only from VS Code's own `keybindings.json` instead of probing other applications' folders.
- **Reflow Layout** now also resets saved tile heights, so tiles return to their natural sizes.

### Fixed
- **Split editor widths in tab mode**: closing Thumbview no longer changes them. After fullscreen with split editors, splits return at equal widths.
- **Returning from Thumbview pinned preview tabs**.
- **Security hardening**: the page runs only its own nonce'd scripts, file names and key labels are escaped in HTML, typed file and folder names cannot leave the workspace, and settings sent from the page are validated.
- **Thumbview stopped tracking the active file after opening a file from it** and returning by clicking its tab.
- **F4 with Thumbview visible in another split** now focuses it where it is instead of moving it over your code.
- **First F4 showed nothing when split editors were open**: Thumbview mistook its own fullscreen layout for being dragged into a split and closed itself; only the second F4 worked.
- **F4 in one split closed Thumbview showing in another** instead of bringing it forward.
- **Thumbview left showing beside the code after closing with split editors**: closing now puts back the editor Thumbview covered in its own group.
- **Thumbview opening beside the code after splitting the editor**: the first reopen after a split now opens fullscreen like every other time.
- **Opening a file showed it in Zen mode for a moment**: the file now appears once, directly in the normal layout, instead of first in Zen mode and then again when the sidebar and tabs return.
- **Space on a toolbar or dialog button typed into search** instead of pressing the button.
- **Settings controls without accessible names**, a missing page title, landmark, and heading, and low contrast on the selected folder's file count (found by the new automated accessibility audit).
- **Build error in the spanning layout payload**: layout placements now keep the full file type, so the `contentVersion` used by delta payloads type-checks.
- **`thumbview.fullscreenOnOpen` description**: it now says Zen settings are restored when VS Code closes, which is what happens.
- **Thumbview not opening fullscreen**: A Zen mode setting that does not exist in current VS Code versions made every fullscreen attempt fail silently. Thumbview now writes only settings VS Code knows, and a failed settings write can no longer prevent fullscreen.
- **Slow, flashing file opens from tiles**: Clicking a tile shows the file immediately and restores the normal layout afterwards, instead of blanking Thumbview and waiting before opening the file. Reopening Thumbview afterwards is instant.
- **Security**: File actions requested by the webview are limited to the workspace, and the webview no longer allows `eval`.
- **Brief dark flash when reopening Thumbview**: Reopening at the same size now shows the previous frame immediately instead of waiting for the layout to settle.
- **Squished-then-expanding first open on large workspaces**: Opening Thumbview no longer shows tiles packed into the top-left corner for several seconds before they fill the screen. The panel stays hidden until a render at a stable size is ready, and a single `ResizeObserver` now drives all canvas sizing.
- **Folder mini-mosaic cache never hit**: The mosaic cache was stored on folder group objects that are rebuilt every render, so every render rebuilt every folder preview. It is now a module-level `mosaicCache` keyed by folder, size, search state, open files, and theme.
- **Data updates lost after a drag**: Payloads deferred during a drag were never applied because `applyDataMessage` was not reachable from the drag cleanup code. It is now module-level.
- **Stale open-tab set after closing a tab from a tile**: Clicking a tile's close button now updates `openFilesSet` as well as `openFiles`.
- **Squish when reopening quickly**: Reopening Thumbview keeps it hidden until the host reports its layout has settled and a frame at that size exists. Transition messages carry ids so a delayed message from a previous close is ignored, and pressing the open key repeatedly no longer reveals the page mid-transition.
- **Files shifting when ignoring a file inside a folder or among folder cards**: Folder views and folder card views now keep a persistent order like the root grid. Ignoring a file leaves an empty slot, every other tile stays in place, and the next added or unignored file fills the earliest gap it fits in. In spanning mode a gap keeps the ignored file's height; a shorter file that fills it keeps that height too (content at the top), and a taller file goes to the next gap that fits or to the end, so nothing re-flows.
- **Adding files re-wrapping spanning layouts**: New files at the root no longer recompute the column height, and folder and card views now save theirs, so additions add columns instead of re-wrapping every column.
- **Concurrent layout saves overwriting each other**: Drag reorders and background updates now write saved orders one at a time.
- **Blank panel when returning to Thumbview right after leaving it**.
- **Stale search highlights after toggling Match Case, Whole Word, or Regex**: The tile cache key now includes the search toggles.
- **Unsaved edits reverting in tiles**: A rescan triggered by any file change no longer replaces unsaved buffer contents with the on-disk version.
- **Brief top-left frame on resize**: When the panel grows after it is shown, the previous frame is stretched to the new size before paint, and the sharp render follows on the next frame.
- **Search missed edits below the first line**: The search index is now keyed on a host-provided content version instead of line count plus first line.
- **Blank panel when very small**: Panels under 200px now show a hint to enlarge the panel.
- **Toolbar flash on first open**: The page is hidden in its initial CSS instead of after the script loads.
- **Stale folder previews after switching themes**: Theme changes now clear the folder mosaic cache.
- **Gray panel or VS Code crash after pressing F4 rapidly**: Open/close sequences now run one at a time, and presses during a transition are coalesced, so spamming F4 no longer stacks overlapping Zen mode and editor maximize toggles.
- **Hidden panel after returning to Thumbview in some sequences**: The reveal safety timer keeps checking while Thumbview is in the background.
- **Tiles jumping after a drag in spanning mode**: Drag previews and the saved layout now use the same frozen tile heights, so a dropped file lands where it was previewed and no other file changes column.
- **Typing collapsing a view into folder cards**: Rows and columns added for a growing file no longer count toward the "tiles too small" check.
- **F4 stopping working after a hung transition**: A transition that never finishes no longer blocks later presses.
- **Files jumping to another column when a file grows or shrinks**: A file's column is now fixed once it is placed. Growing or shrinking a file only shifts the files below it within the same column; if a column overflows, the grid adds a row and proportional columns so tiles keep their shape.

### Performance
- **Closing is one visual step**: your file appears directly in the restored layout, like opening a file from a tile.
- **Faster close**: closing Thumbview waits for VS Code's own signals instead of fixed delays.
- **Faster file opens from Thumbview**: Thumbview stops redrawing the moment you click a file, so it no longer competes with VS Code restoring its layout. Each open's timing is logged to **View > Output > Thumbview**.
- **First open up to 3.5x faster on large workspaces**: lines are sent to the webview as plain text instead of objects, halving the data sent (144 MB to 69 MB at 10,000 files) and cutting the time to the first frame from about 2 s to 0.6 s at that size. Search indexing no longer copies every line up front.
- Updates send only the files whose content changed; unchanged tiles and folder previews keep their cached images across updates.
- Builds writing ignored output (for example `npm run watch` into a gitignored `out/`) no longer resend the workspace.
- Folder and card drags no longer do quadratic lookups.
- Cached tile and folder preview images are limited by memory (64MB and 32MB) instead of only by count, and evicted images release their memory immediately.
- Warnings and hints changing no longer resend the whole workspace to the webview; only changes to errors do.
- Host messages and resizes coalesce into one render per animation frame.
- Opening Thumbview before the background scan finishes waits for that scan instead of starting a second full scan.
- Document edits (300ms) and diagnostics (500ms) are debounced, and the host rebuilds its document cache once per pause instead of on every keystroke.
- Updates received while Thumbview is hidden are applied shortly after it reappears instead of delaying the reveal.
- File watcher events inside any directory the scanner excludes (such as `out/`, `node_modules/`, `.git/`) no longer trigger rescans, and saving a file sends one update instead of two.
- The search index cache is bounded to the files in the current payload.
- Resizing no longer discards cached tile and folder preview images, so the first frame after a resize is cheap.

### Internal
- New checks: an axe-core accessibility audit and a scale benchmark of the real webview in headless Chrome, integration tests inside VS Code, and unit tests on Windows and macOS in CI. `npm test` previously tried to run the node unit scripts inside VS Code and could not pass.
- The layout functions used by both the extension and the webview now have one source (`src/layout_core.ts`), generated into `media/overview.js`, replacing hand-kept copies that had started to drift.
- esbuild bundles the extension host to `dist/extension.js`, and a smoke test loads that bundle; GitHub Actions runs lint, the unit tests, and packaging on every push.

### Upgrade note
- Tile heights are now frozen per file. Layouts saved by earlier versions keep their current heights; the first **Reflow Layout** after upgrading resets every tile to its natural height, which can change every column once.
- Saved folder orders from earlier versions may contain files removed since. Those are now kept as empty slots, so the first view of such a folder can show a larger grid. Run **Reflow Layout** in that folder to compact it.

## [0.4.8] - 2026-09-21

### Added
- Layered Escape key dismissal: Pressing `Esc` now closes active UI interactions in priority order. It cancels active drags, hides context menus, closes settings and folders menus, or clears search input. When no menus or actions are active, `Esc` exits Thumbview and restores the previous editor tab.

### Changed
- Replaced the multi-color gradient bar atop the Settings and Folders & Ignored menus with the theme button background color, matching the active selection style used on layout and drag mode buttons.
- Unified fonts across Active Directories and Ignored Patterns in the Folders & Ignored popover by removing the monospace override from pattern text and aligning with the UI font.

### Fixed
- **Subfolder Drilldown Rendering Latency & Top-Left Sizing**: Fixed an issue where opening a subfolder with 152 files rendered files clustered in the top left and froze the UI for 2 seconds before expanding. Restored `THUMBNAIL_MIN_READABLE_FONT_SIZE` to `6.0` and `THUMBNAIL_MIN_READABLE_TEXT_PITCH` to `5.0`, eliminating 97,000+ redundant text layout/draw calls, expanded tile cache capacity from 150 to 500 entries to prevent eviction thrashing on 150+ file folders, enabled drilldown unconditionally when a folder is focused (`shouldOpenFolder = !!focusedFolder`), and used `Math.max(canvas.clientWidth, window.innerWidth)` to prevent transient layout dimension stalls.
- **Thumbnail vs Left CTRL Hover Alignment**: Fixed an issue where lines displayed in the Left CTRL hover inspector did not match the lines under the cursor in the thumbnail. Replaced uniform thumbnail height division with exact `stepY` pitch indexing clamped to `THUMBNAIL_MAX_LINE_PITCH`, properly mapped sampled lines in large files (>2000 lines) by scaling through the file's sampling stride, resolved hover lines against `fullLines` and `hoverLineCache` instead of returning sampled line items, and synchronized document click-to-jump calculation to use the identical visual line mapping.
- **Editor Viewport Band Alignment on Short Files**: Scaled `bandY` and `bandH` by rendered code content height (`Math.min(thumbnailH, lines.length * stepY)`) rather than full tile height, keeping editor viewport overlays and click-to-switch hits exactly aligned with visible code lines.
- **Git Gutter Markers in Sampled Files (>2,000 Lines)**: Added stride slice range iteration to `gitType` in `renderFileThumbnailContent`, displaying git diff additions and modifications on lines located past line 2,000.
- **Dynamic PDF Script Loader**: Added fallback dynamic script injection via `window.PDF_JS_URI` in `overview.js`, resolving a startup race condition where opening Thumbview before initial background scanning completes omitted `pdf.min.js`.
- **Hover Inspector Indentation Preservation**: Fixed an issue where all lines in the Left CTRL hover inspector were left-aligned due to thumbnail canvas tokens omitting leading whitespace. Extracted leading spaces and tabs from the source line and prepended them to the rendered HTML, configured `tab-size: 4` on `#hover-tooltip` in `extension.ts`, and accounted for tab expansion in `getFileWidestLineWidth` to avoid tooltip width clipping.

### Performance & Architectural Enhancements
- **Retained Webview Context Lifecycle**: Enabled `retainContextWhenHidden: true` for the webview panel and preserved the panel in the background on tab switches, editor jumps, and F4 toggles. Subsequent activations instantly reveal the existing panel in 0ms without re-instantiating Chromium DOM, re-parsing scripts, or reflowing layout.
- **Monospace Character Width Arithmetic**: Replaced tens of thousands of dynamic `ctx.measureText` layout measurements in `drawThumbnail` with single-sample monospace width caching (`getMonospaceCharWidth(fontSize)`). Token offsets are computed in $O(1)$ arithmetic (`tok.text.length * charWidth`), eliminating 1.5s–3.5s thread freezes during folder drill-downs.
- **Readability Thresholds & Crisp Minimap Blocks**: Configured readable text thresholds (`THUMBNAIL_MIN_READABLE_FONT_SIZE = 6.0`, `THUMBNAIL_MIN_READABLE_TEXT_PITCH = 5.0`). At sub-readable font sizes, code lines render as crisp syntax-colored minimap blocks via high-speed `ctx.fillRect`, eliminating sub-pixel blur and rendering entire repository grids in < 2ms.
- **Offscreen Tile Raster Cache**: Implemented LRU `tileRasterCache` (150-entry capacity) caching rendered code tile surfaces to offscreen canvases. Active editor viewport bands render dynamically on top, allowing scrolling and navigation between folders to blit cached bitmaps in ~0.1ms.
- **Memoized Recursive Subfolder Mini-Mosaics**: Preserved the full visual detail of recursive subfolder mini-mosaics while memoizing their rendered output to offscreen canvases (`group._miniCache`). Subsequent frames and hover events blit the cached mini-mosaic via a single `ctx.drawImage` call, reducing frame latency from ~300ms to < 0.05ms.
- **Lazy Line Tokenization**: Replaced eager upfront regex tokenization across all repository files during message processing with lazy tokenization in `drawThumbnail`, tokenizing lines only on demand when rendered.
- **Lazy Popovers & Modal Updates**: Deferred building folders and ignored patterns DOM nodes in `applyDataMessage` until the popovers or modal are physically opened.
- **Fast Hit Testing in Focused Folders**: Restricted `findFileAt` point testing to `activeRenderGrid.files` when drilling down into a folder, avoiding filtering thousands of repository files on every mouse move.
- **Surgical File Cache Invalidation**: Added `invalidateScanFile(filePath)` to evict only the modified file from the scan cache upon file watcher events, avoiding repository-wide disk rescans.
- **Sidebar In-Memory Directory Provider**: Connected `DirectoryTreeDataProvider` to cached repository files, eliminating repetitive 1s–4s disk crawls on folder tree expansions.
- **Conditional PDF Library Loading**: Lazy-injected `pdf.min.js` (320 KB) only when the workspace contains PDF files, trimming webview memory and startup evaluation.

## [0.4.7] - 2026-09-11

### Fixed
- Reflow ghost columns: Eliminated empty columns on the right after reflowing spanning grid layouts by sizing grid columns strictly from total required cells and row wrapping rather than padding empty columns to match canvas aspect ratio.
- Root view drag explosion on grid expansion/reduction: Fixed root view losing `wrapRows` metadata during tile drag operations, which previously caused Expand/Reduce Grid Space to repack tiles under an incorrect 2-row fallback and corrupt tile positions.
- Column stride preservation on extra-row drops: Ensured tile reordering serializes positions using effective wrap rows so dropping files into bottom padding rows does not shift subsequent columns diagonally.
- Gap preservation on grid expansion/reduction: Fixed an issue where expanding or reducing grid size caused files to shift into deliberate gaps left by previously moved files by omitting empty string tokens from cell counts, preventing tile drops beyond reduced column bounds, and retaining file order across webview data messages.

## [0.4.6] - 2026-09-11

### Added
- Mouse buttons 3 and 4 support to step backward and forward through folder drill-down history.
- Expandable directory tree and file counts in the ignored patterns popover.
- Configurable settings in the settings modal and VS Code configuration: compression percentage (`thumbview.compressionPercentage`), tile size before collapsing into folder cards (`thumbview.minCellWidth` and `thumbview.minCellHeight`), and auto-ignore threshold (`thumbview.autoIgnoreThreshold`).

### Changed
- Removed Grid Space controls from the settings modal. Expanding and reducing grid space remains available through the right-click context menu and command palette.
- Grid space expansion and reduction now scale rows and columns like a camera zoom. Existing tiles shrink toward the top left while new rows and columns appear on the bottom and right, preserving relative positions without reflow.
- Grid expansion is scoped per folder, so adding space inside a subdirectory leaves the root view untouched.
- Folder card previews mirror the drill-down view, including line-height spanning tiles and nested subfolder cards.

### Fixed
- Rebounding and layout jitter when changing compression percentage by resetting stale spanning rows and synchronizing slots in memory.
- Folder view aspect ratio and right-side void after reflow.
- Grid row height freeze when expanding space inside a reflowed folder view.
- Rapid successive drag swaps by updating slot occupancy in memory immediately upon drop.
- Multi-cell tile swaps collapsing empty gaps and shifting unrelated files.
- False folder card grouping in leaf folders with no subdirectories.
- Canvas expansion when dragging tiles into bottom empty rows or far-right columns.
- Window and sidebar resizing reflowing tiles across columns.

## [0.4.5] - 2026-08-31

### Added
- **Diagnostic Error Title and Overview Highlighting**: File titles turn red (`--vscode-list-errorForeground`) when syntax or type errors exist in the file, matching VS Code's file explorer behavior. Offending lines render red background and gutter highlights on the overview thumbnail tile, with diagnostic messages and error badges in the Left CTRL inspect tooltip.
- **Git Deletion Gutter Carets & Diff Indicators**: Rendered Git deletions as red gutter triangle carets (`▶`) on minimap tiles instead of full-width stripes, reserving full-width row fills for active lines. In the Ctrl-magnifier inspect tooltip, deleted lines feature strikethrough text with `-` diff prefixes, while errors display `✕` indicators and diagnostic messages.

### Changed
- **Recency Viewport Band Transparency**: Adjusted the gray editor viewport range overlay (`viewportBandOverlay`) opacity from `0.22` to `0.08` so blue modified highlights and green added highlights remain clear and distinct.

## [0.4.4] - 2026-08-29

### Changed
- **Git Status File Title Color Coding**: File titles are now styled directly in Yellow (modified) and Green (added / untracked) according to your VS Code theme's Git decoration colors, replacing the M and U/A badge glyphs for cleaner card headers.
- **Drag and Drop Map Optimizations**: Replaced $O(N)$ linear scans on mouse hover and dragging with $O(1)$ spatial coordinate Map lookups (`slotOccupancy`), indexed placements into Maps in the extension host, and eliminated frame allocations in `render()`.

### Fixed
- **Spanning Grid Bottom Row Drag Placement**: Fixed an issue where dragging tiles to lower or bottom rows failed to persist the expanded row capacity, which previously caused items to wrap into adjacent columns and expand canvas dimensions.
- **Cross-Column 1-Tall Tile Swapping**: Fixed an issue where swapping two 1-tall files at different row coordinates across columns swept up adjacent row 0 tiles and displaced them to the right. Equal-span tiles now swap exact slot positions cleanly.

## [0.4.3] - 2026-08-29

### Added
- **Unified Folders & Ignored Side-by-Side Modal**: Combined the separate Folders and Ignored top toolbar buttons into a single Folders & Ignored button opening a two-column glassmorphic modal. The left column lists active folders shown in Thumbview with file counts, click-to-isolate actions, and single-click ignore buttons. The right column lists all ignored folders and glob patterns with folder icons, an inline pattern input with an Add button, and one-click unignore buttons.
- **Automated Spanning Reordering Test Suite**: Added a unit test suite in `src/test/spanning_reorder.test.ts` and `npm run test:unit` verifying intra-column, cross-column, multi-tile displacement, and empty-slot movements.

### Fixed
- **Spanning Grid Aspect-Ratio Scaling**: Grid dimensions now expand proportionally in both horizontal and vertical directions when adding space, maintaining natural code aspect ratios without shifting existing tiles.
- **Symmetric Multi-Tile Cross-Column Drag and Drop**: Reordering spanning tiles across columns now collects and swaps all overlapping files across the full vertical span, preventing tile overwrites, lost files, or unintended canvas reflows.
- **Self-Drop and Intra-Column Movement Protection**: Resolved tile duplication when dragging a multi-cell file down onto its own sub-cells or swapping files within the same column.
- **Title Click Drag-State Reset**: Fixed an issue where clicking a file tile's title or header left candidate drag state active, causing subsequent mouse movement to trigger accidental file dragging.
- **Spanning Grid Drag Teleportation with Tall Files**: Fixed an issue where dragging files to empty slots on lower rows in workspaces with tall spanning files caused tiles to drop off the 2D grid matrix and teleport to the first empty slot. `buildSpanningGrid` and `reorderFile` now dynamically accommodate all spanning file cell heights and targeted row coordinates.
- **Opaque Blue Viewport Band on Windows**: Restored the open file editor viewport range overlay (`viewportBandOverlay`) to transparent gray (`rgba(255, 255, 255, 0.22)`), preventing solid opaque theme colors (`--vscode-editor-selectionBackground`) from covering code lines.
- **Search Bar Input Hijacking**: Fixed the global `keydown` event listener in `media/overview.js` to ignore keystrokes when any text input, textarea, or select element is focused, allowing users to type glob patterns into the ignore input without keystrokes being redirected to the search bar.
- **Consistent Ignored Folder Representation**: Automatically and manually ignored folders now consistently display folder items and badges in both the webview modal and sidebar tree views.

## [0.4.2] - 2026-08-07

### Added
- **Top Toolbar Navigation & Controls**: Added top toolbar controls with directory navigator, pattern manager, and interactive `⚙ Settings` modal directly on the webview toolbar. Allows switching layout modes (Spanning vs Uniform Grid), drag-to-reorder modes (Swap vs Shift), media thumbnails toggle, layout reflow, and full folder/ignore management.
- **Drag-and-Drop Tile Reordering**: Click-drag any file tile onto another to reorder the grid. Two modes, Swap and Shift, toggle via the Command Palette, settings modal, or sidebar links. Swap trades tile positions, while Shift inserts at the target and shifts items between. Works in both Uniform and Spanning grid layouts, persists across rescans and reloads, and shows a live ghost of the dragged tile plus an outline on the current drop target while dragging.
- **Empty Grid-Slot Drag Placement**: Users can drop file tiles into empty slots across both Uniform and Spanning grid modes. Dropping a tile to an empty space leaves an empty space where it came from so surrounding files do not reflow.
- **Git Status & Diff Tracking**: Visual gutter markers and status badges for modified, added, untracked, and deleted files with real-time Git repository change detection.
- **Theme Color Centralization & Fixed Brand Accents**: All webview HTML/CSS and canvas UI chrome colors now derive dynamically from the user's active VS Code theme (`--vscode-*`), automatically adapting across Dark+, Light+, and High Contrast themes. Three fixed brand accents are defined in `src/colors.ts`: search highlight (`#dc267f`), magnifier inspection (`#785ef0`), and open-tab recency (`#fe6100`).
- **General Hover Outline**: Hovering any tile now outlines it in the same accent color as the drag ghost/drop-target outline, for a consistent "you're interacting with this tile" affordance.

### Fixed
- **Stale WorkspaceState Keys for Spanning Layout**: Fixed stale `repomap.spanningAllocations` and `repomap.spanningRows` reads in `extension.ts` so persisted spanning allocations and row calculations reliably load from `thumbview.*`.
- **Sidebar Remaining Visible in Zen Mode**: Removed the automatic sidebar un-hiding in `enterFullscreen()`, ensuring the left sidebar stays hidden during Zen mode for a true full-canvas view.
- **Split Code Editors Visible to the Right in Zen Mode**: Enforced `zenMode.singleTabGroup: true` in `forceZenSettings()`, ensuring split editor groups to the right are hidden on enter and restored on exit.
- **Active-File Border Never Showing**: The active-file border now tracks the last editor that had focus before opening Thumbview, fixing an issue where the open-file border never appeared while Thumbview was focused.

## [0.4.1] - 2026-08-07

### Added
- **README Catchphrases**: Added a couple fun catchphrases to the README.md to help explain the value proposition.

### Fixed
- **Line Numbers Disappearing**: Forced `zenMode.hideLineNumbers` to `false` during Thumbview to prevent VS Code from hiding them in editor windows upon exiting zen mode.
- **Tab Dragging Splitting Guard**: Added layout protection that automatically closes Thumbview if its tab is dragged into a new split while in fullscreen mode, preventing the zen mode layout from breaking.
- **Manual Zen Mode Inversion**: Added tree-view visibility detection to ensure Thumbview doesn't accidentally exit an existing manual zen mode session when initialized.
- **Zen Mode Layout Inversion and Visible Tabs**: Removed a buggy visibility check that incorrectly inverted manual zen mode sessions and sometimes caused tabs to remain visible when opening Thumbview.

## [0.4.0] - 2026-08-07

### Changed
- **Always-Fullscreen Thumbview via Zen Mode**: Opening Thumbview now takes over the workbench through Zen Mode, hiding sidebars, panel, and auxiliary bar while maximizing editor groups. Prior layout state is restored on exit. `zenMode.centerLayout` and `zenMode.fullScreen` are temporarily forced off so the grid uses the full window, with original values backed up to workspaceState and restored on exit or next activation after a crash.

### Fixed
- **Slow, Multi-Step Fullscreen Transitions**: Zen Mode and editor-group maximize run concurrently so the panel renders at full size immediately, and opening a file from the grid overlaps layout exit with file disk reads.
- **Fullscreen Only Working Every Fourth Toggle / Phantom Split Groups**: All layout operations are now serialized through a promise queue with synchronously-set state flags. Previously, concurrent `enterFullscreen()` calls from the command path and `onDidChangeViewState` both passed the `fullscreenActive` check before either set it, stacking blind `toggleMaximizeEditorGroup` calls that cancelled each other or left splits stuck hidden.
- **Stray Split Groups When Opening Files from the Grid**: `jump` and `switchTab` now exit fullscreen before opening the document, so editors never open into a maximized group and force VS Code to spawn a side group that didn't exist before.
- **Split Widths Drifting Every Toggle**: `toggleMaximizeEditorGroup` acts on the active editor group, but it was fired at moments when different groups were active (maximize on the code group before `reveal()`, unmaximize on Thumbview's group), skewing split widths each cycle instead of restoring them. Maximize now runs only after the Thumbview panel is active (`maximizeThumbviewGroup()`), and unmaximize re-reveals the panel first if needed, so both toggles always land on Thumbview's group.
- **Zen Mode Inverted (Code in Zen, Thumbview Not)**: The view-state handler now exits fullscreen only when the panel is actually hidden (`visible === false`), ignoring view-state events while a layout operation is in flight to prevent queued exit calls from inverting Zen Mode.

## [0.3.9] - 2026-08-06

### Added
- **Match Case, Match Whole Word, and Regex Search**: Added Match Case (`Aa`), Match Whole Word (`ab`), and Use Regular Expression (`.*`) search toggles, with `Alt+C`, `Alt+W`, and `Alt+X` keyboard shortcuts. `media/overview.js`'s `rebuildSearchState()`/`textMatches()` are now the single matching engine behind grid tile borders/dimming, the per-line minimap match highlight, and the hover tooltip's highlighted matches. An invalid regex shows a red outline on the search input and stops dimming the grid instead of treating every tile as non-matching.

### Fixed
- **Post-Jump Line Flash Respects Search Options**: Opening a file by clicking a minimap tile now flashes matching lines in the editor using the same Match Case/Whole Word/Regex options active in the grid, instead of always doing a plain case-insensitive substring match.
- **Search Option Buttons Swallowing Their First Click**: Search toggle buttons now suppress default focus shifts on `mousedown` so clicks register on the first press.

## [0.3.8] - 2026-08-06

### Changed
- **In-Memory Cache Layout Updates**: Updated `src/extension.ts` to cache scanned files (`cachedScannedFiles`) upon repository scan and re-filter active files via `updateLayoutFromCache()` during ignore/unignore state changes or layout mode switches. This avoids redundant disk re-scans when toggling ignore rules.
- **Preserved Webview Image & View State**: Prevented webview data resets (`clearData: false`) and preserved webview image caches during layout updates to avoid unnecessary UI flashes and image re-fetching.

## [0.3.7] - 2026-08-05

### Fixed
- **Root Directory Files Only Ignore Support**: Updated `scanner.ts` `shouldIgnore()` to handle the `(root files)/` ignore pattern, filtering out top-level workspace root files (files without slashes in their relative paths). Updated `directoryProvider.ts` to evaluate `isFolderIgnored("(root files)/", ignorePatterns)` and count total root files from `allFiles` for the "Root Directory Files Only" tree item so it preserves total file counts and displays `(hidden)` state formatting, closed-eye icon, and context actions when hidden.

## [0.3.6] - 2026-08-04

### Fixed
- **Prevent Text Editor Unfocusing & Focus Stealing**: Removed automated `window.focus()` invocations from `openState` and `data` webview message handlers in `media/overview.js`. This prevents Thumbview from shifting focus away from active text editors during document modifications, cursor/line movements, or background file updates.

## [0.3.5] - 2026-08-04

### Fixed
- **Instant Image Thumbnail Refresh**: `media/overview.js` now clears `imageCache` on repository data updates and appends a cache-busting timestamp parameter (`?v=timestamp`) when instantiating `Image` elements, ensuring modified image and PDF files on disk refresh immediately in minimap tiles without requiring closing and reopening Thumbview.

### Changed
- **Documentation Cleanup**: Removed image tags from `README.md` for clean Marketplace rendering without broken image icons, updated section headings to "More Features" across `README.md` and `⚙ Actions & Shortcuts` webview modal.

## [0.3.4] - 2026-08-04

### Added
- **Fixed Magnifying Overlay Width Per File**: The code magnifying hover overlay (`#hover-tooltip`) width is now calculated once per file based on `min(max width allowed, widest line)`, preventing overlay window size jitter while moving across lines in the same file.
- **Comprehensive Project Setup & Ignore Guides**: Rewrote `README.md` and updated the `⚙ Actions & Shortcuts` webview modal overlay with detailed instructions on environment setup, layout modes (`spanning_grid` vs `uniform_grid`), auto-ignore threshold behavior, step-by-step ignore/unignore workflows (including managing `thumbview.autoIgnoreExclusions`), power-user minimap navigation tips, and embedded screenshot figures.

## [0.3.3] - 2026-08-04

### Added
- **Root Directory Files Only Highlight**: Added a "Root Directory Files Only" item to Directory Navigation sidebar. Selecting it highlights only files located directly in the root workspace folder while dimming subdirectories. Clicking a root file's header bar in the minimap webview also isolates root files.

### Changed
- **Directory-Grouped File Sorting**: Updated file layout sorting algorithm to group root directory files together contiguously at the start of the grid on initialization and reflow, keeping all root files adjacent to each other rather than scattered between subdirectories.

## [0.3.2] - 2026-08-01

### Changed
- **Default Minimum Cell Dimensions**: Adjusted default minimum cell dimensions (`thumbview.minCellWidth` and `thumbview.minCellHeight`) to 32×28 px.

## [0.3.1] - 2026-07-31

### Added
- **Configurable Minimum Cell Dimensions**: Added `thumbview.minCellWidth` (default `32`) and `thumbview.minCellHeight` (default `28`) configuration settings to customize the minimum tile size threshold before files are grouped into subfolder cards.

### Changed
- **Instant Hotkey Toggle & Tab Switch**: Replaced WebviewPanel destruction (`dispose()`) and window reflow animations on toggle hotkey (`F4`) with direct active text document switching (`showTextDocument`). Preserved background webview context enables 0ms instant toggling identical to tab clicks.
- **Smart Directory Selection (Lowlight vs. Folder Opening)**: When root file tiles are visible on screen, selecting a directory (from Directory Navigation sidebar or clicking a path) dims non-selected files (opacity 0.15) to preserve full codebase layout context. If tiles have shrunk below minimum cell size thresholds into folder cards, selecting a directory opens and drills down into that folder.

### Fixed
- **Stale Repository Data Flash Prevention**: Added `clearData: true` flag on repository rescan start, preventing webviews from briefly displaying stale minimap tiles from a previous repository or session while a refresh is in progress.
- **Reliable Window Maximization via Idempotent Commands**: Replaced boolean toggle commands with idempotent VS Code layout commands (`workbench.action.minimizeOtherEditors` and `workbench.action.evenEditorWidths`), eliminating state desynchronization and ensuring window expansion works 100% of the time.

## [0.3.0] - 2026-07-30

### Added
- **Subdirectory Selection Lowlighting**: When selecting a subdirectory in Directory Navigation, remaining workspace files stay positioned in their grid slots and are rendered low-lit (dimmed), preserving full codebase layout context while emphasizing the selected folder.
- **Directory Navigation Context Action "Ignore Directory" & Hidden Folder Indicators**: Added "Ignore Directory" to the right-click context menu in Directory Navigation. Ignored/hidden folders remain visible in the hierarchy, formatted with gray deemphasized text, darker deemphasized icons (`eye-closed`), `(hidden)` label, inline hover eye icon to unignore, and right-click "Unignore Directory".
- **Ignored Files & Directories Context Action "Unignore Directory" & "Delete"**: Added "Unignore Directory" to the right-click context menu in Ignored Files & Directories tree view and renamed the disk deletion option to "Delete" for ignored items.
- **Instant 0ms Editor Group Expansion**: Replaced tab snapshot loops with VS Code's instant 0ms `maximizeEditor` / `toggleEditorWidths` command so Thumbview expands to full width without slowing down or disrupting open tab groups.
- **Automatic Webview DOM Focus on Hotkey Open**: Webview automatically receives browser DOM focus (`window.focus()`) as soon as Thumbview opens via hotkey `F4`, allowing holding `Left CTRL` for magnifying overlay or typing to search immediately without clicking the panel first.
- **Toggle & Focus Hotkey (`F4`)**: Pressing the hotkey when Thumbview is focused toggles the panel closed. Pressing the hotkey when Thumbview is open but unfocused (e.g. side panel selected) brings focus to Thumbview.
- **Aspect Ratio Preservation for Images and PDFs**: Applied `drawAspectFit` rendering to image and PDF thumbnails, ensuring media files maintain their native aspect ratio (`object-fit: contain`) with dark letterbox/pillarbox background centering instead of stretching.
- **Auto-Ignore Guidance Toast Notification**: Updated auto-ignore toast notifications to explicitly inform users to check out 'Ignored Files & Directories' in the Thumbview sidebar to unignore folders if desired.

### Changed
- **Default Layout Mode Set to Spanning Grid**: Changed default configuration setting `thumbview.layoutMode` to `"spanning_grid"`, allowing larger/taller code files to span multiple vertical grid cells by default.
- **Directory-Grouped Relative Path Sorting & Reflow Layout Reset**: Sorted workspace files alphabetically by relative path during scanning so files in the same directory/level sit adjacent to each other in the minimap grid. Running "Reflow Layout" resets the grid order strictly to this directory-grouped relative path sequence while closing all layout gaps.
- **Fixed Maximum Line Gap for Short Files**: Capped line spacing step (`stepY`) to a fixed maximum height (6px) so files with few lines retain standard code line height instead of expanding vertical gaps to fill the thumbnail container height.
- **Ignored Tree Item Eye Icon Updates**: Changed the remove action icon in Ignored Files & Directories to an eye (`$(eye)`) and removed the crossed-out eye icon to the left of ignored tree items, replacing it with standard folder/file icons.

## [0.2.9] - 2026-07-29

### Added
- **VS Code Theme Highlighting for Markdown and JSON**: Improved syntax tokenization for `.md` and `.json` files in Thumbview, correctly applying VS Code theme colors (light blue headers and JSON keys, orange strings, green numbers, and dark blue booleans) to minimap canvas tiles and hover tooltips.
- **Reveal in Explorer Option**: Added "Reveal in Explorer" to the right-click context menu for items in both Directory Navigation and Ignored Files & Directories sidebar tree views, allowing quick location of folders or files in VS Code's File Explorer.
- **Delete Option for Ignored Files & Directories**: Added file/folder deletion to the Ignored Files & Directories tree view right-click context menu, supporting single and batch multi-selection deletions from disk (via Trash or Permanent Delete).

### Fixed
- **Sticky Hover Magnifying Overlay on Keyboard Shortcuts**: Fixed an issue where triggering keyboard shortcuts like `Ctrl+J` or losing window focus left the code magnifying hover overlay stuck on screen. Hover overlay now strictly disables whenever `Ctrl` is not actively held down.
- **Instant Minimap Refresh on Document Save**: Added a direct `onDidSaveTextDocument` event listener and reduced the refresh debounce delay from 500ms to 200ms, ensuring minimap cards update instantly upon saving a file in VS Code.

## [0.2.8] - 2026-07-28

### Fixed
- **PDF Click Opens Viewer Instead of Metadata**: Clicking a PDF tile in the thumbview now opens the file with `vscode.open` (delegating to the user's installed PDF viewer extension) instead of `openTextDocument` which showed raw binary metadata.
- **Single-File Layout Filling Viewport**: When most workspace files are gitignored, remaining files now fill the viewport instead of appearing tiny in the top-left corner. The grid dimensions are now computed from the bounding box of actually-occupied cells rather than the full persistent file order (which retained slots for removed/ignored files across sessions).

## [0.2.7] - 2026-07-28

### Added
- **Directory Navigation Delete Command**: Right-click any folder in the sidebar Directory Navigation tree to delete it (Move to Trash or Delete Permanently), with a confirmation dialog. Root item is excluded from deletion.
- **Directory Navigation Sync on File System Changes**: The sidebar Directory Navigation tree now refreshes automatically when folders or files are created, deleted, or changed in the file explorer, keeping the tree in sync with the workspace.

### Fixed
- **Eliminated `.vscode/settings.json` Repository Pollution**: Moved `ignorePatterns` and `autoIgnoreExclusions` storage from VS Code workspace-folder configuration (`ConfigurationTarget.WorkspaceFolder`, which creates `.vscode/settings.json` in the user's project) to `ExtensionContext.workspaceState` (VS Code's internal per-workspace key-value store). Users will no longer see Thumbview-created files appear in `git status`. Existing `settings.json` values are automatically migrated and cleaned up on first activation.

## [0.2.6] - 2026-07-27

### Fixed
- **Auto-Ignore Re-Add Loop**: Un-ignoring a dense directory no longer causes it to reappear in the ignore list on the next scan. A persistent `thumbview.autoIgnoreExclusions` list tracks user un-ignore decisions so auto-ignore respects them.
- **Cross-Project Ignore Pollution**: All `thumbview.ignorePatterns` reads and writes are now scoped to `ConfigurationTarget.WorkspaceFolder` with explicit workspace folder URI, ensuring ignore patterns from one project never leak into another VS Code window.

### Added
- **Recursive Subfolder Card Expansion**: When the root grid produces cells too small to read (below 60×40px), the view automatically groups files by immediate subfolder and renders clickable folder cards showing folder name, file count, and a density bar. Clicking a card drills into that folder. Recursion continues until tiles are large enough for individual minimap rendering.
- **`thumbview.autoIgnoreExclusions` Setting**: New configuration array that persists directories the user has explicitly un-ignored, preventing auto-ignore from re-adding them.

## [0.2.5] - 2026-07-24

### Fixed
- **Project-Scoped Workspace Ignore Settings**: Updated all `thumbview.ignorePatterns` configuration updates to use `vscode.ConfigurationTarget.WorkspaceFolder` so ignore patterns remain strictly isolated per repository project instead of saving to global user settings.
- **Dynamic Hotkey Label Display**: Restored inline hotkey rendering in sidebar welcome views and modal shortcuts, dynamically resolving keybindings to match user settings.

## [0.2.3] - 2026-07-23

### Added
- **Multi-Select Batch Deletion**: Enabled `canSelectMany: true` on the sidebar `Ignored Files & Directories` tree view, allowing `Shift + Click` or `Ctrl + Click` to select and batch-remove multiple ignore patterns simultaneously.
- **Top-Level Directory Ignore Consolidation**: Automatically aggregates auto-ignored virtualenvs and dense directories to top-level root folders (e.g., `BOFS/`, `.venv/`) to prevent redundant child entries.

### Fixed
- **Redundant Ignored Directory Pruning**: Pruned pre-existing child ignore patterns when a parent directory is already present in `thumbview.ignorePatterns`.

## [0.2.2] - 2026-07-23

### Added
- **Actions & Shortcuts Overlay Panel**: Added an interactive glassmorphic overlay modal triggered via `⚙ Actions & Shortcuts` button displaying keyboard/mouse shortcuts, layout controls, and settings hints.
- **`F4` Shortcut Integration**: Documented and bound `F4` key as the primary shortcut for opening and focusing the Thumbview panel.
- **Auto Window Focus on Mouseover**: Webview canvas automatically requests and restores active panel focus when the cursor enters the Thumbview window.

### Changed
- **`Left CTRL` Hover Modifier Rebind**: Rebound code magnifying preview overlay modifier key from `Alt` to `Left CTRL` to prevent window menu-bar focus stealing.

## [0.2.1] - 2026-07-23

### Performance
- **Parallel Chunked Repository Scanning**: Converted sequential workspace file scanning to parallel batches of 50 via `Promise.all()`, speeding up initial workspace loading by **5x to 7x** (under 500ms).
- **Canvas View Frustum Culling**: Implemented bounding-box viewport culling in the webview canvas loop (`y + fileH < -50 || y > rectH + 50`), skipping offscreen cards and locking canvas rendering at **60 FPS**.
- **Unified `_combinedText` Search Indexing**: Pre-indexed lowercased file strings into a single buffer (`file._combinedText`), replacing multi-line search loops with a fast 1-pass C++ `indexOf` lookup.
- **Pre-Computed Tokenization & HTML Caching**: Syntax tokens and line HTML strings (`line._htmlCache`) are pre-rendered on data receipt, eliminating string allocations during render frames.
- **$O(1)$ Constant-Time Open Tab Checks**: Converted open tab arrays to a `Set<string>` (`openFilesSet`), reducing open border checks from $O(N)$ linear scans to $O(1)$ instant lookups.

### Fixed
- **Media Custom Tab Close & Highlight Support**: Fixed open tab border highlighting (`#f97316`) and middle-click/close `×` button support for Image (`.png`, `.jpg`, `.svg`) and PDF custom editor tabs.

## [0.2.0] - 2026-07-23

### Added
- **Visual Image & PDF Thumbnail Rendering**: Integrated Webview `asWebviewUri` conversion and PDF.js Page 1 offscreen canvas snapshot rendering.
- **Configurable Media Rendering Setting**: Added `thumbview.renderMediaThumbnails` setting (default `true`).
- **Binary File Jumping Fallback**: Handled binary file jumping by catching text document errors and delegating to native `vscode.open`.

## [0.1.3] - 2026-07-22

### Fixed
- **Tab Switching Layout Stability**: Sanitized webview `resize()` and `render()` dimension measurements to ignore transient collapsed tab dimensions (<100px), eliminating tile shrink glitches upon tab switching.
- **Small File Code Line Scaling**: Adjusted font size to 5px for small files ($\le 50$ lines), showing up to 3x more code width on minimap tiles.
- **Top-Left Control Layout**: Anchored search container to top-left and placed folder breadcrumbs dynamically to its right.

## [0.1.0] - 2026-07-22

### Added
- **Initial Release**: 2D Code minimap grid with syntax highlighting, immediate search, Explorer context menu, sidebar tree navigation, `.gitignore` emulation, and dynamic line sampling.