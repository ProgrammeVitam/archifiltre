/**
 * The describe engine: the UI-side owner of folder-summary state, built on RxJS for flow and
 * XState (describe-machine.ts) for each target's lifecycle, with the IO injected here.
 *
 * Concurrency comes from the operators rather than hand-kept bookkeeping: `switchMap` over the
 * selected target cancels the previous describe on a folder switch, `shareReplay(1)` lets a
 * component that mounts late still see the current host state, and `retry({delay})` gated on the
 * transient predicate is the whole bounded-retry policy.
 *
 * Public surface — components render these and never call describe themselves:
 *   rootSummary, selectedSummary : Readable<SummaryView>
 *   aiCellState, aiMeter         : Readable<AiCellState | AiMeter>   (status-bar view-models)
 *   llmBackend, llmEngineInfo    : Readable<'gpu' | 'cpu' | null | LlmEngineInfo>
 *   initLlmDescribe()            : Promise<() => void>
 */
import { writable, readable, type Readable } from 'svelte/store';
import { locale } from 'svelte-i18n';
import { Observable, Subject, combineLatest, timer, throwError, of, type Subscription } from 'rxjs';
import {
	map,
	filter,
	distinctUntilChanged,
	switchMap,
	retry,
	startWith,
	shareReplay
} from 'rxjs/operators';
import { createActor, fromCallback, type ActorRefFrom } from 'xstate';
import {
	onJobUpdate,
	queryDirectoryDescription,
	cancelDescribe,
	persistDescription,
	isTransientSessionError,
	currentUiLang,
	type DirectoryDescription
} from '$lib/tauri';
import { activeScan, scanPhase, aiMode, localModel, selectedItem, isScanning } from '$lib/stores';
import { logFrontend } from '$lib/log-buffer';
import {
	summaryMachine,
	STRUCTURE_READY_PHASES,
	type DescribeOutcome,
	type MachineEvent,
	type DescribeInput
} from '$lib/describe-machine';

// ── Public view shape (unchanged) ───────────────────────────────────────────

export interface SummaryView {
	status: 'absent' | 'generating' | 'partial' | 'done' | 'error' | 'deferred-scan' | 'unavailable';
	text: string | null;
	streamingText: string;
	model?: string;
	cached?: boolean;
	/** Our request sits in the host queue behind something else (honest waiting label). */
	waiting: boolean;
	/** How many requests (active + queued) are ahead of ours on the shared model — drives the
	 *  honest "In queue (N ahead)" label. 0 when we're at the front (or not queued). */
	queuedAhead: number;
	/** The model is loading (one-time warm) — shown instead of a bare spinner. */
	modelLoading: boolean;
	/** When status==='unavailable', a machine code for WHY the on-device runtime could not load
	 *  ('runtime-missing' | 'model-load-failed' | 'unknown'), so the UI can name the reason. */
	reason?: string;
}

const EMPTY_VIEW: SummaryView = {
	status: 'absent',
	text: null,
	streamingText: '',
	waiting: false,
	queuedAhead: 0,
	modelLoading: false
};

/** RootSummary renders this — the whole-scan overview for the active scan. */
export const rootSummary = writable<SummaryView>({ ...EMPTY_VIEW });
/** FileDetailsPanel renders this — the currently-selected sub-folder's summary. */
export const selectedSummary = writable<SummaryView>({ ...EMPTY_VIEW });

// ── Host state, mirrored from `llm:state` as one extended snapshot ────────────

interface LlmQueueEntry {
	clientId: string;
	kind: string;
	state: 'queued' | 'active';
}
interface LlmModelInfo {
	state: 'unloaded' | 'loading' | 'ready' | 'failed';
	id: string | null;
	reason?: string;
	/** Resolved backend once loaded ('vulkan'/'metal'/… → GPU, false/'cpu' → CPU); null otherwise. */
	backend?: string | false | null;
	/** Tier-2 engine detail from node-llama-cpp at load (GPU backend only for name/VRAM). */
	gpuName?: string | null;
	vramTotalMb?: number | null;
	cpuCount?: number | null;
}
interface LlmHostState {
	model: LlmModelInfo;
	queue: LlmQueueEntry[];
}
const INITIAL_HOST: LlmHostState = { model: { state: 'unloaded', id: null }, queue: [] };

