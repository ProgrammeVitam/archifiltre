<script lang="ts">
	import {
		scans,
		activeScanId,
		scansStore,
		resumeScanningScan,
		type Scan
	} from '$lib/stores';
	import { resumeScan, cancelScan } from '$lib/tauri';
	import {
		Plus as PlusIcon,
		FolderInput as FolderInputIcon,
		Folder as FolderIcon,
		Loader2 as Loader2Icon,
		CheckCircle2 as CheckCircle2Icon,
		AlertCircle as AlertCircleIcon,
		Pause as PauseIcon,
		Play as PlayIcon,
		PanelLeftClose as PanelLeftCloseIcon,
		Trash2 as Trash2Icon
	} from '@lucide/svelte';
	import ArchifiltreLogo from './ArchifiltreLogo.svelte';
	import SettingsDialog from './SettingsDialog.svelte';

	// Props
	let {
		collapsed = $bindable(false),
		isLinux = false,
		class: className = ''
	}: {
		collapsed?: boolean;
		isLinux?: boolean;
		class?: string;
	} = $props();

	function handleNewScan() {
		scansStore.addScan();
	}

	function handleSelectScan(scanId: string) {
		scansStore.setActiveScan(scanId);
	}

	function handleDeleteScan(e: MouseEvent, scan: Scan) {
		e.stopPropagation();

		if (scan.state === 'scanning' || scan.state === 'paused') {
			if (!confirm('A scan is in progress. Closing it will stop the scan. Continue?')) {
				return;
			}
			// Close = cancel: stop the owner's scan so it doesn't keep running in the
			// background (data is kept by the frontier, but this tab is being discarded).
			if (scan.dbName) void cancelScan(scan.dbName);
		} else if (scan.state === 'complete') {
			if (!confirm(`Delete "${scan.name}"? This will also delete the scan database.`)) {
				return;
			}
		}

		scansStore.closeScan(scan.id);
	}

	// Tab status icon doubles as a resume control: hovering the paused ⏸ flips to ▶.
	async function handleResume(e: MouseEvent, scan: Scan) {
		e.stopPropagation(); // don't select the tab
		resumeScanningScan(scan.id);
		if (scan.dbName) {
			try {
				await resumeScan(scan.dbName);
			} catch {
				/* progress will reconcile */
			}
		}
	}

	function toggleCollapsed() {
		collapsed = !collapsed;
	}

	function getStateIcon(state: Scan['state']) {
		switch (state) {
			case 'scanning':
				return Loader2Icon;
			case 'paused':
				return PauseIcon;
			case 'complete':
				return CheckCircle2Icon;
			case 'error':
				return AlertCircleIcon;
			default:
				return FolderInputIcon;
		}
	}

	function getStateClass(state: Scan['state']) {
		switch (state) {
			case 'scanning':
				return 'text-blue-500';
			case 'paused':
				return 'text-amber-500';
			case 'complete':
				return 'text-green-500';
			case 'error':
				return 'text-red-500';
			default:
				return 'text-muted-foreground';
		}
	}

	function getStateIconClass(state: Scan['state']) {
		if (state === 'scanning') {
			return 'animate-spin';
		}
		return '';
	}

	// Computed values
	let scansWithPath = $derived($scans.filter((s) => s.path));
</script>

