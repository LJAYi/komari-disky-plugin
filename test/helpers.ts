import type { SnapshotDatabase, SnapshotStore } from "../src/types";

export class MemoryStore implements SnapshotStore {
  database: SnapshotDatabase = {
    schema_version: 1,
    snapshots: {},
    active_generations: {},
    watermarks: {},
    retired_generations: {},
  };
  saves = 0;

  load(): SnapshotDatabase {
    return structuredClone(this.database);
  }

  save(database: SnapshotDatabase): void {
    this.database = structuredClone(database);
    this.saves += 1;
  }
}

export function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    generation_id: "0198cd80-2dc0-7000-8000-000000000001",
    mode: "full",
    provider: "docker",
    provider_instance: "local",
    capabilities: ["docker.swarm", "docker.container"],
    snapshot_id: "snapshot-1",
    sequence: 1,
    collected_at: "2026-08-03T00:00:00Z",
    resources: [
      {
        id: "docker:container:web",
        type: "docker.container",
        name: "web",
        status: "running",
        labels: { project: "example" },
        attributes: { image: "nginx:stable" },
        metrics: { cpu_percent: 1.5, memory_bytes: 1024 },
      },
    ],
    relationships: [],
    ...overrides,
  };
}
