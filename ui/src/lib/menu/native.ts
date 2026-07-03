/**
 * Builds the NATIVE OS menu from the shared model ({@link buildMenu}) using Tauri's
 * JS menu API, and installs it as the macOS global menu bar or the window menu (which
 * KDE/Plasma exports to its global menu). Same labels, actions and enabled-state as the
 * in-app menubar — one source of truth.
 *
 * Returns true if a native menu was installed (so the caller can hide the in-app ☰).
 * On the browser bridge or an unsupported platform it returns false and the in-app
 * menubar stays.
 */
import { buildMenu, isSeparator, type MenuContext } from './model';

/**
 * Platforms where we install a native menu. **macOS only** — there it becomes the global
 * menu bar cleanly. On Linux a native menu renders as a detached in-window GTK menubar
 * (broken with our frameless `decorations:false` window unless the user installs
 * `appmenu-gtk-module` + sets `GTK_MODULES`), and frameless Windows apps keep their own
 * menu — both use the in-app ☰ instead.
 */
export function usesNativeMenu(platform: string | undefined): boolean {
	return platform === 'macos';
}

export async function applyNativeMenu(ctx: MenuContext, t: (key: string) => string): Promise<boolean> {
	try {
		const { Menu, Submenu, MenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu');
		const { type } = await import('@tauri-apps/plugin-os');

		const groups = buildMenu(ctx);
		const submenus = await Promise.all(
			groups.map(async (group) => {
				const items = await Promise.all(
					group.entries.map(async (entry) => {
						if (isSeparator(entry)) {
							return PredefinedMenuItem.new({ item: 'Separator' });
						}
						return MenuItem.new({
							id: entry.id,
							text: t(entry.labelKey),
							accelerator: entry.accelerator,
							enabled: entry.enabled !== false,
							action: () => void entry.run()
						});
					})
				);
				return Submenu.new({ text: t(group.labelKey), items });
			})
		);

		const menu = await Menu.new({ items: submenus });
		const os = await type();
		if (os === 'macos') {
			await menu.setAsAppMenu();
		} else {
			// Linux (KDE exports this to the global menu) and Windows.
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			await menu.setAsWindowMenu(getCurrentWindow());
		}
		return true;
	} catch {
		// No Tauri (browser bridge) or the API is unavailable — keep the in-app menubar.
		return false;
	}
}
