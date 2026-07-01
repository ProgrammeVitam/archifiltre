<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> = $props();
</script>

<span
	bind:this={ref}
	data-slot="menubar-shortcut"
	class={cn('ml-auto pl-4 text-[10px] tracking-widest text-muted-foreground/70', className)}
	{...restProps}
>
	{@render children?.()}
</span>
