import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCell,
  insertCell,
  keepCellIds,
  parseTags,
  setCellSource,
  setTags,
  setTitle,
} from "../src/renderer/src/state/runbook-edits";
import { createRunbookStore } from "../src/renderer/src/state/runbook-store";
import type { Runbook } from "../src/shared/types";

function runbook(path = "/n/a.md"): Runbook {
  return {
    path,
    title: "A",
    tags: [],
    frontmatterRaw: null,
    lineEnding: "\n",
    cells: [
      { id: "m1", type: "markdown", source: "Hello" },
      { id: "s1", type: "shell", source: "echo hi", info: "bash" },
    ],
  };
}

describe("runbook edits", () => {
  it("change one cell's source and leave the rest alone", () => {
    const before = runbook();
    const after = setCellSource(before, "s1", "echo bye");
    expect(after.cells.map((cell) => cell.source)).toEqual(["Hello", "echo bye"]);
    expect(after.cells[0]).toBe(before.cells[0]);
    expect(before.cells[1]?.source).toBe("echo hi");
  });

  it("insert an empty cell at a position, clamped to the list", () => {
    const { runbook: after, cell } = insertCell(runbook(), "shell", 1);
    expect(after.cells.map((c) => c.id)).toEqual(["m1", cell.id, "s1"]);
    expect(cell).toMatchObject({ type: "shell", source: "", info: "bash" });
    const atEnd = insertCell(runbook(), "markdown", 99);
    expect(atEnd.runbook.cells.at(-1)).toBe(atEnd.cell);
  });

  it("delete a cell", () => {
    expect(deleteCell(runbook(), "m1").cells.map((c) => c.id)).toEqual(["s1"]);
  });

  it("set the title, keeping the old one for a blank title", () => {
    expect(setTitle(runbook(), "  New  ").title).toBe("New");
    const before = runbook();
    expect(setTitle(before, "   ")).toBe(before);
    expect(setTitle(before, "A")).toBe(before);
  });

  it("set tags from comma-separated text", () => {
    expect(parseTags(" audio, pipewire,,audio ,")).toEqual(["audio", "pipewire"]);
    expect(setTags(runbook(), "x, y").tags).toEqual(["x", "y"]);
    const before = runbook();
    expect(setTags(before, " , ")).toBe(before);
  });
});

describe("runbook store", () => {
  let saved: Runbook[];
  let failNext: boolean;
  const save = async (value: Runbook): Promise<void> => {
    await Promise.resolve();
    if (failNext) {
      failNext = false;
      throw new Error("disk full");
    }
    saved.push(value);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    saved = [];
    failNext = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a runbook as first opened", () => {
    const store = createRunbookStore({ save });
    const first = store.open(runbook());
    expect(store.open(runbook())).toBe(first);
    expect(get(store)["/n/a.md"]).toBe(first);
  });

  it("saves 500 ms after the last edit, once", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    await vi.advanceTimersByTimeAsync(300);
    store.edit("/n/a.md", (n) => setTitle(n, "C"));
    await vi.advanceTimersByTimeAsync(499);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved.map((n) => n.title)).toEqual(["C"]);
  });

  it("doesn't save an edit that changed nothing", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setTitle(n, "A"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual([]);
  });

  it("saves at once on flush, and nothing when there is nothing to save", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    await store.flush("/n/a.md");
    expect(saved).toEqual([]);
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    await store.flush("/n/a.md");
    expect(saved.map((n) => n.title)).toEqual(["B"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toHaveLength(1);
  });

  it("saves an edit made during a save once that save is done, not alongside it", async () => {
    let release: (() => void) | undefined;
    const titles: string[] = [];
    let inFlight = 0;
    const slowSave = async (value: Runbook): Promise<void> => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      titles.push(value.title);
      await new Promise<void>((resolve) => (release = resolve));
      inFlight -= 1;
    };
    const store = createRunbookStore({ save: slowSave });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    const first = store.flush("/n/a.md");
    await vi.waitFor(() => expect(titles).toEqual(["B"]));
    store.edit("/n/a.md", (n) => setTitle(n, "C"));
    const second = store.flush("/n/a.md");
    release?.();
    await first;
    await vi.waitFor(() => expect(titles).toEqual(["B", "C"]));
    release?.();
    await second;
  });

  it("saves only the latest version when edits come before the save starts", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    const first = store.flush("/n/a.md");
    store.edit("/n/a.md", (n) => setTitle(n, "C"));
    await Promise.all([first, store.flush("/n/a.md")]);
    expect(saved.map((n) => n.title)).toEqual(["C"]);
  });

  it("reports a failed save and tries again on the next flush", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    failNext = true;
    await expect(store.flush("/n/a.md")).rejects.toThrow("disk full");
    expect(get(store.errors)).toEqual({ "/n/a.md": "disk full" });
    await store.flush("/n/a.md");
    expect(saved.map((n) => n.title)).toEqual(["B"]);
    expect(get(store.errors)).toEqual({});
  });

  it("flushes every runbook with unsaved changes", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook("/n/a.md"));
    store.open(runbook("/n/b.md"));
    store.open(runbook("/n/c.md"));
    store.edit("/n/a.md", (n) => setTitle(n, "A2"));
    store.edit("/n/b.md", (n) => setTitle(n, "B2"));
    await store.flushAll();
    expect(saved.map((n) => n.path).toSorted()).toEqual(["/n/a.md", "/n/b.md"]);
  });
});

