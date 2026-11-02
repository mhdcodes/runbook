<script lang="ts">
  import { untrack } from "svelte";
  import { markdownEditor } from "../lib/codemirror";
  import { renderMarkdown } from "../lib/markdown";
  import CellMenu from "./CellMenu.svelte";

  interface Props {
    source: string;
    autoEdit?: boolean; // a new cell starts in the editor
    onchange: (source: string) => void;
    ondelete: () => void;
  }

  const { source, autoEdit = false, onchange, ondelete }: Props = $props();

  // Rendered by default; click or Enter edits, Esc or clicking outside renders again.
  let editing = $state(untrack(() => autoEdit));
  // Esc leaves the editor with the keyboard still on this cell; clicking
  // elsewhere doesn't take it back.
  let refocus = false;
  const html = $derived(renderMarkdown(source));

  function edit(event: MouseEvent | KeyboardEvent): void {
    // Links keep working: they open in the browser instead of starting an edit.
    if (event.target instanceof Element && event.target.closest("a")) return;
    editing = true;
  }

  // Created when editing starts, from the source at that moment.
  function editor(): ReturnType<typeof markdownEditor> {
    return markdownEditor({
      initial: untrack(() => source),
      onChange: onchange,
      onExit: () => (editing = false),
      autofocus: true,
      // Listed, with every other shortcut, in KeyboardShortcuts.svelte.
      shortcuts: {
        Escape: () => {
          refocus = true;
          editing = false;
        },
        "Mod-Shift-Backspace": () => ondelete(),
      },
    });
  }

  const focusIfLeftByKeyboard = (element: HTMLElement): void => {
    if (refocus) element.focus();
    refocus = false;
  };

  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return; // the editor's keymap had it
    if (event.key === "Backspace" && event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      ondelete();
    }
  }
</script>

<!-- Prose first. While editing, the text stays where it was and an
     accent bar in the margin marks the cell. Its ⋮ sits in the right margin. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="group relative" data-cell {onkeydown}>
  <!-- While its menu is open, above the cells after it; flush with the cell in narrow
       windows, where the margin is only as wide as the button. -->
  <div
    class="absolute top-0 left-full z-10 ml-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-aria-expanded:z-30 has-aria-expanded:opacity-100 max-[1000px]:ml-0"
  >
    <CellMenu
      items={[
        {
          label: "Delete cell",
          icon: "trash",
          onselect: ondelete,
          danger: true,
          shortcut: "Ctrl+Shift+Backspace",
        },
      ]}
    />
  </div>
  {#if editing}
    <div
      class="relative before:absolute before:top-[3px] before:bottom-[3px] before:-left-[18px] before:w-0.5 before:rounded-full before:bg-acc"
      {@attach editor()}
    ></div>
  {:else}
    <!-- Safe: markdown-it runs with html: false, so the output contains no raw HTML. -->
    <div
      class="markdown min-h-7 cursor-text rounded-sm focus-visible:outline-offset-4"
      data-focus-target
      {@attach focusIfLeftByKeyboard}
      role="button"
      tabindex="0"
      aria-label="Edit markdown cell"
      onclick={edit}
      onkeydown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          edit(event);
        }
      }}
    >
      {#if source.trim() === ""}
        <p class="text-faint">Empty markdown cell. Click to write.</p>
      {:else}
        {@html html}
      {/if}
    </div>
  {/if}
</div>
