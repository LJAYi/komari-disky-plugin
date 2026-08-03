import archiver from "archiver";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");

export async function packPlugin(root = process.cwd()) {
  const packageJSON = await readJSON(path.join(root, "package.json"));
  const manifest = await readJSON(path.join(root, "komari-plugin.json"));
  if (packageJSON.version !== manifest.version) {
    throw new Error(`package version ${packageJSON.version} does not match manifest ${manifest.version}`);
  }

  const paths = new Set(["komari-plugin.json", manifest.entry || "script.js"]);
  if (manifest.icon) paths.add(manifest.icon);
  for (const page of manifest.pages || []) {
    if ((page.type || "iframe") === "iframe" && page.file) {
      paths.add(path.dirname(page.file) === "." ? page.file : path.dirname(page.file));
    }
    if (page.icon) paths.add(page.icon);
  }
  for (const item of [...(packageJSON.komari?.files || []), ...(packageJSON.komari?.assets || [])]) {
    paths.add(item);
  }

  const entries = new Map();
  for (const relative of paths) await collectEntries(root, relative, entries);
  const archivePath = path.join(root, "dist", `${manifest.short}-${manifest.version}.zip`);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.rm(archivePath, { force: true });

  const output = createWriteStream(archivePath, { mode: 0o644 });
  // Store entries without deflate so the bytes do not depend on the zlib
  // implementation bundled by a particular Node.js patch release.
  const zip = archiver("zip", { store: true });
  const completed = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    zip.on("error", reject);
  });
  zip.pipe(output);
  for (const [name, full] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    zip.append(await fs.readFile(full), {
      name,
      date: FIXED_ZIP_DATE,
      mode: 0o100644,
    });
  }
  await zip.finalize();
  await completed;
  return archivePath;
}

async function collectEntries(root, relative, entries) {
  const normalized = normalizeRelative(relative);
  const full = path.resolve(root, normalized);
  ensureWithin(root, full);
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink()) throw new Error(`package path cannot be a symlink: ${normalized}`);
  if (stat.isFile()) {
    entries.set(normalized, full);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`unsupported package entry: ${normalized}`);
  const children = await fs.readdir(full);
  for (const child of children.sort()) {
    await collectEntries(root, path.posix.join(normalized, child), entries);
  }
}

function normalizeRelative(relative) {
  if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative)) {
    throw new Error(`invalid package path: ${relative}`);
  }
  const normalized = relative.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "." || normalized.split("/").includes("..")) {
    throw new Error(`package path escapes the project: ${relative}`);
  }
  return normalized;
}

function ensureWithin(root, full) {
  const relative = path.relative(path.resolve(root), full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`package path escapes the project: ${full}`);
  }
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = await packPlugin();
  process.stdout.write(`Packed ${path.relative(process.cwd(), archive)}\n`);
}
