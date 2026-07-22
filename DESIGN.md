# DESIGN.md

This document records the *why* behind Thumbview's architecture and behavior —
decisions that aren't obvious from reading the code alone — and is the place to record
new design decisions going forward, before or as they're implemented. See
[CLAUDE.md](CLAUDE.md) for the *what* (file responsibilities, commands, common tasks).

## Extension host vs. webview split

VS Code sandboxes webview content: it gets a real browser context (canvas, CSS,
`requestAnimationFrame`) but no direct access to the workspace file system or most of
the `vscode` API. Full workspace access requires the extension host (Node). So scanning
and file-system watching happen host-side (`extension.ts`, `scanner.ts`), and the
result is pushed into the webview (`media/overview.js`) over `postMessage` for
rendering — see CLAUDE.md's Architecture section for the message shapes.

## Why a single `<canvas>`, not one DOM element per tile

A workspace can have hundreds or thousands of files. Hundreds of absolutely-positioned
DOM nodes, each with their own layout/paint/reflow cost, would be considerably slower
to redraw on every resize, search keystroke, or cursor move than a single immediate-mode
canvas repaint. Canvas drawing is cheap to fully redraw every frame; the DOM isn't
designed to be entirely rebuilt on every keystroke. This also means there's no tile
component state to manage — `render()` just redraws everything from `data` each time.

## Duplicated grid/tokenizer logic between host and webview

`media/overview.js` is loaded as a plain `<script>` (see the CSP in `extension.ts`'s
`getHtml()`) — it cannot `import` the extension-host TypeScript in `src/`, which
compiles to Node16 modules meant for the extension host's Node runtime, not a browser.
So `layout.ts`'s `buildStableGrid` and `scanner.ts`'s per-line handling are effectively
re-implemented independently on the webview side (the `buildStableGrid` duplicate, the
`tokenizeJS`/`tokenizeCSS`/`tokenizeHTML` tokenizers). This duplication is an accepted
tradeoff for now, not an oversight — a shared bundle (e.g. bundling a common module for
both environments with esbuild) would remove it, but adds a build step this project
doesn't currently have. Revisit if the two copies drift out of sync often enough to be
a real maintenance cost.

## Two layout modes: `uniform_grid` vs `spanning_grid`

`uniform_grid` (the default) is simplest: one cell per file, purely order-based, cheap
to reason about and maximally stable. `spanning_grid` was added so a file's tile size
communicates something about the file (its line count) instead of every file getting
equal screen space regardless of size — useful once a workspace mixes many small files
with a few large ones. The two modes are additive, not a replacement of one by the
other, so users can pick based on preference via `thumbview.layoutMode`.

## Stable, incremental grid growth (`buildStableGrid`)

Users build spatial memory of where a file's tile lives ("that file is bottom-right of
the grid"). If adding one new file to the workspace re-flowed every existing file to a
new position, that memory would be invalidated on every git branch switch or scaffold
step. So the grid only ever grows by appending new columns then new rows onto the
existing layout (see the comment in `layout.ts`), and `PersistentFileOrder` (`state.ts`)
guarantees a given file's array index — and therefore its slot — never changes just
because other files came and went.

## Hole-filling instead of compaction (`PersistentFileOrder.update`)

Why a deleted file leaves a gap that's backfilled by a new file, rather than
immediately compacting the array: same stability goal as above. Removing a file from
the middle of the order and shifting everyone else down would move every subsequent
file's slot. Backfilling a hole means only the newly-added file's position is
"surprising"; nothing already on screen moves. The explicit **Reflow Layout** command
exists for when a user *does* want to intentionally compact and reset — e.g. after a
lot of churn has left many holes and the grid feels sparse.

## Hand-rolled `.gitignore` emulation & custom ignore patterns

`scanner.ts`'s `shouldIgnore` translates glob patterns to regular expressions without external dependencies.
Rules are evaluated sequentially in order, supporting negation patterns (`!pattern`) where subsequent rules
override preceding ones. In addition to workspace `.gitignore` files, custom ignore patterns defined in
`thumbview.ignorePatterns` are combined into the ignore filter and managed visually in the sidebar tree view.

## Sidebar Tree Views & Navigation

To improve navigation in large repositories where canvas headers are small:
1. **Directory Navigation Tree**: Built hierarchically in `directoryProvider.ts`. Focuses the Thumbview canvas
   to specific folders with accurate cumulative file counts (including subdirectories).
2. **Ignored Files & Directories Tree**: Built in `ignoreProvider.ts`. Allows adding or removing ignore patterns directly from the sidebar.

## Webview Context Menu & Pinned Editors

Right-clicking minimap file cards triggers a custom HTML context menu supporting standard VS Code Explorer
actions (Open, Open to Side, Open Preview, Select for Compare, Compare with Selected, Reveal in Explorer,
Open Containing Folder, Cut, Copy, Copy Path, Copy Relative Path, Rename..., Delete, Ignore in Thumbview).
Jumping to files opens them with `{ preview: false }` to ensure tabs pin permanently and populate recency history.

## Known limitations / accepted tradeoffs

- **No automated tests** (see README's "Notes" section). `layout.ts`/`state.ts` are
  pure functions/classes and would be straightforward to unit test; not yet done.
- **`MiniLine.category`** (`scanner.ts`) is computed host-side but not read by the
  webview, which does its own independent tokenization. Left unresolved as either dead
  code or an unfinished feature — see the comment at its definition.
- **No shared type definitions for the `postMessage` protocol** between `extension.ts`
  and `media/overview.js` (see CLAUDE.md's "Cross-module interface" note) — protocol
  drift is caught only by manual review/testing, not the compiler.

## Future design decisions

Record new design decisions here as they're made — before or while implementing them,
not only after. For each: the decision, the alternatives considered, and why. Move an
entry into a dedicated section above once it's substantial enough to warrant one.

- **`.gitignore` Negation Pattern Support**: Updated `shouldIgnore` to evaluate rules sequentially so `!pattern` rules explicitly override earlier matches.
- **Pinned Tabs on Jump**: Opened files with `{ preview: false }` so VS Code keeps tabs open and preserves active tab history.
- **Full Explorer Context Menu & Sidebar Views**: Integrated custom context menu and sidebar TreeDataProviders (`thumbview-directories`, `thumbview-ignores`) for workspace management.
