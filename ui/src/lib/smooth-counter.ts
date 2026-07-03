/**
 * Smooth counter — a per-frame "odometer" over a batched truth signal.
 *
 * Scan progress arrives in coarse jumps (the scanner emits every ~500 files), but a
 * count is monotonic and passes through every integer, so interpolating between
 * checkpoints is semantically honest: every displayed value is a count that really
 * existed; only its timing is estimated. The displayed value cruises at the estimated
 * rate (EMA of Δcount/Δtime), catches up exponentially when behind, and is clamped so
 * it can NEVER exceed the confirmed truth.
 *
 * Terminal modes:
 *  - land(): roll to a stop — tightened convergence onto the exact final value
 *    (used on pause/completion, so the finale decelerates instead of jump-cutting).
 *  - snap(): jump instantly (used on scan switch and resume-seeding, where animating
 *    through thousands of phantom values would be worse).
 */

import { writable, type Readable } from 'svelte/store';

const CATCHUP_S = 0.4; // convergence horizon while cruising
const LAND_S = 0.15; // convergence horizon while landing (roll-to-a-stop)
const EMA_ALPHA = 0.3; // rate smoothing (weighted by sample size below)
const IDLE_STOP_MS = 2000; // stop the rAF loop once settled and quiet

export interface SmoothCounter {
	displayed: Readable<number>;
	/** New confirmed truth from a progress event. */
	update(truth: number): void;
	/** Jump instantly (scan switch, resume seed, phase reset). */
	snap(truth: number): void;
	/** Roll to a stop on the exact final value (pause / completion). */
	land(truth?: number): void;
	destroy(): void;
}

export function createSmoothCounter(): SmoothCounter {
	const store = writable(0);
	let truth = 0;
	let shown = 0;
	let rate = 0; // files/sec, EMA
	let lastEventAt = 0;
	let lastFrameAt = 0;
	let landing = false;
	let raf: number | null = null;

	function emit() {
		store.set(Math.floor(shown));
	}

	function ensureLoop() {
		if (raf == null && typeof requestAnimationFrame !== 'undefined') {
			lastFrameAt = performance.now();
			raf = requestAnimationFrame(frame);
		}
	}

	function frame(now: number) {
		raf = null;
		const dt = Math.min(0.1, Math.max(0.001, (now - lastFrameAt) / 1000));
		lastFrameAt = now;
		const gap = truth - shown;

		if (gap > 0) {
			// Cruise at the estimated rate; when behind schedule, close the gap
			// exponentially within the convergence horizon. Never overshoot.
			const horizon = landing ? LAND_S : CATCHUP_S;
			const advance = Math.max(rate * dt, (gap * dt) / horizon);
			shown = Math.min(truth, shown + advance);
			if (landing && truth - shown < 1) shown = truth; // settle the last fraction
			emit();
		}

		const settled = shown >= truth;
		const quiet = now - lastEventAt > IDLE_STOP_MS;
		if (!(settled && (landing || quiet))) {
			raf = requestAnimationFrame(frame);
		} else if (landing) {
			landing = false; // landed — loop stops until the next update/land
		}
	}

	return {
		displayed: { subscribe: store.subscribe },
		update(next: number) {
			const now = performance.now();
			if (next < shown) {
				// A smaller value means a different metric epoch (new scan) — never animate
				// backwards through a counter.
				this.snap(next);
				return;
			}
			if (lastEventAt) {
				const dtEvent = (now - lastEventAt) / 1000;
				const delta = next - truth;
				if (dtEvent > 0.02 && delta > 0) {
					const sample = delta / dtEvent;
					// Weight small samples less, so the runt last batch barely moves the EMA.
					const w = EMA_ALPHA * Math.min(1, delta / 500);
					rate = rate > 0 ? rate * (1 - w) + sample * w : sample;
				}
			}
			truth = next;
			lastEventAt = now;
			landing = false;
			ensureLoop();
		},
		snap(next: number) {
			truth = next;
			shown = next;
			rate = 0;
			landing = false;
			lastEventAt = performance.now();
			emit();
		},
		land(next?: number) {
			if (next != null && next >= truth) truth = next;
			landing = true;
			lastEventAt = performance.now();
			ensureLoop();
		},
		destroy() {
			if (raf != null) cancelAnimationFrame(raf);
			raf = null;
		}
	};
}
