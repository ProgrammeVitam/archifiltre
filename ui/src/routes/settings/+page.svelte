<script lang="ts">
	import { extensionRegistry } from '$lib/extensions/registry';
	import { PuzzleIcon, PlusIcon } from '@lucide/svelte';

	let extensions = $derived(
		$extensionRegistry.extensions.map((e) => ({
			...e,
			enabled: $extensionRegistry.enabledIds.has(e.id)
		}))
	);

	function toggleExtension(id: string, enabled: boolean) {
		extensionRegistry.setEnabled(id, enabled);
	}
</script>

<div class="mx-auto max-w-2xl p-8 text-foreground/85">
	<div class="mb-7 flex items-center gap-2.5">
		<PuzzleIcon size={20} />
		<h1 class="m-0 text-xl font-semibold">Extensions</h1>
	</div>

	{#if extensions.length === 0}
		<p class="text-sm text-muted-foreground">No extensions registered.</p>
	{:else}
		<div class="mb-7 flex flex-col gap-2">
			{#each extensions as ext (ext.id)}
				<div
					class="flex items-center justify-between gap-4 rounded-lg border border-white/[0.08] bg-white/[0.04] px-4 py-3.5"
				>
					<div class="min-w-0 flex-1">
						<div class="mb-[3px] text-sm font-medium">{ext.name}</div>
						<div class="mb-[3px] text-xs text-white/50">{ext.description}</div>
						<div class="font-mono text-[11px] text-white/30">ID: {ext.id}</div>
					</div>
					<label
						class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center"
						title={ext.enabled ? 'Disable extension' : 'Enable extension'}
					>
						<input
							type="checkbox"
							class="peer sr-only"
							checked={ext.enabled}
							onchange={(e) => toggleExtension(ext.id, (e.target as HTMLInputElement).checked)}
						/>
						<div
							class="h-5 w-9 rounded-full bg-white/15 transition-colors peer-checked:bg-blue-500/80 after:absolute after:left-[3px] after:top-[3px] after:h-[14px] after:w-[14px] after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
						></div>
					</label>
				</div>
			{/each}
		</div>
	{/if}

	<div class="flex items-center gap-3">
		<button
			class="flex cursor-not-allowed items-center gap-1.5 rounded-md border border-white/15 bg-transparent px-3.5 py-2 text-[13px] text-white/50 opacity-50"
			disabled
			title="Coming in a future version"
		>
			<PlusIcon size={14} />
			Import extension
		</button>
		<span class="text-xs text-white/35">Dynamic extension loading is coming in a future version.</span>
	</div>
</div>
