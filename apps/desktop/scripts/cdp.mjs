// CDP driver — remote-control the running Curator desktop app's renderer over
// the Chrome DevTools Protocol, for verifying UI changes in the real app
// (no Playwright/Puppeteer needed; uses Node's built-in fetch + WebSocket).
//
// Launch the app with a debug port first, e.g.:
//   pnpm --filter @curator/desktop dev -- --remote-debugging-port=9222
// then drive it:
//   pnpm --filter @curator/desktop cdp <command> [args]
//   node apps/desktop/scripts/cdp.mjs <command> [args]
//
// Commands:
//   targets                List debuggable page targets (and which one we drive)
//   eval "<js>"            Evaluate JS in the renderer; prints the JSON result
//   eval -                 Evaluate JS read from stdin   (avoids shell quoting)
//   evalfile <path>        Evaluate JS read from a file  (avoids shell quoting)
//   shot [out.png]         Screenshot the window (default: shot.png)
//   hover "<sel>"          Move the cursor over an element's center (:hover)
//   click "<sel>"          Trusted left click at the element's center
//   dblclick "<sel>"       Trusted double-click (e.g. play a track row)
//   key "<combo>"          Trusted key press, e.g. "Ctrl+a", "Shift+ArrowDown", "Enter"
//
// Why eval-from-file/stdin: passing a non-trivial JS expression as a quoted
// CLI arg gets its embedded quotes mangled by some shells (PowerShell in
// particular), producing SyntaxErrors. Writing the probe to a file (or piping
// it on stdin) sidesteps the shell entirely.
//
// Env:
//   CURATOR_CDP_PORT       DevTools debug port (default 9222)

const PORT = Number(process.env.CURATOR_CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;
const [, , cmd, ...rest] = process.argv;

const USAGE = `cdp — drive the running Curator app over the Chrome DevTools Protocol

Usage: node apps/desktop/scripts/cdp.mjs <command> [args]
       pnpm --filter @curator/desktop cdp <command> [args]

  targets                List page targets
  eval "<js>" | eval -   Evaluate JS (arg, or '-' for stdin)
  evalfile <path>        Evaluate JS from a file
  shot [out.png]         Screenshot
  hover "<sel>"          Hover an element
  click "<sel>"          Trusted click
  dblclick "<sel>"       Trusted double-click
  key "<combo>"          Trusted key, e.g. "Ctrl+a", "Shift+ArrowDown", "Enter"

App must be launched with --remote-debugging-port=${PORT} (CURATOR_CDP_PORT to override).`;

function die(msg) { console.error(msg); process.exit(1); }

async function listTargets() {
	let res;
	try {
		res = await fetch(`${BASE}/json/list`);
	} catch {
		die(`Could not reach the app on ${BASE}.\nLaunch it with --remote-debugging-port=${PORT} (or set CURATOR_CDP_PORT).`);
	}
	return res.json();
}

// The Curator window is the http(s) page target in dev, or the packaged
// app.asar file:// page; skip the devtools:// target either way.
async function appPage() {
	const list = await listTargets();
	const page = list.find((t) => t.type === 'page' && /^(https?|file):/.test(t.url));
	if (!page) die('No app page target found (is the renderer loaded?).');
	return page;
}

async function readStdin() {
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return Buffer.concat(chunks).toString('utf8');
}

// ── Key-combo parsing ───────────────────────────────────────────────────────
// "Ctrl+Shift+a" → { modifiers, key, code, vk }. modifiers bitmask matches CDP:
// Alt=1, Ctrl=2, Meta=4, Shift=8.
const MOD_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, cmd: 4, meta: 4, command: 4, shift: 8 };
const NAMED_KEYS = {
	enter: { key: 'Enter', code: 'Enter', vk: 13 },
	escape: { key: 'Escape', code: 'Escape', vk: 27 },
	esc: { key: 'Escape', code: 'Escape', vk: 27 },
	tab: { key: 'Tab', code: 'Tab', vk: 9 },
	space: { key: ' ', code: 'Space', vk: 32 },
	backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
	delete: { key: 'Delete', code: 'Delete', vk: 46 },
	del: { key: 'Delete', code: 'Delete', vk: 46 },
	arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
	arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
	arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
	arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
	home: { key: 'Home', code: 'Home', vk: 36 },
	end: { key: 'End', code: 'End', vk: 35 },
	pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
	pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

function parseCombo(combo) {
	const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
	const keyTok = parts.pop();
	if (!keyTok) die(`Empty key combo: "${combo}"`);
	let modifiers = 0;
	for (const p of parts) {
		const bit = MOD_BITS[p.toLowerCase()];
		if (!bit) die(`Unknown modifier "${p}" in "${combo}"`);
		modifiers |= bit;
	}
	const shift = (modifiers & 8) !== 0;
	const lower = keyTok.toLowerCase();
	let resolved;
	if (NAMED_KEYS[lower]) {
		resolved = { ...NAMED_KEYS[lower] };
	} else if (/^[a-z]$/i.test(keyTok)) {
		const up = keyTok.toUpperCase();
		resolved = { key: shift ? up : keyTok.toLowerCase(), code: `Key${up}`, vk: up.charCodeAt(0) };
	} else if (/^[0-9]$/.test(keyTok)) {
		resolved = { key: keyTok, code: `Digit${keyTok}`, vk: keyTok.charCodeAt(0) };
	} else {
		// Single symbol / unknown — pass through verbatim; renderer matches on .key.
		resolved = { key: keyTok, code: '', vk: keyTok.length === 1 ? keyTok.toUpperCase().charCodeAt(0) : 0 };
	}
	return { modifiers, ...resolved };
}

// ── Connection ──────────────────────────────────────────────────────────────
const page = await appPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket failed to open')); }).catch((e) => die(String(e)));
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
function send(method, params = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res) => pending.set(id, res)); }

