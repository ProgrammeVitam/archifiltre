<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils.js";

	type Variant = "default" | "outline" | "muted";
	type Size = "default" | "sm";
	let {
		ref = $bindable(null),
		class: className,
		variant = "default",
		size = "default",
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { variant?: Variant; size?: Size } = $props();

	const variants: Record<Variant, string> = {
		default: "border-transparent",
		outline: "border-border",
		muted: "border-transparent bg-muted/50"
	};
	const sizes: Record<Size, string> = {
		default: "gap-4 p-4",
		sm: "gap-2.5 px-4 py-3"
	};
</script>

<div
	bind:this={ref}
	data-slot="item"
	class={cn(
		"group/item flex flex-wrap items-center rounded-md border text-sm outline-none transition-colors",
		variants[variant],
		sizes[size],
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
