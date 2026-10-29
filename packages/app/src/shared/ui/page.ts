/** A page of its own in the app, with its tab in the top bar: what a feature shows the workspace's data in. */
export interface Page<S> {
	/** Its address after the "#", e.g. "analysis". */
	route: string;
	/** The tab's name, in the current language. */
	label(): string;
	/** The page, showing the workspace held by `store`. */
	render(store: S): HTMLElement;
}
