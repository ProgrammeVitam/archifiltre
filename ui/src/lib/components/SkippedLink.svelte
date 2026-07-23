<script lang="ts">
	// The skipped-units ledger as a StatusBar link: clicking filters the list to the
	// not-processed items, hovering shows the reason breakdown.
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { _ } from '$lib/i18n';
	import { fmtNum } from '$lib/format';
	import { listFilters, viewMode } from '$lib/stores';
	import { SearchAlertIcon } from '@lucide/svelte';

	let {
		skipped,
		severe = false
	}: {
		skipped: { total: number; byReason: Record<string, number> };
		severe?: boolean;
	} = $props();

	// Plain, blame-free label per reason class (never a raw error string).
	const REASON_KEY: Record<string, string> = {
		unreadable: 'skips.unreadable',
		timeout: 'skips.timeout',
		unsupported: 'skips.unsupported',
		encrypted: 'skips.encrypted',
		permission: 'skips.permission',
		missing: 'skips.missing',
		'location-unavailable': 'skips.locationUnavailable',
		truncated: 'skips.truncated',
		error: 'skips.error'
	};

	// Most-impactful cause first.
	let rows = $derived(
		Object.entries(skipped.byReason)
			.filter(([, n]) => n > 0)
			.sort((a, b) => b[1] - a[1])
	);

	function showInList() {
		listFilters.update((f) => ({ ...f, notProcessed: true }));
		viewMode.set('flat');
	}
</script>

<Tooltip.Provider delayDuration={150}>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					onclick={showInList}
					aria-label={$_('skips.title')}
					class="inline-flex items-center gap-1 whitespace-nowrap rounded px-1 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring {severe
						? 'text-[var(--color-warning,#d97706)]'
						: 'opacity-70'}"
				>
					<SearchAlertIcon class="h-3 w-3" />
					<span>{$fmtNum(skipped.total)} {$_('status.notProcessed')}</span>
				</button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="top" align="start" class="max-w-xs">
			<div class="space-y-1">
				<p class="font-medium">{$_('skips.title')}</p>
				<ul class="space-y-0.5">
					{#each rows as [reason, n] (reason)}
						<li class="flex items-center justify-between gap-4">
							<span>{$_(REASON_KEY[reason] ?? 'skips.error')}</span>
							<span class="tabular-nums opacity-70">{$fmtNum(n)}</span>
						</li>
					{/each}
				</ul>
				<p class="pt-0.5 text-xs opacity-70">{$_('skips.clickToShow')}</p>
			</div>
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
