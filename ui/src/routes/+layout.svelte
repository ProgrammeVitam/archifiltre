<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import {
		platform,
		detectPlatform,
		activeScan,
		hasActiveScans,
		scansStore,
		viewMode,
		colorMode,
		sortMode,
		settingsOpen,
		aboutOpen,
		windowEffect,
		type Platform,
		type ViewMode
	} from '$lib/stores';
	import { _ } from '$lib/i18n';
	import AboutDialog from '$lib/components/AboutDialog.svelte';
	import ActionToolbar from '$lib/components/ActionToolbar.svelte';
	import { buildMenu, isSeparator } from '$lib/menu/model';
	import { applyNativeMenu, usesNativeMenu } from '$lib/menu/native';
	import { exportCsv, selectExportPath, generateId, useOwnerDb } from '$lib/tauri';
	import { installLogCapture } from '$lib/log-buffer';
	import { exportLogsFlow } from '$lib/log-export';
	import { exportAnnotationsFlow, importAnnotationsFlow } from '$lib/annotations-io';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { ButtonGroup } from '$lib/components/ui/button-group';
	import * as Menubar from '$lib/components/ui/menubar';
	import * as Tabs from '$lib/components/ui/tabs';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import ArchifiltreLogo from '$lib/components/ArchifiltreLogo.svelte';
	import {
		LoaderCircleIcon,
		CircleCheckIcon,
		CircleAlertIcon,
		PanelLeftIcon,
		KanbanIcon,
		SquareKanbanIcon,
		SquareChartGanttIcon,
		ListIcon,
		Undo2Icon,
		Redo2Icon,
		MenuIcon,
		FilePlusIcon,
		DownloadIcon,
		PaletteIcon,
		LogOutIcon,
		ArrowDownWideNarrowIcon,
		ArrowDownAZIcon,
		CalendarArrowDownIcon,
		SettingsIcon
	} from '@lucide/svelte';
	import { doUndo, doRedo, undoRedoState } from '$lib/history';
	import ExportDropdown from '$lib/components/ExportDropdown.svelte';
	import BackgroundJobsPanel from '$lib/components/BackgroundJobsPanel.svelte';
	import { extensionRegistry } from '$lib/extensions/registry';

	const BUNDLED_EXTENSIONS = [
		{ id: 'checksum', name: 'Checksum', description: 'Computes cryptographic checksums for scanned files' },
		{ id: 'ai-describe', name: 'AI Describe', description: 'Generates LLM-powered descriptions for directories' },
		{ id: 'file-thumbnails', name: 'File Thumbnails', description: 'Stores browser-generated thumbnails for files' },
		{ id: 'enrichment', name: 'Enrichment', description: 'Aliases, comments, tags and deletion marks for files and directories' }
	];

	let { children } = $props();

	let showDevTools = $state(false);
	let devPlatformOverride = $state<Platform | null>(null);
	let sidebarCollapsed = $state(false);

	// Use dev override if set, otherwise use detected platform
	let effectivePlatform = $derived(devPlatformOverride ?? $platform);

	// Check if we're on Linux (GNOME) - needs CSS shadows and custom resize handles
	let isLinux = $derived(effectivePlatform === 'gnome');

	// Resize handle directions (only used on Linux)
	type ResizeDirection =
		| 'North'
		| 'South'
		| 'East'
		| 'West'
		| 'NorthEast'
		| 'NorthWest'
		| 'SouthEast'
		| 'SouthWest';

	async function startResize(direction: ResizeDirection) {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const appWindow = getCurrentWindow();
		await appWindow.startResizeDragging(direction);
	}

	// Window control actions
	async function closeWindow() {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const appWindow = getCurrentWindow();
		await appWindow.close();
	}

	async function toggleMaximize() {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const appWindow = getCurrentWindow();
		const isMaximized = await appWindow.isMaximized();
		if (isMaximized) {
			await appWindow.unmaximize();
		} else {
			await appWindow.maximize();
		}
	}

	async function minimizeWindow() {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const appWindow = getCurrentWindow();
		await appWindow.minimize();
	}

	async function startDrag(e: MouseEvent) {
		// Only drag if not clicking on interactive elements
		if ((e.target as HTMLElement).closest('button, a, input, [data-no-drag]')) {
			return;
		}
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		const appWindow = getCurrentWindow();
		await appWindow.startDragging();
	}

	async function handleDoubleClick(e: MouseEvent) {
		// Only toggle maximize if not clicking on interactive elements
		if ((e.target as HTMLElement).closest('button, a, input, [data-no-drag]')) {
			return;
		}
		await toggleMaximize();
	}

	function setViewMode(mode: ViewMode) {
		viewMode.set(mode);
	}

	// ── Collapsible menubar (Zed-style) ──────────────────────────────────────────
	// The ☰ button swaps the left "lens" group for a full File/Edit/View menubar.
	// It stays open while the pointer is over the cluster OR a menu dropdown is open;
	// leaving the cluster with everything closed collapses it back to the lenses.
	let showMenu = $state(false);
	let overMenuBar = $state(false); // pointer is over the ☰ + menubar cluster
	let openMenu = $state<string>(''); // bind:value of the Menubar — '' when no menu is open
	$effect(() => {
		if (showMenu && !openMenu && !overMenuBar) showMenu = false;
	});
	// Run a menu action then collapse back to the lens group (acting is a natural exit).
	function runMenu(action: () => void) {
		action();
		showMenu = false;
	}

	function newScan() {
		scansStore.addScan();
	}

	async function exportActiveCsv(deletionOnly = false): Promise<void> {
		const scan = $activeScan;
		if (!scan) return;
		const outputPath = await selectExportPath(deletionOnly ? 'bordereau-elimination' : undefined);
		if (!outputPath) return;
		exportCsv({ outputPath, jobId: generateId(), dbName: scan.dbName, fullPaths: true, deletionOnly });
	}

	// Archival exports: RESIP (SEDA import CSV) and a two-sheet Excel workbook. Both walk
	// the tree with enrichment folded in; RESIP drops items marked for deletion.
	async function exportArchival(format: 'resip' | 'xlsx' | 'docx'): Promise<void> {
		const scan = $activeScan;
		if (!scan) return;
		const [type, ext, filter] =
			format === 'xlsx'
				? ['excel', 'xlsx', 'Excel']
				: format === 'docx'
					? ['rapport-audit', 'docx', 'Word']
					: ['resip', 'csv', 'CSV'];
		const outputPath = await selectExportPath(type, ext, filter);
		if (!outputPath) return;
		exportCsv({ outputPath, jobId: generateId(), dbName: scan.dbName, format });
	}

	// ── Shared menu model (one source of truth for the in-app menubar AND the native OS menu) ──
	const menuActions = {
		about: () => aboutOpen.set(true),
		settings: () => settingsOpen.set(true),
		quit: closeWindow,
		newScan,
		exportCsv: () => exportActiveCsv(false),
		exportDeletionManifest: () => exportActiveCsv(true),
		exportResip: () => exportArchival('resip'),
		exportXlsx: () => exportArchival('xlsx'),
		exportAudit: () => exportArchival('docx'),
		exportAnnotations: () => void exportAnnotationsFlow(),
		importAnnotations: () => void importAnnotationsFlow(),
		exportLogs: () => void exportLogsFlow(),
		closeWindow,
		undo: doUndo,
		redo: doRedo,
		viewVisual: () => setViewMode('stalactite'),
		viewFlat: () => setViewMode('flat'),
		colourType: () => colorMode.set('type'),
		colourDate: () => colorMode.set('date'),
		sortSize: () => sortMode.set('size'),
		sortName: () => sortMode.set('name'),
		sortDate: () => sortMode.set('date'),
		toggleSidebar: () => (sidebarCollapsed = !sidebarCollapsed)
	};
	let menuCtx = $derived({
		browseable,
		scanComplete,
		viewable,
		canUndo: $undoRedoState.canUndo,
		canRedo: $undoRedoState.canRedo,
		actions: menuActions
	});
	let menuModel = $derived(buildMenu(menuCtx));
	// Icons for the in-app menubar only (the native menu uses OS conventions). Keyed by item id.
	const MENU_ICON: Record<string, typeof MenuIcon> = {
		settings: SettingsIcon,
		quit: LogOutIcon,
		closeWindow: LogOutIcon,
		newScan: FilePlusIcon,
		exportCsv: DownloadIcon,
		exportDeletionManifest: DownloadIcon,
		exportResip: DownloadIcon,
		exportXlsx: DownloadIcon,
		exportAudit: DownloadIcon,
		exportAnnotations: DownloadIcon,
		importAnnotations: DownloadIcon,
		exportLogs: DownloadIcon,
		undo: Undo2Icon,
		redo: Redo2Icon,
		viewVisual: KanbanIcon,
		viewFlat: ListIcon,
		colourType: PaletteIcon,
		colourDate: PaletteIcon,
		sortSize: ArrowDownWideNarrowIcon,
		sortName: ArrowDownAZIcon,
		sortDate: CalendarArrowDownIcon,
		toggleSidebar: PanelLeftIcon
	};

	// Install the native OS menu (macOS global bar / KDE global menu) from the same model.
	// Succeeds only in the real Tauri app on a supported platform → then we hide the in-app ☰.
	// Rebuilds when the language ($_) or enabled-state (menuCtx) changes.
	let nativeMenuApplied = $state(false);
	$effect(() => {
		const translate = $_; // track language changes
		const ctx = menuCtx; // track enabled-state changes
		if (!usesNativeMenu(effectivePlatform)) {
			nativeMenuApplied = false;
			return;
		}
		applyNativeMenu(ctx, translate).then((ok) => (nativeMenuApplied = ok));
	});

	onMount(() => {
		// First thing: start capturing console/window errors into the in-memory ring
		// buffer, so the "Export logs" bundle carries the session's UI-side story.
		installLogCapture();

		for (const ext of BUNDLED_EXTENSIONS) {
			extensionRegistry.register(ext);
		}

		const handleKeydown = (e: KeyboardEvent) => {
			// Dev tools toggle: Ctrl+Shift+P
			if (e.ctrlKey && e.shiftKey && e.key === 'P') {
				e.preventDefault();
				showDevTools = !showDevTools;
			}

			// Toggle sidebar: Ctrl+B
			if (e.ctrlKey && !e.shiftKey && e.key === 'b') {
				e.preventDefault();
				sidebarCollapsed = !sidebarCollapsed;
			}
		};

		window.addEventListener('keydown', handleKeydown);

		// Async initialization
		(async () => {
			await detectPlatform();
			// Reconcile the on-disk scan datadirs against the restored tab list: surface
			// interrupted/complete scans the UI forgot (crash before persist, wiped
			// profile) and flag tabs whose datadir vanished. Owner mode only (query mode
			// has no per-scan datadirs to reconcile). Best-effort — never blocks launch.
			if (useOwnerDb()) {
				try {
					const { reconcileScans } = await import('$lib/scan-recovery');
					const res = await reconcileScans();
					if (res.adopted || res.missing) {
						console.warn(
							`scan reconciliation: adopted ${res.adopted}, flagged ${res.missing} missing`
						);
					}
				} catch (e) {
					console.warn('scan reconciliation failed', e);
				}
			}
		})();

		return () => {
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	function setDevPlatform(p: Platform | null) {
		devPlatformOverride = p;
	}

	// The toolbar is PRESENT from the moment a scan starts (not only when complete), so the
	// header is a stable structure instead of popping in — controls just enable as their
	// data becomes available.
	let hasScan = $derived(!!$activeScan && $activeScan.state !== 'idle');
	// A browseable tree exists (completed, or paused mid-scan) → export becomes usable.
	let browseable = $derived(
		$activeScan?.state === 'complete' || $activeScan?.state === 'paused'
	);
	// Fully finished (hashing + duplicate detection done). The audit report gates on this,
	// not `browseable` — a paused scan is browseable but has no redundancy data yet.
	let scanComplete = $derived($activeScan?.state === 'complete');
	// Viewing + recolouring work on the LIVE partial tree too, so they're enabled DURING a
	// scan — not just when complete. Only duplicate-derived affordances wait for hashing.
	let viewable = $derived($activeScan?.state === 'scanning' || browseable);
</script>

<!-- Window container - padding and shadow only on Linux -->
<div class="window-container" class:window-container-linux={isLinux}>
	<!-- Main app container with rounded corners -->
	<div
		id="app-window"
		class="window-frame"
		class:window-frame-linux={isLinux}
		class:solid-bg={!$windowEffect}
	>
		<!-- Resize handles - only needed on Linux where we have CSS shadows with padding -->
		{#if isLinux}
			<div
				role="presentation"
				class="resize-handle resize-n"
				onmousedown={() => startResize('North')}
			></div>
			<div
				role="presentation"
				class="resize-handle resize-s"
				onmousedown={() => startResize('South')}
			></div>
			<div
				role="presentation"
				class="resize-handle resize-e"
				onmousedown={() => startResize('East')}
			></div>
			<div
				role="presentation"
				class="resize-handle resize-w"
				onmousedown={() => startResize('West')}
			></div>
			<div
				role="presentation"
				class="resize-handle resize-ne"
				onmousedown={() => startResize('NorthEast')}
			></div>
			<div
				role="presentation"
				class="resize-handle resize-nw"
				onmousedown={() => startResize('NorthWest')}
			></div>
			<div
				role="presentation"
				class="resize-handle resize-se"
				onmousedown={() => startResize('SouthEast')}
			></div>
			<div
				role="presentation"
				class="resize-handle resize-sw"
				onmousedown={() => startResize('SouthWest')}
			></div>
		{/if}

		<!-- App Layout: Sidebar + Main Content Wrapper -->
		<div class="app-layout">
			<!-- Collapsible Sidebar (full height) -->
			<Sidebar bind:collapsed={sidebarCollapsed} {isLinux} />

			<!-- Main Content Wrapper (titlebar + content) -->
			<div class="main-content-wrapper">
				<!-- Dev tools panel -->
				{#if showDevTools}
					<div class="dev-tools" data-no-drag>
						<span class="dev-tools-label">Platform:</span>
						<button
							class="dev-tools-btn"
							class:active={devPlatformOverride === null}
							onclick={() => setDevPlatform(null)}
						>
							Auto ({$platform ?? '...'})
						</button>
						<button
							class="dev-tools-btn"
							class:active={devPlatformOverride === 'windows'}
							onclick={() => setDevPlatform('windows')}
						>
							Windows
						</button>
						<button
							class="dev-tools-btn"
							class:active={devPlatformOverride === 'macos'}
							onclick={() => setDevPlatform('macos')}
						>
							macOS
						</button>
						<button
							class="dev-tools-btn"
							class:active={devPlatformOverride === 'gnome'}
							onclick={() => setDevPlatform('gnome')}
						>
							GNOME
						</button>
						<span class="dev-tools-hint">Ctrl+Shift+P to toggle</span>
					</div>
				{/if}

				<!-- Title bar -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<header
					class="titlebar"
					class:titlebar-macos={effectivePlatform === 'macos'}
					class:titlebar-linux={isLinux}
					onmousedown={startDrag}
					ondblclick={handleDoubleClick}
				>
					<!-- macOS: controls on left -->
					{#if effectivePlatform === 'macos'}
						<div class="window-controls macos" data-no-drag>
							<button class="control-btn control-close" onclick={closeWindow} title="Close">
								<span class="control-icon">×</span>
							</button>
							<button
								class="control-btn control-minimize"
								onclick={minimizeWindow}
								title="Minimize"
							>
								<span class="control-icon">−</span>
							</button>
							<button
								class="control-btn control-maximize"
								onclick={toggleMaximize}
								title="Maximize"
							>
								<span class="control-icon">+</span>
							</button>
						</div>
					{/if}

					<!-- Left cluster. The ☰ button swaps the "lens" toggle group (Visual/Tree/Flat)
					     for a full File/Edit/View menubar, Zed-style: click to reveal the menubar,
					     move the pointer away (with no menu open) to collapse back to the lenses.
					     Visual is the LIVE lens (usable mid-scan); Tree/Flat need a stable tree. -->
					<div
						class="flex items-center gap-1"
						data-no-drag
						onpointerenter={() => (overMenuBar = true)}
						onpointerleave={() => (overMenuBar = false)}
					>
						{#if showMenu && !nativeMenuApplied}
							<Menubar.Root bind:value={openMenu}>
								{#each menuModel as group (group.id)}
									<Menubar.Menu value={group.id}>
										<Menubar.Trigger>{$_(group.labelKey)}</Menubar.Trigger>
										<Menubar.Content>
											{#each group.entries as entry, i (i)}
												{#if isSeparator(entry)}
													<Menubar.Separator />
												{:else}
													{@const Icon = MENU_ICON[entry.id]}
													<Menubar.Item
														disabled={entry.enabled === false}
														onSelect={() => runMenu(entry.run)}
													>
														{#if Icon}<Icon />{/if}
														{$_(entry.labelKey)}
														{#if entry.shortcut}<Menubar.Shortcut>{entry.shortcut}</Menubar.Shortcut>{/if}
													</Menubar.Item>
												{/if}
											{/each}
										</Menubar.Content>
									</Menubar.Menu>
								{/each}
							</Menubar.Root>
						{:else}
							<!-- Menu closed: the ☰ button sits where the "Archifiltre" menu will
							     appear, so opening the menu swaps it in right under the cursor. -->
							{#if !nativeMenuApplied}
								<Button
									variant="ghost"
									size="icon"
									class="size-7 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
									onclick={() => {
										openMenu = 'app';
										showMenu = true;
									}}
									title="Menu"
								>
									<MenuIcon size={15} />
								</Button>
							{/if}
						{/if}
					</div>

					<!-- Sidebar toggle (when collapsed) - single button with logo, status, and folder
					     name. Hidden while the ☰ app menu is open so the menubar stands alone. -->
					{#if sidebarCollapsed && !showMenu}
						<button
							class="sidebar-toggle-btn"
							onclick={() => (sidebarCollapsed = false)}
							title="Open sidebar (Ctrl+B)"
							data-no-drag
						>
							<span class="sidebar-toggle-icon">
								<ArchifiltreLogo size={20} class="toggle-logo" />
								<PanelLeftIcon size={18} class="toggle-panel-icon" />
							</span>
							{#if $activeScan?.path}
								{#if $activeScan.state === 'scanning'}
									<LoaderCircleIcon size={14} class="animate-spin text-blue-500" />
								{:else if $activeScan.state === 'complete'}
									<CircleCheckIcon size={14} class="text-green-500" />
								{:else if $activeScan.state === 'error'}
									<CircleAlertIcon size={14} class="text-red-500" />
								{/if}
								<span class="sidebar-toggle-scan-name">{$activeScan.name}</span>
							{/if}
						</button>
					{/if}

					<!-- Lens toggle group (Visual / Flat), after the app identity. Hidden while
					     the menubar is open (the ☰ up front becomes the menubar). -->
					{#if hasScan && !showMenu}
						<div data-no-drag>
							<Tabs.Root value={$viewMode} onValueChange={(v) => v && setViewMode(v as ViewMode)}>
								<Tabs.List class="h-8">
									<Tabs.Trigger value="stalactite" disabled={!viewable} class="gap-1.5 text-xs">
										<SquareKanbanIcon size={14} /> {$_('view.visual')}
									</Tabs.Trigger>
									<Tabs.Trigger value="flat" disabled={!browseable} class="gap-1.5 text-xs">
										<SquareChartGanttIcon size={14} /> {$_('view.flat')}
									</Tabs.Trigger>
								</Tabs.List>
							</Tabs.Root>
						</div>
					{/if}

					<!-- Shared, view-aware action toolbar (Visual → Colours/Sort; List →
					     arrangement/Filter/Search), centered by balancing spacers on each side so
					     the wide List toolbar never collides with the right cluster. Hidden while
					     the ☰ app menu is open. -->
					<!-- viewable (not browseable): Colours/Sort apply to the LIVE icicle during
					     a scan too; the List-only controls are reachable only once the Liste tab
					     unlocks, and duplicates gating lives inside the toolbar. -->
					{#if hasScan && viewable && !showMenu}
						<div class="titlebar-spacer"></div>
						<div data-no-drag>
							<ActionToolbar />
						</div>
					{/if}

					<!-- Spacer to push export and controls to the right -->
					<div class="titlebar-spacer"></div>

					<!-- Undo / redo — head of the right actions cluster (Cmd/Ctrl+Z mirror).
					     Present whenever a scan exists; each button enables on can-undo/redo. -->
					{#if hasScan}
						<ButtonGroup data-no-drag>
							<Button
								variant="outline"
								size="icon"
								class="size-7"
								disabled={!$undoRedoState.canUndo}
								onclick={doUndo}
								title="Undo (Ctrl+Z)"
							>
								<Undo2Icon size={14} />
							</Button>
							<Button
								variant="outline"
								size="icon"
								class="size-7"
								disabled={!$undoRedoState.canRedo}
								onclick={doRedo}
								title="Redo (Ctrl+Shift+Z)"
							>
								<Redo2Icon size={14} />
							</Button>
						</ButtonGroup>
					{/if}

					<!-- Colour mode now lives in the shared ActionToolbar (Colours ▾, Visual view). -->

					<!-- Export — present from scan-start; disabled until there's data to export. -->
					{#if hasScan}
						<ExportDropdown disabled={!browseable} />
					{/if}

					<!-- Windows/GNOME: controls on right -->
					{#if effectivePlatform && effectivePlatform !== 'macos'}
						<div class="window-controls" data-no-drag>
							<button
								class="control-btn control-minimize"
								onclick={minimizeWindow}
								title="Minimize"
							>
								<span class="control-icon">−</span>
							</button>
							<button
								class="control-btn control-maximize"
								onclick={toggleMaximize}
								title="Maximize"
							>
								<span class="control-icon">□</span>
							</button>
							<button class="control-btn control-close" onclick={closeWindow} title="Close">
								<span class="control-icon">×</span>
							</button>
						</div>
					{/if}
				</header>

				<!-- Main Content -->
				<main class="content-area">
					{@render children()}
				</main>
			</div>
		</div>

		<!-- App-level dialogs driven by the Archifiltre menu -->
		<AboutDialog />
	</div>
</div>

<!-- Fixed background jobs panel (bottom-right, only when scan is complete) -->
<BackgroundJobsPanel />

<style>
	.app-layout {
		display: flex;
		flex: 1;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}

	.main-content-wrapper {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background-color: var(--background);
		border-radius: 0 var(--window-radius) var(--window-radius) 0;
	}

	.content-area {
		flex: 1;
		overflow: auto;
		background-color: var(--background);
	}

	/* ================================
	   Sidebar Toggle Button (in titlebar)
	   ================================ */

	.sidebar-toggle-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		/* Trim the left padding so the logo sits closer to the ☰ (the right stays for the
		   scan-name). The titlebar's 8px gap alone is the perfect ☰↔Visual spacing. */
		padding: 6px 10px 6px 4px;
		border-radius: 6px;
		background-color: transparent;
		border: none;
		cursor: pointer;
		color: var(--muted-foreground);
		font-size: 13px;
		transition: all 0.15s ease;
	}

	.sidebar-toggle-btn:hover {
		background-color: var(--accent);
		color: var(--foreground);
	}

	.sidebar-toggle-icon {
		position: relative;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.sidebar-toggle-icon :global(.toggle-logo) {
		width: 20px;
		height: auto;
		transition: opacity 0.15s ease;
	}

	.sidebar-toggle-icon :global(.toggle-panel-icon) {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	.sidebar-toggle-btn:hover .sidebar-toggle-icon :global(.toggle-logo) {
		opacity: 0;
	}

	.sidebar-toggle-btn:hover .sidebar-toggle-icon :global(.toggle-panel-icon) {
		opacity: 1;
	}

	.sidebar-toggle-scan-name {
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--foreground);
	}

	/* ================================
	   Titlebar Spacer
	   ================================ */

	.titlebar-spacer {
		flex: 1;
	}

	/* ================================
	   Export Button
	   ================================ */

	:global(.titlebar-export-btn) {
		gap: 6px;
		margin-right: 8px;
	}
</style>
