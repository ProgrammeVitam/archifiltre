<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils.js";
	let { ref = $bindable(null), class: className, children, ...restProps }: WithElementRef<HTMLAttributes<HTMLParagraphElement>> = $props();
</script>

<p bind:this={ref} data-slot="item-description" class={cn("text-sm leading-normal text-muted-foreground", className)} {...restProps}>
	{@render children?.()}
</p>
