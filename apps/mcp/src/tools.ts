import {
	CARD_DISPLAYS,
	GRID_SIZE,
	PROPERTY_KINDS,
	createStore,
	entityTags,
	filterEntities,
	layeredLayout,
	missingRequired,
	newReference,
	parseValue,
	pathOptions,
	placeholderProperty,
	referencedIds,
	resolvePath,
	runAnalysis,
	snapToGrid,
	ulid,
	validateType,
	type Analysis,
	type AnalysisGroup,
	type AnalysisRow,
	type AppData,
	type Board,
	type CardDisplay,
	type DataPort,
	type DraftProperty,
	type Entity,
	type EntityType,
	type NewEntity,
	type PathOption,
	type PathStep,
	type PropertyDef,
	type PropertyKind,
	type PropertyValue,
	type Store,
	type ValidationError,
} from "@tybo/core";
import { ToolError, type Tool } from "./protocol.js";

/**
 * The tools a model gets on tybo: read a workspace's types and entities, run its analyses, and make or change
 * types and entities. Each call reads the workspace anew and writes through the core's store — the same rules
 * as the app's forms (`validateType`, `parseValue`), the same change sets to the API.
 *
 * The model names everything the way a person would: workspaces, types, properties and entities by name (or
 * by id where a name is ambiguous), options by their text.
 */
