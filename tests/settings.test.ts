import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/main/settings";

const DEFAULT_DIR = join(homedir(), "Runbooks");
const DEFAULTS = { runbooksDir: DEFAULT_DIR, checkForUpdates: true };
let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runbook-settings-"));
  file = join(root, "userData", "settings.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("defaults to ~/Runbooks and update checks on, and writes settings.json", async () => {
    expect(await loadSettings(file)).toEqual(DEFAULTS);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(DEFAULTS);
  });

  it("reads a stored runbooksDir", async () => {
    await loadSettings(file);
    await writeFile(file, JSON.stringify({ runbooksDir: "/srv/runbooks" }));
    expect(await loadSettings(file)).toEqual({ ...DEFAULTS, runbooksDir: "/srv/runbooks" });
  });

  it("reads update checks turned off", async () => {
    await loadSettings(file);
    await writeFile(file, JSON.stringify({ runbooksDir: "/srv/runbooks", checkForUpdates: false }));
    expect(await loadSettings(file)).toEqual({
      runbooksDir: "/srv/runbooks",
      checkForUpdates: false,
    });
  });

  it.each([
    ["missing", {}],
    ["not a boolean", { checkForUpdates: "no" }],
  ])("keeps update checks on when the setting is %s", async (_reason, extra) => {
    await loadSettings(file);
    await writeFile(file, JSON.stringify({ runbooksDir: "/srv/runbooks", ...extra }));
    expect(await loadSettings(file)).toEqual({ ...DEFAULTS, runbooksDir: "/srv/runbooks" });
  });

  it.each([
    ["broken JSON", "{ nope"],
    ["a non-object", "[]"],
    ["a relative folder", JSON.stringify({ runbooksDir: "Runbooks" })],
    ["a non-string folder", JSON.stringify({ runbooksDir: 7 })],
  ])("falls back to the default for %s and leaves the file alone", async (_reason, text) => {
    await loadSettings(file);
    await writeFile(file, text);
    expect(await loadSettings(file)).toEqual(DEFAULTS);
    expect(await readFile(file, "utf8")).toBe(text);
  });
});

describe("saveSettings", () => {
  const changed = { runbooksDir: "/srv/runbooks", checkForUpdates: false };

  it("writes the settings, and loadSettings reads them back", async () => {
    await loadSettings(file);
    await saveSettings(file, changed);
    expect(await loadSettings(file)).toEqual(changed);
  });

  it("creates settings.json and its folder when missing", async () => {
    await saveSettings(file, changed);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(changed);
  });

  it("keeps keys it doesn't know", async () => {
    await mkdir(join(root, "userData"));
    await writeFile(file, JSON.stringify({ runbooksDir: "/old", theme: "night" }));
    await saveSettings(file, changed);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...changed, theme: "night" });
  });

  it("replaces a broken file", async () => {
    await mkdir(join(root, "userData"));
    await writeFile(file, "{ nope");
    await saveSettings(file, changed);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(changed);
  });

  it("leaves no temp file behind", async () => {
    await saveSettings(file, changed);
    expect(await readdir(join(root, "userData"))).toEqual(["settings.json"]);
  });

  it("keeps the file's permissions", async () => {
    await mkdir(join(root, "userData"));
    await writeFile(file, "{}", { mode: 0o600 });
    await saveSettings(file, changed);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlinked settings.json, which stays a link", async () => {
    const real = join(root, "dotfiles.json");
    await writeFile(real, JSON.stringify({ runbooksDir: "/old" }));
    await mkdir(join(root, "userData"));
    await symlink(real, file);
    await saveSettings(file, changed);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual(changed);
  });

  it("doesn't follow a symlink planted at the temp name", async () => {
    const victim = join(root, "victim");
    await writeFile(victim, "untouched");
    await mkdir(join(root, "userData"));
    await symlink(victim, `${file}.tmp`);
    await saveSettings(file, changed);
    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(changed);
  });
});
