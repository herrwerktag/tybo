import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin } from "vite";

const STANDALONE_VIEW = "virtual:standalone-view";

/**
 * `virtual:standalone-view`: the viewer for exported boards (src/standalone.ts) built into one script, with the
 * styles inside, as a string the app writes into the HTML files it exports.
 */
function standaloneView(): Plugin {
	const resolved = `\0${STANDALONE_VIEW}`;
	return {
		name: "standalone-view",
		resolveId: (id) => (id === STANDALONE_VIEW ? resolved : null),
		async load(id) {
			if (id !== resolved) return null;
			const entry = fileURLToPath(new URL("./src/standalone.ts", import.meta.url));
			this.addWatchFile(entry);
			const output = await build({
				configFile: false,
				logLevel: "warn",
				root: fileURLToPath(new URL(".", import.meta.url)),
				build: {
					write: false,
					lib: { entry, formats: ["iife"], name: "tyboView" },
				},
			});
			const [result] = Array.isArray(output) ? output : [output];
			const chunk = result && "output" in result ? result.output.find((o) => o.type === "chunk") : undefined;
			if (!chunk) throw new Error("the standalone view wasn't built");
			return `export default ${JSON.stringify(chunk.code)};`;
		},
	};
}

export default defineConfig({ plugins: [standaloneView()] });