/** Static on-device engine detail for the status-bar Tier-2 tooltip. `null` until known. */
export interface LlmEngineInfo {
	gpuName: string | null;
	vramTotalMb: number | null;
	cpuCount: number | null;
}
/** One live per-generation resource sample (CPU% + system memory always; VRAM on a GPU
 *  backend). Memory is SYSTEM-wide, not the helper's own resident set: the meter reports machine
 *  load, and one process's RSS is neither the app's footprint nor, on Windows, its real cost. */
export interface LlmResource {
	cpuPct: number;
	memUsedMb: number;
	memTotalMb: number;
	vramUsedMb: number | null;
	vramTotalMb: number | null;
}

function toHostState(msg: Record<string, unknown>): LlmHostState {
	const m = (msg.model ?? {}) as Record<string, unknown>;
	return {
		model: {
			state: (m.state as LlmModelInfo['state']) ?? 'unloaded',
			id: (m.id as string) ?? null,
			reason: m.reason as string | undefined,
			backend: (m.backend as string | false | null) ?? null,
			gpuName: (m.gpuName as string | null) ?? null,
			vramTotalMb: (m.vramTotalMb as number | null) ?? null,
			cpuCount: (m.cpuCount as number | null) ?? null
		},
		queue: Array.isArray(msg.queue) ? (msg.queue as LlmQueueEntry[]) : []
	};
}

// ── Svelte store → Observable adapter (sources live at the edges) ────────────

function fromStore<T>(store: Readable<T>): Observable<T> {
	return new Observable<T>((sub) => {
		const unsub = store.subscribe((v) => sub.next(v));
		return () => unsub();
	});
}

/** Sink boundary: expose an Observable as a Svelte-readable store. */
function toStore<T>(obs$: Observable<T>, initial: T): Readable<T> {
	return readable(initial, (set) => {
		const sub = obs$.subscribe((v) => set(v));
		return () => sub.unsubscribe();
	});
}

// ── Host lines, parsed once ──────────────────────────────────────────────────
// Carries the `llm:*` events plus the scan governor's `resource`. The host-derived signals below
// all read from here, so the status bar and the summary panel can't disagree. (`externalState$`
// is the exception: remote AI produces no host events, so it derives from describe outcomes.)
const hostEvents$ = new Subject<Record<string, unknown>>();

/** Model + queue snapshot. `shareReplay(1)` so a component mounting after a warm-load still sees
 *  the current state. */
const hostState$: Observable<LlmHostState> = hostEvents$.pipe(
	filter((m) => m.event === 'llm:state'),
	map(toHostState),
	startWith(INITIAL_HOST),
	shareReplay(1)
);

/** A generation holds the single model slot (something is generating anywhere). */
const busy$: Observable<boolean> = hostState$.pipe(
	map((h) => h.queue.some((e) => e.state === 'active')),
	distinctUntilChanged(),
	shareReplay(1)
);
/** Resolved engine once loaded: 'gpu' | 'cpu' | null (never a guess). */
const backend$: Observable<'gpu' | 'cpu' | null> = hostState$.pipe(
	map((h) =>
		h.model.state === 'ready' ? (h.model.backend && h.model.backend !== 'cpu' ? 'gpu' : 'cpu') : null
	),
	distinctUntilChanged(),
	shareReplay(1)
);
/** Hard-failure reason, or null when healthy. */
const failed$: Observable<string | null> = hostState$.pipe(
	map((h) => (h.model.state === 'failed' ? (h.model.reason ?? 'failed') : null)),
	distinctUntilChanged(),
	shareReplay(1)
);
/** Tier-2 engine detail for the tooltip. */
const engineInfo$: Observable<LlmEngineInfo> = hostState$.pipe(
	map((h) => ({
		gpuName: h.model.gpuName ?? null,
		vramTotalMb: h.model.vramTotalMb ?? null,
		cpuCount: h.model.cpuCount ?? null
	})),
	distinctUntilChanged(
		(a, b) => a.gpuName === b.gpuName && a.vramTotalMb === b.vramTotalMb && a.cpuCount === b.cpuCount
	),
	shareReplay(1)
);

