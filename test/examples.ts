import { readFileSync } from "node:fs";
import { checkExample, examples } from "./examples/check";
import { readSnapshot } from "../viewer/snapshot";

for (const name of examples) {
  const snapshot = readSnapshot(
    JSON.parse(readFileSync(`examples/${name}/${name}.pgviz.json`, "utf8")),
  );
  checkExample(name, snapshot);
  console.log(name + " offline example passed");
}
