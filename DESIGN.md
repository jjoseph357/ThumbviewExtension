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

## Hand-rolled `.gitignore` emulation instead of a library

`scanner.ts`'s `shouldIgnore` is a quick glob-to-regex translator rather than a
dependency on a maintained gitignore-parsing library. It's known incomplete — no
negation pattern (`!foo`) support (see the comment in `scanner.ts`). Accepted for now
because the main failure mode is a false-negative (a file that should be ignored but
isn't), which just adds noise to the grid rather than breaking anything. Revisit if
this becomes a real pain point, or swap in a maintained library if negation support is
needed.

## Persisted state keys keep the pre-rename "repomap" name

The extension was renamed from **Repository Map** (`repomap`) to **Thumbview** after
users may already have had state persisted under the old name. Renaming
`context.workspaceState` keys would silently drop existing users' saved file
order/layout on their next update, so they were deliberately left as `"repomap.*"`
rather than "cleaned up" for cosmetic consistency. See CLAUDE.md's Terminology section
for the specific keys, and what a safe migration would need to do.

## Search/highlight color choices

Pink (`#ec4899`) = search match, purple (`#a855f7`) = active editor tab, orange
(`#f97316`) = an open-but-inactive tab. Chosen to be visually distinguishable from each
other at a glance across many small tiles. The canvas draws its own fixed dark palette
rather than trying to match the user's actual VS Code theme — reliably deriving a
matching palette from an arbitrary theme isn't attempted here.

## Known limitations / accepted tradeoffs

- **No automated tests** (see README's "Notes" section). `layout.ts`/`state.ts` are
  pure functions/classes and would be straightforward to unit test; not yet done.
- **`MiniLine.category`** (`scanner.ts`) is computed host-side but not read by the
  webview, which does its own independent tokenization. Left unresolved as either dead
  code or an unfinished feature — see the comment at its definition.
- **`.gitignore` negation patterns are unsupported** (see above).
- **No shared type definitions for the `postMessage` protocol** between `extension.ts`
  and `media/overview.js` (see CLAUDE.md's "Cross-module interface" note) — protocol
  drift is caught only by manual review/testing, not the compiler.

## Future design decisions

Record new design decisions here as they're made — before or while implementing them,
not only after. For each: the decision, the alternatives considered, and why. Move an
entry into a dedicated section above once it's substantial enough to warrant one.

*(None yet.)*
