import {
  chmod,
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkRunbook,
  ensureRunbooksDir,
  listRunbooks,
  readRunbook,
  createRunbook,
  deleteRunbook,
  renameRunbook,
  resolveRunbookPath,
  saveRunbook,
  slugify,
} from "../src/main/runbooks";
import { WELCOME_RUNBOOK } from "../src/main/welcome";
import { parse, serialize } from "../src/shared/runbook";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runbook-test-"));
  dir = join(root, "Runbooks");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveRunbookPath", () => {
  it("accepts a .md file inside the folder", () => {
    expect(resolveRunbookPath("/home/u/Runbooks", "/home/u/Runbooks/a.md")).toBe(
      "/home/u/Runbooks/a.md",
    );
    expect(resolveRunbookPath("/home/u/Runbooks/", "/home/u/Runbooks/sub/../b.MD")).toBe(
      "/home/u/Runbooks/b.MD",
    );
  });

  it.each([
    ["outside the folder", "/home/u/other.md"],
    ["escaping with ..", "/home/u/Runbooks/../secrets.md"],
    ["a sibling folder sharing the prefix", "/home/u/Runbooks-old/a.md"],
    ["the folder itself", "/home/u/Runbooks"],
    ["not a .md file", "/home/u/Runbooks/a.txt"],
    ["in a subfolder", "/home/u/Runbooks/sub/a.md"],
    ["a .md folder name with another file", "/home/u/Runbooks/a.md/x.sh"],
    ["a NUL byte", "/home/u/Runbooks/a\0.md"],
  ])("rejects a path %s", (_reason, path) => {
    expect(() => resolveRunbookPath("/home/u/Runbooks", path)).toThrow();
  });

  it("accepts files directly inside a root folder", () => {
    expect(resolveRunbookPath("/", "/a.md")).toBe("/a.md");
  });

  it.each([undefined, null, 42, {}, ["/home/u/Runbooks/a.md"]])(
    "rejects a non-string path (%j)",
    (path) => {
      expect(() => resolveRunbookPath("/home/u/Runbooks", path)).toThrow();
    },
  );
});

describe("ensureRunbooksDir", () => {
  it("creates a missing folder and seeds Welcome.md", async () => {
    await ensureRunbooksDir(dir);
    expect(await readdir(dir)).toEqual(["Welcome.md"]);
    expect(await readFile(join(dir, "Welcome.md"), "utf8")).toBe(WELCOME_RUNBOOK);
  });

  it("leaves a folder with files in it untouched", async () => {
    await mkdir(dir);
    await writeFile(join(dir, "notes.txt"), "x");
    await ensureRunbooksDir(dir);
    expect(await readdir(dir)).toEqual(["notes.txt"]);
  });

  it("does not seed Welcome.md again once the user deletes it", async () => {
    await ensureRunbooksDir(dir);
    await writeFile(join(dir, "mine.md"), "Mine\n");
    await rm(join(dir, "Welcome.md"));
    await ensureRunbooksDir(dir);
    expect(await readdir(dir)).toEqual(["mine.md"]);
  });
});

describe("listRunbooks", () => {
  it("lists .md files sorted by title, with tags, mtime and a preview", async () => {
    await mkdir(dir);
    await writeFile(join(dir, "zeta.md"), "---\ntitle: Alpha\ntags: [x]\n---\n");
    await writeFile(join(dir, "beta.md"), "## Some **text**\n\n```bash\nls\n```\n");
    await writeFile(join(dir, "item10.md"), "");
    await writeFile(join(dir, "item9.md"), "");

    const list = await listRunbooks(dir);
    expect(list.map((nb) => [nb.title, nb.tags])).toEqual([
      ["Alpha", ["x"]],
      ["beta", []],
      ["item9", []],
      ["item10", []],
    ]);
    expect(list[0]?.path).toBe(join(dir, "zeta.md"));
    expect(list[0]?.mtime).toBeGreaterThan(0);
    expect(list.map((nb) => nb.preview)).toEqual(["", "Some text", "", ""]);
  });

  it("skips other files, hidden files, subfolders and unreadable entries", async () => {
    await mkdir(join(dir, "folder.md"), { recursive: true });
    await writeFile(join(dir, "a.md"), "");
    await writeFile(join(dir, "notes.txt"), "");
    await writeFile(join(dir, ".hidden.md"), "");
    await symlink(join(root, "missing.md"), join(dir, "broken.md"));
    await symlink(join(dir, "folder.md"), join(dir, "folder-link.md"));
    expect((await listRunbooks(dir)).map((nb) => nb.title)).toEqual(["a"]);
  });

  it("follows symlinked runbooks", async () => {
    await mkdir(dir);
    await writeFile(join(root, "shared.md"), "---\ntitle: Shared\n---\n");
    await symlink(join(root, "shared.md"), join(dir, "shared.md"));
    expect((await listRunbooks(dir)).map((nb) => nb.title)).toEqual(["Shared"]);
  });
});

