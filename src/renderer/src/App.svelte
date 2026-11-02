<script lang="ts">
  import type { Runbook, RunbookSummary } from "../../shared/types";
  import { messageOf } from "./state/errors";
  import KeyboardShortcuts from "./components/KeyboardShortcuts.svelte";
  import RunbookView from "./components/RunbookView.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import { runbooks as openRunbooks } from "./lib/runbooks";
  import { previewOf } from "../../shared/preview";
  import { claimPath, closeSession, forgetRuns, renameRuns, runs } from "./lib/runs";
  import { refocus, rowKey } from "./lib/focus";

  const saveErrors = openRunbooks.errors;
  const savedAt = openRunbooks.savedAt;
  const conflicts = openRunbooks.conflicts;

  let runbooks: RunbookSummary[] = $state([]);
  let runbooksDir = $state("");
  let selected: string | null = $state(null);
  let shown: string | null = $state(null); // the path of the runbook on screen
  let error: string | null = $state(null);
  let sidebar: ReturnType<typeof Sidebar> | undefined = $state();
  let shortcuts: ReturnType<typeof KeyboardShortcuts> | undefined = $state();

  // Window-wide shortcuts, all listed in KeyboardShortcuts.svelte. Not inside a running
  // cell's output pane: there Ctrl+N and Ctrl+K are bash's own keys (previous command,
  // kill to end of line).
  function onkeydown(event: KeyboardEvent): void {
    // The open dialog has the keyboard; Esc closes it natively.
    if (event.defaultPrevented || shortcuts?.isOpen()) return;
    if (event.key === "?" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (isTyping(event.target)) return;
      event.preventDefault();
      shortcuts?.show();
      return;
    }
    const ctrl = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
    const inShell =
      event.target instanceof Element && event.target.closest('[data-running="true"] .xterm');
    if (!ctrl || inShell) return;
    const key = event.key.toLowerCase();
    if (key === "n") sidebar?.startCreate();
    else if (key === "k") sidebar?.focusSearch();
    else return;
    event.preventDefault();
  }

  // Where a ? is text: fields, the cell editors (CodeMirror is contenteditable) and a
  // running cell's output pane, which sends it to the shell. Between runs the pane
  // passes keys on to the page, as it does Ctrl+N and Ctrl+K.
  function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.closest(".xterm")) return target.closest('[data-running="true"]') !== null;
    return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }
  // The runbook on screen, with every edit so far: the store is the source of truth
  // for open runbooks.
  const runbook: Runbook | null = $derived(shown === null ? null : ($openRunbooks[shown] ?? null));
  // The sidebar shows titles and previews as edited, before the file is listed again.
  const listed = $derived(
    runbooks.map((summary) => {
      const edited = $openRunbooks[summary.path];
      return edited
        ? { ...summary, title: edited.title, preview: previewOf(edited.cells) }
        : summary;
    }),
  );
  // When the runbook on screen was last saved, for "Edited …": from this window, or
  // before its first save here, from its file (the sidebar's summary).
  const mtime = $derived(
    shown === null
      ? null
      : ($savedAt[shown] ?? runbooks.find((summary) => summary.path === shown)?.mtime ?? null),
  );

  async function open(path: string): Promise<void> {
    // Save the runbook being left now, rather than in up to 500 ms.
    if (selected !== null && selected !== path) void openRunbooks.flush(selected).catch(() => {});
    selected = path;
    // Each runbook is kept as first opened and reused on return. Cells without an
    // {id=…} in the file get fresh IDs on every read, and the run store and output
    // panes are keyed by cell ID: a re-read would cut a cell off from its output and
    // from a run still going in the background.
    if (openRunbooks.get(path)) {
      shown = path;
      error = null;
      return;
    }
    try {
      const opened = await window.api.readRunbook(path);
      openRunbooks.open(opened);
      // A slower earlier read must not replace the runbook clicked last.
      if (selected !== path) return;
      shown = path;
      error = null;
    } catch (cause) {
      if (selected !== path) return;
      // Don't leave the previous runbook on screen under the new selection.
      shown = null;
      error = messageOf(cause);
    }
  }

  function compareText(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  }

  // Sorted like listRunbooks: by title, then path.
  function sorted(list: RunbookSummary[]): RunbookSummary[] {
    return list.toSorted((a, b) => compareText(a.title, b.title) || compareText(a.path, b.path));
  }

  async function create(title: string): Promise<boolean> {
    try {
      const created = await window.api.createRunbook(title);
      claimPath(created.path);
      openRunbooks.open(created);
      runbooks = sorted([
        ...runbooks,
        {
          path: created.path,
          title: created.title,
          tags: created.tags,
          mtime: Date.now(),
          preview: "",
        },
      ]);
      error = null;
      await open(created.path);
      // The keyboard moves from the sidebar's input to the new runbook.
      void refocus("start", { force: true });
      return true;
    } catch (cause) {
      error = messageOf(cause);
      return false;
    }
  }

  // Renames the file after the title and updates the title; from the sidebar
  // and from the runbook's own title. Resolves with the new path, or null if it failed.
  async function rename(path: string, title: string): Promise<string | null> {
    try {
      // Renaming rewrites the file from the window's copy, like a save: a file changed
      // outside the app is a conflict to resolve first.
      if (openRunbooks.get(path)) {
        const disk = await window.api.checkRunbook(path);
        if (disk !== "same") {
          openRunbooks.setConflict(path, disk);
          if (shown !== path) await open(path);
          return null;
        }
      }
      const moved = await openRunbooks.rename(path, () => window.api.renameRunbook(path, title));
      // Right away, before awaiting anything: main has already moved the session, and
      // its events now name the new path.
      renameRuns(path, moved.path);
      runbooks = sorted(
        runbooks.map((summary) =>
          summary.path === path
            ? { ...summary, path: moved.path, title: moved.title, mtime: Date.now() }
            : summary,
        ),
      );
      if (selected === path) selected = moved.path;
      if (shown === path) shown = moved.path;
      error = null;
      return moved.path;
    } catch (cause) {
      error = messageOf(cause);
      return null;
    }
  }

  // The two ways out of a conflict: take the file as it is now, dropping the
  // window's unsaved edits, or write the window's copy over it.
  async function readFromDisk(path: string): Promise<void> {
    try {
      const fresh = $conflicts[path] === "missing" ? null : await window.api.readRunbook(path);
      openRunbooks.readFromDisk(path, fresh);
      error = null;
      if (fresh === null) {
        // Gone from disk, so gone from the app.
        runbooks = runbooks.filter((summary) => summary.path !== path);
        if (selected === path || shown === path) {
          selected = null;
          shown = null;
          const [next] = runbooks;
          if (next) await open(next.path);
        }
        void refocus(selected === null ? "new-runbook" : rowKey(selected));
      } else {
        void refocus("title");
      }
    } catch (cause) {
      error = messageOf(cause);
    }
  }

  async function overwrite(path: string): Promise<void> {
    try {
      await openRunbooks.overwrite(path);
      error = null;
      void refocus("title");
    } catch (cause) {
      error = messageOf(cause);
    }
  }

  async function remove(path: string): Promise<void> {
    const title = runbooks.find((summary) => summary.path === path)?.title ?? path;
    if (!window.confirm(`Delete “${title}”? It goes to the trash, and its shell session is closed.`)) {
      return;
    }
    try {
      await openRunbooks.remove(path, () => window.api.deleteRunbook(path));
      forgetRuns(path);
      runbooks = runbooks.filter((summary) => summary.path !== path);
      error = null;
      if (selected === path || shown === path) {
        selected = null;
        shown = null;
        const [next] = runbooks;
        if (next) await open(next.path);
      }
      // The deleted row had the focus (its menu gives it back to the row).
      void refocus(selected === null ? "new-runbook" : rowKey(selected));
    } catch (cause) {
      error = messageOf(cause);
    }
  }

  // Ends the runbook's shell (the sidebar's "Clear session"). A running cell would be
  // stopped with it, so that asks first, as Delete does.
  async function clearSession(path: string): Promise<void> {
    if ($runs[path]?.session === "busy") {
      const title = runbooks.find((summary) => summary.path === path)?.title ?? path;
      if (!window.confirm(`A cell is still running in “${title}”. Clear its session and stop it?`)) {
        return;
      }
    }
    try {
      await closeSession(path);
      error = null;
    } catch (cause) {
      error = messageOf(cause);
    }
  }

  function reveal(path: string): void {
    window.api.showRunbookInFolder(path).catch((cause: unknown) => {
      error = messageOf(cause);
    });
  }

  function openFolder(): void {
    window.api.openRunbooksFolder().catch((cause: unknown) => {
      error = messageOf(cause);
    });
  }

  async function load(): Promise<void> {
    try {
      const [settings, list] = await Promise.all([
        window.api.getSettings(),
        window.api.listRunbooks(),
      ]);
      runbooksDir = settings.runbooksDir;
      runbooks = list;
      const [first] = runbooks;
      if (first) await open(first.path);
    } catch (cause) {
      error = messageOf(cause);
    }
  }

  void load();
