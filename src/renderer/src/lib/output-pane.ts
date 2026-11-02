// A shell cell's output pane: an xterm that grows with its output up to
// 400 px and then scrolls. While there is no output it is collapsed (the
// `output-collapsed` class), not display: none, because xterm can't measure its font
// in an element that isn't rendered, and the pane's size is needed before a run starts.
//
// A pane outlives its cell component: while its runbook isn't shown, it is detached
// from the page and keeps taking output, then is attached again on return.

import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const MAX_HEIGHT_PX = 400;

// The Graphite terminal theme: the output panel's colour, soft
// ANSI colours that stay readable on it, and the accent for selections.
const THEME: ITheme = {
  background: "#111113",
  foreground: "#d6d6da",
  cursor: "#ececef",
  cursorAccent: "#111113",
  selectionBackground: "rgba(138, 180, 248, 0.32)",
  black: "#2a2a2f",
  red: "#f38b82",
  green: "#8fdca2",
  yellow: "#e9c97a",
  blue: "#8ab4f8",
  magenta: "#d7a6f0",
  cyan: "#86d4e0",
  white: "#d6d6da",
  brightBlack: "#96969f",
  brightRed: "#ff9e96",
  brightGreen: "#a6e8b6",
  brightYellow: "#f2d892",
  brightBlue: "#a8c8ff",
  brightMagenta: "#e4bdf7",
  brightCyan: "#a3e3ec",
  brightWhite: "#f4f4f6",
};

export interface PaneSize {
  cols: number;
  rows: number;
}

export interface OutputPaneOptions {
  onInput: (data: string) => void;
  onResize: (size: PaneSize) => void;
}

// An inset panel. The right padding keeps every line clear of the Copy and Clear
// buttons the cell lays over its top-right corner.
const ROOT_CLASSES = [
  "output-collapsed",
  "overflow-hidden rounded-inset bg-out py-2.5 pr-16 pl-4 shadow-[inset_0_0_0_1px_var(--color-rule-soft)]",
  // An amber edge while the cell runs; the accent while it has the focus, running or not.
  "data-[running=true]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-busy)_38%,var(--color-rule-soft))]",
  "focus-within:shadow-[inset_0_0_0_1px_var(--color-acc)]",
  "data-[running=true]:focus-within:shadow-[inset_0_0_0_1px_var(--color-acc)]",
].join(" ");

export class OutputPane {
  private readonly terminal: Terminal;
  // The pane's own element, moved into a cell's slot by attach().
  private readonly root = document.createElement("div");
  // xterm sizes itself to the element it opens in, so give it one without padding.
  private readonly host = document.createElement("div");
  private readonly fit = new FitAddon();
  private readonly resizeObserver = new ResizeObserver(() => this.fitWidth());
  private opened = false;
  // The element whose focus may pass to the pane (the cell's Run/Stop button).
  private focusOwner: HTMLElement | null = null;
  // Measured while attached, so the height limit holds while detached too.
  private rowHeight = 0;
  // A trailing newline, written only once more output follows. Output usually ends
  // with one, and writing it would leave the cursor on an empty last row.
  private heldNewline = "";
  private running = false;