export function tyboTools(port: DataPort): Tool[] {
	/** The store of the workspace `ref` names, read just now. */
	async function open(ref: unknown): Promise<Store> {
		const workspaces = await port.listWorkspaces();
		const wanted = text(ref, "workspace");
		const byId = workspaces.find((w) => w.id === wanted);
		const byName = workspaces.filter((w) => sameName(w.name, wanted));
		const workspace = byId ?? (byName.length === 1 ? byName[0] : undefined);
		if (!workspace) {
			const known = workspaces.map((w) => `${w.name} (${w.id})`).join(", ") || "none";
			throw new ToolError(`${byName.length > 1 ? "Several workspaces are" : "No workspace is"} called "${wanted}". Workspaces: ${known}.`);
		}
		const store = await createStore(port, workspace.id);
		if (store.problems.load?.code === "newerVersion") throw new ToolError("The workspace was saved by a newer version of tybo; update tybo first.");
		if (store.problems.load) throw new ToolError("The workspace couldn't be read.");
		return store;
	}

	/** Waits for the store's saves and says how they went; a failed one is the tool's failure. */
	async function saved(store: Store): Promise<string | null> {
		await store.saved();
		if (store.problems.saveFailed) throw new ToolError("The change couldn't be saved; nothing was written.");
		return store.problems.saveConflict ? "Someone else changed this in between; this change was written over theirs." : null;
	}

	return [
		{
			name: "list_workspaces",
			description: "Lists the tybo workspaces. Every other tool names one of them in `workspace` (by name or id).",
			inputSchema: { type: "object", properties: {} },
			async run() {
				return json(await port.listWorkspaces());
			},
		},
		{
			name: "describe_workspace",
			description:
				"The schema of a workspace: its entity types with their properties (kind, options, which types a reference points to), " +
				"how many entities each type has, the tags in use, the saved analyses and the boards with how many cards each has. " +
				"Read this before creating or changing anything.",
			inputSchema: object({ workspace: WORKSPACE }, ["workspace"]),
			async run(args) {
				const { data } = await open(args.workspace);
				return json({
					types: data.types.map((type) => ({ ...describeType(data, type), entities: data.entities.filter((e) => e.typeId === type.id).length })),
					tags: entityTags(data.entities),
					analyses: data.analyses.map((a) => describeAnalysis(data, a)),
					boards: data.boards.map((b) => ({ id: b.id, name: b.name, cards: b.cards.length })),
				});
			},
		},
		{
			name: "find_entities",
			description:
				"Finds entities by type, by a part of their name (ignoring case and accents), by tag, and by property values " +
				"(`values`: property name → text it contains, option, or name/id of an entity it references; needs `type`), " +
				"and with `missing: true` to those lacking a required reference. " +
				"Answers id, type, name and tags of each (and the required references it lacks); get_entity tells the rest.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					type: { type: "string", description: "Name or id of the entity type." },
					query: { type: "string", description: "Part of the name." },
					tag: { type: "string" },
					values: { type: "object", additionalProperties: { type: "string" } },
					missing: { type: "boolean", description: "Only the entities lacking a required reference." },
					limit: { type: "integer", minimum: 1, description: "At most this many (default 50)." },
				},
				["workspace"],
			),
			async run(args) {
				const { data } = await open(args.workspace);
				const type = args.type === undefined ? null : typeOf(data, args.type);
				let found = filterEntities(data.entities, {
					query: args.query === undefined ? "" : text(args.query, "query"),
					typeId: type?.id ?? null,
					tag: args.tag === undefined ? null : text(args.tag, "tag"),
				});
				if (args.values !== undefined) {
					if (!type) throw new ToolError("Filtering by `values` needs a `type`.");
					for (const [name, wanted] of Object.entries(record(args.values, "values"))) {
						const prop = propertyOf(type, name);
						found = found.filter((e) => valueMatches(data, prop, e.values[prop.id], text(wanted, name)));
					}
				}
				const missing = (e: Entity) => missingRequired(data.types.find((t) => t.id === e.typeId), e).map((p) => p.name);
				if (args.missing === true) found = found.filter((e) => missing(e).length > 0);
				const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 50;
				return json({
					total: found.length,
					entities: found.slice(0, limit).map((e) => {
						const lacking = missing(e);
						return { id: e.id, type: typeName(data, e.typeId), name: e.name, tags: e.tags, ...(lacking.length > 0 ? { missing: lacking } : {}) };
					}),
				});
			},
		},
		{
			name: "get_entity",
			description:
				"One entity with everything about it: content, description, tags, its property values (references with the names " +
				"and ids of the entities they point to) and the entities that reference it.",
			inputSchema: object({ workspace: WORKSPACE, entity: ENTITY, type: TYPE_HINT }, ["workspace", "entity"]),
			async run(args) {
				const { data } = await open(args.workspace);
				const entity = entityOf(data, args.entity, args.type);
				return json({ ...describeEntity(data, entity), referencedBy: referencesTo(data, entity) });
			},
		},
		{
			name: "run_analysis",
			description:
				"Runs a saved analysis (see describe_workspace): the entities of its type as rows, nested in groups by what its grouping " +
				"paths lead to, with a cell per column (`columns` names them, in the order of the cells). At most `limit` rows are " +
				"shown (default 100); the groups' counts are always whole.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					analysis: ANALYSIS,
					limit: { type: "integer", minimum: 1, description: "At most this many rows (default 100)." },
				},
				["workspace", "analysis"],
			),
			async run(args) {
				const { data } = await open(args.workspace);
				const analysis = analysisOf(data, args.analysis);
				if (analysis.typeId === null) throw new ToolError(`The analysis "${analysis.name}" has no type picked yet.`);
				const typeId = analysis.typeId;
				const result = runAnalysis(data, analysis);
				const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 100;
				// The rows still to show; once none are left, the groups after are left out.
				let left = limit;
				let cut = false;
				const rows = (rs: readonly AnalysisRow[]) => {
					const shown = rs.slice(0, left);
					left -= shown.length;
					cut ||= shown.length < rs.length;
					return shown.map((r) => ({ entity: { id: r.entity.id, name: r.entity.name }, cells: r.cells.map((c) => c.map((v) => v.label)) }));
				};
				const groups = (gs: readonly AnalysisGroup[]): object[] =>
					gs.flatMap((g) => {
						if (left === 0) {
							cut = true;
							return [];
						}
						return [{ value: g.value?.label ?? null, count: g.count, ...(g.groups.length > 0 ? { groups: groups(g.groups) } : { rows: rows(g.rows) }) }];
					});
				const shown = result.groups.length > 0 ? { groups: groups(result.groups) } : { rows: rows(result.rows) };
				return json({
					analysis: analysis.name,
					type: typeName(data, typeId),
					groupedBy: analysis.groups.map((path) => pathLabel(data, typeId, path)),
					columns: analysis.columns.map((path) => pathLabel(data, typeId, path)),
					count: result.count,
					...shown,
					...(cut ? { truncated: `Only the first ${limit} rows are shown; ask with a higher limit for more.` } : {}),
				});
			},
		},
		{
			name: "create_analysis",
			description:
				"Creates an analysis: the entities of `type` as rows, grouped by the paths in `groups` (outermost first), with a column " +
				"per path in `columns`. " +
				PATHS,
			inputSchema: object({ workspace: WORKSPACE, name: { type: "string" }, type: { type: "string", description: "Name or id of the row type." }, groups: PATH_LIST, columns: PATH_LIST }, [
				"workspace",
				"name",
				"type",
			]),
			async run(args) {
				const store = await open(args.workspace);
				const name = analysisName(store.data, args.name, null);
				const type = typeOf(store.data, args.type);
				const groups = args.groups === undefined ? [] : paths(store.data, type.id, args.groups, "groups");
				const columns = args.columns === undefined ? [] : paths(store.data, type.id, args.columns, "columns");
				const analysis = store.addAnalysis(name);
				store.updateAnalysis(analysis.id, { typeId: type.id, groups, columns });
				return answerSaved(store, { analysis: describeAnalysis(store.data, analysisOf(store.data, analysis.id)) });
			},
		},
		{
			name: "update_analysis",
			description:
				"Changes an analysis: its name, its row type, its groups or its columns. `groups` and `columns` each replace the whole list; " +
				"a new `type` without them empties them, as the paths of the old type don't fit. " +
				PATHS,
			inputSchema: object(
				{ workspace: WORKSPACE, analysis: ANALYSIS, name: { type: "string" }, type: { type: "string", description: "Name or id of the row type." }, groups: PATH_LIST, columns: PATH_LIST },
				["workspace", "analysis"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const analysis = analysisOf(store.data, args.analysis);
				const patch: Partial<Omit<Analysis, "id">> = {};
				if (args.name !== undefined) patch.name = analysisName(store.data, args.name, analysis.id);
				if (args.type !== undefined) {
					const type = typeOf(store.data, args.type);
					if (type.id !== analysis.typeId) Object.assign(patch, { typeId: type.id, groups: [], columns: [] });
				}
				const typeId = patch.typeId ?? analysis.typeId;
				if ((args.groups !== undefined || args.columns !== undefined) && typeId === null) throw new ToolError("Give the analysis a `type` first.");
				if (args.groups !== undefined) patch.groups = paths(store.data, typeId!, args.groups, "groups");
				if (args.columns !== undefined) patch.columns = paths(store.data, typeId!, args.columns, "columns");
				store.updateAnalysis(analysis.id, patch);
				return answerSaved(store, { analysis: describeAnalysis(store.data, analysisOf(store.data, analysis.id)) });
			},
		},
		{
			name: "delete_analysis",
			description: "Deletes an analysis; the entities stay as they are. Needs `confirm: true`.",
			inputSchema: object({ workspace: WORKSPACE, analysis: ANALYSIS, confirm: { type: "boolean" } }, ["workspace", "analysis", "confirm"]),
			async run(args) {
				const store = await open(args.workspace);
				const analysis = analysisOf(store.data, args.analysis);
				if (args.confirm !== true) throw new ToolError(`Deleting the analysis "${analysis.name}" needs confirm: true.`);
				store.deleteAnalysis(analysis.id);
				return answerSaved(store, { deleted: { id: analysis.id, name: analysis.name } });
			},
		},
		{
			name: "create_type",
			description:
				"Creates an entity type. Properties are text, options (with their `options`) or references (with `targets`: names of " +
				"the types they point to, `multiple` for several, `required` for at least one, `inverseLabel` for how the referenced entities show the reference). " +
				"A reference to the type itself is added afterwards with update_type.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					name: { type: "string" },
					properties: { type: "array", items: PROPERTY },
					contentTemplate: { type: "string", description: "Description new entities of the type start with." },
				},
				["workspace", "name"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const name = text(args.name, "name");
				if (store.data.types.some((t) => sameName(t.name, name))) throw new ToolError(`There is a type "${name}" already.`);
				const properties = drafts(store.data, args.properties ?? [], []);
				check(store.data, name, properties);
				const type = store.addType(name, properties, args.contentTemplate === undefined ? "" : text(args.contentTemplate, "contentTemplate"));
				return answerSaved(store, { type: describeType(store.data, type) });
			},
		},
		{
			name: "update_type",
			description:
				"Changes an entity type: its name, its content template, or its properties. `properties` replaces the whole list: a " +
				"property keeps its values when it is listed with its id (or its current name), and what isn't given of it stays as it " +
				"is; a property left out is removed, together with its values on all entities — which needs `confirm: true`.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					type: { type: "string", description: "Name or id of the type." },
					name: { type: "string" },
					properties: { type: "array", items: { ...PROPERTY, properties: { id: { type: "string" }, ...PROPERTY.properties }, required: [] } },
					contentTemplate: { type: "string" },
					confirm: { type: "boolean", description: "Needed when properties are left out, as they are removed with their values." },
				},
				["workspace", "type"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const type = typeOf(store.data, args.type);
				const name = args.name === undefined ? type.name : text(args.name, "name");
				if (store.data.types.some((t) => t.id !== type.id && sameName(t.name, name))) throw new ToolError(`There is a type "${name}" already.`);
				const properties = args.properties === undefined ? type.properties : drafts(store.data, args.properties, type.properties);
				check(store.data, name, properties);
				const removed = type.properties.filter((p) => !properties.some((d) => d.id === p.id));
				if (removed.length > 0 && args.confirm !== true) {
					const losing = store.data.entities.filter((e) => removed.some((p) => e.values[p.id] !== undefined && e.values[p.id] !== null)).length;
					throw new ToolError(
						`This removes ${removed.map((p) => `"${p.name}"`).join(", ")} from ${type.name}, with the values of ${losing} entities. ` +
							"List the properties to keep, or repeat with confirm: true.",
					);
				}
				const template = args.contentTemplate === undefined ? type.contentTemplate : text(args.contentTemplate, "contentTemplate");
				store.updateType(type.id, name, properties, template);
				return answerSaved(store, { type: describeType(store.data, typeOf(store.data, type.id)) });
			},
		},
		{
			name: "create_entity",
			description:
				"Creates an entity of a type. `values` maps property names to a text, an option, or the name/id of the entity a " +
				"reference points to (a list for references allowing several). Without a description it starts with the type's template.",
			inputSchema: object({ workspace: WORKSPACE, ...ENTITY_FIELDS }, ["workspace", "type", "name"]),
			async run(args) {
				const store = await open(args.workspace);
				const [entity] = store.addEntities([newEntity(store.data, args, store.data.entities)]);
				return answerSaved(store, { entity: describeEntity(store.data, entity!) });
			},
		},
		{
			name: "create_entities",
			description:
				"Creates several entities at once, each given as to create_entity (`type`, `name`, `content`, `description`, `tags`, `values`). " +
				"A reference may name another entity of the same call. All are checked first: one that doesn't fit, and none is created.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					entities: { type: "array", minItems: 1, items: object(ENTITY_FIELDS, ["type", "name"]) },
				},
				["workspace", "entities"],
			),
			async run(args) {
				const store = await open(args.workspace);
				if (!Array.isArray(args.entities) || args.entities.length === 0) throw new ToolError("`entities` must be a list of entities.");
				/** `run` on the `index`th entity given, its refusal saying which one it is about. */
				const at = <T>(index: number, run: () => T): T => {
					try {
						return run();
					} catch (error) {
						const item = (args.entities as unknown[])[index] as { name?: unknown } | null;
						throw error instanceof ToolError ? new ToolError(`entities[${index}] ("${String(item?.name)}"): ${error.message}`) : error;
					}
				};
				const given = args.entities.map((item, index) =>
					at(index, () => {
						const fields = record(item, `entities[${index}]`);
						return { fields, id: ulid(), typeId: typeOf(store.data, fields.type).id, name: text(fields.name, "name").trim() };
					}),
				);
				// What the references may point to: the entities there are, and the ones of this call.
				const candidates = [...store.data.entities, ...given];
				const items = given.map(({ fields, id }, index) => at(index, () => ({ ...newEntity(store.data, fields, candidates), id })));
				const created = store.addEntities(items);
				return answerSaved(store, {
					created: created.map((e) => {
						const { id, type, name, missing } = describeEntity(store.data, e);
						return { id, type, name, ...(missing ? { missing } : {}) };
					}),
				});
			},
		},
		{
			name: "update_entity",
			description:
				"Changes an entity. Only what is given changes; `values` sets the properties it names (null clears one) and leaves the " +
				"others as they are, `tags` replaces the tags.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					entity: ENTITY,
					type: TYPE_HINT,
					name: { type: "string" },
					content: { type: "string" },
					description: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
					values: VALUES,
				},
				["workspace", "entity"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const entity = entityOf(store.data, args.entity, args.type);
				const type = typeOf(store.data, entity.typeId);
				const name = args.name === undefined ? entity.name : text(args.name, "name");
				if (name.trim() === "") throw new ToolError("An entity needs a name.");
				const values = args.values === undefined ? {} : valuesOf(store.data, type, record(args.values, "values"));
				store.updateEntity(
					entity.id,
					name,
					args.content === undefined ? entity.content : text(args.content, "content"),
					{ ...entity.values, ...values },
					args.description === undefined ? undefined : text(args.description, "description"),
					args.tags === undefined ? undefined : texts(args.tags, "tags"),
				);
				return answerSaved(store, { entity: describeEntity(store.data, entityOf(store.data, entity.id)) });
			},
		},
		{
			name: "delete_entity",
			description: "Deletes an entity, with its cards on all boards and the references to it. Needs `confirm: true`.",
			inputSchema: object({ workspace: WORKSPACE, entity: ENTITY, type: TYPE_HINT, confirm: { type: "boolean" } }, ["workspace", "entity", "confirm"]),
			async run(args) {
				const store = await open(args.workspace);
				const entity = entityOf(store.data, args.entity, args.type);
				if (args.confirm !== true) throw new ToolError(`Deleting "${entity.name}" needs confirm: true.`);
				store.deleteEntity(entity.id);
				return answerSaved(store, { deleted: { id: entity.id, name: entity.name } });
			},
		},
		{
			name: "place_on_board",
			description:
				"Puts entities on a board as cards, so they can be seen with their references drawn between them. Names a board " +
				"by name or id; one of that name is made when there is none. `types` puts all entities of those types there, " +
				"`entities` the ones named (each a name or id, or { entity, type, x, y }). An entity with `x` and `y` goes there " +
				"(its card moves when it's on the board already); the others are laid out right of what's on the board, in columns " +
				"in the direction of the references (each type a band of its own), sorted so their lines cross as little as " +
				"possible; ones on the board already stay where they are.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					board: { type: "string", description: "Name or id of the board; made when there is none of that name." },
					types: { type: "array", items: { type: "string" }, description: "Names or ids of types: all their entities." },
					entities: {
						type: "array",
						items: {
							anyOf: [
								{ type: "string" },
								object({ entity: ENTITY, type: TYPE_HINT, x: { type: "number" }, y: { type: "number" } }, ["entity"]),
							],
						},
						description: "Entities by name or id, or with where their card goes (x to the right, y down; a card is 240 × 168).",
					},
				},
				["workspace", "board"],
			),
			async run(args) {
				const store = await open(args.workspace);
				if (args.types === undefined && args.entities === undefined) throw new ToolError("Give `types` or `entities` to put on the board.");
				const types = args.types === undefined ? [] : texts(args.types, "types").map((t) => typeOf(store.data, t).id);
				const given = new Map<string, { entity: Entity; at: { x: number; y: number } | null }>();
				for (const entity of store.data.entities.filter((e) => types.includes(e.typeId))) given.set(entity.id, { entity, at: null });
				if (args.entities !== undefined) {
					if (!Array.isArray(args.entities)) throw new ToolError("`entities` must be a list.");
					args.entities.forEach((item, index) => {
						const fields = typeof item === "string" ? { entity: item } : record(item, `entities[${index}]`);
						const entity = entityOf(store.data, fields.entity, fields.type);
						const hasAt = fields.x !== undefined || fields.y !== undefined;
						if (hasAt && (typeof fields.x !== "number" || typeof fields.y !== "number")) {
							throw new ToolError(`entities[${index}] ("${entity.name}") needs both x and y as numbers, or neither.`);
						}
						given.set(entity.id, { entity, at: hasAt ? { x: snapToGrid(fields.x as number), y: snapToGrid(fields.y as number) } : null });
					});
				}
				if (given.size === 0) throw new ToolError("There are no entities of those types to put on the board.");

				const { board, created } = boardOf(store, text(args.board, "board"));
				const onBoard = new Set(board.cards.map((c) => c.entityId));
				const kept = [...given.values()].filter((g) => g.at === null && onBoard.has(g.entity.id)).map((g) => g.entity);
				const toLayOut = [...given.values()].filter((g) => g.at === null && !onBoard.has(g.entity.id)).map((g) => g.entity);
				const start =
					board.cards.length === 0
						? board.viewFrame
						: { x: Math.max(...board.cards.map((c) => c.x + c.width)) + 4 * GRID_SIZE, y: Math.min(...board.cards.map((c) => c.y)) };
				const placements = [
					...[...given.values()].flatMap((g) => (g.at ? [{ entityId: g.entity.id, ...g.at }] : [])),
					...layeredLayout(store.data.types, toLayOut, start),
				];
				const cards = store.placeCards(board.id, placements);
				const name = (entityId: string) => store.data.entities.find((e) => e.id === entityId)!.name;
				return answerSaved(store, {
					board: { id: board.id, name: board.name, ...(created ? { created: true } : {}) },
					placed: cards.map((c) => ({ entity: name(c.entityId), x: c.x, y: c.y })),
					...(kept.length > 0 ? { kept: kept.map((e) => e.name) } : {}),
				});
			},
		},
	];

	/** The tool's answer once its change is saved, with a warning when it collided with someone else's. */
	async function answerSaved(store: Store, value: object): Promise<string> {
		const warning = await saved(store);
		return json(warning ? { ...value, warning } : value);
	}
}

