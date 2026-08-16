import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import {
  buildFileOrder,
  collectFileMatchMarks,
  compileQuery,
  findTargets,
  parsePatchLines,
  stepToTarget,
} from "../src/search";
import { createSearchSession, formatOutcome } from "../src/session";

/** Build a minimal reviewed-file view carrying real patch text. */
function createTestFile(id: string, path: string, patch: string): ExtensionDiffFile {
  return {
    id,
    path,
    patch,
    stats: { additions: 0, deletions: 0 },
    metadata: {},
    agent: null,
  };
}

const alpha = createTestFile(
  "file-0",
  "src/alpha.ts",
  [
    "diff --git a/src/alpha.ts b/src/alpha.ts",
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -10,3 +10,4 @@ function alpha() {",
    " const keep = 1;",
    "-const removed = readConfig();",
    "+const added = readConfig();",
    "+const second = readConfig();",
    "@@ -40,2 +41,2 @@",
    " untouched",
    "+const late = 2;",
  ].join("\n"),
);

const beta = createTestFile(
  "file-1",
  "src/beta.ts",
  ["@@ -1,2 +1,2 @@", " context", "+readConfig();"].join("\n"),
);

describe("parsePatchLines", () => {
  test("numbers both sides and groups lines by hunk", () => {
    const lines = parsePatchLines(alpha.patch);

    expect(lines.map((line) => [line.hunkIndex, line.side, line.lineNumber, line.text])).toEqual([
      [0, "new", 10, "const keep = 1;"],
      [0, "old", 11, "const removed = readConfig();"],
      [0, "new", 11, "const added = readConfig();"],
      [0, "new", 12, "const second = readConfig();"],
      [1, "new", 41, "untouched"],
      [1, "new", 42, "const late = 2;"],
    ]);
  });

  test("skips file headers and no-newline markers", () => {
    const lines = parsePatchLines(
      [
        "diff --git a/x b/x",
        "index 1..2",
        "@@ -1 +1 @@",
        "+only",
        "\\ No newline at end of file",
      ].join("\n"),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("only");
  });
});

describe("compileQuery", () => {
  test("is case-insensitive until the query carries uppercase", () => {
    const lower = compileQuery("readconfig", "literal");
    const upper = compileQuery("ReadConfig", "literal");

    expect(lower.ok && lower.locate("const x = ReadConfig();")).toEqual([10, 20]);
    expect(upper.ok && upper.locate("const x = readconfig();")).toBeNull();
  });

  test("literal mode does not interpret regex metacharacters", () => {
    const compiled = compileQuery("readConfig(", "literal");

    expect(compiled.ok && compiled.locate("readConfig();")).toEqual([0, 11]);
  });

  test("regex mode compiles patterns and reports bad ones", () => {
    const compiled = compileQuery("read(Config|Value)", "regex");
    expect(compiled.ok && compiled.locate("a readValue()")).toEqual([2, 11]);

    const broken = compileQuery("read(", "regex");
    expect(broken.ok).toBe(false);
  });

  test("a zero-width regex match still marks a visible position", () => {
    const compiled = compileQuery("^", "regex");

    expect(compiled.ok && compiled.locate("anything")).toEqual([0, 1]);
  });

  test("an empty query is refused", () => {
    expect(compileQuery("   ", "literal").ok).toBe(false);
  });
});

describe("findTargets", () => {
  test("collapses every match in a hunk into one target, in stream order", () => {
    const compiled = compileQuery("readConfig", "literal");
    if (!compiled.ok) throw new Error("query should compile");

    const targets = findTargets([alpha, beta], compiled.locate);

    expect(
      targets.map((target) => [
        target.path,
        target.hunkIndex,
        target.count,
        target.line.lineNumber,
      ]),
    ).toEqual([
      ["src/alpha.ts", 0, 3, 11],
      ["src/beta.ts", 0, 1, 2],
    ]);
  });

  test("skips files with no patch text", () => {
    const compiled = compileQuery("anything", "literal");
    if (!compiled.ok) throw new Error("query should compile");

    expect(findTargets([createTestFile("file-0", "bin.png", "")], compiled.locate)).toEqual([]);
  });
});

describe("stepToTarget", () => {
  const compiled = compileQuery("readConfig", "literal");
  if (!compiled.ok) throw new Error("query should compile");
  const files = [alpha, beta];
  const targets = findTargets(files, compiled.locate);
  const order = buildFileOrder(files);

  test("moves strictly forward from the current hunk", () => {
    expect(stepToTarget(targets, order, { fileId: "file-0", hunkIndex: 0 }, "forward")).toEqual({
      index: 1,
      wrapped: false,
    });
  });

  test("wraps at the end and reports it", () => {
    expect(stepToTarget(targets, order, { fileId: "file-1", hunkIndex: 0 }, "forward")).toEqual({
      index: 0,
      wrapped: true,
    });
  });

  test("walks backward and wraps at the start", () => {
    expect(stepToTarget(targets, order, { fileId: "file-1", hunkIndex: 0 }, "backward")).toEqual({
      index: 0,
      wrapped: false,
    });
    expect(stepToTarget(targets, order, { fileId: "file-0", hunkIndex: 0 }, "backward")).toEqual({
      index: 1,
      wrapped: true,
    });
  });

  test("a file selected with no hunk finds that file's own first match", () => {
    expect(stepToTarget(targets, order, { fileId: "file-0", hunkIndex: null }, "forward")).toEqual({
      index: 0,
      wrapped: false,
    });
  });

  test("no selection starts at the end the direction implies", () => {
    expect(stepToTarget(targets, order, { fileId: null, hunkIndex: null }, "forward")).toEqual({
      index: 0,
      wrapped: false,
    });
    expect(stepToTarget(targets, order, { fileId: null, hunkIndex: null }, "backward")).toEqual({
      index: 1,
      wrapped: false,
    });
  });

  test("an empty target list has nowhere to go", () => {
    expect(stepToTarget([], order, { fileId: "file-0", hunkIndex: 0 }, "forward")).toBeNull();
  });
});

describe("search session", () => {
  test("a fresh search jumps forward from the current position", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);

    const outcome = session.search("readConfig", { fileId: "file-0", hunkIndex: 0 });

    expect(outcome).toMatchObject({ kind: "moved", index: 2, total: 2, wrapped: false });
    expect(outcome.kind === "moved" && outcome.target.path).toBe("src/beta.ts");
  });

  test("n and N walk the same list in both directions", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);
    session.search("readConfig", { fileId: null, hunkIndex: null });

    expect(session.repeat("forward", { fileId: "file-0", hunkIndex: 0 })).toMatchObject({
      index: 2,
    });
    expect(session.repeat("backward", { fileId: "file-1", hunkIndex: 0 })).toMatchObject({
      index: 1,
    });
  });

  test("a query with no matches reports itself instead of moving", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);

    expect(session.search("nowhere", { fileId: null, hunkIndex: null })).toEqual({
      kind: "no-matches",
      query: "nowhere",
    });
  });

  test("repeating before any search says so", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);

    expect(session.repeat("forward", { fileId: null, hunkIndex: null })).toEqual({
      kind: "no-query",
    });
  });

  test("an invalid query leaves the previous one repeatable", () => {
    const session = createSearchSession({ mode: "regex" });
    session.setFiles([alpha, beta]);
    session.search("readConfig", { fileId: null, hunkIndex: null });

    expect(session.search("read(", { fileId: null, hunkIndex: null }).kind).toBe("invalid-query");
    expect(session.query).toBe("readConfig");
    expect(session.repeat("forward", { fileId: null, hunkIndex: null })).toMatchObject({
      kind: "moved",
    });
  });

  test("a reload re-matches the live query against the new changeset", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);
    session.search("readConfig", { fileId: null, hunkIndex: null });
    expect(session.total).toBe(2);

    session.setFiles([beta]);

    expect(session.total).toBe(1);
    expect(session.repeat("forward", { fileId: null, hunkIndex: null })).toMatchObject({
      kind: "moved",
      index: 1,
      total: 1,
    });
  });
});

