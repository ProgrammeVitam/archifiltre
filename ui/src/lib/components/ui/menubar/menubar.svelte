<script lang="ts">
	import { Menubar as MenubarPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		...restProps
	}: MenubarPrimitive.RootProps = $props();
</script>

<!-- Inline menubar bar (File / Edit / View …). Unstyled container — it lives in the
     titlebar, so no border/background box of its own; the triggers carry the styling. -->
<MenubarPrimitive.Root
	bind:ref
	bind:value
	data-slot="menubar"
	class={cn('flex items-center gap-0.5', className)}
	{...restProps}
/>
