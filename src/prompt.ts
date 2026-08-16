/**
 * The prompt's key grammar, as a pure function.
 *
 * A session keyboard mode receives raw terminal keys and must answer
 * synchronously, so the editing rules are kept here where a unit test can drive
 * every one of them without a terminal. There is no host text input at this
 * layer: an extension that wants an in-place prompt owns backspace, word
 * deletion, and what counts as a printable character itself.
 */
import type { ExtensionKeyEvent } from "hunkdiff/extension";

/** What one key did to the prompt buffer. */
export type PromptKeyResult =
  | { kind: "edit"; query: string }
  | { kind: "submit"; query: string }
  | { kind: "cancel" }
  /** Consumed to keep the review still under the prompt, but changed nothing. */
  | { kind: "ignore" };

/**
 * Fold one key into the prompt buffer.
 *
 * Modelled on `less`'s own prompt rather than on a text field: Enter searches,
 * backspace on an empty buffer backs out of the search entirely, and Ctrl-C /
 * Ctrl-G abandon it. Everything else the mode does not understand is consumed
 * rather than passed, so a stray arrow key cannot scroll the review out from
 * under a half-typed pattern.
 */
export function applyPromptKey(query: string, key: ExtensionKeyEvent): PromptKeyResult {
  const name = key.name?.toLowerCase();

  if (key.ctrl) {
    switch (name) {
      case "c":
      case "g":
        return { kind: "cancel" };
      case "u":
        return { kind: "edit", query: "" };
      case "w":
        return { kind: "edit", query: deleteWord(query) };
      case "h":
        return backspace(query);
      default:
        return { kind: "ignore" };
    }
  }

  if (key.meta) {
    return { kind: "ignore" };
  }

  if (name === "enter" || name === "return") {
    // An empty pattern is a change of mind, not a search for nothing.
    return query.trim().length === 0 ? { kind: "cancel" } : { kind: "submit", query };
  }

  if (name === "backspace" || name === "delete") {
    return backspace(query);
  }

  if (name === "space") {
    return { kind: "edit", query: `${query} ` };
  }

  return typeText(query, key.sequence);
}

/**
 * Append whatever text one key event carried.
 *
 * A terminal does not promise one character per event: a fast typist, a
 * coalesced read, and a paste all arrive as a multi-character `sequence`, so
 * accepting only single characters silently drops input. Escape sequences
 * arrive the same way, which is why any control character other than a
 * newline rejects the whole event rather than being filtered out of it —
 * otherwise an arrow key (`ESC [ A`) would type `[A` into the pattern.
 */
function typeText(query: string, sequence: string | undefined): PromptKeyResult {
  if (sequence === undefined || sequence.length === 0) {
    return { kind: "ignore" };
  }

  let submits = false;
  for (const character of sequence) {
    if (character === "\r" || character === "\n") {
      // A pasted newline means the same thing typing Enter does.
      submits = true;
      continue;
    }

    if (!isPrintable(character)) {
      return { kind: "ignore" };
    }
  }

  const next = query + sequence.replaceAll(/[\r\n]/g, "");
  if (!submits) {
    return { kind: "edit", query: next };
  }

  return next.trim().length === 0 ? { kind: "cancel" } : { kind: "submit", query: next };
}

/** Backspace, where emptying the buffer leaves the search entirely. */
function backspace(query: string): PromptKeyResult {
  return query.length === 0 ? { kind: "cancel" } : { kind: "edit", query: query.slice(0, -1) };
}

/** Drop the trailing word, plus whatever whitespace led up to it. */
function deleteWord(query: string) {
  return query.replace(/\S+\s*$/, "");
}

/** True for one character a terminal reports as literal text. */
function isPrintable(character: string) {
  const code = character.codePointAt(0);
  // Below 0x20 is a control code and 0x7f is DEL; everything above is text,
  // including the non-ASCII characters a pattern may legitimately contain.
  return code !== undefined && code >= 0x20 && code !== 0x7f;
}

/** Render the prompt exactly as `less` shows it: the `/` sigil, then the buffer. */
export function formatPromptLine(query: string) {
  return `/${query}`;
}
