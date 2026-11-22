import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import vsce from "@vscode/vsce";

// Stage one platform at a time so the local development extension keeps its host binary.
const output = resolve("release/assets");
await mkdir(output, { recursive: true });
const stage = await mkdtemp(resolve("release/.pack-"));
const artifacts = [];
const go = process.env.GO || "go";
const goText = (...args) => execFileSync(go, args, { encoding: "utf8" }).trim();

function zip(name, cwd, files) {
  execFileSync("zip", ["-q", "-X", "-9", join(stage, name), ...files], { cwd });
  artifacts.push(name);
}

try {
  const notices = [await readFile(join(goText("env", "GOROOT"), "LICENSE"), "utf8")];
  const modules = goText(
    "list",
    "-deps",
    "-f",
    "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}",
    ".",
  );
  for (const line of [...new Set(modules.split("\n").filter(Boolean))].sort()) {
    const [module, version, dir] = line.split("\t");
    const files = (await readdir(dir))
      .filter((name) => /^(LICENSE|NOTICE|COPYRIGHT)(\.|$)/.test(name))
      .sort();
    if (module === "github.com/pganalyze/pg_query_go/v6") files.push("parser/COPYRIGHT");
    if (module === "github.com/wasilibs/go-pgquery") files.push("internal/cparser/COPYRIGHT");
    for (const file of files) {
      notices.push(`${module} ${version} / ${file}\n\n${await readFile(join(dir, file), "utf8")}`);
    }
  }
  const notice = join(stage, "THIRD-PARTY-NOTICES.txt");
  await writeFile(notice, "Go runtime and standard library\n\n" + notices.join("\n\n"));

  for (const [os, vscodeOS] of [
    ["darwin", "darwin"],
    ["linux", "linux"],
    ["windows", "win32"],
  ]) {
    for (const [arch, vscodeArch] of [
      ["amd64", "x64"],
      ["arm64", "arm64"],
    ]) {
      const platform = os + "-" + arch;
      const exe = os === "windows" ? "postgres-viz.exe" : "postgres-viz";
      const cli = join(stage, platform);
      await mkdir(cli);
      await cp(join("release", platform, exe), join(cli, exe));
      await cp(notice, join(cli, "THIRD-PARTY-NOTICES.txt"));
      await cp("LICENSE", join(cli, "LICENSE"));
      zip("postgres-viz-" + platform + ".zip", cli, [exe, "LICENSE", "THIRD-PARTY-NOTICES.txt"]);

      const extension = join(cli, "extension");
      await mkdir(join(extension, "dist"), { recursive: true });
      await cp("editors/vscode/package.json", join(extension, "package.json"));
      await cp("editors/vscode/README.md", join(extension, "README.md"));
      await cp("LICENSE", join(extension, "LICENSE"));
      await cp("editors/vscode/dist/extension.js", join(extension, "dist/extension.js"));
      await cp("dist/viewer", join(extension, "dist/viewer"), { recursive: true });
      await cp(join(cli, exe), join(extension, "dist", exe));
      await cp(notice, join(extension, "THIRD-PARTY-NOTICES.txt"));
      const target = vscodeOS + "-" + vscodeArch;
      const name = "postgres-viz-" + target + ".vsix";
      await vsce.createVSIX({
        cwd: extension,
        packagePath: join(stage, name),
        target,
        dependencies: false,
        allowMissingRepository: true,
      });
      artifacts.push(name);
    }
  }
  const zed = join(stage, "zed");
  await cp("editors/zed", zed, { recursive: true, filter: (path) => !path.split(/[\\/]/).pop().startsWith(".") });
  await cp("LICENSE", join(zed, "LICENSE"));
  execFileSync("zip", ["-q", "-X", "-9", "-r", "postgres-viz-zed.zip", "zed"], { cwd: stage });
  artifacts.push("postgres-viz-zed.zip");
  const vim = join(stage, "vim");
  await cp("editors/vim/plugin", join(vim, "plugin"), { recursive: true });
  await cp("editors/vim/README.md", join(vim, "README.md"));
  await cp("LICENSE", join(vim, "LICENSE"));
  zip("postgres-viz-vim.zip", vim, ["plugin/postgres-viz.vim", "README.md", "LICENSE"]);
  const sums = [];
  for (const name of artifacts.sort()) {
    const hash = createHash("sha256")
      .update(await readFile(join(stage, name)))
      .digest("hex");
    sums.push(hash + "  " + name);
  }
  await writeFile(join(stage, "SHA256SUMS"), sums.join("\n") + "\n");
  for (const name of [...artifacts, "SHA256SUMS"]) {
    await rename(join(stage, name), join(output, name));
  }
  console.log(`Packaged ${artifacts.length} archives in release/assets`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
