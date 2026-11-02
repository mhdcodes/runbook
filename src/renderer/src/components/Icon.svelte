<script module lang="ts">
  // The app's icon set, drawn on a 16 × 16 grid in currentColor.
  export type IconName =
    | "search"
    | "plus"
    | "x"
    | "run"
    | "stop"
    | "more"
    | "ok"
    | "bad"
    | "wait"
    | "halt"
    | "copy"
    | "clear"
    | "trash"
    | "pen"
    | "folder"
    | "alert"
    | "check"
    | "power"
    | "gear";
</script>

<script lang="ts">
  const { name, size = 16 }: { name: IconName; size?: 12 | 14 | 16 } = $props();
</script>

<svg
  class="block flex-none"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.4"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "search"}
    <circle cx="7" cy="7" r="4.6" stroke-width="1.6" /><path d="m10.4 10.4 3.1 3.1" stroke-width="1.6" />
  {:else if name === "plus"}
    <path d="M8 3.2v9.6M3.2 8h9.6" stroke-width="1.6" />
  {:else if name === "x"}
    <path d="m4.5 4.5 7 7m0-7-7 7" stroke-width="1.6" />
  {:else if name === "run"}
    <path d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.3-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none" />
  {:else if name === "stop"}
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  {:else if name === "more"}
    <g fill="currentColor" stroke="none"><circle cx="8" cy="3.5" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="8" cy="12.5" r="1.3" /></g>
  {:else if name === "ok"}
    <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" opacity=".2" /><path d="m5 8.2 2 2 4-4.2" stroke-width="1.7" />
  {:else if name === "bad"}
    <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" opacity=".2" /><path d="m5.7 5.7 4.6 4.6m0-4.6-4.6 4.6" stroke-width="1.7" />
  {:else if name === "wait"}
    <circle cx="8" cy="8" r="6.2" /><path d="M8 4.9V8l2.1 1.4" />
  {:else if name === "halt"}
    <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" opacity=".2" /><rect x="5.6" y="5.6" width="4.8" height="4.8" rx="1" fill="currentColor" stroke="none" />
  {:else if name === "copy"}
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 3.6V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.6" />
  {:else if name === "clear"}
    <path d="M2.5 4h11M2.5 8h11M2.5 12h5.5M10.5 10.5l3 3m0-3-3 3" />
  {:else if name === "trash"}
    <path d="M2.8 4.5h10.4M6.4 4.5V3.1h3.2v1.4M4.4 4.5l.7 8.6h5.8l.7-8.6" />
  {:else if name === "pen"}
    <path d="m10.3 2.9 2.8 2.8M3 13l.6-3L11 2.6a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 0 1 0 1.4L6.4 12.8 3 13z" />
  {:else if name === "folder"}
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  {:else if name === "gear"}
    <circle cx="8" cy="8" r="4.6" /><circle cx="8" cy="8" r="1.8" /><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.25 1.25M11.25 11.25l1.25 1.25M3.5 12.5l1.25-1.25M11.25 4.75l1.25-1.25" stroke-width="1.6" />
  {:else if name === "power"}
    <path d="M8 2.2v5.3M4.7 4.3a5 5 0 1 0 6.6 0" />
  {:else if name === "alert"}
    <circle cx="8" cy="8" r="6.4" stroke-width="1.5" /><path d="M8 4.8v3.6" stroke-width="1.6" /><circle cx="8" cy="10.9" r=".95" fill="currentColor" stroke="none" />
  {:else if name === "check"}
    <path d="m3.5 8.4 3 3 6-6.6" stroke-width="1.6" />
  {/if}
</svg>
