<script lang="ts">
	// The unified List view (replaces the old Tree + Flat). One data table with a centered
	// control cluster on top: Flat / Group by folders / Group by duplicates · Filter ·
	// collapsible Search. Columns are Name (no header) / Size / Modified, with Size/Modified
	// labels revealed only on hovering their column. Selection drives the shared panel.
	// See project-list-view-ux. Increment 1: Flat + Folders modes, real data, hover-reveal.
	import { untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { queryFiles, queryAllFiles, type TreeData, type FileNode, type DirectoryNode } from '$lib/tauri';
	import { _ } from '$lib/i18n';
	import { fmtBytes, fmtDateShort } from '$lib/format';
	import { selectDirectory, selectFile, selectedItem, listMode, listFilters, listSearch } from '$lib/stores';
	import * as Table from '$lib/components/ui/table';
	import SkeletonList from '$lib/components/SkeletonList.svelte';
	import {
		ChevronDownIcon,
		ChevronRightIcon,
		FolderIcon,
		FileIcon,
		FileVideoIcon,
		FileImageIcon,
		FileTextIcon,
		FileSpreadsheetIcon,
		FileArchiveIcon,
		FileStackIcon,
		SquareIcon,
		SquareCheckIcon,
		SearchAlertIcon
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';

	let { data, class: className = '' }: { data: TreeData | null; class?: string } = $props();

	// Arrangement (flat/folders/dupes), quick-filters and search are driven by the shared
	// header toolbar via these stores; ListView only reads them.
	let mode = $derived($listMode);
	let filters = $derived($listFilters);
	let search = $derived($listSearch);
	let sortCol = $state<'name' | 'size' | 'mtime'>('name');
	let sortDir = $state<'asc' | 'desc'>('asc');
	let hoverCol = $state<'size' | 'mtime' | null>(null);
	let expanded = new SvelteSet<string>();
	// "Group by duplicates" folds each set of same-content files into ONE collapsible group
	// header (keyed by content hash) that unfolds to reveal the individual copies.
	let dupExpanded = new SvelteSet<string>();
	let selection = new SvelteSet<string>();
	// Multi-select: checkboxes are hidden until a selection exists (Ctrl/Shift+click a row,
	// or click the hover-revealed ghost checkbox), then the column slides in. They slide away
	// again the moment the selection is empty. `anchor` is the pivot for Shift+click ranges.
	let showChecks = $derived(selection.size > 0);
	let anchor = $state<string | null>(null);

	// ── data (per-directory file load; windowing is a later increment) ──
	interface Row {
		path: string;
		name: string;
		size: number;
		mtime: number;
		isDir: boolean;
		depth: number;
		alias: string | null;
		enriched: boolean;
		del: boolean;
		/** The scan couldn't fully process this unit (unreadable/too large/timed-out/truncated
		 *  archive). Drives the "Not processed" filter + a subtle row marker. */
		notProcessed: boolean;
		type: string;
		hash: string | null;
		/** Duplicates mode: the true group size (copies of this hash across the whole result),
		 *  so a group split across a page boundary still shows its real count. */
		dupCount?: number;
		/** The source node, passed to the details panel on click (needs the full shape,
		 *  not just a path — passing a bare path is what broke panel selection before). */
		src: FileNode | DirectoryNode;
	}
	// Folders mode loads each directory's direct children LAZILY — the root up front, then a
	// folder's children the first time it's expanded — never the whole tree at once, so it
	// scales to huge scans (the old eager "load every directory" walk did not).
	let filesCache = new SvelteMap<string, FileNode[]>();
	let dirs = $derived(data?.directories ?? []);
	let isLoading = $state(false);

	// Flat / dupes mode is backed by ONE server-sorted, paginated query over ALL files
	// (queryAllFiles), not a per-directory walk. `loadSeq` discards stale responses when the
	// query shape (sort) changes mid-flight.
	let flat = $state<{ files: FileNode[]; total: number; hasMore: boolean }>({
		files: [],
		total: 0,
		hasMore: false
	});
	let loadSeq = 0;
	const PAGE = 500;

	// Reset caches when the underlying scan/tree changes (e.g. switching scan tabs).
	let lastData: TreeData | null = null;
	$effect(() => {
		if (data === lastData) return;
		lastData = data;
		untrack(() => {
			filesCache.clear();
			expanded.clear();
			flat = { files: [], total: 0, hasMore: false };
		});
	});

	// Flat/dupes: (re)load the first page whenever the query shape (mode / sort) changes.
	// The loader runs untracked so its own reads/writes can't re-trigger this effect.
	$effect(() => {
		// Read every query-shape signal explicitly (NOT via a discarded `void [...]`
		// array, whose reads don't reliably register as dependencies) so ANY change —
		// including flat→dupes — re-triggers the first-page load.
		const d = data;
		const m = mode;
		const sc = sortCol;
		const sd = sortDir;
		void sc;
		void sd;
		if (d && (m === 'flat' || m === 'dupes')) untrack(() => void loadFlatFirst());
	});

	// Folders: ensure the root's children are loaded when the tree view is active.
	$effect(() => {
		const d = data;
		const m = mode;
		if (d && m === 'folders') untrack(() => void loadDir(''));
	});

	async function loadFlatFirst() {
		const seq = ++loadSeq;
		isLoading = true;
		flat = { files: [], total: 0, hasMore: false };
		const r = await queryAllFiles(sortCol, sortDir, PAGE, 0, mode === 'dupes');
		if (seq !== loadSeq) return; // superseded by a newer load
		isLoading = false;
		if (r) flat = { files: r.files, total: r.total, hasMore: r.has_more };
	}
	async function loadFlatMore() {
		if (isLoading || !flat.hasMore) return;
		const seq = ++loadSeq;
		isLoading = true;
		const r = await queryAllFiles(sortCol, sortDir, PAGE, flat.files.length, mode === 'dupes');
		if (seq !== loadSeq) return;
		isLoading = false;
		if (r) flat = { files: [...flat.files, ...r.files], total: r.total, hasMore: r.has_more };
	}
	// Infinite scroll: when the scroll position nears the bottom, pull the next page.
	// The 600px pre-fetch margin loads before the user actually hits the end, so it feels
	// continuous. loadFlatMore is a no-op while a load is in flight or nothing's left.
	function onScroll(e: Event) {
		if (mode !== 'flat' && mode !== 'dupes') return;
		if (isLoading || !flat.hasMore) return;
		const el = e.currentTarget as HTMLElement;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 600) void loadFlatMore();
	}
	async function loadDir(p: string) {
		if (filesCache.has(p)) return;
		try {
			const r = await queryFiles(p, 10000);
			filesCache.set(p, (r?.files ?? []).filter((f) => !f.is_directory));
		} catch {
			filesCache.set(p, []);
		}
	}

	function fileType(name: string): string {
		const e = name.split('.').pop()?.toLowerCase() ?? '';
		if (['mp4', 'mov', 'avi', 'mkv'].includes(e)) return 'video';
		if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(e)) return 'image';
		if (['xlsx', 'xls', 'csv'].includes(e)) return 'sheet';
		if (['zip', 'tar', 'gz', '7z', 'rar'].includes(e)) return 'archive';
		if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(e)) return 'doc';
		return 'other';
	}
	const ICON: Record<string, typeof FileIcon> = {
		video: FileVideoIcon, image: FileImageIcon, sheet: FileSpreadsheetIcon,
		archive: FileArchiveIcon, doc: FileTextIcon, other: FileIcon
	};

	function fileRow(f: FileNode, depth: number): Row {
		return {
			path: f.path, name: f.name, size: f.size, mtime: f.mtime, isDir: false, depth,
			alias: f.alias ?? null, enriched: !!(f.alias || f.has_comment || f.has_tag),
			del: !!f.tagged_for_deletion, notProcessed: !!f.not_processed,
			type: fileType(f.name), hash: f.hash ?? null,
			dupCount: f.dup_count, src: f
		};
	}
	function dirRow(d: DirectoryNode, depth: number): Row {
		return {
			path: d.path, name: d.name, size: d.total_size, mtime: 0, isDir: true, depth,
			alias: d.alias ?? null, enriched: !!(d.alias || d.has_comment || d.has_tag),
			del: !!d.tagged_for_deletion, notProcessed: false,
			type: d.is_archive ? 'archive' : 'folder', hash: null, src: d
		};
	}

	// Flat/dupes rows come straight from the server-sorted page(s); we do NOT re-sort them
	// client-side (the DB already ordered them). Filters/search apply to the loaded window.
	let flatRows = $derived.by(() => flat.files.map((f) => fileRow(f, 0)).filter(passFilters));

	function passFilters(r: Row): boolean {
		if (search && !r.path.toLowerCase().includes(search.toLowerCase())) return false;
		if (filters.marked && !r.del) return false;
		if (filters.tagged && !r.enriched) return false;
		if (filters.big && r.size < 1e9) return false;
		if (filters.notProcessed && !r.notProcessed) return false;
		return true;
	}
	function cmp(a: Row, b: Row): number {
		const s = sortDir === 'asc' ? 1 : -1;
		if (sortCol === 'name') return s * (a.alias ?? a.name).localeCompare(b.alias ?? b.name, undefined, { numeric: true });
		if (sortCol === 'size') return s * (a.size - b.size);
		return s * (a.mtime - b.mtime);
	}

	// Rows to render, per mode
	let rows = $derived.by(() => {
		if (mode === 'flat' || mode === 'dupes') {
			return flatRows;
		}
		// folders: hierarchical, only children of expanded dirs; folders-first per level
		const byParent = new Map<string, Row[]>();
		const push = (parent: string, r: Row) => {
			if (!byParent.has(parent)) byParent.set(parent, []);
			byParent.get(parent)!.push(r);
		};
		for (const d of dirs) {
			const parent = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
			push(parent, dirRow(d, parent === '' ? 0 : parent.split('/').length));
		}
		for (const [dirPath, files] of filesCache)
			for (const f of files) push(dirPath, fileRow(f, dirPath === '' ? 0 : dirPath.split('/').length));
		const out: Row[] = [];
		const walk = (parent: string) => {
			const kids = (byParent.get(parent) ?? []).filter(passFilters).sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return cmp(a, b);
			});
			for (const r of kids) {
				out.push(r);
				if (r.isDir && expanded.has(r.path)) walk(r.path);
			}
		};
		walk('');
		return out;
	});

	// A flat render list of tagged items. Flat/folders yield only file rows; "Group by
	// duplicates" yields a collapsible GROUP header per content hash, followed by its member
	// copies when the group is expanded. One list keeps the table body a single loop.
	interface DupGroup {
		kind: 'group';
		key: string;
		hash: string | null;
		size: number;
		count: number;
		name: string;
		wasted: number;
		enriched: boolean;
		del: boolean;
	}
	type Display = DupGroup | { kind: 'file'; key: string; row: Row; member: boolean };
	let displayItems = $derived.by<Display[]>(() => {
		if (mode === 'dupes') {
			// Group by content hash via a Map — so ALL copies of a hash collapse into ONE
			// group regardless of their order in the page (the duplicates query orders them
			// contiguously, but a transient/flat window may not; a position-based grouping
			// would then emit two groups with the same `g:<hash>` key and crash the keyed
			// each block). Files with no hash (unhashed / hashing skipped) never group —
			// each stands alone as a plain file row.
			const byHash = new Map<string, Row[]>();
			const unhashed: Row[] = [];
			for (const r of flatRows) {
				if (!r.hash) { unhashed.push(r); continue; }
				let g = byHash.get(r.hash);
				if (!g) byHash.set(r.hash, (g = []));
				g.push(r);
			}
			const out: Display[] = [];
			for (const [hash, files] of byHash) {
				const size = files[0]?.size ?? 0;
				// True group size from the server (all copies of this hash), independent of how
				// many landed in the loaded window. Falls back to the loaded count if absent.
				const total = files[0]?.dupCount ?? files.length;
				// A group split across a page boundary has fewer rows loaded than its true size.
				// While more pages can still load, HIDE such a partial group (only the tail group
				// can be partial, given the contiguous server ordering) so it never shows a wrong
				// "1×"; it reappears complete once its remaining copies load. Never hide when the
				// window is fully loaded (no more pages) — then loaded == total anyway.
				if (flat.hasMore && files.length < total) continue;
				out.push({
					kind: 'group',
					key: `g:${hash}`,
					hash,
					size,
					count: total,
					name: files[0]?.name ?? '',
					wasted: size * Math.max(0, total - 1),
					enriched: files.some((f) => f.enriched),
					del: files.every((f) => f.del)
				});
				if (dupExpanded.has(hash))
					for (const f of files) out.push({ kind: 'file', key: `m:${f.path}`, row: f, member: true });
			}
			for (const r of unhashed) out.push({ kind: 'file', key: r.path, row: r, member: false });
			return out;
		}
		return rows.map((r) => ({ kind: 'file' as const, key: r.path, row: r, member: false }));
	});
	// The file rows currently visible, in order — used for Shift+click range selection.
	let visibleFileRows = $derived(
		displayItems.filter((d): d is Extract<Display, { kind: 'file' }> => d.kind === 'file').map((d) => d.row)
	);

	function toggleDup(hash: string | null) {
		const h = hash ?? '';
		if (dupExpanded.has(h)) dupExpanded.delete(h);
		else dupExpanded.add(h);
	}

	function ymd(mt: number): string {
		if (!mt) return '';
		const d = new Date(mt * 1000);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}
	function setSort(c: 'name' | 'size' | 'mtime') {
		if (sortCol === c) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		else { sortCol = c; sortDir = 'asc'; }
	}
	function pick(r: Row) {
		if (r.isDir) selectDirectory(r.src as DirectoryNode);
		else selectFile(r.src as FileNode);
	}
	function toggleExp(p: string) {
		if (expanded.has(p)) expanded.delete(p);
		else { expanded.add(p); void loadDir(p); } // lazy-load children on first expand
	}
	function toggleSel(p: string) { selection.has(p) ? selection.delete(p) : selection.add(p); }

	// A row-body click. Modifiers drive multi-select; a plain click collapses back to a single
	// selection (clears the batch) and shows that item in the panel.
	function rowClick(r: Row, e: MouseEvent) {
		if (e.shiftKey && anchor) {
			const paths = visibleFileRows.map((x) => x.path);
			const a = paths.indexOf(anchor);
			const b = paths.indexOf(r.path);
			if (a !== -1 && b !== -1) {
				const [lo, hi] = a < b ? [a, b] : [b, a];
				for (let i = lo; i <= hi; i++) selection.add(paths[i]);
			}
			pick(r);
		} else if (e.ctrlKey || e.metaKey) {
			toggleSel(r.path);
			anchor = r.path;
			pick(r);
		} else {
			selection.clear(); // plain click → single selection, checkboxes slide away
			anchor = r.path;
			pick(r);
		}
	}
	// Click the checkbox (or the hover-revealed ghost one) → toggle batch membership only,
	// without disturbing the panel's single selection.
	function selectToggle(r: Row, e: Event) {
		e.stopPropagation();
		toggleSel(r.path);
		anchor = r.path;
	}
	function colFromEvent(e: MouseEvent) {
		const c = (e.target as HTMLElement).closest('td,th');
		const i = c ? (c as HTMLTableCellElement).cellIndex : -1;
		// Name is column 0 now (checkbox lives inside it), so Size = 1, Modified = 2.
		hoverCol = i === 1 ? 'size' : i === 2 ? 'mtime' : null;
	}
