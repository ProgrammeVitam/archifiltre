<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		orientation = 'horizontal',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		orientation?: 'horizontal' | 'vertical';
	} = $props();
</script>

<!--
	A connected cluster of buttons: inner adjacent corners are squared and doubled
	borders are collapsed so the children read as one segmented control. Put `Button`s
	(or any bordered controls) inside. shadcn-svelte convention.
-->
<div
	bind:this={ref}
	role="group"
	data-slot="button-group"
	data-orientation={orientation}
	class={cn(
		'inline-flex w-fit items-stretch [&>*]:relative [&>*:focus-visible]:z-10',
		orientation === 'horizontal'
			? '[&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none [&>*:not(:first-child)]:-ml-px'
			: 'flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:last-child)]:rounded-b-none [&>*:not(:first-child)]:-mt-px',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
