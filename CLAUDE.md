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

# Workflow

Before implementing:
1. Inspect relevant code.
2. Find similar implementations.
3. Explain your intended approach.

After implementing:
1. Run relevant tests.
2. Run full test suite if practical.
3. Run lint/type checks.
4. Review your own diff for unnecessary complexity.

# Definition of done

- Tests pass
- No unnecessary dependency
- No unrelated refactoring
- Existing conventions followed
