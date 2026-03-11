<script lang="ts">
	import './layout.css';
	import { appState, cliVersion, healthStatus, isRunning } from '$lib/stores';
	import { Badge } from '$lib/components/ui/badge';

	let { children } = $props();
</script>

<div class="flex min-h-screen flex-col bg-background">
	<!-- Header -->
	<header class="sticky top-0 z-50 border-b bg-card">
		<div class="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
			<!-- Logo -->
			<div class="flex items-center gap-3">
				<div class="flex items-center gap-2">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 101 78" class="h-8 w-auto">
						<rect x="0" y="0" width="101" height="25" fill="#FCBF40" />
						<rect x="0" y="27" width="41" height="26" fill="#FCBF40" />
						<rect x="43" y="27" width="14" height="26" fill="#FC5745" />
						<rect x="59" y="27" width="12" height="26" fill="#FCBF40" />
						<rect x="73" y="27" width="10" height="26" fill="#BA77EB" />
						<rect x="85" y="27" width="6" height="26" fill="#477BE2" />
						<rect x="93" y="27" width="5" height="26" fill="#FB4B36" />
						<rect x="100" y="27" width="1" height="26" fill="#3BD041" />
						<rect x="0" y="55" width="19" height="23" fill="#40D145" />
						<rect x="21" y="55" width="12" height="23" fill="#00D8F0" />
						<rect x="35" y="55" width="10" height="23" fill="#FC5745" />
						<rect x="59" y="55" width="12" height="23" fill="#477BE2" />
					</svg>
					<span class="text-xl font-bold text-primary">Archifiltre</span>
				</div>
				<Badge variant="secondary">v5</Badge>
			</div>

			<!-- Status (only show when scanning or error) -->
			<div class="flex items-center gap-3">
				{#if $appState === 'scanning'}
					<Badge variant="outline" class="gap-1.5">
						<span class="h-2 w-2 animate-pulse rounded-full bg-blue-500"></span>
						Scanning...
					</Badge>
				{:else if $healthStatus === 'unhealthy'}
					<Badge variant="destructive" class="gap-1.5">
						<span class="h-2 w-2 rounded-full bg-red-500"></span>
						Error
					</Badge>
				{/if}
			</div>
		</div>
	</header>

	<!-- Main Content -->
	<main class="flex-1 pt-8">
		{@render children()}
	</main>
</div>
