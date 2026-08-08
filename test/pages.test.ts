import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "pages", "index.html"), "utf8");

describe("provider workspaces", () => {
  it("ships Docker inventory views", () => {
    for (const view of ["images", "storage", "networks"]) {
      expect(page).toContain(`data-disky-view="${view}"`);
    }
    for (const type of ["docker.image", "docker.volume", "docker.network"]) {
      expect(page).toContain(`"${type}"`);
    }
    for (const metric of ["cpu.percent", "memory.used_bytes", "storage.layers_bytes"]) {
      expect(page).toContain(`["${metric}"]`);
    }
  });

  it("ships Proxmox storage and disk inventory views", () => {
    for (const type of ["proxmox.storage", "proxmox.physical_disk", "proxmox.zfs_pool"]) {
      expect(page).toContain(`"${type}"`);
    }
    expect(page).toContain("Physical Disks & SMART");
    expect(page).toContain("ZFS Pools");
  });

  it("surfaces derived provider and resource health", () => {
    expect(page).toContain('id="health"');
    expect(page).toContain('/api/disky/v1/health');
    expect(page).toContain("需要处理的资源问题");
  });
});
