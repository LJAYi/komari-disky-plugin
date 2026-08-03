export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ResourceSnapshotInput {
  schema_version: 1;
  generation_id: string;
  mode: "full";
  provider: string;
  provider_instance: string;
  snapshot_id: string;
  sequence: number;
  collected_at: string;
  ttl_seconds?: number;
  resources: SnapshotResource[];
  relationships: SnapshotRelationship[];
}

export interface SnapshotResource {
  id: string;
  type: string;
  name?: string;
  status?: string;
  labels?: Record<string, string>;
  attributes?: Record<string, JsonValue>;
  metrics?: Record<string, number>;
}

export interface SnapshotRelationship {
  source: string;
  target: string;
  type: string;
  attributes?: Record<string, JsonValue>;
}

export interface StoredSnapshot extends ResourceSnapshotInput {
  source_client_uuid: string;
  received_at: string;
  expires_at: string;
}

export interface SnapshotScope {
  source_client_uuid: string;
  provider: string;
  provider_instance: string;
}

export interface SnapshotDatabase {
  schema_version: 1;
  snapshots: Record<string, StoredSnapshot>;
  active_generations: Record<string, string>;
  watermarks: Record<string, Record<string, SnapshotWatermark>>;
  retired_generations: Record<string, Record<string, string>>;
}

export interface SnapshotWatermark {
  generation_id: string;
  snapshot_id: string;
  sequence: number;
  accepted_at: string;
  expires_at: string;
}

export interface SnapshotOverview {
  clients: number;
  providers: number;
  snapshots: number;
  resources: number;
  relationships: number;
  stale: number;
  generated_at: string;
}

export interface SnapshotSummary {
  source_client_uuid: string;
  provider: string;
  provider_instance: string;
  generation_id: string;
  sequence: number;
  collected_at: string;
  received_at: string;
  expires_at: string;
  stale: boolean;
  resource_count: number;
  relationship_count: number;
  resource_types: Record<string, number>;
}

export type ApplyResult =
  | { status: "accepted"; snapshot: StoredSnapshot }
  | { status: "duplicate"; watermark: SnapshotWatermark };

export interface SnapshotStore {
  load(): SnapshotDatabase;
  save(database: SnapshotDatabase): void;
}
