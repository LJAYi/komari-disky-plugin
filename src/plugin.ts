import {
  definePlugin,
  jsonResponse,
  server,
  type PluginRequest,
  type PluginResponse,
} from "@komari-monitor/plugin-sdk";
import { SnapshotRegistry, SnapshotRejectedError } from "./registry";
import { JsonFileSnapshotStore } from "./storage";
import { LIMITS, parseSnapshotInput, ValidationError } from "./validation";

let registry: SnapshotRegistry;

definePlugin({
  async load() {
    registry = new SnapshotRegistry(new JsonFileSnapshotStore(__storageDir__));

    server.route("POST", "/api/disky/v1/snapshots", receiveSnapshot);
    server.route("GET", "/api/disky/v1/snapshots", listSnapshots);
    server.route("GET", "/api/disky/v1/client-status", clientStatus);
    server.route("GET", "/api/disky/v1/overview", (_request, response) => {
      noStore(response);
      jsonResponse(response, { ok: true, data: registry.overview() });
    });

    // Komari 1.4 plugin RPC handlers do not receive caller identity. Keep this
    // method deliberately limited to the same non-sensitive aggregate overview
    // exposed on the public page.
    server.registerRPC("plugin:disky.getOverview", () => registry.overview());

    server.cron("* * * * *", () => {
      const removed = registry.pruneExpired();
      if (removed > 0) console.log(`disky: pruned ${removed} expired snapshot(s)`);
    });
  },
});

async function receiveSnapshot(request: PluginRequest, response: PluginResponse): Promise<void> {
  noStore(response);
  const clientUUID = agentClientUUID(request);
  if (!clientUUID) {
    jsonResponse(response, { ok: false, error: "agent authentication required" }, 401);
    return;
  }

  const contentEncoding = headerValue(request, "content-encoding").trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    jsonResponse(response, { ok: false, error: "Content-Encoding is not supported" }, 415);
    return;
  }

  try {
    const input = parseSnapshotInput(JSON.parse(request.body || "{}"));
    const defaultTTL = await configuredDefaultTTL();
    const result = registry.apply(clientUUID, input, defaultTTL);
    const statusCode = result.status === "accepted" ? 201 : 200;
    const state = result.status === "accepted"
      ? {
          snapshot_id: result.snapshot.snapshot_id,
          sequence: result.snapshot.sequence,
          expires_at: result.snapshot.expires_at,
        }
      : {
          snapshot_id: result.watermark.snapshot_id,
          sequence: result.watermark.sequence,
          expires_at: result.watermark.expires_at,
        };
    jsonResponse(response, {
      ok: true,
      status: result.status,
      source_client_uuid: clientUUID,
      ...state,
    }, statusCode);
  } catch (error) {
    if (error instanceof SyntaxError) {
      jsonResponse(response, { ok: false, error: errorMessage(error) }, 400);
      return;
    }
    if (error instanceof ValidationError) {
      jsonResponse(response, { ok: false, error: error.message }, 422);
      return;
    }
    if (error instanceof SnapshotRejectedError) {
      jsonResponse(response, { ok: false, status: error.reason, error: error.message }, 409);
      return;
    }
    console.error(`disky: snapshot ingest failed: ${errorMessage(error)}`);
    jsonResponse(response, { ok: false, error: "snapshot ingest failed" }, 500);
  }
}

async function clientStatus(request: PluginRequest, response: PluginResponse): Promise<void> {
  noStore(response);
  if (!isAdmin(request)) {
    jsonResponse(response, { ok: false, error: "administrator authentication required" }, 401);
    return;
  }
  const raw = request.query.uuids || "";
  const uuids = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (uuids.length > 200 || uuids.some((value) => optionalIdentifierQuery(value) !== value)) {
    jsonResponse(response, { ok: false, error: "invalid client UUID list" }, 400);
    return;
  }
  try {
    const data = await server.call<Record<string, unknown>>(
      "common:getNodesLatestStatus",
      uuids.length ? { uuids } : {},
    );
    jsonResponse(response, { ok: true, data: normalizeLatestStatuses(data) });
  } catch (error) {
    console.error(`disky: latest client status query failed: ${errorMessage(error)}`);
    jsonResponse(response, { ok: false, error: "latest client status query failed" }, 502);
  }
}