</script>

<div class="flex h-full flex-col {className}">
	<!-- table (arrangement / filters / search come from the shared header toolbar) -->
	<div class="min-h-0 flex-1 overflow-auto" role="table" onscroll={onScroll} onmouseover={colFromEvent} onmouseleave={() => (hoverCol = null)}>
		{#if isLoading && rows.length === 0}
			<SkeletonList />
		{:else if rows.length === 0}
			<div class="flex h-40 items-center justify-center text-sm text-muted-foreground">{$_('details.noFiles')}</div>
		{:else}
			<Table.Root>
				<Table.Header class="sticky top-0 z-10 bg-background">
					<Table.Row class="border-b hover:bg-transparent">
						<Table.Head class="h-6 cursor-pointer py-0 text-xs" onclick={() => setSort('name')}></Table.Head>
						<Table.Head class="h-6 w-24 cursor-pointer py-0 text-right text-xs" onclick={() => setSort('size')}><span class="transition-opacity {hoverCol === 'size' ? 'opacity-70' : 'opacity-0'}">{mode === 'dupes' ? $_('details.sizeEach') : $_('details.size')} {sortCol === 'size' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span></Table.Head>
						<Table.Head class="h-6 w-28 cursor-pointer py-0 text-xs" onclick={() => setSort('mtime')}><span class="transition-opacity {hoverCol === 'mtime' ? 'opacity-70' : 'opacity-0'}">{mode === 'dupes' ? $_('details.reclaimable') : $_('details.modified')} {mode !== 'dupes' && sortCol === 'mtime' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each displayItems as item (item.key)}
						{#if item.kind === 'group'}
							<!-- Duplicate-group header: a fold-out row. The size column shows the size of
							     ONE copy; the modified column shows the reclaimable (wasted) bytes. -->
							<Table.Row
								class="group cursor-pointer bg-muted/40 hover:bg-muted"
								onclick={() => toggleDup(item.hash)}
							>
								<Table.Cell class="py-1.5">
									<div class="flex min-w-0 items-center gap-1.5">
										<button class="text-muted-foreground" aria-label="Toggle group" onclick={(e) => { e.stopPropagation(); toggleDup(item.hash); }}>
											{#if dupExpanded.has(item.hash ?? '')}<ChevronDownIcon class="size-3.5" />{:else}<ChevronRightIcon class="size-3.5" />{/if}
										</button>
										<FileStackIcon class="size-4 shrink-0 text-amber-500" />
										<span class="truncate font-medium {item.del ? 'text-muted-foreground line-through' : ''}">{item.name}</span>
										<span class="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-600 tabular-nums">×{item.count}</span>
										{#if item.enriched}<span class="size-1.5 shrink-0 rounded-full bg-blue-500" title="enriched"></span>{/if}
									</div>
								</Table.Cell>
								<Table.Cell class="w-24 py-1.5 text-right tabular-nums">{$fmtBytes(item.size)}</Table.Cell>
								<Table.Cell class="w-28 py-1.5 text-xs tabular-nums text-muted-foreground" title={$_('details.reclaimableSpace')}>+{$fmtBytes(item.wasted)}</Table.Cell>
							</Table.Row>
						{:else}
							{@const r = item.row}
							<Table.Row
								class="group cursor-pointer {selection.has(r.path) || $selectedItem?.path === r.path ? 'bg-accent' : ''}"
								onclick={(e) => rowClick(r, e)}
							>
								<Table.Cell class="py-1.5">
									<div class="flex items-center gap-1.5">
										<!-- Multi-select checkbox: width 0 until a selection exists, then it slides in
										     for every row (and slides back out when the selection empties). -->
										<div class="shrink-0 overflow-hidden transition-all duration-200 ease-out {showChecks ? 'w-5 opacity-100' : 'w-0 opacity-0'}">
											<button
												class="grid size-5 place-items-center text-muted-foreground hover:text-foreground"
												tabindex={showChecks ? 0 : -1}
												aria-label="Select {r.name}"
												onclick={(e) => selectToggle(r, e)}
											>
												{#if selection.has(r.path)}<SquareCheckIcon class="size-4 text-primary" />{:else}<SquareIcon class="size-4" />{/if}
											</button>
										</div>
										<div class="flex min-w-0 items-center gap-1.5" style="padding-left:{(item.member ? 1 : r.depth) * 16}px">
											{#if r.isDir && mode === 'folders'}
												<button class="text-muted-foreground" onclick={(e) => { e.stopPropagation(); toggleExp(r.path); }}>
													{#if expanded.has(r.path)}<ChevronDownIcon class="size-3.5" />{:else}<ChevronRightIcon class="size-3.5" />{/if}
												</button>
											{:else}<span class="w-3.5"></span>{/if}
											<!-- Icon, with a hover-revealed ghost checkbox for discovery (only before a
											     selection exists — once selecting, the slide-in column takes over). -->
											<div class="relative grid size-4 shrink-0 place-items-center">
												<span class="transition-opacity {showChecks ? '' : 'group-hover:opacity-0'}">
													{#if r.isDir && r.type === 'archive'}<FileArchiveIcon class="size-4 text-zinc-500" />
													{:else if r.isDir}<FolderIcon class="size-4 text-amber-500" />
													{:else}{@const I = ICON[r.type]}<I class="size-4 text-muted-foreground" />{/if}
												</span>
												{#if !showChecks}
													<button
														class="absolute inset-0 grid place-items-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-70"
														aria-label="Select {r.name}"
														onclick={(e) => selectToggle(r, e)}
													>
														<SquareIcon class="size-4" />
													</button>
												{/if}
											</div>
											<!-- A duplicate's member row shows its full path (the WHERE of each copy);
											     elsewhere the file/alias name is enough. -->
											<span class="truncate {r.del ? 'text-muted-foreground line-through' : ''} {r.isDir ? 'font-medium' : ''} {item.member ? 'text-muted-foreground' : ''}" title={item.member ? r.path : ''}>{item.member ? r.path : (r.alias ?? r.name)}</span>
											{#if r.enriched}<span class="size-1.5 shrink-0 rounded-full bg-blue-500" title="enriched"></span>{/if}
											{#if r.notProcessed}<Badge variant="outline" class="shrink-0 gap-1 border-amber-500/30 px-1.5 py-0 text-[10px] font-normal text-amber-600" title={$_('skips.title')}><SearchAlertIcon class="size-3" />{$_('toolbar.notProcessed')}</Badge>{/if}
										</div>
									</div>
								</Table.Cell>
								<Table.Cell class="w-24 py-1.5 text-right tabular-nums {r.size > 1e9 ? 'font-medium' : ''}">{$fmtBytes(r.size)}</Table.Cell>
								<Table.Cell class="w-28 py-1.5 tabular-nums text-muted-foreground">{$fmtDateShort(r.mtime)}</Table.Cell>
							</Table.Row>
						{/if}
					{/each}
				</Table.Body>
			</Table.Root>
			{#if (mode === 'flat' || mode === 'dupes') && flat.hasMore}
				<!-- Infinite scroll: onScroll auto-loads the next page as the bottom nears; this
				     is just the in-flight affordance. -->
				<div class="flex justify-center py-3 text-xs text-muted-foreground">
					{isLoading ? $_('details.loading') : ''}
				</div>
			{/if}
		{/if}
	</div>
</div>