// What main returns for a rename: the file read back, so a cell without an {id=…}
// got an ID of its own.
function renamedTo(path: string, title: string): () => Promise<Runbook> {
  return async () => ({
    ...runbook(path),
    title,
    cells: [{ id: "main-id", type: "markdown", source: "Hello" }],
  });
}

describe("keepCellIds", () => {
  it("keeps the window's IDs for cells that still match, and the file's own IDs", () => {
    const open = runbook();
    const fresh: Runbook = {
      ...runbook(),
      cells: [
        { id: "new1", type: "markdown", source: "Hello" }, // unchanged: keeps m1
        { id: "s1", type: "shell", source: "echo changed", info: "bash" }, // file ID stays
        { id: "new2", type: "shell", source: "echo hi", info: "bash" }, // s1 is taken
      ],
    };
    expect(keepCellIds(open, fresh).cells.map((cell) => cell.id)).toEqual(["m1", "s1", "new2"]);
  });
});

describe("runbook store: a file changed outside the app", () => {
  let results: string[];
  let saved: { title: string; force: boolean }[];
  const save = async (value: Runbook, { force }: { force: boolean }) => {
    saved.push({ title: value.title, force });
    return (force ? "saved" : (results.shift() ?? "saved")) as "saved" | "changed" | "missing";
  };

  beforeEach(() => {
    vi.useFakeTimers();
    results = [];
    saved = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a conflict: nothing more is saved, and the edits stay, until the user decides", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    results = ["changed"];
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    await vi.advanceTimersByTimeAsync(500);
    expect(get(store.conflicts)).toEqual({ "/n/a.md": "changed" });
    expect(get(store.errors)).toEqual({});
    store.edit("/n/a.md", (n) => setTitle(n, "C"));
    await vi.advanceTimersByTimeAsync(2000);
    await store.flushAll();
    expect(saved).toEqual([{ title: "B", force: false }]);
    expect(get(store)["/n/a.md"]?.title).toBe("C");
  });

  it("overwrites the file with the window's copy when asked", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    results = ["changed"];
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    await vi.advanceTimersByTimeAsync(500);
    await store.overwrite("/n/a.md");
    expect(saved.at(-1)).toEqual({ title: "B", force: true });
    expect(get(store.conflicts)).toEqual({});
    // Autosave goes on as before.
    store.edit("/n/a.md", (n) => setTitle(n, "C"));
    await vi.advanceTimersByTimeAsync(500);
    expect(saved.at(-1)).toEqual({ title: "C", force: false });
  });

  it("reads the file again when asked, dropping the window's edits and keeping cell IDs", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    results = ["changed"];
    store.edit("/n/a.md", (n) => setTitle(n, "Mine"));
    await vi.advanceTimersByTimeAsync(500);
    const fromDisk: Runbook = {
      ...runbook(),
      title: "Theirs",
      cells: [{ id: "x9", type: "markdown", source: "Hello" }],
    };
    store.readFromDisk("/n/a.md", fromDisk);
    expect(get(store)["/n/a.md"]).toMatchObject({ title: "Theirs", cells: [{ id: "m1" }] });
    expect(get(store.conflicts)).toEqual({});
    await store.flushAll();
    expect(saved).toHaveLength(1);
  });

  it("closes a runbook whose file is gone when the user takes the disk's side", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    results = ["missing"];
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    await vi.advanceTimersByTimeAsync(500);
    expect(get(store.conflicts)).toEqual({ "/n/a.md": "missing" });
    store.readFromDisk("/n/a.md", null);
    expect(get(store)).toEqual({});
    expect(get(store.conflicts)).toEqual({});
  });

  it("stops a rename while the runbook is in conflict", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    results = ["changed"];
    store.edit("/n/a.md", (n) => setTitle(n, "B"));
    const perform = vi.fn(async () => ({ ...runbook("/n/b.md"), title: "B" }));
    await expect(store.rename("/n/a.md", perform)).rejects.toThrow("changed outside Runbook");
    expect(perform).not.toHaveBeenCalled();
    expect(Object.keys(get(store))).toEqual(["/n/a.md"]);
  });
});

