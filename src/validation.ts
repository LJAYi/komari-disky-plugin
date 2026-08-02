import type {
  JsonValue,
  ResourceSnapshotInput,
  SnapshotRelationship,
  SnapshotResource,
} from "./types";

export const LIMITS = {
  maxResources: 5000,
  maxRelationships: 10000,
  maxLabels: 64,
  maxMetrics: 128,
  maxAttributes: 128,
  maxJsonDepth: 8,
  maxStringLength: 4096,
  minTTLSeconds: 30,
  maxTTLSeconds: 86400,
} as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;
const providerPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function parseSnapshotInput(value: unknown): ResourceSnapshotInput {
  const input = objectValue(value, "snapshot");
  assertOnlyKeys(input, [
    "schema_version",
    "generation_id",
    "mode",
    "provider",
    "provider_instance",
    "snapshot_id",
    "sequence",
    "collected_at",
    "ttl_seconds",
    "resources",
    "relationships",
  ]);

  if (input.schema_version !== 1) {
    throw new ValidationError("schema_version must be 1");
  }
  const generationID = uuid(input.generation_id, "generation_id");
  if (input.mode !== "full") throw new ValidationError("mode must be full");
  const provider = providerName(input.provider, "provider");
  const providerInstance = identifier(input.provider_instance, "provider_instance");
  const snapshotID = identifier(input.snapshot_id, "snapshot_id");
  const sequence = integer(input.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER);
  const collectedAt = timestamp(input.collected_at, "collected_at");
  const ttlSeconds = input.ttl_seconds === undefined
    ? undefined
    : integer(input.ttl_seconds, "ttl_seconds", LIMITS.minTTLSeconds, LIMITS.maxTTLSeconds);

  const rawResources = arrayValue(input.resources, "resources", LIMITS.maxResources);
  const resources = rawResources.map((resource, index) => parseResource(resource, index));
  const resourceIDs = new Set<string>();
  for (const resource of resources) {
    if (resourceIDs.has(resource.id)) {
      throw new ValidationError(`resources contains duplicate id ${resource.id}`);
    }
    resourceIDs.add(resource.id);
  }

  const rawRelationships = arrayValue(
    input.relationships,
    "relationships",
    LIMITS.maxRelationships,
  );
  const relationships = rawRelationships.map((relationship, index) =>
    parseRelationship(relationship, index),
  );
  for (const [index, relationship] of relationships.entries()) {
    if (!resourceIDs.has(relationship.source)) {
      throw new ValidationError(`relationships[${index}].source does not exist in resources`);
    }
    if (!resourceIDs.has(relationship.target)) {
      throw new ValidationError(`relationships[${index}].target does not exist in resources`);
    }
  }

  return {
    schema_version: 1,
    generation_id: generationID,
    mode: "full",
    provider,
    provider_instance: providerInstance,
    snapshot_id: snapshotID,
    sequence,
    collected_at: collectedAt,
    ...(ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }),
    resources,
    relationships,
  };
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ValidationError(`${label} must be an RFC 4122 UUID`);
  }
  return value.toLowerCase();
}

function parseResource(value: unknown, index: number): SnapshotResource {
  const label = `resources[${index}]`;
  const input = objectValue(value, label);
  assertOnlyKeys(input, ["id", "type", "name", "status", "labels", "attributes", "metrics"]);
  return {
    id: identifier(input.id, `${label}.id`),
    type: providerName(input.type, `${label}.type`),
    ...(input.name === undefined ? {} : { name: shortString(input.name, `${label}.name`, 256) }),
    ...(input.status === undefined
      ? {}
      : { status: shortString(input.status, `${label}.status`, 64) }),
    ...(input.labels === undefined ? {} : { labels: stringMap(input.labels, `${label}.labels`) }),
    ...(input.attributes === undefined
      ? {}
      : { attributes: jsonObject(input.attributes, `${label}.attributes`) }),
    ...(input.metrics === undefined ? {} : { metrics: numberMap(input.metrics, `${label}.metrics`) }),
  };
}

function parseRelationship(value: unknown, index: number): SnapshotRelationship {
  const label = `relationships[${index}]`;
  const input = objectValue(value, label);
  assertOnlyKeys(input, ["source", "target", "type", "attributes"]);
  return {
    source: identifier(input.source, `${label}.source`),
    target: identifier(input.target, `${label}.target`),
    type: providerName(input.type, `${label}.type`),
    ...(input.attributes === undefined
      ? {}
      : { attributes: jsonObject(input.attributes, `${label}.attributes`) }),
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  if (value.length > maximum) throw new ValidationError(`${label} exceeds ${maximum} entries`);
  return value;
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknown) throw new ValidationError(`unknown field ${unknown}`);
}

function providerName(value: unknown, label: string): string {
  if (typeof value !== "string" || !providerPattern.test(value)) {
    throw new ValidationError(`${label} must be a lowercase namespace`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new ValidationError(`${label} is not a valid identifier`);
  }
  return value;
}

function shortString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ValidationError(`${label} must be a non-empty string up to ${maximum} characters`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ValidationError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`${label} must be an RFC 3339 timestamp`);
  }
  return value;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const input = objectValue(value, label);
  if (Object.keys(input).length > LIMITS.maxLabels) {
    throw new ValidationError(`${label} exceeds ${LIMITS.maxLabels} entries`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!providerPattern.test(key)) throw new ValidationError(`${label} contains invalid key ${key}`);
    result[key] = shortString(item, `${label}.${key}`, 1024);
  }
  return result;
}

function numberMap(value: unknown, label: string): Record<string, number> {
  const input = objectValue(value, label);
  if (Object.keys(input).length > LIMITS.maxMetrics) {
    throw new ValidationError(`${label} exceeds ${LIMITS.maxMetrics} entries`);
  }
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!providerPattern.test(key)) throw new ValidationError(`${label} contains invalid key ${key}`);
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new ValidationError(`${label}.${key} must be a finite number`);
    }
    result[key] = item;
  }
  return result;
}

function jsonObject(value: unknown, label: string): Record<string, JsonValue> {
  const input = objectValue(value, label);
  if (Object.keys(input).length > LIMITS.maxAttributes) {
    throw new ValidationError(`${label} exceeds ${LIMITS.maxAttributes} entries`);
  }
  assertJsonValue(input, label, 0);
  return input as Record<string, JsonValue>;
}

function assertJsonValue(value: unknown, label: string, depth: number): void {
  if (depth > LIMITS.maxJsonDepth) throw new ValidationError(`${label} exceeds JSON depth limit`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > LIMITS.maxStringLength) {
      throw new ValidationError(`${label} contains an oversized string`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxAttributes) {
      throw new ValidationError(`${label} contains an oversized array`);
    }
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length > LIMITS.maxAttributes) {
      throw new ValidationError(`${label} contains an oversized object`);
    }
    Object.entries(input).forEach(([key, item]) => {
      if (key.length === 0 || key.length > 128) {
        throw new ValidationError(`${label} contains an invalid object key`);
      }
      assertJsonValue(item, `${label}.${key}`, depth + 1);
    });
    return;
  }
  throw new ValidationError(`${label} contains a non-JSON value`);
}
