import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { packPlugin } from "./pack.mjs";

const first = await packPlugin();
const firstDigest = await sha256(first);
const second = await packPlugin();
const secondDigest = await sha256(second);
if (firstDigest !== secondDigest) {
  throw new Error(`package is not reproducible: ${firstDigest} != ${secondDigest}`);
}
const checksumPath = `${second}.sha256`;
await fs.writeFile(checksumPath, `${secondDigest}  ${path.basename(second)}\n`, "utf8");
process.stdout.write(`Verified ${path.relative(process.cwd(), second)} (${secondDigest})\n`);

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
