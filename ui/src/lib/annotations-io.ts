/**
 * Manual annotation backup — File → Export / Import annotations.
 *
 * Export writes this scan's annotations (aliases/comments/tags/marks) to a user-chosen
 * JSON file: a portable copy of the user's irreplaceable work, and a way to move it
 * between machines. Import restores such a file onto the active scan, path-keyed (same
 * semantics as post-rescan restore), and surfaces the restore result via the recovery
 * prompt (restored / orphaned counts).
 */

import { get } from 'svelte/store';
import { activeScan } from '$lib/stores';
import { exportAnnotations, importAnnotations } from '$lib/tauri';
import { reportSaveStatus } from '$lib/stores';
import { restorePrompt } from '$lib/scan-recovery';

/** Export the active scan's annotations to a user-picked .json path. */
export async function exportAnnotationsFlow(): Promise<void> {
	const scan = get(activeScan);
	if (!scan?.dbName) return;
	const { save } = await import('@tauri-apps/plugin-dialog');
	const path = await save({
		title: 'Export annotations',
		defaultPath: `${scan.name || 'annotations'}-annotations-${Date.now()}.json`,
		filters: [{ name: 'JSON', extensions: ['json'] }]
	});
	if (!path) return;
	try {
		reportSaveStatus('saving', 'annotations');
		await exportAnnotations(path, scan.dbName);
		reportSaveStatus('saved', 'annotations');
	} catch (e) {
		console.error('annotation export failed', e);
		reportSaveStatus('error', 'annotations');
	}
}

/** Import an annotations .json onto the active scan; surface the result in the banner. */
export async function importAnnotationsFlow(): Promise<void> {
	const scan = get(activeScan);
	if (!scan?.dbName) return;
	const { open } = await import('@tauri-apps/plugin-dialog');
	const picked = await open({
		title: 'Import annotations',
		multiple: false,
		filters: [{ name: 'JSON', extensions: ['json'] }]
	});
	const path = Array.isArray(picked) ? picked[0] : picked;
	if (!path) return;
	try {
		const { restored, orphaned } = await importAnnotations(path, scan.dbName);
		// Reuse the recovery banner's "done" state to report what happened.
		restorePrompt.set({
			scanId: scan.id,
			dbName: scan.dbName,
			count: restored,
			status: 'done',
			restored,
			orphaned
		});
	} catch (e) {
		console.error('annotation import failed', e);
		reportSaveStatus('error', 'annotations');
	}
}