  constructor(private readonly options: OutputPaneOptions) {
    this.terminal = new Terminal({
      rows: 1,
      scrollback: 5000,
      // xterm draws on a canvas and can't use var(), so read the stack from the CSS.
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 13.5,
      lineHeight: 21 / 13.5,
      theme: THEME,
      cursorBlink: true,
      cursorInactiveStyle: "none",
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.onWriteParsed(() => this.fitHeight());
    // Ctrl+C arrives here as "\x03" too: in the pane it goes to the shell, not to copy.
    this.terminal.onData((data) => this.options.onInput(data));
    // Esc (leave the pane) and Ctrl+. (stop) are the cell's shortcuts, not
    // keys for the shell: xterm ignores them, and they reach the cell's key handler.
    // Between runs there is no shell to type to, so every key goes on to the page:
    // Tab moves on, Ctrl+K, Ctrl+N and ? work. All are listed in KeyboardShortcuts.svelte.
    this.terminal.attachCustomKeyEventHandler(
      (event) => this.running && !(event.key === "Escape" || (event.ctrlKey && event.key === ".")),
    );
    this.root.className = ROOT_CLASSES;
    this.root.append(this.host);
  }

  // Shows the pane in a cell's slot. The first time, xterm opens; it needs to be in
  // the page for that, to measure its font. Output written before is kept.
  attach(slot: HTMLElement, focusOwner: HTMLElement | null): void {
    this.focusOwner = focusOwner;
    slot.append(this.root);
    if (!this.opened) {
      this.opened = true;
      this.terminal.open(this.host);
      this.resizeObserver.observe(this.host);
      this.setTabStop();
    }
    // The window may have been resized, or output written, while it was detached.
    this.fitWidth();
    this.fitHeight();
    this.terminal.refresh(0, this.terminal.rows - 1);
  }

  // Takes the pane out of the page; it keeps its contents and keeps taking output.
  detach(): void {
    this.root.remove();
    this.focusOwner = null;
  }

  // Frees the pane for good, when its cell is deleted.
  dispose(): void {
    this.resizeObserver.disconnect();
    this.terminal.dispose();
    this.root.remove();
    this.focusOwner = null;
  }

  // The size a program in the pane should assume: its full width, and the rows it
  // shows once grown to its height limit.
  get size(): PaneSize {
    return { cols: this.terminal.cols, rows: this.maxRows() };
  }

  // A run that ends gives the keyboard back to the cell's Run button: the pane may
  // have taken it (offerFocus), and nothing typed there reaches a shell any more.
  setRunning(running: boolean): void {
    const ended = this.running && !running;
    this.running = running;
    this.root.dataset["running"] = String(running);
    this.setTabStop();
    if (ended && this.root.contains(document.activeElement)) {
      if (this.focusOwner?.isConnected) this.focusOwner.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  // Only a running cell's pane is a Tab stop: a finished one has nothing to type to.
  private setTabStop(): void {
    const input = this.terminal.textarea;
    if (input) input.tabIndex = this.running ? 0 : -1;
  }

  write(data: string): void {
    const text = this.heldNewline + data;
    this.heldNewline = /\r?\n$/.exec(text)?.[0] ?? "";
    const shown = text.slice(0, text.length - this.heldNewline.length);
    if (shown === "") return;
    this.root.classList.remove("output-collapsed");
    this.terminal.write(shown);
  }

  // Everything the pane shows, as plain text: for Copy output. Trailing blank lines
  // (the cursor's row, a held newline) are left out.
  text(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      if (line.isWrapped && lines.length > 0)
        lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    return lines.join("\n");
  }

  // Empties the pane for a new run and collapses it until output arrives.
  clear(): void {
    this.terminal.reset();
    this.heldNewline = "";
    this.terminal.resize(this.terminal.cols, 1);
    this.root.classList.add("output-collapsed");
  }

  // Hides the cursor once the run has ended, so the pane doesn't look like it is
  // waiting for input. clear() shows it again: reset() restores the cursor.
  hideCursor(): void {
    this.terminal.write("\x1b[?25l");
  }

  // Moves keyboard focus into the pane, so typing goes to a prompt (a password,
  // [Y/n]) without a click, but only while focus is free: on nothing, or still on the
  // cell's Run/Stop button. Focus the user put elsewhere is never taken.
  offerFocus(): void {
    if (!this.root.isConnected || this.root.classList.contains("output-collapsed")) return;
    const focused = document.activeElement;
    const free = focused === null || focused === document.body || focused === this.focusOwner;
    if (free) this.terminal.focus();
  }

  // Columns follow the pane's width; rows are set by fitHeight. Never while detached:
  // a detached element has no width, and xterm would reflow to 2 columns.
  private fitWidth(): void {
    if (!this.host.isConnected) return;
    const size = this.fit.proposeDimensions();
    if (!size || size.cols === this.terminal.cols) return;
    this.terminal.resize(size.cols, this.terminal.rows);
    this.options.onResize(this.size);
  }

  // One row per line of output, up to the height limit; beyond it, the pane scrolls.
  private fitHeight(): void {
    const buffer = this.terminal.buffer.active;
    // The cursor is on the last line of output (see heldNewline).
    const lines = buffer.baseY + buffer.cursorY + 1;
    const rows = Math.min(lines, this.maxRows());
    if (rows !== this.terminal.rows) this.terminal.resize(this.terminal.cols, rows);
  }

  private maxRows(): number {
    const screen = this.host.querySelector(".xterm-screen");
    if (screen && screen.clientHeight > 0) {
      this.rowHeight = screen.clientHeight / this.terminal.rows;
    }
    return this.rowHeight > 0 ? Math.max(1, Math.floor(MAX_HEIGHT_PX / this.rowHeight)) : 24;
  }
}
