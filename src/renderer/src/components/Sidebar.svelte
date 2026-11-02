<script lang="ts">
  import { untrack } from "svelte";
  import type { RunbookSummary, SearchResult } from "../../../shared/types";
  import { refocus, rowKey } from "../lib/focus";
  import { runs } from "../lib/runs";
  import { aroundMatch, highlight } from "../state/highlight";
  import { withTilde } from "../state/paths";
  import Icon from "./Icon.svelte";
  import Menu from "./Menu.svelte";
  import SessionDot from "./SessionDot.svelte";

  interface Props {
    runbooks: RunbookSummary[];
    folder: string; // the runbooks folder, shown at the bottom
    selected: string | null;
    onselect: (path: string) => void;
    // Each resolves false (null) if it failed (the error is shown elsewhere), so the
    // input stays. onrename resolves with the runbook's new path.
    oncreate: (title: string) => Promise<boolean>;
    onrename: (path: string, title: string) => Promise<string | null>;
    ondelete: (path: string) => void;
    onreveal: (path: string) => void;
    onopenfolder: () => void; // the footer: opens the runbooks folder
    onsettings: () => void; // the footer's gear: opens the settings dialog
    onclearsession: (path: string) => void;
  }

  const {
    runbooks,
    folder,
    selected,
    onselect,
    oncreate,
    onrename,
    ondelete,
    onreveal,
    onopenfolder,
    onsettings,
    onclearsession,
  }: Props = $props();

  const shownFolder = $derived(withTilde(folder));

  // Search: an empty query shows every runbook; otherwise the results,
  // each with a one-line snippet. Queries wait 150 ms after the last keystroke.
  let query = $state("");
  let results = $state<SearchResult[] | null>(null);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchSeq = 0;

  function search(text: string): void {
    query = text;
    clearTimeout(searchTimer);
    const seq = ++searchSeq;
    if (text.trim() === "") {
      results = null;
      return;
    }
    searchTimer = setTimeout(() => {
      window.api.searchRunbooks(text).then(
        (found) => {
          // An older query answering late must not replace a newer one's results.
          if (seq === searchSeq) results = found;
        },
        () => {
          if (seq === searchSeq) results = [];
        },
      );
    }, 150);
  }

  // A runbook deleted or renamed during a search: the search runs again, and until it
  // answers, what is gone isn't shown. `runbooks` is new on every edit, so this watches
  // the paths as one string, which only changes when a path does.
  const pathList = $derived(runbooks.map((runbook) => runbook.path).join("\n"));
  const paths = $derived(new Set(pathList.split("\n")));
  const shownResults = $derived(results?.filter((result) => paths.has(result.path)) ?? null);
  $effect(() => {
    void pathList;
    untrack(() => {
      if (query.trim() !== "") search(query);
    });
  });

  let searchInput: HTMLInputElement | undefined = $state();

  // The runbooks folder changed: what was searched for was in the old one.
  export function clearSearch(): void {
    search("");
    creating = false;
    newTitle = "";
    renaming = null;
    menu = null;
  }

  // Ctrl+K.
  export function focusSearch(): void {
    searchInput?.focus();
    searchInput?.select();
  }

  // Ctrl+N: the same inline input as "+ New". It takes the focus when it appears, and
  // Esc gives it back to where it was.
  export function startCreate(): void {
    const active = document.activeElement;
    beforeCreate = active instanceof HTMLElement && active !== document.body ? active : null;
    search("");
    creating = true;
  }

  function cancelCreate(): void {
    creating = false;
    newTitle = "";
    if (beforeCreate?.isConnected) beforeCreate.focus();
    else void refocus("new-runbook");
  }

  // "+ New" shows an inline title input.
  let creating = $state(false);
  let newTitle = $state("");
  let beforeCreate: HTMLElement | null = null;
  // The item whose title is being renamed inline.
  let renaming: string | null = $state(null);
  let renameTitle = $state("");
  // A create or rename on its way: Enter, then the blur it may cause, must not send it twice.
  let busy = false;
  // The item menu, opened by right-click (at the pointer) or by the item's ⋮.
  // `opener` gets the focus back when it closes by Esc or a choice.
  let menu: { path: string; x: number; y: number; opener: HTMLElement } | null = $state(null);
  let menuElement: HTMLElement | undefined = $state();

  async function submitNew(): Promise<void> {
    const title = newTitle.trim();
    if (title === "") {
      creating = false;
      return;
    }
    if (busy) return;
    busy = true;
    try {
      if (await oncreate(title)) {
        creating = false;
        newTitle = "";
      }
    } finally {
      busy = false;
    }
  }

  // In the list: a search result has no rename input, so the search clears first.
  function startRename(path: string): void {
    const runbook = runbooks.find((summary) => summary.path === path);
    if (!runbook) return;
    search("");
    renaming = runbook.path;
    renameTitle = runbook.title;
  }

  async function submitRename(runbook: RunbookSummary): Promise<void> {
    const title = renameTitle.trim();
    if (renaming !== runbook.path) return;
    if (title === "" || title === runbook.title) {
      renaming = null;
      void refocus(rowKey(runbook.path));
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const moved = await onrename(runbook.path, title);
      if (moved !== null) {
        renaming = null;
        void refocus(rowKey(moved));
      }
    } finally {
      busy = false;
    }
  }

  // Opens at the pointer or under the ⋮, kept inside the window (the menu is about
  // 210 × 160 px with all its items).
  function openMenu(path: string, x: number, y: number, opener: HTMLElement): void {
    menu = {
      path,
      x: Math.max(8, Math.min(x, window.innerWidth - 220)),
      y: Math.max(8, Math.min(y, window.innerHeight - 170)),
      opener,
    };
  }

  // The focus was in the menu: give it back, rather than drop it on the page. Before
  // the action, which may move it on (Rename's input takes it).
  function closeMenu(): void {
    const opener = menu?.opener;
    menu = null;
    opener?.focus();
  }

  function choose(action: (path: string) => void): void {
    if (!menu) return;
    const { path } = menu;
    closeMenu();
    action(path);
  }

  const focusAndSelect = (input: HTMLInputElement): void => {
    input.focus();
    input.select();
  };
