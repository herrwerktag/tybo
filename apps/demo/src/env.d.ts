/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Where the storage API (apps/api) answers, e.g. http://localhost:3001 — set when starting Vite
	 * (VITE_API_URL=…, or in apps/demo/.env). The demo keeps its data there, in Postgres, and nowhere else. */
	readonly VITE_API_URL?: string;
}

/** The viewer for exported boards, built into one script (see vite.config.ts). */
declare module "virtual:standalone-view" {
	const script: string;
	export default script;
}
