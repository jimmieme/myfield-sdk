import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

const root = fileURLToPath(new URL("../", import.meta.url));
const update = process.argv.includes("--update");
const build = process.argv.includes("--build");
const scratch = path.join(root, ".api-build");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (JSON.stringify(Object.keys(pkg.exports)) !== JSON.stringify(["."])) throw new Error("Update API extraction and consumer checks for new package entries.");
const normalized = text => text.replace(/\r\n/g, "\n");
function run(tool, args) {
  const result = spawnSync(process.execPath, [path.join(root, "node_modules", tool), ...args], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${tool} failed`);
}
async function tree(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const files = await Promise.all(entries.map(async entry => entry.isDirectory()
    ? (await tree(path.join(dir, entry.name))).map(file => path.join(entry.name, file)) : [entry.name]));
  return files.flat().sort();
}
async function publish(from, to, write) {
  const files = await tree(from);
  if (!write && JSON.stringify(files) !== JSON.stringify(await tree(to))) throw new Error(`${path.relative(root, to)} is stale; run npm run api:update`);
  if (write) {
    await fs.rm(to, { recursive: true, force: true });
    await fs.mkdir(to, { recursive: true });
  }
  for (const file of files) {
    const content = normalized(await fs.readFile(path.join(from, file), "utf8"));
    if (write) {
      await fs.mkdir(path.dirname(path.join(to, file)), { recursive: true });
      await fs.writeFile(path.join(to, file), content);
    } else if (content !== normalized(await fs.readFile(path.join(to, file), "utf8"))) {
      throw new Error(`${path.relative(root, path.join(to, file))} is stale; run npm run api:update`);
    }
  }
}
await fs.rm(scratch, { recursive: true, force: true });
await fs.mkdir(path.join(root, "etc"), { recursive: true });
run("typescript/bin/tsc", ["-p", "tsconfig.api.json"]);
const config = ExtractorConfig.loadFileAndPrepare(path.join(root, "config/api-extractor.json"));
const result = Extractor.invoke(config, { localBuild: update, showVerboseMessages: false });
if (!result.succeeded) throw new Error("API extraction failed");
await publish(path.join(scratch, "types"), path.join(root, "types"), update || build);
if (!build) {
  run("typedoc/bin/typedoc", ["--options", "config/typedoc.json"]);
  await publish(path.join(scratch, "docs"), path.join(root, "docs/api"), update);
} else {
  const model = JSON.parse(await fs.readFile(path.join(scratch, "sdk.api.json"), "utf8"));
  const expected = [...new Set(model.members[0].members.filter(item => ["Class", "Function", "Variable", "Enum", "Namespace"].includes(item.kind)).map(item => item.name))].sort();
  const actual = Object.keys(await import(pathToFileURL(path.join(root, pkg.exports["."].import)).href)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Runtime exports differ from public declarations");
}
console.log(update ? "Updated API report, declarations and reference." : build ? "Built public declarations and checked exports." : "API report, declarations and reference are current.");
