// Runbook storage: the files in the runbooks folder. No Electron imports, so it is
// tested against real temp folders.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { previewOf } from "../shared/preview";
import { parse, serialize } from "../shared/runbook";
import type { Cell, DiskState, Runbook, RunbookSummary } from "../shared/types";
import { isCode } from "./fs";
import { WELCOME_FILE, WELCOME_RUNBOOK } from "./welcome";

// Creates the folder if it is missing, and seeds the Welcome runbook if it is empty.
export async function ensureRunbooksDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length === 0) {
    // "wx": never overwrite, in case the file appeared in the meantime.
    await writeFile(join(dir, WELCOME_FILE), WELCOME_RUNBOOK, { flag: "wx" });
  }
}

// The .md files directly inside the folder, sorted by title. Files that can't be
// read are left out rather than failing the whole list.
export async function listRunbooks(dir: string): Promise<RunbookSummary[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // Symlinks are followed; broken ones and links to folders fail the read below.
  const files = entries.filter(
    (entry) =>
      (entry.isFile() || entry.isSymbolicLink()) &&
      isRunbookName(entry.name) &&
      !entry.name.startsWith("."),
  );

  const summaries = await Promise.all(
    files.map(async (entry): Promise<RunbookSummary | null> => {
      const path = join(dir, entry.name);
      try {
        const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        const { title, tags, cells } = parse(text, path);
        return { path, title, tags, mtime: info.mtimeMs, preview: previewOf(cells) };
      } catch {
        return null;
      }
    }),
  );

  return summaries
    .filter((summary) => summary !== null)
    .toSorted((a, b) => compareText(a.title, b.title) || compareText(a.path, b.path));
}

export async function readRunbook(dir: string, path: unknown): Promise<Runbook> {
  const resolved = resolveRunbookPath(dir, path);
  const { text, bytes } = await readText(resolved);
  known.set(resolved, fingerprint(bytes));
  return parse(text, resolved);
}

// What each runbook's file held when this app last read or wrote it, as a hash. The
// renderer keeps a runbook as first read, so a file changed since by another editor,
// git or a cell would be overwritten by the next save: instead, the save refuses
//. Files never read here (only listed) have no entry and aren't checked.
const known = new Map<string, string>();

function fingerprint(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

// How the file compares with what this app last read or wrote.
async function stateOnDisk(path: string): Promise<DiskState> {
  const expected = known.get(path);
  if (expected === undefined) return "same";
  try {
    return fingerprint(await readFile(path)) === expected ? "same" : "changed";
  } catch (error) {
    if (isCode(error, "ENOENT")) return "missing";
    throw error;
  }
}

export function checkRunbook(dir: string, path: unknown): Promise<DiskState> {
  return stateOnDisk(resolveRunbookPath(dir, path));
}

// A runbook's text, refusing a file that isn't UTF-8: read leniently, its other bytes
// would turn into U+FFFD, and the next save would write those over the original.
// (The sidebar list still reads such a file leniently: it only shows its title.)
async function readText(path: string): Promise<{ text: string; bytes: Uint8Array }> {
  const bytes = await readFile(path);
  try {
    // ignoreBOM: keep a BOM in the text, as readFile(…, "utf8") does.
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      bytes,
    };
  } catch (cause) {
    throw new Error(
      `${basename(path)} isn't UTF-8 text. Runbook doesn't open it, so it can't damage it.`,
      { cause },
    );
  }
}

// A read-only file stays as it is: the atomic write and the rename below would
// otherwise replace it, as they need only the folder to be writable.
async function assertWritable(path: string): Promise<void> {
  try {
    await access(path, constants.W_OK);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    if (isCode(error, "EACCES") || isCode(error, "EPERM") || isCode(error, "EROFS")) {
      throw new Error(`${basename(path)} is read-only`, { cause: error });
    }
    throw error;
  }
}

// Writes in progress per file (see queueWrite).
const saving = new Map<string, Promise<void>>();

export type SaveResult = { state: "saved"; runbook: Runbook } | { state: "changed" | "missing" };

