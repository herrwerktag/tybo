import { createApp, portFromEnv } from "./http.js";
import { describeMigration } from "./migrate.js";
import { APP_KEY } from "./mirror.js";
import { postgresStorage } from "./postgres.js";

// The URL comes only from the environment, and leaves it only into the driver.
const url = process.env.DATABASE_URL;
if (!url) {
	console.error("DATABASE_URL isn't set — the server needs it to reach Postgres.");
	process.exit(1);
}

const storage = postgresStorage(url);
try {
	await storage.init();
} catch {
	// What went wrong stays out — errors about connecting can quote parts of the URL.
	console.error("The Postgres database isn't reachable.");
	process.exit(1);
}

// The one-time move of the app's blob into the addressable tables. It starts from the blob and never
// writes back, so however it goes, the app's data stays safe where it was. A failed run is reported and
// the server keeps running — the app goes on reading and writing the blob exactly as before.
try {
	const result = await storage.migrateBlob(await storage.getItem(APP_KEY));
	console.log(`Migration of the app data — ${describeMigration(result)}`);
} catch {
	console.error("Migrating the app data into the addressable tables failed — the blob in texts stays the source of truth.");
}

const server = createApp(storage);
const port = portFromEnv(process.env.PORT);
server.listen(port, () => {
	console.log(`The bekbon API is listening on port ${port}.`);
});

function stop(signal: string): void {
	server.close(() => console.log(`${signal} received: the API is closed.`));
	server.closeAllConnections();
	void storage.close().finally(() => process.exit(0));
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
