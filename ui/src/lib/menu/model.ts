/**
 * The application menu, defined ONCE and rendered two ways:
 *  - the in-app menubar (bits-ui Menubar behind the ☰), and
 *  - the native OS menu (macOS global bar / KDE global menu) via the Tauri menu API.
 *
 * Keeping a single model means labels (i18n keys), actions, accelerators and
 * enabled-state never drift between the two surfaces.
 */

export interface MenuItemModel {
	id: string;
	/** i18n key resolved by whichever surface renders it. */
	labelKey: string;
	/** Native accelerator, e.g. 'CmdOrCtrl+N'. */
	accelerator?: string;
	/** Display shortcut for the in-app menubar, e.g. '⌘N'. */
	shortcut?: string;
	enabled?: boolean;
	run: () => void | Promise<void>;
}
export interface MenuSeparatorModel {
	separator: true;
}
export type MenuEntry = MenuItemModel | MenuSeparatorModel;

export interface MenuGroupModel {
	id: string;
	labelKey: string;
	entries: MenuEntry[];
}

/** Everything the model needs from the host: current enabled-state + action callbacks. */
export interface MenuContext {
	browseable: boolean;
	/** The scan finished fully (duplicate detection included). The audit report needs this —
	 *  a paused/partial scan has no hashes yet, so its redundancy section would be all zeros. */
	scanComplete: boolean;
	viewable: boolean;
	canUndo: boolean;
	canRedo: boolean;
	actions: {
		about: () => void;
		settings: () => void;
		quit: () => void;
		newScan: () => void;
		exportCsv: () => void;
		exportDeletionManifest: () => void;
		exportResip: () => void;
		exportXlsx: () => void;
		exportAudit: () => void;
		exportAnnotations: () => void;
		importAnnotations: () => void;
		exportLogs: () => void;
		closeWindow: () => void;
		undo: () => void;
		redo: () => void;
		viewVisual: () => void;
		viewFlat: () => void;
		colourType: () => void;
		colourDate: () => void;
		sortSize: () => void;
		sortName: () => void;
		sortDate: () => void;
		toggleSidebar: () => void;
	};
}

const sep: MenuSeparatorModel = { separator: true };

export function isSeparator(e: MenuEntry): e is MenuSeparatorModel {
	return 'separator' in e;
}

export function buildMenu(ctx: MenuContext): MenuGroupModel[] {
	const a = ctx.actions;
	return [
		{
			id: 'app',
			labelKey: 'menu.app',
			entries: [
				{ id: 'about', labelKey: 'menu.about', run: a.about },
				sep,
				{ id: 'settings', labelKey: 'menu.settings', accelerator: 'CmdOrCtrl+,', shortcut: '⌘,', run: a.settings },
				sep,
				// Support bundle. Lives in the app menu (support concerns the app, not a
				// document) and is ALWAYS enabled — it must be exportable precisely when
				// nothing else works (no scan, broken DB, failed session).
				{ id: 'exportLogs', labelKey: 'menu.exportLogs', run: a.exportLogs },
				sep,
				{ id: 'quit', labelKey: 'menu.quit', accelerator: 'CmdOrCtrl+Q', run: a.quit }
			]
		},
		{
			id: 'file',
			labelKey: 'menu.file',
			entries: [
				{ id: 'newScan', labelKey: 'common.newScan', accelerator: 'CmdOrCtrl+N', shortcut: '⌘N', run: a.newScan },
				sep,
				{ id: 'exportCsv', labelKey: 'export.csv', enabled: ctx.browseable, run: a.exportCsv },
				{ id: 'exportDeletionManifest', labelKey: 'export.deletionManifest', enabled: ctx.browseable, run: a.exportDeletionManifest },
				{ id: 'exportResip', labelKey: 'export.resip', enabled: ctx.browseable, run: a.exportResip },
				{ id: 'exportXlsx', labelKey: 'export.xlsx', enabled: ctx.browseable, run: a.exportXlsx },
				{ id: 'exportAudit', labelKey: 'export.auditReport', enabled: ctx.scanComplete, run: a.exportAudit },
				sep,
				// Annotation backup: portable copy of the user's work; import restores it onto
				// any scan of the same folder (or moves it between machines).
				{ id: 'exportAnnotations', labelKey: 'menu.exportAnnotations', enabled: ctx.browseable, run: a.exportAnnotations },
				{ id: 'importAnnotations', labelKey: 'menu.importAnnotations', enabled: ctx.browseable, run: a.importAnnotations },
				sep,
				{ id: 'closeWindow', labelKey: 'menu.closeWindow', accelerator: 'CmdOrCtrl+W', run: a.closeWindow }
			]
		},
		{
			id: 'edit',
			labelKey: 'menu.edit',
			entries: [
				{ id: 'undo', labelKey: 'menu.undo', accelerator: 'CmdOrCtrl+Z', shortcut: '⌘Z', enabled: ctx.canUndo, run: a.undo },
				{ id: 'redo', labelKey: 'menu.redo', accelerator: 'CmdOrCtrl+Shift+Z', shortcut: '⇧⌘Z', enabled: ctx.canRedo, run: a.redo }
			]
		},
		{
			id: 'view',
			labelKey: 'menu.view',
			entries: [
				{ id: 'viewVisual', labelKey: 'view.visual', enabled: ctx.viewable, run: a.viewVisual },
				{ id: 'viewFlat', labelKey: 'view.flat', enabled: ctx.browseable, run: a.viewFlat },
				sep,
				{ id: 'colourType', labelKey: 'menu.colourByType', enabled: ctx.viewable, run: a.colourType },
				{ id: 'colourDate', labelKey: 'menu.colourByDate', enabled: ctx.viewable, run: a.colourDate },
				sep,
				{ id: 'sortSize', labelKey: 'menu.sortBySize', enabled: ctx.viewable, run: a.sortSize },
				{ id: 'sortName', labelKey: 'menu.sortByName', enabled: ctx.viewable, run: a.sortName },
				{ id: 'sortDate', labelKey: 'menu.sortByDate', enabled: ctx.browseable, run: a.sortDate },
				sep,
				{ id: 'toggleSidebar', labelKey: 'menu.toggleSidebar', accelerator: 'CmdOrCtrl+B', shortcut: '⌘B', run: a.toggleSidebar }
			]
		}
	];
}