// Writes the runbook to its file atomically: to `<file>.tmp`, then renamed
// over the file, so a crash mid-write never leaves a half-written runbook. The value
// comes from the renderer, so its path and shape are checked first. A file changed or
// removed since this app last read or wrote it isn't written, unless `force`.
// Resolves with the runbook as saved, for the search index.
export async function saveRunbook(
  dir: string,
  value: unknown,
  { force = false }: { force?: boolean } = {},
): Promise<SaveResult> {
  const runbook = toRunbook(value);
  const saved = { ...runbook, path: resolveRunbookPath(dir, runbook.path) };
  let refused: DiskState = "same";
  await queueWrite(saved.path, async () => {
    // Inside the queue: a save just before this one has updated what is known.
    if (!force) refused = await stateOnDisk(saved.path);
    if (refused === "same") await writeKnown(dir, saved.path, serialize(saved));
  });
  return refused === "same" ? { state: "saved", runbook: saved } : { state: refused };
}

// Creates an empty runbook named after its title, never overwriting a file.
export async function createRunbook(dir: string, title: unknown): Promise<Runbook> {
  const clean = toTitle(title);
  for (const name of await freeNames(dir, clean)) {
    const runbook = emptyRunbook(join(resolve(dir), name), clean);
    const text = serialize(runbook);
    try {
      // "wx": if the name was taken meanwhile, try the next one.
      await writeFile(runbook.path, text, { flag: "wx" });
      known.set(runbook.path, fingerprint(text));
      return runbook;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
  throw new Error("No free file name for this title");
}

// Gives the runbook a new title and a file named after it, keeping its contents.
// Returns it as written; the caller keeps its own cells (their IDs key the run state).
export async function renameRunbook(
  dir: string,
  path: unknown,
  newTitle: unknown,
): Promise<Runbook> {
  const from = resolveRunbookPath(dir, path);
  const title = toTitle(newTitle);
  const { text, bytes } = await readText(from);
  // The window's copy is older than the file: the renamed file would mix the two.
  const expected = known.get(from);
  if (expected !== undefined && fingerprint(bytes) !== expected) {
    throw new Error(`${basename(from)} changed outside Runbook. Reload it before renaming it.`);
  }
  const runbook = parse(text, from);
  // Before the file moves: a refused write must leave it where it was.
  await assertWritable(from);
  let to = from;
  for (const name of await freeNames(dir, title, from)) {
    const candidate = join(resolve(dir), name);
    if (candidate === from || (await moveWithoutReplacing(from, candidate))) {
      to = candidate;
      break;
    }
  }
  // Title and path change together: for a file without frontmatter, serialize()
  // compares the title with the file name.
  const renamed = { ...runbook, path: to, title };
  if (to !== from) known.delete(from);
  await queueWrite(to, () => writeKnown(dir, to, serialize(renamed)));
  return renamed;
}

// Moves the runbook to the OS trash. `trash` is Electron's shell.trashItem.
export async function deleteRunbook(
  dir: string,
  path: unknown,
  trash: (path: string) => Promise<void>,
): Promise<string> {
  const resolved = resolveRunbookPath(dir, path);
  await trash(resolved);
  known.delete(resolved);
  return resolved;
}

// "Fix audio after update" → "fix-audio-after-update". Letters and digits of any
// script are kept, accents dropped (é → e); everything else becomes a single dash.
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "untitled" : slug;
}

// File names for a title in the order to try them: `slug.md`, `slug-2.md`, … skipping
// names already in the folder, compared case-insensitively like listRunbooks does.
// `own` is the runbook being renamed: its current name counts as free.
async function freeNames(dir: string, title: string, own?: string): Promise<string[]> {
  const taken = new Set(
    (await readdir(dir))
      .filter((name) => own === undefined || join(resolve(dir), name) !== own)
      .map((name) => name.toLowerCase()),
  );
  const slug = slugify(title);
  const names: string[] = [];
  for (let n = 1; names.length < 20 && n < 1000; n++) {
    const name = n === 1 ? `${slug}.md` : `${slug}-${n}.md`;
    if (!taken.has(name)) names.push(name);
  }
  return names;
}

// Renames `from` to `to` unless `to` exists; false if it does. A hard link fails on an
// existing name, where rename() would replace it. On filesystems without hard links
// (FAT on a USB stick), it falls back to checking first.
async function moveWithoutReplacing(from: string, to: string): Promise<boolean> {
  try {
    await link(from, to);
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    if (!isCode(error, "EPERM") && !isCode(error, "ENOTSUP") && !isCode(error, "EXDEV")) {
      throw error;
    }
    if (
      await lstat(to).then(
        () => true,
        () => false,
      )
    )
      return false;
    await rename(from, to);
    return true;
  }
  await unlink(from);
  return true;
}

function emptyRunbook(path: string, title: string): Runbook {
  return { path, title, tags: [], frontmatterRaw: null, lineEnding: "\n", cells: [] };
}

function toTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (title === "") throw new Error("A runbook needs a title");
  return title;
}