describe("readRunbook", () => {
  it("reads and parses a runbook inside the folder", async () => {
    await ensureRunbooksDir(dir);
    const runbook = await readRunbook(dir, join(dir, "Welcome.md"));
    expect(runbook.title).toBe("Welcome to Runbook");
    expect(runbook.cells.length).toBeGreaterThan(0);
  });

  it("refuses a path through a symlinked folder", async () => {
    await mkdir(dir);
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "private.md"), "secret\n");
    await symlink(join(root, "elsewhere"), join(dir, "ext"));
    await expect(readRunbook(dir, join(dir, "ext", "private.md"))).rejects.toThrow();
  });

  it("refuses a file that isn't UTF-8, rather than read it with replaced bytes", async () => {
    await mkdir(dir);
    const latin1 = Buffer.from("---\ntitle: Caf\xe9 cr\xe8me\n---\n", "latin1");
    await writeFile(join(dir, "cafe.md"), latin1);
    await expect(readRunbook(dir, join(dir, "cafe.md"))).rejects.toThrow("isn't UTF-8 text");
    await expect(renameRunbook(dir, join(dir, "cafe.md"), "Other")).rejects.toThrow(
      "isn't UTF-8 text",
    );
    expect(await readFile(join(dir, "cafe.md"))).toEqual(latin1);
    // Still listed, so it doesn't seem to vanish.
    expect((await listRunbooks(dir)).map((summary) => summary.path)).toEqual([
      join(dir, "cafe.md"),
    ]);
  });

  it("keeps a byte order mark in the text, as before", async () => {
    await mkdir(dir);
    await writeFile(join(dir, "bom.md"), "\uFEFFHello\n");
    expect((await readRunbook(dir, join(dir, "bom.md"))).cells[0]?.source).toContain("Hello");
  });

  it("refuses a path outside the folder without reading it", async () => {
    await mkdir(dir);
    const outside = join(root, "outside.md");
    await writeFile(outside, "secret\n");
    await expect(readRunbook(dir, outside)).rejects.toThrow();
  });
});

describe("Welcome runbook", () => {
  const runbook = parse(WELCOME_RUNBOOK, "/runbooks/Welcome.md");
  const shellSources = runbook.cells
    .filter((cell) => cell.type === "shell")
    .map((cell) => cell.source);

  it("shows markdown cells, cd + pwd persistence and a coloured echo", () => {
    expect(runbook.cells.some((cell) => cell.type === "markdown")).toBe(true);
    expect(shellSources).toEqual([
      "cd /tmp",
      "pwd",
      String.raw`echo -e "\e[32mgreen\e[0m, \e[33myellow\e[0m and \e[1;34mbold blue\e[0m"`,
    ]);
  });

  it("is already in saved form, so opening it never rewrites it", () => {
    expect(serialize(runbook)).toBe(WELCOME_RUNBOOK);
  });
});

