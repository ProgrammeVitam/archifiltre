/// <reference types="bun" />
/**
 * Deterministic unit tests for the summary lifecycle machine — the frontend equivalent of the
 * host's loom test. Drives the machine with a MOCK describe actor (no Tauri, no model) so every
 * transition under test is asserted in isolation. Run: bun test (in ui/).
 */
import { test, expect } from 'bun:test';
import { createActor, fromCallback } from 'xstate';
import { summaryMachine, type DescribeOutcome, type MachineEvent, type DescribeInput, type Sync } from './describe-machine';

/** A controllable describe actor: capture its sendBack so a test can emit TOKEN/RESULT at will,
 *  and count how many times a describe was torn down (switchMap cancel) or a persist fired. */
function make(role: 'root' | 'selected') {
	const ctl = { sendBack: null as null | ((e: MachineEvent) => void), persisted: 0, cancelled: 0, started: 0 };
	const mock = fromCallback<MachineEvent, DescribeInput>(({ sendBack }) => {
		ctl.sendBack = sendBack;
		ctl.started++;
		return () => {
			ctl.sendBack = null;
			ctl.cancelled++;
		};
	});
	const machine = summaryMachine.provide({
		actors: { describe: mock },
		actions: { persistDone: () => void ctl.persisted++ }
	});
	const actor = createActor(machine, { input: { role, db: 'db', path: role === 'root' ? '' : 'sub' } });
	actor.start();
	return {
		state: () => actor.getSnapshot().value as string,
		ctx: () => actor.getSnapshot().context,
		sync: (o: Partial<Sync>) =>
			actor.send({
				type: 'SYNC',
				sync: { enabled: true, local: true, scanState: '', phaseReady: false, modelReady: false, ...o }
			}),
		result: (r: DescribeOutcome) => ctl.sendBack?.({ type: 'RESULT', result: r }),
		token: (d: string) => ctl.sendBack?.({ type: 'TOKEN', delta: d }),
		stop: () => actor.stop(),
		get generating() {
			return ctl.sendBack != null;
		},
		get persisted() {
			return ctl.persisted;
		},
		get cancelled() {
			return ctl.cancelled;
		},
		get started() {
			return ctl.started;
		}
	};
}

const SCANNING_READY = { scanState: 'scanning', phaseReady: true, modelReady: true } as const;

test('root: mid-scan (model ready) generates, done, then persists once at completion', () => {
	const t = make('root');
	t.sync(SCANNING_READY);
	expect(t.state()).toBe('generating');
	expect(t.generating).toBe(true);
	t.result({ kind: 'done', text: 'Hello', model: 'qwen' });
	expect(t.state()).toBe('done');
	expect(t.ctx().text).toBe('Hello');
	expect(t.ctx().needsPersist).toBe(true); // authoritative mid-scan → persist at completion
	t.sync({ scanState: 'complete' });
	expect(t.persisted).toBe(1);
	expect(t.ctx().needsPersist).toBe(false);
	t.sync({ scanState: 'complete' }); // idempotent — never persists twice / re-animates
	expect(t.persisted).toBe(1);
});

test('root: Rule 1 gates on model-ready — waits, then fires when the model becomes ready', () => {
	const t = make('root');
	t.sync({ scanState: 'scanning', phaseReady: true, modelReady: false });
	expect(t.state()).toBe('absent'); // model not ready → does NOT fire into a loading model
	t.sync({ scanState: 'scanning', phaseReady: true, modelReady: true });
	expect(t.state()).toBe('generating'); // model ready → fires (the R3 self-heal, made explicit)
});

test('root: settled scan generates without the model-ready gate and does not mark needsPersist', () => {
	const t = make('root');
	t.sync({ scanState: 'complete' });
	expect(t.state()).toBe('generating');
	t.result({ kind: 'done', text: 'Overview' });
	expect(t.state()).toBe('done');
	expect(t.ctx().needsPersist).toBe(false); // settled describe is already cached by leg 3
	t.sync({ scanState: 'complete' });
	expect(t.persisted).toBe(0);
});

test('selected: mid-scan provisional partial regenerates once at completion', () => {
	const t = make('selected');
	t.sync({ scanState: 'scanning' });
	expect(t.state()).toBe('generating');
	t.result({ kind: 'partial', text: 'provisional' });
	expect(t.state()).toBe('partial');
	const before = t.started;
	t.sync({ scanState: 'complete' });
	expect(t.state()).toBe('generating'); // regenerate from the full tree
	expect(t.started).toBe(before + 1);
	t.result({ kind: 'done', text: 'final' });
	expect(t.state()).toBe('done');
});

test('deferred-scan regenerates at completion', () => {
	const t = make('selected');
	t.sync({ scanState: 'scanning' });
	t.result({ kind: 'deferred' });
	expect(t.state()).toBe('deferred');
	t.sync({ scanState: 'complete' });
	expect(t.state()).toBe('generating');
});

test('error is TERMINAL — a persistent failure never re-fires (storm fix)', () => {
	const t = make('selected');
	t.sync({ scanState: 'scanning' });
	const startedAfterFirst = t.started; // exactly one describe was invoked
	t.result({ kind: 'error' });
	expect(t.state()).toBe('error');
	// Completion — and ANY subsequent input change — must NOT re-arm the failed describe.
	// The old `always: completed → generating` re-fired forever on a persistent failure (the
	// 758-describe "storm"); error is now terminal, so re-attempting is a user action only.
	t.sync({ scanState: 'complete' });
	expect(t.state()).toBe('error');
	t.sync({ modelReady: true });
	t.sync({ scanState: 'complete' });
	expect(t.state()).toBe('error');
	expect(t.started).toBe(startedAfterFirst); // no new describe invoked → no storm
});

test('cancelled returns to absent and the rules re-enqueue a fresh describe', () => {
	const t = make('selected');
	t.sync({ scanState: 'complete' });
	expect(t.state()).toBe('generating');
	t.token('abandoned');
	const before = t.started;
	t.result({ kind: 'cancelled' });
	// → absent; still selected + complete, so it re-enqueues immediately (a NEW describe,
	// not the abandoned one), with the stale streaming text cleared.
	expect(t.state()).toBe('generating');
	expect(t.started).toBe(before + 1);
	expect(t.ctx().streamingText).toBe('');
});

test('tokens accumulate into streamingText', () => {
	const t = make('selected');
	t.sync({ scanState: 'complete' });
	t.token('Hel');
	t.token('lo');
	expect(t.ctx().streamingText).toBe('Hello');
});

test('stopping mid-generate cancels the describe (switchMap teardown)', () => {
	const t = make('selected');
	t.sync({ scanState: 'complete' });
	expect(t.generating).toBe(true);
	t.stop();
	expect(t.cancelled).toBe(1); // the invoked describe was torn down → cancel on the host
});

test('AI off never generates', () => {
	const t = make('root');
	t.sync({ enabled: false, scanState: 'complete' });
	expect(t.state()).toBe('absent');
});
