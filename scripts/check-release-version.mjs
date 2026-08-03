import { promises as fs } from "node:fs";

const tag = process.argv[2] || "";
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`release tag must look like v1.2.3: ${tag}`);
}
const packageJSON = JSON.parse(await fs.readFile("package.json", "utf8"));
const manifest = JSON.parse(await fs.readFile("komari-plugin.json", "utf8"));
const version = tag.slice(1);
if (packageJSON.version !== version || manifest.version !== version) {
  throw new Error(
    `tag ${tag}, package ${packageJSON.version}, and manifest ${manifest.version} must match`,
  );
}
process.stdout.write(`Release version ${version} is consistent\n`);
