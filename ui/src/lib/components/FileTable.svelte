<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import {
		formatBytes,
		buildTreeHierarchy,
		getChildren,
		getRootDirectories,
		queryFiles,
		type DirectoryNode,
		type TreeData,
		type FileNode
	} from '$lib/tauri';

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
		depth: number;
		fileCount?: number;
		dirCount?: number;
		isArchive?: boolean;
		archiveFormat?: string | null;
	}

	// ================================
	// State
	// ================================

	let rows: TableRow[] = $state([]);
	let sortColumn: 'name' | 'size' | 'type' = $state('name');
	let sortDirection: 'asc' | 'desc' = $state('asc');
	let isLoading = $state(false);

	// Files cache
	let filesCache: SvelteMap<string, FileNode[]> = new SvelteMap();
	let loadingFiles: SvelteSet<string> = new SvelteSet();

	// Derived
	let childrenMap = $derived(data ? buildTreeHierarchy(data.directories) : new Map());

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

		// Load files for root
		await loadFilesForDirectory('');

		// Load files for all directories
		for (const dir of data.directories) {
			await loadFilesForDirectory(dir.path);
		}

		// Build table rows
		buildTableRows();
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

	function buildTableRows() {
		if (!data) {
			rows = [];
			return;
		}

		const newRows: TableRow[] = [];

		// Add root files
		const rootFiles = filesCache.get('') || [];
		for (const file of rootFiles) {
			newRows.push({
				path: file.path,
				name: file.name,
				size: file.size,
				type: 'file',
				depth: 0,
				isArchive: file.is_archive,
				archiveFormat: file.archive_format
			});
		}

		// Recursively add directories and their files
		function addDirectoryContents(dirs: DirectoryNode[], depth: number) {
			for (const dir of dirs) {
				// Add directory row
				newRows.push({
					path: dir.path,
					name: dir.name,
					size: dir.total_size,
					type: 'directory',
					depth,
					fileCount: dir.file_count,
					dirCount: dir.dir_count
				});

				// Add files in this directory
				const dirFiles = filesCache.get(dir.path) || [];
				for (const file of dirFiles) {
					newRows.push({
						path: file.path,
						name: file.name,
						size: file.size,
						type: 'file',
						depth: depth + 1,
						isArchive: file.is_archive,
						archiveFormat: file.archive_format
					});
				}

				// Add subdirectories
				const children = getChildren(dir.path, childrenMap);
				if (children.length > 0) {
					addDirectoryContents(children, depth + 1);
				}
			}
		}

		const rootDirs = getRootDirectories(data.directories);
		addDirectoryContents(rootDirs, 0);

		rows = newRows;
	}

	// ================================
	// Sorting
	// ================================

	function sortRows(column: 'name' | 'size' | 'type') {
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

	function getSortIndicator(column: 'name' | 'size' | 'type'): string {
		if (sortColumn !== column) return '';
		return sortDirection === 'asc' ? ' ↑' : ' ↓';
	}
</script>

<div class="flex h-full flex-col overflow-hidden rounded-lg border bg-background {className}">
	{#if isLoading}
		<div class="flex flex-1 items-center justify-center gap-2 p-10 text-muted-foreground">
			<div
				class="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary"
			></div>
			<span class="text-sm">Loading files...</span>
		</div>
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
					{#each sortedRows as row}
						<tr
							class="border-b border-border/50 transition-colors hover:bg-muted/50"
							class:font-medium={row.type === 'directory'}
						>
							<td class="px-3 py-2">
								<div class="flex items-center gap-1.5">
									<span style="width: {row.depth * 20}px" class="shrink-0"></span>
									<span class="shrink-0">{getFileIcon(row)}</span>
									<span class="truncate" title={row.path}>{row.name}</span>
									{#if row.type === 'directory'}
										<span class="shrink-0 text-xs text-muted-foreground">
											({row.fileCount} files, {row.dirCount} folders)
										</span>
									{:else if row.isArchive && row.archiveFormat}
										<span class="shrink-0 text-xs text-muted-foreground">
											({row.archiveFormat})
										</span>
									{/if}
								</div>
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
