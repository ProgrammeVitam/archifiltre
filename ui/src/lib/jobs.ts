import { writable, derived, get } from 'svelte/store';

// ================================
// Types
// ================================

export type JobStatus = 'running' | 'paused' | 'complete' | 'error' | 'cancelled';

export interface Job {
	id: string;
	/** Which scan tab spawned this job */
	scanTabId: string;
	type: string;
	label: string;
	phases: string[];
	status: JobStatus;
	currentPhase: string;
	progress: number | null; // null = indeterminate
	total: number | null;
	detail: string | null;
	error: string | null;
	startedAt: number;
	finishedAt: number | null;
	dismissed: boolean;
}

type JobsState = Record<string, Job>;

// Mirrors the JobEvent union from src/lib/job-context.ts
type JobEvent =
	| { event: 'job:start'; jobId: string; type: string; label: string; phases: string[] }
	| {
			event: 'job:progress';
			jobId: string;
			phase: string;
			processed: number;
			total: number | null;
			detail: string;
	  }
	| { event: 'job:paused'; jobId: string }
	| { event: 'job:complete'; jobId: string; durationMs: number }
	| { event: 'job:error'; jobId: string; error: string };

export function tryParseJobEvent(line: string): JobEvent | null {
	try {
		const parsed = JSON.parse(line);
		if (typeof parsed?.event === 'string' && parsed.event.startsWith('job:')) {
			return parsed as JobEvent;
		}
	} catch {
		/* not JSON */
	}
	return null;
}

// ================================
// Store
// ================================

function createJobsStore() {
	const { subscribe, update } = writable<JobsState>({});

	return {
		subscribe,

		/** Parse a raw JSON line from the sidecar and update the store. */
		upsertFromEvent(line: string, scanTabId: string): void {
			const evt = tryParseJobEvent(line);
			if (!evt) return;

			update((state) => {
				const existing = state[evt.jobId];

				switch (evt.event) {
					case 'job:start':
						return {
							...state,
							[evt.jobId]: {
								id: evt.jobId,
								scanTabId,
								type: evt.type,
								label: evt.label,
								phases: evt.phases,
								status: 'running',
								currentPhase: evt.phases[0] ?? '',
								progress: null,
								total: null,
								detail: null,
								error: null,
								startedAt: Date.now(),
								finishedAt: null,
								dismissed: false
							}
						};

					case 'job:progress':
						if (!existing) return state;
						return {
							...state,
							[evt.jobId]: {
								...existing,
								status: 'running',
								currentPhase: evt.phase,
								progress: evt.processed,
								total: evt.total,
								detail: evt.detail
							}
						};

					case 'job:paused':
						if (!existing) return state;
						return { ...state, [evt.jobId]: { ...existing, status: 'paused' } };

					case 'job:complete':
						if (!existing) return state;
						return {
							...state,
							[evt.jobId]: { ...existing, status: 'complete', finishedAt: Date.now() }
						};

					case 'job:error':
						if (!existing) return state;
						return {
							...state,
							[evt.jobId]: {
								...existing,
								status: 'error',
								error: evt.error,
								finishedAt: Date.now()
							}
						};

					default:
						return state;
				}
			});
		},

		dismiss(jobId: string): void {
			update((state) => {
				const job = state[jobId];
				if (!job) return state;
				return { ...state, [jobId]: { ...job, dismissed: true } };
			});
		},

		getJobsForScan(scanTabId: string): Job[] {
			const state = get({ subscribe });
			return Object.values(state).filter((j) => j.scanTabId === scanTabId && !j.dismissed);
		}
	};
}

export const jobsStore = createJobsStore();

/** All non-dismissed, non-scan jobs for a given scan tab (checksum, export, etc.) */
export const backgroundJobsForTab = (scanTabId: string) =>
	derived(jobsStore, ($jobs) =>
		Object.values($jobs).filter(
			(j) => j.scanTabId === scanTabId && !j.dismissed && j.type !== 'scan'
		)
	);
