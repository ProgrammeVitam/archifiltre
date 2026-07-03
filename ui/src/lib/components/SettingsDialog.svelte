<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { extensionRegistry } from '$lib/extensions/registry';
	import { settingsOpen, windowEffect, lensMode, type LensMode, icicleHeight, type IcicleHeight, llmConfig, type LlmConfig, aiMode, type AiMode } from '$lib/stores';
	import { exportLogsFlow } from '$lib/log-export';
	import { _ } from '$lib/i18n';
	import {
		getStoredLocalePref,
		setLocalePref,
		SUPPORTED_LOCALES,
		type LocalePref
	} from '$lib/i18n';
	import {
		Settings as SettingsIcon,
		SlidersHorizontalIcon,
		PaintbrushIcon,
		SparklesIcon,
		BlocksIcon,
		ChevronDownIcon,
		CheckIcon
	} from '@lucide/svelte';

	/** When false the gear trigger is hidden (opened via the store instead). */
	let { showTrigger = true }: { showTrigger?: boolean } = $props();

	// ── Categories (left rail) ──
	type SectionId = 'general' | 'appearance' | 'ai' | 'extensions';
	const sections: { id: SectionId; labelKey: string; icon: typeof SettingsIcon }[] = [
		{ id: 'general', labelKey: 'settings.general', icon: SlidersHorizontalIcon },
		{ id: 'appearance', labelKey: 'settings.appearance', icon: PaintbrushIcon },
		{ id: 'ai', labelKey: 'settings.ai', icon: SparklesIcon },
		{ id: 'extensions', labelKey: 'settings.extensions', icon: BlocksIcon }
	];
	let active = $state<SectionId>('general');
	let activeLabel = $derived($_(sections.find((s) => s.id === active)!.labelKey));

	// ── General: language ──
	let localePref = $state<LocalePref>(getStoredLocalePref());
	function chooseLocale(pref: LocalePref) {
		localePref = pref;
		setLocalePref(pref);
	}
	const localeOptions: LocalePref[] = ['system', ...SUPPORTED_LOCALES];

	// ── Extensions ──
	let extensions = $derived(
		$extensionRegistry.extensions.map((e) => ({
			...e,
			enabled: $extensionRegistry.enabledIds.has(e.id)
		}))
	);
	function toggleExtension(id: string, enabled: boolean) {
		extensionRegistry.setEnabled(id, enabled);
	}

	// ── AI: provider mode + LLM credentials for the directory-summary feature ──
	function updateLlm(field: keyof LlmConfig, value: string) {
		llmConfig.update((c) => ({ ...c, [field]: value }));
	}
	// WebLLM (in-browser) is planned but disabled for now.
	const aiModes: { id: AiMode; labelKey: string; disabled?: boolean }[] = [
		{ id: 'off', labelKey: 'settings.aiOff' },
		{ id: 'webllm', labelKey: 'settings.aiWebllm', disabled: true },
		{ id: 'external', labelKey: 'settings.aiExternal' }
	];

	const lensModes: { id: LensMode; labelKey: string; hintKey: string }[] = [
		{ id: 'off', labelKey: 'settings.lensOff', hintKey: 'settings.lensOffHint' },
		{ id: 'aggregate', labelKey: 'settings.lensAggregate', hintKey: 'settings.lensAggregateHint' },
		{ id: 'always', labelKey: 'settings.lensAlways', hintKey: 'settings.lensAlwaysHint' }
	];

	const icicleHeights: { id: IcicleHeight; labelKey: string; hintKey: string }[] = [
		{ id: 'small', labelKey: 'settings.heightSmall', hintKey: 'settings.heightSmallHint' },
		{ id: 'comfortable', labelKey: 'settings.heightComfortable', hintKey: 'settings.heightComfortableHint' },
		{ id: 'fill', labelKey: 'settings.heightFill', hintKey: 'settings.heightFillHint' }
	];

	function save() {
		// Settings apply live; Save is the explicit confirmation and closes the dialog.
		settingsOpen.set(false);
	}
</script>