const WORKSPACE = { type: "string", description: "Name or id of the workspace." };
const ENTITY = { type: "string", description: "Name or id of the entity." };
const TYPE_HINT = { type: "string", description: "Name or id of the entity's type, when its name alone is ambiguous." };
const VALUES = {
	type: "object",
	description: "Property name → text, option, or name/id of a referenced entity (a list where several are allowed); null clears.",
	additionalProperties: { type: ["string", "array", "null"], items: { type: "string" } },
};
/** What create_entity and each entity of create_entities are given. */
const ENTITY_FIELDS = {
	type: { type: "string", description: "Name or id of the entity type." },
	name: { type: "string" },
	content: { type: "string", description: "Short text shown on the entity's cards." },
	description: { type: "string", description: "Longer text, Markdown." },
	tags: { type: "array", items: { type: "string" } },
	values: VALUES,
};
const ANALYSIS = { type: "string", description: "Name or id of the analysis." };
const PATH_LIST = {
	type: "array",
	items: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
	description: "Paths: each a list of steps, or the steps in one text joined by ›.",
};
const PATHS =
	"A path goes from the row type step by step: a property's name (a reference leads on to the entities it points to, a text or " +
	"options property ends the path), or for the entities referencing these, the reference's inverse label or Type.Property. " +
	"`Owner › Role` is the role of the owner; describe_workspace and run_analysis write paths the same way.";
