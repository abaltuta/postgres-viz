import { spawn, spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executableCandidates = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  process.env.GOOGLE_CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
let chrome = executableCandidates.find((candidate) => existsSync(candidate));
if (!chrome) {
  for (const command of [
    "chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    const lookup = spawnSync("which", [command], { encoding: "utf8" });
    if (lookup.status === 0 && lookup.stdout.trim()) {
      chrome = lookup.stdout.trim();
      break;
    }
  }
}
if (!chrome) {
  if (process.env.CI) throw new Error("Chrome is required for the rendered webview test");
  console.log("webview-ui SKIP - Chrome is not installed");
  process.exit(0);
}

const mimeTypes = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "text/javascript"],
]);
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}${sep}`) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.setHeader("content-type", mimeTypes.get(extname(file)) ?? "application/octet-stream");
  createReadStream(file).pipe(response);
});
await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
const address = server.address();
if (!address || typeof address === "string") throw new Error("UI test server has no TCP address");

try {
  for (const [width, height] of [
    [1200, 800],
    [500, 800],
  ]) {
    const chromeProfile = mkdtempSync(join(tmpdir(), "postgres-viz-chrome-"));
    const url = `http://127.0.0.1:${address.port}/test/webview-harness.html`;
    const child = spawn(
      chrome,
      [
        "--headless=new",
        "--no-sandbox",
        "--hide-scrollbars",
        "--disable-background-networking",
        "--disable-extensions",
        "--no-first-run",
        "--remote-debugging-port=0",
        `--user-data-dir=${chromeProfile}`,
        `--window-size=${width},${height}`,
        "about:blank",
      ],
      { detached: true, stdio: "ignore" },
    );
    const screenshot = `/tmp/postgres-viz-ui-${width}x${height}.png`;
    try {
      const activePortFile = join(chromeProfile, "DevToolsActivePort");
      for (let attempt = 0; attempt < 200 && !existsSync(activePortFile); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      if (!existsSync(activePortFile)) throw new Error("Chrome debugging port did not open");
      const port = Number(readFileSync(activePortFile, "utf8").split("\n")[0]);
      let target;
      for (let attempt = 0; attempt < 100 && !target; attempt += 1) {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
          response.json(),
        );
        target = targets.find((candidate) => candidate.type === "page");
        if (!target) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      if (!target) throw new Error("Chrome page target did not open");

      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolveOpen, rejectOpen) => {
        socket.addEventListener("open", resolveOpen, { once: true });
        socket.addEventListener("error", rejectOpen, { once: true });
      });
      let messageId = 0;
      const pending = new Map();
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      });
      const send = (method, params = {}) =>
        new Promise((resolveMessage, rejectMessage) => {
          const id = (messageId += 1);
          pending.set(id, { reject: rejectMessage, resolve: resolveMessage });
          socket.send(JSON.stringify({ id, method, params }));
        });

      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.enable");
      await send("Page.navigate", { url });
      let result;
      for (let attempt = 0; attempt < 150 && !result; attempt += 1) {
        const evaluation = await send("Runtime.evaluate", {
          expression: `(() => {
            const marker = document.querySelector("#ui-test-result");
            if (!marker) return null;
            return { details: marker.dataset.details, result: marker.dataset.result };
          })()`,
          returnByValue: true,
        });
        result = evaluation.result.value;
        if (!result) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      if (!result) throw new Error(`webview ${width}x${height} timed out`);
      if (result.result !== "pass") {
        throw new Error(
          `webview ${width}x${height} failed: ${decodeURIComponent(result.details ?? "")}`,
        );
      }
      const captured = await send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      });
      const png = Buffer.from(captured.data, "base64");
      writeFileSync(screenshot, png);
      if (png.length < 5_000 || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
        throw new Error(`webview screenshot ${width}x${height} is blank or incorrectly sized`);
      }
      socket.close();
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      rmSync(chromeProfile, { force: true, recursive: true });
    }
  }
  console.log("webview-ui OK - wide/narrow layout, canvas, paging, keyboard, screenshots");
} finally {
  await new Promise((resolveClosed) => server.close(resolveClosed));
}
