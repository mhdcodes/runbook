import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import type { CellOutputEvent, CellStatusEvent, SessionStateEvent } from "../src/preload/api";
import {
  createRunTracker,
  type PaneCallbacks,
  type RunApi,
  type TrackedPane,
} from "../src/renderer/src/state/run-tracker";
import type { RunState } from "../src/shared/types";

const NB = "/n/a.md";

class FakePane implements TrackedPane {
  readonly size = { cols: 83, rows: 25 };
  calls: string[] = [];
  constructor(readonly callbacks: PaneCallbacks) {}
  clear(): void {
    this.calls.push("clear");
  }
  write(data: string): void {
    this.calls.push(`write ${data}`);
  }
  hideCursor(): void {
    this.calls.push("hideCursor");
  }
  setRunning(running: boolean): void {
    this.calls.push(`running ${running}`);
  }
  offerFocus(): void {
    this.calls.push("offerFocus");
  }
  dispose(): void {
    this.calls.push("dispose");
  }
}

// A fake window.api: records the calls, and lets the test send the main process's events.
function setup(overrides: Partial<RunApi> = {}) {
  const calls: string[] = [];
  let onStatus: ((event: CellStatusEvent) => void) | undefined;
  let onOutput: ((event: CellOutputEvent) => void) | undefined;
  let onState: ((event: SessionStateEvent) => void) | undefined;
  const api: RunApi = {
    runCell: async (_path, cellId, source) => void calls.push(`run ${cellId} ${source}`),
    cancelCell: async (_path, cellId) => void calls.push(`cancel ${cellId}`),
    sendInput: async (_path, data) => void calls.push(`input ${data}`),
    resizeSession: async (_path, cols, rows) => void calls.push(`resize ${cols}x${rows}`),
    closeSession: async (path) => void calls.push(`close ${path}`),
    onCellStatus: (callback) => ((onStatus = callback), () => {}),
    onCellOutput: (callback) => ((onOutput = callback), () => {}),
    onSessionState: (callback) => ((onState = callback), () => {}),
    ...overrides,
  };
  const created: FakePane[] = [];
  const tracker = createRunTracker(api, (callbacks) => {
    const pane = new FakePane(callbacks);
    created.push(pane);
    return pane;
  });
  tracker.start();
  return {
    tracker,
    calls,
    created,
    status: (cellId: string, state: RunState) =>
      onStatus?.({ runbookPath: NB, status: { cellId, state } }),
    output: (cellId: string, data: string) => onOutput?.({ runbookPath: NB, cellId, data }),
    state: (event: SessionStateEvent) => onState?.(event),
  };
}

describe("run tracker: events", () => {
  it("clears the pane when a run starts and hides its cursor when it ends", () => {
    const { tracker, status } = setup();
    status("c1", "running");
    const pane = tracker.existingPane(NB, "c1");
    status("c1", "success");
    expect(pane?.calls).toEqual(["clear", "running true", "hideCursor", "running false"]);
    expect(get(tracker.runs)[NB]?.cells["c1"]?.status?.state).toBe("success");
  });

  it("creates a pane for a run that starts while its runbook isn't shown", () => {
    const { tracker, status } = setup();
    status("c1", "running");
    expect(tracker.existingPane(NB, "c1")).toBeDefined();
  });

  it("writes output to the cell's pane and offers it focus only while it runs", () => {
    const { tracker, status, output } = setup();
    status("c1", "running");
    output("c1", "Password: ");
    status("c1", "success");
    output("c1", "late");
    expect(tracker.existingPane(NB, "c1")?.calls).toEqual([
      "clear",
      "running true",
      "write Password: ",
      "offerFocus",
      "hideCursor",
      "running false",
      "write late",
    ]);
  });

  it("passes typing and resizes to the shell only while the cell runs", () => {
    const { tracker, calls, status } = setup();
    const pane = tracker.paneFor(NB, "c1") as FakePane;
    pane.callbacks.onInput("ignored");
    status("c1", "running");
    pane.callbacks.onInput("y\r");
    pane.callbacks.onResize({ cols: 90, rows: 25 });
    status("c1", "success");
    pane.callbacks.onInput("ignored too");
    expect(calls).toEqual(["input y\r", "resize 90x25"]);
  });

  it("keeps session states in the store", () => {
    const { tracker, state } = setup();
    state({ runbookPath: NB, state: "dead", end: { type: "exited", exitCode: 3 } });
    expect(get(tracker.runs)[NB]).toMatchObject({ session: "dead", end: { exitCode: 3 } });
  });
});

