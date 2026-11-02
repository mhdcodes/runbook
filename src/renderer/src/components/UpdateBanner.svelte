<script lang="ts">
  import type { UpdateState } from "../../../shared/types";
  import { messageOf } from "../state/errors";
  import { runs } from "../lib/runs";
  import Icon from "./Icon.svelte";

  // The AppImage's update banner. Nothing downloads or installs until the user clicks.
  // Main only ever reports "idle" in the .deb, in dev or with update checks off.
  let update: UpdateState = $state({ state: "idle" });
  // Dismissed for this launch, until the update moves on (say, from downloading to ready).
  let dismissed: UpdateState["state"] | null = $state(null);

  window.api.onUpdateState((state) => (update = state));
  void window.api.getUpdateState().then((state) => {
    // An event may have come first; it's the newer one.
    if (update.state === "idle") update = state;
  });

  // Its failures come back as a "failed" state, with Try again.
  function download(): void {
    window.api.downloadUpdate().catch((cause: unknown) => console.error(messageOf(cause)));
  }

  function restart(): void {
    // Quitting closes every shell, as it always does; a running cell is asked about.
    if (Object.values($runs).some((run) => run?.session === "busy")) {
      if (!window.confirm("A cell is still running. Restart Runbook and stop it?")) return;
    }
    void window.api.installUpdate();
  }
</script>

{#if update.state !== "idle" && dismissed !== update.state}
  <div
    role="status"
    class="mx-auto mt-6 max-[1000px]:mx-7 flex max-w-[680px] items-center gap-x-4 rounded-menu border border-[color-mix(in_srgb,var(--color-acc)_28%,var(--color-page))] bg-[color-mix(in_srgb,var(--color-acc)_7%,var(--color-page))] py-2 pr-2 pl-3.5 text-[14px] leading-[22px] text-body"
  >
    <p class="min-w-0 flex-1 py-1">
      {#if update.state === "available"}
        <strong class="font-semibold text-ink">Runbook {update.version} is available.</strong>
      {:else if update.state === "downloading"}
        <strong class="font-semibold text-ink">Downloading Runbook {update.version}…</strong>
        <span class="tabular-nums">{update.percent}%</span>
      {:else if update.state === "ready"}
        <strong class="font-semibold text-ink">Runbook {update.version} is ready.</strong>
        It's installed when you quit.
      {:else}
        <strong class="font-semibold text-ink">Couldn't update to Runbook {update.version}.</strong>
        {update.message}.
      {/if}
    </p>
    {#if update.state === "available" || update.state === "failed"}
      <button
        type="button"
        class="flex h-[30px] flex-none items-center rounded-ctl bg-white/8 px-3 text-ui text-ink hover:bg-white/13"
        onclick={download}
      >
        {update.state === "available" ? "Update" : "Try again"}
      </button>
    {:else if update.state === "ready"}
      <button
        type="button"
        class="flex h-[30px] flex-none items-center rounded-ctl bg-white/8 px-3 text-ui text-ink hover:bg-white/13"
        onclick={restart}
      >
        Restart now
      </button>
    {/if}
    <button
      type="button"
      class="grid size-7 flex-none place-items-center rounded-ctl text-muted hover:bg-white/7 hover:text-ink"
      title="Dismiss"
      aria-label="Dismiss"
      onclick={() => (dismissed = update.state)}
    >
      <Icon name="x" size={14} />
    </button>
  </div>
{/if}
