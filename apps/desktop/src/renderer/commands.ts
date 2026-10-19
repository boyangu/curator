// Command registry — single source of truth for renderer commands and their
// keybindings. The big keydown handler in main.ts is a thin dispatcher over
// this: it does the early input-focus / view-scope guards, then hands the
// event to `dispatchKey`, which finds the first command whose key-spec and
// `when()` predicate both match and runs it.
//
// Why a registry: keyboard and context menus can now invoke the same behaviour
// by id (`registry.run(id)`), so action dispatch is unified instead of being
// duplicated inline per call site.
//
// Deliberately framework-free — no Solid, no DOM ownership. Commands' `run`
// bodies own their own `evt.preventDefault()` exactly where the behaviour
// requires it; the registry NEVER auto-preventDefaults, because some paths
// intentionally fall through to the browser default (e.g. a bare letter with
// an empty selection).

export interface Command {
	id: string;
	/** Human label — for a future command palette / menu surfaces. */
	title: string;
	/**
	 * Key specs, e.g. 'Space', 'Mod+a', 'Shift+ArrowUp', 'r'.
	 * 'Mod' = Ctrl OR Cmd. A spec with no Mod/Shift/Alt matches ONLY when
	 * those modifiers are absent, so 'r' does not fire on Ctrl+R and
	 * 'ArrowUp' is distinct from 'Shift+ArrowUp' / 'Mod+ArrowUp'.
	 */
	keys?: string[];
	/** Applicability predicate; defaults to always-true. */
	when?: () => boolean;
	run: (evt: KeyboardEvent) => void;
}

interface ParsedSpec {
	mod: boolean;
	shift: boolean;
	alt: boolean;
	/** Base key, lowercased for single letters. 'space' is special-cased. */
	key: string;
}

function parseSpec(spec: string): ParsedSpec {
	const parts = spec.split('+');
	let mod = false;
	let shift = false;
	let alt = false;
	let key = '';
	for (const raw of parts) {
		const p = raw.trim();
		const lower = p.toLowerCase();
		if (lower === 'mod') mod = true;
		else if (lower === 'shift') shift = true;
		else if (lower === 'alt') alt = true;
		else key = p;
	}
	// Single letters are case-insensitive; everything else (ArrowUp, Space,
	// Enter, Tab, Escape, …) matches KeyboardEvent.key verbatim.
	const normKey = key.length === 1 ? key.toLowerCase() : key;
	return { mod, shift, alt, key: normKey };
}

function specMatches(spec: ParsedSpec, evt: KeyboardEvent): boolean {
	const mod = evt.ctrlKey || evt.metaKey;
	// Modifier matrix is exact: a spec without Mod/Shift/Alt must NOT fire
	// when those modifiers are held — that's what keeps 'r' off Ctrl+R and
	// 'ArrowUp' distinct from 'Shift+ArrowUp'.
	if (spec.mod !== mod) return false;
	if (spec.shift !== evt.shiftKey) return false;
	if (spec.alt !== evt.altKey) return false;

	if (spec.key === 'Space') {
		return evt.key === ' ' || evt.code === 'Space';
	}
	if (spec.key.length === 1) {
		return evt.key.toLowerCase() === spec.key;
	}
	return evt.key === spec.key;
}

export class CommandRegistry {
	#byId = new Map<string, Command>();
	// Pre-parsed specs, kept in registration order so dispatch precedence is
	// deterministic ("first matching command wins").
	#entries: Array<{ cmd: Command; specs: ParsedSpec[] }> = [];

	register(cmd: Command): void {
		if (this.#byId.has(cmd.id)) {
			throw new Error(`Command already registered: ${cmd.id}`);
		}
		this.#byId.set(cmd.id, cmd);
		this.#entries.push({ cmd, specs: (cmd.keys ?? []).map(parseSpec) });
	}

	get(id: string): Command | undefined {
		return this.#byId.get(id);
	}

	/**
	 * Run a command by id (no event). Honors `when()`; returns whether it ran.
	 * For programmatic invocation from menus etc. — `run` receives a synthetic
	 * (empty) KeyboardEvent so commands that touch `evt` don't blow up.
	 */
	run(id: string): boolean {
		const cmd = this.#byId.get(id);
		if (!cmd) return false;
		if (cmd.when && !cmd.when()) return false;
		cmd.run(new KeyboardEvent('keydown'));
		return true;
	}

	/**
	 * Find the first command (registration order) whose key-spec AND `when()`
	 * both match this event, run it, and return true. Returns false if nothing
	 * matched — the caller leaves the event alone.
	 */
	dispatchKey(evt: KeyboardEvent): boolean {
		for (const { cmd, specs } of this.#entries) {
			if (specs.length === 0) continue;
			if (!specs.some((s) => specMatches(s, evt))) continue;
			if (cmd.when && !cmd.when()) continue;
			cmd.run(evt);
			return true;
		}
		return false;
	}
}
