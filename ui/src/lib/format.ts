/**
 * Locale-aware formatting for sizes, counts and dates.
 *
 * These are exposed as DERIVED STORES that wrap the current i18n `locale`, so any
 * `{$fmtBytes(n)}` / `{$fmtDate(t)}` in a template re-runs when the language changes —
 * no reload, and no need to thread the locale through every call site.
 *
 * French uses octet units (o/Ko/Mo/Go/To) and a comma decimal; German keeps B/KB/MB…
 * but with a comma decimal; both put a non-breaking space before the unit. Numbers and
 * dates go through the platform Intl APIs with the active locale.
 */
import { derived } from 'svelte/store';
import { locale } from '$lib/i18n';

const NBSP = ' ';

function sizeUnits(loc: string): string[] {
	// French archival convention: octets. Everyone else: bytes.
	return loc.startsWith('fr')
		? ['o', 'Ko', 'Mo', 'Go', 'To', 'Po']
		: ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
}

/** Human-readable byte size in the given locale (comma decimal + localized unit). */
export function formatBytesLocale(bytes: number, loc: string): string {
	const units = sizeUnits(loc);
	if (!bytes || bytes <= 0) return `0${NBSP}${units[0]}`;
	const k = 1024;
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
	const value = bytes / Math.pow(k, i);
	const num = new Intl.NumberFormat(loc, {
		maximumFractionDigits: i > 0 ? 1 : 0,
		minimumFractionDigits: 0
	}).format(value);
	return `${num}${NBSP}${units[i]}`;
}

/** Integer count with locale thousands grouping (e.g. 69 173 / 69.173 / 69,173). */
export function formatNumberLocale(n: number, loc: string): string {
	return new Intl.NumberFormat(loc).format(n);
}

/** A unix timestamp (seconds OR ms) as a localized date-time, or null when absent. */
export function formatDateLocale(timestamp: number | undefined | null, loc: string): string | null {
	if (timestamp === undefined || timestamp === null || timestamp === 0) return null;
	const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
	return new Intl.DateTimeFormat(loc, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	}).format(new Date(ms));
}

/** Short date (no time) — for dense rows like the list view. */
export function formatDateShortLocale(timestamp: number | undefined | null, loc: string): string {
	if (!timestamp) return '';
	const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
	return new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'short', day: 'numeric' }).format(
		new Date(ms)
	);
}

const resolve = (l: string | null | undefined) => l || 'en';

/** Reactive formatters bound to the active locale — use `{$fmtBytes(n)}` etc. */
export const fmtBytes = derived(locale, ($l) => (b: number) => formatBytesLocale(b, resolve($l)));
export const fmtNum = derived(locale, ($l) => (n: number) => formatNumberLocale(n, resolve($l)));
export const fmtDate = derived(
	locale,
	($l) => (t: number | undefined | null) => formatDateLocale(t, resolve($l))
);
export const fmtDateShort = derived(
	locale,
	($l) => (t: number | undefined | null) => formatDateShortLocale(t, resolve($l))
);
