<script lang="ts">
	import './layout.css';
	import { currentStep, completedSteps, isRunning, cliVersion, healthStatus } from '$lib/stores';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import type { WorkflowStep } from '$lib/stores';

	let { children } = $props();

	const steps: { id: WorkflowStep; label: string; icon: string }[] = [
		{ id: 'select', label: 'Select', icon: '📁' },
		{ id: 'scan', label: 'Scan', icon: '🔍' },
		{ id: 'checksum', label: 'Checksum', icon: '🔐' },
		{ id: 'export', label: 'Export', icon: '📤' }
	];

	function getStepState(stepId: WorkflowStep): 'completed' | 'active' | 'pending' {
		if ($completedSteps.includes(stepId)) return 'completed';
		if ($currentStep === stepId) return 'active';
		return 'pending';
	}
</script>

<div class="flex min-h-screen flex-col bg-background">
	<!-- Header -->
	<header class="sticky top-0 z-50 border-b bg-card">
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
			<!-- Logo -->
			<div class="flex items-center gap-3">
				<div class="flex items-center gap-2">
					<span class="text-2xl">📂</span>
					<span class="text-xl font-bold text-primary">Archifiltre</span>
				</div>
				<Badge variant="secondary">v5</Badge>
			</div>

			<!-- Steps Navigation -->
			<nav class="hidden items-center gap-1 md:flex">
				{#each steps as step, index}
					{@const state = getStepState(step.id)}
					<div class="flex items-center gap-2 px-3 py-1.5">
						<div
							class="flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold transition-colors
								{state === 'completed' ? 'bg-green-500 text-white' : ''}
								{state === 'active' ? 'bg-primary text-primary-foreground' : ''}
								{state === 'pending' ? 'bg-muted text-muted-foreground' : ''}"
						>
							{#if state === 'completed'}
								✓
							{:else}
								{index + 1}
							{/if}
						</div>
						<span
							class="text-sm font-medium
								{state === 'active' ? 'text-primary' : ''}
								{state === 'completed' ? 'text-foreground' : ''}
								{state === 'pending' ? 'text-muted-foreground' : ''}"
						>
							{step.label}
						</span>
					</div>
					{#if index < steps.length - 1}
						<div
							class="h-0.5 w-8 transition-colors
								{state === 'completed' ? 'bg-green-500' : 'bg-border'}"
						></div>
					{/if}
				{/each}
			</nav>

			<!-- Status -->
			<div class="flex items-center gap-2">
				{#if $isRunning}
					<Badge variant="outline" class="gap-1.5">
						<span class="h-2 w-2 animate-pulse rounded-full bg-blue-500"></span>
						Processing...
					</Badge>
				{:else if $healthStatus === 'healthy'}
					<Badge variant="outline" class="gap-1.5 text-green-600">
						<span class="h-2 w-2 rounded-full bg-green-500"></span>
						Ready
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
	<main class="flex-1 px-6 py-8">
		<div class="mx-auto max-w-4xl">
			{@render children()}
		</div>
	</main>

	<!-- Footer -->
	<footer class="border-t bg-card">
		<div class="mx-auto flex max-w-6xl items-center justify-center gap-2 px-6 py-4 text-sm text-muted-foreground">
			<span>République française – Ministère de la Culture</span>
			<Separator orientation="vertical" class="h-4" />
			<span>Programme VITAM</span>
			{#if $cliVersion}
				<Separator orientation="vertical" class="h-4" />
				<span class="font-mono">{$cliVersion}</span>
			{/if}
		</div>
	</footer>
</div>
