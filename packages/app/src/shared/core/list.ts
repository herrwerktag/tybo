/** Returns a copy of the list with the item at `from` moved to index `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
	const result = [...items];
	const [item] = result.splice(from, 1);
	if (item !== undefined) result.splice(Math.max(0, Math.min(to, result.length)), 0, item);
	return result;
}
