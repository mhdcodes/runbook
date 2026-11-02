// IPC handlers behind `window.api`. Validation lives in the modules they call.

import { isAbsolute, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { Settings, UpdateState } from "../shared/types";
import {
  checkRunbook,
  createRunbook,
  deleteRunbook,
  ensureRunbooksDir,
  listRunbooks,
  readRunbook,
  renameRunbook,
  resolveRunbookPath,
  saveRunbook,
} from "./runbooks";
import { isCode } from "./fs";
import { RunbookIndex } from "./search";
import { saveSettings } from "./settings";
import type { SessionManager } from "./shell/manager";
import { OutputBatcher } from "./shell/output-batcher";
import type { Updater } from "./updater";

export interface IpcOptions {
  // The settings in use: the one source of truth, changed in place by settings:save.
  settings: Settings;
  settingsFile: string;
  sessions: SessionManager;
  // Null where updates are off: the .deb, dev runs, or checkForUpdates false.
  updater: Updater | null;
  // Called when the user asks to restart into a downloaded update.
  restart: () => void;
}

export function registerIpc({
  settings,
  settingsFile,
  sessions,
  updater,
  restart,
}: IpcOptions): void {
  // Built on the first search, then kept current by the handlers below. Replaced when
  // the runbooks folder changes.
  let index = new RunbookIndex(settings.runbooksDir);

  ipcMain.handle("settings:get", () => settings);
  // The folder picker, starting in `from` (the dialog's field). Resolves with the
  // picked folder, or null if cancelled.
  ipcMain.handle("settings:choose-folder", async (event, from: unknown) => {
    const options: Electron.OpenDialogOptions = {
      title: "Runbooks folder",
      defaultPath: typeof from === "string" && isAbsolute(from) ? from : settings.runbooksDir,
      properties: ["openDirectory", "createDirectory"],
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return canceled ? null : (filePaths[0] ?? null);
  });
  // The settings dialog's Save. A new folder is prepared (an empty one gets the
  // Welcome runbook) and settings.json written before anything switches, so a failure
  // leaves both as they were. Then every shell closes and search starts over in it.
  let applying = false;
  ipcMain.handle("settings:save", async (_event, change: unknown): Promise<Settings> => {
    if (applying) throw new Error("Settings are already being saved");
    applying = true;
    try {
      const next = toSettings(change, settings);
      const folderChanged = next.runbooksDir !== settings.runbooksDir;
      if (!folderChanged && next.checkForUpdates === settings.checkForUpdates) return settings;
      if (folderChanged) await prepareFolder(next.runbooksDir);
      await saveSettings(settingsFile, next);
      Object.assign(settings, next);
      if (folderChanged) {
        sessions.closeAll();
        index = new RunbookIndex(settings.runbooksDir);
      }
      return settings;
    } finally {
      applying = false;
    }
  });
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

// ensureRunbooksDir, with messages for the dialog rather than bare error codes.
async function prepareFolder(dir: string): Promise<void> {
  try {
    await ensureRunbooksDir(dir);
  } catch (error) {
    if (isCode(error, "EEXIST") || isCode(error, "ENOTDIR")) {
      throw new Error(`${dir} isn't a folder`, { cause: error });
    }
    if (["EACCES", "EPERM", "EROFS"].some((code) => isCode(error, code))) {
      throw new Error(`Runbook can't write to ${dir}`, { cause: error });
    }
    throw error;
  }
}

// The settings with the dialog's changes, checked: they come from the renderer.
function toSettings(change: unknown, current: Settings): Settings {
  if (typeof change !== "object" || change === null) throw new Error("Invalid settings");
  const { runbooksDir, checkForUpdates } = change as Record<string, unknown>;
  if (runbooksDir !== undefined && (typeof runbooksDir !== "string" || !isAbsolute(runbooksDir))) {
    throw new Error("The runbooks folder must be an absolute path");
  }
  if (checkForUpdates !== undefined && typeof checkForUpdates !== "boolean") {
    throw new Error("Invalid settings");
  }
  return {
    // Without a trailing slash or "..", so the same folder compares equal.
    runbooksDir: runbooksDir === undefined ? current.runbooksDir : resolve(runbooksDir),
    checkForUpdates: checkForUpdates ?? current.checkForUpdates,
  };
}

function isTerminalSize(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1000;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}