describe("runbook store: rename and delete", () => {
  let saved: Runbook[];
  const save = async (value: Runbook): Promise<void> => {
    await Promise.resolve();
    saved.push(value);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    saved = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves pending edits first, then moves the runbook, keeping its cells", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setCellSource(n, "s1", "echo edited"));
    const moved = await store.rename("/n/a.md", renamedTo("/n/b.md", "B"));
    expect(saved.map((n) => [n.path, n.cells[1]?.source])).toEqual([["/n/a.md", "echo edited"]]);
    expect(moved).toMatchObject({ path: "/n/b.md", title: "B" });
    expect(moved.cells.map((cell) => cell.id)).toEqual(["m1", "s1"]);
    expect(Object.keys(get(store))).toEqual(["/n/b.md"]);
  });

  it("holds saves while the file moves, and saves later edits under the new path", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    let finish: ((value: Runbook) => void) | undefined;
    const renaming = store.rename(
      "/n/a.md",
      () => new Promise<Runbook>((resolve) => (finish = resolve)),
    );
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.edit("/n/a.md", (n) => setCellSource(n, "s1", "typed meanwhile"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual([]);
    finish?.({ ...runbook("/n/b.md"), title: "B" });
    await renaming;
    await vi.advanceTimersByTimeAsync(500);
    expect(saved.map((n) => [n.path, n.title, n.cells[1]?.source])).toEqual([
      ["/n/b.md", "B", "typed meanwhile"],
    ]);
  });

  it("leaves the runbook where it was when the rename fails", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    await expect(
      store.rename("/n/a.md", () => Promise.reject(new Error("name taken"))),
    ).rejects.toThrow("name taken");
    expect(Object.keys(get(store))).toEqual(["/n/a.md"]);
    store.edit("/n/a.md", (n) => setTitle(n, "Still saves"));
    await vi.advanceTimersByTimeAsync(500);
    expect(saved.map((n) => n.path)).toEqual(["/n/a.md"]);
  });

  it("forgets when a runbook was saved once it moves or goes, so a reused path starts fresh", async () => {
    let clock = 1000;
    const store = createRunbookStore({ save, now: () => clock });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setTitle(n, "Edited"));
    await store.flush("/n/a.md");
    expect(get(store.savedAt)).toEqual({ "/n/a.md": 1000 });

    await store.rename("/n/a.md", renamedTo("/n/b.md", "B"));
    expect(get(store.savedAt)).toEqual({});
    clock = 2000;
    store.edit("/n/b.md", (n) => setTitle(n, "Edited again"));
    await store.flush("/n/b.md");
    expect(get(store.savedAt)).toEqual({ "/n/b.md": 2000 });

    await store.remove("/n/b.md", () => Promise.resolve());
    expect(get(store.savedAt)).toEqual({});
  });

  it("renames a runbook that isn't open by just running the rename", async () => {
    const store = createRunbookStore({ save });
    const moved = await store.rename("/n/a.md", renamedTo("/n/b.md", "B"));
    expect(moved.path).toBe("/n/b.md");
    expect(get(store)).toEqual({});
  });

  it("deletes a runbook after a save in flight, dropping its unsaved edits", async () => {
    let release: (() => void) | undefined;
    const slowSave = async (value: Runbook): Promise<void> => {
      await new Promise<void>((resolve) => (release = resolve));
      saved.push(value);
    };
    const store = createRunbookStore({ save: slowSave });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setTitle(n, "Saving"));
    void store.flush("/n/a.md");
    await vi.waitFor(() => expect(release).toBeDefined());
    store.edit("/n/a.md", (n) => setTitle(n, "Never saved"));
    const deleted: string[] = [];
    const removing = store.remove("/n/a.md", async () => {
      // The save in flight must be done before the file goes.
      deleted.push(`deleted after ${saved.length} save`);
    });
    release?.();
    await removing;
    await vi.advanceTimersByTimeAsync(1000);
    expect(deleted).toEqual(["deleted after 1 save"]);
    expect(saved.map((n) => n.title)).toEqual(["Saving"]);
    expect(get(store)).toEqual({});
  });

  it("keeps a runbook, and its unsaved edits, when the delete fails", async () => {
    const store = createRunbookStore({ save });
    store.open(runbook());
    store.edit("/n/a.md", (n) => setTitle(n, "Kept"));
    await expect(
      store.remove("/n/a.md", () => Promise.reject(new Error("no trash"))),
    ).rejects.toThrow("no trash");
    await vi.advanceTimersByTimeAsync(500);
    expect(saved.map((n) => n.title)).toEqual(["Kept"]);
    expect(get(store)["/n/a.md"]?.title).toBe("Kept");
  });
});

