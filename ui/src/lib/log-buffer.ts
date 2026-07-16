/**
 * Frontend log capture — an in-memory ring buffer of the webview's errors/warnings.
 *
 * The webview persists nothing: console.error dies in the WebKitGTK console and
 * window errors vanish on close. This module wraps console.error/warn (call-through,
 * behaviour unchanged) and hooks window `error` + `unhandledrejection`, keeping the
 * last N entries in memory. The "Export logs" support bundle serialises the buffer
 * into `frontend.log`, so a user's bundle carries the current session's UI-side story
 * (e.g. failed queries, session errors) alongside the sidecar's log files.
 *
 * Deliberately dependency-free (imported by app bootstrap before anything else) and
 * never throws — log capture must not be able to break the app.
 */

interface LogEntry {
	ts: string;
	level: 'error' | 'warn' | 'window-error' | 'unhandled-rejection' | 'engine';
	text: string;
	attrs?: Record<string, unknown>;
}

const MAX_ENTRIES = 2000;
const entries: LogEntry[] = [];
let installed = false;

function serialize(arg: unknown): string {
	try {
		if (typeof arg === 'string') return arg;
		if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

function push(level: LogEntry['level'], text: string, attrs?: Record<string, unknown>): void {
	entries.push({ ts: new Date().toISOString(), level, text, attrs });
	if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/**
 * Record an engine-lifecycle event into the ring so the UI leg of the AI trace (where the
 * `describeId` originates) is present in the export, not just console errors. Renders as RFC5424
 * with `event` as the message and `attrs` (describeId, path, kind…) in the `[context …]` block.
 */
export function logFrontend(event: string, attrs?: Record<string, unknown>): void {
	try {
		push('engine', event, attrs);
	} catch {
		/* capture must never break the app */
	}
}

/** Install the capture hooks (idempotent). Call once at app bootstrap. */
export function installLogCapture(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;

	for (const level of ['error', 'warn'] as const) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			try {
				push(level, args.map(serialize).join(' '));
			} catch {
				/* capture must never break logging */
			}
			original(...args);
		};
	}

	window.addEventListener('error', (e) => {
		push('window-error', `${e.message} (${e.filename ?? '?'}:${e.lineno ?? '?'})`);
	});
	window.addEventListener('unhandledrejection', (e) => {
		push('unhandled-rejection', serialize(e.reason));
	});
}

// RFC5424 severity per level (facility 16/local0 → priority = 128 + severity), so frontend.log is
// uniform with the sidecar/helper/owner rings and merges into one timestamp-ordered timeline.
const SEVERITY: Record<LogEntry['level'], number> = {
	error: 3,
	'window-error': 3,
	'unhandled-rejection': 3,
	warn: 4,
	engine: 6
};

/** Escape a structured-data value: RFC5424 SD forbids raw `"`; keep each record on ONE line and
 *  never emit `]` (which would truncate the `[context …]` block) so the line-based merge is safe. */
function sd(v: unknown): string {
	return String(v).replace(/"/g, '\\"').replace(/[\]\r\n]+/g, ' ');
}

/** Render the buffer as RFC5424 lines for the export bundle's frontend.log. One record per line
 *  (`<pri>1 <ts> webview archifiltre-ui - - [context source="frontend" …] <msg>`) — host/procid are
 *  synthetic since a webview has neither. */
export function getFrontendLog(): string {
	if (entries.length === 0) return '(no frontend errors or warnings captured this session)\n';
	return (
		entries
			.map((e) => {
				const pri = 16 * 8 + SEVERITY[e.level];
				const ctx = [
					['source', 'frontend'],
					['level', e.level],
					...Object.entries(e.attrs ?? {}).filter(([, v]) => v !== undefined)
				]
					.map(([k, v]) => `${k}="${sd(v)}"`)
					.join(' ');
				const body = e.text.replace(/[\r\n]+/g, ' | ');
				return `<${pri}>1 ${e.ts} webview archifiltre-ui - - [context ${ctx}] ${body}`;
			})
			.join('\n') + '\n'
	);
}
