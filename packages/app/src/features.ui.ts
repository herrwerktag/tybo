import type { Store } from "./legacy/core/index.js";
import type { Page } from "./shared/ui/index.js";
import { ANALYSES_PAGE } from "./features/analyses/ui.js";

export * from "./features/analyses/ui.js";

/**
 * The features' parts of the UI, in one place: a feature joins with a line here, and leaves without a trace by
 * its line going.
 */

/** The features' pages, their tabs in this order after the data and the boards. */
export const PAGES: readonly Page<Store>[] = [ANALYSES_PAGE];
