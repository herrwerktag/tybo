import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The directions imports may take (see the README): dependencies point down only, so a feature can be taken out
 * without touching the code below it.
 *
 * - `shared/core` imports nothing but itself; `shared/ui`, `shared/api` and `shared/mcp` import themselves and
 *   `shared/core`.
 * - A feature imports `shared/`, itself, and the features it builds on (FEATURES_BELOW) — nothing of the app put
 *   together in `features.*.ts` above it, not even types: it works with the store of the features below it
 *   (e.g. `DataStore`, `BoardStore`).
 * - Tests and their helpers (`*.test.ts`, `test-*.ts`) may also use the app as a whole: `features.*.ts` and the
 *   helpers at the root.
 * - The root (`features.*.ts`, the package's entries, the app's own tests) puts everything together.
 */
const FEATURES_BELOW: Record<string, readonly string[]> = {
	data: [],
	analyses: ["data"],
	boards: ["data"],
	drawings: ["data", "boards"],
	exports: ["data", "boards", "drawings"],
	history: [],
};

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [relative(SRC, path)] : [];
	});
}

/** The files a file's relative imports and re-exports name. */
function importsOf(file: string): string[] {
	const source = readFileSync(join(SRC, file), "utf8");
	const statements = source.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+"(\.[^"]+)";|^import\s+"(\.[^"]+)";/gms);
	return [...statements].map(([, path, sideEffect]) => relative(SRC, join(SRC, dirname(file), (path ?? sideEffect)!)).replace(/\.js$/, ".ts"));
}

/** Where a file belongs: `shared/core`, a feature (`features/boards`), or the root. */
function area(file: string): string {
	const [top, sub] = file.split("/");
	return top === "shared" || top === "features" ? `${top}/${sub}` : "root";
}

const isTest = (file: string) => /(^|\/)(test-[^/]*|[^/]*\.test)\.ts$/.test(file);

/** Why the import of `target` from `file` goes the wrong way, or null when it may. */
function violation(file: string, target: string): string | null {
	const from = area(file);
	const to = area(target);
	if (from === to || from === "root") return null;
	if (from === "shared/core") return "shared/core imports nothing but itself";
	if (from.startsWith("shared/")) return to === "shared/core" ? null : `${from} imports only itself and shared/core`;
	const feature = from.slice("features/".length);
	if (to.startsWith("shared/")) return null;
	if (to.startsWith("features/")) {
		const other = to.slice("features/".length);
		return FEATURES_BELOW[feature]?.includes(other)
			? null
			: `${feature} doesn't build on ${other} (FEATURES_BELOW): import from below, or decide that it does — see CLAUDE.md`;
	}
	if (isTest(file)) return null;
	return `${feature} imports the app put together above it: use what the features below it give (e.g. their store type)`;
}

test("every feature is listed with the features it builds on", () => {
	const features = readdirSync(join(SRC, "features"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	const listed = Object.keys(FEATURES_BELOW);
	const problems = [
		...features
			.filter((name) => !listed.includes(name))
			.map((name) => `features/${name} is missing in FEATURES_BELOW: add it with the features it builds on — a design decision, see CLAUDE.md`),
		...listed.filter((name) => !features.includes(name)).map((name) => `FEATURES_BELOW lists ${name}, which isn't a feature (any more)`),
	];
	assert.deepEqual(problems, []);
});

test("imports point down only: shared below the features, a feature below the ones building on it", () => {
	const wrong = sourceFiles(SRC).flatMap((file) =>
		importsOf(file).flatMap((target) => {
			const why = violation(file, target);
			return why ? [`${file} → ${target}: ${why}`] : [];
		}),
	);
	assert.deepEqual(wrong, []);
});
