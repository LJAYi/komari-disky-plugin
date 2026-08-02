import type { SnapshotDatabase, SnapshotStore } from "./types";

const fs = require("node:fs");
const path = require("node:path");

export class JsonFileSnapshotStore implements SnapshotStore {
  private readonly file: string;
  private readonly temporaryFile: string;

  constructor(storageDirectory: string) {
    this.file = path.join(storageDirectory, "snapshots-v1.json");
    this.temporaryFile = path.join(storageDirectory, "snapshots-v1.json.tmp");
  }

  load(): SnapshotDatabase {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) return emptyDatabase();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed?.schema_version !== 1 || !isPlainObject(parsed.snapshots)) {
        throw new Error("unsupported snapshot database schema");
      }
      return parsed as SnapshotDatabase;
    } catch (error) {
      throw new Error(`cannot load Disky snapshot database: ${errorMessage(error)}`);
    }
  }

  save(database: SnapshotDatabase): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.temporaryFile, `${JSON.stringify(database)}\n`, { mode: 0o600 });
    fs.renameSync(this.temporaryFile, this.file);
  }
}

function emptyDatabase(): SnapshotDatabase {
  return {
    schema_version: 1,
    snapshots: {},
    active_generations: {},
    watermarks: {},
    retired_generations: {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
