<script lang="ts">
	import {
		selectedItem,
		hoveredItem,
		tagDictionary,
		addTagToDictionary,
		invalidateEnrichment,
		enrichmentInvalidation,
		reportSaveStatus,
		scanPhase,
		isDiscovering,
		activeScan,
		panelTab,
		aiMode
	} from '$lib/stores';
	import { selectedSummary } from '$lib/llm-describe';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { _, locale } from '$lib/i18n';
	import { fmtBytes, fmtNum, fmtDate } from '$lib/format';
	import {
		queryDirDateStats,
		queryComposition,
		type DirDateStats,
		type CompositionEntry,
		setDeleteTag,
		removeDeleteTag,
		getElementEnrichment,
		setAlias,
		setComment,
		createTag,
		assignTag,
		unassignTag,
		type ElementEnrichment
	} from '$lib/tauri';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { getFileType, type FileType } from '$lib/file-types';
	import {
		XIcon,
		ChevronRightIcon,
		FolderIcon,
		FileIcon,
		FileArchiveIcon,
		FileTextIcon,
		FileCodeIcon,
		FileJsonIcon,
		FileSpreadsheetIcon,
		ImageIcon,
		VideoIcon,
		MusicIcon,
		HardDriveIcon,
		ClockIcon,
		HashIcon,
		ArchiveIcon,
		EyeOffIcon,
		FilesIcon,
		FolderOpenIcon,
		LoaderCircleIcon,
		Trash2Icon,
		LeafIcon,
		CalendarIcon,
		TagIcon,
		MessageSquareTextIcon,
		PencilIcon,
		PlusIcon,
		LayersIcon
	} from '@lucide/svelte';
	import FilePreview from './FilePreview.svelte';
	import RootSummary from './RootSummary.svelte';

	// The folder summary is DRIVEN ELSEWHERE: $lib/llm-describe is the sole describe engine
	// (proactive root + reactive selection, per-target state, host-queued). This panel only
	// renders `$selectedSummary` for the selected sub-folder — no describe call of its own.

	// Directory date stats state
	let dirDateStats: DirDateStats | null = $state(null);
	let isLoadingDateStats = $state(false);
	let lastDateStatsPath: string | null = $state(null);

	// Composition (file-type breakdown) of the displayed subtree.
	let composition = $state<CompositionEntry[] | null>(null);
	let lastCompositionPath: string | null = $state(null);
	// Aggregate the extension breakdown into file-type segments, by size.
	let typeBreakdown = $derived.by(() => {
		if (!composition || composition.length === 0) return { total: 0, segments: [] };
		const byType = new Map<FileType, { size: number; count: number }>();
		let total = 0;
		for (const e of composition) {
			const type = getFileType(`f.${e.ext ?? ''}`);
			const cur = byType.get(type) ?? { size: 0, count: 0 };
			cur.size += e.size;
			cur.count += e.count;
			byType.set(type, cur);
			total += e.size;
		}
		const segments = [...byType.entries()]
			.map(([type, v]) => ({
				type,
				size: v.size,
				count: v.count,
				pct: total > 0 ? (v.size / total) * 100 : 0
			}))
			.sort((a, b) => b.size - a.size);
		return { total, segments };
	});

	// onGoHome (× / root crumb): return to the whole-scan home state.
	// rootName: the scanned folder's display name, always the first breadcrumb.
	let {
		onGoHome,
		onNavigate,
		rootName = ''
	}: {
		onGoHome?: () => void;
		/** Jump to an ancestor folder from the breadcrumb: selects it (updating the panel)
		 *  and, since selection is shared, highlights it on the chart. */
		onNavigate?: (path: string) => void;
		rootName?: string;
	} = $props();

	// Hover-to-preview: the hovered item takes priority so moving the mouse over a
	// block previews it; releasing the hover reverts to the committed selection.
	let displayItem = $derived($hoveredItem ?? $selectedItem);
	let isPreview = $derived(!!$hoveredItem && $hoveredItem.path !== ($selectedItem?.path ?? null));
	// The root / home state (the whole scan) is not a folder: no enrichment, no
	// close button — it IS the close target. (The connector itself is drawn by the
	// chart, behind the blocks; the panel no longer renders it.)
	let isRootSelected = $derived(($selectedItem?.path ?? '') === '');
	// The right column splits into Details/Enrichment tabs ONLY for a real item. The
	// root / whole-scan overview has no enrichment, so it shows metadata alone — no
	// tab bar. (Based on the DISPLAYED item, so hovering a block over the root shows
	// tabs too.)
	let showTabs = $derived(!!displayItem && (displayItem.path ?? '') !== '');
	// The DISPLAYED item is the whole-scan root (path ''). The root always routes to the
	// dedicated borderless RootSummary (which shows the live whole-scan counts, skeletoning
	// what isn't ready). Hovering a block makes displayItem a sub-folder → the item card.
	let isRootDisplayed = $derived(!!displayItem && (displayItem.path ?? '') === '');
	let useRootSummary = $derived(isRootDisplayed);

	// The item card is ONLY ever a sub-folder (the root goes to RootSummary), so its counts
	// are always that folder's OWN aggregates — never the scan-wide figures. size/files/
	// folders come from the folder's DB rollup (dirDateStats, exact, loads at structure-
	// ready) or, during the discovery/ingestion window before that, the live tree node
	// (displayItem, from dir_stats). Both are canonical per-subtree counts (see
	// project-canonical-count-model), so a hovered sub-folder shows a subset ≤ the whole
	// scan, never the scan total.
	// Hover-sweep debounce for the per-folder DB queries (dates + composition), matching the
	// thumbnail preview: no IPC work until the hovered folder is stable.
	const HOVER_QUERY_DEBOUNCE_MS = 180;
	const STRUCTURE_READY_PHASES = ['prefilter', 'hashing', 'duplicate-detection', 'complete'];
	let structureReady = $derived(
		$activeScan?.state !== 'scanning' || STRUCTURE_READY_PHASES.includes($scanPhase)
	);
	let shownSize = $derived(dirDateStats?.size ?? displayItem?.size ?? 0);
	let shownFiles = $derived(dirDateStats?.fileCount ?? displayItem?.fileCount);
	let shownFolders = $derived(dirDateStats?.dirCount ?? displayItem?.dirCount);

	// Per-element enrichment, read on selection (query-on-select). PGlite is the
	// source of truth; this is not a long-lived cache — it is re-read whenever the
	// selection changes. Only the selected item is enriched (hovered previews are
	// not, to avoid query spam).
	let elementEnrichment = $state<ElementEnrichment | null>(null);
	let enrichmentPath = $state<string | null>(null);
	let aliasInput = $state('');
	let commentInput = $state('');
	let tagInput = $state('');

	// Per-field save feedback: 'saved' = brief green border-settle, 'error' = red
	// border + inline message (persists until re-edit). Driven by the DB ack.
	type FieldState = 'idle' | 'saved' | 'error';
	let aliasFieldState = $state<FieldState>('idle');
	let commentFieldState = $state<FieldState>('idle');
	let tagError = $state(false);
	let aliasSettleTimer: ReturnType<typeof setTimeout> | null = null;
	let commentSettleTimer: ReturnType<typeof setTimeout> | null = null;

	function settleSaved(field: 'alias' | 'comment') {
		if (field === 'alias') {
			aliasFieldState = 'saved';
			if (aliasSettleTimer) clearTimeout(aliasSettleTimer);
			aliasSettleTimer = setTimeout(() => (aliasFieldState = 'idle'), 700);
		} else {
			commentFieldState = 'saved';
			if (commentSettleTimer) clearTimeout(commentSettleTimer);
			commentSettleTimer = setTimeout(() => (commentFieldState = 'idle'), 700);
		}
	}

	let isItemTagged = $derived(
		!!elementEnrichment &&
			(elementEnrichment.directlyTaggedForDeletion || elementEnrichment.ancestorTaggedForDeletion)
	);
	let isDirectlyTagged = $derived(!!elementEnrichment && elementEnrichment.directlyTaggedForDeletion);

	// Tags assigned to the selected element, resolved to names via the dictionary.
	let assignedTags = $derived(
		(elementEnrichment?.tagIds ?? [])
			.map((id) => ({ tag_id: id, name: $tagDictionary.get(id) ?? '' }))
			.filter((t) => t.name !== '')
			.sort((a, b) => a.name.localeCompare(b.name))
	);

	// Fetch enrichment when the selected element changes.
	$effect(() => {
		const item = $selectedItem;
		if (item && item.path !== enrichmentPath) {
			enrichmentPath = item.path;
			elementEnrichment = null;
			aliasInput = '';
			commentInput = '';
			tagInput = '';
			aliasFieldState = 'idle';
			commentFieldState = 'idle';
			tagError = false;
			getElementEnrichment(item.path).then((result) => {
				if (enrichmentPath === item.path) {
					elementEnrichment = result;
					aliasInput = result?.alias ?? '';
					commentInput = result?.comment ?? '';
				}
			});
		} else if (!item) {
			enrichmentPath = null;
			elementEnrichment = null;
			aliasInput = '';
			commentInput = '';
			tagInput = '';
		}
	});

	// Re-query the selected element when ANY enrichment changes (undo/redo, or a tag
	// touched elsewhere) so the panel reflects the new state without a selection change.
	$effect(() => {
		if (!$enrichmentInvalidation) return;
		const item = $selectedItem;
		if (!item) return;
		getElementEnrichment(item.path).then((result) => {
			if (($selectedItem?.path ?? null) === item.path) {
				elementEnrichment = result;
				aliasInput = result?.alias ?? '';
				commentInput = result?.comment ?? '';
			}
		});
	});

	// The element's original (real) name, used to detect a no-op alias. Falls back
	// to the item's own name for the root folder (empty path has no last segment).
	let originalName = $derived(
		$selectedItem ? ($selectedItem.path.split('/').filter(Boolean).pop() ?? $selectedItem.name) : ''
	);

	async function commitAlias() {
		const item = $selectedItem;
		if (!item || !elementEnrichment) return;
		// The backend clears the alias when empty or equal to the original name.
		const trimmed = aliasInput.trim();
		const effective = trimmed === '' || trimmed === originalName ? null : trimmed;
		// No-op: unchanged → no write, no flash.
		if (effective === (elementEnrichment.alias ?? null)) {
			aliasFieldState = 'idle';
			return;
		}
		reportSaveStatus('saving', 'alias');
		const ok = await setAlias(item.path, aliasInput);
		if (!ok) {
			aliasInput = elementEnrichment.alias ?? ''; // revert to last-saved
			aliasFieldState = 'error';
			reportSaveStatus('error', 'alias');
			return;
		}
		// Keep pathAliases (used by the breadcrumb) in sync with the edit.
		const pathAliases = { ...elementEnrichment.pathAliases };
		if (effective === null) delete pathAliases[item.path];
		else pathAliases[item.path] = effective;
		elementEnrichment = { ...elementEnrichment, alias: effective, pathAliases };
		aliasInput = effective ?? '';
		invalidateEnrichment(item.path, false);
		settleSaved('alias');
		reportSaveStatus('saved', 'alias');
	}

	async function commitComment() {
		const item = $selectedItem;
		if (!item || !elementEnrichment) return;
		const effective = commentInput.trim() === '' ? null : commentInput;
		if (effective === (elementEnrichment.comment ?? null)) {
			commentFieldState = 'idle';
			return;
		}
		reportSaveStatus('saving', 'comment');
		const ok = await setComment(item.path, commentInput);
		if (!ok) {
			commentInput = elementEnrichment.comment ?? ''; // revert
			commentFieldState = 'error';
			reportSaveStatus('error', 'comment');
			return;
		}
		elementEnrichment = { ...elementEnrichment, comment: effective };
		commentInput = effective ?? '';
		invalidateEnrichment(item.path, false);
		settleSaved('comment');
		reportSaveStatus('saved', 'comment');
	}

	async function submitTag() {
		const item = $selectedItem;
		const name = tagInput.trim();
		if (!item || !elementEnrichment || name === '') return;

		reportSaveStatus('saving', 'tag');
		// Reuse an existing tag of the same name (case-insensitive), else create one.
		const existing = [...$tagDictionary.entries()].find(
			([, n]) => n.toLowerCase() === name.toLowerCase()
		);
		let tagId: string;
		if (existing) {
			tagId = existing[0];
		} else {
			const created = await createTag(name);
			if (!created) {
				tagError = true;
				reportSaveStatus('error', 'tag');
				return;
			}
			addTagToDictionary(created.tag_id, created.name);
			tagId = created.tag_id;
		}

		const ok = await assignTag(tagId, item.path);
		if (!ok) {
			tagError = true;
			reportSaveStatus('error', 'tag');
			return;
		}
		tagError = false;
		if (!elementEnrichment.tagIds.includes(tagId)) {
			elementEnrichment = { ...elementEnrichment, tagIds: [...elementEnrichment.tagIds, tagId] };
		}
		tagInput = '';
		invalidateEnrichment(item.path, false);
		reportSaveStatus('saved', 'tag');
	}

	async function removeTagAssignment(tagId: string) {
		const item = $selectedItem;
		if (!item || !elementEnrichment) return;
		reportSaveStatus('saving', 'tag');
		const ok = await unassignTag(tagId, item.path);
		if (!ok) {
			tagError = true;
			reportSaveStatus('error', 'tag');
			return;
		}
		tagError = false;
		elementEnrichment = {
			...elementEnrichment,
			tagIds: elementEnrichment.tagIds.filter((id) => id !== tagId)
		};
		invalidateEnrichment(item.path, false);
		reportSaveStatus('saved', 'tag');
	}

	// Parse path into breadcrumb segments, displaying the alias for any segment
	// that has one (matching the chart labels and v4). Aliases come from the
	// selected element's enrichment (self + ancestors); only applied when the
	// loaded enrichment matches the displayed item (not a transient hover preview).
	let breadcrumbs = $derived(() => {
		if (!displayItem) return [];
		const aliases =
			enrichmentPath === displayItem.path ? (elementEnrichment?.pathAliases ?? {}) : {};
		// The scanned root is always the first crumb, so you can return home from
		// anywhere; its path is '' (home).
		const crumbs: { display: string; path: string; isRoot: boolean }[] = [
			{ display: rootName || 'Home', path: '', isRoot: true }
		];
		const parts = displayItem.path.split('/').filter(Boolean);
		parts.forEach((segment, i) => {
			const cumulativePath = parts.slice(0, i + 1).join('/');
			crumbs.push({ display: aliases[cumulativePath] ?? segment, path: cumulativePath, isRoot: false });
		});
		return crumbs;
	});

	// Fetch date stats + subtree aggregate (size/counts) for the displayed directory (hover
	// preview included). Skipped while the walk is still ingesting — the aggregate would be
	// partial — and re-fetched the instant the structure is ready (reads `structureReady`, so
	// resetting lastDateStatsPath below makes it fetch fresh at that transition).
	$effect(() => {
		const item = displayItem;
		if (!structureReady) {
			lastDateStatsPath = null;
			dirDateStats = null;
			isLoadingDateStats = false;
			return;
		}
		if (item && item.type === 'directory' && item.path !== lastDateStatsPath) {
			// Debounce like the thumbnail preview: a rapid hover sweep over folders would
			// otherwise fire one IPC query per boundary crossing (same channel as the
			// thumbnail cache). Keep the previous stats on screen until the hovered folder is
			// stable ~180 ms, then query.
			const p = item.path;
			const timer = setTimeout(() => {
				lastDateStatsPath = p;
				isLoadingDateStats = true;
				dirDateStats = null;
				queryDirDateStats(p).then((result) => {
					if (lastDateStatsPath === p) {
						dirDateStats = result;
						isLoadingDateStats = false;
					}
				});
			}, HOVER_QUERY_DEBOUNCE_MS);
			return () => clearTimeout(timer);
		} else if (!item || item.type !== 'directory') {
			dirDateStats = null;
			isLoadingDateStats = false;
			lastDateStatsPath = null;
		}
	});

	// Fetch composition for the displayed directory (hover preview included). Same readiness
	// gate as the date stats: partial mid-walk, fetched once the structure is ready.
	$effect(() => {
		const item = displayItem;
		if (!structureReady) {
			lastCompositionPath = null;
			composition = null;
			return;
		}
		if (item && item.type === 'directory' && item.path !== lastCompositionPath) {
			const p = item.path;
			const timer = setTimeout(() => {
				lastCompositionPath = p;
				composition = null;
				queryComposition(p).then((result) => {
					if (lastCompositionPath === p) composition = result;
				});
			}, HOVER_QUERY_DEBOUNCE_MS);
			return () => clearTimeout(timer);
		} else if (!item || item.type !== 'directory') {
			composition = null;
			lastCompositionPath = null;
		}
	});

	// thumbnailjs handles all file types — native previews for images/pdf/video/svg,
	// graceful fallback icons for everything else
	let supportsPreview = $derived(() => {
		if (!displayItem || displayItem.type === 'directory') return false;
		return true;
	});

	// CO₂ estimate, with the number localized (comma decimal in fr/de) and the "/year" suffix
	// translated (an / year / Jahr) via root.perYear. The unit itself (kg/g/mg CO₂eq) is
	// scientific and stays as-is.
	function formatCO2(bytes: number, loc: string): string {
		const grams = (bytes / 1024 ** 3) * 11.6;
		const per = $_('root.perYear');
		const n = (v: number) => new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
		if (grams >= 1000) return `${n(grams / 1000)} kg CO₂eq/${per}`;
		if (grams < 0.01) return `${n(grams * 1000)} mg CO₂eq/${per}`;
		return `${n(grams)} g CO₂eq/${per}`;
	}

	// Get file extension from name
	function getExtension(name: string): string | null {
		const dotIndex = name.lastIndexOf('.');
		if (dotIndex <= 0) return null;
		return name.slice(dotIndex + 1).toLowerCase();
	}

	// Resolve a Lucide icon component based on file extension
	function getFileTypeIcon(name: string): typeof FileIcon {
		const ext = getExtension(name);
		if (!ext) return FileIcon;

		const map: Record<string, typeof FileIcon> = {
			// Images
			jpg: ImageIcon,
			jpeg: ImageIcon,
			png: ImageIcon,
			gif: ImageIcon,
			svg: ImageIcon,
			webp: ImageIcon,
			bmp: ImageIcon,
			tiff: ImageIcon,
			ico: ImageIcon,
			// Video
			mp4: VideoIcon,
			avi: VideoIcon,
			mov: VideoIcon,
			mkv: VideoIcon,
			webm: VideoIcon,
			flv: VideoIcon,
			wmv: VideoIcon,
			// Audio
			mp3: MusicIcon,
			wav: MusicIcon,
			flac: MusicIcon,
			ogg: MusicIcon,
			aac: MusicIcon,
			wma: MusicIcon,
			m4a: MusicIcon,
			// Documents
			pdf: FileTextIcon,
			doc: FileTextIcon,
			docx: FileTextIcon,
			txt: FileTextIcon,
			rtf: FileTextIcon,
			odt: FileTextIcon,
			md: FileTextIcon,
			// Spreadsheets
			xls: FileSpreadsheetIcon,
			xlsx: FileSpreadsheetIcon,
			csv: FileSpreadsheetIcon,
			ods: FileSpreadsheetIcon,
			tsv: FileSpreadsheetIcon,
			// Code
			js: FileCodeIcon,
			ts: FileCodeIcon,
			py: FileCodeIcon,
			rs: FileCodeIcon,
			java: FileCodeIcon,
			c: FileCodeIcon,
			cpp: FileCodeIcon,
			h: FileCodeIcon,
			html: FileCodeIcon,
			css: FileCodeIcon,
			scss: FileCodeIcon,
			rb: FileCodeIcon,
			go: FileCodeIcon,
			php: FileCodeIcon,
			sh: FileCodeIcon,
			// JSON / Config
			json: FileJsonIcon,
			xml: FileCodeIcon,
			yaml: FileCodeIcon,
			yml: FileCodeIcon,
			toml: FileCodeIcon,
			ini: FileCodeIcon
		};

		return map[ext] ?? FileIcon;
	}

	async function toggleDeleteTag() {
		const item = $selectedItem;
		if (!item || !elementEnrichment) return;

		reportSaveStatus('saving', 'deletion');
		const wasTagged = elementEnrichment.directlyTaggedForDeletion;
		const success = wasTagged ? await removeDeleteTag(item.path) : await setDeleteTag(item.path);
		if (!success) {
			reportSaveStatus('error', 'deletion');
			return;
		}
		// The badge + red band are the positive ack; the status bar mirrors it.
		elementEnrichment = { ...elementEnrichment, directlyTaggedForDeletion: !wasTagged };
		invalidateEnrichment(item.path, true);
		reportSaveStatus('saved', 'deletion');
	}
