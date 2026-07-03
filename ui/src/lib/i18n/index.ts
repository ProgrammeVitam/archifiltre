/**
 * Internationalization for the SvelteKit app (English, French, German).
 *
 * Runtime-based (svelte-i18n) rather than compile-time on purpose: extensions are
 * registered at runtime, so they must be able to register their own translations
 * too — see `addMessages` re-exported below. Dictionaries are bundled and added
 * synchronously, so `$_` works on first paint with no loading flash.
 *
 * Language resolution: an explicit user choice (persisted in localStorage) wins;
 * otherwise we follow the OS/browser locale; otherwise English.
 */
import { addMessages, init, locale, _, isLoading } from 'svelte-i18n';
import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';

export const SUPPORTED_LOCALES = ['en', 'fr', 'de'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
/** A user preference: a specific locale, or 'system' to follow the OS. */
export type LocalePref = Locale | 'system';

const STORAGE_KEY = 'archifiltre-locale';
const FALLBACK: Locale = 'en';

addMessages('en', en);
addMessages('fr', fr);
addMessages('de', de);

function isLocale(v: unknown): v is Locale {
	return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/** The OS/browser locale, narrowed to a supported one (else English). */
function detectSystemLocale(): Locale {
	try {
		const nav = navigator?.language ?? '';
		const base = nav.slice(0, 2).toLowerCase();
		if (isLocale(base)) return base;
	} catch {
		/* no navigator (prerender) */
	}
	return FALLBACK;
}

/** The stored preference ('system' when unset). */
export function getStoredLocalePref(): LocalePref {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		if (v === 'system' || isLocale(v)) return v;
	} catch {
		/* no localStorage (prerender) */
	}
	return 'system';
}

/** Resolve a preference to a concrete, supported locale. */
export function resolveLocale(pref: LocalePref): Locale {
	return pref === 'system' ? detectSystemLocale() : pref;
}

// Initialize once, synchronously — dictionaries are bundled, so no async wait.
init({ fallbackLocale: FALLBACK, initialLocale: resolveLocale(getStoredLocalePref()) });

/** Change the language preference: persist it and apply it live (no reload). */
export function setLocalePref(pref: LocalePref): void {
	try {
		localStorage.setItem(STORAGE_KEY, pref);
	} catch {
		/* ignore */
	}
	locale.set(resolveLocale(pref));
}

// Re-exported so components trigger init on import and share one instance.
// `addMessages` lets extensions register their own translations at runtime.
export { _, locale, isLoading, addMessages };
