/**
 * The summary subsystem's ONE state owner on the UI side — the describe engine.
 *
 * There used to be TWO deciders: this coordinator (root only) and FileDetailsPanel's own
 * describe effect (every selected folder, incl. the root). They raced — the panel's `user`
 * request preempted the coordinator's `auto` root run, which re-queued and surfaced as
 * "another summary is being generated". This module is now the SOLE trigger for every
 * describe; components render its output and never call the describe API themselves.
 *
 * Two trigger sources, ONE `generate()`, ONE per-target `summaries` map:
 *   • the ROOT target — driven PROACTIVELY by scan state (so the whole-scan overview is ready
 *     before the user opens it). Kind `auto`, preemptible by user clicks on the host.
 *   • the SELECTED sub-folder — driven REACTIVELY by selection (the user opened it). Kind
 *     `user`; switching folders cancels the previous in-flight run (switchMap semantics via
 *     `cancelDescribe`). The root (path '') is NEVER a selected target — it is exclusively
 *     root-driven, so no target is ever described twice.
 *
 * Rules are re-evaluated on every input change and are idempotent (keyed by target status),
 * so a missed edge cannot exist. Concurrency/ordering is delegated to the Rust host queue —
 * the engine only dedups per target. Svelte stores are the reactive substrate: `derived`
 * "desired" + the reconciler below is the native equivalent of combineLatest + switchMap.
 */
import { writable, get } from 'svelte/store';
import type { Unsubscriber } from 'svelte/store';
import {
	onJobUpdate,
	queryDirectoryDescription,
	cancelDescribe,
	persistDescription,
	isTransientSessionError,
	currentUiLang,
	type UnlistenFn
} from '$lib/tauri';
import { activeScan, scanPhase, aiMode, localModel, selectedItem, llmModelState } from '$lib/stores';

// ── Mirrored host state ──

export interface LlmQueueEntry {
	clientId: string;
	kind: 'user-describe' | 'auto-describe' | 'load';
	state: 'queued' | 'active';
}
export interface LlmHostState {
	model: { state: 'unloaded' | 'loading' | 'ready'; id: string | null; backend?: unknown };
	queue: LlmQueueEntry[];
}

/** The host's truthful state machine (model + queue), mirrored from `llm:state` events. */
export const llmState = writable<LlmHostState>({
	model: { state: 'unloaded', id: null },
	queue: []
});

// ── Per-target summary view (root and any sub-folder share this shape) ──

// 'pending-retry' — a transient owner-handoff error is being retried with backoff. It is a
// NON-refiring state (the rules skip it) so it can't drive a tight recompute→generate loop; the
// scheduled timer is the ONLY thing that re-attempts. Rendered as 'generating' (loading) in the
// view, so the user sees "working on it", not an error, during the backoff.
type SummaryStatus =
	| 'absent'
	| 'generating'
	| 'partial'
	| 'done'
	| 'error'
	| 'deferred-scan'
	| 'pending-retry';
export interface SummaryView {
	status: SummaryStatus;
	text: string | null;
	streamingText: string;
	model?: string;
	cached?: boolean;
	error?: string;
	/** Our request sits in the host queue behind something else (honest waiting label). */
	waiting: boolean;
	/** The model is loading (one-time warm) — shown instead of a bare spinner. */
	modelLoading: boolean;
}

const EMPTY_VIEW: SummaryView = {
	status: 'absent',
	text: null,
	streamingText: '',
	waiting: false,
	modelLoading: false
};

/** RootSummary renders this — the whole-scan overview for the active scan. */
export const rootSummary = writable<SummaryView>({ ...EMPTY_VIEW });
/** FileDetailsPanel renders this — the currently-selected sub-folder's summary. */
export const selectedSummary = writable<SummaryView>({ ...EMPTY_VIEW });

interface Stored {
	status: Exclude<SummaryStatus, 'generating'>;
	text: string | null;
	model?: string;
	cached?: boolean;
	error?: string;
	/** An authoritative mid-scan summary that was left uncached (persistence is deferred while
	 *  scanning). At completion the engine PERSISTS it as-is — no regeneration, so the on-screen
	 *  text never re-animates — then clears this flag. */
	needsPersist?: boolean;
}
const summaries = new Map<string, Stored>(); // key = `${db}::${path}::${lang}`
const inFlight = new Map<string, string>(); // key → streaming text (present iff generating)

