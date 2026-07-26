/**
 * pi-cd — /cd command to change pi's working directory.
 *
 * Features:
 * - Path argument with directory autocomplete
 * - Interactive browser when invoked with no args
 * - Recent destinations + previous dir (`-`)
 * - Keep conversation (fork session into new cwd) or --new for a clean session
 *
 * Pi's tools/skills/sessions are cwd-bound. Switching is done by creating a
 * session under the target cwd and ctx.switchSession(), which rebuilds runtime services.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
	type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

const STATE_DIR = join(homedir(), ".pi", "agent");
const STATE_PATH = join(STATE_DIR, "pi-cd-state.json");
const MAX_RECENTS = 24;
const MAX_COMPLETIONS = 40;

type CdState = {
	previous?: string;
	recents: string[];
};

type ParsedArgs =
	| { kind: "help" }
	| { kind: "clear-recents" }
	| { kind: "recents-picker" }
	| { kind: "browser" }
	| { kind: "go"; path: string; fresh: boolean };

function loadState(): CdState {
	try {
		if (!existsSync(STATE_PATH)) return { recents: [] };
		const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<CdState>;
		return {
			previous: typeof raw.previous === "string" ? raw.previous : undefined,
			recents: Array.isArray(raw.recents)
				? raw.recents.filter((x): x is string => typeof x === "string")
				: [],
		};
	} catch {
		return { recents: [] };
	}
}

function saveState(state: CdState): void {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
	} catch {
		// best-effort persistence
	}
}

function rememberVisit(from: string, to: string): void {
	const state = loadState();
	state.previous = from;
	const next = [to, ...state.recents.filter((r) => r !== to && r !== from)];
	state.recents = next.slice(0, MAX_RECENTS);
	saveState(state);
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~" + sep)) {
		return join(homedir(), input.slice(2));
	}
	return input;
}

function displayPath(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	if (p.startsWith(home + sep)) return "~" + p.slice(home.length);
	return p;
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return normalize(p);
	}
}

function resolveTarget(cwd: string, raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return safeRealpath(cwd);

	if (trimmed === "-") {
		const prev = loadState().previous;
		if (!prev) throw new Error("No previous directory");
		return safeRealpath(prev);
	}

	const expanded = expandHome(trimmed);
	const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	return safeRealpath(abs);
}

function assertDirectory(path: string): void {
	if (!existsSync(path)) {
		throw new Error(`No such directory: ${displayPath(path)}`);
	}
	const st = statSync(path);
	if (!st.isDirectory()) {
		throw new Error(`Not a directory: ${displayPath(path)}`);
	}
}

function listSubdirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d: Dirent) => d.isDirectory() && !d.name.startsWith("."))
			.map((d: Dirent) => d.name)
			.sort((a: string, b: string) => a.localeCompare(b));
	} catch {
		return [];
	}
}

function listSubdirsIncludingHidden(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d: Dirent) => d.isDirectory())
			.map((d: Dirent) => d.name)
			.sort((a: string, b: string) => {
				// non-dot first
				const ad = a.startsWith(".") ? 1 : 0;
				const bd = b.startsWith(".") ? 1 : 0;
				if (ad !== bd) return ad - bd;
				return a.localeCompare(b);
			});
	} catch {
		return [];
	}
}

function tokenizeArgs(args: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < args.length; i++) {
		const ch = args[i];
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

function parseArgs(args: string): ParsedArgs {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "browser" };

	const tokens = tokenizeArgs(trimmed);
	if (tokens.length === 0) return { kind: "browser" };

	let fresh = false;
	const paths: string[] = [];

	for (const t of tokens) {
		if (t === "--help" || t === "-h") return { kind: "help" };
		if (t === "--clear-recents") return { kind: "clear-recents" };
		if (t === "--recents" || t === "-r") return { kind: "recents-picker" };
		if (t === "--new" || t === "-n") {
			fresh = true;
			continue;
		}
		if (t.startsWith("-") && t !== "-" && t !== "--") {
			// unknown flag — treat as path only if it looks like a path; else ignore-ish
			if (t.includes("/") || t === ".." || t.startsWith("~")) paths.push(t);
			else throw new Error(`Unknown flag: ${t}\nTry /cd --help`);
			continue;
		}
		paths.push(t);
	}

	if (paths.length === 0) {
		if (fresh) return { kind: "browser" }; // /cd -n → browser, then fresh switch
		return { kind: "browser" };
	}

	// Join remaining as one path (supports unquoted spaces only if quoted by user)
	const path = paths.join(" ");
	return { kind: "go", path, fresh };
}

function helpText(): string {
	return [
		"/cd — change pi working directory",
		"",
		"  /cd                  interactive browser",
		"  /cd <path>           go there (keep conversation)",
		"  /cd -n <path>        new session in path",
		"  /cd --new <path>     same as -n",
		"  /cd -                previous directory",
		"  /cd ~                home",
		"  /cd ..               parent",
		"  /cd --recents        pick from recent destinations",
		"  /cd --clear-recents  clear recent list",
		"",
		"Tab-complete paths after /cd. History is forked into the new cwd by default.",
	].join("\n");
}

function completionItemsForPrefix(cwd: string, prefix: string): AutocompleteItem[] {
	const specials: AutocompleteItem[] = [
		{ value: "-", label: "-", description: "previous directory" },
		{ value: "~", label: "~", description: "home" },
		{ value: "..", label: "..", description: "parent" },
		{ value: "--new", label: "--new", description: "fresh session (no history)" },
		{ value: "-n", label: "-n", description: "fresh session (no history)" },
		{ value: "--recents", label: "--recents", description: "pick from recents" },
		{ value: "--help", label: "--help", description: "usage" },
	];

	const p = prefix;
	const items: AutocompleteItem[] = [];

	// Specials / flags when the token looks like a flag or is empty / short special
	const wantsSpecials =
		!p || p.startsWith("-") || p === "~" || p === "." || p === ".." || (!p.includes("/") && !p.includes(sep));
	if (wantsSpecials) {
		for (const s of specials) {
			if (!p || s.value.startsWith(p) || s.label.startsWith(p)) items.push(s);
		}
	}

	// Recents matching (skip when typing an absolute/relative path with slash)
	if (!p.includes("/") && !p.includes(sep)) {
		const state = loadState();
		for (const r of state.recents) {
			const d = displayPath(r);
			if (!p || d.includes(p) || basename(r).toLowerCase().startsWith(p.toLowerCase())) {
				items.push({
					value: d.startsWith("~") ? d : r,
					label: d,
					description: "recent",
				});
			}
		}
	}

	// Directory completions
	const expanded = expandHome(p || "");
	let dirToList: string;
	let namePrefix: string;
	let valuePrefix: string;

	if (!p || p === "") {
		dirToList = cwd;
		namePrefix = "";
		valuePrefix = "";
	} else if (p.endsWith("/") || p.endsWith(sep)) {
		dirToList = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
		namePrefix = "";
		valuePrefix = p;
	} else {
		const parentRaw = dirname(expanded);
		const base = basename(expanded);
		dirToList =
			parentRaw === "."
				? cwd
				: isAbsolute(parentRaw)
					? parentRaw
					: resolve(cwd, parentRaw);
		namePrefix = base;
		const slash = p.endsWith("/") ? p : p.slice(0, p.length - base.length);
		valuePrefix = slash;
	}

	if (existsSync(dirToList)) {
		try {
			const st = statSync(dirToList);
			if (st.isDirectory()) {
				const names = listSubdirsIncludingHidden(dirToList).filter((n) =>
					n.toLowerCase().startsWith(namePrefix.toLowerCase()),
				);
				for (const name of names) {
					const value = valuePrefix + name + "/";
					const full = join(dirToList, name);
					items.push({
						value,
						label: value.startsWith("~") || isAbsolute(value) ? displayPath(full) + "/" : value,
						description: "directory",
					});
				}
			}
		} catch {
			// ignore
		}
	}

	// Dedupe by value, prefer earlier (specials/recents)
	const seen = new Set<string>();
	const out: AutocompleteItem[] = [];
	for (const it of items) {
		if (seen.has(it.value)) continue;
		seen.add(it.value);
		out.push(it);
		if (out.length >= MAX_COMPLETIONS) break;
	}
	return out;
}

async function pickFromList(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
): Promise<string | null> {
	if (items.length === 0) return null;
	if (ctx.mode !== "tui") {
		// Fallback: first item or ui.select with labels
		const labels = items.map((i) =>
			i.description ? `${i.label} — ${i.description}` : i.label,
		);
		const chosen = await ctx.ui.select(title, labels);
		if (!chosen) return null;
		const idx = labels.indexOf(chosen);
		return idx >= 0 ? items[idx].value : null;
	}

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));

		const selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · type to filter · enter select · esc cancel")));
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

type BrowserAction =
	| { type: "cancel" }
	| { type: "choose"; path: string }
	| { type: "navigate"; path: string };

/**
 * Interactive directory browser.
 * Enter on a subdirectory navigates into it; "Use this directory" confirms.
 */