describe("runbook store: changing folder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lists the runbooks whose edits a flush couldn't save", async () => {
    const store = createRunbookStore({
      save: async (saved) => {
        if (saved.path === "/n/bad.md") throw new Error("disk full");
        if (saved.path === "/n/moved.md") return "changed";
        return "saved";
      },
    });
    for (const path of ["/n/a.md", "/n/bad.md", "/n/moved.md"]) {
      store.open(runbook(path));
      store.edit(path, (open) => setTitle(open, "Edited"));
    }
    await store.flushAll();
    expect(store.unsavedPaths().toSorted()).toEqual(["/n/bad.md", "/n/moved.md"]);
  });

  it("clears every runbook, with its errors, conflicts and pending saves", async () => {
    const save = vi.fn(async (saved: Runbook) =>
      saved.path === "/n/b.md" ? "changed" : undefined,
    );
    const store = createRunbookStore({ save });
    store.open(runbook("/n/a.md"));
    store.open(runbook("/n/b.md"));
    store.edit("/n/b.md", (open) => setTitle(open, "B"));
    await store.flush("/n/b.md").catch(() => {});
    store.edit("/n/a.md", (open) => setTitle(open, "Pending"));
    save.mockClear();
    store.clear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    expect(get(store)).toEqual({});
    expect(get(store.conflicts)).toEqual({});
    expect(store.unsavedPaths()).toEqual([]);
  });
});