describe("collectFileMatchMarks", () => {
  const compiled = compileQuery("readConfig", "literal");
  if (!compiled.ok) throw new Error("query should compile");

  test("marks every matching line on its own side with the matched extent", () => {
    const marks = collectFileMatchMarks(alpha, compiled.locate, null);

    expect(marks).toEqual([
      { side: "old", line: 11, range: [16, 26], tone: "match" },
      { side: "new", line: 11, range: [14, 24], tone: "match" },
      { side: "new", line: 12, range: [15, 25], tone: "match" },
    ]);
  });

  test("gives the active target's quoted line the one current mark", () => {
    const marks = collectFileMatchMarks(alpha, compiled.locate, {
      fileId: "file-0",
      hunkIndex: 0,
      lineOffset: 1,
    });

    expect(marks.map((mark) => mark.tone)).toEqual(["current", "match", "match"]);
  });

  test("a current target in another file marks nothing current here", () => {
    const marks = collectFileMatchMarks(alpha, compiled.locate, {
      fileId: "file-1",
      hunkIndex: 0,
      lineOffset: 1,
    });

    expect(marks.every((mark) => mark.tone === "match")).toBe(true);
  });
});

describe("session marks", () => {
  test("paints nothing before the first search and marks after it", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);

    expect(session.marksFor(alpha)).toBeNull();

    session.search("readConfig", { fileId: null, hunkIndex: null });

    const alphaMarks = session.marksFor(alpha);
    expect(alphaMarks?.map((mark) => mark.tone)).toEqual(["current", "match", "match"]);
    expect(session.marksFor(beta)?.map((mark) => mark.tone)).toEqual(["match"]);
  });

  test("the current mark follows n across files", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);
    session.search("readConfig", { fileId: null, hunkIndex: null });

    session.repeat("forward", { fileId: "file-0", hunkIndex: 0 });

    expect(session.marksFor(alpha)?.every((mark) => mark.tone === "match")).toBe(true);
    expect(session.marksFor(beta)?.map((mark) => mark.tone)).toEqual(["current"]);
  });

  test("a reload keeps the query but drops the orphaned current mark", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);
    session.search("readConfig", { fileId: null, hunkIndex: null });

    session.setFiles([alpha, beta]);

    expect(session.marksFor(alpha)?.every((mark) => mark.tone === "match")).toBe(true);
  });
});

describe("formatOutcome", () => {
  test("a match reads like a less status line", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);

    const outcome = session.search("readConfig", { fileId: null, hunkIndex: null });

    expect(formatOutcome(outcome)).toEqual({
      message: "[1/2] src/alpha.ts:11 (+2 in hunk) — const removed = readConfig();",
      type: "info",
    });
  });

  test("a wrap and a miss are both said out loud", () => {
    const session = createSearchSession({ mode: "literal" });
    session.setFiles([alpha, beta]);
    session.search("readConfig", { fileId: null, hunkIndex: null });

    expect(
      formatOutcome(session.repeat("forward", { fileId: "file-1", hunkIndex: 0 })).message,
    ).toContain("wrapped");
    expect(formatOutcome({ kind: "no-matches", query: "zzz" })).toEqual({
      message: 'No match for "zzz"',
      type: "warning",
    });
  });
});