async function browseDirectory(
	ctx: ExtensionCommandContext,
	startDir: string,
): Promise<string | null> {
	if (ctx.mode !== "tui") {
		// Non-TUI: simple select of children + specials
		let current = safeRealpath(startDir);
		for (;;) {
			const entries: SelectItem[] = [
				{ value: "__use__", label: `✓ Use this directory`, description: displayPath(current) },
				{ value: "__up__", label: "..", description: "parent" },
			];
			for (const name of listSubdirs(current)) {
				entries.push({
					value: join(current, name),
					label: name + "/",
					description: "open",
				});
			}
			const labels = entries.map((e) =>
				e.description ? `${e.label}  ${e.description}` : e.label,
			);
			const chosen = await ctx.ui.select(`cd · ${displayPath(current)}`, labels);
			if (!chosen) return null;
			const idx = labels.indexOf(chosen);
			if (idx < 0) return null;
			const item = entries[idx];
			if (item.value === "__use__") return current;
			if (item.value === "__up__") {
				current = dirname(current);
				continue;
			}
			current = item.value;
		}
	}

	let current = safeRealpath(startDir);

	const runRound = (): Promise<BrowserAction> =>
		ctx.ui.custom<BrowserAction>((tui, theme, _kb, done) => {
			const buildItems = (): SelectItem[] => {
				const items: SelectItem[] = [
					{
						value: "__use__",
						label: "✓ Use this directory",
						description: displayPath(current),
					},
				];
				if (dirname(current) !== current) {
					items.push({
						value: "__up__",
						label: "..",
						description: displayPath(dirname(current)),
					});
				}
				// Recents that are under or near — show a few at top when at start
				const recents = loadState().recents.filter((r) => r !== current).slice(0, 5);
				for (const r of recents) {
					items.push({
						value: `__recent__:${r}`,
						label: displayPath(r),
						description: "recent · enter to jump",
					});
				}
				for (const name of listSubdirsIncludingHidden(current)) {
					items.push({
						value: join(current, name),
						label: name + "/",
						description: "directory",
					});
				}
				return items;
			};

			let items = buildItems();
			const container = new Container();
			const header = new Text("");
			const selectList = new SelectList(items, 14, {
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			});

			const refreshHeader = () => {
				header.setText(
					theme.fg("accent", theme.bold("cd")) +
						theme.fg("dim", "  ") +
						theme.fg("muted", displayPath(current)),
				);
			};
			refreshHeader();

			const rebuild = () => {
				items = buildItems();
				// SelectList has no setItems — recreate via filter reset by constructing new list is hard;
				// we rebuild by mutating through a new SelectList reference... use outer replacement.
			};

			// We can't easily replace SelectList children mid-flight; navigation = done(navigate) and new round.
			selectList.onSelect = (item) => {
				if (item.value === "__use__") {
					done({ type: "choose", path: current });
					return;
				}
				if (item.value === "__up__") {
					done({ type: "navigate", path: dirname(current) });
					return;
				}
				if (item.value.startsWith("__recent__:")) {
					done({ type: "navigate", path: item.value.slice("__recent__:".length) });
					return;
				}
				done({ type: "navigate", path: item.value });
			};
			selectList.onCancel = () => done({ type: "cancel" });

			container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
			container.addChild(header);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`from ${displayPath(ctx.cwd)}` +
							(current !== ctx.cwd ? `  ·  Δ ${displayPath(relative(ctx.cwd, current) || ".")}` : ""),
					),
				),
			);
			container.addChild(selectList);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						"↑↓ move · type filter · enter open/use · esc cancel",
					),
				),
			);
			container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

			// silence unused
			void rebuild;

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					// Left arrow → up a level (common file-manager binding)
					if (data === "\x1b[D") {
						done({ type: "navigate", path: dirname(current) });
						return;
					}
					// Right arrow → enter selected directory if any
					if (data === "\x1b[C") {
						const sel = selectList.getSelectedItem();
						if (sel) selectList.onSelect?.(sel);
						return;
					}
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

	for (;;) {
		const action = await runRound();
		if (action.type === "cancel") return null;
		if (action.type === "choose") return action.path;
		// navigate
		try {
			assertDirectory(action.path);
			current = safeRealpath(action.path);
		} catch (e) {
			ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
		}
	}
}

