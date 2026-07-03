<script lang="ts">
	// Unclean-shutdown recovery surface. Two roles, both anchored to the active scan:
	//  1. datadirState 'damaged'/'missing' → the scan's data can't be opened → offer
	//     Re-scan (same folder) or Delete.
	//  2. restorePrompt → a durable annotation snapshot survived for a just-(re)scanned
	//     folder → offer to restore the user's work, then report restored/orphaned.
	import { activeScan, scansStore } from '$lib/stores';
	import { restorePrompt, acceptRestore, dismissRestore } from '$lib/scan-recovery';
	import { _ } from '$lib/i18n';
	import { Button } from '$lib/components/ui/button';
	import {
		TriangleAlertIcon,
		HistoryIcon,
		RotateCwIcon,
		Trash2Icon,
		CheckIcon,
		XIcon
	} from '@lucide/svelte';

	let { onRescan, onDelete }: { onRescan: () => void; onDelete: () => void } = $props();

	let scan = $derived($activeScan);
	let damaged = $derived(scan?.datadirState === 'damaged' || scan?.datadirState === 'missing');
	// Only show the restore prompt for the active scan.
	let prompt = $derived($restorePrompt && $restorePrompt.scanId === scan?.id ? $restorePrompt : null);
</script>

{#if damaged}
	<div class="recovery-banner recovery-danger" role="alert">
		<TriangleAlertIcon class="size-4 shrink-0" />
		<div class="min-w-0 flex-1">
			<div class="font-medium">{$_('recovery.damagedTitle')}</div>
			<div class="text-xs opacity-80">{$_('recovery.damagedHint')}</div>
		</div>
		<Button variant="default" size="sm" onclick={onRescan}>
			<RotateCwIcon class="size-3.5" /> {$_('recovery.rescan')}
		</Button>
		<Button variant="outline" size="sm" onclick={onDelete}>
			<Trash2Icon class="size-3.5" /> {$_('recovery.delete')}
		</Button>
	</div>
{:else if prompt}
	<div class="recovery-banner recovery-info" role="status">
		<HistoryIcon class="size-4 shrink-0" />
		{#if prompt.status === 'ask'}
			<div class="min-w-0 flex-1">
				<div class="font-medium">{$_('recovery.restoreTitle')}</div>
				<div class="text-xs opacity-80">
					{$_('recovery.restoreHint', { values: { count: prompt.count } })}
				</div>
			</div>
			<Button variant="default" size="sm" onclick={() => void acceptRestore()}>
				<CheckIcon class="size-3.5" /> {$_('recovery.restore')}
			</Button>
			<Button variant="ghost" size="sm" onclick={dismissRestore}>{$_('recovery.dismiss')}</Button>
		{:else if prompt.status === 'restoring'}
			<div class="min-w-0 flex-1 font-medium">{$_('recovery.restoring')}</div>
		{:else if prompt.status === 'done'}
			<div class="min-w-0 flex-1">
				<div class="font-medium">
					{$_('recovery.restoredCount', { values: { count: prompt.restored ?? 0 } })}
				</div>
				{#if prompt.orphaned && prompt.orphaned.length > 0}
					<div class="text-xs opacity-80">
						{$_('recovery.orphanedCount', { values: { count: prompt.orphaned.length } })}
					</div>
				{/if}
			</div>
			<Button variant="ghost" size="icon" class="size-7" onclick={dismissRestore}>
				<XIcon class="size-3.5" />
			</Button>
		{/if}
	</div>
{/if}

<style>
	.recovery-banner {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin: 0.5rem 1rem 0;
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		border: 1px solid;
		font-size: 0.8125rem;
	}
	.recovery-danger {
		border-color: color-mix(in srgb, var(--destructive) 40%, transparent);
		background: color-mix(in srgb, var(--destructive) 8%, transparent);
		color: var(--destructive);
	}
	.recovery-info {
		border-color: color-mix(in srgb, var(--primary) 35%, transparent);
		background: color-mix(in srgb, var(--primary) 7%, transparent);
		color: var(--foreground);
	}
</style>