const PROPERTY = {
	type: "object",
	properties: {
		name: { type: "string" },
		kind: { type: "string", enum: ["text", "options", "reference"] },
		options: { type: "array", items: { type: "string" }, description: "For options: the allowed values." },
		targets: { type: "array", items: { type: "string" }, description: "For references: names or ids of the types pointed to." },
		multiple: { type: "boolean", description: "For references: whether several entities can be picked." },
		required: {
			type: "boolean",
			description: "For references: whether each entity should reference one. Not enforced; entities without one are listed as `missing`.",
		},
		inverseLabel: { type: "string", description: "For references: the label on the referenced entities; empty hides it there." },
		cardDisplay: { type: "string", enum: ["list", "line", "hidden"], description: "How cards show it; line draws references as lines." },
	},
	required: ["name", "kind"],
};

/** A JSON Schema of an object with `properties`, of which `required` must be there. */
const object = (properties: Record<string, object>, required: string[]) => ({ type: "object", properties, required });

const json = (value: unknown) => JSON.stringify(value, null, 2);

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

function text(value: unknown, what: string): string {
	if (typeof value !== "string") throw new ToolError(`\`${what}\` must be a text.`);
	return value;
}

function texts(value: unknown, what: string): string[] {
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new ToolError(`\`${what}\` must be a list of texts.`);
	return value;
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ToolError(`\`${what}\` must be an object.`);
	return value as Record<string, unknown>;
}