// Live per-generation samples, scoped to the busy window: on idle we switch to `of(null)`, so the
// meter clears itself instead of needing a separate reset path.
const rawResource$: Observable<LlmResource> = hostEvents$.pipe(
	filter((m) => m.event === 'llm:resource'),
	map((m) => ({
		cpuPct: Number(m.cpuPct ?? 0),
		memUsedMb: Number(m.memUsedMb ?? 0),
		memTotalMb: Number(m.memTotalMb ?? 0),
		vramUsedMb: m.vramUsedMb == null ? null : Number(m.vramUsedMb),
		vramTotalMb: m.vramTotalMb == null ? null : Number(m.vramTotalMb)
	}))
);
const resource$: Observable<LlmResource | null> = busy$.pipe(
	switchMap((busy) => (busy ? rawResource$.pipe(startWith<LlmResource | null>(null)) : of(null))),
	shareReplay(1)
);

/** External-provider status, derived from describe outcomes (no `llm:state` for remote AI): a
 *  describe in flight → the globe pulses; a hard-failure → globe-x; cleared on the next success. */
const externalState$: Observable<'idle' | 'fetching' | 'unavailable'> = combineLatest([
	fromStore(aiMode),
	fromStore(rootSummary),
	fromStore(selectedSummary)
]).pipe(
	map(([mode, root, sel]) => {
		if (mode !== 'external') return 'idle' as const;
		if (root.status === 'error' || sel.status === 'error') return 'unavailable' as const;
		if (root.status === 'generating' || sel.status === 'generating') return 'fetching' as const;
		return 'idle' as const;
	}),
	distinctUntilChanged(),
	shareReplay(1)
);

// ── Composite view-models rendered by the status bar ──────────────────────────
export type AiCellState = 'shield' | 'pinwheel' | 'crash' | 'globe' | 'globe-pulse' | 'globe-x';
const aiCellState$: Observable<AiCellState> = combineLatest([
	fromStore(aiMode),
	busy$,
	failed$,
	externalState$
]).pipe(
	map(([mode, busy, failed, ext]): AiCellState => {
		if (mode === 'external')
			return ext === 'unavailable' ? 'globe-x' : ext === 'fetching' ? 'globe-pulse' : 'globe';
		return failed ? 'crash' : busy ? 'pinwheel' : 'shield';
	}),
	distinctUntilChanged(),
	shareReplay(1)
);

/** The scan governor's CPU% / system-memory / budget sample. Not an `llm:*` event — the owner
 *  emits `resource` every 500ms on the same stdout stream, so it arrives on `hostEvents$` too.
 *  `startWith(null)` so `aiMeter$`'s combineLatest fires before any scan has run. */
interface ScanResource {
	cpuPct: number;
	memUsedMb: number;
	memTotalMb: number;
	budget: number;
}
const scanResource$: Observable<ScanResource | null> = hostEvents$.pipe(
	filter((m) => m.event === 'resource'),
	map((m) => ({
		cpuPct: Number(m.cpuPct ?? 0),
		memUsedMb: Number(m.memUsedMb ?? 0),
		memTotalMb: Number(m.memTotalMb ?? 0),
		budget: Number(m.budget ?? 1)
	})),
	startWith<ScanResource | null>(null),
	shareReplay(1)
);

