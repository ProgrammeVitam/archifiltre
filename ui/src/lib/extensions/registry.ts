import { writable, get } from 'svelte/store';

// ================================
// Types
// ================================

export interface ExportMenuItem {
	id: string;
	label: string;
	icon?: string;
	action: () => Promise<void>;
}

export interface UIExtension {
	/** Matches the backend manifest id */
	id: string;
	name: string;
	description: string;
	exportMenuItems?: ExportMenuItem[];
}

// ================================
// Persistence
// ================================

const ENABLED_KEY = 'archifiltre-extensions-enabled';

function loadEnabledIds(): Set<string> {
	try {
		const stored = localStorage.getItem(ENABLED_KEY);
		if (!stored) return new Set(['csv-export', 'checksum']);
		return new Set(JSON.parse(stored) as string[]);
	} catch {
		return new Set(['csv-export', 'checksum']);
	}
}

function saveEnabledIds(ids: Set<string>): void {
	try {
		localStorage.setItem(ENABLED_KEY, JSON.stringify([...ids]));
	} catch {
		/* ignore */
	}
}

// ================================
// Registry Store
// ================================

interface RegistryState {
	extensions: UIExtension[];
	enabledIds: Set<string>;
}

function createRegistry() {
	const enabledIds = loadEnabledIds();

	const { subscribe, update } = writable<RegistryState>({
		extensions: [],
		enabledIds
	});

	return {
		subscribe,

		/** Register a UI extension definition. Called at app startup. */
		register(ext: UIExtension): void {
			update((state) => ({
				...state,
				extensions: [...state.extensions.filter((e) => e.id !== ext.id), ext]
			}));
		},

		/** Toggle enabled state of an extension. */
		setEnabled(id: string, enabled: boolean): void {
			update((state) => {
				const newIds = new Set(state.enabledIds);
				if (enabled) newIds.add(id);
				else newIds.delete(id);
				saveEnabledIds(newIds);
				return { ...state, enabledIds: newIds };
			});
		},

		isEnabled(id: string): boolean {
			return get({ subscribe }).enabledIds.has(id);
		},

		/** All registered extensions with their enabled state. */
		getAll(): Array<UIExtension & { enabled: boolean }> {
			const state = get({ subscribe });
			return state.extensions.map((e) => ({
				...e,
				enabled: state.enabledIds.has(e.id)
			}));
		},

		/** Export menu items from all enabled extensions. */
		getExportMenuItems(): ExportMenuItem[] {
			const state = get({ subscribe });
			return state.extensions
				.filter((e) => state.enabledIds.has(e.id))
				.flatMap((e) => e.exportMenuItems ?? []);
		}
	};
}

export const extensionRegistry = createRegistry();
