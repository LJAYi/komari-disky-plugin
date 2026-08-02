import { describe, expect, it } from "vitest";
import { SnapshotRegistry, SnapshotRejectedError } from "../src/registry";
import { parseSnapshotInput } from "../src/validation";
import { MemoryStore, validSnapshot } from "./helpers";

const GENERATION_A = "0198cd80-2dc0-7000-8000-000000000001";
const GENERATION_B = "0198cd80-2dc0-7000-8000-000000000002";

describe("SnapshotRegistry", () => {
  it("fully replaces one client/provider/instance scope", () => {
    const store = new MemoryStore();
    const registry = new SnapshotRegistry(store, () => new Date("2026-08-03T00:00:00Z"));
    registry.apply("client-a", parseSnapshotInput(validSnapshot()), 300);
    registry.apply("client-a", parseSnapshotInput(validSnapshot({
      snapshot_id: "snapshot-2",
      sequence: 2,
      resources: [],
    })), 300);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].snapshot_id).toBe("snapshot-2");
    expect(registry.list()[0].resources).toHaveLength(0);
  });

  it("makes exact snapshot retries idempotent and rejects collisions", () => {
    const store = new MemoryStore();
    const registry = new SnapshotRegistry(store, () => new Date("2026-08-03T00:00:00Z"));
    const input = parseSnapshotInput(validSnapshot());
    expect(registry.apply("client-a", input, 300).status).toBe("accepted");
    expect(registry.apply("client-a", input, 300).status).toBe("duplicate");
    expect(store.saves).toBe(1);
    expectRejection(() => registry.apply("client-a", parseSnapshotInput(validSnapshot({
      snapshot_id: "different",
    })), 300), "conflict");
    expectRejection(() => registry.apply("client-a", parseSnapshotInput(validSnapshot({
      sequence: 2,
    })), 300), "conflict");
  });

  it("rejects stale sequences in the active generation", () => {
    const registry = new SnapshotRegistry(new MemoryStore(), () => new Date("2026-08-03T00:00:00Z"));
    registry.apply("client-a", parseSnapshotInput(validSnapshot()), 300);
    registry.apply("client-a", parseSnapshotInput(validSnapshot({
      snapshot_id: "newer",
      sequence: 2,
    })), 300);
    expectRejection(() => registry.apply("client-a", parseSnapshotInput(validSnapshot({
      snapshot_id: "older",
      sequence: 1,
    })), 300), "stale");
    expect(registry.list()[0].sequence).toBe(2);
  });

  it("requires a new generation to start at one and permanently retires the old generation", () => {
    const store = new MemoryStore();
    const registry = new SnapshotRegistry(store, () => new Date("2026-08-03T00:00:00Z"));
    registry.apply("client-a", parseSnapshotInput(validSnapshot({ generation_id: GENERATION_A })), 300);
    expectRejection(() => registry.apply("client-a", parseSnapshotInput(validSnapshot({
      generation_id: GENERATION_B,
      snapshot_id: "generation-b-2",
      sequence: 2,
    })), 300), "conflict");
    registry.apply("client-a", parseSnapshotInput(validSnapshot({
      generation_id: GENERATION_B,
      snapshot_id: "generation-b-1",
      sequence: 1,
    })), 300);
    expect(registry.list()[0].generation_id).toBe(GENERATION_B);
    expectRejection(() => registry.apply("client-a", parseSnapshotInput(validSnapshot({
      generation_id: GENERATION_A,
      snapshot_id: "generation-a-return",
      sequence: 2,
    })), 300), "retired");

    const reloaded = new SnapshotRegistry(store, () => new Date("2027-08-03T00:00:00Z"));
    reloaded.pruneExpired();
    expectRejection(() => reloaded.apply("client-a", parseSnapshotInput(validSnapshot({
      generation_id: GENERATION_A,
      snapshot_id: "generation-a-late",
      sequence: 3,
    })), 300), "retired");
  });

  it("marks expired snapshots stale and removes them only after seven more days", () => {
    let now = new Date("2026-08-03T00:00:00Z");
    const registry = new SnapshotRegistry(new MemoryStore(), () => now);
    registry.apply("client-a", parseSnapshotInput(validSnapshot({ ttl_seconds: 30 })), 300);
    now = new Date("2026-08-03T00:00:31Z");
    expect(registry.pruneExpired()).toBe(0);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].stale).toBe(true);
    expect(registry.overview().stale).toBe(1);
    now = new Date("2026-08-10T00:00:31Z");
    expect(registry.pruneExpired()).toBe(1);
    expect(registry.list()).toHaveLength(0);
  });

  it("keeps scopes isolated by authenticated client", () => {
    const registry = new SnapshotRegistry(new MemoryStore(), () => new Date("2026-08-03T00:00:00Z"));
    registry.apply("client-a", parseSnapshotInput(validSnapshot()), 300);
    registry.apply("client-b", parseSnapshotInput(validSnapshot()), 300);
    expect(registry.overview().clients).toBe(2);
    expect(registry.list()).toHaveLength(2);
  });
});

function expectRejection(action: () => unknown, reason: string): void {
  try {
    action();
    throw new Error("expected SnapshotRejectedError");
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotRejectedError);
    expect((error as SnapshotRejectedError).reason).toBe(reason);
  }
}