export type AiMeter =
	| { kind: 'none' }
	| { kind: 'scan'; cpuPct: number; memUsedMb: number; memTotalMb: number; budget: number }
	| { kind: 'gpu'; usedMb: number; totalMb: number }
	| { kind: 'cpu'; cpuPct: number; memUsedMb: number; memTotalMb: number };
// The scan branch is gated on `isScanning` (the real scan lifecycle), not the resource event's
// self-reported `scanning` flag, so the meter clears the instant the scan completes.
const aiMeter$: Observable<AiMeter> = combineLatest([
	fromStore(isScanning),
	scanResource$,
	busy$,
	resource$,
	backend$
]).pipe(
	map(([scanning, scanRes, busy, res, backend]): AiMeter => {
		if (scanning && scanRes)
			return {
				kind: 'scan',
				cpuPct: scanRes.cpuPct,
				memUsedMb: scanRes.memUsedMb,
				memTotalMb: scanRes.memTotalMb,
				budget: scanRes.budget
			};
		if (busy && res) {
			if (backend === 'gpu' && res.vramTotalMb && res.vramUsedMb != null)
				return { kind: 'gpu', usedMb: res.vramUsedMb, totalMb: res.vramTotalMb };
			return { kind: 'cpu', cpuPct: res.cpuPct, memUsedMb: res.memUsedMb, memTotalMb: res.memTotalMb };
		}
		return { kind: 'none' };
	}),
	distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
	shareReplay(1)
);

// ── The exposed Svelte-readable stores (one `toStore` per signal, the only sink) ──
export const aiCellState = toStore<AiCellState>(aiCellState$, 'shield');
export const aiMeter = toStore<AiMeter>(aiMeter$, { kind: 'none' });
export const llmBackend = toStore<'gpu' | 'cpu' | null>(backend$, null);
export const llmEngineInfo = toStore<LlmEngineInfo>(engineInfo$, {
	gpuName: null,
	vramTotalMb: null,
	cpuCount: null
});

// ── The describe as an Observable (streaming + transient retry, one operator) ─

const RETRY_BACKOFFS_MS = [500, 1500, 4000]; // 3 retries over ~6s, spans owner churn

/** Wrap one describe call as a stream of tokens then a terminal outcome. A TRANSIENT owner
 *  error `error()`s the stream so `retry` re-attempts with backoff; after the cap it surfaces
 *  as an `error` outcome. Unsubscribing (switchMap teardown / folder switch) cancels on the host. */
