/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Where the storage API (apps/api) answers, e.g. http://localhost:3001 — set when starting Vite
	 * (VITE_API_URL=…), and the demo saves its data there, in Postgres; empty or unset (the standard)
	 * saves in the browser's localStorage, as before. */
	readonly VITE_API_URL?: string;
}
