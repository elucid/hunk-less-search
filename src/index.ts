/**
 * less-style forward search for Hunk.
 *
 * `/` opens a prompt on a one-row line at the bottom of the review, you type
 * the pattern in place, and Enter jumps to the next matching hunk; `n` and `N`
 * repeat it, wrapping. The same line then reports where you landed, and the
 * matched characters are marked inside the diff itself.
 *
 * Three surfaces cooperate on the prompt because no single one can do this
 * alone:
 *
 * - a **command** is the only thing that can hold a key and enter a mode,
 * - a **keyboard mode** is the only thing that receives raw typed keys, and
 * - a **pane** is the only thing that can paint and navigate.
 *
 * `store.ts` is the seam between them. Stepping is hunk-granular so `n` visibly
 * moves on every press, while the jump itself is `revealLine` on the first
 * matching line, so a hit deep inside a tall hunk lands on the match rather
 * than on the hunk's anchor.
 *
 * A registered **line highlighter** marks the matched characters inside the
 * diff itself: every matching line gets a `"match"` mark and the line the
 * review just jumped to gets the one `"current"` mark. The marks are a pure
 * derivation of the session's query and current target, so every path that
 * changes either — a submitted search, `n`, `N` — asks the host to re-derive
 * with `ctx.highlights.refresh` rather than pushing mark state anywhere.
 */
import type { HunkExtensionAPI } from "hunkdiff/extension";
import { SearchPromptLine } from "./pane";
import { applyPromptKey } from "./prompt";
import { createSearchSession, readSearchMode } from "./session";
import {
  beginPrompt,
  deliverOutcome,
  endPrompt,
  getSnapshot,
  readSelection,
  setQuery,
} from "./store";

export default function (hunk: HunkExtensionAPI) {
  const session = createSearchSession({ mode: readSearchMode(hunk.config) });

  // A command handler only ever sees the selected file, so the searched corpus
  // is shadow-tracked from the changeset event.
  hunk.on("changeset_loaded", (event) => {
    session.setFiles(event.changeset.files);
  });

  // Marks live inside Hunk's own diff rendering; the host resolves the tones
  // against each line's background so a match is visible on added lines too.
  hunk.registerLineHighlighter({
    id: "matches",
    highlight: ({ file }) => session.marksFor(file),
  });

  // Always open rather than gated by `available()`: pane availability is
  // re-evaluated on the host's renders, which extension state changes do not
  // cause, so a pane that hides itself on extension state can fail to come
  // back. One permanently reserved row is the honest trade.
  hunk.registerPane({
    id: "prompt",
    title: "Search",
    placement: "bottom",
    defaultOpen: true,
    height: { preferred: 1, min: 1, max: 1 },
    component: SearchPromptLine,
  });

  hunk.registerKeyboardMode({
    id: "prompt",
    title: "Search",
    onEnter: beginPrompt,
    onExit: endPrompt,
    onKey(key, ctx) {
      const result = applyPromptKey(getSnapshot().query, key);

      switch (result.kind) {
        case "edit":
          setQuery(result.query);
          return "handled";
        case "submit":
          // The mode holds no navigation, so the outcome is left for the
          // mounted prompt line to perform.
          deliverOutcome(session.search(result.query, readSelection()), null);
          ctx.highlights.refresh("matches");
          return "exit";
        case "cancel":
          return "exit";
        case "ignore":
          // Consume rather than pass: the review stays still under the prompt.
          return "handled";
      }
    },
  });

  hunk.registerCommand({ id: "find", title: "Search forward", key: "ctrl+f" }, (ctx) => {
    ctx.keyboardModes.enterMode("prompt");
  });

  hunk.registerCommand({ id: "next", title: "Next search match", key: "n" }, (ctx) => {
    deliverOutcome(
      session.repeat("forward", {
        fileId: ctx.selection.file?.id ?? null,
        hunkIndex: ctx.selection.hunkIndex,
      }),
      ctx.navigation,
    );
    // The current target moved, so the one "current" mark moves with it.
    ctx.highlights.refresh("matches");
  });

  hunk.registerCommand({ id: "previous", title: "Previous search match", key: "N" }, (ctx) => {
    deliverOutcome(
      session.repeat("backward", {
        fileId: ctx.selection.file?.id ?? null,
        hunkIndex: ctx.selection.hunkIndex,
      }),
      ctx.navigation,
    );
    ctx.highlights.refresh("matches");
  });
}
