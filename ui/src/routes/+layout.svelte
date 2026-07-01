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
		type Platform,
		type ViewMode
	} from '$lib/stores';
	import { exportCsv, selectExportPath, generateId } from '$lib/tauri';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { ButtonGroup } from '$lib/components/ui/button-group';
	import * as Menubar from '$lib/components/ui/menubar';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import ArchifiltreLogo from '$lib/components/ArchifiltreLogo.svelte';
	import {
		LoaderCircleIcon,
		CircleCheckIcon,
		CircleAlertIcon,
		PanelLeftIcon,
		LayoutGridIcon,
		FolderTreeIcon,
		ListIcon,
		Undo2Icon,
		Redo2Icon,
		MenuIcon,
		FilePlusIcon,
		DownloadIcon,
		PaletteIcon,
		LogOutIcon
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
	async function exportArchival(format: 'resip' | 'xlsx'): Promise<void> {
		const scan = $activeScan;
		if (!scan) return;
		const [type, ext, filter] =
			format === 'xlsx' ? ['excel', 'xlsx', 'Excel'] : ['resip', 'csv', 'CSV'];
		const outputPath = await selectExportPath(type, ext, filter);
		if (!outputPath) return;
		exportCsv({ outputPath, jobId: generateId(), dbName: scan.dbName, format });
	}

	onMount(() => {
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
	// Viewing + recolouring work on the LIVE partial tree too, so they're enabled DURING a
	// scan — not just when complete. Only duplicate-derived affordances wait for hashing.
	let viewable = $derived($activeScan?.state === 'scanning' || browseable);
</script>

<!-- Window container - padding and shadow only on Linux -->
<div class="window-container" class:window-container-linux={isLinux}>
	<!-- Main app container with rounded corners -->
	<div id="app-window" class="window-frame" class:window-frame-linux={isLinux}>
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

					<!-- Sidebar toggle (when collapsed) - single button with logo, status, and folder name -->
					{#if sidebarCollapsed}
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

					<!-- Left cluster. The ☰ button swaps the "lens" toggle group (Visual/Tree/Flat)
					     for a full File/Edit/View menubar, Zed-style: click to reveal the menubar,
					     move the pointer away (with no menu open) to collapse back to the lenses.
					     Visual is the LIVE lens (usable mid-scan); Tree/Flat need a stable tree. -->
					<div
						class="ml-3 flex items-center gap-1"
						data-no-drag
						onpointerenter={() => (overMenuBar = true)}
						onpointerleave={() => (overMenuBar = false)}
					>
						<Button
							variant="ghost"
							size="icon"
							class="size-7 text-muted-foreground hover:text-accent-foreground {showMenu
								? 'bg-accent text-accent-foreground'
								: ''}"
							onclick={() => (showMenu = !showMenu)}
							title="Menu"
						>
							<MenuIcon size={15} />
						</Button>

						{#if showMenu}
							<Menubar.Root bind:value={openMenu}>
								<Menubar.Menu>
									<Menubar.Trigger>File</Menubar.Trigger>
									<Menubar.Content>
										<Menubar.Item onSelect={() => runMenu(newScan)}>
											<FilePlusIcon /> New scan
											<Menubar.Shortcut>⌘N</Menubar.Shortcut>
										</Menubar.Item>
										<Menubar.Separator />
										<Menubar.Item
											disabled={!browseable}
											onSelect={() => runMenu(() => exportActiveCsv(false))}
										>
											<DownloadIcon /> Export as CSV…
										</Menubar.Item>
										<Menubar.Item
											disabled={!browseable}
											onSelect={() => runMenu(() => exportActiveCsv(true))}
										>
											<DownloadIcon /> Deletion manifest…
										</Menubar.Item>
										<Menubar.Item
											disabled={!browseable}
											onSelect={() => runMenu(() => exportArchival('resip'))}
										>
											<DownloadIcon /> Export RESIP (SEDA)…
										</Menubar.Item>
										<Menubar.Item
											disabled={!browseable}
											onSelect={() => runMenu(() => exportArchival('xlsx'))}
										>
											<DownloadIcon /> Export Excel…
										</Menubar.Item>
										<Menubar.Separator />
										<Menubar.Item onSelect={() => runMenu(closeWindow)}>
											<LogOutIcon /> Quit
										</Menubar.Item>
									</Menubar.Content>
								</Menubar.Menu>

								<Menubar.Menu>
									<Menubar.Trigger>Edit</Menubar.Trigger>
									<Menubar.Content>
										<Menubar.Item
											disabled={!$undoRedoState.canUndo}
											onSelect={() => runMenu(doUndo)}
										>
											<Undo2Icon /> Undo
											<Menubar.Shortcut>⌘Z</Menubar.Shortcut>
										</Menubar.Item>
										<Menubar.Item
											disabled={!$undoRedoState.canRedo}
											onSelect={() => runMenu(doRedo)}
										>
											<Redo2Icon /> Redo
											<Menubar.Shortcut>⇧⌘Z</Menubar.Shortcut>
										</Menubar.Item>
									</Menubar.Content>
								</Menubar.Menu>

								<Menubar.Menu>
									<Menubar.Trigger>View</Menubar.Trigger>
									<Menubar.Content>
										<Menubar.Item
											disabled={!viewable}
											onSelect={() => runMenu(() => setViewMode('stalactite'))}
										>
											<LayoutGridIcon /> Visual
										</Menubar.Item>
										<Menubar.Item
											disabled={!browseable}
											onSelect={() => runMenu(() => setViewMode('tree'))}
										>
											<FolderTreeIcon /> Tree
										</Menubar.Item>
										<Menubar.Item
											disabled={!browseable}
											onSelect={() => runMenu(() => setViewMode('flat'))}
										>
											<ListIcon /> Flat
										</Menubar.Item>
										<Menubar.Separator />
										<Menubar.Item
											disabled={!viewable}
											onSelect={() => runMenu(() => colorMode.set('type'))}
										>
											<PaletteIcon /> Colour by type
										</Menubar.Item>
										<Menubar.Item
											disabled={!viewable}
											onSelect={() => runMenu(() => colorMode.set('date'))}
										>
											<PaletteIcon /> Colour by date
										</Menubar.Item>
										<Menubar.Separator />
										<Menubar.Item onSelect={() => runMenu(() => (sidebarCollapsed = !sidebarCollapsed))}>
											<PanelLeftIcon /> Toggle sidebar
											<Menubar.Shortcut>⌘B</Menubar.Shortcut>
										</Menubar.Item>
									</Menubar.Content>
								</Menubar.Menu>
							</Menubar.Root>
						{:else if hasScan}
							<ButtonGroup data-no-drag>
								<Button
									variant="outline"
									size="sm"
									disabled={!viewable}
									class="h-7 gap-1.5 text-xs {$viewMode === 'stalactite'
										? 'bg-accent text-accent-foreground'
										: 'text-muted-foreground'}"
									onclick={() => setViewMode('stalactite')}
									title="Visual view"
								>
									<LayoutGridIcon size={14} /> Visual
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={!browseable}
									class="h-7 gap-1.5 text-xs {$viewMode === 'tree'
										? 'bg-accent text-accent-foreground'
										: 'text-muted-foreground'}"
									onclick={() => setViewMode('tree')}
									title="Tree view"
								>
									<FolderTreeIcon size={14} /> Tree
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={!browseable}
									class="h-7 gap-1.5 text-xs {$viewMode === 'flat'
										? 'bg-accent text-accent-foreground'
										: 'text-muted-foreground'}"
									onclick={() => setViewMode('flat')}
									title="Flat list"
								>
									<ListIcon size={14} /> Flat
								</Button>
							</ButtonGroup>
						{/if}
					</div>

					<!-- Spacer to push export and controls to the right -->
					<div class="titlebar-spacer"></div>

					<!-- Undo / redo — head of the right actions cluster (Cmd/Ctrl+Z mirror).
					     Present whenever a scan exists; each button enables on can-undo/redo. -->
					{#if hasScan}
						<ButtonGroup class="mr-2" data-no-drag>
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

					<!-- Icicle colour mode (Visual view only). Present whenever the Visual lens
					     is selected; recolours the live icicle, so enabled during a scan too. -->
					{#if hasScan && $viewMode === 'stalactite'}
						<ButtonGroup class="mr-2" data-no-drag>
							<Button
								variant="outline"
								size="sm"
								disabled={!viewable}
								class="h-7 text-xs {$colorMode === 'type'
									? 'bg-accent text-accent-foreground'
									: 'text-muted-foreground'}"
								onclick={() => colorMode.set('type')}>Type</Button
							>
							<Button
								variant="outline"
								size="sm"
								disabled={!viewable}
								class="h-7 text-xs {$colorMode === 'date'
									? 'bg-accent text-accent-foreground'
									: 'text-muted-foreground'}"
								onclick={() => colorMode.set('date')}>Date</Button
							>
						</ButtonGroup>
					{/if}

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
		padding: 6px 10px;
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
