# Komari Disky Plugin

Komari Disky Plugin is the server-side extension for `komari-disky-agent`. It
accepts bounded, versioned resource snapshots from authenticated Komari agents
and keeps dynamic resources and topology outside Komari's high-frequency host
metric pipeline.

This repository currently contains an MVP for the Komari `1.4.x` plugin API.
It does not intercept Agent reports, write Komari metrics, execute commands, or
request unrestricted filesystem access.

## Data model

Each upload is a complete replacement for one scope:

```text
authenticated client UUID + provider + provider_instance
```

The client UUID always comes from Komari's resolved Agent principal. A payload
that tries to provide `source_client_uuid` is rejected.

The version 1 payload contains:

- `schema_version`: currently `1`;
- RFC 4122 `generation_id` and `mode: full`;
- `provider` and `provider_instance`;
- `snapshot_id` for retry idempotency;
- monotonically increasing `sequence` for ordering;
- `collected_at` and optional `ttl_seconds`;
- complete `resources` and `relationships` arrays.

The first snapshot in every generation must use sequence `1`. Within the active
generation, only a higher sequence replaces the current full snapshot. Repeating
the same snapshot ID and sequence is idempotent; older sequences and collisions
are rejected. Starting a new generation retires the previous generation, and
retired generation IDs are durably rejected instead of becoming valid again
after TTL cleanup.

## HTTP and RPC surface

| Method | Path / RPC | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/disky/v1/snapshots?token=...` | Komari Agent token | Submit a full snapshot (`201`, duplicate `200`) |
| `GET` | `/api/disky/v1/snapshots?view=summary` | Admin session/API key | Query paginated snapshot summaries |
| `GET` | `/api/disky/v1/snapshots?view=full&client_uuid=...&provider=...&provider_instance=...` | Admin session/API key | Query one exact snapshot |
| `GET` | `/api/disky/v1/health` | Admin session/API key | Query derived provider and resource health issues |
| `GET` | `/api/disky/v1/overview` | Public | Query aggregate counts only |
| RPC | `plugin:disky.getOverview` | Public-safe | Query aggregate counts only |

Komari `1.4.x` does not pass caller identity to plugin-owned RPC handlers, so
the RPC intentionally exposes only aggregate counts. Full resource data stays
behind an authenticated HTTP route.

The POST body must not contain the token. Pass the existing Komari Agent token
as a query parameter, matching Komari's current Agent HTTP authentication.
Malformed JSON returns `400`; schema or relationship-reference errors return
`422`; stale, retired, or conflicting uploads return `409`; and a non-identity
`Content-Encoding` returns `415`.

The plugin page keeps the public view limited to aggregate counts. When opened
by an administrator, it additionally shows searchable snapshot summaries and
provider workspaces. Docker views cover hosts, containers, Compose, Swarm,
images, volumes, storage usage, and networks. Proxmox views cover nodes,
VM/LXC guests, storage, physical disks/SMART, and ZFS pools. WSL and Slurm keep
their focused inventory views. All pages consume the same generic `type`,
`status`, `labels`, `attributes`, `metrics`, and relationship fields rather
than defining provider-specific transport schemas.

Full snapshots may contain administrative inventory such as disk serials,
container ports, IP addresses, and mount source paths. These details remain
behind Komari administrator authentication; only aggregate counts are public.

## Limits and persistence

- HTTP request body: 4 MiB (enforced by Komari before the handler runs);
- compressed request bodies are rejected; agents must send identity encoding;
- resources: 5,000 per snapshot;
- relationships: 10,000 per snapshot, with both endpoints in the same snapshot;
- TTL: 30 seconds to 24 hours, with a configurable 300-second default;
- attributes and metrics have count, depth, key, string, and finite-number checks;
- expired snapshots are marked stale and remain queryable for seven days;
- health is derived at read time: an expired snapshot is a warning and becomes
  a missing-provider critical issue after three TTL intervals;
- current snapshots surface SMART failures, PVE storage usage at 90%/95%, and
  Swarm services with fewer running than desired tasks;
- stale snapshot bodies are then removed, while generation watermarks and the
  retired-generation set remain durable to reject delayed or replayed uploads;
- each client is limited to 32 provider scopes and the plugin to 512 scopes;
- state is atomically written under Komari's plugin-scoped `__storageDir__`.

Only `node` (for the scoped persistent directory) and `allowRoutes` permissions
are requested. The plugin does not request hooks, HTML injection, command
execution, local listeners, system RPC, or all-files access.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm run verify
npm run artifact
```

For local hot reload, create a gitignored `komari.local.json` as documented by
[`@komari-monitor/plugin-dev`](https://github.com/komari-monitor/plugin-dev),
then run `npm run dev`.

`npm run artifact` creates a deterministic ZIP and matching SHA-256 file in
`dist/`, packing sorted entries with fixed timestamps and modes and without
runtime-dependent deflate output. CI runs against the locked npm dependency
graph and uploads these files as workflow artifacts.
Pushing a version tag such as `v0.1.0` additionally verifies that the tag,
package, and plugin manifest versions match before creating the GitHub release.

## Status

The snapshot schema remains deliberately generic while the bundled page adds
provider-specific views. Binding management, alert rules, actions, and metric
history beyond Komari's native host metrics remain future work.

## License and attribution

Licensed under the MIT License. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Komari is an independent upstream project. This community project is not an
official Komari distribution.
