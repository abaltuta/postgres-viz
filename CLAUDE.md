# Working agreements

Write a failing test before implementing a bug fix or behavior change. Use the smallest test that exercises the behavior.

- SQL and PL/pgSQL analysis tests live in `internal/analysis`. Keep WASM parsing in a killable worker.
- Test native snapshot validation and traversal in `internal/snapshot`, and the viewer's reader in `test/snapshot.ts`. Use `internal/integration` for real PostgreSQL parity.
- Exercise browser interactions with the viewer harness and editor workflows with the editor integration tests.

Before committing, run typecheck, lint, smoke, DB integration, build and browser checks as described in README.md.
