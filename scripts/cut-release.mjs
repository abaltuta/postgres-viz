import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const [bump, option, ...extra] = process.argv.slice(2);
const index = ["major", "minor", "patch"].indexOf(bump);
if (index < 0 || (option && option !== "--dry-run") || extra.length) {
  throw Error("Usage: pnpm release:cut <patch|minor|major> [--dry-run]");
}
const manifests = ["package.json", "editors/vscode/package.json", "editors/zed/extension.toml"];
const [project, vscode, zed] = manifests.map((path) => readFileSync(path, "utf8"));
const pkg = JSON.parse(project);
const extension = JSON.parse(vscode);
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || !/^version = "\d+\.\d+\.\d+"$/m.test(zed)) {
  throw Error("Expected stable major.minor.patch versions in the release manifests");
}
const parts = pkg.version.split(".").map(Number);
parts[index]++;
parts.fill(0, index + 1);
const version = parts.join(".");
const tag = "v" + version;
console.log(
  `${pkg.version} -> ${version}: update project, VS Code and Zed; push main and ${tag} to origin.`,
);
if (option === "--dry-run") process.exit(0);

if (git("branch", "--show-current") !== "main" || git("status", "--porcelain")) {
  throw Error("Start from a clean main branch");
}
const existing = git("ls-remote", "origin", "refs/heads/main", "refs/tags/" + tag);
if (existing.includes("refs/tags/" + tag)) throw Error(tag + " already exists on origin");
if (existing.split(/\s+/)[0] !== git("rev-parse", "HEAD")) {
  throw Error("Push or pull main first so this release contains exactly the reviewed commits");
}
pkg.version = extension.version = version;
writeFileSync(manifests[0], JSON.stringify(pkg, null, 2) + "\n");
writeFileSync(manifests[1], JSON.stringify(extension, null, 2) + "\n");
writeFileSync(manifests[2], zed.replace(/^version = ".*"$/m, `version = "${version}"`));
git("commit", "-m", "Release " + tag, "--", ...manifests);
// An atomic push leaves both remote refs unchanged if either update is rejected.
git("push", "--atomic", "origin", "HEAD:refs/heads/main", "HEAD:refs/tags/" + tag);
console.log(`Pushed ${tag}. Review the draft on GitHub when packaging finishes.`);
