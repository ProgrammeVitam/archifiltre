<script lang="ts">
	import type { Job } from '$lib/jobs';
	import { jobsStore } from '$lib/jobs';
	import { pauseJob, resumeJob, cancelJob } from '$lib/tauri';
	import { Progress } from '$lib/components/ui/progress';
	import {
		LoaderCircleIcon,
		CircleCheckIcon,
		CircleAlertIcon,
		PauseIcon,
		PlayIcon,
		XIcon,
		MinusIcon
	} from '@lucide/svelte';

	let { job }: { job: Job } = $props();

	let progressPct = $derived(
		job.progress !== null && job.total !== null && job.total > 0
			? Math.round((job.progress / job.total) * 100)
			: null
	);

	async function handlePause() {
		await pauseJob(job.id);
	}
	async function handleResume() {
		await resumeJob(job.id);
	}
	async function handleCancel() {
		await cancelJob(job.id);
	}
	function handleDismiss() {
		jobsStore.dismiss(job.id);
	}
</script>

<div
	class="flex items-start gap-2 rounded-md border p-2 transition-colors {job.status === 'complete'
		? 'opacity-70'
		: ''} {job.status === 'error' ? 'border-destructive/30' : 'border-white/[0.08]'} bg-white/[0.04]"
>
	<div class="shrink-0 pt-px">
		{#if job.status === 'running'}
			<LoaderCircleIcon size={14} class="animate-spin text-blue-400" />
		{:else if job.status === 'paused'}
			<PauseIcon size={14} class="text-yellow-400" />
		{:else if job.status === 'complete'}
			<CircleCheckIcon size={14} class="text-green-400" />
		{:else if job.status === 'error'}
			<CircleAlertIcon size={14} class="text-red-400" />
		{:else}
			<MinusIcon size={14} class="text-muted-foreground" />
		{/if}
	</div>

	<div class="flex min-w-0 flex-1 flex-col gap-[3px]">
		<div class="truncate text-xs font-medium text-foreground/90">{job.label}</div>
		{#if job.status === 'error' && job.error}
			<div class="truncate text-[11px] text-red-300/90">{job.error}</div>
		{:else if job.detail}
			<div class="truncate text-[11px] text-muted-foreground">{job.detail}</div>
		{:else if job.status === 'complete'}
			<div class="text-[11px] text-green-400/70">Done</div>
		{/if}
		{#if progressPct !== null}
			<Progress value={progressPct} max={100} class="mt-0.5 h-[3px]!" />
		{:else if job.status === 'running'}
			<Progress value={null} max={100} class="mt-0.5 h-[3px]!" />
		{/if}
	</div>

	<div class="flex shrink-0 gap-0.5">
		{#if job.status === 'running'}
			<button
				class="flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent text-white/50 transition-colors hover:bg-white/10 hover:text-white/90"
				title="Pause"
				onclick={handlePause}
			>
				<PauseIcon size={12} />
			</button>
			<button
				class="flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent text-white/50 transition-colors hover:bg-destructive/20 hover:text-red-300/90"
				title="Cancel"
				onclick={handleCancel}
			>
				<XIcon size={12} />
			</button>
		{:else if job.status === 'paused'}
			<button
				class="flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent text-white/50 transition-colors hover:bg-white/10 hover:text-white/90"
				title="Resume"
				onclick={handleResume}
			>
				<PlayIcon size={12} />
			</button>
			<button
				class="flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent text-white/50 transition-colors hover:bg-destructive/20 hover:text-red-300/90"
				title="Cancel"
				onclick={handleCancel}
			>
				<XIcon size={12} />
			</button>
		{:else}
			<button
				class="flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent text-white/50 transition-colors hover:bg-white/10 hover:text-white/90"
				title="Dismiss"
				onclick={handleDismiss}
			>
				<XIcon size={12} />
			</button>
		{/if}
	</div>
</div>