// ── Bounded transient-retry (the guardrail that makes a self-healing retry safe) ──
// A transient owner-handoff error (owner not ready yet / momentarily churned) must be retried,
// but the retry MUST have: a cap, a backoff, and a non-refiring wait state. Without all three,
// "recover automatically" becomes "hammer the owner until the machine dies" (the crash we hit).
const RETRY_BACKOFFS_MS = [500, 1500, 4000]; // 3 retries over ~6s, then give up (spans owner churn)
const attempts = new Map<string, number>(); // key → transient attempts so far
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>(); // key → pending retry timer
let lastContext: string | null = null; // `${db}::${state}` — re-arm capped errors when it changes

function clearRetry(key: string): void {
	const t = retryTimers.get(key);
	if (t) clearTimeout(t);
	retryTimers.delete(key);
}

/** Forget a key's retry bookkeeping (on success, or when its context genuinely changes). */
function resetRetry(key: string): void {
	attempts.delete(key);
	clearRetry(key);
}

/** Handle a transient error for `key`: schedule ONE backed-off retry, or give up after the cap.
 *  Never re-fires via recompute (status 'pending-retry' is skipped by the rules) — the timer is
 *  the sole re-attempt, so this can never become a tight loop. `reason` is logged (captured by the
 *  app's exportable ring-buffer log) so the exact owner-handoff error is diagnosable — the open
 *  Phase-D question of WHICH transient (churn vs timeout-under-load) can only be answered from a
 *  real occurrence, since the crash that motivated this never got to flush a log. */
function scheduleTransientRetry(key: string, reason?: unknown): void {
	const n = attempts.get(key) ?? 0;
	console.warn(
		`[describe] transient owner error (attempt ${n + 1}/${RETRY_BACKOFFS_MS.length + 1}) for ${key}:`,
		String((reason as { message?: unknown })?.message ?? reason)
	);
	clearRetry(key);
	if (n >= RETRY_BACKOFFS_MS.length) {
		// Exhausted — show the friendly line and stop. A genuine context change re-arms it.
		attempts.delete(key);
		summaries.set(key, { status: 'error', text: null });
		return;
	}
	attempts.set(key, n + 1);
	summaries.set(key, { status: 'pending-retry', text: null });
	retryTimers.set(
		key,
		setTimeout(() => {
			retryTimers.delete(key);
			summaries.delete(key); // → absent, so the next recompute fires exactly ONE more attempt
			recompute();
		}, RETRY_BACKOFFS_MS[n])
	);
}

const STRUCTURE_READY_PHASES = ['prefilter', 'hashing', 'duplicate-detection', 'complete'];

function keyFor(db: string, path: string): string {
	return `${db}::${path}::${currentUiLang()}`;
}

/** The selected target is a NON-ROOT directory (the root is driven separately). Null when the
 *  selection is a file, empty, or the root — those have no panel-summary of their own. */
function selectedPath(): string | null {
	const sel = get(selectedItem);
	if (!sel || sel.type !== 'directory') return null;
	const p = sel.path ?? '';
	return p === '' ? null : p;
}

/** Build a view for one target from the stored result + any in-flight generation + host state. */
function viewFor(db: string, path: string): SummaryView {
	const key = keyFor(db, path);
	const streaming = inFlight.get(key);
	const stored = summaries.get(key);
	// A pending-retry (transient backoff) reads as a loading state, not an error — the user sees
	// "working on it" while the owner settles, never a flash of failure.
	const generating = streaming !== undefined || stored?.status === 'pending-retry';
	const host = get(llmState);
	return {
		status: generating ? 'generating' : (stored?.status ?? 'absent'),
		text: stored?.text ?? null,
		streamingText: streaming ?? '',
		model: stored?.model,
		cached: stored?.cached,
		error: stored?.error,
		waiting: generating && host.queue.some((e) => e.clientId === key && e.state === 'queued'),
		modelLoading: generating && host.model.state === 'loading'
	};
}

/** Refresh both view stores (no rule evaluation) — used during token streaming. */
function recomputeViews() {
	const db = get(activeScan)?.dbName ?? null;
	rootSummary.set(db ? viewFor(db, '') : { ...EMPTY_VIEW });
	const sel = selectedPath();
	selectedSummary.set(db && sel ? viewFor(db, sel) : { ...EMPTY_VIEW });
}

