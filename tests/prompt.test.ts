import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionDiffFile, ExtensionKeyEvent } from "hunkdiff/extension";
import { applyPromptKey, formatPromptLine } from "../src/prompt";
import { createSearchSession } from "../src/session";
import {
  beginPrompt,
  deliverOutcome,
  endPrompt,
  getSnapshot,
  completeNavigation,
  readSelection,
  resetStore,
  setQuery,
  setSelection,
  subscribe,
} from "../src/store";

/** One typed character, as a terminal reports it. */
function typed(sequence: string): ExtensionKeyEvent {
  return { name: sequence, sequence };
}

describe("applyPromptKey", () => {
  test("printable characters extend the buffer, including symbols and unicode", () => {
    expect(applyPromptKey("read", typed("C"))).toEqual({ kind: "edit", query: "readC" });
    expect(applyPromptKey("read", typed("("))).toEqual({ kind: "edit", query: "read(" });
    expect(applyPromptKey("caf", typed("é"))).toEqual({ kind: "edit", query: "café" });
  });

  test("space arrives as a named key rather than a sequence", () => {
    expect(applyPromptKey("const", { name: "space", sequence: " " })).toEqual({
      kind: "edit",
      query: "const ",
    });
  });

  test("enter submits, and an all-whitespace buffer is a change of mind", () => {
    expect(applyPromptKey("readConfig", { name: "enter" })).toEqual({
      kind: "submit",
      query: "readConfig",
    });
    expect(applyPromptKey("   ", { name: "enter" })).toEqual({ kind: "cancel" });
  });

  test("backspace edits until the buffer empties, then backs out of the search", () => {
    expect(applyPromptKey("ab", { name: "backspace" })).toEqual({ kind: "edit", query: "a" });
    expect(applyPromptKey("", { name: "backspace" })).toEqual({ kind: "cancel" });
  });

  test("readline-style control keys clear, delete a word, and abandon", () => {
    expect(applyPromptKey("read config", { name: "u", ctrl: true })).toEqual({
      kind: "edit",
      query: "",
    });
    expect(applyPromptKey("read config", { name: "w", ctrl: true })).toEqual({
      kind: "edit",
      query: "read ",
    });
    expect(applyPromptKey("read", { name: "c", ctrl: true })).toEqual({ kind: "cancel" });
    expect(applyPromptKey("read", { name: "g", ctrl: true })).toEqual({ kind: "cancel" });
  });

  test("a multi-character chunk is text, because terminals coalesce input", () => {
    // A fast typist, a coalesced read, and a paste all arrive this way.
    expect(applyPromptKey("beta", { name: "V", sequence: "Value" })).toEqual({
      kind: "edit",
      query: "betaValue",
    });
  });

  test("a pasted newline submits the pattern it completes", () => {
    expect(applyPromptKey("", { sequence: "readConfig\n" })).toEqual({
      kind: "submit",
      query: "readConfig",
    });
  });

  test("an escape sequence is refused whole, never typed as its letters", () => {
    // The bug this guards: filtering the ESC out of an arrow key would leave
    // `[A` to be typed into the pattern.
    expect(applyPromptKey("read", { name: "up", sequence: "\u001b[A" })).toEqual({
      kind: "ignore",
    });
  });

  test("keys the prompt does not understand are consumed, not passed", () => {
    // Passing them would scroll the review out from under a half-typed pattern.
    expect(applyPromptKey("read", { name: "pagedown" })).toEqual({ kind: "ignore" });
    expect(applyPromptKey("read", { name: "up" })).toEqual({ kind: "ignore" });
    expect(applyPromptKey("read", { name: "d", ctrl: true })).toEqual({ kind: "ignore" });
    expect(applyPromptKey("read", { name: "v", meta: true })).toEqual({ kind: "ignore" });
  });

  test("the line reads like the less prompt it imitates", () => {
    expect(formatPromptLine("readConfig")).toBe("/readConfig");
  });
});

const file: ExtensionDiffFile = {
  id: "file-0",
  path: "src/alpha.ts",
  patch: ["@@ -1,2 +1,2 @@", " keep", "+const added = readConfig();"].join("\n"),
  stats: { additions: 1, deletions: 0 },
  metadata: {},
  agent: null,
};

