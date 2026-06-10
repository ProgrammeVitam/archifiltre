<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { extensionRegistry } from '$lib/extensions/registry';
	import { Settings as SettingsIcon } from '@lucide/svelte';

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

<Dialog.Root>
	<Dialog.Trigger
		class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
		title="Settings"
	>
		<SettingsIcon size={16} />
	</Dialog.Trigger>

	<Dialog.Content portalProps={{ to: '#app-window' }} class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Settings</Dialog.Title>
			<Dialog.Description>Enable or disable features. Preferences are saved automatically.</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-2 py-2">
			{#each extensions as ext (ext.id)}
				<div class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
					<div class="min-w-0 flex-1">
						<Label for={ext.id} class="cursor-pointer text-sm font-medium">{ext.name}</Label>
						<p class="mt-0.5 text-xs text-muted-foreground">{ext.description}</p>
					</div>
					<Switch
						id={ext.id}
						checked={ext.enabled}
						onCheckedChange={(checked) => toggleExtension(ext.id, checked)}
					/>
				</div>
			{/each}
		</div>
	</Dialog.Content>
</Dialog.Root>
