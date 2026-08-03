import type {
  ApplyResult,
  ResourceSnapshotInput,
  SnapshotDatabase,
  SnapshotOverview,
  SnapshotScope,
  SnapshotStore,
  SnapshotSummary,
  SnapshotWatermark,
  StoredSnapshot,
} from "./types";

export type SnapshotRejection = "stale" | "retired" | "conflict";

export class SnapshotRejectedError extends Error {
  constructor(
    readonly reason: SnapshotRejection,
    message: string,
  ) {
    super(message);
    this.name = "SnapshotRejectedError";
  }
}

const MAX_SCOPES_PER_CLIENT = 32;
const MAX_SCOPES_TOTAL = 512;
const MAX_GENERATIONS_PER_SCOPE = 1024;
const STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SnapshotView extends StoredSnapshot {
  stale: boolean;
}

export class SnapshotRegistry {
  private database: SnapshotDatabase;

  constructor(
    private readonly store: SnapshotStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.database = normalizeDatabase(store.load());
  }

  apply(sourceClientUUID: string, input: ResourceSnapshotInput, defaultTTLSeconds: number): ApplyResult {
    const scope = scopeKey({
      source_client_uuid: sourceClientUUID,
      provider: input.provider,
      provider_instance: input.provider_instance,
    });
    const activeGeneration = this.database.active_generations[scope];
    const retired = this.database.retired_generations[scope] || {};
    const watermarks = this.database.watermarks[scope] || {};
    const watermark = watermarks[input.generation_id];

    if (retired[input.generation_id]) {
      throw new SnapshotRejectedError("retired", "generation_id has been retired");
    }

    if (activeGeneration === input.generation_id) {
      if (!watermark) {
        throw new SnapshotRejectedError("conflict", "active generation has no watermark");
      }
      if (input.snapshot_id === watermark.snapshot_id) {
        if (input.sequence === watermark.sequence) return { status: "duplicate", watermark };
        throw new SnapshotRejectedError(
          "conflict",
          "snapshot_id is already associated with another sequence",
        );
      }
      if (input.sequence < watermark.sequence) {
        throw new SnapshotRejectedError("stale", "sequence is older than the active watermark");
      }
      if (input.sequence === watermark.sequence) {
        throw new SnapshotRejectedError("conflict", "sequence already belongs to another snapshot_id");
      }
    } else {
      if (input.sequence !== 1) {
        throw new SnapshotRejectedError("conflict", "a new generation must start at sequence 1");
      }
      if (watermark) {
        // A non-active generation with durable history is never allowed to
        // become active again, even if an older database omitted its retired marker.
        throw new SnapshotRejectedError("retired", "generation_id is no longer active");
      }
      if (!activeGeneration) this.assertScopeCapacity(sourceClientUUID);
      this.assertGenerationCapacity(scope);
    }

    const receivedAt = this.now();
    const ttlSeconds = input.ttl_seconds ?? defaultTTLSeconds;
    const snapshot: StoredSnapshot = {
      ...input,
      ttl_seconds: ttlSeconds,
      source_client_uuid: sourceClientUUID,
      received_at: receivedAt.toISOString(),
      expires_at: new Date(receivedAt.getTime() + ttlSeconds * 1000).toISOString(),
    };

    if (activeGeneration && activeGeneration !== input.generation_id) {
      this.database.retired_generations[scope] ||= {};
      this.database.retired_generations[scope][activeGeneration] = receivedAt.toISOString();
    }
    this.database.active_generations[scope] = input.generation_id;
    this.database.watermarks[scope] ||= {};
    this.database.watermarks[scope][input.generation_id] = watermarkFrom(snapshot);
    this.database.snapshots[scope] = snapshot;
    this.persist();
    return { status: "accepted", snapshot };
  }

  list(filter: Partial<SnapshotScope> = {}): SnapshotView[] {
    const now = this.now().getTime();
    return Object.values(this.database.snapshots)
      .filter((snapshot) =>
        (!filter.source_client_uuid || snapshot.source_client_uuid === filter.source_client_uuid) &&
        (!filter.provider || snapshot.provider === filter.provider) &&
        (!filter.provider_instance || snapshot.provider_instance === filter.provider_instance),
      )
      .map((snapshot) => ({ ...snapshot, stale: Date.parse(snapshot.expires_at) <= now }))
      .sort((left, right) => left.source_client_uuid.localeCompare(right.source_client_uuid) ||
        left.provider.localeCompare(right.provider) ||
        left.provider_instance.localeCompare(right.provider_instance));
  }

