# Symbol navigation and the database views

## A first editor journey

Open the routine lab snapshot, search for `ledger.account_deltas` using the editor's workspace symbol picker, and open its captured SQL. With the cursor on `e.owner`, Go to Definition should identify `ledger.entries.account_id`. Find References should return recorded occurrences with exact locations. A separate **Explore in postgres-viz** command should open the same object or column and show the two-hop path to `ledger.post_deltas`. That command needs a selection handoff from each editor to the viewer.

## Implementation choices

| Option | What the user gets | Main cost |
| --- | --- | --- |
| Native commands over the existing index | Search a database object and open the viewer or captured SQL. Vim can use a location list and Zed can launch a task. | The interaction differs by editor. Native Go to Definition and Find References need additional integration. |
| Shared snapshot language server | One proposed `postgres-viz lsp --stdio` process answers workspace symbol, definition, hover and exact-reference requests for an explicitly selected snapshot. | Each destination needs a stable document URI and range. Each client needs a small adapter or configuration. |
| Navigation in arbitrary working SQL | Resolve the token under the cursor in a migration or unsaved query, including aliases and overloaded routines. | Requires current-buffer parsing, schema/search-path context, ambiguity handling and invalidating stale results on edits. |

Start with the shared server for captured documents and verified workspace sources. Give the snapshot its own local cache directory and materialize captured definitions as SQL files there, so all three editors can open ordinary file URIs. For objects with metadata only, generate a clearly labeled catalog document containing the qualified name and columns. Prefer a verified workspace declaration when available. The VS Code extension already checks for one exact definition in migration or HCL files. Persisting that mapping requires checking it against the current document text. [Current source matching](../editors/vscode/source.ts)

The routine lab has 18 evidence records, 13 with exact offsets. All three routine-call records point to owning definitions without call-site offsets. Workspace symbol search can use routine identities immediately. Exact Find References for a callee needs the parser to record each call token and range. Until then, show those callers as object-level relationships in the viewer. The server also needs a reverse index from a cursor position to a recorded endpoint. The LSP supplies the requests and response format. [Snapshot contract](snapshot-v1.md) · [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)

| Editor | Proposed integration |
| --- | --- |
| VS Code | Start the shared server from the existing extension. Keep the custom snapshot editor for diagrams. [Language server guide](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide) |
| Zed | Provide an opt-in SQL language-server extension with a small Rust launcher. Keep scan and open as tasks. [Zed language servers](https://zed.dev/docs/extensions/languages) |
| Vim / Neovim | Register the executable with vim-lsp in Vim or the native LSP client in Neovim. Keep the existing Vim commands for opening the viewer. [vim-lsp](https://github.com/prabirshrestha/vim-lsp) · [Neovim LSP](https://neovim.io/doc/user/lsp) |

## View review

The review covered the implementation and the commerce and routine examples. These proposed changes still need a usability trial.

| Current view | Recommendation |
| --- | --- |
| Schema overview | Keep as the landing page. Distinguish visible and total links when filters narrow a cell while the details list stays complete. |
| Orbital map | Keep as a Map mode. Add schema sectors and direction arrows to the selected links. |
| Dependency matrix | Keep for comparing selected schemas. The commerce example has 111 directed object pairs across 25,921 possible cells. Pin the axes during scrolling. |
| Arc diagram | Remove from primary navigation first. It repeats the orbital view's connections and inspector, and its commerce layout spans 3,773 pixels. |
| Reference index | Fold into a searchable Map list mode, preserving keyboard access and pair-level evidence. |
| Object explorer | Keep as Inspect's detailed evidence mode. Show unresolved references alongside the routine that owns them. |
| Visual neighborhood | Make this the default Inspect mode for routines. Allow re-centering on a neighbor and preserve the selected path when switching to evidence. |

Test the proposed **Overview / Map / Inspect** navigation by asking someone to find a schema dependency, trace a column through two routines, and explain the unresolved dynamic command in the routine lab.
