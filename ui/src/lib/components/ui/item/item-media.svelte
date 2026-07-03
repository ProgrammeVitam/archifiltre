<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils.js";
	type Variant = "default" | "icon" | "image";
	let { ref = $bindable(null), class: className, variant = "default", children, ...restProps }: WithElementRef<HTMLAttributes<HTMLDivElement>> & { variant?: Variant } = $props();
	const variants: Record<Variant, string> = {
		default: "",
		icon: "size-8 rounded-md border bg-muted text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
		image: "size-10 overflow-hidden rounded-md"
	};
</script>

<div bind:this={ref} data-slot="item-media" class={cn("flex shrink-0 items-center justify-center gap-2 [&_svg]:pointer-events-none", variants[variant], className)} {...restProps}>
	{@render children?.()}
</div>
