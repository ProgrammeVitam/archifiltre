<script lang="ts">
	import {
		selectedItem,
		selectedItemX,
		hoveredItem,
		hoveredItemX,
		clearSelectedItem,
		tagDictionary,
		addTagToDictionary,
		invalidateEnrichment
	} from '$lib/stores';
	import {
		formatBytes,
		queryDirectoryDescription,
		queryDirDateStats,
		type DirectoryDescription,
		type DirDateStats,
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
		TextIcon,
		LoaderCircleIcon,
		Trash2Icon,
		LeafIcon,
		CalendarIcon,
		TagIcon,
		MessageSquareTextIcon,
		PencilIcon,
		PlusIcon
	} from '@lucide/svelte';
	import FilePreview from './FilePreview.svelte';

	// AI description state
	let aiDescription: DirectoryDescription | null = $state(null);
	let isLoadingDescription = $state(false);
	let lastDescribedPath: string | null = $state(null);

	// Directory date stats state
	let dirDateStats: DirDateStats | null = $state(null);
	let isLoadingDateStats = $state(false);
	let lastDateStatsPath: string | null = $state(null);

	// Determine which item to display: selected takes priority, then hovered
	let displayItem = $derived($selectedItem ?? $hoveredItem);
	let displayX = $derived($selectedItem ? $selectedItemX : $hoveredItemX);
	let isPreview = $derived(!$selectedItem && !!$hoveredItem);

	// Per-element enrichment, read on selection (query-on-select). PGlite is the
	// source of truth; this is not a long-lived cache — it is re-read whenever the
	// selection changes. Only the selected item is enriched (hovered previews are
	// not, to avoid query spam).
	let elementEnrichment = $state<ElementEnrichment | null>(null);
	let enrichmentPath = $state<string | null>(null);
	let aliasInput = $state('');
	let commentInput = $state('');
	let tagInput = $state('');

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

	// The element's original (real) name, used to detect a no-op alias.
	let originalName = $derived($selectedItem?.path.split('/').filter(Boolean).pop() ?? '');

	async function commitAlias() {
		const item = $selectedItem;
		if (!item || !elementEnrichment) return;
		const ok = await setAlias(item.path, aliasInput);
		if (!ok) return;
		// The backend clears the alias when empty or equal to the original name.
		const trimmed = aliasInput.trim();
		const effective = trimmed === '' || trimmed === originalName ? null : trimmed;
		elementEnrichment = { ...elementEnrichment, alias: effective };
		aliasInput = effective ?? '';
		invalidateEnrichment(item.path, false);
	}

	async function commitComment() {
		const item = $selectedItem;
		if (!item || !elementEnrichment) return;
		const ok = await setComment(item.path, commentInput);
		if (!ok) return;
		const effective = commentInput.trim() === '' ? null : commentInput;
		elementEnrichment = { ...elementEnrichment, comment: effective };
		commentInput = effective ?? '';
		invalidateEnrichment(item.path, false);
	}

	async function submitTag() {
		const item = $selectedItem;
		const name = tagInput.trim();
		if (!item || !elementEnrichment || name === '') return;

		// Reuse an existing tag of the same name (case-insensitive), else create one.
		const existing = [...$tagDictionary.entries()].find(
			([, n]) => n.toLowerCase() === name.toLowerCase()
		);
		let tagId: string;
		if (existing) {
			tagId = existing[0];
		} else {
			const created = await createTag(name);
			if (!created) return;
			addTagToDictionary(created.tag_id, created.name);
			tagId = created.tag_id;
		}

		const ok = await assignTag(tagId, item.path);
		if (ok && !elementEnrichment.tagIds.includes(tagId)) {
			elementEnrichment = { ...elementEnrichment, tagIds: [...elementEnrichment.tagIds, tagId] };
		}
		tagInput = '';
		if (ok) invalidateEnrichment(item.path, false);
	}

	async function removeTagAssignment(tagId: string) {
		const item = $selectedItem;
		if (!item || !elementEnrichment) return;
		const ok = await unassignTag(tagId, item.path);
		if (ok) {
			elementEnrichment = {
				...elementEnrichment,
				tagIds: elementEnrichment.tagIds.filter((id) => id !== tagId)
			};
			invalidateEnrichment(item.path, false);
		}
	}

	// Parse path into breadcrumb segments
	let breadcrumbs = $derived(() => {
		if (!displayItem) return [];
		const parts = displayItem.path.split('/').filter(Boolean);
		return parts;
	});

	// Fetch AI description when a directory is selected
	$effect(() => {
		const item = $selectedItem;
		if (item && item.type === 'directory' && item.path !== lastDescribedPath) {
			lastDescribedPath = item.path;
			isLoadingDescription = true;
			aiDescription = null;
			queryDirectoryDescription(item.path).then((result) => {
				if (lastDescribedPath === item.path) {
					aiDescription = result;
					isLoadingDescription = false;
				}
			});
		} else if (!item || item.type !== 'directory') {
			aiDescription = null;
			isLoadingDescription = false;
			lastDescribedPath = null;
		}
	});

	// Fetch date stats when a directory is selected
	$effect(() => {
		const item = $selectedItem;
		if (item && item.type === 'directory' && item.path !== lastDateStatsPath) {
			lastDateStatsPath = item.path;
			isLoadingDateStats = true;
			dirDateStats = null;
			queryDirDateStats(item.path).then((result) => {
				if (lastDateStatsPath === item.path) {
					dirDateStats = result;
					isLoadingDateStats = false;
				}
			});
		} else if (!item || item.type !== 'directory') {
			dirDateStats = null;
			isLoadingDateStats = false;
			lastDateStatsPath = null;
		}
	});

	// thumbnailjs handles all file types — native previews for images/pdf/video/svg,
	// graceful fallback icons for everything else
	let supportsPreview = $derived(() => {
		if (!displayItem || displayItem.type === 'directory') return false;
		return true;
	});

	function formatCO2(bytes: number): string {
		const grams = (bytes / 1024 ** 3) * 11.6;
		if (grams >= 1000) return `${(grams / 1000).toFixed(2)} kg CO₂eq/year`;
		if (grams < 0.01) return `${(grams * 1000).toFixed(2)} mg CO₂eq/year`;
		return `${grams.toFixed(2)} g CO₂eq/year`;
	}

	// Format a unix timestamp (seconds) into a human-readable date
	function formatDate(timestamp: number | undefined): string | null {
		if (timestamp === undefined || timestamp === 0) return null;
		// mtime may be in seconds
		const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
		const date = new Date(ms);
		return date.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
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

		if (elementEnrichment.directlyTaggedForDeletion) {
			const success = await removeDeleteTag(item.path);
			if (success) {
				elementEnrichment = { ...elementEnrichment, directlyTaggedForDeletion: false };
				invalidateEnrichment(item.path, true);
			}
		} else {
			const success = await setDeleteTag(item.path);
			if (success) {
				elementEnrichment = { ...elementEnrichment, directlyTaggedForDeletion: true };
				invalidateEnrichment(item.path, true);
			}
		}
	}
