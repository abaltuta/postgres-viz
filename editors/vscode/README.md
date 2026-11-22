# Postgres Viz for VS Code

Install the VSIX for your operating system and CPU with **Extensions: Install from VSIX**. Each package includes the matching Go CLI and the Prism viewer.

Open a `.pgviz.json` file to explore its dependency graph offline. Select a column in **Object explorer** to follow its references. Select a relationship to inspect the SQL behind it.

To capture a live database, run **Postgres Viz: Capture Database Snapshot** from the Command Palette. Use **Postgres Viz: Manage Connections** to configure a connection and **Postgres Viz: Refresh Database Snapshot** to update an existing capture. Connection credentials use VS Code's secret storage.
