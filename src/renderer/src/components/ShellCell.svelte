<script lang="ts">
  import { untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import { isActive, NO_CELL_RUN } from "../state/run-store";
  import { statusLine } from "../state/status";
  import type { Cell } from "../../../shared/types";
  import { shellEditor } from "../lib/codemirror";
  import { existingPane, forgetCell, paneFor, runCell, runs, stopCell } from "../lib/runs";
  import CellMenu from "./CellMenu.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    runbookPath: string;
    cell: Cell;
    autofocus?: boolean; // a new cell's editor takes the focus
    onchange: (source: string) => void;
    ondelete: () => void;
    onfocusnext: () => void; // Shift+Enter moves on to the next cell
  }

  const { runbookPath, cell, autofocus = false, onchange, ondelete, onfocusnext }: Props =
    $props();

  // Created once: it owns its document and reports edits, which come back as cell.source.
  // Its shortcuts run before CodeMirror's own keys. All are listed in KeyboardShortcuts.svelte.
  const editor = shellEditor({
    initial: untrack(() => cell.source),
    onChange: (source) => onchange(source),
    autofocus: untrack(() => autofocus),
    shortcuts: {
      "Shift-Enter": () => runFromKeyboard(true),
      "Mod-Enter": () => runFromKeyboard(false),
      "Mod-.": () => stopFromKeyboard(),
      // Leaves the editor for the cell's toolbar, where the other shortcuts still work.
      Escape: () => runButton?.focus(),
      "Mod-Shift-Backspace": () => remove(),
    },
  });

  let runButton: HTMLButtonElement | undefined = $state();
  let paneSlot: HTMLElement | null = null;

  // Lives in the run store, so it survives switching runbooks.
  const run = $derived($runs[runbookPath]?.cells[cell.id] ?? NO_CELL_RUN);
  const line = $derived(run.status ? statusLine(run.status) : null);
  const active = $derived(isActive(run));

  function start(): void {
    if (!paneSlot) return;
    // Created on the cell's first run, and attached before the run so the shell can
    // be sized to it.
    paneFor(runbookPath, cell.id).attach(paneSlot, runButton ?? null);
    // The editor's current contents: every edit has already reached cell.source.
    void runCell(runbookPath, cell.id, cell.source);
  }

  // Shift+Enter and Ctrl+Enter. A cell already running or queued isn't run again, as
  // its Run button is Stop then.
  function runFromKeyboard(moveOn: boolean): void {
    if (!active) start();
    if (moveOn) onfocusnext();
  }

  function stopFromKeyboard(): void {
    if (active) stopCell(runbookPath, cell.id);
  }

  // The same shortcuts with the focus elsewhere in the cell: the toolbar or the output
  // pane. In the pane only Esc and Ctrl+. count; every other key goes to the shell.
  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return; // the editor's keymap had it
    const inPane = paneSlot?.contains(event.target as Node) ?? false;
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
    let handled = true;
    if (event.key === "Escape" && inPane) runButton?.focus();
    else if (ctrl && event.key === ".") stopFromKeyboard();
    else if (inPane) handled = false;
    else if (event.key === "Enter" && event.shiftKey && !event.ctrlKey) runFromKeyboard(true);
    else if (event.key === "Enter" && ctrl && !event.shiftKey) runFromKeyboard(false);
    else if (event.key === "Backspace" && ctrl && event.shiftKey) remove();
    else handled = false;
    if (handled) event.preventDefault();
  }

  // Copy output: the pane's text to the clipboard. The button shows
  // a tick for a moment so the copy is visible.
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyOutput(): Promise<void> {
    const text = existingPane(runbookPath, cell.id)?.text() ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // e.g. the window lost focus; the tick just doesn't show
    }
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1200);
  }

  function remove(): void {
    if (active) stopCell(runbookPath, cell.id);
    // Its pane would otherwise stay in memory until the window closes.
    forgetCell(runbookPath, cell.id);
    ondelete();
  }

  // The pane, if the cell has run before, comes back with its output as it was.
  const attachPane: Attachment<HTMLElement> = (slot) => {
    paneSlot = slot;
    existingPane(runbookPath, cell.id)?.attach(slot, runButton ?? null);
    return () => {
      // Looked up again: a first run since mounting has created the pane meanwhile.
      existingPane(runbookPath, cell.id)?.detach();
      paneSlot = null;
    };
  };
