<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { activeScan, deleteTags } from '$lib/stores';
	import { extensionRegistry, type ExportMenuItem } from '$lib/extensions/registry';
	import { exportCsv, selectExportPath, generateId } from '$lib/tauri';
	import { jobsStore } from '$lib/jobs';
	import { DownloadIcon, ChevronDownIcon } from '@lucide/svelte';

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

	let hasDeletionTags = $derived($deleteTags.size > 0);

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
		}
	]);

	let extensionItems = $derived(
		$extensionRegistry.extensions
			.filter((e) => $extensionRegistry.enabledIds.has(e.id))
			.flatMap((e) => e.exportMenuItems ?? [])
	);
	let allItems = $derived([...builtinItems, ...extensionItems]);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				class="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
