# Architecture

- Follow existing patterns before inventing new abstractions.
- Prefer modifying existing code over adding dependencies.
- Implement features as vertical slices end to end instead of horizontal layers.

# Feature slices

- A feature lives in `packages/app/src/features/<name>/` with all its layers and joins with one line in each
  `features.{core,ui,api,mcp}.ts` it needs.
- Imports point down only: `shared/` knows no feature; a feature imports `shared/`, itself and the features
  listed for it in `FEATURES_BELOW` (`packages/app/src/imports.test.ts`), of those only their entries
  (`core.ts`, `ui.ts`, `api.ts`, `mcp.ts`, `texts.ts`); nothing from `features.*.ts`, not even
  types — a feature works with the store type of the features below it (`DataStore`, `BoardStore`).
- A new feature or a new dependency between features starts with its entry in `FEATURES_BELOW`. Treat it as a
  design decision and name it in the plan; never add an entry just to make the test pass.
- Code moves to `shared/` only once two or more features use it.
- Moving CSS needs byte-identical screenshots before and after.

# Where things live

- CSS: a feature's styles in `features/<name>/<name>.css`; the shell (top bar, menus, search, banners, empty
  lists, drop markers, cards, tags) and some older feature styles in `apps/web/src/app.css`.
- Saved format: `DATA_VERSION` and `MIGRATIONS` in `shared/core/migrations.ts`; each raise also needs a step in
  `shared/api/schema.ts` (Postgres) and `shared/api/sqlite.ts`, tested in `apps/api/src/{schema,sqlite}.test.ts`.
- Tests in `packages/app/src/` beside the features: `features.core.test.ts` the store (saving, sync between tabs,
  undo, migrations), `features.ui.test.ts` the whole app (shell, workspaces, data pages), `history.test.ts` the
  history page, `workspaces.test.ts` workspaces; everything else beside its feature.

# Workflow

Before implementing:
1. Inspect relevant code.
2. Find similar implementations.
3. Explain your intended approach.

After implementing:
1. Run relevant tests, while working only those, e.g.
   `pnpm --filter @tybo/app exec tsx --test --test-reporter=dot 'src/features/data/**/*.test.ts'`.
2. Run `pnpm check` (type checks of every runtime, all tests, build) once before committing; there is no linter.
3. Review your own diff for unnecessary complexity.

# Definition of done

- Tests pass
- No unnecessary dependency
- No unrelated refactoring
- Existing conventions followed
