# Runbook

Markdown notes with shell cells you can run.

Write down how you fixed something, with the commands in between, and run them again next
time with one click. All the cells of a runbook share one bash session, so a `cd` or an
`export` in one cell still holds in the next. Runbooks are plain `.md` files in a folder,
so you can read them anywhere and keep them in git.

**[Download for Linux](https://github.com/mhdcodes/runbook/releases/latest)** ·
[Website](https://runbook.mhd.codes)

## Features

- Live, coloured output, and typing into a running command (a `sudo` password, a `[Y/n]`)
- One bash session per runbook, started with your `~/.profile` and `~/.bashrc`, that keeps
  running while you look at another runbook
- Stop a command, restart the session, or clear it to start over
- Each cell shows its last run: its exit code and how long it took
- Full-text search, autosave and keyboard shortcuts

## Install

Runbook is for x86-64 Linux. Get the `.deb` (Ubuntu 24.04 or newer, Debian) or the
AppImage (any other distribution) from the
[releases page](https://github.com/mhdcodes/runbook/releases), then:

```sh
sudo apt install ./runbook-amd64.deb
# or
chmod +x runbook-x86_64.AppImage && ./runbook-x86_64.AppImage
```

## Usage

On first start, Runbook creates `~/Runbooks` with a Welcome runbook that walks through the
basics. Every `.md` file in that folder is a runbook.

A shell cell is a fenced code block marked `bash`, `sh` or `shell`, outside lists and
quotes. Everything else is Markdown:

````markdown
---
title: Fix audio after a kernel update
tags: [audio, pipewire]
---

Restart PipeWire first; this fixes it most of the time.

```bash {id=a1b2c3d4}
systemctl --user restart pipewire pipewire-pulse wireplumber
```
````

You can edit runbooks in another editor or sync them with git. If a file changed on disk
since Runbook opened it, Runbook asks before overwriting it.

To keep runbooks somewhere else, set `runbooksDir` to an absolute path in
`~/.config/codes.mhd.runbook/settings.json` and restart Runbook:

```json
{ "runbooksDir": "/home/you/notes/runbooks" }
```

### Keyboard shortcuts

| Shortcut               | Action                                             |
| ---------------------- | -------------------------------------------------- |
| `Shift+Enter`          | Run the focused cell and move to the next          |
| `Ctrl+Enter`           | Run the focused cell and stay on it                |
| `Ctrl+.`               | Stop the focused cell, or take it out of the queue |
| `Enter`                | Edit the focused Markdown cell                     |
| `Esc`                  | Leave the cell editor or the output                |
| `Ctrl+Shift+Backspace` | Delete the focused cell                            |
| `Ctrl+N`               | New runbook                                        |
| `Ctrl+K`               | Search                                             |

While a cell runs, every key in its output except `Esc` and `Ctrl+.` goes to the command,
`Ctrl+C` included.

## Safety

Shell cells run as you, like commands typed in a terminal. Nothing runs when you open a
runbook, so read one you got from someone else before running its cells.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) to build from source and find your way around the
code.

## License

[MIT](./LICENSE)
