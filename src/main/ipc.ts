// IPC handlers behind `window.api`. Validation lives in the modules they call.

import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { Settings, UpdateState } from "../shared/types";
import {
  checkRunbook,
  createRunbook,
  deleteRunbook,
  listRunbooks,
  readRunbook,
  renameRunbook,
  resolveRunbookPath,
  saveRunbook,
} from "./runbooks";
import { RunbookIndex } from "./search";
import type { SessionManager } from "./shell/manager";
import { OutputBatcher } from "./shell/output-batcher";
import type { Updater } from "./updater";

// `updater` is null where updates are off: the .deb, dev runs, or checkForUpdates false.
// `restart` is called when the user asks to restart into a downloaded update.
export function registerIpc(
  settings: Settings,
  sessions: SessionManager,
  updater: Updater | null,
  restart: () => void,
): void {
  // Built on the first search, then kept current by the handlers below.
  const index = new RunbookIndex(settings.runbooksDir);

  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("runbooks:list", () => listRunbooks(settings.runbooksDir));
  ipcMain.handle("runbooks:read", async (_event, path: unknown) => {
    const runbook = await readRunbook(settings.runbooksDir, path);
    // It may have changed outside the app since it was indexed.
    index.update(runbook);
    return runbook;
  });
  ipcMain.handle("runbooks:check", (_event, path: unknown) =>
    checkRunbook(settings.runbooksDir, path),
  );
  ipcMain.handle("runbooks:save", async (_event, runbook: unknown, force: unknown) => {
    const result = await saveRunbook(settings.runbooksDir, runbook, { force: force === true });
    if (result.state === "saved") index.update(result.runbook);
    return result.state;
  });

  ipcMain.handle("runbooks:create", async (_event, title: unknown) => {
    const created = await createRunbook(settings.runbooksDir, title);
    index.update(created);
    return created;
  });
  ipcMain.handle("runbooks:search", (_event, query: unknown) =>
    index.search(typeof query === "string" ? query : ""),
  );
  ipcMain.handle("runbooks:rename", async (_event, path: unknown, title: unknown) => {
    const from = resolveRunbookPath(settings.runbooksDir, path);
    const renamed = await renameRunbook(settings.runbooksDir, from, title);
    index.rename(from, renamed);
    // A running cell keeps running in the renamed runbook.
    sessions.rename(from, renamed.path);
    return renamed;
  });
  ipcMain.handle("runbooks:delete", async (_event, path: unknown) => {
    const deleted = await deleteRunbook(settings.runbooksDir, path, (p) => shell.trashItem(p));
    sessions.close(deleted);
    index.remove(deleted);
  });
  // In the file manager. openPath resolves with an error message, "" when it worked.
  ipcMain.handle("runbooks:open-folder", async () => {
    const error = await shell.openPath(settings.runbooksDir);
    if (error) throw new Error(error);
  });
  ipcMain.handle("runbooks:reveal", (_event, path: unknown) => {
    shell.showItemInFolder(resolveRunbookPath(settings.runbooksDir, path));
  });

  // Resolves once the run ends; its status arrives separately as a cell:status event.
  ipcMain.handle("cell:run", async (_event, path: unknown, cellId: unknown, source: unknown) => {
    const runbookPath = resolveRunbookPath(settings.runbooksDir, path);
    if (typeof cellId !== "string" || typeof source !== "string") {
      throw new Error("Invalid cell");
    }
    await sessions.run(runbookPath, cellId, source);
  });
  ipcMain.handle("cell:cancel", (_event, path: unknown, cellId: unknown) => {
    const runbookPath = resolveRunbookPath(settings.runbooksDir, path);
    if (typeof cellId !== "string") throw new Error("Invalid cell");
    sessions.cancel(runbookPath, cellId);
  });
  ipcMain.handle("session:input", (_event, path: unknown, data: unknown) => {
    const runbookPath = resolveRunbookPath(settings.runbooksDir, path);
    if (typeof data !== "string") throw new Error("Invalid input");
    sessions.sendInput(runbookPath, data);
  });
  ipcMain.handle("session:restart", (_event, path: unknown) =>
    sessions.restart(resolveRunbookPath(settings.runbooksDir, path)),
  );
  ipcMain.handle("session:close", (_event, path: unknown) => {
    sessions.close(resolveRunbookPath(settings.runbooksDir, path));
  });
  ipcMain.handle("session:resize", (_event, path: unknown, cols: unknown, rows: unknown) => {
    const runbookPath = resolveRunbookPath(settings.runbooksDir, path);
    if (!isTerminalSize(cols) || !isTerminalSize(rows)) throw new Error("Invalid size");
    sessions.resize(runbookPath, cols, rows);
  });

  const output = new OutputBatcher((event) => broadcast("cell:output", event));
  sessions.on("output", (event) => output.push(event));
  sessions.on("status", (event) => {
    output.flush();
    broadcast("cell:status", event);
  });
  sessions.on("state", (event) => broadcast("session:state", event));

  ipcMain.handle("updates:get", (): UpdateState => updater?.state ?? { state: "idle" });
  ipcMain.handle("updates:download", () => updater?.download());
  // Quits the normal way (edits saved, shells closed); quitting installs the update.
  ipcMain.handle("updates:install", () => {
    if (updater?.state.state !== "ready") return;
    restart();
    app.quit();
  });
  updater?.on("state", (state) => broadcast("updates:state", state));
}

function isTerminalSize(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1000;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}
