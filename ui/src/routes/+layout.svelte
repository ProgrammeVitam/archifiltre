<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import {
		platform,
		detectPlatform,
		activeScan,
		hasActiveScans,
		viewMode,
		colorMode,
		type Platform,
		type ViewMode
	} from '$lib/stores';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { ButtonGroup } from '$lib/components/ui/button-group';
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
		Redo2Icon
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

	// Derived state for showing view toggle and export button
	let showViewControls = $derived($activeScan?.state === 'complete');
	// Undo/redo + enrichment apply to a browseable scan — completed OR paused (partial tree).
	let showHistoryControls = $derived(
		$activeScan?.state === 'complete' || $activeScan?.state === 'paused'
	);
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

					<!-- View toggle (Visual/Tree/Flat) — the LEFT "lens" group. -->
					{#if showViewControls}
						<ButtonGroup class="ml-3" data-no-drag>
							<Button
								variant="outline"
								size="sm"
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

					<!-- Spacer to push export and controls to the right -->
					<div class="titlebar-spacer"></div>

					<!-- Undo / redo — head of the right actions cluster (Cmd/Ctrl+Z mirror). -->
					{#if showHistoryControls}
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

					<!-- Icicle colour mode (Visual view only) -->
					{#if showViewControls && $viewMode === 'stalactite'}
						<ButtonGroup class="mr-2" data-no-drag>
							<Button
								variant="outline"
								size="sm"
								class="h-7 text-xs {$colorMode === 'type'
									? 'bg-accent text-accent-foreground'
									: 'text-muted-foreground'}"
								onclick={() => colorMode.set('type')}>Type</Button
							>
							<Button
								variant="outline"
								size="sm"
								class="h-7 text-xs {$colorMode === 'date'
									? 'bg-accent text-accent-foreground'
									: 'text-muted-foreground'}"
								onclick={() => colorMode.set('date')}>Date</Button
							>
						</ButtonGroup>
					{/if}

					<!-- Export dropdown - only shown when scan complete -->
					{#if showViewControls}
						<ExportDropdown />
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
