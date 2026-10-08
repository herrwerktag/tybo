import { resolve } from "node:path";
import { createApp, portFromEnv } from "./http.js";
import { postgresStorage } from "./postgres.js";
import { sqliteStorage } from "./sqlite.js";

// LOCAL_DB_PATH runs the API on a local SQLite file instead of Postgres. A relative path is taken from where
// pnpm was started (INIT_CWD), not from this package's folder.
const localPath = process.env.LOCAL_DB_PATH;
// The URL comes only from the environment, and leaves it only into the driver.
const url = process.env.DATABASE_URL;
if (!localPath && !url) {
	console.error("DATABASE_URL isn't set — the server needs it to reach Postgres (or LOCAL_DB_PATH for a local SQLite file).");
	process.exit(1);
}

const storage = localPath ? sqliteStorage(resolve(process.env.INIT_CWD ?? process.cwd(), localPath)) : postgresStorage(url!);
try {
	const ran = await storage.init();
	if (localPath) console.log(`Using the local SQLite database ${localPath}.`);
	if (ran.length > 0) console.log(`The schema was brought up to date (steps ${ran.join(", ")}).`);
} catch {
	// What went wrong stays out — errors about connecting can quote parts of the URL. Whether it was the
	// connection or a step of the schema, the step left the schema as it was.
	console.error(localPath
		? "The local SQLite database couldn't be opened, or its schema couldn't be brought up to date."
		: "The Postgres database isn't reachable, or its schema couldn't be brought up to date.");
	process.exit(1);
}

const server = createApp(storage);
const port = portFromEnv(process.env.PORT);
server.listen(port, () => {
	console.log(`The tybo API is listening on port ${port}.`);
});

function stop(signal: string): void {
	server.close(() => console.log(`${signal} received: the API is closed.`));
	server.closeAllConnections();
	void storage.close().finally(() => process.exit(0));
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