<Dialog.Root bind:open={$settingsOpen}>
	{#if showTrigger}
		<Dialog.Trigger
			class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
			title={$_('settings.title')}
		>
			<SettingsIcon size={16} />
		</Dialog.Trigger>
	{/if}

	<Dialog.Content
		portalProps={{ to: '#app-window' }}
		class="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]"
	>
		<Dialog.Title class="sr-only">{$_('settings.title')}</Dialog.Title>
		<Dialog.Description class="sr-only">{$_('settings.description')}</Dialog.Description>

		<Sidebar.Provider class="items-start">
			<Sidebar.Root collapsible="none" class="hidden md:flex">
				<Sidebar.Content>
					<Sidebar.Group>
						<Sidebar.GroupContent>
							<Sidebar.Menu>
								{#each sections as item (item.id)}
									{@const Icon = item.icon}
									<Sidebar.MenuItem>
										<Sidebar.MenuButton
											isActive={active === item.id}
											onclick={() => (active = item.id)}
										>
											<Icon />
											<span>{$_(item.labelKey)}</span>
										</Sidebar.MenuButton>
									</Sidebar.MenuItem>
								{/each}
							</Sidebar.Menu>
						</Sidebar.GroupContent>
					</Sidebar.Group>
				</Sidebar.Content>
			</Sidebar.Root>

			<main class="flex h-[480px] flex-1 flex-col overflow-hidden">
				<header class="flex h-16 shrink-0 items-center gap-2 border-b px-4">
					<Breadcrumb.Root>
						<Breadcrumb.List>
							<Breadcrumb.Item class="hidden md:block">
								<Breadcrumb.Link>{$_('settings.title')}</Breadcrumb.Link>
							</Breadcrumb.Item>
							<Breadcrumb.Separator class="hidden md:block" />
							<Breadcrumb.Item>
								<Breadcrumb.Page>{activeLabel}</Breadcrumb.Page>
							</Breadcrumb.Item>
						</Breadcrumb.List>
					</Breadcrumb.Root>
				</header>

				<div class="flex flex-1 flex-col gap-4 overflow-y-auto p-4 pt-0">
					{#if active === 'general'}
						<div class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
							<Label class="text-sm font-medium">{$_('settings.language')}</Label>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="outline"
											size="sm"
											class="min-w-[160px] justify-between gap-2 font-normal"
										>
											{localePref === 'system'
												? $_('settings.languageSystem')
												: $_(`lang.${localePref}`)}
											<ChevronDownIcon class="size-4 opacity-60" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="min-w-[160px]">
									{#each localeOptions as opt (opt)}
										<DropdownMenu.Item class="gap-2" onSelect={() => chooseLocale(opt)}>
											<CheckIcon class="size-4 {localePref === opt ? 'opacity-100' : 'opacity-0'}" />
											{opt === 'system' ? $_('settings.languageSystem') : $_(`lang.${opt}`)}
										</DropdownMenu.Item>
									{/each}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>

						<!-- Support bundle: sidecar logs + frontend snapshot as one .zip. -->
						<div class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
							<div class="min-w-0 flex-1">
								<Label class="text-sm font-medium">{$_('settings.exportLogs')}</Label>
								<p class="mt-0.5 text-xs text-muted-foreground">{$_('settings.exportLogsHint')}</p>
							</div>
							<Button variant="outline" size="sm" onclick={() => void exportLogsFlow()}>
								{$_('export.label')}
							</Button>
						</div>
					{:else if active === 'appearance'}
						<div class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
							<div class="min-w-0 flex-1">
								<Label for="window-effect" class="cursor-pointer text-sm font-medium">
									{$_('settings.windowEffect')}
								</Label>
								<p class="mt-0.5 text-xs text-muted-foreground">{$_('settings.windowEffectHint')}</p>
							</div>
							<Switch
								id="window-effect"
								checked={$windowEffect}
								onCheckedChange={(v) => windowEffect.set(v)}
							/>
						</div>
						<div class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
							<div class="min-w-0 flex-1">
								<Label class="text-sm font-medium">{$_('settings.icicleLens')}</Label>
								<p class="mt-0.5 text-xs text-muted-foreground">{$_('settings.icicleLensHint')}</p>
							</div>
							<div class="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
								{#each lensModes as m (m.id)}
									<button
										type="button"
										title={$_(m.hintKey)}
										onclick={() => lensMode.set(m.id)}
										class="rounded-md px-2.5 py-1 text-xs transition-colors {$lensMode === m.id
											? 'bg-background font-medium text-foreground shadow-sm'
											: 'text-muted-foreground hover:text-foreground'}"
									>
										{$_(m.labelKey)}
									</button>
								{/each}
							</div>
						</div>
						<div class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
							<div class="min-w-0 flex-1">
								<Label class="text-sm font-medium">{$_('settings.icicleHeight')}</Label>
								<p class="mt-0.5 text-xs text-muted-foreground">{$_('settings.icicleHeightHint')}</p>
							</div>
							<div class="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
								{#each icicleHeights as m (m.id)}
									<button
										type="button"
										title={$_(m.hintKey)}
										onclick={() => icicleHeight.set(m.id)}
										class="rounded-md px-2.5 py-1 text-xs transition-colors {$icicleHeight === m.id
											? 'bg-background font-medium text-foreground shadow-sm'
											: 'text-muted-foreground hover:text-foreground'}"
									>
										{$_(m.labelKey)}
									</button>
								{/each}
							</div>
						</div>
					{:else if active === 'ai'}
						<!-- Provider mode: Off / WebLLM (disabled) / External -->
						<div class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
							<Label class="text-sm font-medium">{$_('settings.aiProvider')}</Label>
							<div class="flex items-center gap-1 rounded-lg bg-muted p-0.5">
								{#each aiModes as m (m.id)}
									<button
										type="button"
										disabled={m.disabled}
										title={m.disabled ? $_('settings.aiWebllmSoon') : ''}
										onclick={() => !m.disabled && aiMode.set(m.id)}
										class="rounded-md px-2.5 py-1 text-xs transition-colors {$aiMode === m.id
											? 'bg-background font-medium text-foreground shadow-sm'
											: m.disabled
												? 'cursor-not-allowed text-muted-foreground/40'
												: 'text-muted-foreground hover:text-foreground'}"
									>
										{$_(m.labelKey)}
									</button>
								{/each}
							</div>
						</div>

						{#if $aiMode === 'external'}
						<p class="text-xs text-muted-foreground">{$_('settings.aiHint')}</p>
						<div class="flex flex-col gap-4 rounded-lg border px-4 py-4">
							<div class="flex flex-col gap-1.5">
								<Label for="llm-base-url" class="text-sm font-medium">{$_('settings.llmBaseUrl')}</Label>
								<Input
									id="llm-base-url"
									type="url"
									autocomplete="off"
									spellcheck={false}
									placeholder="https://api.openai.com/v1"
									value={$llmConfig.baseUrl}
									oninput={(e) => updateLlm('baseUrl', e.currentTarget.value)}
								/>
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="llm-api-key" class="text-sm font-medium">{$_('settings.llmApiKey')}</Label>
								<Input
									id="llm-api-key"
									type="password"
									autocomplete="off"
									spellcheck={false}
									placeholder="sk-…"
									value={$llmConfig.apiKey}
									oninput={(e) => updateLlm('apiKey', e.currentTarget.value)}
								/>
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="llm-model" class="text-sm font-medium">{$_('settings.llmModel')}</Label>
								<Input
									id="llm-model"
									autocomplete="off"
									spellcheck={false}
									placeholder="llama-3.1-8b-instruct"
									value={$llmConfig.model}
									oninput={(e) => updateLlm('model', e.currentTarget.value)}
								/>
								<p class="text-xs text-muted-foreground">{$_('settings.llmModelHint')}</p>
							</div>
						</div>
						{:else}
							<p class="text-xs text-muted-foreground">{$_('settings.aiOffHint')}</p>
						{/if}
					{:else if active === 'extensions'}
						<p class="text-xs text-muted-foreground">{$_('settings.extensionsHint')}</p>
						{#each extensions as ext (ext.id)}
							<div class="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
								<div class="min-w-0 flex-1">
									<Label for={ext.id} class="cursor-pointer text-sm font-medium">{ext.name}</Label>
									<p class="mt-0.5 text-xs text-muted-foreground">{ext.description}</p>
								</div>
								<Switch
									id={ext.id}
									checked={ext.enabled}
									onCheckedChange={(checked) => toggleExtension(ext.id, checked)}
								/>
							</div>
						{/each}
					{/if}
				</div>
				<!-- Footer: explicit Save (settings also apply live). -->
				<footer class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
					<Button size="sm" onclick={save}>{$_('settings.save')}</Button>
				</footer>
			</main>
		</Sidebar.Provider>
	</Dialog.Content>
</Dialog.Root>
