# hunk-less-search

`/` forward search for the [Hunk](https://github.com/modem-dev/hunk) review
stream, in the shape `less` taught everyone: a prompt appears on a one-row line
at the bottom, you type the pattern **in place**, Enter jumps to the next
matching hunk, and `n` / `N` repeat it. The same line then reports where you
landed, and the matched characters are **marked inside the diff itself** —
every match highlighted, the one you just jumped to marked more strongly.

![Typing /readConfig at the prompt line, jumping to the first match, and
stepping through the rest with n and N](demo/less-search.gif)

```text
/readConfig█
```

```text
[2/7] src/session/agent/surface.ts:214 (+3 in hunk) — const surface = buildAgentSurface(session);
```

## Requirements

- [Hunk](https://github.com/modem-dev/hunk) with extension API v5 or newer
  (0.19.0 or later)
- [Bun](https://bun.sh) only for development and the short `bun run search`
  command

The prompt line needs `registerPane` and `registerKeyboardMode`, and the in-diff
match marks need `registerLineHighlighter`. The manifest declares
`"apiVersion": 5`, so an older Hunk refuses the extension with a clear notice
instead of throwing partway through the factory.

## Install

```bash
hunk extension install elucid/hunk-less-search
```

That clones it into `~/.config/hunk/extensions/installed/hunk-less-search/`,
where it loads in every session. `hunk extension list`, `update`, and `remove`
manage it from there.

To try it for a single session instead, clone the repository and load the
checkout explicitly:

```bash
git clone https://github.com/elucid/hunk-less-search.git
cd hunk-less-search
bun install
bun run search
```

That script expands to:

```bash
hunk diff --extension .
```

## Take `/` from the file filter

Out of the box the extension binds `ctrl+f`, because Hunk's built-in
`hunk.review.focusFilter` already owns `/` and **built-ins win key conflicts** —
an extension can never shadow one.

What an extension _can_ do is be handed the key by the user. Bindings are
exclusive: a chord you bind explicitly belongs to that command, and whatever
held it by default gives it up. So one line in `~/.config/hunk/config.toml` is
the whole handover:

```toml
[keybindings]
"hunk-less-search.find" = "/"
```

The file filter is still reachable with `tab`, or give it a key of its own:

```toml
[keybindings]
"hunk-less-search.find" = "/"
"hunk.review.focusFilter" = "F"
```

| Key                       | Does                                        |
| ------------------------- | ------------------------------------------- |
| `ctrl+f` / `/`            | Open the prompt                             |
| `n` / `N`                 | Next / previous match, wrapping             |
| Enter                     | Search, jump, close the prompt              |
| Backspace on empty buffer | Back out of the search                      |
| `ctrl+u` / `ctrl+w`       | Clear the buffer / delete the trailing word |
| `ctrl+c`, `ctrl+g`, Esc   | Abandon the search (Esc is host-owned)      |

> The extension id is the folder name, which is `hunk-less-search` however you
> install it. Rename the checkout on disk and every `[keybindings]` command id
> and the `[extension.…]` table name change with it.

## Options

```toml
[extension.hunk-less-search]
mode = "regex"   # default "literal"
```

Both modes are smart-case: an all-lowercase pattern is case-insensitive, any
uppercase character makes it case-sensitive.

## How the prompt line is possible

No single extension surface can do this, because Hunk splits paint from input
deliberately. Three cooperate, joined by a store:

| Surface                        | Can                                | Cannot                   |
| ------------------------------ | ---------------------------------- | ------------------------ |
| `registerCommand`              | hold a key, enter a mode, navigate | stay open while you type |
| `registerKeyboardMode`         | receive every typed key            | paint anything, navigate |
| `registerPane` (bottom, 1 row) | paint, and navigate via `actions`  | receive any key          |

So the mode owns the buffer, the pane paints it, and the pane also performs the
jump the mode asked for — `ExtensionKeyboardModeContext` exposes no navigation,
while `ExtensionPaneActions` does. `src/store.ts` is that seam, bridged into
React with `useSyncExternalStore` so the state survives the pane unmounting.

Two consequences worth knowing before copying this pattern:

- **The pane is always open**, costing one review row for the whole session.
  `available()` looks like the way to hide it, but availability is re-evaluated
  on the _host's_ renders, and extension state changes do not cause one — a pane
  that hides itself on extension state can fail to come back.
- **Hunk labels the active mode itself.** While the prompt is open the chrome
  shows `Search — ext hunk-less-search:prompt — Esc exits`. An extension cannot
  suppress that, and shouldn't be able to: it is how a user knows who is holding
  their keyboard.

There is no host text input at this layer either, so `src/prompt.ts` owns
backspace, word deletion, what counts as printable, and the block character
standing in for a cursor. It rejects any event containing a control character
rather than filtering it, because otherwise an arrow key (`ESC [ A`) would type
`[A` into the pattern — and it accepts multi-character events, because a
terminal happily delivers a fast typist or a paste as one chunk.

## What it searches, and how precisely it lands

The changeset is shadow-tracked from `changeset_loaded`, since a command
handler's `ctx.selection` only exposes the _selected_ file. Each file's `patch`
is parsed into hunks, and every rendered line — added, removed, and context — is
searched on both sides.

Stepping is **hunk-granular** and landing is **line-exact**. Every match inside
one hunk collapses into a single jump target, which is what keeps `n` visibly
moving on every press rather than crawling through six hits on adjacent lines.
The jump itself uses `revealLine(fileId, side, line)` on the first matching
line, so a hit two hundred lines into one tall hunk arrives near the top of the
viewport instead of pages below the hunk's anchor — and the reveal makes it the
current line, right under the `"current"` mark described below. A match the
patch never numbered (a malformed `@@` header) has no line to address, so it
falls back to `selectHunk`. The status line still carries what the jump cannot
show: path, line number, matched text, and how many more lines in that hunk
matched.

The **marks carry the character-level precision**: a registered line
highlighter (`src/index.ts` → `session.marksFor`) reports every matching line's
matched extent in source coordinates, and Hunk paints them inside its own diff
rendering — syntax highlighting and word diff intact, with the tone resolved
against each line's background so a match is visible on added lines too. The
line the review just jumped to (the one the status quotes) gets the single
`"current"` tone. Marks are a pure derivation of the session's query and
current target: every path that changes either — Enter, `n`, `N` — calls
`ctx.highlights.refresh("matches")`, and a reload re-derives them against the
new files automatically.

- **Repeats are strict and wrapping.** `n` never answers with the hunk you are
  already on; when the current hunk is the only match, the wrap brings it back
  around and says `wrapped`.
- **Repeats follow you.** `n` steps from wherever the review is now, so
  scrolling away and pressing `n` resumes from there.
- **A reload keeps the search.** The query is re-matched against the new
  changeset when a watch, refresh, or agent command rebuilds the review.
- **A bad regex keeps the old query** and reports the compile error.
- **The file filter still wins.** A match in a hidden file is refused by Hunk's
  guarded navigation, since the extension navigates through the same validated
  path a built-in pane does.
- **Hunk bounds how much one file may paint.** A pattern matching thousands of
  lines in one file exceeds the host's per-file mark budget, and Hunk drops that
  file's marks with a notice. Navigation and the status line are unaffected.

## Repository layout

```text
src/index.ts     registration and wiring of the four surfaces
src/search.ts    pure: patch parsing, query compiling, targets, marks
src/session.ts   the one query, target list, and cursor; status wording
src/prompt.ts    pure: the prompt's key grammar
src/store.ts     the seam between mode, pane, and commands
src/pane.tsx     the one-row prompt line
tests/           bun test coverage for all of it, no terminal required
demo/            the recorded demo and the fixture changeset it searches
scripts/         capture-demo.ts, which records that demo from the real TUI
```

## Development

```bash
bun install
bun run test
bun run typecheck
```

The extension uses only Hunk's public extension API. `react`, `@opentui/core`,
`@opentui/react`, and `hunkdiff` are **development** dependencies supplying
types only — Hunk serves its own copies of React and OpenTUI to extension files
at runtime, and shipping a second React would give the pane a second hooks
dispatcher and stop it rendering.

For a real terminal check, run `bun run search` and try `/`, `n`, and `N`
against an actual diff.

### Recapturing the demo

`demo/less-search.gif` is recorded from the real TUI, not assembled by hand:
`scripts/capture-demo.ts` drives an actual `hunk` binary over a PTY against
`demo/config-cache.patch`, renders each terminal state to a retina PNG, and
encodes the timeline as a looping GIF.

```bash
bun run capture:demo
```

It needs `hunk` and `ffmpeg` on PATH (`HUNK=` and `FFMPEG=` override either),
and it is Unix-oriented and optional — tests never run it. The recording uses a
throwaway config home carrying the `/` handover above, so what you see is the
keybinding this README recommends rather than the default `ctrl+f`. Recapture
when the prompt line, the status wording, or the match marks visibly change.

## License

MIT
