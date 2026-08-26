# Eddie Platinum Dashboard

The dashboard is a read-only Node service bound to `127.0.0.1`. It has no
runtime dependencies and reads two local sources:

- `config/agents.tsv`, the fleet controller's canonical agent/port manifest.
- `runtime/telemetry/events.jsonl`, append-only content-free events from the
  `minecraft_observer` Hermes plugin installed in the managed Minecraft and
  Eddie Social profiles.

The Eddie Social profile emits under the distinct `eddie-social` identifier.
Its token usage is included in the overall counters and shown as
`Eddie Platinum — Social`; its lifecycle state comes from the daemon PID file,
not from Minecraft or the profile's private session data.

Eddie's endpoint canary appends content-free results to
`runtime/telemetry/endpoint_checks.jsonl`. The dashboard reports per-route and
streaming-mode successes, failures, latency, schema status, token use, and
freshness for a rolling 24-hour window. Existing HTTP-200, schema-valid records
whose visible smoke output matched but hidden reasoning varied are projected as
successful visible parity without rewriting the append-only telemetry source.
Failures are grouped into saturation, timeout, HTTP, schema, output, parity, and
uncategorized request failures. Saturation is reported only when the
canary receives an allowlisted structured queue or capacity reason from the
inference response; a client-side timeout remains a timeout. The canary runs
every 15 minutes and on demand, exercises only the
fixed inference-route allowlist, and cannot invoke `/v1/models/load` or another
model-management route.

It also checks the controller's `mc-server`, `mc-<id>-brain`, and
`mc-<id>-body` tmux sessions and probes each body at
`http://127.0.0.1:<api_port>/observability`. That endpoint is a lightweight,
content-free projection; it does not compute or return scene, inventory, chat,
logs, or task result/error data.

Controller state files under `runtime/state/` distinguish a live supervisor
from its child process. The dashboard shows `starting`, `running`,
`backing_off`, `stopping`, or `stopped`, plus restart count and last exit code.
A transition timestamp is marked stale only when its tmux supervisor is also
absent; running workers are not expected to rewrite it as a heartbeat.
Browser clients never connect directly to body APIs.

The Spark memory cards sample `MemTotal`, `MemAvailable`, `SwapTotal`, and
`SwapFree` from each S2 Spark's `/proc/meminfo` over fixed, batch-mode SSH
commands. Samples are cached for 10 seconds. A failed refresh keeps the last
good values marked stale for up to 60 seconds, after which the values become
unavailable. On GB10, this host-memory view is labeled unified memory because
CPU and GPU allocations share the same pool. The browser receives only the
Spark name, numeric memory values, status, and sample timestamp; SSH targets,
key paths, commands, and errors remain server-side.

```bash
cd dashboard
bun test
node server.js
```

Open <http://127.0.0.1:9120>. Set `DASHBOARD_PORT` to change only the port;
the bind address intentionally remains loopback.

The fleet controller owns the normal lifecycle:

```bash
bin/minecraft-fleet dashboard up
bin/minecraft-fleet dashboard status
bin/minecraft-fleet dashboard attach
bin/minecraft-fleet dashboard down
```

The dashboard does not read Hermes sessions, memories, prompt files, agent
logs, messages, or tool payloads. Its API exposes lifecycle booleans and
aggregate counters plus the whitelisted Spark memory values, so observing the
fleet cannot change or expand any agent context.

Token totals for each workload begin when `minecraft_observer` is enabled. The dashboard does
not reconstruct historical usage from old Hermes sessions, request dumps, or
logs, and the UI labels the total accordingly.

The totals are exact for Hermes requests that emit `post_api_request`, which
includes each inference request in the Minecraft agent/tool loop. Hermes
auxiliary-client paths that do not emit that observer hook are outside this
counter; the dashboard is operational telemetry, not a provider billing
ledger.
