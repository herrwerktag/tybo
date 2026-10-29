import { readPreference, writePreference } from "../../../shared/ui/index.js";

const WRAP_REFERENCES_KEY = "wrap-references";

/** Whether references on cards wrap into more lines instead of being cut off with …; shown as `data-wrap-references`
 * on <html>. */
export let wrapReferences = readPreference(WRAP_REFERENCES_KEY) === "true";
applyWrapReferences();

function applyWrapReferences(): void {
	if (wrapReferences) document.documentElement.dataset.wrapReferences = "";
	else delete document.documentElement.dataset.wrapReferences;
}

export function setWrapReferences(next: boolean): void {
	wrapReferences = next;
	applyWrapReferences();
	writePreference(WRAP_REFERENCES_KEY, String(next));
}
