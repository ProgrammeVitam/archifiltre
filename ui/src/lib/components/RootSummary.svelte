<script lang="ts">
	// The whole-scan root overview shown when the root (the whole scan) is selected — during
	// a scan AND after it. Borderless so it blends in: the AI résumé, the metadata, two
	// répartitions (par type / par âge) and a couple of actions (shadcn Item). Scan-aware:
	// the file count climbs live, and size/folders/dates/composition skeleton until the walk
	// finishes (the hashing phase), then fill in — so nothing waits for duplicate detection.
	import { untrack } from 'svelte';
	import {
		selectedItem,
		viewMode,
		listMode,
		activeScan,
		scanPhase,
		isDiscovering
	} from '$lib/stores';
	import { smoothFilesDiscovered } from '$lib/scan-counters';
	import {
		queryDirectoryDescription,
		queryComposition,
		queryDirDateStats,
		exportCsv,
		selectExportPath,
		generateId,
		type DirectoryDescription,
		type DirDateStats,
		type CompositionEntry
	} from '$lib/tauri';
	import { _, locale } from '$lib/i18n';
	import { fmtBytes, fmtNum, fmtDate } from '$lib/format';
	import { getFileType, type FileType } from '$lib/file-types';
	import * as Item from '$lib/components/ui/item';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		PackageOpenIcon,
		HardDriveIcon,
		FilesIcon,
		FolderOpenIcon,
		CalendarIcon,
		LeafIcon,
		DownloadIcon
	} from '@lucide/svelte';

	let { rootName = '' }: { rootName?: string } = $props();

	// The root node is the current selection; its aggregates come straight from it post-scan.
	let root = $derived($selectedItem);

	let aiDescription = $state<DirectoryDescription | null>(null);
	let isLoadingDescription = $state(false);
	let composition = $state<CompositionEntry[] | null>(null);
	let dateStats = $state<DirDateStats | null>(null);

	// ── Scan readiness ──
	// The walk + tree/size rollup finish the moment the hashing (duplicates) phase begins;
	// from then on size, folders, dates and composition are final in the DB. Only the file
	// count climbs live before that (from the streamed scan progress).
	const STRUCTURE_READY_PHASES = ['prefilter', 'hashing', 'duplicate-detection', 'complete'];
	let scanning = $derived($activeScan?.state === 'scanning');
	let structureReady = $derived(!scanning || STRUCTURE_READY_PHASES.includes($scanPhase));
	// Report + duplicate review need the fully finished scan (hashes computed). A paused or
	// still-running scan has no redundancy data, so both actions stay disabled until complete.
	let reportReady = $derived($activeScan?.state === 'complete');
	// size/folder/date aggregates are known: instantly from the root node post-scan; from the
	// DB aggregate (dateStats) once the structure is ready mid-scan; skeleton until then.
	let statsReady = $derived(!scanning || (structureReady && dateStats != null));
	let sizeBytes = $derived(dateStats?.size ?? root?.size ?? 0);
	let folderCount = $derived(dateStats?.dirCount ?? root?.dirCount ?? 0);
	// The file count is the one figure that grows during the walk, so show it live throughout.
	// Live count via the smoothed odometer (scan-counters.ts) — ticks every frame instead
	// of jumping per 500-file progress event.
	let fileCount = $derived(scanning ? $smoothFilesDiscovered : (root?.fileCount ?? dateStats?.fileCount ?? 0));
	// Files inside archives (canonical sub-count of files), for the "· N inside archives"
	// note. From the live scan counts; persists through the session.
	let archiveEntries = $derived($activeScan?.scanResult.archiveEntries ?? 0);
	let compReady = $derived(!scanning ? composition != null : structureReady && composition != null);

	// The AI summary loads early — during a scan the describe extension falls back to a live
	// filesystem listing, so a real résumé appears from the start. Reload on db change.
	$effect(() => {
		const db = $activeScan?.dbName;
		void db;
		untrack(() => void loadDescription());
	});
	async function loadDescription() {
		isLoadingDescription = true;
		aiDescription = await queryDirectoryDescription('');
		isLoadingDescription = false;
	}

	// Size/counts/dates/composition need a fully-ingested DB — (re)load once the structure is
	// ready (walk done → hashing), and again if the db changes. Keyed so hashing's steady
	// "ready" state doesn't refetch on every progress tick.
	let loadedAggKey = '';
	$effect(() => {
		const db = $activeScan?.dbName ?? '';
		const ready = structureReady;
		const key = `${db}:${ready}`;
		if (ready && key !== loadedAggKey) {
			loadedAggKey = key;
			untrack(() => void loadAggregates());
		}
	});
	async function loadAggregates() {
		const [c, s] = await Promise.all([queryComposition(''), queryDirDateStats('')]);
		composition = c;
		dateStats = s;
	}

	// Aggregate the extension breakdown into file-type segments, by size (same colours as
	// the chart, via the --color-type-* CSS variables).
	let typeBreakdown = $derived.by(() => {
		if (!composition || composition.length === 0) return [] as { type: FileType; pct: number }[];
		const byType = new Map<FileType, number>();
		let total = 0;
		for (const e of composition) {
			const t = getFileType(`f.${e.ext ?? ''}`);
			byType.set(t, (byType.get(t) ?? 0) + e.size);
			total += e.size;
		}
		return [...byType.entries()]
			.map(([type, size]) => ({ type, pct: total > 0 ? (size / total) * 100 : 0 }))
			.filter((s) => s.pct >= 0.5)
			.sort((a, b) => b.pct - a.pct);
	});

	// Age répartition (cold / warm / active) from the date-stats buckets.
	let ageBreakdown = $derived.by(() => {
		const b = dateStats?.buckets;
		if (!b) return [] as { key: string; pct: number; color: string }[];
		const total = b.cold + b.warm + b.active;
		if (total === 0) return [];
		return [
			{ key: 'cold', pct: (b.cold / total) * 100, color: '#94a3b8' },
			{ key: 'warm', pct: (b.warm / total) * 100, color: '#60a5fa' },
			{ key: 'active', pct: (b.active / total) * 100, color: '#34d399' }
		];
	});

	function formatCO2(bytes: number, loc: string): string {
		const grams = (bytes / 1024 ** 3) * 11.6;
		const n = (v: number) =>
			new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
		if (grams >= 1000) return `${n(grams / 1000)} kg CO₂eq/${$_('root.perYear')}`;
		if (grams < 0.01) return `${n(grams * 1000)} mg CO₂eq/${$_('root.perYear')}`;
		return `${n(grams)} g CO₂eq/${$_('root.perYear')}`;
	}

	// ── Actions ── (both need the finished scan: the report reads the settled DB, and the
	// duplicate review needs the hashing phase to have produced groups — disabled mid-scan.)
	async function downloadReport() {
		const scan = $activeScan;
		if (!scan) return;
		const outputPath = await selectExportPath('rapport-audit', 'docx', 'Word');
		if (!outputPath) return;
		exportCsv({ outputPath, jobId: generateId(), dbName: scan.dbName, format: 'docx' });
	}
	function reviewDuplicates() {
		viewMode.set('flat');
		listMode.set('dupes');
	}