</script>

{#if displayItem}
	<div class="relative flex min-h-0 flex-1 flex-col px-4" class:opacity-80={isPreview}>
		{#if useRootSummary}
			<!-- Whole-scan overview: an anchored sheet with a defined top edge, docked to the
			     bottom — reads as the root overview, not an item card. -->
			<div class="flex flex-1 flex-col overflow-hidden">
				<RootSummary {rootName} />
			</div>
		{:else}
		<!-- Drawer (the workspace card, a clean golden-ratio share of the height). The
		     connector that ties it to the chart is drawn by the chart, behind the
		     blocks — it's purely graphical and has no claim on this layout. -->
		<!-- A drilled-in item (file or subfolder) gets a generous shadow so it reads as a
		     focused card lifted off the page — clearly distinct from the flat, ambient
		     ROOT overview panel (which keeps just its border). -->
		<div
			class="mb-4 flex flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background transition-shadow duration-200 {showTabs
				? 'shadow-xl'
				: ''}"
		>
			<!-- Breadcrumbs header -->
			<div
				class="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/50 px-4 py-2"
			>
				<div
					class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto text-sm text-muted-foreground"
				>
					{#each breadcrumbs() as crumb, i}
						{#if i > 0}
							<ChevronRightIcon class="h-3 w-3 shrink-0 text-muted-foreground/50" />
						{/if}
						{#if i === breadcrumbs().length - 1}
							<!-- Last segment: icon + name grouped tightly -->
							<span
								class="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
							>
								{#if displayItem.type === 'directory'}
									<FolderIcon class="h-4 w-4 shrink-0" />
								{:else if displayItem.isArchive}
									<FileArchiveIcon class="h-4 w-4 shrink-0" />
								{:else}
									{@const TypeIcon = getFileTypeIcon(displayItem.name)}
									<TypeIcon class="h-4 w-4 shrink-0" />
								{/if}
								{crumb.display}
							</span>
						{:else if crumb.isRoot}
							<!-- Root crumb is always present and always clickable → home. -->
							<button
								type="button"
								onclick={() => onGoHome?.()}
								class="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
								title="Back to the whole scan"
							>
								{crumb.display}
							</button>
						{:else}
							<!-- Intermediate ancestor folder → clickable: select it (panel + chart). -->
							<button
								type="button"
								onclick={() => onNavigate?.(crumb.path)}
								class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
								title={crumb.display}
							>
								{crumb.display}
							</button>
						{/if}
					{/each}
				</div>

				{#if isItemTagged}
					<span
						class="flex shrink-0 items-center gap-1 rounded bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-500"
					>
						<Trash2Icon class="h-3 w-3" />
						Deletion
					</span>
				{/if}

				<!-- Close button → home (the whole-scan state). Hidden on root, since
				     root IS home — there's nowhere further back to go. -->
				{#if $selectedItem && !isRootSelected}
					<Button
						variant="ghost"
						size="sm"
						onclick={() => onGoHome?.()}
						class="-mr-2 shrink-0"
						title="Back to the whole scan"
					>
						<XIcon class="h-4 w-4" />
						<span class="sr-only">Back to the whole scan</span>
					</Button>
				{/if}
			</div>

			<!-- Drawer content - two columns -->
			<div class="flex flex-1 overflow-hidden">
				<!-- Left column -->
				{#if displayItem.type === 'file' && supportsPreview()}
					<!-- File: thumbnail preview -->
					<div class="flex w-1/2 shrink-0">
						<FilePreview path={displayItem.path} class="h-full w-full" />
					</div>
				{:else if displayItem.type === 'directory'}
					<!-- Directory: AI description -->
					<div class="flex w-1/2 shrink-0 flex-col border-r border-border bg-muted/20 p-6">
						{#if isPreview}
							<!-- Hover preview: the summary is load-on-select (no LLM call per hover),
							     so show a hint rather than the selected folder's summary. -->
							<p class="flex-1 text-sm text-muted-foreground/40 italic">
								{$_('details.selectFolderHint')}
							</p>
						{:else if $selectedSummary.streamingText}
							<!-- Tokens streaming in from the on-device model (via the describe engine) -->
							<p class="flex-1 leading-relaxed text-foreground">
								{$selectedSummary.streamingText}<span class="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-foreground/50"></span>
							</p>
						{:else if $selectedSummary.status === 'generating'}
							<div class="flex flex-1 items-center gap-2 text-sm text-muted-foreground">
								<LoaderCircleIcon class="h-4 w-4 animate-spin" />
								<!-- Honest wait states: model loading (one-time), queued behind another
								     summary, or genuinely analyzing. Never an anonymous spinner. -->
								<span>
									{$_(
										$selectedSummary.modelLoading
											? 'details.modelLoading'
											: $selectedSummary.waiting
												? 'details.waitingTurn'
												: 'details.analyzing'
									)}
								</span>
							</div>
						{:else if $selectedSummary.text}
							<div class="flex flex-1 flex-col">
								<p class="leading-relaxed text-foreground">
									{$selectedSummary.text}
								</p>
								{#if $selectedSummary.model}
									<p class="mt-auto pt-4 text-xs text-muted-foreground/60">
										{$_($aiMode === 'external' ? 'details.summarizedExternal' : 'details.summarizedLocally')}
									·
										{$selectedSummary.model}{$selectedSummary.cached ? ' · ' + $_('details.cached') : ''}
									</p>
								{/if}
							</div>
						{:else if $selectedSummary.status === 'error'}
							<p class="text-sm text-muted-foreground/60 italic">{$_('details.summaryUnavailable')}</p>
						{:else}
							<p class="text-sm text-muted-foreground/40 italic">{$_('details.noDescription')}</p>
						{/if}

						<!-- Composition: file-type breakdown of this subtree (same colours as
						     the chart). Shown at every level — the whole scan and any folder.
						     DB-derived → shimmer only while the walk ingests; ready once hashing starts. -->
						{#if !structureReady}
							<div class="mt-5 flex shrink-0 flex-col gap-2 border-t border-border pt-4">
								<div class="flex items-center gap-2 text-sm font-medium text-muted-foreground">
									<FilesIcon class="h-4 w-4" />
									<span>{$_('details.composition')}</span>
								</div>
								<Skeleton class="h-3 w-full rounded-full" />
								<div class="flex flex-wrap gap-x-3 gap-y-1">
									<Skeleton class="h-3 w-16" />
									<Skeleton class="h-3 w-20" />
									<Skeleton class="h-3 w-14" />
								</div>
							</div>
						{:else if typeBreakdown.segments.length > 0}
							<div class="mt-5 flex shrink-0 flex-col gap-2 border-t border-border pt-4">
								<div class="flex items-center gap-2 text-sm font-medium text-muted-foreground">
									<FilesIcon class="h-4 w-4" />
									<span>{$_('details.composition')}</span>
								</div>
								<div class="flex h-3 w-full overflow-hidden rounded-full">
									{#each typeBreakdown.segments as seg (seg.type)}
										<div
											style="width: {seg.pct}%; background: var(--color-type-{seg.type});"
											title="{$_('fileType.' + seg.type)}: {$fmtBytes(seg.size)} · {$fmtNum(
												seg.count
											)}"
										></div>
									{/each}
								</div>
								<div class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
									{#each typeBreakdown.segments as seg (seg.type)}
										<span class="flex items-center gap-1.5">
											<span
												class="h-2.5 w-2.5 shrink-0 rounded-sm"
												style="background: var(--color-type-{seg.type});"
											></span>
											<span class="text-foreground">{$_('fileType.' + seg.type)}</span>
											<span class="text-muted-foreground">{Math.round(seg.pct)}%</span>
										</span>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}

				<!-- Right column: Details / Enrichment tabs. The left column is untouched;
				     only the metadata/enrichment split gets tabs so you needn't scroll the
				     whole panel. The active tab lives in the panelTab store, so it survives
				     re-selection — pick "Enrichment" once and enrich file after file. -->
				<div class="flex min-w-0 flex-1 flex-col overflow-hidden p-6">
					<!-- Details grid, shared by the tabbed (real item) and bare (root) layouts. -->
					{#snippet detailsGrid()}
						<div class="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 text-sm">
							<!-- Size -->
							<div class="flex items-center gap-2 text-muted-foreground">
								<HardDriveIcon class="h-3.5 w-3.5" />
								<span>{$_('details.size')}</span>
							</div>
							<span class="font-medium text-foreground">
								{$fmtBytes(shownSize)}
								{#if displayItem.type === 'file' && displayItem.contentSize != null && displayItem.contentSize !== displayItem.size}
									<span class="ml-1 font-normal text-muted-foreground">
										({$fmtBytes(displayItem.contentSize)} {$_('details.onDisk')})
									</span>
								{/if}
							</span>

							<!-- CO₂ -->
							<div class="flex items-center gap-2 text-muted-foreground">
								<LeafIcon class="h-3.5 w-3.5" />
								<span>{$_('details.co2')}</span>
							</div>
							<span class="font-medium text-foreground">{formatCO2(shownSize, $locale ?? 'en')}</span>

							{#if displayItem.type === 'directory'}
								<!-- File count -->
								<div class="flex items-center gap-2 text-muted-foreground">
									<FilesIcon class="h-3.5 w-3.5" />
									<span>{$_('details.files')}</span>
								</div>
								<!-- The file count is the one figure that climbs live during a scan;
								     pulse it while discovering so it reads as actively changing. -->
								<span class="font-medium text-foreground" class:animate-pulse={$isDiscovering}>
									{$fmtNum(shownFiles ?? 0)}
								</span>

								<!-- Folder count -->
								<div class="flex items-center gap-2 text-muted-foreground">
									<FolderOpenIcon class="h-3.5 w-3.5" />
									<span>{$_('details.folders')}</span>
								</div>
								<span class="font-medium text-foreground">
									{$fmtNum(shownFolders ?? 0)}
								</span>

								<!-- Deepest descendant: how far the structure nests below this
								     folder, and where. Surfaces the "this corner goes deep" signal
								     the icicle can only hint at when zoomed out. From the folder's
								     own tree node (live during a scan). -->
								{#if (displayItem.maxDepth ?? 0) > 0}
									<div class="flex items-center gap-2 text-muted-foreground">
										<LayersIcon class="h-3.5 w-3.5" />
										<span>{$_('details.deepest')}</span>
									</div>
									<span class="font-medium text-foreground" title={displayItem.deepestPath ?? undefined}>
										{displayItem.maxDepth}
										{displayItem.maxDepth === 1 ? $_('details.level') : $_('details.levels')}
										{#if displayItem.deepestPath}
											<span class="font-normal text-muted-foreground"
												>· {displayItem.deepestPath.split('/').pop()}</span
											>
										{/if}
									</span>
								{/if}

								<!-- Date stats. DB-derived → shimmer only while the walk ingests; ready at hashing. -->
								{#if !structureReady}
									{#each ['details.oldestFile', 'details.newestFile', 'details.medianDate'] as label (label)}
										<div class="flex items-center gap-2 text-muted-foreground">
											<CalendarIcon class="h-3.5 w-3.5" />
											<span>{$_(label)}</span>
										</div>
										<Skeleton class="h-4 w-36" />
									{/each}
								{:else if isLoadingDateStats}
									<div class="col-span-2 flex items-center gap-2 text-sm text-muted-foreground">
										<LoaderCircleIcon class="h-3.5 w-3.5 animate-spin" />
										<span>{$_('details.computingDates')}</span>
									</div>
								{:else if dirDateStats && dirDateStats.count > 0}
									<div class="flex items-center gap-2 text-muted-foreground">
										<CalendarIcon class="h-3.5 w-3.5" />
										<span>{$_('details.oldestFile')}</span>
									</div>
									<span class="font-medium text-foreground">{$fmtDate(dirDateStats.min) ?? '—'}</span>

									<div class="flex items-center gap-2 text-muted-foreground">
										<CalendarIcon class="h-3.5 w-3.5" />
										<span>{$_('details.newestFile')}</span>
									</div>
									<span class="font-medium text-foreground">{$fmtDate(dirDateStats.max) ?? '—'}</span>

									<div class="flex items-center gap-2 text-muted-foreground">
										<CalendarIcon class="h-3.5 w-3.5" />
										<span>{$_('details.medianDate')}</span>
									</div>
									<span class="font-medium text-foreground">{$fmtDate(dirDateStats.median) ?? '—'}</span>
								{/if}
							{/if}

							{#if displayItem.type === 'file'}
								<!-- Extension -->
								{@const ext = getExtension(displayItem.name)}
								{#if ext}
									<div class="flex items-center gap-2 text-muted-foreground">
										<FileIcon class="h-3.5 w-3.5" />
										<span>{$_('details.type')}</span>
									</div>
									<span class="font-medium text-foreground uppercase">{ext}</span>
								{/if}

								<!-- Modified date -->
								{@const formattedDate = $fmtDate(displayItem.mtime)}
								{#if formattedDate}
									<div class="flex items-center gap-2 text-muted-foreground">
										<ClockIcon class="h-3.5 w-3.5" />
										<span>{$_('details.modified')}</span>
									</div>
									<span class="font-medium text-foreground">{formattedDate}</span>
								{/if}

								<!-- Hidden -->
								{#if displayItem.isHidden}
									<div class="flex items-center gap-2 text-muted-foreground">
										<EyeOffIcon class="h-3.5 w-3.5" />
										<span>Visibility</span>
									</div>
									<span class="font-medium text-foreground">Hidden</span>
								{/if}

								<!-- Archive format -->
								{#if displayItem.isArchive && displayItem.archiveFormat}
									<div class="flex items-center gap-2 text-muted-foreground">
										<ArchiveIcon class="h-3.5 w-3.5" />
										<span>Archive</span>
									</div>
									<span class="font-medium text-foreground">{displayItem.archiveFormat}</span>
								{/if}

								<!-- Hash -->
								{#if displayItem.hash}
									<div class="flex items-center gap-2 text-muted-foreground">
										<HashIcon class="h-3.5 w-3.5" />
										<span>{$_('details.hash')}</span>
									</div>
									<span
										class="truncate font-mono text-xs font-medium text-foreground"
										title={displayItem.hash}
									>
										{displayItem.hash}
									</span>
								{/if}
							{/if}
						</div>
					{/snippet}

					{#if showTabs}
						<!-- A real item: its own metadata (Details) + user enrichment (Enrichment). -->
						<Tabs.Root bind:value={$panelTab} class="flex min-h-0 flex-1 flex-col gap-3">
							<Tabs.List class="w-full">
								<Tabs.Trigger value="details" class="flex-1">{$_('details.details')}</Tabs.Trigger>
								<Tabs.Trigger value="enrichment" class="flex-1">{$_('details.enrichment')}</Tabs.Trigger>
							</Tabs.List>
							<Tabs.Content value="details" class="mt-0 min-h-0 flex-1 overflow-y-auto">
								{@render detailsGrid()}
							</Tabs.Content>

							<!-- Enrichment: user-authored alias / comment / tags / mark-for-deletion.
							     Editable for a committed selection (not a hover preview). The DB is
							     live-writable mid-scan, so enrichment works during a scan too. -->
							<Tabs.Content value="enrichment" class="mt-0 min-h-0 flex-1 overflow-y-auto">
								{#if $selectedItem && !isRootSelected && !isPreview}
									<div class="flex flex-col gap-4">
										<!-- Alias -->
										<label class="flex flex-col gap-1.5">
											<span class="flex items-center gap-2 text-xs text-muted-foreground">
												<PencilIcon class="h-3.5 w-3.5" />
												Alias
											</span>
											<Input
												type="text"
												bind:value={aliasInput}
												onblur={commitAlias}
												oninput={() => aliasFieldState === 'error' && (aliasFieldState = 'idle')}
												onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
												placeholder={originalName}
												class={aliasFieldState === 'saved'
													? 'border-[var(--color-success)]'
													: aliasFieldState === 'error'
														? 'border-destructive'
														: 'transition-colors duration-700'}
											/>
											{#if aliasFieldState === 'error'}
												<span class="text-xs text-destructive">Couldn't save alias — try again</span>
											{/if}
										</label>

										<!-- Comment -->
										<label class="flex flex-col gap-1.5">
											<span class="flex items-center gap-2 text-xs text-muted-foreground">
												<MessageSquareTextIcon class="h-3.5 w-3.5" />
												Comment
											</span>
											<Textarea
												bind:value={commentInput}
												onblur={commitComment}
												oninput={() => commentFieldState === 'error' && (commentFieldState = 'idle')}
												rows={2}
												placeholder="Add a comment…"
												class={commentFieldState === 'saved'
													? 'border-[var(--color-success)]'
													: commentFieldState === 'error'
														? 'border-destructive'
														: 'transition-colors duration-700'}
											/>
											{#if commentFieldState === 'error'}
												<span class="text-xs text-destructive">Couldn't save comment — try again</span>
											{/if}
										</label>

										<!-- Tags -->
										<div class="flex flex-col gap-1.5">
											<span class="flex items-center gap-2 text-xs text-muted-foreground">
												<TagIcon class="h-3.5 w-3.5" />
												Tags
											</span>
											{#if assignedTags.length > 0}
												<div class="flex flex-wrap gap-1.5">
													{#each assignedTags as tag (tag.tag_id)}
														<Badge variant="secondary" class="gap-1 pr-1">
															{tag.name}
															<button
																type="button"
																onclick={() => removeTagAssignment(tag.tag_id)}
																class="rounded-full text-muted-foreground hover:text-foreground"
																aria-label={`Remove tag ${tag.name}`}
															>
																<XIcon class="h-3 w-3" />
															</button>
														</Badge>
													{/each}
												</div>
											{/if}
											<div class="flex items-center gap-1.5">
												<Input
													type="text"
													bind:value={tagInput}
													oninput={() => tagError && (tagError = false)}
													onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), submitTag())}
													list="tag-suggestions"
													placeholder="Add a tag…"
													class={'flex-1 transition-colors duration-300 ' +
														(tagError ? 'border-destructive' : '')}
												/>
												<datalist id="tag-suggestions">
													{#each [...$tagDictionary.values()] as name}
														<option value={name}></option>
													{/each}
												</datalist>
												<Button
													variant="outline"
													size="sm"
													onclick={submitTag}
													disabled={tagInput.trim() === ''}
													class="shrink-0 gap-1"
												>
													<PlusIcon class="h-3.5 w-3.5" />
													Add
												</Button>
											</div>
											{#if tagError}
												<span class="text-xs text-destructive">Couldn't save tag — try again</span>
											{/if}
										</div>

										<!-- Mark for deletion -->
										<div class="border-t border-border pt-3">
											<Button
												variant={isDirectlyTagged ? 'destructive' : 'outline'}
												size="sm"
												onclick={toggleDeleteTag}
												class="w-full gap-2"
											>
												<Trash2Icon class="h-4 w-4" />
												{#if isDirectlyTagged}
													Unmark for deletion
												{:else}
													Mark for deletion
												{/if}
											</Button>
											{#if isItemTagged && !isDirectlyTagged}
												<p class="mt-2 text-xs text-red-500">
													A parent directory is marked for deletion
												</p>
											{/if}
										</div>
									</div>
								{:else}
									<p class="text-sm text-muted-foreground">
										Select a file or folder to add enrichment.
									</p>
								{/if}
							</Tabs.Content>
						</Tabs.Root>
					{:else}
						<!-- Root / whole-scan overview: metadata only, so no tab bar. -->
						<div class="min-h-0 flex-1 overflow-y-auto">
							{@render detailsGrid()}
						</div>
					{/if}
				</div>
			</div>
		</div>
		{/if}
	</div>
{/if}
