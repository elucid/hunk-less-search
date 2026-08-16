/**
 * The stateful half of less-style search: one query, one target list, one
 * cursor into it.
 *
 * Kept out of `index.ts` so the interesting transitions — a fresh query, a
 * repeat in either direction, a reload replacing the changeset under a live
 * query — are ordinary functions a unit test can drive without a host.
 */
import type { ExtensionDiffFile, ExtensionLineHighlight } from "hunkdiff/extension";
import {
  buildFileOrder,
  collectFileMatchMarks,
  compileQuery,
  findTargets,
  stepToTarget,
  type SearchDirection,
  type SearchMode,
  type SearchPosition,
  type SearchTarget,
} from "./search";

/** What a search or repeat asks the host to do. */
export type SearchOutcome =
  | { kind: "moved"; target: SearchTarget; index: number; total: number; wrapped: boolean }
  | { kind: "no-matches"; query: string }
  | { kind: "no-query" }
  | { kind: "invalid-query"; query: string; error: string };

export interface SearchSessionOptions {
  mode: SearchMode;
}

export interface SearchSession {
  /** The active query, or `null` before the first successful search. */
  readonly query: string | null;
  /** How many hunks the active query matches. */
  readonly total: number;
  /** Replace the searched changeset, recomputing targets for the live query. */
  setFiles(files: readonly ExtensionDiffFile[]): void;
  /** Run a new query from `position`, like typing `/pattern` in `less`. */
  search(query: string, position: SearchPosition): SearchOutcome;
  /** Repeat the active query, like `n` / `N`. */
  repeat(direction: SearchDirection, position: SearchPosition): SearchOutcome;
  /**
   * The diff marks the active query paints on one file, for the registered
   * line highlighter. `null` before the first search, so an idle session
   * paints nothing.
   */
  marksFor(file: ExtensionDiffFile): ExtensionLineHighlight[] | null;
}

/**
 * Create one search session for the life of the extension.
 *
 * The session outlives reloads on purpose: a factory re-runs only on a trust
 * grant or a cwd change, so `n` still works after the watcher rebuilds the
 * review — the query is re-matched against the new files rather than dropped.
 * File ids encode changeset position, so the target list is always rebuilt from
 * the new files rather than reconciled against the old ones.
 */
export function createSearchSession(options: SearchSessionOptions): SearchSession {
  let files: readonly ExtensionDiffFile[] = [];
  let fileOrder = new Map<string, number>();
  let query: string | null = null;
  let targets: SearchTarget[] = [];
  // The target the review last jumped to — what marksFor paints as "current".
  let current: SearchTarget | null = null;

  /** Recompute the target list for the current query and files. */
  function refreshTargets() {
    // A rebuilt target list orphans the old current target: its file object,
    // hunk indexes, and even its existence may have changed with the review.
    current = null;
    if (query === null) {
      targets = [];
      return;
    }

    const compiled = compileQuery(query, options.mode);
    targets = compiled.ok ? findTargets(files, compiled.locate) : [];
  }

  function move(direction: SearchDirection, position: SearchPosition): SearchOutcome {
    if (query === null) {
      return { kind: "no-query" };
    }

    if (targets.length === 0) {
      return { kind: "no-matches", query };
    }

    const step = stepToTarget(targets, fileOrder, position, direction);
    const target = step === null ? undefined : targets[step.index];
    if (step === null || !target) {
      return { kind: "no-matches", query };
    }

    current = target;
    return {
      kind: "moved",
      target,
      index: step.index + 1,
      total: targets.length,
      wrapped: step.wrapped,
    };
  }

  return {
    get query() {
      return query;
    },
    get total() {
      return targets.length;
    },
    setFiles(next) {
      files = next;
      fileOrder = buildFileOrder(next);
      refreshTargets();
    },
    search(raw, position) {
      const compiled = compileQuery(raw, options.mode);
      if (!compiled.ok) {
        // A bad query never clobbers a working one: the previous search stays
        // repeatable with `n`.
        return { kind: "invalid-query", query: raw, error: compiled.error };
      }

      query = raw.trim();
      targets = findTargets(files, compiled.locate);
      current = null;
      return move("forward", position);
    },
    repeat(direction, position) {
      return move(direction, position);
    },
    marksFor(file) {
      if (query === null) {
        return null;
      }

      const compiled = compileQuery(query, options.mode);
      if (!compiled.ok) {
        return null;
      }

      return collectFileMatchMarks(
        file,
        compiled.locate,
        current === null
          ? null
          : {
              fileId: current.fileId,
              hunkIndex: current.hunkIndex,
              lineOffset: current.line.offset,
            },
      );
    },
  };
}

/** Read the `[extension.<id>]` search mode, defaulting to literal text. */
export function readSearchMode(config: Record<string, unknown>): SearchMode {
  // Config can come from the repo under review, so it is treated as untrusted
  // input: anything but the one opt-in string falls back to literal matching.
  return config.mode === "regex" ? "regex" : "literal";
}

/** Render one outcome as the toast the user sees. */
export function formatOutcome(outcome: SearchOutcome): {
  message: string;
  type: "info" | "warning";
} {
  switch (outcome.kind) {
    case "moved": {
      const { target, index, total, wrapped } = outcome;
      const location =
        target.line.lineNumber === null ? target.path : `${target.path}:${target.line.lineNumber}`;
      const more = target.count > 1 ? ` (+${target.count - 1} in hunk)` : "";
      const wrap = wrapped ? " • wrapped" : "";
      return {
        message: `[${index}/${total}] ${location}${more}${wrap} — ${truncate(target.line.text.trim(), 60)}`,
        type: "info",
      };
    }
    case "no-matches":
      return { message: `No match for "${outcome.query}"`, type: "warning" };
    case "no-query":
      return { message: "No search yet — press / to search", type: "info" };
    case "invalid-query":
      return { message: `Bad search "${outcome.query}" • ${outcome.error}`, type: "warning" };
  }
}

/** Clip quoted source text so a toast stays one readable line. */
function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
