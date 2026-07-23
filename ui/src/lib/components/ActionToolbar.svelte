<script lang="ts">
	// The shared, view-aware action toolbar that lives in the header (one bar for both
	// views, so we don't spend a whole row on it). Visual → Colours / Sort; List →
	// arrangement + Filter + Search. Hidden by the header when the ☰ app menu is open.
	import { viewMode, colorMode, sortMode, listMode, listFilters, listSearch, activeScan } from '$lib/stores';
	import { _ } from '$lib/i18n';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { CheckIcon, ChevronDownIcon, SearchIcon, PaletteIcon, ArrowDownWideNarrowIcon } from '@lucide/svelte';

	// Collapsible search (List view).
	let searchOpen = $state(false);
	let searchInput: HTMLInputElement | undefined = $state();
	function openSearch() {
		searchOpen = true;
		queueMicrotask(() => searchInput?.focus());
	}
	// Duplicate detection (content hashing) only runs when a scan FINISHES, so grouping by
	// duplicates is meaningless on a paused/scanning tab — gate it on completion. If we're
	// already in dupes mode when the scan is no longer complete (e.g. a rescan), fall back
	// to the flat arrangement so the list never sits on an empty, unavailable mode.
	// Duplicate detection (content hashing) only runs when a scan FINISHES, so grouping by
	// duplicates is meaningless on a paused/scanning tab — gate it on completion. If we're
	// already in dupes mode when the scan is no longer complete (e.g. a rescan), fall back
	// to the flat arrangement so the list never sits on an empty, unavailable mode.
	let duplicatesReady = $derived($activeScan?.state === 'complete');
	$effect(() => {
		if (!duplicatesReady && $listMode === 'dupes') listMode.set('flat');
	});

	let filterCount = $derived(Object.values($listFilters).filter(Boolean).length);
	function setFilter(key: 'marked' | 'tagged' | 'big' | 'notProcessed', value: boolean) {
		listFilters.update((f) => ({ ...f, [key]: value }));
	}

	const PILL = 'flex items-center gap-0.5 rounded-lg bg-muted px-1 py-0.5 text-[13px]';
	const ITEM = 'h-7 gap-1.5';
</script>

{#if $viewMode === 'stalactite'}
	<!-- Visual: Colours ▾ · Sort ▾ -->
	<div class={PILL} data-no-drag>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" class="{ITEM} text-muted-foreground">
						<PaletteIcon class="size-3.5" />{$_('toolbar.colours')}<ChevronDownIcon class="size-3.5 opacity-60" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="w-44" align="start">
				<DropdownMenu.CheckboxItem checked={$colorMode === 'type'} onCheckedChange={() => colorMode.set('type')}>
					{$_('toolbar.colourType')}
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem checked={$colorMode === 'date'} onCheckedChange={() => colorMode.set('date')}>
					{$_('toolbar.colourDate')}
				</DropdownMenu.CheckboxItem>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" class="{ITEM} text-muted-foreground">
						<ArrowDownWideNarrowIcon class="size-3.5" />{$_('toolbar.sort')}<ChevronDownIcon class="size-3.5 opacity-60" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="w-44" align="start">
				<DropdownMenu.CheckboxItem checked={$sortMode === 'size'} onCheckedChange={() => sortMode.set('size')}>
					{$_('toolbar.sortSize')}
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem checked={$sortMode === 'name'} onCheckedChange={() => sortMode.set('name')}>
					{$_('toolbar.sortName')}
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem checked={$sortMode === 'date'} onCheckedChange={() => sortMode.set('date')}>
					{$_('toolbar.sortDate')}
				</DropdownMenu.CheckboxItem>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
{:else}
	<!-- List: arrangement · Filter ▾ · Search -->
	<div class={PILL} data-no-drag>
		<Button
			variant="ghost"
			size="sm"
			class="{ITEM} {$listMode === 'flat' ? 'font-medium text-foreground' : 'text-muted-foreground'}"
			onclick={() => listMode.set('flat')}
		>
			{#if $listMode === 'flat'}<CheckIcon class="size-3.5" />{/if}{$_('toolbar.flat')}
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="{ITEM} {$listMode === 'folders' ? 'font-medium text-foreground' : 'text-muted-foreground'}"
			onclick={() => listMode.set('folders')}
		>
			{#if $listMode === 'folders'}<CheckIcon class="size-3.5" />{/if}{$_('toolbar.groupFolders')}
		</Button>
		<Button
			variant="ghost"
			size="sm"
			disabled={!duplicatesReady}
			title={duplicatesReady ? '' : $_('toolbar.duplicatesNeedComplete')}
			class="{ITEM} {$listMode === 'dupes' ? 'font-medium text-foreground' : 'text-muted-foreground'}"
			onclick={() => duplicatesReady && listMode.set('dupes')}
		>
			{#if $listMode === 'dupes'}<CheckIcon class="size-3.5" />{/if}{$_('toolbar.groupDuplicates')}
		</Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" class="{ITEM} text-muted-foreground">
						{$_('toolbar.filter')}{#if filterCount}<span class="rounded-full bg-primary/10 px-1.5 text-[11px] text-primary">{filterCount}</span>{/if}<ChevronDownIcon class="size-3.5 opacity-60" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="w-52" align="start">
				<DropdownMenu.Label class="text-xs text-muted-foreground">{$_('toolbar.showOnly')}</DropdownMenu.Label>
				<DropdownMenu.CheckboxItem checked={$listFilters.marked} onCheckedChange={(v) => setFilter('marked', v)}>
					{$_('toolbar.marked')}
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem checked={$listFilters.tagged} onCheckedChange={(v) => setFilter('tagged', v)}>
					{$_('toolbar.enriched')}
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem checked={$listFilters.big} onCheckedChange={(v) => setFilter('big', v)}>
					{$_('toolbar.large')}
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem checked={$listFilters.notProcessed} onCheckedChange={(v) => setFilter('notProcessed', v)}>
					{$_('toolbar.notProcessed')}
				</DropdownMenu.CheckboxItem>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		{#if searchOpen}
			<div class="relative">
				<SearchIcon class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					bind:this={searchInput}
					bind:value={$listSearch}
					onblur={() => (searchOpen = false)}
					placeholder={$_('toolbar.search')}
					class="h-7 w-56 rounded-md border border-input bg-background pl-7 pr-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
				/>
			</div>
		{:else}
			<Button
				variant="ghost"
				size="sm"
				class="{ITEM} {$listSearch ? 'font-medium text-foreground' : 'text-muted-foreground'}"
				onclick={openSearch}
			>
				<SearchIcon class="size-3.5" />{$listSearch || $_('toolbar.search')}
			</Button>
		{/if}
	</div>
{/if}
