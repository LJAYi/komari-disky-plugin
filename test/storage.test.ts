import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileSnapshotStore } from "../src/storage";
import type { SnapshotDatabase } from "../src/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("JsonFileSnapshotStore", () => {
  it("atomically persists and reloads the database", () => {
    const directory = temporaryDirectory();
    const store = new JsonFileSnapshotStore(directory);
    const database: SnapshotDatabase = {
      schema_version: 1,
      snapshots: {},
      active_generations: {},
      watermarks: {},
      retired_generations: {},
    };
    store.save(database);
    expect(store.load()).toEqual(database);
  });

  it("fails closed instead of overwriting corrupt state", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "snapshots-v1.json"), "not-json", "utf8");
    expect(() => new JsonFileSnapshotStore(directory).load())
      .toThrow(/cannot load Disky snapshot database/);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "komari-disky-plugin-"));
  temporaryDirectories.push(directory);
  return directory;
}
