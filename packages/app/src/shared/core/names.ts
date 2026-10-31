/** What has a name that is unique among its kind in a workspace (a type, a board, an analysis) or among the
 * workspaces: two names are the same when they differ only in case and surrounding spaces. */
export interface Named {
	id: string;
	name: string;
}

export const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** Whether one of `items` other than the one of `selfId` is called `name`. */
export function nameTaken(items: readonly Named[], name: string, selfId: string | null = null): boolean {
	return items.some((item) => item.id !== selfId && sameName(item.name, name));
}

/** The first of `name(1)`, `name(2)` … that none of `items` is called. */
export function freeName(items: readonly Named[], name: (n: number) => string): string {
	for (let n = 1; ; n++) if (!nameTaken(items, name(n))) return name(n);
}

/** A name that another of its kind has already: the change is refused, and nothing is written. */
export class NameTaken extends Error {
	constructor(
		/** What kind of thing it is, as the message names it: "type", "board" … */
		readonly kind: string,
		/** The name given, trimmed. */
		readonly taken: string,
	) {
		super(`There is ${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} "${taken}" already.`);
	}
}

/** Refuses `name` with a `NameTaken` when another of `items` (than `selfId`) has it. */
export function refuseTakenName(kind: string, items: readonly Named[], name: string, selfId: string | null = null): void {
	if (nameTaken(items, name, selfId)) throw new NameTaken(kind, name.trim());
}
