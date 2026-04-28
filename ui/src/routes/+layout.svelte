<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { appState, healthStatus, platform, detectPlatform, type Platform } from '$lib/stores';
	import { Badge } from '$lib/components/ui/badge';
	import { WindowControls } from '@tauri-controls/svelte';

	let { children } = $props();

	let titlebar: HTMLElement;
	let showDevTools = $state(false);
	let devPlatformOverride = $state<Platform | null>(null);

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

	onMount(() => {
		// Dev tools toggle: Ctrl+Shift+P
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.shiftKey && e.key === 'P') {
				e.preventDefault();
				showDevTools = !showDevTools;
			}
		};
		window.addEventListener('keydown', handleKeydown);

		// Async initialization
		(async () => {
			// Detect platform for window controls (workaround for @tauri-controls/svelte bug)
			await detectPlatform();

			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			const appWindow = getCurrentWindow();

			if (titlebar) {
				titlebar.addEventListener('mousedown', async (e) => {
					// Only drag if not clicking on interactive elements
					if ((e.target as HTMLElement).closest('button, a, [data-no-drag]')) {
						return;
					}
					await appWindow.startDragging();
				});

				// Double-click to maximize/restore
				titlebar.addEventListener('dblclick', async () => {
					const isMaximized = await appWindow.isMaximized();
					if (isMaximized) {
						await appWindow.unmaximize();
					} else {
						await appWindow.maximize();
					}
				});
			}
		})();

		return () => {
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	function setDevPlatform(p: Platform | null) {
		devPlatformOverride = p;
	}
</script>

<!-- Window container - padding and shadow only on Linux -->
<div class="window-container" class:window-container-linux={isLinux}>
	<!-- Main app container with rounded corners -->
	<div class="window-frame" class:window-frame-linux={isLinux}>
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

		<!-- Title bar with window controls -->
		<header
			bind:this={titlebar}
			class="titlebar"
			class:titlebar-macos={effectivePlatform === 'macos'}
			class:titlebar-linux={isLinux}
		>
			<!-- macOS: controls on left -->
			{#if effectivePlatform === 'macos'}
				<div data-no-drag class="window-controls">
					<WindowControls platform="macos" class="gap-2" />
				</div>
			{/if}

			<!-- Logo and content -->
			<div class="flex items-center gap-3 px-4">
				<div class="flex items-center gap-2" data-no-drag>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 101 78" class="h-6 w-auto">
						<rect x="0" y="0" width="101" height="25" fill="#FCBF40" />
						<rect x="0" y="27" width="41" height="26" fill="#FCBF40" />
						<rect x="43" y="27" width="14" height="26" fill="#FC5745" />
						<rect x="59" y="27" width="12" height="26" fill="#FCBF40" />
						<rect x="73" y="27" width="10" height="26" fill="#BA77EB" />
						<rect x="85" y="27" width="6" height="26" fill="#477BE2" />
						<rect x="93" y="27" width="5" height="26" fill="#FB4B36" />
						<rect x="100" y="27" width="1" height="26" fill="#3BD041" />
						<rect x="0" y="55" width="19" height="23" fill="#40D145" />
						<rect x="21" y="55" width="12" height="23" fill="#00D8F0" />
						<rect x="35" y="55" width="10" height="23" fill="#FC5745" />
						<rect x="59" y="55" width="12" height="23" fill="#477BE2" />
					</svg>
					<span class="text-lg font-bold text-primary">Archifiltre</span>
				</div>
				<Badge variant="secondary" class="text-xs">v5</Badge>
			</div>

			<!-- Status badges (center area is draggable) -->
			<div class="flex flex-1 items-center justify-center">
				{#if $appState === 'scanning'}
					<Badge variant="outline" class="gap-1.5" data-no-drag>
						<span class="h-2 w-2 animate-pulse rounded-full bg-blue-500"></span>
						Scanning...
					</Badge>
				{:else if $healthStatus === 'unhealthy'}
					<Badge variant="destructive" class="gap-1.5" data-no-drag>
						<span class="h-2 w-2 rounded-full bg-red-500"></span>
						Error
					</Badge>
				{/if}
			</div>

			<!-- Windows/GNOME: controls on right -->
			{#if effectivePlatform && effectivePlatform !== 'macos'}
				<div data-no-drag class="window-controls">
					<WindowControls platform={effectivePlatform} class="gap-2" />
				</div>
			{/if}
		</header>

		<!-- Main Content -->
		<main class="flex-1 overflow-auto pt-8">
			{@render children()}
		</main>
	</div>
</div>