  overview(): SnapshotOverview {
    const snapshots = Object.values(this.database.snapshots);
    const now = this.now().getTime();
    return {
      clients: new Set(snapshots.map((snapshot) => snapshot.source_client_uuid)).size,
      providers: new Set(snapshots.map((snapshot) => snapshot.provider)).size,
      snapshots: snapshots.length,
      resources: snapshots.reduce((sum, snapshot) => sum + snapshot.resources.length, 0),
      relationships: snapshots.reduce((sum, snapshot) => sum + snapshot.relationships.length, 0),
      stale: snapshots.filter((snapshot) => Date.parse(snapshot.expires_at) <= now).length,
      generated_at: this.now().toISOString(),
    };
  }

  summaries(filter: Partial<SnapshotScope> = {}): SnapshotSummary[] {
    return this.list(filter).map((snapshot) => ({
      source_client_uuid: snapshot.source_client_uuid,
      provider: snapshot.provider,
      provider_instance: snapshot.provider_instance,
      generation_id: snapshot.generation_id,
      sequence: snapshot.sequence,
      collected_at: snapshot.collected_at,
      received_at: snapshot.received_at,
      expires_at: snapshot.expires_at,
      stale: snapshot.stale,
      resource_count: snapshot.resources.length,
      relationship_count: snapshot.relationships.length,
      resource_types: countResourceTypes(snapshot.resources),
    }));
  }

  pruneExpired(): number {
    const now = this.now().getTime();
    let removed = 0;
    for (const [key, snapshot] of Object.entries(this.database.snapshots)) {
      if (Date.parse(snapshot.expires_at) + STALE_RETENTION_MS <= now) {
        delete this.database.snapshots[key];
        removed += 1;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  private assertScopeCapacity(sourceClientUUID: string): void {
    const keys = Object.keys(this.database.active_generations);
    if (keys.length >= MAX_SCOPES_TOTAL) {
      throw new SnapshotRejectedError("conflict", `snapshot scope limit of ${MAX_SCOPES_TOTAL} reached`);
    }
    const clientScopes = keys.filter((key) => scopeClientUUID(key) === sourceClientUUID).length;
    if (clientScopes >= MAX_SCOPES_PER_CLIENT) {
      throw new SnapshotRejectedError(
        "conflict",
        `client snapshot scope limit of ${MAX_SCOPES_PER_CLIENT} reached`,
      );
    }
  }

  private assertGenerationCapacity(scope: string): void {
    const count = Object.keys(this.database.watermarks[scope] || {}).length;
    if (count >= MAX_GENERATIONS_PER_SCOPE) {
      throw new SnapshotRejectedError(
        "conflict",
        `generation limit of ${MAX_GENERATIONS_PER_SCOPE} reached for this scope`,
      );
    }
  }

  private persist(): void {
    this.store.save(this.database);
  }
}

function countResourceTypes(resources: Array<{ type: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const resource of resources) counts[resource.type] = (counts[resource.type] || 0) + 1;
  return counts;
}

export function scopeKey(scope: SnapshotScope): string {
  return JSON.stringify([
    scope.source_client_uuid,
    scope.provider,
    scope.provider_instance,
  ]);
}

function scopeClientUUID(key: string): string | undefined {
  try {
    const decoded = JSON.parse(key);
    return Array.isArray(decoded) && typeof decoded[0] === "string" ? decoded[0] : undefined;
  } catch {
    return undefined;
  }
}

function watermarkFrom(snapshot: StoredSnapshot): SnapshotWatermark {
  return {
    generation_id: snapshot.generation_id,
    snapshot_id: snapshot.snapshot_id,
    sequence: snapshot.sequence,
    accepted_at: snapshot.received_at,
    expires_at: snapshot.expires_at,
  };
}

function normalizeDatabase(database: SnapshotDatabase): SnapshotDatabase {
  if (!database || database.schema_version !== 1 || !database.snapshots) {
    return emptyDatabase();
  }
  database.active_generations ||= {};
  database.watermarks ||= {};
  database.retired_generations ||= {};
  for (const [key, snapshot] of Object.entries(database.snapshots)) {
    if (!snapshot.generation_id) continue;
    database.active_generations[key] ||= snapshot.generation_id;
    database.watermarks[key] ||= {};
    database.watermarks[key][snapshot.generation_id] ||= watermarkFrom(snapshot);
    database.retired_generations[key] ||= {};
  }
  return database;
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
