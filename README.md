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
| `/cd` | Interactive directory browser with a “Create directory…” option |
| `/cd <path>` | Create missing directories, then go to path (keeps conversation via session fork) |
| `/cd -n <path>` | New empty session in path |
| `/cd --new <path>` | Same as `-n` |
| `/cd -` | Previous directory |
| `/cd ~` | Home |
| `/cd ..` | Parent |
| `/cd --recents` | Pick from recent destinations |
| `/cd --clear-recents` | Clear recent list |

While typing `/cd …`, argument completion lists directories (and specials `-`, `~`, `..`, `--new`, `--recents`).

### Creating directories

Explicit paths create missing directories, including parents, before switching:

```text
/cd projects/new-app
/cd -n "projects/new app"
```

Existing directories still work as before. Files and paths beneath files are rejected.
Previous-directory (`/cd -`) and recent-directory selections do not recreate missing destinations.

In the browser, select **Create directory…** at any location. Enter a single folder name
(spaces and hidden names are supported) to create it inside the displayed directory and
open it in the browser. Select **Use this directory** to switch Pi into it. Cancelling
the name prompt or encountering an invalid/existing name returns to the same directory
without switching sessions. Names must not be empty, `.`, `..`, absolute paths, or contain
path separators or NUL characters. The same action is available in the non-TUI select fallback.

Created directories remain on disk if you subsequently cancel the browser or session switch.

### Browser keys

- **↑↓** navigate
- **type** filter
- **enter** open folder, select “Create directory…”, or confirm “Use this directory”
- **←** or select `..` go up
- **esc** cancel

### Modes

- **Default** — `SessionManager.forkFrom` copies the current session history into a new session under the target cwd, then switches. Context travels with you.
- **`--new` / `-n`** — fresh session in the target cwd (no history).

Recent destinations and the previous cwd are stored in `~/.pi/agent/pi-cd-state.json`.

## Why not just bash `cd`?

Bash tools run with the session cwd. Changing the shell’s directory inside one bash call does not rebind pi’s project root, tools, skills, or session storage. `/cd` does.

## Tests

Run `npm test` with Node.js 22.13+ (or 23.5+). The dependency-free regression suite uses
Node’s TypeScript stripping API and mocked Pi UI/session services, with real filesystem
operations in temporary directories. It covers command paths, browser creation, cancellation,
validation, and filesystem errors; it does not replace a live Pi TUI smoke test.

## License

MIT © [Richard Anaya](https://github.com/richardanaya)
