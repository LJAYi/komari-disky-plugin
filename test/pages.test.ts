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

  it("ships a dedicated NVIDIA GPU inventory view and empty state", () => {
    expect(page).toContain('data-provider-view="nvidia"');
    expect(page).toContain('resource.type !== "nvidia.gpu"');
    for (const metric of [
      "utilization.percent", "memory.used_bytes", "memory.total_bytes",
      "temperature.celsius", "power.draw_watts", "power.limit_watts",
    ]) expect(page).toContain(`metrics["${metric}"]`);
    expect(page).toContain("UUID / Index");
    expect(page).toContain("暂无 NVIDIA GPU 快照。");
    expect(page).toContain("未发现 GPU");
  });
});
