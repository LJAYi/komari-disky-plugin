import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginRequest, PluginResponse } from "@komari-monitor/plugin-sdk";
import { validSnapshot } from "./helpers";

const runtime = vi.hoisted(() => ({
  definition: undefined as { load?: () => unknown | Promise<unknown> } | undefined,
  routes: new Map<string, (request: PluginRequest, response: PluginResponse) => unknown>(),
}));

vi.mock("@komari-monitor/plugin-sdk", () => ({
  definePlugin(definition: { load?: () => unknown | Promise<unknown> }) {
    runtime.definition = definition;
    return definition;
  },
  jsonResponse(response: PluginResponse, value: unknown, statusCode = 200) {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
    return response;
  },
  server: {
    route(method: string, path: string, handler: (request: PluginRequest, response: PluginResponse) => unknown) {
      runtime.routes.set(`${method} ${path}`, handler);
    },
    registerRPC() {},
    cron() {},
    async getConfig() { return { default_ttl_seconds: 300 }; },
  },
}));

const storageDirectory = mkdtempSync(join(tmpdir(), "komari-disky-plugin-route-"));
(globalThis as Record<string, unknown>).__storageDir__ = storageDirectory;

beforeAll(async () => {
  await import("../src/plugin");
  await runtime.definition?.load?.();
});

afterAll(() => {
  rmSync(storageDirectory, { recursive: true, force: true });
});

describe("snapshot HTTP route", () => {
  it("requires an authenticated agent", async () => {
    const response = await post(validSnapshot(), {});
    expect(response.statusCode).toBe(401);
  });

  it("rejects non-identity Content-Encoding", async () => {
    const response = await post(validSnapshot(), agentContext("client-encoding"), {
      "content-encoding": "gzip",
    });
    expect(response.statusCode).toBe(415);
  });

  it("returns 422 for schema and reference errors", async () => {
    const schema = await post(validSnapshot({ mode: "delta" }), agentContext("client-schema"));
    expect(schema.statusCode).toBe(422);
    const reference = await post(validSnapshot({
      provider_instance: "reference",
      relationships: [{
        source: "docker:container:web",
        target: "docker:container:missing",
        type: "contains",
      }],
    }), agentContext("client-reference"));
    expect(reference.statusCode).toBe(422);
  });

  it("returns 201 for acceptance and 200 for an idempotent retry", async () => {
    const body = validSnapshot({ provider_instance: "accepted" });
    expect((await post(body, agentContext("client-accepted"))).statusCode).toBe(201);
    expect((await post(body, agentContext("client-accepted"))).statusCode).toBe(200);
  });

  it("returns 409 for stale and retired generations", async () => {
    const context = agentContext("client-conflict");
    await post(validSnapshot({ provider_instance: "conflict" }), context);
    await post(validSnapshot({
      provider_instance: "conflict",
      snapshot_id: "second",
      sequence: 2,
    }), context);
    const stale = await post(validSnapshot({
      provider_instance: "conflict",
      snapshot_id: "late",
      sequence: 1,
    }), context);
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).status).toBe("stale");

    await post(validSnapshot({
      provider_instance: "conflict",
      generation_id: "0198cd80-2dc0-7000-8000-000000000002",
      snapshot_id: "new-generation",
      sequence: 1,
    }), context);
    const retired = await post(validSnapshot({
      provider_instance: "conflict",
      generation_id: "0198cd80-2dc0-7000-8000-000000000001",
      snapshot_id: "retired-generation",
      sequence: 3,
    }), context);
    expect(retired.statusCode).toBe(409);
    expect(JSON.parse(retired.body).status).toBe("retired");
  });
});

function agentContext(clientUUID: string): PluginRequest["context"] {
  return {
    principal: { type: "agent", client_uuid: clientUUID, roles: ["client"] },
    client_uuid: clientUUID,
  };
}

async function post(
  body: Record<string, unknown>,
  context: PluginRequest["context"],
  headers: Record<string, string> = {},
): Promise<ResponseCapture> {
  const handler = runtime.routes.get("POST /api/disky/v1/snapshots");
  if (!handler) throw new Error("snapshot route was not registered");
  const response = new ResponseCapture();
  await handler({
    method: "POST",
    url: "/api/disky/v1/snapshots",
    headers,
    query: {},
    body: JSON.stringify(body),
    context,
  }, response);
  return response;
}

class ResponseCapture implements PluginResponse {
  statusCode = 200;
  streaming = false;
  body = "";
  private headers: Record<string, string | string[]> = {};

  setHeader(name: string, value: string | string[]): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }

  write(data: string | Uint8Array): boolean {
    this.body += typeof data === "string" ? data : new TextDecoder().decode(data);
    return true;
  }

  end(data = ""): this {
    this.body += data;
    return this;
  }

  isAborted(): boolean {
    return false;
  }
}
