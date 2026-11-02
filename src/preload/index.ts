import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "./api";

// One ipcRenderer listener per channel, shared by every subscriber: each shell cell
// subscribes, and many listeners on one channel would trip Node's leak warning.
function channel<T>(name: string): (callback: (event: T) => void) => () => void {
  const callbacks = new Set<(event: T) => void>();
  ipcRenderer.on(name, (_event, payload: T) => {
    for (const callback of callbacks) callback(payload);
  });
  return (callback) => {
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
    };
  };
}

// Expose a minimal, explicit API to the renderer. Never expose ipcRenderer itself.
const api: Api = {
  listRunbooks: () => ipcRenderer.invoke("runbooks:list"),
  readRunbook: (path) => ipcRenderer.invoke("runbooks:read", path),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  checkRunbook: (path) => ipcRenderer.invoke("runbooks:check", path),
  saveRunbook: (runbook, options) => ipcRenderer.invoke("runbooks:save", runbook, options?.force),
  createRunbook: (title) => ipcRenderer.invoke("runbooks:create", title),
  renameRunbook: (path, newTitle) => ipcRenderer.invoke("runbooks:rename", path, newTitle),
  deleteRunbook: (path) => ipcRenderer.invoke("runbooks:delete", path),
  showRunbookInFolder: (path) => ipcRenderer.invoke("runbooks:reveal", path),
  searchRunbooks: (query) => ipcRenderer.invoke("runbooks:search", query),
  // A request and reply, not a channel(): main waits for exactly one "flushed" reply,
  // sent once the callback's saves settle. Register a single handler (saveOnClose).
  onFlushRequest: (callback) => {
    ipcRenderer.on("runbooks:flush", () => {
      // Close even if saving failed: the user would otherwise be stuck in the window.
      void callback()
        .catch(() => {})
        .finally(() => ipcRenderer.send("runbooks:flushed"));
    });
  },
  runCell: (runbookPath, cellId, source) =>
    ipcRenderer.invoke("cell:run", runbookPath, cellId, source),
  cancelCell: (runbookPath, cellId) => ipcRenderer.invoke("cell:cancel", runbookPath, cellId),
  sendInput: (runbookPath, data) => ipcRenderer.invoke("session:input", runbookPath, data),
  restartSession: (runbookPath) => ipcRenderer.invoke("session:restart", runbookPath),
  closeSession: (runbookPath) => ipcRenderer.invoke("session:close", runbookPath),
  resizeSession: (runbookPath, cols, rows) =>
    ipcRenderer.invoke("session:resize", runbookPath, cols, rows),
  onCellOutput: channel("cell:output"),
  onCellStatus: channel("cell:status"),
  onSessionState: channel("session:state"),
  getUpdateState: () => ipcRenderer.invoke("updates:get"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: channel("updates:state"),
};

contextBridge.exposeInMainWorld("api", api);