</script>

<div
	class="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-t-2xl border border-b-0 border-border bg-background px-6 pt-5 pb-6"
>
	<!-- Breadcrumb -->
	<Breadcrumb.Root class="mb-4">
		<Breadcrumb.List class="justify-center">
			<Breadcrumb.Item>
				<Breadcrumb.Page class="flex items-center gap-1.5 font-medium text-foreground">
					<PackageOpenIcon class="size-4 text-amber-500" />
					{rootName || root?.name || $_('common.appName')}
				</Breadcrumb.Page>
			</Breadcrumb.Item>
		</Breadcrumb.List>
	</Breadcrumb.Root>

	<!-- Résumé — centré et contenu à une largeur de prose (mx-auto) -->
	{#if aiDescription?.description}
		<div class="mx-auto max-w-prose text-center">
			<p class="text-base leading-relaxed text-foreground">{aiDescription.description}</p>
			{#if aiDescription.model}
				<p class="mt-2 text-xs text-muted-foreground/60">
					{$_('root.summarizedBy')}
					{aiDescription.model}{aiDescription.cached ? ' · ' + $_('details.cached') : ''}
				</p>
			{/if}
		</div>
	{:else if aiDescription?.error}
		<p class="mx-auto max-w-prose text-center text-sm italic text-muted-foreground/60">
			{aiDescription.error}
		</p>
	{:else if isLoadingDescription}
		<div class="mx-auto flex max-w-prose flex-col items-center gap-2">
			<Skeleton class="h-4 w-[92%]" />
			<Skeleton class="h-4 w-full" />
			<Skeleton class="h-4 w-[85%]" />
		</div>
	{/if}

	<!-- Métadonnées — grille à deux colonnes (label ↔ valeur par ligne) -->
	<div class="mt-8 grid grid-cols-2 gap-x-10 gap-y-3 text-sm">
		<div class="flex items-center justify-between gap-4">
			<span class="flex items-center gap-2 text-muted-foreground">
				<HardDriveIcon class="size-3.5" />{$_('details.size')}
			</span>
			{#if statsReady}
				<span class="font-medium tabular-nums text-foreground">{$fmtBytes(sizeBytes)}</span>
			{:else}
				<Skeleton class="h-4 w-20" />
			{/if}
		</div>
		<div class="flex items-center justify-between gap-4">
			<span class="flex items-center gap-2 text-muted-foreground">
				<LeafIcon class="size-3.5" />{$_('details.co2')}
			</span>
			{#if statsReady}
				<span class="font-medium tabular-nums text-foreground">
					{formatCO2(sizeBytes, $locale ?? 'en')}
				</span>
			{:else}
				<Skeleton class="h-4 w-24" />
			{/if}
		</div>
		<div class="flex items-center justify-between gap-4">
			<span class="flex items-center gap-2 text-muted-foreground">
				<FilesIcon class="size-3.5" />{$_('details.files')}
			</span>
			<!-- Live throughout the scan; pulses while still discovering. Files include
			     archive entries (canonical); the sub-note breaks out how many are inside
			     archives when there are any. -->
			<span class="flex items-baseline gap-1.5">
				{#if archiveEntries > 0}
					<span class="text-[11px] text-muted-foreground">· {$fmtNum(archiveEntries)} {$_('details.inArchives')}</span>
				{/if}
				<span class="font-medium tabular-nums text-foreground" class:animate-pulse={$isDiscovering}>
					{$fmtNum(fileCount)}
				</span>
			</span>
		</div>
		<div class="flex items-center justify-between gap-4">
			<span class="flex items-center gap-2 text-muted-foreground">
				<FolderOpenIcon class="size-3.5" />{$_('details.folders')}
			</span>
			{#if statsReady}
				<span class="font-medium tabular-nums text-foreground">{$fmtNum(folderCount)}</span>
			{:else}
				<Skeleton class="h-4 w-16" />
			{/if}
		</div>
		{#if dateStats?.min}
			<div class="flex items-center justify-between gap-4">
				<span class="flex items-center gap-2 text-muted-foreground">
					<CalendarIcon class="size-3.5" />{$_('details.oldestFile')}
				</span>
				<span class="font-medium tabular-nums text-foreground">{$fmtDate(dateStats.min) ?? '—'}</span>
			</div>
			<div class="flex items-center justify-between gap-4">
				<span class="flex items-center gap-2 text-muted-foreground">
					<CalendarIcon class="size-3.5" />{$_('details.newestFile')}
				</span>
				<span class="font-medium tabular-nums text-foreground">{$fmtDate(dateStats.max) ?? '—'}</span>
			</div>
			<div class="flex items-center justify-between gap-4">
				<span class="flex items-center gap-2 text-muted-foreground">
					<CalendarIcon class="size-3.5" />{$_('details.medianDate')}
				</span>
				<span class="font-medium tabular-nums text-foreground">{$fmtDate(dateStats.median) ?? '—'}</span>
			</div>
		{:else if !statsReady}
			{#each ['details.oldestFile', 'details.newestFile', 'details.medianDate'] as label (label)}
				<div class="flex items-center justify-between gap-4">
					<span class="flex items-center gap-2 text-muted-foreground">
						<CalendarIcon class="size-3.5" />{$_(label)}
					</span>
					<Skeleton class="h-4 w-32" />
				</div>
			{/each}
		{/if}
	</div>

	<!-- Deux répartitions — par type / par âge (skeleton tant que la structure n'est pas prête) -->
	{#if scanning || typeBreakdown.length > 0 || ageBreakdown.length > 0}
		<div class="mt-8 grid gap-10" style="grid-template-columns: 1fr 1fr">
			<!-- Par type -->
			<div>
				<div class="mb-2 text-sm font-medium text-muted-foreground">{$_('root.byType')}</div>
				{#if compReady}
					{#if typeBreakdown.length > 0}
						<div class="flex h-3.5 w-full overflow-hidden rounded-full">
							{#each typeBreakdown as s (s.type)}<div
									style="width:{s.pct}%; background: var(--color-type-{s.type})"
								></div>{/each}
						</div>
						<div class="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
							{#each typeBreakdown as s (s.type)}
								<span class="flex items-center gap-2"
									><span class="size-2.5 rounded-sm" style="background: var(--color-type-{s.type})"
									></span>{$_('fileType.' + s.type)}<span class="ml-auto tabular-nums text-foreground"
										>{Math.round(s.pct)}%</span
									></span
								>
							{/each}
						</div>
					{/if}
				{:else}
					<Skeleton class="h-3.5 w-full rounded-full" />
					<div class="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
						{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-3 w-20" />{/each}
					</div>
				{/if}
			</div>
			<!-- Par âge -->
			<div>
				<div class="mb-2 text-sm font-medium text-muted-foreground">{$_('root.byAge')}</div>
				{#if statsReady}
					{#if ageBreakdown.length > 0}
						<div class="flex h-3.5 w-full overflow-hidden rounded-full">
							{#each ageBreakdown as a (a.key)}<div
									style="width:{a.pct}%; background:{a.color}"
								></div>{/each}
						</div>
						<div class="mt-3 flex flex-col gap-1.5 text-sm text-muted-foreground">
							{#each ageBreakdown as a (a.key)}
								<span class="flex items-center gap-2"
									><span class="size-2.5 rounded-sm" style="background:{a.color}"></span>{$_(
										'root.age' + a.key.charAt(0).toUpperCase() + a.key.slice(1)
									)}<span class="ml-auto tabular-nums text-foreground">{Math.round(a.pct)}%</span
									></span
								>
							{/each}
						</div>
					{/if}
				{:else}
					<Skeleton class="h-3.5 w-full rounded-full" />
					<div class="mt-3 flex flex-col gap-1.5">
						{#each [0, 1, 2] as i (i)}<Skeleton class="h-3 w-24" />{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Actions (disabled while scanning: both need the finished scan) -->
	<Separator class="my-8" />
	<div class="mb-3 text-sm font-medium text-muted-foreground">{$_('root.actions')}</div>
	<div class="flex flex-col gap-3">
		<Item.Root variant="muted">
			<Item.Content>
				<Item.Title>{$_('root.reportTitle')}</Item.Title>
				<Item.Description>{$_('root.reportDesc')}</Item.Description>
			</Item.Content>
			<Item.Actions>
				<Button size="sm" class="gap-2" onclick={downloadReport} disabled={!reportReady}>
					<DownloadIcon class="size-4" />{$_('root.download')}
				</Button>
			</Item.Actions>
		</Item.Root>

		<Item.Root variant="muted">
			<Item.Content>
				<Item.Title>{$_('root.duplicatesTitle')}</Item.Title>
				<Item.Description>{$_('root.duplicatesDesc')}</Item.Description>
			</Item.Content>
			<Item.Actions>
				<Button variant="outline" size="sm" onclick={reviewDuplicates} disabled={!reportReady}>
					{$_('root.review')}
				</Button>
			</Item.Actions>
		</Item.Root>
	</div>
</div>
