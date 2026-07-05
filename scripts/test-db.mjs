import { spawnSync } from "node:child_process";

const name = "pgviz-test";
const defaultUrl = "postgres://postgres:pg@localhost:54339/postgres";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function capture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) return "";
  return res.stdout.trim();
}

function hasDockerContainer(all = false) {
  const out = capture("docker", [
    "ps",
    ...(all ? ["-a"] : []),
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Names}}",
  ]);
  return out.split(/\r?\n/).includes(name);
}

let started = false;
let stopped = false;

function stopStartedContainer() {
  if (!started || stopped) return;
  stopped = true;
  spawnSync("docker", ["stop", name], { stdio: "inherit" });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopStartedContainer();
    process.kill(process.pid, signal);
  });
}

try {
  if (!process.env.DATABASE_URL) {
    if (!hasDockerContainer()) {
      if (hasDockerContainer(true)) {
        run("docker", ["start", name]);
      } else {
        run("docker", [
          "run",
          "-d",
          "--rm",
          "--name",
          name,
          "-p",
          "54339:5432",
          "-e",
          "POSTGRES_PASSWORD=pg",
          "postgres:16",
        ]);
      }
      started = true;
    }
  }

  run("node", ["esbuild.mjs", "--smoke"]);
  run("node", ["dist-test/integration.js"], {
    env: { DATABASE_URL: process.env.DATABASE_URL ?? defaultUrl },
  });
} finally {
  stopStartedContainer();
}
