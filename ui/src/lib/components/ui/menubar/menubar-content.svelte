<script lang="ts">
	import { Menubar as MenubarPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		align = 'start',
		sideOffset = 6,
		...restProps
	}: MenubarPrimitive.ContentProps = $props();
</script>

<MenubarPrimitive.Portal>
	<MenubarPrimitive.Content
		bind:ref
		data-slot="menubar-content"
		{align}
		{sideOffset}
		class={cn(
			'z-[200] min-w-[180px] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-2xl backdrop-blur-xl',
			className
		)}
		{...restProps}
	/>
</MenubarPrimitive.Portal>
