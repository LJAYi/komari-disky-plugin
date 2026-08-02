import { describe, expect, it } from "vitest";
import { parseSnapshotInput, ValidationError } from "../src/validation";
import { validSnapshot } from "./helpers";

describe("parseSnapshotInput", () => {
  it("accepts and normalizes a version 1 snapshot", () => {
    const snapshot = parseSnapshotInput(validSnapshot());
    expect(snapshot.provider).toBe("docker");
    expect(snapshot.resources[0].metrics?.cpu_percent).toBe(1.5);
  });

  it("requires a UUID generation, full mode, and sequence starting at one", () => {
    expect(() => parseSnapshotInput(validSnapshot({ generation_id: "not-a-uuid" })))
      .toThrow(/RFC 4122 UUID/);
    expect(() => parseSnapshotInput(validSnapshot({ mode: "delta" }))).toThrow(/mode must be full/);
    expect(() => parseSnapshotInput(validSnapshot({ sequence: 0 }))).toThrow(/sequence/);
  });

  it("rejects source identity supplied by the body", () => {
    expect(() => parseSnapshotInput(validSnapshot({ source_client_uuid: "forged" })))
      .toThrowError(new ValidationError("unknown field source_client_uuid"));
  });

  it("rejects duplicate resource ids", () => {
    const resource = (validSnapshot().resources as unknown[])[0];
    expect(() => parseSnapshotInput(validSnapshot({ resources: [resource, resource] })))
      .toThrow(/duplicate id/);
  });

  it("rejects invalid TTL and non-finite metrics", () => {
    expect(() => parseSnapshotInput(validSnapshot({ ttl_seconds: 1 }))).toThrow(/ttl_seconds/);
    const snapshot = validSnapshot();
    const resource = (snapshot.resources as Record<string, unknown>[])[0];
    resource.metrics = { cpu_percent: Number.POSITIVE_INFINITY };
    expect(() => parseSnapshotInput(snapshot)).toThrow(/finite number/);
  });

  it("requires relationship endpoints to exist in the same resource scope", () => {
    expect(() => parseSnapshotInput(validSnapshot({
      relationships: [{
        source: "docker:container:web",
        target: "docker:container:missing",
        type: "contains",
      }],
    }))).toThrow(/target does not exist/);
  });
});
