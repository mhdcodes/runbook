# Contributing

## Build from source

You need [Node.js](https://nodejs.org) 24 or newer. `corepack enable` sets up the
[pnpm](https://pnpm.io) version pinned in `package.json`; Node 25 and newer no longer
include Corepack, so install it first there with `npm install -g corepack`.

```sh
git clone https://github.com/mhdcodes/runbook.git
cd runbook
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the app with hot reload, and restarts it when the main or preload code
changes. Like `pnpm start`, it turns off Chromium's sandbox, and its first run downloads
Electron (about 100 MB).

| Script           | Description                                                                        |
| ---------------- | ---------------------------------------------------------------------------------- |
| `pnpm dev`       | Run the app in development mode with hot reload                                    |
| `pnpm start`     | Preview the production build                                                       |
| `pnpm test`      | Run the tests (Vitest, in Node, against real bash)                                 |
| `pnpm build`     | Type-check, then bundle main, preload and renderer into `out/`                     |
| `pnpm dist`      | Build the `.deb` and the AppImage into `dist/` (`--dir`: the unpacked app only)    |
| `pnpm typecheck` | Type-check every TypeScript project (`tsc -b`) and the Svelte files (svelte-check) |
| `pnpm lint`      | Lint with oxlint, failing on warnings (`pnpm lint:fix` to fix)                     |
| `pnpm format`    | Format with oxfmt (`pnpm format:check` to check only)                              |
| `pnpm check`     | The format check, lint, type-check and tests together                              |

`pnpm dist` takes about a minute, and the installers must be built on Linux.

## How it fits together

Runbook is an [Electron](https://www.electronjs.org) app, with the interface in
[Svelte 5](https://svelte.dev), [CodeMirror](https://codemirror.net) for editing and
[xterm.js](https://xtermjs.org) for output. [CONTEXT.md](./CONTEXT.md) defines the terms the
code uses.

- `src/main` is the main process: runbook files, search, settings and the window.
  `src/main/shell` runs one bash per runbook over node-pty, with no Electron imports, so it's
  tested in plain Node.
- `src/preload` exposes the typed `window.api`; its type is in `api.ts`.
- `src/shared` holds what both processes use: types, the runbook format, previews, links.
- `src/renderer` is the interface. `components/` holds the Svelte components, `lib/` the glue
  to CodeMirror, xterm and the DOM, and `state/` plain state logic with no DOM, tested in
  Node.
- `tests/` holds the Vitest tests, and `build/` the app icon (`icon.svg`, rendered to a
  512 px `icon.png`).

TypeScript is split into three projects on `tsconfig.base.json` (`strict`, plus extra
checks): `tsconfig.node.json` for main and preload, `tsconfig.web.json` for the renderer (DOM
only, so Node globals can't leak in), and `tsconfig.test.json` for the tests and the code they
import. The tests run in Node, which is why `renderer/src/state/` must stay free of the DOM.

To add an IPC call:

1. Register a handler in `src/main/ipc.ts`: `ipcMain.handle("ns:action", (_e, arg: unknown) => ...)`.
   Check every argument there; a runbook path goes through `resolveRunbookPath`, which
   accepts only `.md` files directly inside the runbooks folder.
2. Add the method to the `Api` interface in `src/preload/api.ts`.
3. Implement it in `src/preload/index.ts` as an explicit function:
   `action: (arg) => ipcRenderer.invoke("ns:action", arg)`. Never expose `ipcRenderer` itself.
4. Call `window.api.action(...)` from the renderer.

## Security

- `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true` on the window. The
  renderer reaches the main process only through `window.api`.
- A strict Content-Security-Policy in `index.html`. Rendered Markdown can't contain raw HTML.
- New windows are denied. `http:` and `https:` links open in the system browser, and the
  app's page can't navigate anywhere else.
- A single-instance lock.
- [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) are set at package
  time: see `electronFuses` in [electron-builder.yml](./electron-builder.yml).

## Website

`website` is the landing page at [runbook.mhd.codes](https://runbook.mhd.codes): plain HTML
styled with [Tailwind](https://tailwindcss.com). Its stylesheet, `tailwind.css`, is built from
`style.css` and the classes in `index.html` and `404.html`, and is committed so the page needs
no build step to serve. After changing any of them, rebuild it:

```sh
npx tailwindcss@3.4.17 -c website/tailwind.config.js -i website/style.css -o website/tailwind.css --minify
```

Tailwind only includes the classes it finds in those pages, so a new class shows up unstyled
until you rebuild.

The download buttons link to `releases/latest/download/runbook-amd64.deb` and
`…/runbook-x86_64.AppImage`, which GitHub redirects to the newest release. The file
names have no version, so these links never change.
