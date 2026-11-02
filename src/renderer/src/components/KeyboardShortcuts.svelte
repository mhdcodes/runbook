<script lang="ts">
  // Every keyboard shortcut, opened with ? (see App.svelte). The one list of them users
  // see: a new shortcut goes here too. The handlers are in App.svelte, ShellCell.svelte,
  // MarkdownCell.svelte and lib/output-pane.ts.
  const shortcuts: { keys: string[]; does: string }[] = [
    { keys: ["Ctrl", "N"], does: "New runbook" },
    { keys: ["Ctrl", "K"], does: "Search runbooks" },
    { keys: ["Shift", "Enter"], does: "Run the shell cell and move to the next cell" },
    { keys: ["Ctrl", "Enter"], does: "Run the shell cell and stay on it" },
    { keys: ["Ctrl", "."], does: "Stop the cell, or take it out of the queue" },
    { keys: ["Enter"], does: "Edit the focused markdown cell" },
    { keys: ["Esc"], does: "Leave the cell's editor or output" },
    { keys: ["Ctrl", "Shift", "Backspace"], does: "Delete the focused cell" },
    { keys: ["Ctrl", "C"], does: "Interrupt a running cell, from its output" },
    { keys: ["?"], does: "Show these shortcuts" },
  ];

  let dialog: HTMLDialogElement | undefined = $state();

  export function show(): void {
    if (!dialog?.open) dialog?.showModal();
  }

  export function isOpen(): boolean {
    return dialog?.open ?? false;
  }

  // A click on the backdrop lands on the dialog itself; one inside lands on its content.
  function onclick(event: MouseEvent): void {
    if (event.target === dialog) dialog.close();
  }
</script>

<!-- Esc closes it natively; the click handler is only for the backdrop. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  aria-labelledby="shortcuts-title"
  class="m-auto w-[min(600px,calc(100vw-32px))] rounded-menu border border-rule bg-block px-7 pt-6 pb-5 text-ink shadow-[0_12px_32px_rgba(0,0,0,0.5)] backdrop:bg-black/60"
  {onclick}
>
  <h2 id="shortcuts-title" class="mb-4 text-[16px] font-semibold">Keyboard shortcuts</h2>
  <dl class="mb-5 grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2.5 text-[14px] leading-[22px]">
    {#each shortcuts as { keys, does } (does)}
      <dt class="whitespace-nowrap">
        {#each keys as key, i (i)}
          {#if i > 0}<span class="mx-1 text-faint">+</span>{/if}<kbd
            class="inline-block min-w-[1.7em] rounded-[5px] border border-b-2 border-rule bg-raise px-1.5 text-center font-mono text-meta text-ink"
            >{key}</kbd
          >
        {/each}
      </dt>
      <dd class="text-muted">{does}</dd>
    {/each}
  </dl>
  <form method="dialog" class="flex justify-end">
    <button
      type="submit"
      class="flex h-[30px] items-center rounded-ctl bg-white/8 px-3 text-ui text-ink hover:bg-white/13"
    >
      Close
    </button>
  </form>
</dialog>
