# Maintaining postgres-viz

## Cut a release

Start on a clean `main` that matches `origin/main`. Run the [local development checks](README.md#development) and push the changes you want to ship. The account pushing the tag needs write access to the repository.

```sh
pnpm release:cut patch --dry-run
pnpm release:cut patch
```

Choose `patch` for a fix, `minor` for a feature, or `major` for a breaking change. From `0.10.0`, these produce `0.10.1`, `0.11.0`, and `1.0.0` respectively. The preview prints the next version without changing files or contacting GitHub.

The command updates the project, VS Code and Zed versions, creates a release commit and pushes the commit and version tag together. The tag starts **Draft release** in GitHub Actions. It builds six CLI ZIPs, six matching VSIX packages, the Zed and Vim ZIPs and `SHA256SUMS`. It verifies the archives and attaches them to a draft with generated release notes.

Open [GitHub Releases](https://github.com/abaltuta/postgres-viz/releases), review the notes and downloads, then publish the draft as the latest release. **Update release installers** updates the Homebrew formula, Scoop manifest and mise command on `main` using the published ZIPs' SHA-256 digests. The snapshot format has its own version.

## Retry an interrupted release

- **Git push rejected after the version commit.** Both remote refs are updated atomically. Resolve the reported Git error, confirm that HEAD is the intended release commit, and retry the push using the version already in `package.json`. For example, for `0.10.1`, run `git push --atomic origin HEAD:refs/heads/main HEAD:refs/tags/v0.10.1`.
- **Packaging failed.** Inspect the tagged **Draft release** run and rerun the failed job after resolving the cause.
- **Installer update failed.** Rerun **Update release installers** from Actions. It reads the latest published release and skips the commit if the files already match. If branch protections require a PR, run `node scripts/sync-installers.mjs` in a checkout with an authenticated `gh` CLI and submit the diff.

## Build packages locally

On macOS or Linux, use the Go version in `mise.toml`, Node.js 24, the pinned pnpm version and `zip`.

```sh
pnpm install --frozen-lockfile
pnpm release
```

This writes the same set of packages to `release/assets/` without bumping versions or publishing. From that directory, verify with `shasum -a 256 -c SHA256SUMS` on macOS or `sha256sum -c SHA256SUMS` on Linux.

## Refresh the commerce example

Build the CLI and set `DATABASE_URL` to an empty PostgreSQL 16 database. Load the fixture and regenerate the snapshot from the repository root.

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -1 -f examples/commerce/schema.sql
./dist/postgres-viz scan --out examples/commerce/commerce.pgviz.json
```
