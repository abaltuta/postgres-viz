import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const name = "pgviz-test-" + process.pid;
let started = false;
function stop() {
  if (started) {
    started = false;
    execFileSync("docker", ["stop", name], { stdio: "inherit" });
  }
}
try {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const major = process.env.PGVIZ_POSTGRES_MAJOR ?? "16";
    if (!["16", "17", "18", "19"].includes(major))
      throw new Error("PGVIZ_POSTGRES_MAJOR must be 16, 17, 18, or 19");
    execFileSync("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_PASSWORD=test",
      "postgres:" + major,
    ]);
    started = true;
    const port = execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" })
      .trim()
      .split(":")
      .pop();
    url = "postgres://postgres:test@127.0.0.1:" + port + "/postgres";
    for (let attempt = 0; ; attempt++) {
      try {
        execFileSync("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], {
          stdio: "ignore",
        });
        break;
      } catch (error) {
        if (attempt >= 60) throw error;
        await sleep(500);
      }
    }
  }
  execFileSync("go", ["test", "-count=1", "-v", "./internal/catalog", "./internal/integration"], {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: url,
      PGVIZ_TEST_DATABASE_URL: url,
      PGVIZ_BINARY:
        process.env.PGVIZ_BINARY ||
        resolve("dist", process.platform === "win32" ? "postgres-viz.exe" : "postgres-viz"),
    },
  });
} finally {
  stop();
}
