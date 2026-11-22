import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = new Map([
  ["/test/viewer-browser.html", "text/html"],
  ["/dist/viewer/index.html", "text/html"],
  ["/dist/viewer/main.js", "application/javascript"],
  ["/dist/viewer/style.css", "text/css"],
]);
const server = createServer(async (req, res) => {
  const type = assets.get(req.url);
  if (!type) return res.writeHead(404).end();
  try {
    const contents = await readFile(join(root, req.url));
    res.writeHead(200, { "Content-Type": type }).end(contents);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve, reject) =>
  server.once("error", reject).listen(0, "127.0.0.1", resolve),
);
try {
  const url = "http://127.0.0.1:" + server.address().port + "/test/viewer-browser.html";
  const child = spawn(
    process.env.CHROME_BIN || "chromium",
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--dump-dom",
      "--virtual-time-budget=12000",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let html = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (html += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise((resolve, reject) =>
      child.once("error", reject).once("exit", resolve),
    );
    const result = html.match(/<output id="result">([^<]+)<\/output>/)?.[1];
    if (code !== 0 || result !== "PASS")
      throw Error("Viewer browser test: " + (result || stderr || code));
    console.log("Viewer browser tests passed");
  } finally {
    clearTimeout(timer);
  }
} finally {
  server.close();
}
