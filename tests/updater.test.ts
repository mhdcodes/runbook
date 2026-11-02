import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../src/shared/types";
import { Updater, updatesEnabled, type UpdateSource } from "../src/main/updater";

let root: string;
let appImage: string; // the running AppImage
let downloaded: string; // where the fake source "downloads" the new one
let staged: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runbook-updater-"));
  await mkdir(join(root, "apps"));
  appImage = join(root, "apps", "runbook-x86_64.AppImage");
  downloaded = join(root, "cache.AppImage");
  staged = join(root, "apps", ".runbook-x86_64.AppImage.update");
  await writeFile(appImage, "old");
  await writeFile(downloaded, "new");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await chmod(join(root, "apps"), 0o755);
  await rm(root, { recursive: true, force: true });
});

// A release source that offers `version` and reports the given progress.
function fakeSource(version: string | null, progress: number[] = []): UpdateSource {
  return {
    check: vi.fn(async () => version),
    download: vi.fn(async (onProgress: (percent: number) => void) => {
      for (const percent of progress) onProgress(percent);
      return downloaded;
    }),
  };
}

function recorded(updater: Updater): UpdateState[] {
  const states: UpdateState[] = [];
  updater.on("state", (state) => states.push(state));
  return states;
}

describe("updatesEnabled", () => {
  it.each([
    [true, "/apps/runbook.AppImage", true, true],
    [false, "/apps/runbook.AppImage", true, false], // dev
    [true, undefined, true, false], // the .deb
    [true, "", true, false],
    [true, "/apps/runbook.AppImage", false, false], // turned off in settings
  ])("isPackaged %s, APPIMAGE %s, setting %s: %s", (isPackaged, path, checkForUpdates, on) => {
    expect(updatesEnabled({ isPackaged, appImage: path, checkForUpdates })).toBe(on);
  });
});

describe("Updater", () => {
  it("offers a newer version and downloads nothing until asked", async () => {
    const source = fakeSource("0.2.0");
    const updater = new Updater(source, appImage);
    await updater.check();
    expect(updater.state).toEqual({ state: "available", version: "0.2.0" });
    expect(source.download).not.toHaveBeenCalled();
    await expect(stat(staged)).rejects.toThrow();
  });

  it("stays idle when there's nothing newer or the check fails", async () => {
    const latest = new Updater(fakeSource(null), appImage);
    await latest.check();
    expect(latest.state).toEqual({ state: "idle" });

    const offline = new Updater(
      { check: async () => Promise.reject(new Error("offline")), download: vi.fn() },
      appImage,
    );
    await offline.check();
    expect(offline.state).toEqual({ state: "idle" });
  });

  it("does nothing on download() without an available update", async () => {
    const source = fakeSource(null);
    const updater = new Updater(source, appImage);
    await updater.download();
    expect(source.download).not.toHaveBeenCalled();
    expect(updater.state).toEqual({ state: "idle" });
  });

  it("reports whole-number progress, then stages the download beside the AppImage", async () => {
    const updater = new Updater(fakeSource("0.2.0", [0.4, 12.6, 12.9, 100]), appImage);
    await updater.check();
    const states = recorded(updater);
    await updater.download();
    expect(states).toEqual([
      { state: "downloading", version: "0.2.0", percent: 0 },
      { state: "downloading", version: "0.2.0", percent: 12 },
      { state: "downloading", version: "0.2.0", percent: 100 },
      { state: "ready", version: "0.2.0" },
    ]);
    expect(await readFile(staged, "utf8")).toBe("new");
    expect((await stat(staged)).mode & 0o777).toBe(0o755);
    // Not installed yet: that waits for the app to quit.
    expect(await readFile(appImage, "utf8")).toBe("old");
  });

  it("replaces the AppImage on install", async () => {
    const updater = new Updater(fakeSource("0.2.0"), appImage);
    await updater.check();
    await updater.download();
    expect(updater.install()).toBe(true);
    expect(await readFile(appImage, "utf8")).toBe("new");
    await expect(stat(staged)).rejects.toThrow();
  });

  it("installs nothing before the download is done", async () => {
    const updater = new Updater(fakeSource("0.2.0"), appImage);
    await updater.check();
    expect(updater.install()).toBe(false);
    expect(await readFile(appImage, "utf8")).toBe("old");
  });

  it("fails when the download fails, and tries again", async () => {
    const source = fakeSource("0.2.0");
    vi.mocked(source.download).mockRejectedValueOnce(new Error("sha512 checksum mismatch"));
    const updater = new Updater(source, appImage);
    await updater.check();
    await updater.download();
    expect(updater.state).toEqual({
      state: "failed",
      version: "0.2.0",
      message: "sha512 checksum mismatch",
    });
    await updater.download();
    expect(updater.state).toEqual({ state: "ready", version: "0.2.0" });
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails with a readable message when the AppImage's folder isn't writable",
    async () => {
      await chmod(join(root, "apps"), 0o555);
      const updater = new Updater(fakeSource("0.2.0"), appImage);
      await updater.check();
      await updater.download();
      expect(updater.state).toEqual({
        state: "failed",
        version: "0.2.0",
        message: `Runbook can't write to ${join(root, "apps")}, where its AppImage is`,
      });
    },
  );

  it("removes a staged file left by an earlier launch", async () => {
    await writeFile(staged, "stale");
    await new Updater(fakeSource(null), appImage).check();
    await expect(stat(staged)).rejects.toThrow();
  });

  it("never writes through a symlink at the staged name", async () => {
    const target = join(root, "elsewhere");
    await writeFile(target, "keep");
    const updater = new Updater(fakeSource("0.2.0"), appImage);
    await updater.check();
    await symlink(target, staged);
    await updater.download();
    expect(await readFile(target, "utf8")).toBe("keep");
    expect(await readFile(staged, "utf8")).toBe("new");
  });
});
