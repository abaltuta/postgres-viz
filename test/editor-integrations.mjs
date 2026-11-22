import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionTasks = JSON.parse(
  readFileSync(join(root, "editors/zed/languages/postgres-viz/tasks.json"), "utf8"),
);
assert.deepEqual(extensionTasks, [
  {
    label: "postgres-viz: Open current snapshot",
    command: "postgres-viz",
    args: ["open", '"$ZED_FILE"'],
  },
  {
    label: "postgres-viz: Scan workspace database",
    command: "postgres-viz",
    args: ["scan", "--out", "database.pgviz.json"],
    cwd: "$ZED_WORKTREE_ROOT",
  },
]);
const tasks = JSON.parse(readFileSync(join(root, ".zed/tasks.json"), "utf8"));
assert.deepEqual(
  tasks.map(({ command, args, cwd }) => ({ command, args, cwd })),
  [
    {
      command: "postgres-viz",
      args: ["scan", "--out", "database.pgviz.json"],
      cwd: "$ZED_WORKTREE_ROOT",
    },
    { command: "postgres-viz", args: ["open", '"$ZED_FILE"'], cwd: "$ZED_WORKTREE_ROOT" },
  ],
);

const vim = spawnSync("vim", ["--version"], { encoding: "utf8" });
if (vim.error?.code === "ENOENT" || !vim.stdout?.includes("+job")) {
  console.log("Vim job checks skipped because Vim with +job is unavailable");
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "postgres viz editors "));
try {
  writeFileSync(
    join(directory, "postgres-viz"),
    `#!/bin/sh
printf '%s\\n' "$1" "$2" "$3" >> "$PV_TEST_DIR/args"
if [ "$1" = scan ]; then
  sleep 1
  touch "$3"
  printf '%s\\n' 'test scan warning' 'Saved snapshot' >&2
else
  printf '%s\\n' 'test viewer failure' 'test viewer detail' >&2
  exit 9
fi
`,
    { mode: 0o700 },
  );

  const script = join(directory, "exercise.vim");
  writeFileSync(
    script,
    String.raw`
execute 'source ' . fnameescape($PV_PLUGIN)
let start = reltime()
PostgresVizScan commerce\ snapshot.pgviz.json
call assert_true(reltimefloat(reltime(start)) < 0.75, 'scan must return before its job exits')
let deadline = reltime()
while !filereadable('commerce snapshot.pgviz.json') && reltimefloat(reltime(deadline)) < 4
  sleep 50m
endwhile
call assert_true(filereadable('commerce snapshot.pgviz.json'))
let deadline = reltime()
while execute('messages') !~ 'Saved snapshot' && reltimefloat(reltime(deadline)) < 4
  sleep 50m
endwhile
call assert_match('test scan warning', execute('messages'))
call assert_match('Saved snapshot', execute('messages'))
let unusual_path = 'checkout\ notes #1.pgviz.json'
execute 'PostgresVizScan ' . fnameescape(unusual_path)
let deadline = reltime()
while !filereadable(unusual_path) && reltimefloat(reltime(deadline)) < 4
  sleep 50m
endwhile
call assert_true(filereadable(unusual_path), 'scan must preserve literal filename characters')
edit commerce\ snapshot.pgviz.json
PostgresVizOpen
let deadline = reltime()
while (execute('messages') !~ 'test viewer detail' || execute('messages') !~ 'exit 9') && reltimefloat(reltime(deadline)) < 4
  sleep 50m
endwhile
call assert_match('test viewer failure', execute('messages'))
call assert_match('test viewer detail', execute('messages'))
call assert_match('open failed (exit 9)', execute('messages'))
let $PATH = '/usr/bin:/bin'
PostgresVizOpen
call assert_match('postgres-viz.*PATH', execute('messages'))
call writefile(v:errors, 'assertions')
qa!
`,
  );
  const run = spawnSync("vim", ["-u", "NONE", "-n", "-es", "-V1", "-S", script], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      PV_PLUGIN: join(root, "editors/vim/plugin/postgres-viz.vim"),
      PV_TEST_DIR: directory,
    },
    timeout: 16000,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  assert.equal(readFileSync(join(directory, "assertions"), "utf8"), "");
  const snapshot = join(realpathSync(directory), "commerce snapshot.pgviz.json");
  const unusual = join(realpathSync(directory), "checkout\\ notes #1.pgviz.json");
  assert.equal(
    readFileSync(join(directory, "args"), "utf8"),
    ["scan", "--out", snapshot, "scan", "--out", unusual, "open", snapshot, "", ""].join("\n"),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("Zed task arguments and Vim job workflow passed");