async function changeCwd(
	ctx: ExtensionCommandContext,
	targetRaw: string,
	fresh: boolean,
): Promise<void> {
	let target: string;
	try {
		target = resolveTarget(ctx.cwd, targetRaw);
		assertDirectory(target);
	} catch (e) {
		ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
		return;
	}

	const from = safeRealpath(ctx.cwd);
	if (target === from) {
		ctx.ui.notify(`Already in ${displayPath(target)}`, "info");
		return;
	}

	// Ensure we don't switch mid-stream
	if (!ctx.isIdle()) {
		const ok = await ctx.ui.confirm(
			"Agent is busy",
			"Switch directory anyway? In-flight work may be interrupted.",
		);
		if (!ok) return;
		ctx.abort();
		await ctx.waitForIdle();
	}

	const sourceFile = ctx.sessionManager.getSessionFile();
	let nextFile: string | undefined;

	try {
		if (!fresh && sourceFile && existsSync(sourceFile)) {
			const sm = SessionManager.forkFrom(sourceFile, target);
			nextFile = sm.getSessionFile();
		} else {
			const sm = SessionManager.create(target);
			nextFile = sm.getSessionFile();
		}
	} catch (e) {
		ctx.ui.notify(
			`Failed to prepare session in ${displayPath(target)}: ${e instanceof Error ? e.message : String(e)}`,
			"error",
		);
		return;
	}

	if (!nextFile) {
		ctx.ui.notify("Could not create a session file for the target directory", "error");
		return;
	}

	rememberVisit(from, target);

	// Best-effort OS cwd for anything that still reads process.cwd()
	try {
		process.chdir(target);
	} catch {
		// ignore — pi runtime uses session cwd
	}

	const modeLabel = fresh ? "new session" : "history kept";
	const result = await ctx.switchSession(nextFile, {
		withSession: async (newCtx) => {
			newCtx.ui.notify(
				`cwd ${displayPath(from)} → ${displayPath(newCtx.cwd)}  (${modeLabel})`,
				"info",
			);
			newCtx.ui.setStatus("pi-cd", displayPath(newCtx.cwd));
		},
	});

	if (result.cancelled) {
		// restore process cwd if cancelled
		try {
			process.chdir(from);
		} catch {
			// ignore
		}
		ctx.ui.notify("Directory change cancelled", "warning");
	}
}