<!-- Sidebar panel -->
<aside class="sidebar {className}" class:collapsed class:sidebar-linux={isLinux}>
	<!-- Sidebar Header -->
	<div class="sidebar-header">
		<div class="sidebar-logo" class:logo-hidden={collapsed}>
			<ArchifiltreLogo size={20} />
			<span class="sidebar-logo-text">Archifiltre</span>
			<span class="sidebar-version">v5</span>
		</div>
		<div class="flex items-center gap-0.5">
			<SettingsDialog />
			<button class="toggle-btn" onclick={toggleCollapsed} title="Close sidebar (Ctrl+B)">
				<PanelLeftCloseIcon size={18} />
			</button>
		</div>
	</div>

	<!-- Scans Section Header -->
	<div class="scans-header">
		<span class="sidebar-section-title">Scans</span>
	</div>
	<div class="scans-list">
		{#if scansWithPath.length === 0}
			<div class="empty-state">
				<FolderIcon size={32} strokeWidth={1} />
				<span class="empty-state-text">No scans yet</span>
			</div>
		{/if}
		{#each scansWithPath as scan (scan.id)}
			{@const Icon = getStateIcon(scan.state)}
			{@const stateClass = getStateClass(scan.state)}
			{@const iconClass = getStateIconClass(scan.state)}
			<div
				class="scan-item"
				class:active={scan.id === $activeScanId}
				onclick={() => handleSelectScan(scan.id)}
				onkeydown={(e) => e.key === 'Enter' && handleSelectScan(scan.id)}
				role="button"
				tabindex="0"
				title={scan.path ?? scan.name}
			>
				{#if scan.state === 'paused'}
					<button
						class="scan-icon resume-icon {stateClass}"
						onclick={(e) => handleResume(e, scan)}
						title="Continue scan"
					>
						<PauseIcon size={16} class="paused-glyph" />
						<PlayIcon size={16} class="resume-glyph" />
					</button>
				{:else}
					<span class="scan-icon {stateClass}">
						<Icon size={16} class={iconClass} />
					</span>
				{/if}
				<span class="scan-name">{scan.name}</span>
				<button class="delete-btn" onclick={(e) => handleDeleteScan(e, scan)} title="Delete scan">
					<Trash2Icon size={14} />
				</button>
			</div>
		{/each}
	</div>

	<!-- Sidebar Footer -->
	<div class="sidebar-footer">
		<button class="new-scan-btn" onclick={handleNewScan} title="New scan (Ctrl+N)">
			<PlusIcon size={18} />
			<span>New Scan</span>
		</button>
	</div>
</aside>

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		width: 260px;
		min-width: 260px;
		align-self: stretch;
		background-color: var(--sidebar);
		border-right: 1px solid var(--border);
		box-shadow: 4px 0 12px rgba(0, 0, 0, 0.08);
		transition:
			transform 0.2s ease,
			margin-left 0.2s ease,
			border-color 0.2s ease;
		overflow: hidden;
	}

	.sidebar.sidebar-linux {
		border-radius: var(--window-radius) 0 0 var(--window-radius);
	}

	.sidebar.sidebar-linux.collapsed {
		border-radius: 0;
	}

	.sidebar.collapsed {
		margin-left: -260px;
		border-right-color: transparent;
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px;
		min-height: 48px;
	}

	.sidebar-logo {
		display: flex;
		align-items: center;
		gap: 8px;
		opacity: 1;
		transform: translateX(0);
		transition:
			opacity 0.15s ease,
			transform 0.2s ease;
	}

	/* Logo slides out to the left when sidebar collapses */
	.sidebar-logo.logo-hidden {
		opacity: 0;
		transform: translateX(-20px);
	}

	.sidebar-logo-text {
		font-size: 15px;
		font-weight: 600;
		color: var(--foreground);
	}

	.sidebar-version {
		font-size: 11px;
		font-weight: 500;
		color: var(--muted-foreground);
		padding: 2px 6px;
		background-color: rgba(255, 255, 255, 0.9);
		border-radius: 4px;
	}

	:global(.dark) .sidebar-version {
		background-color: rgba(0, 0, 0, 0.5);
	}

	.scans-header {
		display: flex;
		align-items: center;
		padding: 8px 12px;
	}

	.sidebar-section-title {
		font-size: 12px;
		font-weight: 500;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.toggle-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		background-color: transparent;
		border: none;
		cursor: pointer;
		color: var(--muted-foreground);
		transition: all 0.15s ease;
	}

	.toggle-btn:hover {
		background-color: var(--accent);
		color: var(--foreground);
	}

	.new-scan-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		padding: 10px 12px;
		border-radius: 8px;
		background-color: var(--primary);
		color: var(--primary-foreground);
		border: none;
		cursor: pointer;
		font-size: 13px;
		font-weight: 500;
		transition: all 0.15s ease;
	}

	.new-scan-btn:hover {
		opacity: 0.9;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		flex: 1;
		padding-top: 40px;
		color: var(--muted-foreground);
		opacity: 0.4;
	}

	.empty-state-text {
		font-size: 13px;
	}

	.scans-list {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
	}

	.scan-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.15s ease;
		margin-bottom: 4px;
	}

	.scan-item:hover {
		background-color: var(--background);
	}

	.scan-item.active {
		background-color: var(--background);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
	}

	.scan-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	/* Paused tab icon = a resume control: ⏸ by default, ▶ on hover. */
	.resume-icon {
		background: transparent;
		border: none;
		padding: 0;
		cursor: pointer;
	}
	.resume-icon :global(.resume-glyph) {
		display: none;
	}
	.resume-icon:hover :global(.paused-glyph) {
		display: none;
	}
	.resume-icon:hover :global(.resume-glyph) {
		display: inline;
	}

	.scan-name {
		flex: 1;
		font-size: 13px;
		color: var(--foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.delete-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 4px;
		background-color: transparent;
		border: none;
		cursor: pointer;
		color: var(--muted-foreground);
		opacity: 0;
		transition: all 0.15s ease;
		flex-shrink: 0;
	}

	.scan-item:hover .delete-btn {
		opacity: 0.6;
	}

	.delete-btn:hover {
		opacity: 1 !important;
		background-color: var(--destructive);
		color: white;
	}

	.sidebar-footer {
		padding: 12px;
	}
</style>