const typeName = (data: AppData, typeId: string | null) => data.types.find((t) => t.id === typeId)?.name ?? null;

/** The type `ref` names by id or name. */
function typeOf(data: AppData, ref: unknown): EntityType {
	const wanted = text(ref, "type");
	const type = data.types.find((t) => t.id === wanted) ?? data.types.find((t) => sameName(t.name, wanted));
	if (!type) throw new ToolError(`There is no type "${wanted}". Types: ${data.types.map((t) => t.name).join(", ") || "none"}.`);
	return type;
}

/** The entity `ref` names by id, or by name (among the entities of `typeRef` when given). */
function entityOf(data: AppData, ref: unknown, typeRef?: unknown): Entity {
	const wanted = text(ref, "entity");
	const byId = data.entities.find((e) => e.id === wanted);
	if (byId) return byId;
	const typeId = typeRef === undefined ? null : typeOf(data, typeRef).id;
	const named = data.entities.filter((e) => (typeId === null || e.typeId === typeId) && sameName(e.name, wanted));
	if (named.length === 1) return named[0]!;
	if (named.length === 0) throw new ToolError(`There is no entity "${wanted}"${typeId ? ` of type ${typeName(data, typeId)}` : ""}.`);
	const which = named.map((e) => `${e.id} (${typeName(data, e.typeId)})`).join(", ");
	throw new ToolError(`Several entities are called "${wanted}": ${which}. Name it by id, or give its type.`);
}

