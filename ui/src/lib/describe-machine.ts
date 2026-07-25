/**
 * The per-target summary lifecycle as a PURE XState machine — no browser / no Tauri imports,
 * so it is unit-testable in isolation (see test/describe-machine.test.ts) and visualisable in
 * the XState inspector. The IO (the describe stream, persistence) is INJECTED via `.provide`
 * in llm-describe.ts, and MOCKED in tests. This module is the single source of truth for the
 * summary state machine.
 */
import { setup, assign, fromCallback } from 'xstate';

export const STRUCTURE_READY_PHASES = ['prefilter', 'hashing', 'duplicate-detection', 'complete'];

/** Terminal outcome of one describe attempt (a transient failure never reaches here — it is
 *  retried inside the describe stream and, if exhausted, arrives as `error`). */
export type DescribeOutcome =
	| { kind: 'done'; text: string; model?: string; cached?: boolean }
	| { kind: 'partial'; text: string; model?: string; cached?: boolean }
	| { kind: 'deferred' }
	| { kind: 'cancelled' }
	| { kind: 'error' };

/** A snapshot of every input the rules depend on, pushed to the machine as one `SYNC` event. */
export interface Sync {
	enabled: boolean; // aiMode !== 'off'
	local: boolean; // aiMode === 'local'
	scanState: string; // 'scanning' | 'complete' | 'paused' | …
	phaseReady: boolean; // scanPhase ∈ STRUCTURE_READY_PHASES
	modelReady: boolean; // host model.state === 'ready'
	modelFailed: boolean; // host model.state === 'failed' (runtime could not load) — local only
}

export interface Ctx {
	role: 'root' | 'selected';
	db: string;
	path: string;
	streamingText: string;
	text: string | null;
	model?: string;
	cached?: boolean;
	midScan: boolean;
	needsPersist: boolean; // an authoritative mid-scan `done` awaiting a persist at completion
	sync: Sync;
}

export type MachineEvent =
	| { type: 'SYNC'; sync: Sync }
	| { type: 'TOKEN'; delta: string }
	| { type: 'RESULT'; result: DescribeOutcome };

export interface DescribeInput {
	db: string;
	path: string;
	midScan: boolean;
	kind: 'auto' | 'user';
}

const NO_SYNC: Sync = { enabled: false, local: false, scanState: '', phaseReady: false, modelReady: false, modelFailed: false };

/** Placeholder describe actor — never emits. Overridden with the real RxJS-backed actor in
 *  llm-describe.ts (`.provide`) and with a controllable mock in tests. */
const describeStub = fromCallback<MachineEvent, DescribeInput>(() => () => {});

