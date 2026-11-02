// Runs and sessions in the renderer: the run store plus each cell's output pane, fed
// by the main process's events whether or not the runbook is shown.
// Components read the store and call the actions; they own none of this state, so
// switching runbooks loses nothing.
//
// The API and the pane are injected (window.api and OutputPane in the renderer), so
// this is tested in plain Node with fakes.

import type { CellOutputEvent, CellStatusEvent, SessionStateEvent } from "../../../preload/api";
import { messageOf } from "./errors";
import { createRunStore, type RunsByRunbook, type RunStore } from "./run-store";

// What the tracker needs from an output pane.
export interface TrackedPane {
  readonly size: { cols: number; rows: number };
  clear(): void;
  write(data: string): void;
  hideCursor(): void;
  setRunning(running: boolean): void;
  offerFocus(): void;
  dispose(): void;
}

export interface PaneCallbacks {
  onInput: (data: string) => void;
  onResize: (size: { cols: number; rows: number }) => void;
}

// The part of window.api the tracker uses.
export interface RunApi {
  runCell(runbookPath: string, cellId: string, source: string): Promise<void>;
  cancelCell(runbookPath: string, cellId: string): Promise<void>;
  sendInput(runbookPath: string, data: string): Promise<void>;
  resizeSession(runbookPath: string, cols: number, rows: number): Promise<void>;
  closeSession(runbookPath: string): Promise<void>;
  onCellOutput(callback: (event: CellOutputEvent) => void): () => void;
  onCellStatus(callback: (event: CellStatusEvent) => void): () => void;
  onSessionState(callback: (event: SessionStateEvent) => void): () => void;
}

export interface RunTracker<P extends TrackedPane> {
  runs: RunStore;
  // The cell's pane, if it has run in this window.
  existingPane(runbookPath: string, cellId: string): P | undefined;
  paneFor(runbookPath: string, cellId: string): P;
  // Subscribes to the main process's events, once, for the window's lifetime.
  start(): void;
  // Runs a cell; resolves once the run has ended. Call it with the cell's pane already
  // attached (paneFor + attach), so the shell can be sized to it first.
  runCell(runbookPath: string, cellId: string, source: string): Promise<void>;
  stopCell(runbookPath: string, cellId: string): void;
  // Ends the runbook's shell and what runs in it (the sidebar's "Clear session"): its
  // running cell ends interrupted, and the next run starts a new session. Main reports
  // no state for a session closed on purpose, so the store drops it here.
  closeSession(runbookPath: string): Promise<void>;
  // Frees everything kept for a deleted cell: its pane and its run-store entry.
  forgetCell(runbookPath: string, cellId: string): void;
  // Moves a renamed runbook's panes and run state to its new path. Call it
  // as soon as main's rename reply arrives, before awaiting anything else.
  renameRunbook(from: string, to: string): void;
  // Frees everything kept for a deleted runbook.
  forgetRunbook(runbookPath: string): void;
  // Frees everything, for every runbook (the runbooks folder changed, and main closed
  // every shell). Late events from those shells are dropped.
  forgetAll(): void;
  // A runbook now lives at `path` (just created there): events for it are its own,
  // not a renamed runbook's that used to live there.
  claimPath(path: string): void;
}

// A NUL can't appear in a path, so it can't make two keys collide.
function key(runbookPath: string, cellId: string): string {
  return `${runbookPath}\0${cellId}`;
}

