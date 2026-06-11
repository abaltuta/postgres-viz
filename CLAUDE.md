# postgres-viz — working agreements

## Test-first (REQUIRED)

For every bug fix or behavior change: **write the test FIRST, run it, see it
fail, then implement.** Never commit a fix whose test was not seen red.

Where tests live — pick the lowest layer that can express the scenario:

| Layer | File | Runs via | Use for |
|---|---|---|---|
| SQL analysis (no DB) | `test/smoke.ts` | `pnpm smoke` | parser/regex-fallback attribution on a fake catalog |
| Webview view logic | `test/webview.ts` | `pnpm smoke` | headless-cytoscape: closures, visibility classes, materialization lifecycle |
| HCL scanner | `test/hcl.ts` | `pnpm smoke` | Atlas block shapes, key indexing/ambiguity |
| Full pipeline | `test/integration.ts` | `pnpm test:db` | introspect → analyze → graph against real Postgres fixtures |

Webview logic that needs a test but lives in `webview/main.ts` (DOM-bound):
extract the pure part into `webview/core.ts` first, then test it.

## Gates (before every commit, in order)

```bash
docker run -d --rm --name pgviz-test -p 54339:5432 -e POSTGRES_PASSWORD=pg postgres:16
pnpm format && pnpm lint && pnpm typecheck && pnpm smoke && pnpm test:db
docker stop pgviz-test
```

## Release ritual

Bump `version` in package.json → `rm` the old `.vsix` → `pnpm package` →
conventional commit (never push) → give the `code --install-extension` one-liner.

## Hard-won gotchas

- Never trust `:visible` right after batched class changes — use the
  class-derived helpers in `webview/core.ts`.
- Row nodes are removed/re-added by dematerialize/materialize — re-resolve
  elements by id after any view transition; stale references have no edges.
- `cy.add` of a same-id element does NOT revive old references (and
  `restore()` behaves differently — tests must simulate with `cy.add`).
- pg-query-emscripten can hang in sync WASM: parsing runs in a killable
  worker; never remove the timeout/respawn path.
