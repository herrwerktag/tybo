import { readPreference, writePreference } from "../../shared/ui/index.js";

/** Light or dark colors; "system" follows the operating system (prefers-color-scheme in app.css). */
export type Theme = "system" | "light" | "dark";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

const THEME_KEY = "ui-theme";

function initialTheme(): Theme {
	const saved = readPreference(THEME_KEY);
	return THEMES.includes(saved as Theme) ? (saved as Theme) : "system";
}

/** The chosen theme, shown as `data-theme` on <html> (absent for "system"). */
export let theme: Theme = initialTheme();
applyTheme();

function applyTheme(): void {
	if (theme === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = theme;
}

export function setTheme(next: Theme): void {
	theme = next;
	applyTheme();
	writePreference(THEME_KEY, next);
}
