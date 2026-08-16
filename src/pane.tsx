/**
 * The one-row prompt line, docked at the bottom edge.
 *
 * This is the half of the feature a pane can do: it paints, and it holds live
 * navigation actions. It receives no keys — pane props carry no key events at
 * all — so the typing happens in the keyboard mode and arrives here through the
 * store.
 *
 * It is also the only mounted surface the keyboard mode can reach, which is why
 * it performs the jump the mode asked for: `ExtensionKeyboardModeContext`
 * exposes no navigation, `ExtensionPaneActions` does.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ExtensionPaneActions, ExtensionPaneProps } from "hunkdiff/extension";
import { formatPromptLine } from "./prompt";
import {
  completeNavigation,
  getSnapshot,
  performNavigation,
  setSelection,
  subscribe,
} from "./store";

/** Idle hint, shown before the first search of the session. */
const IDLE_HINT = "/ search  ·  n next  ·  N previous";

/** Bridge module-level prompt state into React. */
function usePromptSnapshot() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function SearchPromptLine(props: ExtensionPaneProps) {
  const snapshot = usePromptSnapshot();

  // Actions are stable only for the current render, so the navigation effect
  // reads them through a ref instead of depending on their identity — otherwise
  // every repaint would re-run the jump.
  const actions = useRef<ExtensionPaneActions>(props.actions);
  actions.current = props.actions;

  // The keyboard mode has no selection of its own; the painted frame does.
  useEffect(() => {
    setSelection({ fileId: props.selectedFileId, hunkIndex: props.selectedHunkIndex });
  }, [props.selectedFileId, props.selectedHunkIndex]);

  // Perform the jump the mode asked for, exactly once per request token.
  const pending = snapshot.pending;
  useEffect(() => {
    if (pending === null) {
      return;
    }

    completeNavigation(pending.token);
    // Pane actions extend the same navigation interface a command handler gets,
    // so the mode's deferred jump lands exactly where an `n` press would.
    performNavigation(actions.current, pending);
  }, [pending]);

  const { text, color } = resolveLine(snapshot, props.theme);

  return (
    <box style={{ width: props.width, height: props.height, backgroundColor: props.theme.panel }}>
      <text content={clip(text, props.width)} style={{ fg: color, bg: props.theme.panel }} />
    </box>
  );
}

/** Decide what the single row says, and in which semantic color. */
function resolveLine(snapshot: ReturnType<typeof getSnapshot>, theme: ExtensionPaneProps["theme"]) {
  if (snapshot.prompting) {
    // A block character stands in for a cursor: a pane paints, so there is no
    // real terminal cursor to place here.
    return { text: `${formatPromptLine(snapshot.query)}█`, color: theme.text };
  }

  if (snapshot.status) {
    return {
      text: snapshot.status.message,
      color: snapshot.status.tone === "warning" ? theme.badgeRemoved : theme.muted,
    };
  }

  return { text: IDLE_HINT, color: theme.muted };
}

/** Clip to the exact host-owned rectangle; a pane may not overflow its width. */
function clip(text: string, width: number) {
  return text.length <= width ? text : text.slice(0, Math.max(0, width));
}