describe("saveRunbook", () => {
  const TEXT = "---\ntitle: Notes # keep me\n---\n\nHello\n\n```bash {id=abc12345}\necho hi\n```\n";

  async function opened(name = "notes.md", text = TEXT) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), text);
    return readRunbook(dir, join(dir, name));
  }

  it("writes the edited runbook, keeping the rest of the file as it was", async () => {
    const runbook = await opened();
    const [markdown, shell] = runbook.cells;
    await saveRunbook(dir, {
      ...runbook,
      title: "Renamed",
      cells: [{ ...markdown, source: "Hello again" }, shell],
    });
    expect(await readFile(runbook.path, "utf8")).toBe(
      "---\ntitle: Renamed # keep me\n---\n\nHello again\n\n```bash {id=abc12345}\necho hi\n```\n",
    );
  });

  it("leaves no temp file behind", async () => {
    const runbook = await opened();
    await saveRunbook(dir, runbook);
    expect(await readdir(dir)).toEqual(["notes.md"]);
  });

  it("keeps a symlinked runbook a symlink, and writes the file it points to", async () => {
    await mkdir(dir, { recursive: true });
    const real = join(dir, "real.md");
    await writeFile(real, TEXT);
    await symlink(real, join(dir, "linked.md"));
    const runbook = await readRunbook(dir, join(dir, "linked.md"));
    await saveRunbook(dir, { ...runbook, title: "Through the link" });
    expect((await lstat(join(dir, "linked.md"))).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toContain("title: Through the link");
  });

  it("refuses to write through a symlink leading out of the folder", async () => {
    await mkdir(dir, { recursive: true });
    const outside = join(root, "outside.md");
    await writeFile(outside, TEXT);
    await symlink(outside, join(dir, "linked.md"));
    const runbook = await readRunbook(dir, join(dir, "linked.md"));
    await expect(saveRunbook(dir, { ...runbook, title: "Hijacked" })).rejects.toThrow("outside");
    expect(await readFile(outside, "utf8")).toBe(TEXT);
  });

  it("doesn't follow a symlink planted at the temp file's name", async () => {
    const runbook = await opened();
    const victim = join(root, "victim");
    await writeFile(victim, "untouched");
    await symlink(victim, `${runbook.path}.tmp`);
    await saveRunbook(dir, { ...runbook, title: "Saved" });
    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect(await readFile(runbook.path, "utf8")).toContain("title: Saved");
    expect(await readdir(dir)).toEqual(["notes.md"]);
  });

  it("keeps the file's permissions", async () => {
    const runbook = await opened();
    await chmod(runbook.path, 0o600);
    await saveRunbook(dir, { ...runbook, title: "Private" });
    expect((await stat(runbook.path)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite a read-only file", async () => {
    const runbook = await opened();
    await chmod(runbook.path, 0o444);
    await expect(saveRunbook(dir, { ...runbook, title: "Changed" })).rejects.toThrow(
      "notes.md is read-only",
    );
    expect(await readFile(runbook.path, "utf8")).toBe(TEXT);
    expect(await readdir(dir)).toEqual(["notes.md"]);
  });

  it("won't write over a file changed outside the app since it was read, unless forced", async () => {
    const runbook = await opened();
    await writeFile(runbook.path, "Edited in another editor\n");
    expect(await checkRunbook(dir, runbook.path)).toBe("changed");
    expect(await saveRunbook(dir, { ...runbook, title: "Mine" })).toEqual({ state: "changed" });
    expect(await readFile(runbook.path, "utf8")).toBe("Edited in another editor\n");

    expect(await saveRunbook(dir, { ...runbook, title: "Mine" }, { force: true })).toMatchObject({
      state: "saved",
    });
    expect(await readFile(runbook.path, "utf8")).toContain("title: Mine");
    expect(await checkRunbook(dir, runbook.path)).toBe("same");
  });

  it("won't recreate a file removed outside the app, unless forced", async () => {
    const runbook = await opened();
    await rm(runbook.path);
    expect(await checkRunbook(dir, runbook.path)).toBe("missing");
    expect(await saveRunbook(dir, runbook)).toEqual({ state: "missing" });
    expect(await readdir(dir)).toEqual([]);
    await saveRunbook(dir, runbook, { force: true });
    expect(await readdir(dir)).toEqual(["notes.md"]);
  });

  it("takes a file read again as it is now, and its own saves as known", async () => {
    const runbook = await opened();
    await writeFile(runbook.path, "Changed outside\n");
    const again = await readRunbook(dir, runbook.path);
    expect(await saveRunbook(dir, { ...again, title: "One" })).toMatchObject({ state: "saved" });
    expect(await saveRunbook(dir, { ...again, title: "Two" })).toMatchObject({ state: "saved" });
    expect(await checkRunbook(dir, runbook.path)).toBe("same");
  });

  it("saves a runbook it just created without calling it changed", async () => {
    await mkdir(dir, { recursive: true });
    const created = await createRunbook(dir, "Fresh");
    expect(await saveRunbook(dir, { ...created, title: "Fresh" })).toMatchObject({
      state: "saved",
    });
  });

  it("ends with the last of several overlapping saves", async () => {
    const runbook = await opened();
    await Promise.all(
      ["one", "two", "three"].map((title) => saveRunbook(dir, { ...runbook, title })),
    );
    expect(await readFile(runbook.path, "utf8")).toContain("title: three");
    expect(await readdir(dir)).toEqual(["notes.md"]);
  });

  it("refuses a path outside the runbooks folder", async () => {
    const runbook = await opened();
    await expect(
      saveRunbook(dir, { ...runbook, path: join(root, "outside.md") }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual(["Runbooks"]);
  });

  it.each([
    ["not an object", null],
    ["tags that aren't strings", { tags: [1] }],
    ["an unknown line ending", { lineEnding: "\r" }],
    [
      "a cell ID that would break its {id=…}",
      { cells: [{ id: "a}b", type: "shell", source: "" }] },
    ],
    [
      "an info string spanning lines",
      { cells: [{ id: "a", type: "shell", source: "", info: "bash\nx" }] },
    ],
    ["an unknown cell type", { cells: [{ id: "a", type: "python", source: "" }] }],
  ])("refuses a runbook with %s", async (_name, change) => {
    const runbook = await opened();
    const value = change === null ? null : { ...runbook, ...change };
    await expect(saveRunbook(dir, value)).rejects.toThrow("Invalid runbook");
    expect(await readFile(runbook.path, "utf8")).toBe(TEXT);
  });
});

describe("slugify", () => {
  it.each([
    ["Fix audio after update", "fix-audio-after-update"],
    ["  Crème brûlée: notes!  ", "creme-brulee-notes"],
    ["Ünïcödé — and (more)", "unicode-and-more"],
    ["Привет мир", "привет-мир"],
    ["2026/10 release", "2026-10-release"],
    ["!!!", "untitled"],
    ["../../etc/passwd", "etc-passwd"],
  ])("%j → %j", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it("keeps file names to 80 characters, without a trailing dash", () => {
    const slug = slugify(`${"a".repeat(79)} b`);
    expect(slug).toBe("a".repeat(79));
  });
});

describe("createRunbook", () => {
  it("creates an empty runbook named after its title", async () => {
    await mkdir(dir, { recursive: true });
    const runbook = await createRunbook(dir, "  Fix audio after update ");
    expect(runbook).toMatchObject({ title: "Fix audio after update", tags: [], cells: [] });
    expect(runbook.path).toBe(join(dir, "fix-audio-after-update.md"));
    expect(await readFile(runbook.path, "utf8")).toBe(
      "---\ntitle: Fix audio after update\ntags: []\n---\n",
    );
    expect(await readRunbook(dir, runbook.path)).toMatchObject({
      title: "Fix audio after update",
    });
  });

  it("adds -2, -3, … when the name is taken, ignoring case", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Notes.md"), "keep me");
    const second = await createRunbook(dir, "Notes");
    const third = await createRunbook(dir, "notes");
    expect([second.path, third.path]).toEqual([join(dir, "notes-2.md"), join(dir, "notes-3.md")]);
    expect(await readFile(join(dir, "Notes.md"), "utf8")).toBe("keep me");
  });

  it("refuses a blank title", async () => {
    await mkdir(dir, { recursive: true });
    await expect(createRunbook(dir, "   ")).rejects.toThrow("needs a title");
    expect(await readdir(dir)).toEqual([]);
  });
});

async function file(name: string, text: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), text);
  return join(dir, name);
}

describe("renameRunbook", () => {
  it("renames the file after the new title and updates the title in it", async () => {
    const path = await file("old.md", "---\ntitle: Old # comment\ntags: [a]\n---\n\nBody\n");
    const renamed = await renameRunbook(dir, path, "Brand new");
    expect(renamed).toMatchObject({ path: join(dir, "brand-new.md"), title: "Brand new" });
    expect(await readdir(dir)).toEqual(["brand-new.md"]);
    expect(await readFile(renamed.path, "utf8")).toBe(
      "---\ntitle: Brand new # comment\ntags: [a]\n---\n\nBody\n",
    );
  });

  it("refuses to rename a read-only file, leaving it where it was", async () => {
    const path = await file("old.md", "---\ntitle: Old\n---\n");
    await chmod(path, 0o444);
    await expect(renameRunbook(dir, path, "New")).rejects.toThrow("old.md is read-only");
    expect(await readdir(dir)).toEqual(["old.md"]);
    expect(await readFile(path, "utf8")).toBe("---\ntitle: Old\n---\n");
  });

  it("refuses to rename a file changed outside the app since it was read", async () => {
    const path = await file("old.md", "---\ntitle: Old\n---\n");
    await readRunbook(dir, path);
    await writeFile(path, "---\ntitle: Old\n---\n\nAdded elsewhere\n");
    await expect(renameRunbook(dir, path, "New")).rejects.toThrow("changed outside Runbook");
    expect(await readdir(dir)).toEqual(["old.md"]);
  });

  it("gives a file without frontmatter one with the new title", async () => {
    const path = await file("plain.md", "Body\n");
    const renamed = await renameRunbook(dir, path, "Plain notes");
    expect(await readFile(renamed.path, "utf8")).toBe(
      "---\ntitle: Plain notes\ntags: []\n---\n\nBody\n",
    );
  });

  it("never replaces another runbook", async () => {
    const path = await file("a.md", "---\ntitle: A\n---\n");
    await file("b.md", "other");
    const renamed = await renameRunbook(dir, path, "B");
    expect(renamed.path).toBe(join(dir, "b-2.md"));
    expect(await readFile(join(dir, "b.md"), "utf8")).toBe("other");
  });

  it("keeps the file where it is when the name doesn't change", async () => {
    const path = await file("notes.md", "---\ntitle: notes\n---\n");
    const renamed = await renameRunbook(dir, path, "Notes");
    expect(renamed.path).toBe(path);
    expect(await readFile(path, "utf8")).toBe("---\ntitle: Notes\n---\n");
  });

  it("keeps a symlinked runbook a symlink", async () => {
    await mkdir(dir, { recursive: true });
    const real = join(dir, "elsewhere.md");
    await writeFile(real, "---\ntitle: Linked\n---\n");
    await symlink(real, join(dir, "linked.md"));
    const renamed = await renameRunbook(dir, join(dir, "linked.md"), "Moved link");
    expect((await lstat(renamed.path)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe("---\ntitle: Moved link\n---\n");
  });

  it("refuses a blank title or a path outside the folder", async () => {
    const path = await file("a.md", "x");
    await expect(renameRunbook(dir, path, " ")).rejects.toThrow("needs a title");
    await expect(renameRunbook(dir, join(root, "a.md"), "B")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["a.md"]);
  });
});

describe("deleteRunbook", () => {
  it("hands the resolved path to the trash", async () => {
    const trashed: string[] = [];
    const path = await deleteRunbook(dir, join(dir, "sub/../a.md"), async (p) => {
      trashed.push(p);
    });
    expect(trashed).toEqual([join(dir, "a.md")]);
    expect(path).toBe(join(dir, "a.md"));
  });

  it("refuses a path outside the folder, without trashing anything", async () => {
    const trashed: string[] = [];
    await expect(
      deleteRunbook(dir, "/etc/hosts.md", async (p) => {
        trashed.push(p);
      }),
    ).rejects.toThrow();
    expect(trashed).toEqual([]);
  });
});
