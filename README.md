# pi-cd

Change [pi](https://github.com/badlogic/pi-mono)’s working directory mid-session with `/cd`.

Pi binds tools, skills, project config, and sessions to a **cwd**. This extension switches that cwd properly (new session file + runtime rebind), not a fake `process.chdir` alone.

## Install

```bash
pi install npm:pi-cd
```

Or from a local checkout / git:

```bash
pi install ./pi-cd
pi install git:github.com/richardanaya/pi-cd
```

Reload pi (`/reload`) or restart.

## Usage

| Command | What it does |
| -------- | ---------------- |
| `/cd` | Interactive directory browser |
| `/cd <path>` | Go to path (keeps conversation via session fork) |
| `/cd -n <path>` | New empty session in path |
| `/cd --new <path>` | Same as `-n` |
| `/cd -` | Previous directory |
| `/cd ~` | Home |
| `/cd ..` | Parent |
| `/cd --recents` | Pick from recent destinations |
| `/cd --clear-recents` | Clear recent list |

While typing `/cd …`, argument completion lists directories (and specials `-`, `~`, `..`, `--new`, `--recents`).

### Browser keys

- **↑↓** navigate
- **type** filter
- **enter** open folder, or confirm “Use this directory”
- **←** or select `..` go up
- **esc** cancel

### Modes

- **Default** — `SessionManager.forkFrom` copies the current session history into a new session under the target cwd, then switches. Context travels with you.
- **`--new` / `-n`** — fresh session in the target cwd (no history).

Recent destinations and the previous cwd are stored in `~/.pi/agent/pi-cd-state.json`.

## Why not just bash `cd`?

Bash tools run with the session cwd. Changing the shell’s directory inside one bash call does not rebind pi’s project root, tools, skills, or session storage. `/cd` does.

## License

MIT © [Richard Anaya](https://github.com/richardanaya)