// Writes of the same file run one after another, so two never share its temp file.
async function queueWrite(path: string, write: () => Promise<void>): Promise<void> {
  const previous = saving.get(path) ?? Promise.resolve();
  const done = previous.catch(() => {}).then(write);
  saving.set(path, done);
  try {
    await done;
  } finally {
    if (saving.get(path) === done) saving.delete(path);
  }
}

// Writes the file and remembers what it now holds.
async function writeKnown(dir: string, path: string, text: string): Promise<void> {
  await writeAtomically(dir, path, text);
  known.set(path, fingerprint(text));
}

async function writeAtomically(dir: string, path: string, text: string): Promise<void> {
  // Renaming onto a symlink would replace the link with a plain file, so write next
  // to the file it points to. A file that doesn't exist yet is written where it is.
  const root = await realpath(dir);
  const target = await realpath(path).catch(() => join(root, basename(path)));
  // A link leading out of the folder (say, one shipped by a cloned repo) must not make
  // a save overwrite a file elsewhere on disk, such as ~/.bashrc.
  if (dirname(target) !== root) {
    throw new Error(
      `${basename(path)} is a link to a file outside the runbooks folder, so Runbook won't write to it`,
    );
  }
  await assertWritable(target);
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o644,
  );
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

function fail(): never {
  throw new Error("Invalid runbook");
}

function toRunbook(value: unknown): Runbook {
  if (typeof value !== "object" || value === null) return fail();
  const { path, title, tags, frontmatterRaw, lineEnding, cells } = value as Record<string, unknown>;
  if (typeof path !== "string" || typeof title !== "string") return fail();
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) return fail();
  if (frontmatterRaw !== null && typeof frontmatterRaw !== "string") return fail();
  if (lineEnding !== "\n" && lineEnding !== "\r\n") return fail();
  if (!Array.isArray(cells)) return fail();
  return {
    path,
    title,
    tags,
    frontmatterRaw,
    lineEnding,
    cells: cells.map((cell: unknown) => toCell(cell) ?? fail()),
  };
}

function toCell(value: unknown): Cell | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, type, source, info } = value as Record<string, unknown>;
  // The ID ends up in a `{id=…}` attribute: what parse() reads back must be all of it.
  if (typeof id !== "string" || !/^[^\s}]+$/.test(id)) return null;
  if (typeof source !== "string") return null;
  if (type === "markdown") return { id, type, source };
  if (type !== "shell") return null;
  // The info string is the rest of the fence's opening line.
  if (info !== undefined && (typeof info !== "string" || /[\r\n]/.test(info))) return null;
  return info === undefined ? { id, type, source } : { id, type, source, info };
}

// Every path from the renderer must point to a .md file inside the runbooks folder
//. Only files directly inside it count, the same ones listRunbooks shows:
// a deeper path could pass through a symlinked folder that leads anywhere on disk.
// Returns the resolved path, or throws.
export function resolveRunbookPath(dir: string, path: unknown): string {
  if (typeof path !== "string" || path.includes("\0")) {
    throw new Error("Invalid runbook path");
  }
  const root = resolve(dir);
  const resolved = resolve(root, path);
  if (dirname(resolved) !== root || !isRunbookName(resolved)) {
    throw new Error(`Not a runbook in ${root}: ${path}`);
  }
  return resolved;
}

function isRunbookName(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}