/** The same match under a header no line numbers can be read from. */
const unnumberedFile: ExtensionDiffFile = {
  ...file,
  id: "file-1",
  path: "src/beta.ts",
  patch: ["@@ nonsense @@", " keep", "+const added = readConfig();"].join("\n"),
};

/** Record which navigation method a jump chose, and with what arguments. */
function createTestNavigation() {
  const jumps: Array<[string, ...Array<string | number>]> = [];
  return {
    jumps,
    navigation: {
      selectFile: (fileId: string) => jumps.push(["selectFile", fileId]),
      selectHunk: (fileId: string, hunkIndex: number) =>
        jumps.push(["selectHunk", fileId, hunkIndex]),
      revealLine: (fileId: string, side: "old" | "new", line: number) =>
        jumps.push(["revealLine", fileId, side, line]),
    },
  };
}

describe("prompt store", () => {
  beforeEach(() => {
    resetStore();
  });

  test("typing publishes a new snapshot to subscribers", () => {
    let notifications = 0;
    subscribe(() => {
      notifications += 1;
    });

    beginPrompt();
    setQuery("read");

    expect(getSnapshot()).toMatchObject({ prompting: true, query: "read" });
    expect(notifications).toBe(2);
  });

  test("the selection mirror is not part of the painted snapshot", () => {
    let notifications = 0;
    subscribe(() => {
      notifications += 1;
    });

    setSelection({ fileId: "file-0", hunkIndex: 2 });

    // Review navigation must not repaint the prompt line.
    expect(notifications).toBe(0);
    expect(readSelection()).toEqual({ fileId: "file-0", hunkIndex: 2 });
  });

  test("a mode submit leaves the jump pending for the mounted prompt line", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([file]);

    deliverOutcome(session.search("readConfig", { fileId: null, hunkIndex: null }), null);

    const pending = getSnapshot().pending;
    // The line target rides along, so the prompt line's deferred jump is as
    // exact as an `n` press would have been.
    expect(pending).toMatchObject({
      fileId: "file-0",
      hunkIndex: 0,
      line: { side: "new", number: 2 },
    });
    expect(getSnapshot().status?.message).toContain("[1/1] src/alpha.ts:2");

    // The token retires the request, so a repaint cannot replay the jump.
    completeNavigation(pending!.token);
    expect(getSnapshot().pending).toBeNull();
    completeNavigation(pending!.token);
    expect(getSnapshot().pending).toBeNull();
  });

  test("a command submit reveals the matched line and leaves nothing pending", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([file]);
    session.search("readConfig", { fileId: null, hunkIndex: null });
    const { navigation, jumps } = createTestNavigation();

    deliverOutcome(session.repeat("forward", { fileId: "file-0", hunkIndex: 0 }), navigation);

    expect(jumps).toEqual([["revealLine", "file-0", "new", 2]]);
    expect(getSnapshot().pending).toBeNull();
  });

  test("a match the patch never numbered still jumps, by hunk", () => {
    // A malformed `@@` header leaves the line unnumbered; `revealLine` has
    // nothing to address, so the hunk is the honest target.
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([unnumberedFile]);
    session.search("readConfig", { fileId: null, hunkIndex: null });
    const { navigation, jumps } = createTestNavigation();

    deliverOutcome(session.repeat("forward", { fileId: "file-1", hunkIndex: 0 }), navigation);

    expect(jumps).toEqual([["selectHunk", "file-1", 0]]);
  });

  test("a miss updates the status line without asking for a jump", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([file]);

    deliverOutcome(session.search("nowhere", { fileId: null, hunkIndex: null }), null);

    expect(getSnapshot().pending).toBeNull();
    expect(getSnapshot().status).toEqual({
      message: 'No match for "nowhere"',
      tone: "warning",
    });
  });

  test("closing the prompt clears the buffer but keeps the status visible", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([file]);

    beginPrompt();
    setQuery("readConfig");
    deliverOutcome(session.search("readConfig", { fileId: null, hunkIndex: null }), null);
    endPrompt();

    expect(getSnapshot()).toMatchObject({ prompting: false, query: "" });
    expect(getSnapshot().status?.message).toContain("[1/1]");
  });
});
