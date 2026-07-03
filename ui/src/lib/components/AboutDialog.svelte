<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { aboutOpen } from '$lib/stores';
	import { getVersion } from '$lib/tauri';

	let version = $state('');
	// Load the app version lazily the first time the dialog opens.
	$effect(() => {
		if ($aboutOpen && !version) {
			getVersion()
				.then((r) => (version = r?.output?.trim() ?? ''))
				.catch(() => (version = ''));
		}
	});
</script>

<Dialog.Root bind:open={$aboutOpen}>
	<Dialog.Content portalProps={{ to: '#app-window' }} class="sm:max-w-sm">
		<div class="flex flex-col items-center gap-2 py-4 text-center">
			<img src="/logo.svg" alt="Archifiltre" class="h-12 w-12" onerror={(e) => (e.currentTarget.style.display = 'none')} />
			<div class="text-lg font-semibold">Archifiltre</div>
			{#if version}<div class="text-xs text-muted-foreground">v{version}</div>{/if}
			<a
				href="https://www.archifiltre.org"
				target="_blank"
				rel="noreferrer"
				class="mt-1 text-xs text-[color:var(--color-primary,#2563eb)] hover:underline"
			>
				archifiltre.org
			</a>
		</div>
	</Dialog.Content>
</Dialog.Root>