/** The property of `type` named `name` (ignoring case) or with that id. */
function propertyOf(type: EntityType, name: string): PropertyDef {
	const prop = type.properties.find((p) => p.id === name) ?? placeholderProperty(type, name);
	if (!prop) throw new ToolError(`${type.name} has no property "${name}". Properties: ${type.properties.map((p) => p.name).join(", ") || "none"}.`);
	return prop;
}

function describeType(data: AppData, type: EntityType) {
	return {
		id: type.id,
		name: type.name,
		properties: type.properties.map((p) => ({
			id: p.id,
			name: p.name,
			kind: p.kind,
			...(p.kind === "options" ? { options: p.options } : {}),
			...(p.reference
				? { targets: p.reference.typeIds.map((id) => typeName(data, id)), multiple: p.reference.multiple, required: p.reference.required, inverseLabel: p.reference.inverseLabel }
				: {}),
		})),
		contentTemplate: type.contentTemplate,
	};
}

function describeEntity(data: AppData, entity: Entity) {
	const type = data.types.find((t) => t.id === entity.typeId);
	const values: Record<string, unknown> = {};
	for (const prop of type?.properties ?? []) {
		const value = entity.values[prop.id];
		if (value === undefined || value === null) continue;
		values[prop.name] = prop.kind === "reference" ? referencedIds(prop, value).map((id) => named(data, id)) : value;
	}
	const missing = missingRequired(type, entity).map((p) => p.name);
	return {
		id: entity.id,
		type: type?.name ?? null,
		name: entity.name,
		tags: entity.tags,
		content: entity.content,
		description: entity.description,
		values,
		...(missing.length > 0 ? { missing } : {}),
	};
}

const named = (data: AppData, id: string) => ({ id, name: data.entities.find((e) => e.id === id)?.name ?? null });

/** Who references `entity`, per reference: its inverse label, or the referencing type and property. */
function referencesTo(data: AppData, entity: Entity) {
	return data.types.flatMap((type) =>
		type.properties.flatMap((prop) => {
			if (prop.kind !== "reference" || !prop.reference?.typeIds.includes(entity.typeId)) return [];
			const from = data.entities.filter((e) => e.typeId === type.id && referencedIds(prop, e.values[prop.id]).includes(entity.id));
			if (from.length === 0) return [];
			return [{ label: prop.reference.inverseLabel || `${type.name}.${prop.name}`, entities: from.map((e) => named(data, e.id)) }];
		}),
	);
}

/** Whether a value matches what `find_entities` was asked: a text containing it, the option, or a referenced entity
 * of that id or name. */
function valueMatches(data: AppData, prop: PropertyDef, value: PropertyValue | undefined, wanted: string): boolean {
	if (value === undefined || value === null) return false;
	if (prop.kind === "reference") {
		return referencedIds(prop, value).some((id) => id === wanted || sameName(data.entities.find((e) => e.id === id)?.name ?? "", wanted));
	}
	const values = typeof value === "string" ? [value] : value;
	return values.some((v) => (prop.kind === "options" ? sameName(v, wanted) : v.toLocaleLowerCase().includes(wanted.trim().toLocaleLowerCase())));
}