/** Refresh views AND evaluate the rules. Cheap; called on every input change. */
function recompute() {
	recomputeViews();

	const scan = get(activeScan);
	const db = scan?.dbName ?? null;
	if (!db) return;
	const mode = get(aiMode);
	if (mode === 'off') return;

	// Re-arm capped-out summaries when the context genuinely changes (tab switch / a fresh
	// scan-state transition) — a stuck 'error' gets fresh attempts, it doesn't sit forever.
	// Guarded on `${db}::${state}`, which is stable through a scan's progress ticks, so this body
	// runs only on a real transition (never per tick → never a re-describe loop).
	const ctx = `${db}::${scan?.state ?? ''}`;
	if (ctx !== lastContext) {
		lastContext = ctx;
		const sel = selectedPath();
		for (const p of sel === null ? [''] : ['', sel]) {
			const k = keyFor(db, p);
			if (summaries.get(k)?.status === 'error') {
				summaries.delete(k);
				resetRetry(k);
			}
		}
	}

	// ── Root rules (proactive) ──
	const rootKey = keyFor(db, '');
	if (!inFlight.has(rootKey)) {
		const status = summaries.get(rootKey)?.status ?? 'absent';
		const phase = get(scanPhase);
		const model = get(llmState).model;
		// Rule 1 — mid-scan: model already resident so we stream alongside hashing (leg 1's GPU
		// gate defers this to completion on a CPU backend; that lands as 'deferred-scan' → Rule 2).
		if (
			scan?.state === 'scanning' &&
			STRUCTURE_READY_PHASES.includes(phase) &&
			mode === 'local' &&
			model.state === 'ready' &&
			status === 'absent'
		) {
			void generate(db, '', { kind: 'auto', midScan: true });
		}
		// Rule 2 — settled: the final full-tree pass (also remote mode, the CPU-gate deferral,
		// and regenerating a genuinely-provisional mid-scan partial).
		else if (
			scan?.state === 'complete' &&
			(status === 'absent' || status === 'partial' || status === 'deferred-scan')
		) {
			void generate(db, '', { kind: 'auto', midScan: false });
		}
		// Rule 3 — promote: an authoritative mid-scan summary just needs persisting at completion
		// (no regeneration → no re-animation of the on-screen text).
		else if (scan?.state === 'complete' && status === 'done') {
			promote(db, '', rootKey);
		}
	}

	// ── Selected sub-folder rule (reactive) ──
	const sel = selectedPath();
	if (sel) {
		const key = keyFor(db, sel);
		if (!inFlight.has(key)) {
			const status = summaries.get(key)?.status ?? 'absent';
			if (status === 'absent') {
				void generate(db, sel, { kind: 'user', midScan: scan?.state === 'scanning' });
			} else if (
				scan?.state === 'complete' &&
				(status === 'deferred-scan' || status === 'partial')
			) {
				// Skipped mid-scan (CPU gate) or a provisional mid-scan tree → regenerate once settled.
				void generate(db, sel, { kind: 'user', midScan: false });
			} else if (scan?.state === 'complete' && status === 'done') {
				promote(db, sel, key); // authoritative mid-scan summary → persist, no regenerate
			}
		}
	}
}

/** Persist an authoritative mid-scan summary at completion WITHOUT regenerating it, so the
 *  on-screen text never re-animates. Idempotent: the flag is cleared synchronously before the
 *  fire-and-forget DB write, so repeated recomputes persist exactly once. No view change. */
function promote(db: string, path: string, key: string) {
	const s = summaries.get(key);
	if (!s || !s.needsPersist || !s.text) return;
	s.needsPersist = false;
	persistDescription(path, s.text, s.model ?? '', db);
}

