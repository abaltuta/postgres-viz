import { execFileSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

const go = process.env.GO || "go";
const { GOHOSTOS, GOHOSTARCH } = JSON.parse(
  execFileSync(go, ["env", "-json", "GOHOSTOS", "GOHOSTARCH"]),
);
const release = process.argv.includes("--release");
const targets = release
  ? ["darwin", "linux", "windows"].flatMap((os) => ["amd64", "arm64"].map((arch) => [os, arch]))
  : [[GOHOSTOS, GOHOSTARCH]];
for (const [os, arch] of targets) {
  const name = os === "windows" ? "postgres-viz.exe" : "postgres-viz";
  const directory = release ? join("release", os + "-" + arch) : "dist";
  const output = join(directory, name);
  await mkdir(directory, { recursive: true });
  execFileSync(go, ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "."], {
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: os, GOARCH: arch },
  });
  if (os === GOHOSTOS && arch === GOHOSTARCH) {
    await mkdir("editors/vscode/dist", { recursive: true });
    await cp(output, join("editors/vscode/dist", name));
    if (release) await cp(output, join("dist", name));
  }
  console.log(output);
}