</script>

<!-- One card per cell: header, command, status, output. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class={[
    "shell-card relative rounded-card border bg-block p-2",
    run.status?.state === "running"
      ? "border-[color-mix(in_srgb,var(--color-busy)_42%,var(--color-rule))]"
      : "border-rule",
  ]}
  data-cell
  {onkeydown}
>
  <div class="mb-1.5 flex h-9 items-center gap-2.5 pr-0.5 pl-1">
    <span
      class={[
        "grid size-6 place-items-center rounded-inset bg-[color-mix(in_srgb,var(--color-acc)_18%,var(--color-block))] font-mono text-[11px] leading-none font-bold tracking-[-0.06em] text-ink",
        run.status?.state === "queued" && "opacity-60",
      ]}
      aria-hidden="true">&gt;_</span
    >
    <span class={["text-ui text-body", run.status?.state === "queued" && "opacity-60"]}
      >{cell.info ?? "bash"}</span
    >
    <span class="ml-auto flex gap-1">
      <button
        bind:this={runButton}
        type="button"
        class={[
          "grid size-7 place-items-center rounded-ctl",
          active
            ? "bg-[color-mix(in_srgb,var(--color-busy)_18%,var(--color-block))] text-busy hover:bg-[color-mix(in_srgb,var(--color-busy)_26%,var(--color-block))]"
            : "bg-white/9 text-ink hover:bg-white/15",
        ]}
        title={active ? "Stop (Ctrl+.)" : "Run (Ctrl+Enter)"}
        aria-label={active ? "Stop" : "Run"}
        onclick={() => (active ? stopCell(runbookPath, cell.id) : start())}
      >
        <Icon name={active ? "stop" : "run"} size={14} />
      </button>
      <CellMenu
        items={[
          {
            label: "Clear output",
            icon: "clear",
            onselect: () => existingPane(runbookPath, cell.id)?.clear(),
          },
          {
            label: "Delete cell",
            icon: "trash",
            onselect: remove,
            danger: true,
            shortcut: "Ctrl+Shift+Backspace",
          },
        ]}
      />
    </span>
  </div>

  <div
    class={[
      "rounded-inset bg-term shadow-[inset_0_0_0_1px_var(--color-rule-soft)]",
      run.status?.state === "queued" && "opacity-60",
    ]}
    {@attach editor}
  ></div>

  {#if line}
    <p
      class={[
        "status-row flex h-8 items-center gap-2 px-1 font-mono text-meta",
        line.tone === "ok" && "text-ok",
        line.tone === "bad" && "text-dead",
        line.tone === "run" && "text-busy",
        line.tone === "idle" && "text-faint",
      ]}
    >
      {#if line.icon === "spinner"}
        <span class="spin" aria-hidden="true"></span>
      {:else}
        <Icon name={line.icon} size={14} />
      {/if}
      {line.text}
      {#if line.detail}<span class="text-faint">{line.detail}</span>{/if}
      {#if line.hint}<span class="hint ml-auto font-sans text-faint">{line.hint}</span>{/if}
    </p>
  {/if}
  {#if run.error}
    <p class="px-1 pb-1 text-meta text-dead">{run.error}</p>
  {/if}

  <!-- The output pane goes in the slot; `contents` keeps the slot itself out of the
       layout. Copy and Clear sit over its top-right corner once there is output. -->
  <div class="out-wrap relative">
    <div class="pane-slot contents" {@attach attachPane}></div>
    <span class="out-tools absolute top-1.5 right-1.5 hidden gap-0.5">
      <button
        type="button"
        class="grid size-7 place-items-center rounded-ctl text-faint hover:bg-white/7 hover:text-ink"
        title={copied ? "Copied" : "Copy output"}
        aria-label="Copy output"
        onclick={() => void copyOutput()}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </button>
      <button
        type="button"
        class="grid size-7 place-items-center rounded-ctl text-faint hover:bg-white/7 hover:text-ink"
        title="Clear output"
        aria-label="Clear output"
        onclick={() => existingPane(runbookPath, cell.id)?.clear()}
      >
        <Icon name="clear" size={14} />
      </button>
    </span>
  </div>
</div>
