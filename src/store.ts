/**
 * The one piece of state the prompt line and the keyboard mode share.
 *
 * They cannot talk directly: a pane component paints and never receives keys, a
 * session keyboard mode receives keys and can neither paint nor navigate. This
 * module is the seam between them — module-level state, an immutable snapshot,
 * and the `useSyncExternalStore` subscription a pane needs to survive being
 * unmounted and remounted.
 *
 * Two kinds of state live here, deliberately separated:
 *
 * - The **snapshot** is what the prompt line paints, so every write to it
 *   notifies subscribers.
 * - The **selection mirror** is what the keyboard mode reads at submit time,
 *   and nothing paints it, so it is a plain variable. Keeping it out of the
 *   snapshot means the review's own selection changes never repaint the prompt.
 */
import type { ExtensionReviewNavigation } from "hunkdiff/extension";
import type { SearchPosition } from "./search";
import { formatOutcome, type SearchOutcome } from "./session";

/** Where one jump should land: the exact line when there is one, else the hunk. */
export interface NavigationTarget {
  fileId: string;
  hunkIndex: number;
  /** The matched line, or `null` when the patch carried no usable numbers for it. */
  line: { side: "old" | "new"; number: number } | null;
}

/** One jump the prompt line should perform on its next render. */
export interface NavigationRequest extends NavigationTarget {
  /** Identity for the request, so a repaint cannot replay a completed jump. */
  token: number;
}

/**
 * Perform one jump through whichever navigation surface the caller holds.
 *
 * Line-exact whenever the patch numbered the matched line: a hunk can be
 * hundreds of lines tall, and `selectHunk` would land on its anchor rather
 * than on the match the diff just marked. `revealLine` itself degrades to the
 * containing hunk when the review draws no row for the line, so the fallback
 * here is only for a match the patch never numbered at all.
 */
export function performNavigation(navigation: ExtensionReviewNavigation, target: NavigationTarget) {
  if (target.line === null) {
    navigation.selectHunk(target.fileId, target.hunkIndex);
    return;
  }

  navigation.revealLine(target.fileId, target.line.side, target.line.number);
}

/** What the prompt line paints. */
export interface PromptSnapshot {
  /** True while the keyboard mode owns input and the buffer is live. */
  readonly prompting: boolean;
  readonly query: string;
  readonly status: { message: string; tone: "info" | "warning" } | null;
  readonly pending: NavigationRequest | null;
}

const EMPTY: PromptSnapshot = Object.freeze({
  prompting: false,
  query: "",
  status: null,
  pending: null,
});

let snapshot: PromptSnapshot = EMPTY;
const listeners = new Set<() => void>();
let nextToken = 1;

// Not part of the snapshot: the mode needs it, nothing paints it.
let selection: SearchPosition = { fileId: null, hunkIndex: null };

/** Publish an immutable snapshot and wake every mounted subscriber. */
function publish(next: PromptSnapshot) {
  if (next === snapshot) {
    return;
  }

  snapshot = Object.freeze(next);
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe to prompt state; the returned function unsubscribes. */
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the current snapshot. Stable between publishes, as the store contract requires. */
export function getSnapshot() {
  return snapshot;
}

/** Mirror the review's selection so the keyboard mode can search relative to it. */
export function setSelection(position: SearchPosition) {
  selection = position;
}

/** Where a search started from, as of the last painted frame. */
export function readSelection(): SearchPosition {
  return selection;
}

/** Open the prompt with an empty buffer, clearing any previous status. */
export function beginPrompt() {
  publish({ ...snapshot, prompting: true, query: "", status: null });
}

/** Replace the prompt buffer as the user types. */
export function setQuery(query: string) {
  publish({ ...snapshot, query });
}

/** Close the prompt, keeping whatever status the search left behind. */
export function endPrompt() {
  publish({ ...snapshot, prompting: false, query: "" });
}

/** Retire one navigation request once the prompt line has performed it. */
export function completeNavigation(token: number) {
  if (snapshot.pending?.token === token) {
    publish({ ...snapshot, pending: null });
  }
}

/**
 * The single sink for a search result: status text, then the jump.
 *
 * Both entry points end here — the keyboard mode's Enter and the `n`/`N`
 * commands — so there is one description of what a search outcome does, and one
 * place that decides what the status line says.
 *
 * `navigation` is the difference between them, and it is a capability rather
 * than a choice: a command handler holds live navigation, while a keyboard mode
 * holds none at all. Passing `null` defers the jump to the prompt line, which
 * is mounted and does hold navigation actions.
 */
export function deliverOutcome(
  outcome: SearchOutcome,
  navigation: ExtensionReviewNavigation | null,
) {
  const status = formatOutcome(outcome);
  const target: NavigationTarget | null =
    outcome.kind === "moved"
      ? {
          fileId: outcome.target.fileId,
          hunkIndex: outcome.target.hunkIndex,
          line:
            outcome.target.line.lineNumber === null
              ? null
              : { side: outcome.target.line.side, number: outcome.target.line.lineNumber },
        }
      : null;
  const pending =
    target !== null && navigation === null ? { ...target, token: nextToken++ } : snapshot.pending;

  publish({ ...snapshot, status: { message: status.message, tone: status.type }, pending });

  if (target !== null && navigation !== null) {
    performNavigation(navigation, target);
  }
}

/** Reset every piece of prompt state. Exported for tests. */
export function resetStore() {
  snapshot = EMPTY;
  selection = { fileId: null, hunkIndex: null };
  nextToken = 1;
  listeners.clear();
}