export default function piCdExtension(pi: ExtensionAPI) {
	/** Mirrored session cwd for getArgumentCompletions (no ctx there). */
	let sessionCwd = process.cwd();

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		try {
			process.chdir(ctx.cwd);
		} catch {
			// ignore
		}
		ctx.ui.setStatus("pi-cd", displayPath(ctx.cwd));
	});

	pi.registerCommand("cd", {
		description: "Change working directory (browser, paths, recents)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const cwd = sessionCwd || process.cwd();
			const items = completionItemsForPrefix(cwd, prefix);
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			let parsed: ParsedArgs;
			try {
				parsed = parseArgs(args);
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
				return;
			}

			if (parsed.kind === "help") {
				ctx.ui.notify(helpText(), "info");
				return;
			}

			if (parsed.kind === "clear-recents") {
				const state = loadState();
				state.recents = [];
				saveState(state);
				ctx.ui.notify("Cleared recent directories", "info");
				return;
			}

			if (parsed.kind === "recents-picker") {
				const recents = loadState().recents;
				if (recents.length === 0) {
					ctx.ui.notify("No recent directories yet", "info");
					return;
				}
				const items: SelectItem[] = recents.map((r) => ({
					value: r,
					label: displayPath(r),
					description: existsSync(r) ? "directory" : "missing",
				}));
				const chosen = await pickFromList(ctx, "Recent directories", items);
				if (!chosen) return;
				await changeCwd(ctx, chosen, false);
				return;
			}

			// Detect fresh flag when browser was opened via /cd -n with no path
			const tokens = tokenizeArgs(args.trim());
			const freshOnly =
				tokens.length > 0 &&
				tokens.every((t) => t === "-n" || t === "--new") &&
				parsed.kind === "browser";

			if (parsed.kind === "browser") {
				const target = await browseDirectory(ctx, ctx.cwd);
				if (!target) return;
				await changeCwd(ctx, target, freshOnly);
				return;
			}

			if (parsed.kind === "go") {
				await changeCwd(ctx, parsed.path, parsed.fresh);
			}
		},
	});
}
