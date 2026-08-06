import { describe, expect, it } from "vitest";
import { SnapshotRegistry, SnapshotRejectedError, type SnapshotView } from "../src/registry";
import type { SnapshotResource } from "../src/types";
import { parseSnapshotInput } from "../src/validation";
import { MemoryStore, validSnapshot } from "./helpers";

describe("site collector snapshot contract", () => {
  it("links WSL and Slurm scopes to PVE resources and recovers after TTL expiry", () => {
    let now = new Date("2026-08-07T00:00:00Z");
    const registry = new SnapshotRegistry(new MemoryStore(), () => now);
    const client = "site-collector-client";

    registry.apply(client, parseSnapshotInput(siteSnapshot({
      provider: "proxmox",
      provider_instance: "site-a",
      capabilities: ["proxmox.qemu"],
      snapshot_id: "pve-1",
      resources: [
        { id: "proxmox.qemu:42", type: "proxmox.qemu", name: "windows-guest", status: "running" },
        { id: "proxmox.qemu:43", type: "proxmox.qemu", name: "compute-guest", status: "running" },
      ],
    })), 300);
    registry.apply(client, parseSnapshotInput(siteSnapshot({
      provider: "windows_wsl",
      provider_instance: "windows-guest",
      capabilities: ["windows.wsl"],
      snapshot_id: "wsl-1",
      resources: [{
        id: "windows.wsl:00000000-0000-0000-0000-000000000042",
        type: "windows.wsl",
        name: "linux-workspace",
        status: "running",
        attributes: parentAttributes("site-a", "proxmox.qemu:42"),
      }],
    })), 300);
    registry.apply(client, parseSnapshotInput(siteSnapshot({
      provider: "slurm",
      provider_instance: "compute-guest",
      capabilities: ["slurm.cluster"],
      snapshot_id: "slurm-1",
      resources: [{
        id: "slurm.cluster:compute-guest",
        type: "slurm.cluster",
        name: "compute-guest",
        status: "active",
        attributes: parentAttributes("site-a", "proxmox.qemu:43"),
        metrics: { "gpus.configured": 4, "gpus.allocated": 2 },
      }],
    })), 300);

    const wsl = exact(registry, client, "windows_wsl", "windows-guest");
    const slurm = exact(registry, client, "slurm", "compute-guest");
    expect(parentName(registry, wsl, wsl.resources[0])).toBe("windows-guest");
    expect(parentName(registry, slurm, slurm.resources[0])).toBe("compute-guest");
    expect(slurm.resources[0].metrics?.["gpus.configured"]).toBe(4);

    now = new Date("2026-08-07T00:01:31Z");
    expect(exact(registry, client, "windows_wsl", "windows-guest").stale).toBe(true);

    const recovered = siteSnapshot({
      provider: "windows_wsl",
      provider_instance: "windows-guest",
      generation_id: "0198e241-0000-7000-8000-000000000002",
      snapshot_id: "wsl-recovered",
      resources: [{
        id: "windows.wsl:00000000-0000-0000-0000-000000000042",
        type: "windows.wsl",
        name: "linux-workspace",
        status: "running",
        attributes: parentAttributes("site-a", "proxmox.qemu:42"),
      }],
    });
    registry.apply(client, parseSnapshotInput(recovered), 300);
    expect(exact(registry, client, "windows_wsl", "windows-guest").stale).toBe(false);

    expect(() => registry.apply(client, parseSnapshotInput(siteSnapshot({
      provider: "windows_wsl",
      provider_instance: "windows-guest",
      snapshot_id: "late-old-generation",
      sequence: 2,
      resources: [],
    })), 300)).toThrowError(SnapshotRejectedError);
  });
});

function siteSnapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  return validSnapshot({
    generation_id: "0198e241-0000-7000-8000-000000000001",
    ttl_seconds: 90,
    relationships: [],
    ...overrides,
  });
}

function parentAttributes(instance: string, resourceID: string): Record<string, string> {
  return {
    parent_provider: "proxmox",
    parent_provider_instance: instance,
    parent_resource_id: resourceID,
  };
}

function exact(
  registry: SnapshotRegistry,
  client: string,
  provider: string,
  instance: string,
): SnapshotView {
  const snapshot = registry.list({
    source_client_uuid: client,
    provider,
    provider_instance: instance,
  })[0];
  if (!snapshot) throw new Error(`missing ${provider}/${instance}`);
  return snapshot;
}

function parentName(
  registry: SnapshotRegistry,
  snapshot: SnapshotView,
  resource: SnapshotResource,
): string | undefined {
  const attributes = resource.attributes || {};
  const provider = String(attributes.parent_provider || "");
  const instance = String(attributes.parent_provider_instance || "");
  const resourceID = String(attributes.parent_resource_id || "");
  if (!provider || !instance || !resourceID) return undefined;
  const parent = exact(registry, snapshot.source_client_uuid, provider, instance)
    .resources.find((candidate) => candidate.id === resourceID);
  return parent?.name || parent?.id;
}