async function centerOf(sel) {
	const expr = `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()`;
	const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
	return r.result?.result?.value ?? null;
}
async function mouse(type, pt, extra = {}) { await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, ...extra }); }

let exitCode = 0;
try {
	if (cmd === 'targets') {
		const list = await listTargets();
		for (const t of list) console.log(`${t.type === 'page' && /^https?:/.test(t.url) ? '*' : ' '} ${t.type.padEnd(8)} ${t.url}`);
		console.log(`\n(* = the target this driver controls; port ${PORT})`);
	} else if (cmd === 'eval' || cmd === 'evalfile') {
		let expression;
		if (cmd === 'evalfile') {
			if (!rest[0]) die('evalfile needs a path');
			const { readFileSync } = await import('node:fs');
			expression = readFileSync(rest[0], 'utf8');
		} else if (rest[0] === '-') {
			expression = await readStdin();
		} else {
			expression = rest.join(' ');
		}
		if (!expression.trim()) die('nothing to evaluate');
		const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) {
			console.error('EXCEPTION:', JSON.stringify(r.result.exceptionDetails, null, 2));
			exitCode = 1;
		} else {
			console.log(JSON.stringify(r.result?.result?.value ?? null, null, 2));
		}
	} else if (cmd === 'shot') {
		const out = rest[0] || 'shot.png';
		const r = await send('Page.captureScreenshot', { format: 'png' });
		const { writeFileSync } = await import('node:fs');
		writeFileSync(out, Buffer.from(r.result.data, 'base64'));
		console.log('saved', out);
	} else if (cmd === 'hover') {
		const pt = await centerOf(rest.join(' ')); if (!pt) die('no element matched');
		await mouse('mouseMoved', pt, { buttons: 0 });
		console.log('hovered', JSON.stringify(pt));
	} else if (cmd === 'click') {
		const pt = await centerOf(rest.join(' ')); if (!pt) die('no element matched');
		await mouse('mouseMoved', pt, { buttons: 0 });
		await mouse('mousePressed', pt, { button: 'left', buttons: 1, clickCount: 1 });
		await mouse('mouseReleased', pt, { button: 'left', buttons: 0, clickCount: 1 });
		console.log('clicked', JSON.stringify(pt));
	} else if (cmd === 'dblclick') {
		const pt = await centerOf(rest.join(' ')); if (!pt) die('no element matched');
		await mouse('mouseMoved', pt, { buttons: 0 });
		await mouse('mousePressed', pt, { button: 'left', buttons: 1, clickCount: 1 });
		await mouse('mouseReleased', pt, { button: 'left', buttons: 0, clickCount: 1 });
		await mouse('mousePressed', pt, { button: 'left', buttons: 1, clickCount: 2 });
		await mouse('mouseReleased', pt, { button: 'left', buttons: 0, clickCount: 2 });
		console.log('dblclicked', JSON.stringify(pt));
	} else if (cmd === 'key') {
		if (!rest[0]) die('key needs a combo, e.g. "Ctrl+a"');
		const { modifiers, key, code, vk } = parseCombo(rest.join(' '));
		const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
		// `text` makes a printable, unmodified key actually type into a focused
		// input; omit it for shortcut combos (Ctrl/Cmd/Alt) and named keys.
		const printable = key.length === 1 && !(modifiers & (1 | 2 | 4));
		await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(printable ? { text: key } : {}) });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
		console.log('key sent', JSON.stringify(base));
	} else {
		console.log(USAGE);
		exitCode = cmd ? 1 : 0;
	}
} finally {
	ws.close();
}
process.exit(exitCode);
