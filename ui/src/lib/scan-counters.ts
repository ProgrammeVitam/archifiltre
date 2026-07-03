/**
 * Shared smoothed scan counters — the active scan's progress figures as odometer
 * stores (see smooth-counter.ts), wired once here so every surface (status bar,
 * root summary) shows the same smoothly-ticking number.
 *
 * Mode rules, driven from activeScan transitions:
 *  - scan switch            → snap (never animate across scans)
 *  - scanning → progress    → update (cruise at the estimated rate)
 *  - resume (paused→scanning) → snap to the seeded truth (no phantom roll-up)
 *  - scanning → paused/complete → land (roll to a stop on the exact final value)
 */

import { activeScan } from '$lib/stores';
import { createSmoothCounter } from '$lib/smooth-counter';

const files = createSmoothCounter();
const hashed = createSmoothCounter();

export const smoothFilesDiscovered = files.displayed;
export const smoothFilesHashed = hashed.displayed;

let prevId: string | null = null;
let prevState: string | null = null;

// Module-level subscription: lives for the app's lifetime (the counters are global UI
// state, exactly like the stores they smooth).
activeScan.subscribe((scan) => {
	if (!scan) return;
	const discovered = scan.scanResult?.filesDiscovered ?? 0;
	const hashedCount = scan.scanResult?.filesHashed ?? 0;

	if (scan.id !== prevId) {
		prevId = scan.id;
		prevState = scan.state;
		files.snap(discovered);
		hashed.snap(hashedCount);
		return;
	}

	if (scan.state === 'scanning') {
		if (prevState !== 'scanning') {
			// Continue after pause: first truth is the resume seed — jump, don't roll.
			files.snap(discovered);
			hashed.snap(hashedCount);
		} else {
			files.update(discovered);
			hashed.update(hashedCount);
		}
	} else if (prevState === 'scanning' && (scan.state === 'paused' || scan.state === 'complete')) {
		files.land(discovered);
		hashed.land(hashedCount);
	}
	prevState = scan.state;
});