</script>

<svelte:window
  onpointerdown={(event) => {
    if (menu && !menuElement?.contains(event.target as Node)) menu = null;
  }}
  onkeydown={(event) => {
    if (menu && event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  }}
  onblur={() => (menu = null)}
/>

<!-- `terms`: for a search result, the words it matched, marked in its snippet; null in
     the plain list, where `sub` is the preview. -->
{#snippet row(path: string, title: string, sub: string, terms: readonly string[] | null)}
  {@const session = $runs[path]?.session ?? null}
  <div class="group relative">
    <button
      type="button"
      class={[
        "block w-full rounded-row py-2 pr-8 pl-2.5 text-left",
        path === selected ? "bg-sel" : "hover:bg-raise",
        menu?.path === path && path !== selected && "bg-raise",
      ]}
      aria-current={path === selected ? "page" : undefined}
      title={title}
      data-focus-key={rowKey(path)}
      onclick={() => onselect(path)}
      oncontextmenu={(event) => {
        event.preventDefault();
        openMenu(path, event.clientX, event.clientY, event.currentTarget);
      }}
    >
      <span class="block truncate text-[14px] leading-5 font-medium text-ink">{title}</span>
      {#if sub !== "" || terms === null}
        <span
          class={[
            "block truncate text-meta leading-[18px] text-faint",
            terms === null && "max-[1000px]:hidden",
          ]}
        >
          {#if terms === null}
            {sub === "" ? "Empty" : sub}
          {:else}
            {#each highlight(aroundMatch(sub, terms), terms) as part, i (i)}
              {#if part.match}<mark class="rounded-[3px] bg-[color-mix(in_srgb,var(--color-acc)_24%,transparent)] px-px text-ink">{part.text}</mark>{:else}{part.text}{/if}
            {/each}
          {/if}
        </span>
      {/if}
    </button>
    <!-- A runbook with a live shell shows its dot, so a run in the background is visible. -->
    {#if session}
      <span
        class={[
          "pointer-events-none absolute top-[15px] right-[13px] group-focus-within:invisible group-hover:invisible",
          menu?.path === path && "invisible",
        ]}><SessionDot state={session} /></span
      >
    {/if}
    <button
      type="button"
      class={[
        "absolute top-[7px] right-1.5 grid size-6 place-items-center rounded-inset bg-raise text-muted group-focus-within:grid group-hover:grid hover:text-ink",
        menu?.path === path ? "grid" : "hidden",
      ]}
      title="More"
      aria-label={`More for ${title}`}
      aria-haspopup="menu"
      onclick={(event) => {
        // Under the row, right-aligned with it. The row, not this button: it always has
        // a size, even when the button was hidden a moment ago.
        const row = event.currentTarget.parentElement?.getBoundingClientRect();
        if (row) openMenu(path, row.right - 208, row.bottom + 4, event.currentTarget);
      }}
    >
      <Icon name="more" size={14} />
    </button>
  </div>
{/snippet}

<nav class="flex min-h-0 flex-col bg-side px-2 pt-2">
  <label
    class="flex h-[34px] flex-none items-center gap-2 rounded-row bg-raise pr-2 pl-2.5 text-faint focus-within:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-acc)_55%,transparent)]"
  >
    <Icon name="search" size={14} />
    <input
      type="text"
      class="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-faint"
      placeholder="Search runbooks"
      aria-label="Search runbooks"
      bind:this={searchInput}
      value={query}
      oninput={(event) => search(event.currentTarget.value)}
      onkeydown={(event) => {
        if (event.key === "Escape") search("");
      }}
    />
    {#if query}
      <button
        type="button"
        class="grid size-[22px] place-items-center rounded-inset text-muted hover:bg-white/8 hover:text-ink"
        aria-label="Clear search"
        onclick={() => {
          search("");
          searchInput?.focus();
        }}
      >
        <Icon name="x" size={14} />
      </button>
    {:else}
      <kbd class="rounded bg-white/6 px-[5px] font-mono text-[11px] leading-[18px] text-muted">Ctrl K</kbd>
    {/if}
  </label>

  <div class="flex h-10 flex-none items-center justify-between pt-1 pr-1 pl-2.5 text-meta text-faint">
    <span>
      {#if shownResults}{shownResults.length === 0
          ? "No matches"
          : `${shownResults.length} ${shownResults.length === 1 ? "result" : "results"}`}{:else}Runbooks{/if}
    </span>
    <button
      type="button"
      class="grid size-7 place-items-center rounded-ctl text-muted hover:bg-raise hover:text-ink"
      title="New runbook (Ctrl+N)"
      aria-label="New runbook"
      data-focus-key="new-runbook"
      onclick={startCreate}
    >
      <Icon name="plus" />
    </button>
  </div>

  <!-- The menu is fixed to the window, so it closes rather than stay behind on a scroll. -->
  <div
    class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2"
    onscroll={() => (menu = null)}
  >
    {#if creating}
      <input
        class="h-[34px] flex-none rounded-row bg-raise px-2.5 text-ui text-ink outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-acc)_55%,transparent)]"
        aria-label="New runbook title"
        placeholder="Title of the new runbook"
        bind:value={newTitle}
        {@attach focusAndSelect}
        onkeydown={(event) => {
          // Prevented: the focus may move to a button before this Enter's click lands.
          if (event.key === "Enter") {
            event.preventDefault();
            void submitNew();
          }
          if (event.key === "Escape") cancelCreate();
        }}
        onblur={() => {
          if (newTitle.trim() === "") creating = false;
        }}
      />
    {/if}

    {#if shownResults}
      {#each shownResults as result (result.path)}
        {@render row(
          result.path,
          runbooks.find((runbook) => runbook.path === result.path)?.title ?? result.title,
          result.snippet,
          result.terms,
        )}
      {/each}
    {:else}
      {#each runbooks as runbook (runbook.path)}
        {#if renaming === runbook.path}
          <input
            class="h-[34px] flex-none rounded-row bg-raise px-2.5 text-[14px] font-medium text-ink outline-none focus:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-acc)_55%,transparent)]"
            aria-label="New title"
            bind:value={renameTitle}
            {@attach focusAndSelect}
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitRename(runbook);
              }
              if (event.key === "Escape") {
                renaming = null;
                void refocus(rowKey(runbook.path));
              }
            }}
            onblur={() => void submitRename(runbook)}
          />
        {:else}
          {@render row(runbook.path, runbook.title, runbook.preview, null)}
        {/if}
      {/each}
    {/if}
  </div>

  <div class="-mx-2 flex h-10 flex-none items-stretch border-t border-rule-soft">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 pr-2 pl-[18px] text-left font-mono text-meta text-faint hover:text-ink focus-visible:-outline-offset-2"
      title={`Open ${folder}`}
      onclick={onopenfolder}
    >
      <Icon name="folder" size={14} /><span class="truncate">{shownFolder}</span>
    </button>
    <button
      type="button"
      class="grid w-10 flex-none place-items-center text-faint hover:text-ink focus-visible:-outline-offset-2"
      title="Settings"
      aria-label="Settings"
      aria-haspopup="dialog"
      onclick={onsettings}
    >
      <Icon name="gear" size={14} />
    </button>
  </div>
</nav>

{#if menu}
  <div
    bind:this={menuElement}
    class="fixed z-30"
    style:left={`${menu.x}px`}
    style:top={`${menu.y}px`}
  >
    <Menu
      onchoose={closeMenu}
      items={[
        { label: "Rename", icon: "pen", onselect: () => choose(startRename) },
        { label: "Show in folder", icon: "folder", onselect: () => choose(onreveal) },
        // Only a runbook with a session has one to clear.
        ...($runs[menu.path]?.session
          ? [
              {
                label: "Clear session",
                icon: "power" as const,
                onselect: () => choose(onclearsession),
              },
            ]
          : []),
        { label: "Delete…", icon: "trash", danger: true, onselect: () => choose(ondelete) },
      ]}
    />
  </div>
{/if}
