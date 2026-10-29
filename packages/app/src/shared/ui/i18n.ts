import { readPreference, writePreference } from "./preferences.js";

export type Language = "en" | "de";

/** Each language is listed by its own name, so it's recognizable whatever the current language. */
export const LANGUAGES: readonly { code: Language; name: string }[] = [
	{ code: "en", name: "English" },
	{ code: "de", name: "Deutsch" },
];

const LANGUAGE_KEY = "ui-language";

function initialLanguage(): Language {
	const saved = readPreference(LANGUAGE_KEY);
	if (saved === "en" || saved === "de") return saved;
	// First visit: follow the browser.
	return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

/** The current UI language; an ES module binding, so importers always see the current value. */
export let language: Language = initialLanguage();
document.documentElement.lang = language;

const switchers: ((next: Language) => void)[] = [];

/**
 * A set of messages in every language, as one object holding the current language's: each part of the UI keeps
 * its own (`text.someMessage`), and setLanguage swaps them all.
 */
export function messages<M extends object>(byLanguage: Record<Language, M>): M {
	const current = { ...byLanguage[language] };
	switchers.push((next) => Object.assign(current, byLanguage[next]));
	return current;
}

export function setLanguage(next: Language): void {
	language = next;
	for (const switchTo of switchers) switchTo(next);
	document.documentElement.lang = next;
	writePreference(LANGUAGE_KEY, next);
}