async function generate(
	db: string,
	path: string,
	opts: { kind: 'user' | 'auto'; midScan: boolean }
) {
	const key = keyFor(db, path);
	inFlight.set(key, '');
	recomputeViews();
	try {
		const res = await queryDirectoryDescription(
			path,
			(delta) => {
				const cur = inFlight.get(key);
				if (cur !== undefined) {
					inFlight.set(key, cur + delta);
					recomputeViews();
				}
			},
			{ kind: opts.kind, clientId: key, dbName: db }
		);
		if (res?.error === 'cancelled') {
			// Preempted (user switched folders / a click preempted an auto) — leave it absent so
			// the rules re-enqueue when the engine is idle. Not a failure → clear retry state.
			summaries.delete(key);
			resetRetry(key);
		} else if (res?.error === 'scan-in-progress') {
			// CPU gate: don't retry mid-scan; the settled rule regenerates at completion.
			summaries.set(key, { status: 'deferred-scan', text: null });
			resetRetry(key);
		} else if (res?.description) {
			// A mid-scan summary is only `partial` (needs regenerating at completion) when it was
			// built from the on-disk fallback — an incomplete view. When it came from the DB tree
			// it is authoritative: keep it `done` and just PERSIST it at completion (needsPersist),
			// so the summary never visibly re-generates when the scan finishes.
			const provisional = opts.midScan && res.provisional === true;
			summaries.set(key, {
				status: provisional ? 'partial' : 'done',
				text: res.description,
				model: res.model,
				cached: res.cached,
				needsPersist: opts.midScan && !provisional
			});
			resetRetry(key); // success → clear the transient-attempt counter
		} else if (isTransientSessionError(res?.error)) {
			// Owner not ready yet (reopen/pause race) / just churned — NOT a real failure. Retry
			// with backoff + cap via a non-refiring 'pending-retry' state (never a tight loop).
			scheduleTransientRetry(key, res?.error);
		} else {
			// A genuine failure. Mid-scan hiccups retry at completion; a settled one is terminal —
			// shown as a friendly line (never the raw backend string — see the components).
			summaries.set(key, { status: opts.midScan ? 'deferred-scan' : 'error', text: null });
			resetRetry(key);
		}
	} catch (e) {
		if (isTransientSessionError(e)) {
			scheduleTransientRetry(key, e);
		} else {
			summaries.set(key, { status: opts.midScan ? 'deferred-scan' : 'error', text: null });
			resetRetry(key);
		}
	} finally {
		inFlight.delete(key);
		recompute(); // conditions may have changed mid-flight (e.g. scan completed) — re-evaluate
	}
}

// ── Wiring ──

let unsubs: Unsubscriber[] = [];
let unlisten: UnlistenFn | null = null;
let lastSelectedKey: string | null = null;

/** Selection changed: switchMap — cancel the previous sub-folder's in-flight run so an
 *  abandoned generation never hogs the engine, then let the rules describe the new one. The
 *  ROOT run is never cancelled here (it is proactive, not selection-driven). */
function onSelectionChanged() {
	const db = get(activeScan)?.dbName ?? null;
	const sel = selectedPath();
	const newKey = db && sel ? keyFor(db, sel) : null;
	if (lastSelectedKey && lastSelectedKey !== newKey && inFlight.has(lastSelectedKey)) {
		cancelDescribe(lastSelectedKey); // the cancelled result resolves and clears inFlight
	}
	lastSelectedKey = newKey;
	// Re-selecting a folder whose summary capped out gives it a fresh chance (manual retry):
	// clear the stuck 'error' so the reactive rule describes it again.
	if (newKey && summaries.get(newKey)?.status === 'error') {
		summaries.delete(newKey);
		resetRetry(newKey);
	}
	recompute();
}

/** Start mirroring host state + running the rules. Idempotent; returns a cleanup fn. */
export async function initLlmDescribe(): Promise<() => void> {
	if (unlisten) return teardown; // already initialized
	unlisten = await onJobUpdate((e) => {
		try {
			const msg = JSON.parse(e.line);
			if (msg.event !== 'llm:state') return;
			llmState.set({
				model: {
					state: msg.model?.state ?? 'unloaded',
					id: msg.model?.id ?? null,
					backend: msg.model?.backend
				},
				queue: Array.isArray(msg.queue) ? msg.queue : []
			});
			// Keep the legacy 3-state store truthful (status chip reads it).
			llmModelState.set(
				msg.model?.state === 'ready' ? 'ready' : msg.model?.state === 'loading' ? 'loading' : 'idle'
			);
			recompute();
		} catch {
			/* not our event */
		}
	});
	// Rules re-evaluate whenever any input moves; selection also drives switchMap cancellation.
	unsubs = [
		activeScan.subscribe(() => recompute()),
		scanPhase.subscribe(() => recompute()),
		aiMode.subscribe(() => recompute()),
		localModel.subscribe(() => recompute()),
		selectedItem.subscribe(() => onSelectionChanged())
	];
	return teardown;
}

function teardown() {
	for (const u of unsubs) u();
	unsubs = [];
	// Cancel any pending retry timers so they can't fire (and recompute) after teardown.
	for (const t of retryTimers.values()) clearTimeout(t);
	retryTimers.clear();
	attempts.clear();
	try {
		void Promise.resolve(unlisten?.()).catch(() => {});
	} catch {
		/* ignore */
	}
	unlisten = null;
}
