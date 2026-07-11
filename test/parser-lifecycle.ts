import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { disposeParser, getParser } from "../src/analyze";

const CHILD_FLAG = "--concurrent-parser-child";

async function runChild(): Promise<void> {
  const disposedInitialization = getParser();
  disposeParser();
  assert.equal(
    await disposedInitialization,
    null,
    "disposing during initialization must not publish a live parser afterward",
  );

  const parsers = await Promise.all([getParser(), getParser(), getParser(), getParser()]);
  assert.ok(parsers.every(Boolean), "all concurrent callers receive a parser");
  assert.ok(
    parsers.every((parser) => parser === parsers[0]),
    "concurrent callers share one parser pool",
  );
  disposeParser();
  console.log("parser child disposed");
}

async function assertChildExits(): Promise<void> {
  const child = spawn(process.execPath, [__filename, CHILD_FLAG], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`concurrent parser disposal left the subprocess alive\n${stdout}${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(`parser child exited with code ${code}, signal ${signal}\n${stdout}${stderr}`),
        );
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.includes(CHILD_FLAG)) {
    await runChild();
    return;
  }
  await assertChildExits();
  console.log("parser-lifecycle OK - concurrent initialization disposes every worker");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
