export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ResourceSnapshotInput {
  schema_version: 1;
  generation_id: string;
  mode: "full";
  provider: string;
  provider_instance: string;
  capabilities?: string[];
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

export type HealthSeverity = "warning" | "critical";

export interface HealthIssue {
  code: "snapshot_stale" | "provider_missing" | "smart_failed" | "storage_pressure" | "swarm_replicas";
  severity: HealthSeverity;
  source_client_uuid: string;
  provider: string;
  provider_instance: string;
  resource_id?: string;
  resource_name?: string;
  message: string;
  observed_at: string;
}

export interface HealthSummary {
  status: "healthy" | "warning" | "critical";
  warning: number;
  critical: number;
  issues: HealthIssue[];
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