const LATEST_STATUS_FIELDS = {
  Client: "client",
  Time: "time",
  Cpu: "cpu",
  Gpu: "gpu",
  Ram: "ram",
  RamTotal: "ram_total",
  Swap: "swap",
  SwapTotal: "swap_total",
  Load: "load",
  Load5: "load5",
  Load15: "load15",
  Temp: "temp",
  Disk: "disk",
  DiskTotal: "disk_total",
  Disks: "disks",
  NetIn: "net_in",
  NetOut: "net_out",
  NetTotalUp: "net_total_up",
  NetTotalDown: "net_total_down",
  Process: "process",
  Connections: "connections",
  ConnectionsUdp: "connections_udp",
  Online: "online",
  Uptime: "uptime",
  Ping: "ping",
  Extensions: "extensions",
} as const;

function normalizeLatestStatuses(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([uuid, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [uuid, raw];
    const source = raw as Record<string, unknown>;
    const normalized = { ...source };
    for (const [goName, jsonName] of Object.entries(LATEST_STATUS_FIELDS)) {
      if (normalized[jsonName] === undefined && source[goName] !== undefined) {
        normalized[jsonName] = source[goName];
      }
    }
    return [uuid, normalized];
  }));
}

function listSnapshots(request: PluginRequest, response: PluginResponse): void {
  noStore(response);
  if (!isAdmin(request)) {
    jsonResponse(response, { ok: false, error: "administrator authentication required" }, 401);
    return;
  }
  const sourceClientUUID = optionalIdentifierQuery(request.query.client_uuid);
  const provider = optionalIdentifierQuery(request.query.provider);
  const providerInstance = optionalIdentifierQuery(request.query.provider_instance);
  if (sourceClientUUID === null || provider === null || providerInstance === null) {
    jsonResponse(response, { ok: false, error: "invalid query filter" }, 400);
    return;
  }
  const filter = {
    ...(sourceClientUUID ? { source_client_uuid: sourceClientUUID } : {}),
    ...(provider ? { provider } : {}),
    ...(providerInstance ? { provider_instance: providerInstance } : {}),
  };
  const view = request.query.view || "summary";
  if (view === "full") {
    if (!sourceClientUUID || !provider || !providerInstance) {
      jsonResponse(response, {
        ok: false,
        error: "full view requires client_uuid, provider, and provider_instance",
      }, 400);
      return;
    }
    const snapshot = registry.list(filter)[0];
    if (!snapshot) {
      jsonResponse(response, { ok: false, error: "snapshot not found" }, 404);
      return;
    }
    jsonResponse(response, { ok: true, data: snapshot });
    return;
  }
  if (view !== "summary") {
    jsonResponse(response, { ok: false, error: "view must be summary or full" }, 400);
    return;
  }
  const offset = boundedIntegerQuery(request.query.offset, 0, 0, 100000);
  const limit = boundedIntegerQuery(request.query.limit, 50, 1, 100);
  if (offset === null || limit === null) {
    jsonResponse(response, { ok: false, error: "invalid pagination" }, 400);
    return;
  }
  const summaries = registry.summaries(filter);
  jsonResponse(response, {
    ok: true,
    data: summaries.slice(offset, offset + limit),
    pagination: {
      offset,
      limit,
      total: summaries.length,
      has_more: offset + limit < summaries.length,
    },
  });
}

function agentClientUUID(request: PluginRequest): string | undefined {
  const principal = request.context?.principal;
  if (principal?.type !== "agent") return undefined;
  const clientUUID = principal.client_uuid || request.context.client_uuid;
  return typeof clientUUID === "string" && clientUUID.length > 0 ? clientUUID : undefined;
}

function isAdmin(request: PluginRequest): boolean {
  const principal = request.context?.principal;
  return principal?.type === "user" || principal?.type === "api_key" ||
    principal?.roles?.includes("admin") === true;
}

async function configuredDefaultTTL(): Promise<number> {
  const config = await server.getConfig<{ default_ttl_seconds?: unknown }>();
  const value = Number(config.default_ttl_seconds ?? 300);
  if (!Number.isSafeInteger(value)) return 300;
  return Math.max(LIMITS.minTTLSeconds, Math.min(LIMITS.maxTTLSeconds, value));
}

function optionalIdentifierQuery(value: string | undefined): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/.test(value) ? value : null;
}

function boundedIntegerQuery(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function headerValue(request: PluginRequest, name: string): string {
  const value = request.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
}

function noStore(response: PluginResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
