<script lang="ts">
	import { Separator } from "$lib/components/ui/separator";
	import { cn } from "$lib/utils.js";
	let { class: className }: { class?: string } = $props();
</script>

<Separator data-slot="item-separator" class={cn("my-0", className)} />