</script>

{#if displayItem && displayX !== null}
	<div class="relative flex min-h-0 flex-1 flex-col px-4" class:opacity-80={isPreview}>
		<!-- Picker line - connector from chart to drawer -->
		<svg
			class="pointer-events-none h-[75px] w-full shrink-0 overflow-visible"
			style="margin-top: -20px;"
		>
			<!-- Circle at top (near the selected item) -->
			<circle cx={displayX} cy="8" r="5" fill="none" stroke="#94a3b8" stroke-width="2" />
			<!-- Vertical line going down -->
			<line x1={displayX} y1="13" x2={displayX} y2="95" stroke="#94a3b8" stroke-width="2" />
		</svg>

		<!-- Drawer -->
		<div
			class="mb-4 flex flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
		>
			<!-- Breadcrumbs header -->
			<div
				class="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/50 px-4 py-2"
			>
				<div
					class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto text-sm text-muted-foreground"
				>
					{#each breadcrumbs() as segment, i}
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
								{segment}
							</span>
						{:else}
							<span class="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted">
								{segment}
							</span>
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

				<!-- Close button - only show when item is selected -->
				{#if $selectedItem}
					<Button
						variant="ghost"
						size="sm"
						onclick={() => clearSelectedItem()}
						class="-mr-2 shrink-0"
					>
						<XIcon class="h-4 w-4" />
						<span class="sr-only">Close details</span>
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
						<div class="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
							<TextIcon class="h-4 w-4" />
							<span>Summary</span>
						</div>

						{#if isLoadingDescription}
							<div class="flex flex-1 items-center gap-2 text-sm text-muted-foreground">
								<LoaderCircleIcon class="h-4 w-4 animate-spin" />
								<span>Analyzing directory contents…</span>
							</div>
						{:else if aiDescription?.description}
							<div class="flex flex-1 flex-col">
								<p class="leading-relaxed text-foreground">
									{aiDescription.description}
								</p>
								{#if aiDescription.model}
									<p class="mt-auto pt-4 text-xs text-muted-foreground/50">
										{aiDescription.model}{aiDescription.cached ? ' · cached' : ''}
									</p>
								{/if}
							</div>
						{:else if aiDescription?.error}
							<p class="text-sm text-muted-foreground/60 italic">{aiDescription.error}</p>
						{:else}
							<p class="text-sm text-muted-foreground/40 italic">No description available.</p>
						{/if}
					</div>
				{/if}

				<!-- Right column: Metadata -->
				<div class="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
					<div class="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 text-sm">
						<!-- Size -->
						<div class="flex items-center gap-2 text-muted-foreground">
							<HardDriveIcon class="h-3.5 w-3.5" />
							<span>Size</span>
						</div>
						<span class="font-medium text-foreground">
							{formatBytes(displayItem.size)}
							{#if displayItem.type === 'file' && displayItem.contentSize != null && displayItem.contentSize !== displayItem.size}
								<span class="ml-1 font-normal text-muted-foreground">
									({formatBytes(displayItem.contentSize)} on disk)
								</span>
							{/if}
						</span>

						<!-- CO₂ -->
						<div class="flex items-center gap-2 text-muted-foreground">
							<LeafIcon class="h-3.5 w-3.5" />
							<span>CO₂</span>
						</div>
						<span class="font-medium text-foreground">{formatCO2(displayItem.size)}</span>

						{#if displayItem.type === 'directory'}
							<!-- File count -->
							<div class="flex items-center gap-2 text-muted-foreground">
								<FilesIcon class="h-3.5 w-3.5" />
								<span>Files</span>
							</div>
							<span class="font-medium text-foreground">
								{displayItem.fileCount?.toLocaleString() ?? 0}
							</span>

							<!-- Folder count -->
							<div class="flex items-center gap-2 text-muted-foreground">
								<FolderOpenIcon class="h-3.5 w-3.5" />
								<span>Folders</span>
							</div>
							<span class="font-medium text-foreground">
								{displayItem.dirCount?.toLocaleString() ?? 0}
							</span>

							<!-- Date stats -->
							{#if isLoadingDateStats}
								<div class="col-span-2 flex items-center gap-2 text-sm text-muted-foreground">
									<LoaderCircleIcon class="h-3.5 w-3.5 animate-spin" />
									<span>Computing date statistics…</span>
								</div>
							{:else if dirDateStats && dirDateStats.count > 0}
								<div class="flex items-center gap-2 text-muted-foreground">
									<CalendarIcon class="h-3.5 w-3.5" />
									<span>Oldest file</span>
								</div>
								<span class="font-medium text-foreground">{formatDate(dirDateStats.min ?? undefined) ?? '—'}</span>

								<div class="flex items-center gap-2 text-muted-foreground">
									<CalendarIcon class="h-3.5 w-3.5" />
									<span>Newest file</span>
								</div>
								<span class="font-medium text-foreground">{formatDate(dirDateStats.max ?? undefined) ?? '—'}</span>

								<div class="flex items-center gap-2 text-muted-foreground">
									<CalendarIcon class="h-3.5 w-3.5" />
									<span>Median date</span>
								</div>
								<span class="font-medium text-foreground">{formatDate(dirDateStats.median ?? undefined) ?? '—'}</span>
							{/if}
						{/if}

						{#if displayItem.type === 'file'}
							<!-- Extension -->
							{@const ext = getExtension(displayItem.name)}
							{#if ext}
								<div class="flex items-center gap-2 text-muted-foreground">
									<FileIcon class="h-3.5 w-3.5" />
									<span>Type</span>
								</div>
								<span class="font-medium text-foreground uppercase">{ext}</span>
							{/if}

							<!-- Modified date -->
							{@const formattedDate = formatDate(displayItem.mtime)}
							{#if formattedDate}
								<div class="flex items-center gap-2 text-muted-foreground">
									<ClockIcon class="h-3.5 w-3.5" />
									<span>Modified</span>
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
									<span>Hash</span>
								</div>
								<span
									class="truncate font-mono text-xs font-medium text-foreground"
									title={displayItem.hash}
								>
									{displayItem.hash}
								</span>
							{/if}
						{/if}

						<!-- Enrichment (editable only for the selected item) -->
						{#if $selectedItem}
							<div class="col-span-2 mt-3 flex flex-col gap-4 border-t border-border pt-4">
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
										onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
										placeholder={originalName}
									/>
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
										rows={2}
										placeholder="Add a comment…"
									/>
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
											onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), submitTag())}
											list="tag-suggestions"
											placeholder="Add a tag…"
											class="flex-1"
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
						{/if}
					</div>
				</div>
			</div>
		</div>
	</div>
{/if}
