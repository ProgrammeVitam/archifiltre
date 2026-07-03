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
	level: 'error' | 'warn' | 'window-error' | 'unhandled-rejection';
	text: string;
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

function push(level: LogEntry['level'], text: string): void {
	entries.push({ ts: new Date().toISOString(), level, text });
	if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
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

/** Render the buffer as text lines for the export bundle's frontend.log. */
export function getFrontendLog(): string {
	if (entries.length === 0) return '(no frontend errors or warnings captured this session)\n';
	return entries.map((e) => `${e.ts} [${e.level}] ${e.text}`).join('\n') + '\n';
}
