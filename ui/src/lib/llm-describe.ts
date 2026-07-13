/**
 * The summary subsystem's ONE state owner on the UI side — the describe engine, rebuilt on
 * RxJS (flow) + XState (per-target lifecycle) so concurrency is STRUCTURAL, not hand-managed.
 *
 * Why this shape:
 *   • `switchMap` over the selected target = cancel-the-previous describe on folder switch —
 *     replaces the old inFlight map + cancelDescribe bookkeeping (race R5/R8 gone).
 *   • `shareReplay(1)` on the host `llm:state` stream = a late subscriber gets the current
 *     value, so a warm-load fired before we subscribed is never missed (race R3 gone).
 *   • `retry({delay})` gated on the transient predicate = the entire bounded-retry apparatus
 *     (attempts/retryTimers/scheduleTransientRetry) in ONE operator, correct by construction.
 *   • The per-target lifecycle is a PURE XState machine (describe-machine.ts) — explicit,
 *     inspectable, unit-tested — with the IO (describe stream, persistence) INJECTED here.
 *
 * Public surface (unchanged — components + +page render these, never call describe):
 *   rootSummary, selectedSummary : Readable<SummaryView>
 *   initLlmDescribe()            : Promise<() => void>
 */
import { writable, type Readable } from 'svelte/store';
import { locale } from 'svelte-i18n';
import { Observable, combineLatest, timer, throwError, of, type Subscription } from 'rxjs';
import { map, distinctUntilChanged, switchMap, retry, startWith } from 'rxjs/operators';
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
import { activeScan, scanPhase, aiMode, localModel, selectedItem, llmModelState } from '$lib/stores';
import {
	summaryMachine,
	STRUCTURE_READY_PHASES,
	type DescribeOutcome,
	type MachineEvent,
	type DescribeInput
} from '$lib/describe-machine';

// ── Public view shape (unchanged) ───────────────────────────────────────────

export interface SummaryView {
	status: 'absent' | 'generating' | 'partial' | 'done' | 'error' | 'deferred-scan';
	text: string | null;
	streamingText: string;
	model?: string;
	cached?: boolean;
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

// ── Host state, mirrored from `llm:state` as a hot, replayed value ────────────

interface LlmQueueEntry {
	clientId: string;
	kind: string;
	state: 'queued' | 'active';
}
interface LlmHostState {
	model: { state: 'unloaded' | 'loading' | 'ready'; id: string | null };
	queue: LlmQueueEntry[];
}
const INITIAL_HOST: LlmHostState = { model: { state: 'unloaded', id: null }, queue: [] };

/** A writable holding the latest host state; `fromStore` gives a hot Observable whose late
 *  subscribers synchronously see the current value — so a warm-load fired before a target
 *  subscribed is never missed (this is the `shareReplay(1)` role, race R3). */
const hostState = writable<LlmHostState>(INITIAL_HOST);

// ── Svelte store → Observable adapter (sources live at the edges) ────────────

function fromStore<T>(store: Readable<T>): Observable<T> {
	return new Observable<T>((sub) => {
		const unsub = store.subscribe((v) => sub.next(v));
		return () => unsub();
	});
}
const hostState$ = fromStore(hostState);

// ── The describe as an Observable (streaming + transient retry, one operator) ─

const RETRY_BACKOFFS_MS = [500, 1500, 4000]; // 3 retries over ~6s, spans owner churn

/** Wrap one describe call as a stream of tokens then a terminal outcome. A TRANSIENT owner
 *  error `error()`s the stream so `retry` re-attempts with backoff; after the cap it surfaces
 *  as an `error` outcome. Unsubscribing (switchMap teardown / folder switch) cancels on the host. */
function describe$(db: string, path: string, midScan: boolean, kind: 'auto' | 'user'): Observable<MachineEvent> {
	const clientId = `${db}::${path}::${currentUiLang()}`;
	const settleErr: DescribeOutcome = midScan ? { kind: 'deferred' } : { kind: 'error' };
	return new Observable<MachineEvent>((sub) => {
		let done = false;
		const finish = (result: DescribeOutcome) => {
			if (done) return;
			done = true;
			sub.next({ type: 'RESULT', result });
			sub.complete();
		};
		queryDirectoryDescription(
			path,
			(delta) => {
				if (!done) sub.next({ type: 'TOKEN', delta });
			},
			{ kind, clientId, dbName: db }
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
		modelLoading: generating && host.model.state === 'loading'
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
					modelReady: host.model.state === 'ready'
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

	unlisten = await onJobUpdate((e) => {
		try {
			const msg = JSON.parse(e.line);
			if (msg.event !== 'llm:state') return;
			hostState.set({
				model: { state: msg.model?.state ?? 'unloaded', id: msg.model?.id ?? null },
				queue: Array.isArray(msg.queue) ? msg.queue : []
			});
			// Keep the legacy 3-state store truthful (the status chip reads it).
			llmModelState.set(
				msg.model?.state === 'ready' ? 'ready' : msg.model?.state === 'loading' ? 'loading' : 'idle'
			);
		} catch {
			/* not our event */
		}
	});

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