describe("run tracker: actions", () => {
  it("sizes the shell to the pane before running, and clears the request flag after", async () => {
    const { tracker, calls } = setup();
    const done = tracker.runCell(NB, "c1", "echo hi");
    expect(get(tracker.runs)[NB]?.cells["c1"]?.requested).toBe(true);
    await done;
    expect(calls).toEqual(["resize 83x25", "run c1 echo hi"]);
    expect(get(tracker.runs)[NB]?.cells["c1"]?.requested).toBe(false);
  });

  it("doesn't send a run stopped while the shell was being sized", async () => {
    const { tracker, calls } = setup();
    const done = tracker.runCell(NB, "c1", "echo never");
    tracker.stopCell(NB, "c1");
    await done;
    expect(calls).toEqual(["resize 83x25", "cancel c1"]);
  });

  it("shows a failed run request as the cell's error", async () => {
    const { tracker } = setup({
      runCell: () =>
        Promise.reject(
          new Error("Error invoking remote method 'cell:run': Error: Shell didn't start"),
        ),
    });
    await tracker.runCell(NB, "c1", "true");
    expect(get(tracker.runs)[NB]?.cells["c1"]).toMatchObject({
      requested: false,
      error: "Shell didn't start",
    });
  });
});

describe("run tracker: closing a session", () => {
  it("closes it in main, then shows the runbook as having no session", async () => {
    const { tracker, calls, state } = setup();
    state({ runbookPath: NB, state: "ready" });
    await tracker.closeSession(NB);
    expect(calls).toEqual([`close ${NB}`]);
    expect(get(tracker.runs)[NB]?.session).toBeNull();
  });

  it("clears the runbook under its new name if it was renamed meanwhile", async () => {
    let finish: (() => void) | undefined;
    const { tracker, state } = setup({
      closeSession: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    state({ runbookPath: NB, state: "ready" });
    const closing = tracker.closeSession(NB);
    tracker.renameRunbook(NB, "/n/b.md");
    finish?.();
    await closing;
    expect(get(tracker.runs)["/n/b.md"]?.session).toBeNull();
  });

  it("keeps the session when main fails to close it", async () => {
    const { tracker, state } = setup({
      closeSession: () => Promise.reject(new Error("nope")),
    });
    state({ runbookPath: NB, state: "ready" });
    await expect(tracker.closeSession(NB)).rejects.toThrow("nope");
    expect(get(tracker.runs)[NB]?.session).toBe("ready");
  });
});

describe("run tracker: deleting a cell", () => {
  it("disposes its pane, once, and drops its store entry", () => {
    const { tracker, status } = setup();
    status("c1", "running");
    status("c1", "success");
    const pane = tracker.existingPane(NB, "c1");
    tracker.forgetCell(NB, "c1");
    tracker.forgetCell(NB, "c1");
    expect(pane?.calls.filter((call) => call === "dispose")).toHaveLength(1);
    expect(tracker.existingPane(NB, "c1")).toBeUndefined();
    expect(get(tracker.runs)[NB]?.cells["c1"]).toBeUndefined();
  });

  it("ignores its late events, without recreating its pane or entry", () => {
    const { tracker, created, status, output } = setup();
    status("c1", "running");
    tracker.forgetCell(NB, "c1");
    status("c1", "interrupted");
    output("c1", "late");
    status("c1", "running");
    expect(created).toHaveLength(1);
    expect(tracker.existingPane(NB, "c1")).toBeUndefined();
    expect(get(tracker.runs)[NB]?.cells["c1"]).toBeUndefined();
  });

  it("doesn't bring back its entry when its run request ends after the delete", async () => {
    let finish: (() => void) | undefined;
    const { tracker } = setup({
      runCell: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    const done = tracker.runCell(NB, "c1", "sleep 10");
    await vi.waitFor(() => expect(tracker.existingPane(NB, "c1")).toBeDefined());
    tracker.forgetCell(NB, "c1");
    finish?.();
    await done;
    expect(get(tracker.runs)[NB]?.cells["c1"]).toBeUndefined();
  });

  it("forgets a cell that never ran without touching the store", () => {
    const { tracker } = setup();
    const seen: unknown[] = [];
    const stop = tracker.runs.subscribe((value) => seen.push(value));
    tracker.forgetCell(NB, "never-ran");
    stop();
    expect(seen).toEqual([{}]);
  });
});

describe("run tracker: renaming and deleting a runbook", () => {
  const OTHER = "/n/b.md";

  it("moves panes and run state to the new path", () => {
    const { tracker, status } = setup();
    status("c1", "running");
    const pane = tracker.existingPane(NB, "c1");
    tracker.renameRunbook(NB, OTHER);
    expect(tracker.existingPane(OTHER, "c1")).toBe(pane);
    expect(tracker.existingPane(NB, "c1")).toBeUndefined();
    expect(get(tracker.runs)[OTHER]?.cells["c1"]?.status?.state).toBe("running");
    expect(get(tracker.runs)[NB]).toBeUndefined();
  });

  it("routes events still naming the old path to the renamed runbook", () => {
    const { tracker, status, output } = setup();
    status("c1", "running");
    tracker.renameRunbook(NB, OTHER);
    // Output main had batched under the old path before the rename.
    output("c1", "late");
    status("c1", "success");
    expect(tracker.existingPane(OTHER, "c1")?.calls).toContain("write late");
    expect(get(tracker.runs)[OTHER]?.cells["c1"]?.status?.state).toBe("success");
    expect(get(tracker.runs)[NB]).toBeUndefined();
  });

  it("sends typing, and a run's end, to the new path", async () => {
    let finish: (() => void) | undefined;
    const { tracker, calls, status } = setup({
      runCell: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    const done = tracker.runCell(NB, "c1", "read x");
    await vi.waitFor(() => expect(finish).toBeDefined());
    status("c1", "running");
    tracker.renameRunbook(NB, OTHER);
    (tracker.existingPane(OTHER, "c1") as FakePane).callbacks.onInput("y\r");
    finish?.();
    await done;
    expect(calls).toContain("input y\r");
    expect(get(tracker.runs)[OTHER]?.cells["c1"]?.requested).toBe(false);
    expect(get(tracker.runs)[NB]).toBeUndefined();
  });

  it("stops routing the old path once a new runbook lives there", () => {
    const { tracker, status } = setup();
    status("c1", "running");
    tracker.renameRunbook(NB, OTHER);
    tracker.claimPath(NB);
    status("c9", "running");
    expect(tracker.existingPane(NB, "c9")).toBeDefined();
    expect(tracker.existingPane(OTHER, "c9")).toBeUndefined();
  });

  it("frees a deleted runbook's panes and ignores its last events", () => {
    const { tracker, created, status, output } = setup();
    status("c1", "running");
    status("c2", "running");
    tracker.forgetRunbook(NB);
    status("c1", "interrupted");
    output("c2", "late");
    expect(created.map((pane) => pane.calls.at(-1))).toEqual(["dispose", "dispose"]);
    expect(get(tracker.runs)[NB]).toBeUndefined();
    expect(tracker.existingPane(NB, "c1")).toBeUndefined();
  });

  it("forgets every runbook when the folder changes, and drops their late events", () => {
    const { tracker, created, status, output, state } = setup();
    status("c1", "running");
    state({ runbookPath: NB, state: "busy" });
    state({ runbookPath: "/n/b.md", state: "ready" });
    const { forgetAll } = tracker; // used unbound, as lib/runs.ts exports it
    forgetAll();
    status("c1", "interrupted");
    output("c1", "late");
    expect(created[0]?.calls.at(-1)).toBe("dispose");
    expect(get(tracker.runs)).toEqual({});
  });
});