</script>

<svelte:window {onkeydown} />

<div
  class="grid h-screen grid-cols-[272px_1fr] bg-page font-sans text-ink max-[1000px]:grid-cols-[224px_1fr]"
>
  <Sidebar
    bind:this={sidebar}
    runbooks={listed}
    folder={runbooksDir}
    {selected}
    onselect={(path) => void open(path)}
    oncreate={create}
    onrename={rename}
    ondelete={(path) => void remove(path)}
    onreveal={reveal}
    onopenfolder={openFolder}
    onclearsession={(path) => void clearSession(path)}
  />

  <main class="min-w-0 overflow-y-auto">
    <UpdateBanner />
    {#if error}
      <p
        class="mx-auto mt-6 max-[1000px]:mx-7 max-w-[680px] rounded-menu border border-[color-mix(in_srgb,var(--color-dead)_28%,var(--color-page))] bg-[color-mix(in_srgb,var(--color-dead)_8%,var(--color-page))] px-3.5 py-3 text-[14px] leading-[22px] text-body"
      >
        {error}
      </p>
    {/if}
    {#if shown && $conflicts[shown]}
      <div
        role="alert"
        class="mx-auto mt-6 max-[1000px]:mx-7 flex max-w-[680px] flex-wrap items-center gap-x-4 gap-y-2.5 rounded-menu border border-[color-mix(in_srgb,var(--color-busy)_30%,var(--color-page))] bg-[color-mix(in_srgb,var(--color-busy)_7%,var(--color-page))] px-3.5 py-3 text-[14px] leading-[22px] text-body"
      >
        <p class="min-w-0 flex-[1_1_320px]">
          <strong class="font-semibold text-ink">
            {$conflicts[shown] === "missing"
              ? "This runbook's file was moved or deleted outside Runbook."
              : "This runbook was changed outside Runbook since it was last saved here."}
          </strong>
          Your unsaved edits are kept until you choose.
        </p>
        <span class="flex flex-none gap-2">
          <button
            type="button"
            class="flex h-[30px] items-center rounded-ctl bg-white/8 px-3 text-ui text-ink hover:bg-white/13"
            onclick={() => shown && void readFromDisk(shown)}
          >
            Read changes from disk
          </button>
          <button
            type="button"
            class="flex h-[30px] items-center rounded-ctl bg-white/8 px-3 text-ui text-ink hover:bg-white/13"
            onclick={() => shown && void overwrite(shown)}
          >
            Overwrite changes on disk
          </button>
        </span>
      </div>
    {/if}
    {#if shown && $saveErrors[shown]}
      <p
        class="mx-auto mt-6 max-[1000px]:mx-7 max-w-[680px] rounded-menu border border-[color-mix(in_srgb,var(--color-dead)_28%,var(--color-page))] bg-[color-mix(in_srgb,var(--color-dead)_8%,var(--color-page))] px-3.5 py-3 text-[14px] leading-[22px] text-body"
      >
        <strong class="font-semibold text-ink">Couldn't save this runbook.</strong>
        {$saveErrors[shown]}. Your changes are kept; the next edit tries again.
      </p>
    {/if}
    {#if runbook}
      {#key runbook.path}
        <RunbookView
          {runbook}
          {mtime}
          onrename={(title) =>
            // The view is new for the new path: the title's focus goes to the new one.
            void rename(runbook.path, title).then((moved) => {
              if (moved !== null) void refocus("title");
            })}
        />
      {/key}
    {:else if runbooks.length === 0 && runbooksDir}
      <p class="py-12 text-center text-[14px] text-faint">No runbooks in {runbooksDir}</p>
    {/if}
  </main>
</div>

<KeyboardShortcuts bind:this={shortcuts} />
