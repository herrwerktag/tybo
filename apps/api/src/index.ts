import { createApp, portFromEnv } from "./http.js";
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
