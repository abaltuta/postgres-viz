# From VS Code extension to portable database snapshot

The first release should let someone inspect PostgreSQL once, disconnect, and explore the resulting file in Prism. The deliverable to share is a versioned JSON file. The browser and editors use the same reader, relationship queries, and viewer assets.

## User workflow

```sh
# scan reads the connection from DATABASE_URL
postgres-viz scan --out commerce.pgviz.json
postgres-viz open commerce.pgviz.json
```

`scan` captures database metadata and dependency evidence. `open` serves the bundled Prism UI and the selected file on a local loopback port, prints the URL, and opens it in the browser. An already-open viewer can also load a snapshot through a file picker. Both viewing paths work offline. SQL definitions and snippets can be present in the snapshot.

## Source map

- [Go capture](../internal/catalog) combines the PostgreSQL catalog, parser findings and diagnostics into a versioned snapshot.
- [Native snapshot queries](../internal/snapshot) and the [Prism reader](../viewer/snapshot.ts) implement the same v1 contract.
- [Prism](../viewer/main.ts) preserves the recorded endpoint on each hop. A view-to-routine dependency can identify the view without identifying one of its output columns.

## Implementation tasks

Each checkbox is sized as a separately reviewable change. Dependencies are listed where work can proceed independently.

- [x] **1. Define snapshot v1 and a round-trip fixture.** Specify the format identifier, version, capture time, database, schema filters, objects, columns, directed relationships, SQL evidence, and analysis diagnostics. Give each referenced entity an ID scoped to the file. Preserve column order and composite foreign-key pairings. Distinguish catalog facts, parsed references, and fallback results. **Done when** a browser-safe reader and the Go writer agree on a fixture, reject a dangling endpoint or unsupported version with an actionable message, and recognize the existing graph-only export with an explanation of the evidence it lacks.

- [x] **2. Export the real engine result.** Depends on 1. Adapt the load service and usage store to the format. Store a definition once per owner and refer to it from occurrences. Preserve overload identity, quoted names, same-table relationships, unused columns, and unresolved-reference diagnostics. Keep capture credentials out of the file. **Done when** a real PostgreSQL integration fixture round-trips and an offline reader recovers both columns of a composite FK, its constraint identity, and a routine's source evidence.

- [x] **3. Package the capture CLI.** Depends on 2. Use a Go executable with embedded Prism assets and parser. Reuse connection handling, schema filters, and cancellation. Run the parser in a child process of the same executable and dispose it on exit. Write to a temporary file in the output directory, then rename on success. Send diagnostics to stderr and use a nonzero exit status on failure. **Done when** an installed package scans from outside the checkout, exits cleanly, and a failed refresh leaves the previous snapshot readable. [Current binary packaging](../scripts/build-go.mjs)

- [x] **4. Build offline relationship queries.** Depends on 1. Implement the schema inventory, directed object pairs, column references, and one- and two-hop neighborhoods over the reader. Keep same-table details available outside object-link counts. Follow the specific intermediate endpoint and direction on each path. **Done when** a column read by a function leads to a view that calls that function, a sibling column acquires no spurious path, and a view-level dependency remains labeled at view level unless column lineage is established.

- [x] **5. Connect Prism to the file.** Depends on 4. Give the schema overview, four object maps, Object explorer, and visual neighborhood one loaded snapshot. Replace the prototype fixture constructors with queries against it. Add a file picker, load errors, and selection by object ID. Keep the pastel light palette, dark mode, dimmed context, and selectable SQL evidence. **Done when** loading a second file replaces every count, selection, and evidence panel, including empty states, and the views work with the database stopped.

- [x] **6. Deliver the standalone viewer.** Depends on 3 and 5. Bundle the assets with the CLI and implement `open <file>`. Serve the selected snapshot and viewer assets locally, support a printed URL for terminal-only sessions, and stop the server on interrupt. **Acceptance milestone:** from a clean install, scan the integration database, stop it, open the file, select a column, and read the evidence for both hops. Run the same journey with a path containing spaces.

- [x] **7. Add the VS Code file workflow.** Depends on 5. Register a `CustomReadonlyEditorProvider` for `*.pgviz.json`. Use `workspace.fs` to read the selected URI and feed the same viewer bundle in a webview. Keep existing live-load, secret storage, and workspace source navigation available while migrating the existing export command to v1. **Done when** double-clicking the file opens Prism offline, **Reopen With** offers the text editor, and regenerating the file refreshes the view while preserving a selection whose ID still exists. [VS Code custom editors](https://code.visualstudio.com/api/extension-guides/custom-editors)

- [x] **8. Ship a Zed task integration.** Depends on 6. Supply project task examples for scanning the workspace database and opening the current snapshot. Use `command` plus `args` with `$ZED_FILE` for the latter. Run the task from Zed and display Prism in the browser. Zed's documented extension types cover languages, debuggers, themes, snippets, and MCP servers. A custom graphical editor would need a separately verified API. **Done when** a user can generate and reopen a snapshot from the task picker, including a workspace path with spaces. [Zed tasks](https://zed.dev/docs/tasks) · [Zed extension features](https://zed.dev/docs/extensions/developing-extensions)

- [x] **9. Ship a Vim command integration.** Depends on 6. Provide `:PostgresVizOpen` for the current snapshot and `:PostgresVizScan {output}` for capture. On Vim builds with job support, call `job_start()` with an argument list, retain the job handle, and surface failures in Vim. The graphical destination is the same browser viewer. **Done when** capture and open work from Vim, the editor remains responsive, and a missing CLI produces a useful message. [Vim jobs](https://vimhelp.org/channel.txt.html#job_start())

## A useful second increment

The CLI implements `postgres-viz refs --file commerce.pgviz.json --column billing.invoices.total --depth 2 --json` over task 4. Future editor shortcuts could expose the same query as terminal output in Zed or populate a Vim location list for verified workspace matches. Database-definition offsets open captured SQL until a source file and position can be verified. [Vim location lists](https://vimhelp.org/quickfix.txt.html#location-list)
