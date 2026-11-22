# postgres-viz for Zed

Open a `.pgviz.json` snapshot to browse the objects and columns in Zed's outline. Use **task: spawn** and select **postgres-viz: Open current snapshot** for the interactive dependency map in your browser. Opening a saved snapshot works offline.

## Install

1. Put the `postgres-viz` executable for your platform on the PATH visible to Zed. Run `postgres-viz --help` in Zed's terminal to check.
2. In Zed's command palette, run **zed: install dev extension** and select the folder containing this extension's `extension.toml`.
3. Open a snapshot. Its language indicator should read **postgres-viz**. The repository includes `examples/commerce/commerce.pgviz.json` for a first look.

## Capture a database

Open a project folder and make `DATABASE_URL` available to its task environment. With a snapshot active, select **postgres-viz: Scan workspace database** from **task: spawn**. A successful capture writes or replaces `database.pgviz.json` in the project root. Open that file and run the open task.

For a first capture in a project without a snapshot, select **postgres-viz** as the language of an empty buffer in that project to enable the scan task, or run `postgres-viz scan --out database.pgviz.json` in Zed's terminal.
