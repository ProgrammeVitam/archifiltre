/**
 * Undo/redo UI actions + reactive can-undo/can-redo state, shared by the header buttons
 * and the global keyboard shortcuts. The engine lives in the sidecar (enrichment/undo.ts);
 * here we just call it for the active scan's db and refresh the view afterwards.
 */
import { get, writable } from 'svelte/store';
import { activeScan, invalidateEnrichment, hydrateTagDictionary } from '$lib/stores';
import { undo, redo, getUndoState, getEnrichment, useOwnerDb } from '$lib/tauri';

export const undoRedoState = writable<{ canUndo: boolean; canRedo: boolean }>({
	canUndo: false,
	canRedo: false,
});

/** Re-read can-undo/can-redo for the active scan (call after mutations, undo/redo, tab switch). */
export async function refreshUndoState(): Promise<void> {
	const db = get(activeScan)?.dbName;
	if (!useOwnerDb() || !db) {
		undoRedoState.set({ canUndo: false, canRedo: false });
		return;
	}
	const s = await getUndoState(db);
	if (s) undoRedoState.set(s);
}

// After an undo/redo the enrichment changed somewhere — refresh the tree bands + chart +
// details panel (all react to invalidateEnrichment), re-hydrate the tag list, and update
// the button-enabled state.
async function applyAndRefresh(db: string): Promise<void> {
	invalidateEnrichment('', true);
	const data = await getEnrichment(db);
	if (data) hydrateTagDictionary(data.tags);
	await refreshUndoState();
}

export async function doUndo(): Promise<void> {
	const db = get(activeScan)?.dbName;
	if (!useOwnerDb() || !db) return;
	const res = await undo(db);
	if (res?.ok) await applyAndRefresh(db);
}

export async function doRedo(): Promise<void> {
	const db = get(activeScan)?.dbName;
	if (!useOwnerDb() || !db) return;
	const res = await redo(db);
	if (res?.ok) await applyAndRefresh(db);
}