function describe$(db: string, path: string, midScan: boolean, kind: 'auto' | 'user'): Observable<MachineEvent> {
	const clientId = `${db}::${path}::${currentUiLang()}`;
	// One correlation id per describe invocation (shared across this attempt's internal retries and
	// all 3 legs), so `grep <describeId>` reconstructs UI → host → helper → owner in the log bundle.
	// Distinct from clientId (the stable per-folder key used for cancellation/queue-tracking).
	const describeId = `desc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	// UI leg of the AI trace: the describe was requested here (grep the describeId). `dir` is the
	// basename only — a relative path can carry sensitive folder names and the sidecar scrubber
	// doesn't reach webview code, so keep it PII-light.
	logFrontend('describe:requested', {
		describeId,
		dir: path.split('/').pop() || '/',
		kind,
		midScan
	});
	const settleErr: DescribeOutcome = midScan ? { kind: 'deferred' } : { kind: 'error' };
	return new Observable<MachineEvent>((sub) => {
		let done = false;
		const finish = (result: DescribeOutcome) => {
			if (done) return;
			done = true;
			logFrontend('describe:result', { describeId, outcome: result.kind });
			sub.next({ type: 'RESULT', result });
			sub.complete();
		};
		queryDirectoryDescription(
			path,
			(delta) => {
				if (!done) sub.next({ type: 'TOKEN', delta });
			},
			{ kind, clientId, dbName: db, describeId }
		)
			.then((res: DirectoryDescription | null) => {
				if (done) return;
				if (res?.error === 'cancelled') finish({ kind: 'cancelled' });
				else if (res?.error === 'scan-in-progress') finish({ kind: 'deferred' });
				else if (res?.description) {
					const provisional = midScan && res.provisional === true;
					finish({
						kind: provisional ? 'partial' : 'done',
						text: res.description,
						model: res.model,
						cached: res.cached
					});
				} else if (isTransientSessionError(res?.error)) {
					done = true;
					sub.error({ transient: true });
				} else finish(settleErr);
			})
			.catch((e) => {
				if (done) return;
				if (isTransientSessionError(e)) {
					done = true;
					sub.error({ transient: true });
				} else finish(settleErr);
			});
		return () => {
			if (!done) {
				done = true;
				cancelDescribe(clientId);
			}
		};
	}).pipe(
		retry({
			count: RETRY_BACKOFFS_MS.length,
			resetOnSuccess: true,
			delay: (err: unknown, n: number) =>
				(err as { transient?: boolean })?.transient
					? timer(RETRY_BACKOFFS_MS[n - 1] ?? RETRY_BACKOFFS_MS[RETRY_BACKOFFS_MS.length - 1])
					: throwError(() => err)
		})
	);
}

/** The real describe actor injected into the machine: subscribes the describe stream and
 *  forwards its TOKEN/RESULT events; a retry-exhausted transient surfaces as an `error`. */
const describeActor = fromCallback<MachineEvent, DescribeInput>(({ input, sendBack }) => {
	const sub = describe$(input.db, input.path, input.midScan, input.kind).subscribe({
		next: (ev) => sendBack(ev),
		error: () => sendBack({ type: 'RESULT', result: { kind: 'error' } })
	});
	return () => sub.unsubscribe();
});

/** The machine with real IO wired in (describe stream + persistence). */
const wiredMachine = summaryMachine.provide({
	actors: { describe: describeActor },
	actions: {
		persistDone: ({ context }) => {
			if (context.text) persistDescription(context.path, context.text, context.model ?? '', context.db);
		}
	}
});

type SummaryActor = ActorRefFrom<typeof wiredMachine>;

// ── Snapshot + host state → the public SummaryView ───────────────────────────

function toView(actor: SummaryActor, host: LlmHostState, clientId: string): SummaryView {
	const snap = actor.getSnapshot();
	const c = snap.context;
	const generating = snap.value === 'generating';
	const status: SummaryView['status'] = generating
		? 'generating'
		: snap.value === 'deferred'
			? 'deferred-scan'
			: (snap.value as SummaryView['status']);
	return {
		status,
		text: c.text,
		streamingText: generating ? c.streamingText : '',
		model: c.model,
		cached: c.cached,
		waiting: generating && host.queue.some((e) => e.clientId === clientId && e.state === 'queued'),
		// The queue snapshot is [active, ...queued] in order, so the index is how many are ahead.
		queuedAhead: generating
			? Math.max(0, host.queue.findIndex((e) => e.clientId === clientId && e.state === 'queued'))
			: 0,
		modelLoading: generating && host.model.state === 'loading',
		reason: snap.value === 'unavailable' ? host.model.reason : undefined
	};
}

// ── One live target = a machine actor fed by SYNC, projected to a SummaryView ─

function runTarget(role: 'root' | 'selected', db: string, path: string): Observable<SummaryView> {
	return new Observable<SummaryView>((sub) => {
		const actor = createActor(wiredMachine, { input: { role, db, path } });
		const clientId = `${db}::${path}::${currentUiLang()}`;

		// SYNC: every input change becomes one event; the machine's guards decide transitions.
		const sync$: Subscription = combineLatest([
			fromStore(activeScan),
			fromStore(scanPhase),
			fromStore(aiMode),
			hostState$
		]).subscribe(([scan, phase, mode, host]) => {
			actor.send({
				type: 'SYNC',
				sync: {
					enabled: mode !== 'off',
					local: mode === 'local',
					scanState: scan?.state ?? '',
					phaseReady: STRUCTURE_READY_PHASES.includes(phase),
					modelReady: host.model.state === 'ready',
					modelFailed: host.model.state === 'failed'
				}
			});
		});

		// View = machine snapshot × host state (queue/model), recomputed on either change.
		const snap$ = new Observable<void>((s) => {
			const a = actor.subscribe(() => s.next());
			return () => a.unsubscribe();
		}).pipe(startWith(undefined as void));
		const view$: Subscription = combineLatest([snap$, hostState$]).subscribe(([, host]) =>
			sub.next(toView(actor, host, clientId))
		);

		actor.start();
		return () => {
			view$.unsubscribe();
			sync$.unsubscribe();
			actor.stop(); // stopping mid-generate tears down the invoked describe → cancels on the host
		};
	});
}

// ── Wiring: two switchMap'd target pipelines bound to the public stores ───────

/** The selected NON-ROOT directory (root is root-driven). Null for files / empty / root. */
function selectedTargetKey(
	scan: { dbName?: string } | null,
	sel: { type?: string; path?: string } | null
): { db: string; path: string } | null {
	const db = scan?.dbName;
	if (!db || !sel || sel.type !== 'directory') return null;
	const p = sel.path ?? '';
	return p === '' ? null : { db, path: p };
}

let subs: Subscription[] = [];
let unlisten: (() => void) | null = null;
let started = false;

/** Start mirroring host state + running the two target pipelines. Idempotent; returns cleanup. */
export async function initLlmDescribe(): Promise<() => void> {
	if (started) return teardown;
	started = true;

	// Every host line becomes one event on `hostEvents$`; all AI signals derive from it.
	unlisten = await onJobUpdate((e) => {
		try {
			hostEvents$.next(JSON.parse(e.line));
		} catch {
			/* not JSON / not our event */
		}
	});
	// Keep the spine hot from init so a warm-load `llm:state` fired before any component subscribes
	// is captured by shareReplay, not lost until the first mount.
	subs.push(hostState$.subscribe());

	const lang$ = fromStore(locale).pipe(
		map((l) => (typeof l === 'string' ? l.slice(0, 2).toLowerCase() : 'en')),
		distinctUntilChanged()
	);

	// ROOT — one machine per (db, lang); recreated (→ cancel + restart) when either changes.
	const rootKey$ = combineLatest([fromStore(activeScan), lang$]).pipe(
		map(([scan]) => scan?.dbName ?? null),
		distinctUntilChanged()
	);
	subs.push(
		rootKey$
			.pipe(switchMap((db) => (db ? runTarget('root', db, '') : of<SummaryView>({ ...EMPTY_VIEW }))))
			.subscribe((v) => rootSummary.set(v))
	);

	// SELECTED — one machine per (db, path, lang); switchMap cancels the previous on any change.
	const selKey$ = combineLatest([fromStore(activeScan), fromStore(selectedItem), lang$]).pipe(
		map(([scan, sel]) => selectedTargetKey(scan, sel)),
		distinctUntilChanged((a, b) => a?.db === b?.db && a?.path === b?.path)
	);
	subs.push(
		selKey$
			.pipe(switchMap((t) => (t ? runTarget('selected', t.db, t.path) : of<SummaryView>({ ...EMPTY_VIEW }))))
			.subscribe((v) => selectedSummary.set(v))
	);

	return teardown;
}

function teardown() {
	for (const s of subs) s.unsubscribe();
	subs = [];
	try {
		void Promise.resolve(unlisten?.()).catch(() => {});
	} catch {
		/* ignore */
	}
	unlisten = null;
	started = false;
	rootSummary.set({ ...EMPTY_VIEW });
	selectedSummary.set({ ...EMPTY_VIEW });
}
