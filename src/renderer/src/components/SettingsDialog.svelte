<script lang="ts">
  // The settings dialog, opened by the sidebar's gear. Edits stay in the dialog until
  // Save; Cancel, Esc or a click on the backdrop drops them.
  import type { Settings } from "../../../shared/types";
  import { messageOf } from "../state/errors";
  import { withTilde } from "../state/paths";

  interface Props {
    // Applies the changed settings. Resolves true once applied, false if the user
    // backed out (a running cell); throws to show an error in the dialog.
    onsave: (change: Partial<Settings>) => Promise<boolean>;
  }

  const { onsave }: Props = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  // The settings in use when it opened, and the edits to them.
  let current: Settings | null = $state(null);
  let folder = $state("");
  let checkForUpdates = $state(true);
  let error: string | null = $state(null);
  let applying = $state(false);
  let choosing = $state(false);

  const change = $derived.by((): Partial<Settings> => {
    if (!current) return {};
    return {
      ...(folder === current.runbooksDir ? {} : { runbooksDir: folder }),
      ...(checkForUpdates === current.checkForUpdates ? {} : { checkForUpdates }),
    };
  });
  const changed = $derived(Object.keys(change).length > 0);

  export function show(settings: Settings): void {
    if (dialog?.open) return;
    current = settings;
    folder = settings.runbooksDir;
    checkForUpdates = settings.checkForUpdates;
    error = null;
    dialog?.showModal();
  }

  export function isOpen(): boolean {
    return dialog?.open ?? false;
  }

  async function chooseFolder(): Promise<void> {
    choosing = true;
    try {
      const picked = await window.api.chooseFolder(folder);
      if (picked !== null) folder = picked;
    } catch (cause) {
      error = messageOf(cause);
    } finally {
      choosing = false;
    }
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!changed || applying) return;
    applying = true;
    error = null;
    try {
      if (await onsave(change)) dialog?.close();
    } catch (cause) {
      error = messageOf(cause);
    } finally {
      applying = false;
    }
  }

  // While Save applies, it can't be closed: the result has to land somewhere.
  function oncancel(event: Event): void {
    if (applying || choosing) event.preventDefault();
  }

  // A click on the backdrop lands on the dialog itself; one inside lands on its content.
  function onclick(event: MouseEvent): void {
    if (event.target === dialog && !applying && !choosing) dialog.close();
  }
</script>

<!-- Esc closes it natively; the click handler is only for the backdrop. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  aria-labelledby="settings-title"
  class="m-auto w-[min(520px,calc(100vw-32px))] rounded-menu border border-rule bg-block px-7 pt-6 pb-5 text-ink shadow-[0_12px_32px_rgba(0,0,0,0.5)] backdrop:bg-black/60"
  {oncancel}
  {onclick}
>
  <h2 id="settings-title" class="mb-5 text-[16px] font-semibold">Settings</h2>
  <form onsubmit={save}>
    <div class="mb-6 flex flex-col gap-5 text-[14px] leading-[22px]">
      <div>
        <div id="settings-folder" class="mb-1.5 font-medium">Runbooks folder</div>
        <div class="flex items-center gap-2">
          <span
            class="flex h-[30px] min-w-0 flex-1 items-center rounded-ctl bg-raise px-2.5 font-mono text-meta text-body"
            aria-labelledby="settings-folder"
            title={folder}><span class="truncate">{withTilde(folder)}</span></span
          >
          <button
            type="button"
            class="flex h-[30px] flex-none items-center rounded-ctl bg-white/8 px-3 text-ui text-ink hover:bg-white/13 disabled:opacity-50 disabled:hover:bg-white/8"
            disabled={applying || choosing}
            onclick={() => void chooseFolder()}
          >
            Change…
          </button>
        </div>
        <p class="mt-1.5 text-meta text-faint">
          Where your runbooks are kept. An empty folder starts with the Welcome runbook.
        </p>
      </div>

      <div class="flex items-start justify-between gap-6">
        <div>
          <div id="settings-updates" class="font-medium">Check for updates</div>
          <p id="settings-updates-hint" class="mt-0.5 text-meta text-faint">
            Looks for a new version when Runbook starts. Applies from the next launch.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checkForUpdates}
          aria-labelledby="settings-updates"
          aria-describedby="settings-updates-hint"
          class={[
            "relative mt-0.5 h-[20px] w-[34px] flex-none rounded-full transition-colors disabled:opacity-50",
            checkForUpdates
              ? "bg-[color-mix(in_srgb,var(--color-acc)_70%,var(--color-block))]"
              : "bg-white/13",
          ]}
          disabled={applying}
          onclick={() => (checkForUpdates = !checkForUpdates)}
        >
          <span
            class={[
              "absolute top-[3px] left-[3px] size-[14px] rounded-full bg-ink transition-transform",
              checkForUpdates && "translate-x-[14px]",
            ]}
          ></span>
        </button>
      </div>
    </div>

    {#if error}
      <p
        role="alert"
        class="mb-5 rounded-ctl border border-[color-mix(in_srgb,var(--color-dead)_28%,var(--color-block))] bg-[color-mix(in_srgb,var(--color-dead)_8%,var(--color-block))] px-3 py-2 text-[14px] leading-[22px] text-body"
      >
        {error}
      </p>
    {/if}

    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="flex h-[30px] items-center rounded-ctl bg-white/8 px-3 text-ui text-ink hover:bg-white/13 disabled:opacity-50 disabled:hover:bg-white/8"
        disabled={applying}
        onclick={() => dialog?.close()}
      >
        Cancel
      </button>
      <button
        type="submit"
        class="flex h-[30px] items-center rounded-ctl bg-[color-mix(in_srgb,var(--color-acc)_26%,var(--color-block))] px-3 text-ui font-medium text-ink hover:bg-[color-mix(in_srgb,var(--color-acc)_34%,var(--color-block))] disabled:opacity-50 disabled:hover:bg-[color-mix(in_srgb,var(--color-acc)_26%,var(--color-block))]"
        disabled={!changed || applying || choosing}
      >
        {applying ? "Saving…" : "Save"}
      </button>
    </div>
  </form>
</dialog>
