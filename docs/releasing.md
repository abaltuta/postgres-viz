# Preparing a release

From a checkout on macOS or Linux, use the Go version in `mise.toml`, Node.js 24, the pinned pnpm version in `package.json`, and the `zip` command.

```sh
pnpm install --frozen-lockfile
pnpm release
```

`release/assets/` contains six CLI ZIPs, six platform-specific VSIX packages, the Zed and Vim extensions, and `SHA256SUMS`. Each CLI ZIP and VSIX includes the bundled dependency notices. On macOS verify the archives with `(cd release/assets && shasum -a 256 -c SHA256SUMS)`. On Linux use `sha256sum -c SHA256SUMS` in that directory.

For a GitHub release, push a version tag beginning with `v` on the commit to distribute. The CI workflow tests PostgreSQL 16 through 19, runs the CLI, editor and viewer checks, builds the packages, and attaches the verified downloads to a **draft release**. Review the generated notes and assets before publishing the draft. Branch and pull-request runs upload a workflow artifact for testing.

After publishing, update the version and four archive hashes in `Formula/postgres-viz.rb`, the version, Windows download URLs and two hashes in `bucket/postgres-viz.json`, and the pinned mise version in the README. Use the published release's `SHA256SUMS`. Commit these updates to the default branch so existing Homebrew and Scoop users can upgrade. mise discovers releases directly from GitHub.
