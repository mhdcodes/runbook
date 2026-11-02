import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Settings } from "../shared/types";
import { isNotFound } from "./fs";

export function defaultSettings(): Settings {
  return { runbooksDir: join(homedir(), "Runbooks"), checkForUpdates: true };
}

// Reads settings.json, falling back to defaults for anything missing or invalid.
// A missing file is created with the defaults; a broken one is left alone so the
// user can fix it.
export async function loadSettings(file: string): Promise<Settings> {
  const defaults = defaultSettings();

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(defaults, null, 2)}\n`);
    return defaults;
  }

  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return defaults;
  }
  if (typeof stored !== "object" || stored === null) return defaults;

  const { runbooksDir, checkForUpdates } = stored as Record<string, unknown>;
  return {
    runbooksDir:
      typeof runbooksDir === "string" && isAbsolute(runbooksDir)
        ? runbooksDir
        : defaults.runbooksDir,
    // Missing from settings files written before it existed: those keep checking.
    checkForUpdates:
      typeof checkForUpdates === "boolean" ? checkForUpdates : defaults.checkForUpdates,
  };
}

// Writes the settings to settings.json atomically: to a temp file, then renamed over
// it, so a crash mid-write never leaves a broken file. Keys this version doesn't know
// (from a newer one, or added by hand) are kept. A settings.json that is a symlink (to
// a dotfiles repo, say) stays one: the write goes to the file it points to.
export async function saveSettings(file: string, settings: Settings): Promise<void> {
  const target = await realpath(file).catch((error: unknown) => {
    if (isNotFound(error)) return file;
    throw error;
  });
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      stored = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or broken: written fresh.
  }
  const text = `${JSON.stringify({ ...stored, ...settings }, null, 2)}\n`;
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o644,
  );
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  try {
    // Remove a leftover first, then "wx": a symlink planted at the temp name must never
    // be followed, or the write would land on whatever it points to.
    await rm(temp, { force: true });
    await writeFile(temp, text, { mode, flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