/** What a reference can name: an entity there is, or one about to be created. */
type Candidate = Pick<Entity, "id" | "typeId" | "name">;

/** The entity the model described (as create_entity is given it), checked; a reference names one of `entities`.
 * Without a description it starts with its type's template. */
function newEntity(data: AppData, given: Record<string, unknown>, entities: readonly Candidate[]): NewEntity {
	const type = typeOf(data, given.type);
	const name = text(given.name, "name");
	if (name.trim() === "") throw new ToolError("An entity needs a name.");
	return {
		typeId: type.id,
		name,
		content: given.content === undefined ? "" : text(given.content, "content"),
		values: given.values === undefined ? {} : valuesOf(data, type, record(given.values, "values"), entities),
		description: given.description === undefined ? type.contentTemplate : text(given.description, "description"),
		tags: given.tags === undefined ? [] : texts(given.tags, "tags"),
	};
}

/** The values the model gave, keyed by property id, each checked the way the entity form checks it; a reference
 * names one of `entities`. */
function valuesOf(
	data: AppData,
	type: EntityType,
	given: Record<string, unknown>,
	entities: readonly Candidate[] = data.entities,
): Record<string, PropertyValue> {
	const entityTypes = new Map(entities.map((e) => [e.id, e.typeId]));
	const values: Record<string, PropertyValue> = {};
	for (const [name, raw] of Object.entries(given)) {
		const prop = propertyOf(type, name);
		if (raw === null) {
			values[prop.id] = null;
			continue;
		}
		if (prop.kind !== "reference") {
			const value = parseValue(prop, text(raw, prop.name), entityTypes);
			if (value === null && text(raw, prop.name).trim() !== "") {
				throw new ToolError(`"${raw}" isn't an option of ${prop.name}. Options: ${prop.options.join(", ")}.`);
			}
			values[prop.id] = value;
			continue;
		}
		const refs = typeof raw === "string" ? [raw] : texts(raw, prop.name);
		if (refs.length > 1 && !prop.reference?.multiple) throw new ToolError(`${prop.name} references one entity only.`);
		const targets = prop.reference?.typeIds ?? [];
		const candidates = entities.filter((e) => targets.includes(e.typeId));
		const ids = refs.map((ref) => {
			const byId = candidates.find((e) => e.id === ref);
			if (byId) return byId.id;
			const found = candidates.filter((e) => sameName(e.name, ref));
			const kinds = targets.map((id) => typeName(data, id)).join(" or ");
			if (found.length === 0) throw new ToolError(`${prop.name} points to ${kinds}, and there is no such entity "${ref}".`);
			if (found.length > 1) throw new ToolError(`Several ${kinds} entities are called "${ref}": ${found.map((e) => e.id).join(", ")}. Name it by id.`);
			return found[0]!.id;
		});
		values[prop.id] = parseValue(prop, ids, entityTypes);
	}
	return values;
}

/** The properties the model listed, as the type form drafts them: one listed with the id or name of one of
 * `current` keeps that one's id and whatever of it isn't given. */
function drafts(data: AppData, raw: unknown, current: readonly PropertyDef[]): DraftProperty[] {
	if (!Array.isArray(raw)) throw new ToolError("`properties` must be a list.");
	return raw.map((item, index) => {
		const given = record(item, `properties[${index}]`);
		const was = (typeof given.id === "string" ? current.find((p) => p.id === given.id) : undefined) ??
			(typeof given.name === "string" ? current.find((p) => sameName(p.name, given.name as string)) : undefined);
		if (typeof given.id === "string" && !was) throw new ToolError(`There is no property with the id ${given.id}.`);
		const kind = (given.kind ?? was?.kind) as PropertyKind;
		if (!PROPERTY_KINDS.includes(kind)) throw new ToolError(`properties[${index}] needs a kind: ${PROPERTY_KINDS.join(", ")}.`);
		const cardDisplay = (given.cardDisplay ?? was?.cardDisplay ?? "list") as CardDisplay;
		if (!CARD_DISPLAYS.includes(cardDisplay)) throw new ToolError(`properties[${index}].cardDisplay is one of ${CARD_DISPLAYS.join(", ")}.`);
		const reference =
			kind !== "reference"
				? null
				: {
						...(was?.reference ?? newReference([])),
						...(given.targets === undefined ? {} : { typeIds: texts(given.targets, "targets").map((t) => typeOf(data, t).id) }),
						...(given.multiple === undefined ? {} : { multiple: given.multiple === true }),
						...(given.required === undefined ? {} : { required: given.required === true }),
						...(given.inverseLabel === undefined ? {} : { inverseLabel: text(given.inverseLabel, "inverseLabel") }),
					};
		const draft: DraftProperty = {
			name: given.name === undefined ? (was?.name ?? "") : text(given.name, "name"),
			kind,
			options: given.options === undefined ? (was?.options ?? []) : texts(given.options, "options"),
			reference,
			cardDisplay,
		};
		return was ? { ...draft, id: was.id } : draft;
	});
}

