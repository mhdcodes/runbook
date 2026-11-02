export type CellType = "markdown" | "shell";

export interface Cell {
  id: string; // nanoid(8); stable across saves for shell cells
  type: CellType;
  source: string; // raw text of the cell, no trailing newline
  // Shell cells only: the fence info string without the {id=…} attribute,
  // e.g. "bash", "sh", "shell title=x". New cells use "bash".
  info?: string;
}

export interface Runbook {
  path: string; // absolute path to the .md file
  title: string; // from frontmatter, fallback = filename
  tags: string[]; // from frontmatter, default []
  frontmatterRaw: string | null; // original YAML text (without the --- lines), null if none
  lineEnding: "\n" | "\r\n"; // detected from the file; new files use "\n"
  cells: Cell[];
}

export type RunState = "idle" | "queued" | "running" | "success" | "failed" | "interrupted";

export interface CellRunStatus {
  cellId: string;
  state: RunState;
  exitCode?: number;
  startedAt?: number; // epoch ms
  endedAt?: number;
}

export type SessionState = "starting" | "ready" | "busy" | "dead";

// Why a session became dead on its own, for the runbook's notice.
export type SessionEnd =
  | { type: "start-failed"; output: string } // the first output, to help find the cause
  | { type: "exited"; exitCode: number };

// A runbook as listed in the sidebar, without its cells.
export interface RunbookSummary {
  path: string;
  title: string;
  tags: string[];
  mtime: number; // epoch ms
  preview: string; // the first line of its prose, for the sidebar; "" when empty
}

export interface Settings {
  runbooksDir: string; // absolute path
  checkForUpdates: boolean; // the AppImage looks for a newer release at launch
}

// Where an AppImage update stands, for the banner. "idle" also covers no update,
// a failed check, and the .deb, which never checks.
export type UpdateState =
  | { state: "idle" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; percent: number } // 0–100, whole numbers
  | { state: "ready"; version: string } // installed when the app quits
  | { state: "failed"; version: string; message: string };

// A runbook's file compared with what the app last read or wrote: changed by
// another editor, git or a cell; or moved away or deleted.
export type DiskState = "same" | "changed" | "missing";

// A search hit for the sidebar.
export interface SearchResult {
  path: string;
  title: string;
  snippet: string; // one line around the first match, or the runbook's preview
  terms: string[]; // the indexed words it matched, lowercase: "pipewire" for "pipew"
}
