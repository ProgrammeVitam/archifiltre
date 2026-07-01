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

	interface TreeRow {
		path: string;
		name: string;
		size: number;
		type: 'directory' | 'file';
		depth: number;
		isLast: boolean[]; // Track if each ancestor is the last child
		fileCount?: number;
		dirCount?: number;
		isArchive?: boolean;
		archiveFormat?: string | null;
	}

	// ================================
	// State
	// ================================

	let rows: TreeRow[] = $state([]);
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

		// Build tree rows
		buildTreeRows();
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

	function buildTreeRows() {
		if (!data) {
			rows = [];
			return;
		}

		const newRows: TreeRow[] = [];

		// Get root files and directories
		const rootFiles = filesCache.get('') || [];
		const rootDirs = getRootDirectories(data.directories);

		// Sort root items: directories first, then files, both alphabetically
		const sortedRootDirs = [...rootDirs].sort((a, b) => a.name.localeCompare(b.name));
		const sortedRootFiles = [...rootFiles].sort((a, b) => a.name.localeCompare(b.name));

		const totalRootItems = sortedRootDirs.length + sortedRootFiles.length;
		let rootIndex = 0;

		// Add root directories with their contents
		for (const dir of sortedRootDirs) {
			const isLast = rootIndex === totalRootItems - 1;
			addDirectoryAndContents(dir, 0, [isLast], newRows);
			rootIndex++;
		}

		// Add root files
		for (const file of sortedRootFiles) {
			const isLast = rootIndex === totalRootItems - 1;
			newRows.push({
				path: file.path,
				name: file.name,
				size: file.size,
				type: 'file',
				depth: 0,
				isLast: [isLast],
				isArchive: file.is_archive,
				archiveFormat: file.archive_format
			});
			rootIndex++;
		}

		rows = newRows;
	}

	function addDirectoryAndContents(
		dir: DirectoryNode,
		depth: number,
		isLastPath: boolean[],
		newRows: TreeRow[]
	) {
		// Add directory row
		newRows.push({
			path: dir.path,
			name: dir.name,
			size: dir.total_size,
			type: 'directory',
			depth,
			isLast: [...isLastPath],
			fileCount: dir.file_count,
			dirCount: dir.dir_count
		});

		// Get children (subdirectories and files)
		const childDirs = getChildren(dir.path, childrenMap);
		const childFiles = filesCache.get(dir.path) || [];

		// Sort children: directories first, then files, both alphabetically
		const sortedChildDirs = [...childDirs].sort((a, b) => a.name.localeCompare(b.name));
		const sortedChildFiles = [...childFiles].sort((a, b) => a.name.localeCompare(b.name));

		const totalChildren = sortedChildDirs.length + sortedChildFiles.length;
		let childIndex = 0;

		// Add subdirectories
		for (const childDir of sortedChildDirs) {
			const isLast = childIndex === totalChildren - 1;
			addDirectoryAndContents(childDir, depth + 1, [...isLastPath, isLast], newRows);
			childIndex++;
		}

		// Add files in this directory
		for (const file of sortedChildFiles) {
			const isLast = childIndex === totalChildren - 1;
			newRows.push({
				path: file.path,
				name: file.name,
				size: file.size,
				type: 'file',
				depth: depth + 1,
				isLast: [...isLastPath, isLast],
				isArchive: file.is_archive,
				archiveFormat: file.archive_format
			});
			childIndex++;
		}
	}

	// ================================
	// Helpers
	// ================================

	function getFileIcon(row: TreeRow): string {
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

	function getTreePrefix(row: TreeRow): string {
		if (row.depth === 0) {
			return row.isLast[0] ? '└── ' : '├── ';
		}

		let prefix = '';
		// Add continuation lines for ancestors
		for (let i = 0; i < row.depth; i++) {
			if (row.isLast[i]) {
				prefix += '    '; // Ancestor was last, no line
			} else {
				prefix += '│   '; // Ancestor continues, draw line
			}
		}
		// Add the branch for this item
		prefix += row.isLast[row.depth] ? '└── ' : '├── ';
		return prefix;
	}

	function handleRowClick(row: TreeRow) {
		if (row.type === 'directory') {
			// Find the directory node in data
			const dirNode = data?.directories.find((d) => d.path === row.path);
			if (dirNode) {
				selectDirectory(dirNode);
			}
		} else {
			// It's a file - find it in the cache
			const parentPath = row.path.includes('/')
				? row.path.substring(0, row.path.lastIndexOf('/'))
				: '';
			const files = filesCache.get(parentPath) || [];
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
			<!-- Header -->
			<div class="sticky top-0 z-10 flex bg-muted/80 px-3 py-2.5 backdrop-blur-sm">
				<span class="flex-1 text-sm font-semibold text-muted-foreground">Name</span>
				<span class="w-24 text-right text-sm font-semibold text-muted-foreground">Size</span>
			</div>

			<!-- Tree Content -->
			<div class="font-mono text-sm">
				{#if data?.root}
					<div
						class="flex items-center border-b border-border/50 px-3 py-1.5 text-muted-foreground"
					>
						<span class="flex-1 truncate" title={data.root}>
							<span class="mr-1.5">📂</span>
							<span class="font-semibold">{data.root}</span>
						</span>
					</div>
				{/if}
				{#each rows as row (row.path)}
					<div
						class="flex cursor-pointer items-center border-b border-border/30 px-3 py-1 transition-colors hover:bg-muted/50"
						class:font-medium={row.type === 'directory'}
						onclick={() => handleRowClick(row)}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === 'Enter' && handleRowClick(row)}
					>
						<span class="flex min-w-0 flex-1 items-center">
							<span class="whitespace-pre text-muted-foreground/60 select-none"
								>{getTreePrefix(row)}</span
							>
							<span class="mr-1.5 shrink-0">{getFileIcon(row)}</span>
							<span class="truncate" title={row.path}>{row.name}</span>
							{#if row.type === 'directory'}
								<span class="ml-2 shrink-0 text-xs text-muted-foreground">
									({row.fileCount} files, {row.dirCount} folders)
								</span>
							{:else if row.isArchive && row.archiveFormat}
								<span class="ml-2 shrink-0 text-xs text-muted-foreground">
									({row.archiveFormat})
								</span>
							{/if}
						</span>
						<span class="w-24 shrink-0 text-right whitespace-nowrap text-muted-foreground">
							{formatBytes(row.size)}
						</span>
					</div>
				{/each}
			</div>
		</div>
		<div class="border-t bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
			{rows.length} items
		</div>
	{/if}
</div>