/** Refuses a type the type form would refuse, saying why. */
function check(data: AppData, name: string, properties: DraftProperty[]): void {
	const errors = validateType(name, properties, new Set(data.types.map((t) => t.id)));
	if (errors.length > 0) throw new ToolError(`The type can't be saved: ${errors.map(problem).join(" ")}`);
}

function problem(error: ValidationError): string {
	switch (error.code) {
		case "typeNameRequired":
			return "It needs a name.";
		case "propertyNameRequired":
			return "Every property needs a name.";
		case "reservedName":
			return `"${error.label}" is reserved (id, name, content, description).`;
		case "duplicateName":
			return `"${error.label}" is there twice.`;
		case "optionsRequired":
			return `${error.label} needs options.`;
		case "emptyOption":
			return `${error.label} has an empty option.`;
		case "duplicateOptions":
			return `${error.label} has an option twice.`;
		case "referenceTypeRequired":
			return `${error.label} needs targets: types that exist.`;
	}
}

/** How a path reads: its steps' names, an inverse step by its label or the referencing type and property. */
function pathLabel(data: AppData, typeId: string, path: readonly PathStep[]): string {
	return resolvePath(data.types, typeId, path)
		.options.map((o) => stepLabel(data, o))
		.join(" › ");
}

const stepLabel = (data: AppData, o: PathOption) =>
	o.step.direction === "inverse" ? o.prop.reference?.inverseLabel || `${typeName(data, o.ownerTypeId)}.${o.prop.name} (inverse)` : o.prop.name;

/** The paths the model gave from entities of `typeId`, each step named the way `stepLabel` reads it (an inverse
 * one also as Type.Property). */
function paths(data: AppData, typeId: string, raw: unknown, what: string): PathStep[][] {
	if (!Array.isArray(raw)) throw new ToolError(`\`${what}\` must be a list of paths.`);
	return raw.map((item, index) => {
		const steps = typeof item === "string" ? item.split("›") : texts(item, `${what}[${index}]`);
		if (steps.every((s) => s.trim() === "")) throw new ToolError(`${what}[${index}] needs at least one step.`);
		let from = [typeId];
		return steps.map((step, i) => {
			const wanted = step.trim();
			if (from.length === 0) throw new ToolError(`${what}[${index}]: "${steps[i - 1]!.trim()}" is a text or options property; the path ends there.`);
			const options = pathOptions(data.types, from);
			const fits = options.filter((o) =>
				o.step.direction === "forward"
					? o.prop.id === wanted || sameName(o.prop.name, wanted)
					: sameName(stepLabel(data, o), wanted) || sameName(`${typeName(data, o.ownerTypeId)}.${o.prop.name}`, wanted),
			);
			if (fits.length !== 1) {
				const known = options.map((o) => stepLabel(data, o)).join(", ") || "none";
				throw new ToolError(`${what}[${index}]: ${fits.length > 1 ? `"${wanted}" is ambiguous` : `there is no step "${wanted}"`} here. Steps: ${known}.`);
			}
			from = fits[0]!.typeIds;
			return fits[0]!.step;
		});
	});
}

/** The board `ref` names by id or name, or a new one of that name when there is none. */
function boardOf(store: Store, ref: string): { board: Board; created: boolean } {
	const byId = store.data.boards.find((b) => b.id === ref);
	if (byId) return { board: byId, created: false };
	const named = store.data.boards.filter((b) => sameName(b.name, ref));
	if (named.length > 1) throw new ToolError(`Several boards are called "${ref}": ${named.map((b) => b.id).join(", ")}. Name it by id.`);
	if (named.length === 1) return { board: named[0]!, created: false };
	if (ref.trim() === "") throw new ToolError("A board needs a name.");
	return { board: store.addBoard(ref), created: true };
}

/** The analysis `ref` names by id or name. */
function analysisOf(data: AppData, ref: unknown): Analysis {
	const wanted = text(ref, "analysis");
	const analysis = data.analyses.find((a) => a.id === wanted) ?? data.analyses.find((a) => sameName(a.name, wanted));
	if (!analysis) throw new ToolError(`There is no analysis "${wanted}". Analyses: ${data.analyses.map((a) => a.name).join(", ") || "none"}.`);
	return analysis;
}

/** `raw` as the name of an analysis, refused when empty or another one (than `selfId`) has it. */
function analysisName(data: AppData, raw: unknown, selfId: string | null): string {
	const name = text(raw, "name");
	if (name.trim() === "") throw new ToolError("An analysis needs a name.");
	if (data.analyses.some((a) => a.id !== selfId && sameName(a.name, name))) throw new ToolError(`There is an analysis "${name}" already.`);
	return name;
}

function describeAnalysis(data: AppData, analysis: Analysis) {
	const typeId = analysis.typeId;
	return {
		id: analysis.id,
		name: analysis.name,
		type: typeName(data, typeId),
		groupedBy: typeId === null ? [] : analysis.groups.map((path) => pathLabel(data, typeId, path)),
		columns: typeId === null ? [] : analysis.columns.map((path) => pathLabel(data, typeId, path)),
	};
}
