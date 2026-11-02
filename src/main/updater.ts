// AppImage updates, on the user's say: one check at launch, then the download and the
// install wait for the banner's buttons. The .deb and dev runs never get here.
//
// electron-updater only checks and downloads. The install is ours: its own replaces the
// file and then runs the new AppImage while the old one is still quitting. Instead the
// download is copied next to the AppImage as soon as it's done (so a folder we can't
// write to fails in the banner, not silently at quit), and quitting renames it over.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, renameSync } from "node:fs";
import { chmod, copyFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UpdateState } from "../shared/types";
import { buildShellEnv } from "./shell/env";

// Where releases come from: GitHub through electron-updater, or a fake in tests.
export interface UpdateSource {
  // The newer release's version, or null when this one is the latest.
  check(): Promise<string | null>;
  // Downloads the newer release's whole AppImage; resolves with the file's path.
  download(onProgress: (percent: number) => void): Promise<string>;
}

// Only the packaged AppImage updates itself, and only if the user hasn't turned it off.
// APPIMAGE is set by the AppImage's runtime; the .deb and dev runs don't have it.
export function updatesEnabled(options: {
  isPackaged: boolean;
  appImage: string | undefined;
  checkForUpdates: boolean;
}): boolean {
  return options.isPackaged && Boolean(options.appImage) && options.checkForUpdates;
}

export class Updater extends EventEmitter<{ state: [UpdateState] }> {
  readonly #source: UpdateSource;
  readonly #appImage: string;
  readonly #staged: string; // the new AppImage, beside the old one until the app quits
  #state: UpdateState = { state: "idle" };

  constructor(source: UpdateSource, appImage: string) {
    super();
    this.#source = source;
    this.#appImage = appImage;
    this.#staged = join(dirname(appImage), `.${basename(appImage)}.update`);
  }

  get state(): UpdateState {
    return this.#state;
  }

  // Looks for a newer release. Offline or failing, it stays idle: nothing to show.
  async check(): Promise<void> {
    if (this.#state.state !== "idle") return;
    // Left over from a launch that downloaded an update but didn't quit cleanly.
    await rm(this.#staged, { force: true }).catch(() => {});
    try {
      const version = await this.#source.check();
      if (version !== null) this.#set({ state: "available", version });
    } catch (error) {
      console.error("Could not check for updates:", error);
    }
  }

  // Downloads the update and puts it beside the AppImage; also the banner's Try again.
  async download(): Promise<void> {
    const current = this.#state;
    if (current.state !== "available" && current.state !== "failed") return;
    const { version } = current;
    this.#set({ state: "downloading", version, percent: 0 });
    try {
      const file = await this.#source.download((percent) => {
        const whole = Math.min(100, Math.max(0, Math.floor(percent)));
        if (this.#state.state === "downloading" && this.#state.percent !== whole) {
          this.#set({ state: "downloading", version, percent: whole });
        }
      });
      await this.#stage(file);
      this.#set({ state: "ready", version });
    } catch (error) {
      console.error("Could not download the update:", error);
      this.#set({ state: "failed", version, message: this.#messageOf(error) });
    }
  }

  // Replaces the AppImage with the downloaded one, as the app quits. The running app
  // keeps the old file open, so it's unaffected. Returns whether it was replaced.
  install(): boolean {
    if (this.#state.state !== "ready") return false;
    try {
      renameSync(this.#staged, this.#appImage);
      return true;
    } catch (error) {
      console.error("Could not install the update:", error);
      return false;
    }
  }

  async #stage(file: string): Promise<void> {
    // Removed first and then created exclusively, so whatever was at that name, a
    // symlink included, is never written through.
    await rm(this.#staged, { force: true });
    await copyFile(file, this.#staged, constants.COPYFILE_EXCL);
    await chmod(this.#staged, 0o755);
  }

  #messageOf(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return `Runbook can't write to ${dirname(this.#appImage)}, where its AppImage is`;
    }
    if (code === "ENOSPC") return "There isn't enough disk space for it";
    return error instanceof Error ? error.message : String(error);
  }

  #set(state: UpdateState): void {
    this.#state = state;
    this.emit("state", state);
  }
}

// Starts the AppImage again once this process has exited, for Restart now. Not
// app.relaunch(): its helper runs from the AppImage's mount, which goes away as the app
// exits, and with it the helper. This waits in a plain sh instead, outside the mount, so
// the new instance also finds the single-instance lock free.
export function startAfterExit(appImage: string): void {
  // The environment without the old mount's paths, as for the user's shells.
  const env = buildShellEnv(process.env);
  if (process.env["TERM"] === undefined) delete env["TERM"];
  else env["TERM"] = process.env["TERM"];
  const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; exec "$2"';
  spawn("/bin/sh", ["-c", script, "sh", String(process.pid), appImage], {
    detached: true,
    stdio: "ignore",
    env,
  }).unref();
}

// The real source: the latest GitHub release, through electron-updater. Loaded only
// when updates are enabled, so the .deb never loads it.
export async function githubSource(): Promise<UpdateSource> {
  const {
    default: { autoUpdater },
  } = await import("electron-updater");
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false; // installed by Updater.install
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableDifferentialDownload = true; // the whole AppImage, every time
  autoUpdater.logger = { info: () => {}, warn: console.warn, error: console.error };

  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? result.updateInfo.version : null;
    },
    async download(onProgress) {
      const listener = (progress: { percent: number }): void => onProgress(progress.percent);
      autoUpdater.on("download-progress", listener);
      try {
        const [file] = await autoUpdater.downloadUpdate();
        if (!file) throw new Error("The download produced no file");
        return file;
      } finally {
        autoUpdater.off("download-progress", listener);
      }
    },
  };
}
