import assert from "node:assert/strict";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import vm from "node:vm";

// Run the actual command handler without loading Pi or touching the user's cwd/state.
// Only host imports are replaced; path resolution, validation, and filesystem logic
// come from index.ts. UI/session services are mocked, not live terminal rendering.
const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const code = stripTypeScriptTypes(source)
	.replace(/^import[\s\S]*?;\r?\n/gm, "")
	.replace("export default function piCdExtension", "function piCdExtension");

function harness(t, mode = "tui") {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pi-cd-test-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const cwd = path.join(root, "cwd");
	fs.mkdirSync(cwd);
	const notifications = [], sessions = [], switches = [], actions = [], inputs = [];
	let command, selectList;
	class Container { addChild() {} }
	class Text { setText() {} }
	class SelectList {
		constructor(items) { this.items = items; selectList = this; }
	}
	const session = (target, fresh) => {
		sessions.push({ target, fresh });
		return { getSessionFile: () => target };
	};
	const sandbox = {
		...fs, ...path, homedir: () => home,
		mkdirSync(target, options) {
			if (path.basename(target) === "denied") {
				throw new Error("EACCES: permission denied");
			}
			return fs.mkdirSync(target, options);
		},
		Container, Text, SelectList, DynamicBorder: class {},
		SessionManager: {
			create: target => session(target, true),
			forkFrom: (_source, target) => session(target, false),
		},
		process: { cwd: () => cwd, chdir() {} },
	};
	vm.createContext(sandbox);
	vm.runInContext(code + "\nthis.extension = piCdExtension;", sandbox);
	sandbox.extension({
		on() {},
		registerCommand(name, definition) { assert.equal(name, "cd"); command = definition; },
	});
	const theme = { fg: (_color, text) => text, bold: text => text };
	const sourceFile = path.join(root, "source.jsonl");
	fs.writeFileSync(sourceFile, "");
	const ctx = {
		cwd, mode,
		isIdle: () => true,
		sessionManager: { getSessionFile: () => sourceFile },
		ui: {
			notify: (message, type) => notifications.push({ message, type }),
			setStatus() {},
			input: async title => {
				assert.ok(title.startsWith("Create directory in "));
				return inputs.shift();
			},
			custom: async factory => new Promise(done => {
				factory({ requestRender() {} }, theme, {}, done);
				assert.ok(selectList.items.some(item => item.value === "__create__"));
				const action = actions.shift();
				if (action === "cancel") return selectList.onCancel();
				const item = selectList.items.find(item => item.value === action);
				assert.ok(item, `Missing browser action: ${action}`);
				selectList.onSelect(item);
			}),
			select: async (_title, labels) => {
				const action = actions.shift();
				if (action === "cancel") return undefined;
				const prefix = action === "__create__" ? "Create directory…"
					: action === "__use__" ? "✓ Use this directory"
					: action === "__up__" ? ".."
					: path.basename(action) + "/";
				const label = labels.find(label => label.startsWith(prefix));
				assert.ok(label, `Missing select action: ${action}`);
				return label;
			},
		},
		switchSession: async (target, options) => {
			switches.push(target);
			await options.withSession({ ...ctx, cwd: target });
			return { cancelled: false };
		},
	};
	function state(value) {
		const dir = path.join(home, ".pi", "agent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "pi-cd-state.json"), JSON.stringify(value));
	}
	return { root, home, cwd, ctx, sessions, switches, notifications, actions, inputs, state,
		run: args => command.handler(args, ctx) };
}

test("explicit paths create missing parents, keep history, and support spaces", async t => {
	const h = harness(t);
	await h.run('projects/"new app"');
	const target = path.join(h.cwd, "projects", "new app");
	assert.ok(fs.statSync(target).isDirectory());
	assert.deepEqual(h.sessions, [{ target, fresh: false }]);
	assert.deepEqual(h.switches, [target]);
});

test("--new, absolute paths, and home expansion support directory creation", async t => {
	const h = harness(t);
	const absolute = path.join(h.root, "absolute", "child");
	await h.run(`--new "${absolute}"`);
	await h.run("-n ~/new-home-directory");
	assert.deepEqual(h.sessions, [
		{ target: absolute, fresh: true },
		{ target: path.join(h.home, "new-home-directory"), fresh: true },
	]);
});

test("existing directories work; files, parent files, and permission failures do not switch", async t => {
	const h = harness(t);
	fs.mkdirSync(path.join(h.cwd, "existing"));
	await h.run("existing");
	fs.writeFileSync(path.join(h.cwd, "file"), "unchanged");
	for (const target of ["file", "file/child", "denied"]) await h.run(target);
	assert.equal(h.switches.length, 1);
	assert.equal(h.notifications.filter(n => n.type === "error").length, 3);
	assert.equal(fs.readFileSync(path.join(h.cwd, "file"), "utf8"), "unchanged");
});

test("previous and recent destinations are not recreated when missing", async t => {
	const h = harness(t, "rpc");
	const missing = path.join(h.root, "missing");
	h.state({ previous: missing, recents: [missing] });
	await h.run("-");
	h.ctx.ui.select = async (_title, labels) => labels[0];
	await h.run("--recents");
	assert.equal(fs.existsSync(missing), false);
	assert.equal(h.switches.length, 0);
	assert.equal(h.notifications.filter(n => n.type === "error").length, 2);
});

for (const mode of ["tui", "rpc"]) {
	test(`${mode}: creation follows navigation and opens the new directory`, async t => {
		const h = harness(t, mode);
		const child = path.join(h.cwd, "child");
		fs.mkdirSync(child);
		h.actions.push(child, "__create__", "__use__");
		h.inputs.push("new folder");
		await h.run("");
		const target = path.join(child, "new folder");
		assert.ok(fs.statSync(target).isDirectory());
		assert.deepEqual(h.switches, [target]);
		assert.equal(h.actions.length, 0);
	});

	test(`${mode}: cancelling the name prompt preserves the browser location`, async t => {
		const h = harness(t, mode);
		h.actions.push("__create__", "cancel");
		h.inputs.push(undefined);
		await h.run("");
		assert.equal(h.notifications.length, 0);
		assert.equal(h.switches.length, 0);
		assert.deepEqual(fs.readdirSync(h.cwd), []);
	});

	test(`${mode}: invalid, existing, and inaccessible names leave the browser usable`, async t => {
		const h = harness(t, mode);
		fs.mkdirSync(path.join(h.cwd, "existing"));
		fs.writeFileSync(path.join(h.cwd, "file"), "unchanged");
		const names = ["", " ", ".", "..", "../escape", path.join(h.root, "absolute"),
			"nested/name", "bad\0name", "existing", "file", "denied"];
		for (const name of names) { h.actions.push("__create__"); h.inputs.push(name); }
		h.actions.push("__create__", "__use__");
		h.inputs.push(".hidden");
		await h.run("");
		assert.deepEqual(h.switches, [path.join(h.cwd, ".hidden")]);
		assert.equal(h.notifications.filter(n => n.type === "error").length, names.length);
		assert.equal(fs.existsSync(path.join(h.root, "escape")), false);
		assert.equal(fs.existsSync(path.join(h.cwd, "nested")), false);
	});

	test(`${mode}: -n browser creation keeps the fresh-session behavior`, async t => {
		const h = harness(t, mode);
		h.actions.push("__create__", "__use__");
		h.inputs.push("fresh");
		await h.run("-n");
		assert.deepEqual(h.sessions, [{ target: path.join(h.cwd, "fresh"), fresh: true }]);
	});
}
