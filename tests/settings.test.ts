import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/main/settings";

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