export const summaryMachine = setup({
	types: {
		context: {} as Ctx,
		events: {} as MachineEvent,
		input: {} as { role: 'root' | 'selected'; db: string; path: string }
	},
	actors: { describe: describeStub },
	actions: {
		// Overridden in llm-describe.ts to persist the summary; a no-op here / in tests by default.
		persistDone: () => {}
	},
	guards: {
		startMidScanRoot: ({ context: c }) =>
			c.role === 'root' &&
			c.sync.enabled &&
			c.sync.local &&
			c.sync.scanState === 'scanning' &&
			c.sync.phaseReady &&
			c.sync.modelReady,
		startSettledRoot: ({ context: c }) => c.role === 'root' && c.sync.enabled && c.sync.scanState === 'complete',
		startSelected: ({ context: c }) =>
			c.role === 'selected' &&
			c.sync.enabled &&
			(c.sync.scanState === 'scanning' || c.sync.scanState === 'complete' || c.sync.scanState === 'paused'),
		completed: ({ context: c }) => c.sync.enabled && c.sync.scanState === 'complete',
		completedNeedsPersist: ({ context: c }) => c.sync.scanState === 'complete' && c.needsPersist && !!c.text,
		// The on-device runtime could not load (e.g. a missing system dependency). Only meaningful
		// for local mode; an external endpoint never loads a local model, so it can't be "failed".
		runtimeUnavailable: ({ context: c }) => c.sync.enabled && c.sync.local && c.sync.modelFailed
	}
}).createMachine({
	id: 'summary',
	context: ({ input }) => ({
		role: input.role,
		db: input.db,
		path: input.path,
		streamingText: '',
		text: null,
		midScan: false,
		needsPersist: false,
		sync: NO_SYNC
	}),
	on: {
		SYNC: { actions: assign({ sync: ({ event }) => event.sync }) }
	},
	initial: 'absent',
	states: {
		absent: {
			always: [
				// Runtime is dead before we even try — go straight to a named unavailable state
				// instead of spinning a describe that will only fail. This is what stops the
				// "loading… → blank" churn when the on-device runtime can't load.
				{ guard: 'runtimeUnavailable', target: 'unavailable' },
				{ guard: 'startMidScanRoot', actions: assign({ midScan: true, streamingText: '' }), target: 'generating' },
				{ guard: 'startSettledRoot', actions: assign({ midScan: false, streamingText: '' }), target: 'generating' },
				{
					guard: 'startSelected',
					actions: assign({ midScan: ({ context: c }) => c.sync.scanState === 'scanning', streamingText: '' }),
					target: 'generating'
				}
			]
		},
		generating: {
			// If the runtime dies mid-attempt (host reports model.state='failed'), abandon this
			// describe and surface the named unavailable state rather than streaming nothing forever.
			always: [{ guard: 'runtimeUnavailable', target: 'unavailable' }],
			invoke: {
				src: 'describe',
				input: ({ context: c }): DescribeInput => ({
					db: c.db,
					path: c.path,
					midScan: c.midScan,
					kind: c.role === 'root' ? 'auto' : 'user'
				})
			},
			on: {
				TOKEN: { actions: assign({ streamingText: ({ context, event }) => context.streamingText + event.delta }) },
				RESULT: [
					{
						guard: ({ event }) => event.result.kind === 'done',
						target: 'done',
						actions: assign(({ event, context }) => {
							const r = event.result as Extract<DescribeOutcome, { kind: 'done' }>;
							return { text: r.text, model: r.model, cached: r.cached, needsPersist: context.midScan };
						})
					},
					{
						guard: ({ event }) => event.result.kind === 'partial',
						target: 'partial',
						actions: assign(({ event }) => {
							const r = event.result as Extract<DescribeOutcome, { kind: 'partial' }>;
							return { text: r.text, model: r.model, cached: r.cached };
						})
					},
					{ guard: ({ event }) => event.result.kind === 'deferred', target: 'deferred' },
					{ guard: ({ event }) => event.result.kind === 'cancelled', target: 'absent', actions: assign({ streamingText: '' }) },
					{ target: 'error' }
				]
			}
		},
		done: {
			always: [{ guard: 'completedNeedsPersist', actions: ['persistDone', assign({ needsPersist: false })] }]
		},
		partial: {
			always: [{ guard: 'completed', actions: assign({ midScan: false, streamingText: '' }), target: 'generating' }]
		},
		deferred: {
			always: [{ guard: 'completed', actions: assign({ midScan: false, streamingText: '' }), target: 'generating' }]
		},
		error: {
			// Terminal: surfaces once, no auto-regenerate. A static `completed` re-arm here would
			// re-fire forever on a persistent failure. Mid-scan failures use `deferred`/`partial`,
			// which regenerate once at completion.
		},
		unavailable: {
			// The on-device runtime failed to load — surface a named reason and stop, never a blank
			// or a perpetual spinner. Recoverable: if the model later loads (modelFailed clears),
			// re-arm to `absent` so a fresh attempt can run. The `!modelFailed` guard can't loop —
			// on entry modelFailed is true, so it only fires once the failure genuinely clears.
			always: [{ guard: ({ context: c }) => !c.sync.modelFailed, target: 'absent' }]
		}
	}
});
