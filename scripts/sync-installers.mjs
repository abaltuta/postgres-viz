import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// Always read the latest published release, including on a retried workflow run.
const release = JSON.parse(
  execFileSync(
    "gh",
    [
      "release",
      "view",
      "--repo",
      process.env.GITHUB_REPOSITORY || "abaltuta/postgres-viz",
      "--json",
      "tagName,assets,isDraft,isPrerelease",
    ],
    { encoding: "utf8" },
  ),
);
if (release.isDraft || release.isPrerelease || !/^v\d+\.\d+\.\d+$/.test(release.tagName)) {
  throw Error("Expected a published stable release tagged vMAJOR.MINOR.PATCH");
}
const version = release.tagName.slice(1);
function archive(platform) {
  const name = "postgres-viz-" + platform + ".zip";
  const asset = release.assets.find((entry) => entry.name === name);
  if (!asset?.url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw Error("Missing release asset or SHA-256 digest for " + name);
  }
  return { url: asset.url, hash: asset.digest.slice(7) };
}

const formulaPath = "Formula/postgres-viz.rb";
const bucketPath = "bucket/postgres-viz.json";
let formula = readFileSync(formulaPath, "utf8");
function replaceOnce(text, pattern, value) {
  if (text.split(pattern).length !== 2) throw Error("Expected one match for " + pattern);
  return text.replace(pattern, value);
}
formula = replaceOnce(formula, /^  version "[^"]+"$/m, `  version "${version}"`);
for (const os of ["darwin", "linux"]) {
  for (const arch of ["amd64", "arm64"]) {
    const platform = os + "-" + arch;
    const pattern = new RegExp(`postgres-viz-${platform}\\.zip"\\s+sha256 "[a-f0-9]{64}"`);
    formula = replaceOnce(formula, pattern, (match) =>
      match.replace(/[a-f0-9]{64}/, archive(platform).hash),
    );
  }
}
const bucket = JSON.parse(readFileSync(bucketPath, "utf8"));
bucket.version = version;
bucket.architecture["64bit"] = archive("windows-amd64");
bucket.architecture.arm64 = archive("windows-arm64");
const readme = replaceOnce(
  readFileSync("README.md", "utf8"),
  /mise use -g github:abaltuta\/postgres-viz@\d+\.\d+\.\d+/,
  "mise use -g github:abaltuta/postgres-viz@" + version,
);
// Resolve every asset and validate the templates before changing any file.
writeFileSync(formulaPath, formula);
writeFileSync(bucketPath, JSON.stringify(bucket, null, 2) + "\n");
writeFileSync("README.md", readme);
