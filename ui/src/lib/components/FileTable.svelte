<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { formatBytes, queryFiles, type TreeData, type FileNode } from '$lib/tauri';
	import { selectDirectory, selectFile } from '$lib/stores';
	import SkeletonList from '$lib/components/SkeletonList.svelte';

	// ================================
	// Props
	// ================================

	interface Props {
		data: TreeData | null;
		class?: string;
	}

	let { data, class: className = '' }: Props = $props();

	// ================================
	// Types
	// ================================

	interface TableRow {
		path: string;
		name: string;
		size: number;
		type: 'directory' | 'file';
		parentPath: string;
		isArchive?: boolean;
		archiveFormat?: string | null;
	}

	// ================================
	// State
	// ================================

	let rows: TableRow[] = $state([]);
	let sortColumn: 'name' | 'size' | 'type' | 'path' = $state('name');
	let sortDirection: 'asc' | 'desc' = $state('asc');
	let isLoading = $state(false);

	// Files cache and deduplication
	let filesCache: SvelteMap<string, FileNode[]> = new SvelteMap();
	let loadingFiles: SvelteSet<string> = new SvelteSet();
	let seenPaths: SvelteSet<string> = new SvelteSet();

	// ================================
	// Data Loading
	// ================================

	$effect(() => {
		if (data) {
			loadAllData();
		}
	});

	async function loadAllData() {
		if (!data) return;

		isLoading = true;
		rows = [];
		seenPaths.clear();

		// Load files for root
		await loadFilesForDirectory('');

		// Load files for all directories
		for (const dir of data.directories) {
			await loadFilesForDirectory(dir.path);
		}

		// Build flat table rows (deduplicated)
		buildFlatRows();
		isLoading = false;
	}

	async function loadFilesForDirectory(dirPath: string) {
		if (loadingFiles.has(dirPath) || filesCache.has(dirPath)) {
			return;
		}

		loadingFiles.add(dirPath);

		try {
			const filesData = await queryFiles(dirPath, 10000);
			if (filesData && filesData.files.length > 0) {
				const files = filesData.files.filter((f) => !f.is_directory);
				filesCache.set(dirPath, files);
			} else {
				filesCache.set(dirPath, []);
			}
		} catch (e) {
			console.error('Failed to load files for', dirPath, e);
			filesCache.set(dirPath, []);
		} finally {
			loadingFiles.delete(dirPath);
		}
	}

	function buildFlatRows() {
		if (!data) {
			rows = [];
			return;
		}

		const newRows: TableRow[] = [];
		seenPaths.clear();

		// Add all directories as rows
		for (const dir of data.directories) {
			if (!seenPaths.has(dir.path)) {
				seenPaths.add(dir.path);
				const parentPath = dir.path.includes('/')
					? dir.path.substring(0, dir.path.lastIndexOf('/'))
					: '';
				newRows.push({
					path: dir.path,
					name: dir.name,
					size: dir.total_size,
					type: 'directory',
					parentPath
				});
			}
		}

		// Add all files from cache (deduplicated)
		for (const [dirPath, files] of filesCache) {
			for (const file of files) {
				if (!seenPaths.has(file.path)) {
					seenPaths.add(file.path);
					newRows.push({
						path: file.path,
						name: file.name,
						size: file.size,
						type: 'file',
						parentPath: dirPath,
						isArchive: file.is_archive,
						archiveFormat: file.archive_format
					});
				}
			}
		}

		rows = newRows;
	}

	// ================================
	// Sorting
	// ================================

	function sortRows(column: 'name' | 'size' | 'type' | 'path') {
		if (sortColumn === column) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortColumn = column;
			sortDirection = 'asc';
		}
	}

	let sortedRows = $derived.by(() => {
		const sorted = [...rows];
		sorted.sort((a, b) => {
			let comparison = 0;

			switch (sortColumn) {
				case 'name':
					comparison = a.name.localeCompare(b.name);
					break;
				case 'size':
					comparison = a.size - b.size;
					break;
				case 'type':
					comparison = a.type.localeCompare(b.type);
					break;
				case 'path':
					comparison = a.parentPath.localeCompare(b.parentPath);
					break;
			}

			return sortDirection === 'asc' ? comparison : -comparison;
		});
		return sorted;
	});

	// ================================
	// Helpers
	// ================================

	function getFileIcon(row: TableRow): string {
		if (row.type === 'directory') return '📁';
		if (row.isArchive) return '📦';

		const ext = row.name.includes('.') ? row.name.split('.').pop()?.toLowerCase() : '';
		const iconMap: Record<string, string> = {
			pdf: '📄',
			doc: '📝',
			docx: '📝',
			xls: '📊',
			xlsx: '📊',
			ppt: '📽️',
			pptx: '📽️',
			txt: '📃',
			jpg: '🖼️',
			jpeg: '🖼️',
			png: '🖼️',
			gif: '🖼️',
			svg: '🖼️',
			mp3: '🎵',
			mp4: '🎬',
			zip: '📦',
			tar: '📦',
			gz: '📦',
			'7z': '📦',
			js: '📜',
			ts: '📜',
			py: '🐍',
			rs: '🦀',
			html: '🌐',
			css: '🎨',
			json: '📋'
		};

		return iconMap[ext || ''] || '📄';
	}

	function getSortIndicator(column: 'name' | 'size' | 'type' | 'path'): string {
		if (sortColumn !== column) return '';
		return sortDirection === 'asc' ? ' ↑' : ' ↓';
	}

	function handleRowClick(row: TableRow) {
		if (row.type === 'directory') {
			// Find the directory node in data
			const dirNode = data?.directories.find((d) => d.path === row.path);
			if (dirNode) {
				selectDirectory(dirNode);
			}
		} else {
			// It's a file - find it in the cache
			const files = filesCache.get(row.parentPath) || [];
			const fileNode = files.find((f) => f.path === row.path);
			if (fileNode) {
				selectFile(fileNode);
			} else {
				// Fallback: create a minimal file selection
				selectFile({
					path: row.path,
					name: row.name,
					size: row.size,
					is_archive: row.isArchive,
					archive_format: row.archiveFormat
				});
			}
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden rounded-lg border bg-background {className}">
	{#if isLoading}
		<SkeletonList />
	{:else if rows.length === 0}
		<div class="flex flex-1 items-center justify-center p-10 text-sm text-muted-foreground">
			No files to display
		</div>
	{:else}
		<div class="flex-1 overflow-auto">
			<table class="w-full text-sm">
				<thead class="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
					<tr>
						<th
							class="cursor-pointer px-3 py-2.5 text-left font-semibold text-muted-foreground select-none hover:bg-muted"
							onclick={() => sortRows('name')}
						>
							Name{getSortIndicator('name')}
						</th>
						<th
							class="cursor-pointer px-3 py-2.5 text-left font-semibold text-muted-foreground select-none hover:bg-muted"
							onclick={() => sortRows('path')}
						>
							Location{getSortIndicator('path')}
						</th>
						<th
							class="w-24 cursor-pointer px-3 py-2.5 text-right font-semibold text-muted-foreground select-none hover:bg-muted"
							onclick={() => sortRows('size')}
						>
							Size{getSortIndicator('size')}
						</th>
						<th
							class="w-20 cursor-pointer px-3 py-2.5 text-left font-semibold text-muted-foreground select-none hover:bg-muted"
							onclick={() => sortRows('type')}
						>
							Type{getSortIndicator('type')}
						</th>
					</tr>
				</thead>
				<tbody>
					{#each sortedRows as row (row.path)}
						<tr
							class="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/50"
							class:font-medium={row.type === 'directory'}
							onclick={() => handleRowClick(row)}
							role="button"
							tabindex="0"
							onkeydown={(e) => e.key === 'Enter' && handleRowClick(row)}
						>
							<td class="px-3 py-2">
								<div class="flex items-center gap-1.5">
									<span class="shrink-0">{getFileIcon(row)}</span>
									<span class="truncate" title={row.path}>{row.name}</span>
									{#if row.isArchive && row.archiveFormat}
										<span class="shrink-0 text-xs text-muted-foreground">
											({row.archiveFormat})
										</span>
									{/if}
								</div>
							</td>
							<td class="max-w-xs truncate px-3 py-2 text-muted-foreground" title={row.parentPath}>
								{row.parentPath || '/'}
							</td>
							<td class="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">
								{formatBytes(row.size)}
							</td>
							<td class="px-3 py-2 whitespace-nowrap text-muted-foreground">
								{row.type === 'directory' ? 'Folder' : 'File'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="border-t bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
			{rows.length} items
		</div>
	{/if}
</div>
