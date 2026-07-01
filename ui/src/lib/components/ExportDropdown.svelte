<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { activeScan } from '$lib/stores';
	import { extensionRegistry, type ExportMenuItem } from '$lib/extensions/registry';
	import { exportCsv, selectExportPath, generateId, getDeleteTags } from '$lib/tauri';
	import { jobsStore } from '$lib/jobs';
	import { DownloadIcon, ChevronDownIcon } from '@lucide/svelte';

	let { disabled = false }: { disabled?: boolean } = $props();

	async function handleCsvExport(): Promise<void> {
		const scan = $activeScan;
		if (!scan) return;

		const outputPath = await selectExportPath();
		if (!outputPath) return;

		const jobId = generateId();
		exportCsv({ outputPath, jobId, dbName: scan.dbName, fullPaths: true });
	}

	async function handleDeletionManifestExport(): Promise<void> {
		const scan = $activeScan;
		if (!scan) return;

		const outputPath = await selectExportPath('bordereau-elimination');
		if (!outputPath) return;

		const jobId = generateId();
		exportCsv({ outputPath, jobId, dbName: scan.dbName, fullPaths: true, deletionOnly: true });
	}

	// Archival exports: RESIP (SEDA import CSV) and a two-sheet Excel workbook.
	async function handleArchivalExport(format: 'resip' | 'xlsx'): Promise<void> {
		const scan = $activeScan;
		if (!scan) return;
		const [type, ext, filter] =
			format === 'xlsx' ? ['excel', 'xlsx', 'Excel'] : ['resip', 'csv', 'CSV'];
		const outputPath = await selectExportPath(type, ext, filter);
		if (!outputPath) return;
		exportCsv({ outputPath, jobId: generateId(), dbName: scan.dbName, format });
	}

	// Whether the active scan has any deletion marks. Queried from PGlite when
	// the export menu opens (not cached) so the manifest option reflects current
	// state even after marks are toggled elsewhere.
	let hasDeletionTags = $state(false);

	async function refreshDeletionTags(): Promise<void> {
		if (!$activeScan) {
			hasDeletionTags = false;
			return;
		}
		const result = await getDeleteTags();
		hasDeletionTags = (result?.tags.length ?? 0) > 0;
	}

	let builtinItems: ExportMenuItem[] = $derived([
		{
			id: 'csv-export',
			label: 'Export as CSV',
			action: handleCsvExport
		},
		{
			id: 'deletion-manifest',
			label: 'Deletion manifest (CSV)',
			action: handleDeletionManifestExport,
			disabled: !hasDeletionTags
		},
		{
			id: 'resip-export',
			label: 'RESIP (SEDA) CSV',
			action: () => handleArchivalExport('resip')
		},
		{
			id: 'xlsx-export',
			label: 'Excel workbook (.xlsx)',
			action: () => handleArchivalExport('xlsx')
		}
	]);

	let extensionItems = $derived(
		$extensionRegistry.extensions
			.filter((e) => $extensionRegistry.enabledIds.has(e.id))
			.flatMap((e) => e.exportMenuItems ?? [])
	);
	let allItems = $derived([...builtinItems, ...extensionItems]);
</script>

<DropdownMenu.Root onOpenChange={(open) => open && refreshDeletionTags()}>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				{disabled}
				class="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
				data-no-drag
			>
				<DownloadIcon size={14} />
				<span>Export</span>
				<ChevronDownIcon size={12} class="opacity-60" />
			</button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Portal>
		<DropdownMenu.Content
			class="z-[200] min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-2xl backdrop-blur-xl"
			sideOffset={6}
			align="end"
		>
			{#each allItems as item (item.id)}
				<DropdownMenu.Item
					class="block w-full cursor-pointer rounded-md border-none bg-transparent px-2.5 py-1.5 text-left text-xs text-popover-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
					onclick={item.action}
					disabled={item.disabled}
				>
					{item.label}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
