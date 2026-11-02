// The API exposed to the renderer as `window.api`. Type-only so both sides can share it.
import type {
  CellRunStatus,
  DiskState,
  Runbook,
  RunbookSummary,
  SearchResult,
  SessionEnd,
  SessionState,
  Settings,
  UpdateState,
} from "../shared/types";

export interface CellOutputEvent {
  runbookPath: string;
  cellId: string;
  data: string;
}

export interface CellStatusEvent {
  runbookPath: string;
  status: CellRunStatus;
}

export interface SessionStateEvent {
  runbookPath: string;
  state: SessionState;
  end?: SessionEnd; // with "dead": why the shell died on its own
}

export interface Api {
  listRunbooks: () => Promise<RunbookSummary[]>;
  readRunbook: (path: string) => Promise<Runbook>;
  getSettings: () => Promise<Settings>;
  // How the file compares with what the app last read or wrote.
  checkRunbook: (path: string) => Promise<DiskState>;
  // Atomic write. "changed" or "missing": the file changed or went away outside the app
  // since, so it wasn't written; `force` writes it anyway.
  saveRunbook: (
    runbook: Runbook,
    options?: { force?: boolean },
  ) => Promise<"saved" | "changed" | "missing">;
  createRunbook: (title: string) => Promise<Runbook>; // slugified filename, unique
  // Renames the file after the title and updates the title; a live session moves along.
  renameRunbook: (path: string, newTitle: string) => Promise<Runbook>;
  deleteRunbook: (path: string) => Promise<void>; // moves it to the OS trash
  showRunbookInFolder: (path: string) => Promise<void>;
  searchRunbooks: (query: string) => Promise<SearchResult[]>; // { path, title, snippet }
  // Runs the callback when the window is about to close, then lets it close.
  onFlushRequest: (callback: () => Promise<void>) => void;

  // Starts the runbook's session if needed; resolves when the run ends.
  runCell: (runbookPath: string, cellId: string, source: string) => Promise<void>;
  // Stops the cell's run, or drops it from the queue.
  cancelCell: (runbookPath: string, cellId: string) => Promise<void>;
  // Keystrokes for the running cell; ignored when nothing is running.
  sendInput: (runbookPath: string, data: string) => Promise<void>;
  resizeSession: (runbookPath: string, cols: number, rows: number) => Promise<void>;
  // Kills the shell and starts a fresh one; the running cell ends interrupted.
  restartSession: (runbookPath: string) => Promise<void>;
  // Kills the shell; the next run starts a new one.
  closeSession: (runbookPath: string) => Promise<void>;

  // Each returns an unsubscribe function.
  onCellOutput: (callback: (event: CellOutputEvent) => void) => () => void;
  onCellStatus: (callback: (event: CellStatusEvent) => void) => () => void;
  onSessionState: (callback: (event: SessionStateEvent) => void) => () => void;

  // AppImage updates. Always "idle" in the .deb, in dev and with checkForUpdates off.
  getUpdateState: () => Promise<UpdateState>;
  // Downloads the available update (or retries a failed one); progress comes as events.
  downloadUpdate: () => Promise<void>;
  // Quits, installing the downloaded update, and starts the new version.
  installUpdate: () => Promise<void>;
  onUpdateState: (callback: (state: UpdateState) => void) => () => void;
}