export function createRunTracker<P extends TrackedPane>(
  api: RunApi,
  createPane: (callbacks: PaneCallbacks) => P,
): RunTracker<P> {
  const runs = createRunStore();
  // Output panes by runbook path, then cell ID. Created on a cell's first run and
  // kept for the window's lifetime, so their output survives switching runbooks.
  const panes = new Map<string, Map<string, P>>();
  // Cells whose Stop came before their run request reached main (see runCell).
  const stoppedEarly = new Set<string>();
  // Deleted cells. Their run may still be ending, or a background job they started may
  // still print; their events are dropped so nothing is recreated for them. Cell IDs
  // are never reused, so the set only grows by one per deleted cell that had run.
  const forgotten = new Set<string>();
  // Old paths of renamed runbooks, to their new ones. Events main sent before the
  // rename (output it was still batching), runs requested before it, and panes
  // created before it all still name the old path.
  const renamedTo = new Map<string, string>();

  function currentPath(path: string): string {
    let current = path;
    for (let hops = 0; renamedTo.has(current) && hops < 100; hops++) {
      current = renamedTo.get(current) ?? current;
    }
    return current;
  }

  // The store's latest value, for the checks on every keystroke and output chunk.
  let latest: RunsByRunbook = {};
  runs.subscribe((all) => {
    latest = all;
  });

  const isRunning = (runbookPath: string, cellId: string): boolean =>
    latest[runbookPath]?.cells[cellId]?.status?.state === "running";
  const isForgotten = (runbookPath: string, cellId: string): boolean =>
    forgotten.has(key(runbookPath, cellId));

  function existingPane(runbookPath: string, cellId: string): P | undefined {
    return panes.get(runbookPath)?.get(cellId);
  }

  function paneFor(runbookPath: string, cellId: string): P {
    const existing = existingPane(runbookPath, cellId);
    if (existing) return existing;
    const pane = createPane({
      // Only the running cell's pane types into the shell.
      onInput: (data) => {
        const path = currentPath(runbookPath);
        if (isRunning(path, cellId)) void api.sendInput(path, data);
      },
      onResize: ({ cols, rows }) => {
        const path = currentPath(runbookPath);
        if (isRunning(path, cellId)) void api.resizeSession(path, cols, rows);
      },
    });
    let runbookPanes = panes.get(runbookPath);
    if (!runbookPanes) panes.set(runbookPath, (runbookPanes = new Map()));
    runbookPanes.set(cellId, pane);
    return pane;
  }

  function forgetRunbook(runbookPath: string): void {
    const runbookPanes = panes.get(runbookPath);
    // Like forgetCell for each cell that ran: its last events may still be on the way.
    for (const [cellId, pane] of runbookPanes ?? []) {
      forgotten.add(key(runbookPath, cellId));
      pane.dispose();
    }
    panes.delete(runbookPath);
    runs.forgetRunbook(runbookPath);
  }

  return {
    runs,
    existingPane,
    paneFor,

    start() {
      api.onCellStatus((sent) => {
        const event = { ...sent, runbookPath: currentPath(sent.runbookPath) };
        const { cellId, state } = event.status;
        if (isForgotten(event.runbookPath, cellId)) return;
        const pane =
          state === "running"
            ? paneFor(event.runbookPath, cellId)
            : existingPane(event.runbookPath, cellId);
        if (state === "running") pane?.clear();
        if (state === "success" || state === "failed" || state === "interrupted") {
          pane?.hideCursor();
        }
        pane?.setRunning(state === "running");
        runs.onStatus(event);
      });
      api.onCellOutput((sent) => {
        const { cellId, data } = sent;
        const runbookPath = currentPath(sent.runbookPath);
        if (isForgotten(runbookPath, cellId)) return;
        const pane = existingPane(runbookPath, cellId);
        pane?.write(data);
        // A running cell may be waiting for input (a password, [Y/n]).
        if (isRunning(runbookPath, cellId)) pane?.offerFocus();
      });
      api.onSessionState((event) =>
        runs.onSessionState({ ...event, runbookPath: currentPath(event.runbookPath) }),
      );
    },

    async runCell(requestedPath, cellId, source) {
      // The runbook may be renamed while this runs: always use its current path.
      const path = (): string => currentPath(requestedPath);
      stoppedEarly.delete(key(path(), cellId));
      runs.setRequested(path(), cellId, true);
      runs.setError(path(), cellId, null);
      try {
        // Every pane in a runbook has the same width, so sizing the shell to this one
        // is right even if another cell is still running ahead of it.
        const { cols, rows } = paneFor(path(), cellId).size;
        await api.resizeSession(path(), cols, rows);
        // A Stop clicked meanwhile found nothing to cancel in main yet.
        if (stoppedEarly.has(key(path(), cellId))) return;
        await api.runCell(path(), cellId, source);
      } catch (cause) {
        if (!isForgotten(path(), cellId)) runs.setError(path(), cellId, messageOf(cause));
      } finally {
        stoppedEarly.delete(key(path(), cellId));
        // The cell may have been deleted while its run went on.
        if (!isForgotten(path(), cellId)) runs.setRequested(path(), cellId, false);
      }
    },

    stopCell(requestedPath, cellId) {
      const path = currentPath(requestedPath);
      stoppedEarly.add(key(path, cellId));
      api.cancelCell(path, cellId).catch((cause: unknown) => {
        const now = currentPath(path);
        if (!isForgotten(now, cellId)) runs.setError(now, cellId, messageOf(cause));
      });
    },

    async closeSession(requestedPath) {
      await api.closeSession(currentPath(requestedPath));
      // The runbook may have been renamed while main closed it.
      runs.clearSession(currentPath(requestedPath));
    },

    forgetCell(runbookPath, cellId) {
      const pane = existingPane(runbookPath, cellId);
      // Only a cell that has run can still get events: its pane is created when Run is
      // clicked, before the request goes out.
      if (pane) forgotten.add(key(runbookPath, cellId));
      pane?.dispose();
      panes.get(runbookPath)?.delete(cellId);
      runs.forgetCell(runbookPath, cellId);
    },

    renameRunbook(from, to) {
      if (from === to) return;
      renamedTo.delete(to);
      renamedTo.set(from, to);
      const moved = panes.get(from);
      panes.delete(from);
      if (moved) panes.set(to, moved);
      // Copies: the loops add to the sets they walk.
      for (const id of Array.from(forgotten)) {
        if (!id.startsWith(`${from}\0`)) continue;
        forgotten.delete(id);
        forgotten.add(`${to}${id.slice(from.length)}`);
      }
      for (const id of Array.from(stoppedEarly)) {
        if (!id.startsWith(`${from}\0`)) continue;
        stoppedEarly.delete(id);
        stoppedEarly.add(`${to}${id.slice(from.length)}`);
      }
      runs.renameRunbook(from, to);
    },

    claimPath(path) {
      renamedTo.delete(path);
    },

    forgetRunbook,

    forgetAll() {
      for (const path of new Set([...panes.keys(), ...Object.keys(latest)])) forgetRunbook(path);
      renamedTo.clear();
    },
  };
}
