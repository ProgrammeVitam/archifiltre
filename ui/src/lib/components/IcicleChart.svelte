<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import {
		formatBytes,
		buildTreeHierarchy,
		getChildren,
		getRootDirectories,
		getColorForPath,
		queryFiles,
		type DirectoryNode,
		type TreeData,
		type FileNode
	} from '$lib/tauri';
	import { selectDirectory, selectFile, hoverDirectory, hoverFile, clearHoveredItem } from '$lib/stores';

	// ================================
	// Types
	// ================================

	interface LayoutRect {
		node: DirectoryNode | null;
		file: FileNode | null;
		x: number;
		y: number;
		width: number;
		height: number;
		color: string;
		opacity: number;
		depth: number;
	}

	// ================================
	// Props
	// ================================

	interface Props {
		data: TreeData | null;
		class?: string;
	}

	let { data, class: className = '' }: Props = $props();

	// ================================
	// State
	// ================================

	let canvas: HTMLCanvasElement | undefined = $state();
	let container: HTMLDivElement | undefined = $state();
	let ctx: CanvasRenderingContext2D | null = $state(null);

	// Canvas dimensions
	let canvasWidth = $state(800);
	let canvasHeight = $state(600);

	// Computed height based on content
	let contentHeight = $state(0);
	let maxDepth = $state(0);

	// Hover state
	let hoveredRect: LayoutRect | null = $state(null);
	let mouseX = $state(0);
	let mouseY = $state(0);

	// Layout cache
	let layoutRects: LayoutRect[] = $state([]);
	let childrenMap: Map<string, DirectoryNode[]> = $state(new Map());

	// Files cache - stores files for each directory path
	let filesCache: SvelteMap<string, FileNode[]> = new SvelteMap();
	let loadingFiles: SvelteSet<string> = new SvelteSet();

	// Constants
	const ROW_HEIGHT = 28;
	const MIN_VISIBLE_WIDTH = 2;
	const PADDING = 1;

	// ================================
	// Lifecycle
	// ================================

	let resizeObserver: ResizeObserver | null = null;

	onMount(() => {
		if (canvas && container) {
			ctx = canvas.getContext('2d');
			// Initialize canvas size immediately
			const rect = container.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			canvasWidth = rect.width * dpr;
			canvasHeight = rect.height * dpr;
			canvas.width = canvasWidth;
			canvas.height = canvasHeight;
			canvas.style.width = `${rect.width}px`;
			canvas.style.height = `${rect.height}px`;
			setupResizeObserver();
			// Initial render
			if (data) {
				childrenMap = buildTreeHierarchy(data.directories);
				computeLayout();
				render();
			}
		}
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
	});

	function setupResizeObserver() {
		if (!container) return;

		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width } = entry.contentRect;
				const dpr = window.devicePixelRatio || 1;
				if (canvas) {
					canvas.width = width * dpr;
					canvasWidth = canvas.width;
					canvas.style.width = `${width}px`;
					// Height will be set based on content
					updateCanvasHeight();
				}
				computeLayout();
				render();
			}
		});

		resizeObserver.observe(container);
	}

	// ================================
	// Layout Computation
	// ================================

	// Derive childrenMap from data (no effect needed)
	let childrenMapDerived = $derived(data ? buildTreeHierarchy(data.directories) : new Map());

	// Track data changes manually to reset view
	let lastDataId: string | null = null;

	function updateForNewData() {
		if (!data) return;

		const dataId = data.root ?? 'unknown';
		if (dataId !== lastDataId) {
			lastDataId = dataId;
			childrenMap = childrenMapDerived;
			filesCache = new SvelteMap();
			loadingFiles = new SvelteSet();
		} else {
			childrenMap = childrenMapDerived;
		}

		if (ctx && canvasWidth > 0) {
			computeLayout();
			updateCanvasHeight();
			render();
			// Load files for all directories
			loadFilesForAllDirectories();
		}
	}

	// Call updateForNewData when component renders with new data
	$effect.pre(() => {
		// Only read data, don't write reactive state here
		// Schedule update outside of effect
		if (data) {
			requestAnimationFrame(updateForNewData);
		}
	});

	async function loadFilesForDirectory(dirPath: string) {
		// Skip if already loading or cached
		if (loadingFiles.has(dirPath) || filesCache.has(dirPath)) {
			return;
		}

		loadingFiles.add(dirPath);

		try {
			const filesData = await queryFiles(dirPath, 1000);
			if (filesData && filesData.files.length > 0) {
				const files = filesData.files.filter((f) => !f.is_directory);
				filesCache.set(dirPath, files);
				computeLayout();
				render();
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

	function loadFilesForAllDirectories() {
		if (!data) return;

		// Load root files
		loadFilesForDirectory('');

		// Load files for ALL directories to show complete structure
		for (const dir of data.directories) {
			loadFilesForDirectory(dir.path);
		}
	}

	function updateCanvasHeight() {
		if (!canvas || !container) return;

		const dpr = window.devicePixelRatio || 1;
		// Calculate height based on max depth, minimum 1 row
		const rows = Math.max(1, maxDepth + 1);
		contentHeight = rows * ROW_HEIGHT;

		const newHeight = contentHeight * dpr;
		if (canvas.height !== newHeight) {
			canvas.height = newHeight;
			canvasHeight = newHeight;
		}
	}

	function computeLayout() {
		if (!data) {
			layoutRects = [];
			maxDepth = 0;
			return;
		}

		// If no directories, layout root files instead
		if (data.directories.length === 0) {
			const rootFilesList = filesCache.get('') || [];
			if (rootFilesList.length > 0) {
				computeFilesOnlyLayout(rootFilesList);
			} else {
				layoutRects = [];
				maxDepth = 0;
			}
			return;
		}

		const dpr = window.devicePixelRatio || 1;
		const viewWidth = canvasWidth / dpr;

		if (viewWidth === 0) {
			layoutRects = [];
			return;
		}

		let currentMaxDepth = 0;

		const rects: LayoutRect[] = [];

		// Determine starting directories based on focus
		let startDirs: DirectoryNode[];
		let startDepth: number;

		// Always start from root to show complete structure
		startDirs = getRootDirectories(data.directories);
		startDepth = startDirs.length > 0 ? startDirs[0].depth : 0;

		const totalSize = startDirs.reduce((sum, d) => sum + d.total_size, 0);
		if (totalSize === 0) {
			layoutRects = rects;
			return;
		}

		// Initial layout of root level directories and files
		function layoutRootLevel(dirs: DirectoryNode[], x: number, width: number, depth: number) {
			const rootFiles = filesCache.get('') || [];
			layoutChildrenAndFiles(dirs, rootFiles, x, width, depth);
		}

		// Layout both subdirectories and files together at the same level
		function layoutChildrenAndFiles(
			dirs: DirectoryNode[],
			files: FileNode[],
			x: number,
			width: number,
			depth: number
		) {
			const levelIndex = depth - startDepth;
			const y = levelIndex * ROW_HEIGHT;

			// Track max depth
			if (levelIndex > currentMaxDepth) {
				currentMaxDepth = levelIndex;
			}

			// Calculate total size including both dirs and files
			const dirsSize = dirs.reduce((sum, d) => sum + d.total_size, 0);
			const filesSize = files.reduce((sum, f) => sum + f.size, 0);
			const totalSize = dirsSize + filesSize;

			if (totalSize === 0) return;

			let currentX = x;

			// Layout directories first
			for (const dir of dirs) {
				const nodeWidth = (dir.total_size / totalSize) * width;

				if (nodeWidth >= MIN_VISIBLE_WIDTH) {
					rects.push({
						node: dir,
						file: null,
						x: currentX,
						y,
						width: nodeWidth - PADDING,
						height: ROW_HEIGHT - PADDING,
						color: getColorForPath(dir.path, true),
						opacity: 1,
						depth: levelIndex
					});

					// Recursively layout this directory's children
					const subChildren = getChildren(dir.path, childrenMap);
					const subFiles = filesCache.get(dir.path) || [];
					if (subChildren.length > 0 || subFiles.length > 0) {
						layoutChildrenAndFiles(subChildren, subFiles, currentX, nodeWidth, depth + 1);
					}
				}

				currentX += nodeWidth;
			}

			// Then layout files
			for (const file of files) {
				const fileWidth = (file.size / totalSize) * width;

				if (fileWidth >= MIN_VISIBLE_WIDTH) {
					rects.push({
						node: null,
						file: file,
						x: currentX,
						y,
						width: fileWidth - PADDING,
						height: ROW_HEIGHT - PADDING,
						color: getColorForFile(file),
						opacity: 1,
						depth: levelIndex
					});
				}

				currentX += fileWidth;
			}
		}

		layoutRootLevel(startDirs, 0, viewWidth, startDepth);
		layoutRects = rects;
		maxDepth = currentMaxDepth;
	}

	function computeFilesOnlyLayout(files: FileNode[]) {
		const dpr = window.devicePixelRatio || 1;
		const viewWidth = canvasWidth / dpr;
		const viewHeight = canvasHeight / dpr;

		if (viewWidth === 0 || viewHeight === 0 || files.length === 0) {
			layoutRects = [];
			return;
		}

		const rects: LayoutRect[] = [];
		const totalSize = files.reduce((sum, f) => sum + f.size, 0);

		if (totalSize === 0) {
			layoutRects = [];
			maxDepth = 0;
			return;
		}

		maxDepth = 0; // Files only = single row

		let currentX = 0;
		for (const file of files) {
			const fileWidth = (file.size / totalSize) * viewWidth;

			if (fileWidth >= MIN_VISIBLE_WIDTH) {
				rects.push({
					node: null,
					file: file,
					x: currentX,
					y: 0,
					width: fileWidth - PADDING,
					height: ROW_HEIGHT - PADDING,
					color: getColorForFile(file),
					opacity: 1,
					depth: 0
				});
			}

			currentX += fileWidth;
		}

		layoutRects = rects;
	}

	function getColorForFile(file: FileNode): string {
		// Get file extension for color coding
		const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() || '' : '';

		// Color by file type
		const colorMap: Record<string, string> = {
			// Documents
			pdf: 'hsl(0, 70%, 50%)',
			doc: 'hsl(210, 70%, 50%)',
			docx: 'hsl(210, 70%, 50%)',
			xls: 'hsl(120, 70%, 40%)',
			xlsx: 'hsl(120, 70%, 40%)',
			ppt: 'hsl(30, 70%, 50%)',
			pptx: 'hsl(30, 70%, 50%)',
			txt: 'hsl(0, 0%, 50%)',
			// Images
			jpg: 'hsl(280, 60%, 50%)',
			jpeg: 'hsl(280, 60%, 50%)',
			png: 'hsl(280, 60%, 55%)',
			gif: 'hsl(280, 60%, 45%)',
			svg: 'hsl(280, 60%, 60%)',
			// Code
			js: 'hsl(50, 70%, 50%)',
			ts: 'hsl(210, 70%, 55%)',
			py: 'hsl(210, 50%, 45%)',
			rs: 'hsl(25, 70%, 50%)',
			// Archives
			zip: 'hsl(45, 60%, 45%)',
			tar: 'hsl(45, 60%, 40%)',
			gz: 'hsl(45, 60%, 42%)',
			'7z': 'hsl(45, 60%, 48%)'
		};

		return colorMap[ext] || 'hsl(200, 40%, 50%)';
	}

	// ================================
	// Rendering
	// ================================

	function render() {
		if (!ctx || !canvas || canvasWidth === 0 || canvasHeight === 0) return;

		const dpr = window.devicePixelRatio || 1;
		const viewWidth = canvasWidth / dpr;
		const viewHeight = canvasHeight / dpr;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Clear canvas with transparent background
		ctx.clearRect(0, 0, viewWidth, viewHeight);

		if (layoutRects.length === 0) {
			// Show empty state
			ctx.fillStyle = '#64748b';
			ctx.font = '14px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';

			let msg: string;
			if (!data) {
				msg = 'No data to display';
			} else if (data.directories.length === 0 && !filesCache.has('')) {
				msg = 'Loading files...';
			} else if (data.directories.length === 0 && (filesCache.get('') || []).length === 0) {
				msg = 'No files to visualize';
			} else {
				msg = 'Loading...';
			}

			ctx.fillText(msg, viewWidth / 2, viewHeight / 2);
			return;
		}

		// Draw rectangles
		ctx.save();

		// Draw each rectangle
		for (const rect of layoutRects) {
			const rectPath = rect.node?.path ?? rect.file?.path ?? '';
			const isHovered =
				hoveredRect && (hoveredRect.node?.path ?? hoveredRect.file?.path) === rectPath;

			// Draw background
			ctx.fillStyle = isHovered ? lightenColor(rect.color, 0.15) : rect.color;
			ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

			// Draw border
			ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
			ctx.lineWidth = 1;
			ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

			// Draw text if there's enough space
			const scaledWidth = rect.width;
			const scaledHeight = rect.height;

			if (scaledWidth > 40 && scaledHeight > 14) {
				ctx.fillStyle = '#ffffff';
				const fontSize = Math.min(12, rect.height - 4);
				ctx.font = `${fontSize}px system-ui, sans-serif`;
				ctx.textAlign = 'left';
				ctx.textBaseline = 'middle';

				const text = rect.node?.name ?? rect.file?.name ?? '';
				const maxWidth = rect.width - 8;
				const textWidth = ctx.measureText(text).width;

				let displayText = text;
				if (textWidth > maxWidth) {
					// Truncate with ellipsis
					let truncated = text;
					while (truncated.length > 0 && ctx.measureText(truncated + '…').width > maxWidth) {
						truncated = truncated.slice(0, -1);
					}
					displayText = truncated + '…';
				}

				if (displayText.length > 1) {
					ctx.fillText(displayText, rect.x + 4, rect.y + rect.height / 2);
				}
			}
		}

		ctx.restore();
	}

	function lightenColor(color: string, amount: number): string {
		// Handle HSL colors
		if (color.startsWith('hsl')) {
			const match = color.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
			if (match) {
				const h = parseInt(match[1]);
				const s = parseInt(match[2]);
				const l = Math.min(100, parseInt(match[3]) + amount * 100);
				return `hsl(${h}, ${s}%, ${l}%)`;
			}
		}
		// Handle hex colors
		if (color.startsWith('#')) {
			const num = parseInt(color.slice(1), 16);
			const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amount));
			const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amount));
			const b = Math.min(255, (num & 0xff) + Math.round(255 * amount));
			return `rgb(${r}, ${g}, ${b})`;
		}
		return color;
	}

	// ================================
	// Hit Testing
	// ================================

	function findRectAt(screenX: number, screenY: number): LayoutRect | null {
		// Use screen coordinates directly (no pan/zoom)
		const x = screenX;
		const y = screenY;

		// Check rectangles in reverse order (top-most first)
		// Search in reverse (topmost first)
		for (let i = layoutRects.length - 1; i >= 0; i--) {
			const rect = layoutRects[i];
			if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
				return rect;
			}
		}
		return null;
	}

	// ================================
	// Event Handlers
	// ================================

	function handleMouseMove(e: MouseEvent) {
		if (!canvas) return;

		const rect = canvas.getBoundingClientRect();
		mouseX = e.clientX - rect.left;
		mouseY = e.clientY - rect.top;

		// Hit test for hover
		const hit = findRectAt(mouseX, mouseY);
		if (hit !== hoveredRect) {
			hoveredRect = hit;
			render();

			// Update hover stores for drawer preview
			if (hit) {
				const centerX = hit.x + hit.width / 2;
				if (hit.node) {
					hoverDirectory(hit.node, centerX);
				} else if (hit.file) {
					hoverFile(hit.file, centerX);
				}
			} else {
				clearHoveredItem();
			}
		}
	}

	function handleMouseLeave() {
		hoveredRect = null;
		clearHoveredItem();
		render();
	}

	function handleClick(e: MouseEvent) {
		if (!canvas) return;

		const rect = canvas.getBoundingClientRect();
		const clickX = e.clientX - rect.left;
		const clickY = e.clientY - rect.top;

		const hit = findRectAt(clickX, clickY);
		if (hit) {
			// Calculate center X of the selected item (in screen coordinates)
			const centerX = hit.x + hit.width / 2;
			if (hit.node) {
				selectDirectory(hit.node, centerX);
			} else if (hit.file) {
				selectFile(hit.file, centerX);
			}
		}
	}
</script>

<div class="w-full {className}" bind:this={container}>
	<!-- Canvas -->
	<div class="relative w-full">
		<canvas
			bind:this={canvas}
			onmousemove={handleMouseMove}
			onmouseleave={handleMouseLeave}
			onclick={handleClick}
			class="block w-full cursor-pointer"
			style="height: {contentHeight}px;"
		></canvas>

	</div>
</div>
