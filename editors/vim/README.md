# postgres-viz for Vim

Install the platform CLI on your PATH. Extract this package into `~/.vim/pack/postgres-viz/start/postgres-viz/`, or copy `plugin/postgres-viz.vim` into a plugin directory on your Vim runtime path. The integration uses Vim's `+job` feature.

- Run `:PostgresVizScan database.pgviz.json` with `DATABASE_URL` in Vim's environment to capture a database. Use `:messages` to review the result.
- Edit the saved `.pgviz.json` file and run `:PostgresVizOpen` to explore it in your browser.
