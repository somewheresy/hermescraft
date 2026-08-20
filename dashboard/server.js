import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAgents } from './lib/config.js';
import { EndpointTelemetryFile } from './lib/endpoint-telemetry.js';
import { createAgentInspector, listTmuxSessions, probeTcpPort } from './lib/probes.js';
import { createSocialAgentInspector } from './lib/social-agent.js';
import { createSparkMemoryMonitor } from './lib/spark-memory.js';
import { TelemetryFile } from './lib/telemetry.js';
import { loadAgentWorkerStates, projectWorkerState } from './lib/worker-state.js';

const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 9120;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const SOCIAL_AGENT = Object.freeze({
  id: 'eddie-social',
  displayName: 'Eddie Platinum — Social',
  username: 'EddiePlatinum',
  apiPort: null,
  promptId: 'social',
  enabled: true,
});

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function writeResponse(response, statusCode, contentType, body, method = 'GET') {
  response.writeHead(statusCode, { ...SECURITY_HEADERS, 'Content-Type': contentType });
  response.end(method === 'HEAD' ? undefined : body);
}

function jsonResponse(response, statusCode, value, method) {
  writeResponse(response, statusCode, 'application/json; charset=utf-8', JSON.stringify(value), method);
}

function publicAgent(agent) {
  return {
    id: agent.id,
    displayName: agent.displayName,
    username: agent.username,
    apiPort: agent.apiPort,
    promptId: agent.promptId,
    enabled: agent.enabled,
    workload: 'minecraft',
  };
}

function publicSocialAgent(state, metrics) {
  const running = state?.running === true;
  return {
    ...SOCIAL_AGENT,
    workload: 'social',
    state: running ? 'online' : 'offline',
    daemonRunning: running,
    brainRunning: false,
    bodyRunning: false,
    apiReachable: false,
    minecraftConnected: false,
    identityMatches: null,
    game: null,
    task: null,
    workers: { brain: null, body: null },
    metrics: metrics ?? null,
  };
}

function publicAgentState(state) {
  const allowedStates = new Set(['online', 'degraded', 'offline', 'disabled']);
  const game = state.game && typeof state.game === 'object' ? {
    health: state.game.health ?? null,
    maxHealth: state.game.maxHealth ?? null,
    food: state.game.food ?? null,
    position: state.game.position ? {
      x: state.game.position.x ?? null,
      y: state.game.position.y ?? null,
      z: state.game.position.z ?? null,
    } : null,
    dimension: state.game.dimension ?? null,
    biome: state.game.biome ?? null,
  } : null;
  const task = state.task && typeof state.task === 'object' ? {
    action: state.task.action ?? null,
    status: state.task.status ?? null,
    elapsedSeconds: state.task.elapsedSeconds ?? null,
  } : null;
  return {
    state: allowedStates.has(state.state) ? state.state : 'offline',
    brainRunning: state.brainRunning === true,
    bodyRunning: state.bodyRunning === true,
    apiReachable: state.apiReachable === true,
    minecraftConnected: state.minecraftConnected === true,
    identityMatches: typeof state.identityMatches === 'boolean' ? state.identityMatches : null,
    game,
    task,
  };
}

function publicWorkers(workers, state) {
  const brain = projectWorkerState(workers?.brain, state.brainRunning);
  const body = projectWorkerState(workers?.body, state.bodyRunning);
  return { brain, body };
}

function publicSparkMemory(spark) {
  const allowedStates = new Set(['ok', 'stale', 'unavailable']);
  const status = allowedStates.has(spark?.status) ? spark.status : 'unavailable';
  const id = typeof spark?.id === 'string' && /^[a-z0-9_-]{1,32}$/.test(spark.id)
    ? spark.id
    : null;
  if (!id) return null;
  const displayName = typeof spark.displayName === 'string'
    ? spark.displayName.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 64)
    : id;
  const sampledAt = typeof spark.sampledAt === 'number' && Number.isFinite(spark.sampledAt)
    ? spark.sampledAt
    : null;
  const memory = spark.memory && typeof spark.memory === 'object' ? spark.memory : null;
  const swap = spark.swap && typeof spark.swap === 'object' ? spark.swap : null;
  const totalBytes = safeByteCount(memory?.totalBytes);
  const usedBytes = safeByteCount(memory?.usedBytes);
  const availableBytes = safeByteCount(memory?.availableBytes);
  const swapTotalBytes = safeByteCount(swap?.totalBytes);
  const swapUsedBytes = safeByteCount(swap?.usedBytes);
  const validMemory = status !== 'unavailable' && totalBytes !== null && totalBytes > 0 &&
    usedBytes !== null && usedBytes <= totalBytes &&
    availableBytes !== null && availableBytes <= totalBytes &&
    usedBytes === totalBytes - availableBytes;
  const validSwap = validMemory && swapTotalBytes !== null &&
    swapUsedBytes !== null && swapUsedBytes <= swapTotalBytes;

  return {
    id,
    displayName: displayName || id,
    status: validMemory && validSwap ? status : 'unavailable',
    memory: validMemory && validSwap ? {
      totalBytes,
      usedBytes,
      availableBytes,
      utilizationPercent: (usedBytes / totalBytes) * 100,
    } : null,
    swap: validMemory && validSwap ? {
      totalBytes: swapTotalBytes,
      usedBytes: swapUsedBytes,
    } : null,
    sampledAt,
  };
}

function safeByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function createDashboardServer({
  rootDir = DEFAULT_ROOT,
  agentsPath = path.join(rootDir, 'config', 'agents.tsv'),
  telemetryPath = path.join(rootDir, 'runtime', 'telemetry', 'events.jsonl'),
  endpointTelemetryPath = path.join(rootDir, 'runtime', 'telemetry', 'endpoint_checks.jsonl'),
  stateDir = path.join(rootDir, 'runtime', 'state'),
  publicDir = path.join(HERE, 'public'),
  agentInspector = null,
  minecraftPort = Number(process.env.MC_PORT || 25565),
  minecraftProbe = probeTcpPort,
  minecraftSession = process.env.MINECRAFT_SESSION || 'mc-server',
  sessionLister = listTmuxSessions,
  workerStateLoader = loadAgentWorkerStates,
  socialAgentInspector = createSocialAgentInspector(),
  sparkMemoryMonitor = createSparkMemoryMonitor(),
} = {}) {
  const telemetry = new TelemetryFile(telemetryPath);
  const endpointTelemetry = new EndpointTelemetryFile(endpointTelemetryPath);

  return http.createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    if (!['GET', 'HEAD'].includes(method)) {
      jsonResponse(response, 405, { error: 'method_not_allowed' }, method);
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      jsonResponse(response, 400, { error: 'bad_request' }, method);
      return;
    }

    if (pathname === '/api/health') {
      jsonResponse(response, 200, { ok: true }, method);
      return;
    }

    if (pathname === '/api/snapshot') {
      try {
        const agents = await loadAgents(agentsPath);
        const tmuxSessions = await sessionLister();
        const inspect = agentInspector ?? createAgentInspector({
          hasTmuxSession: async (name) => tmuxSessions.has(name),
        });
        const [states, workers, metrics, endpointMetrics, minecraftReachability, socialState, sparkMemory] = await Promise.all([
          Promise.all(agents.map((agent) => inspect(agent))),
          Promise.all(agents.map((agent) => workerStateLoader(stateDir, agent.id))),
          telemetry.refresh(),
          endpointTelemetry.refresh(),
          minecraftProbe(minecraftPort),
          Promise.resolve().then(() => socialAgentInspector()).catch(() => ({ running: false })),
          sparkMemoryMonitor.snapshot().catch(() => []),
        ]);
        const combined = agents.map((agent, index) => {
          const publicState = publicAgentState(states[index]);
          const publicWorkerState = publicWorkers(workers[index], publicState);
          const brain = publicWorkerState.brain;
          const body = publicWorkerState.body;
          const brainHealthy = !brain ||
            (brain.state === 'running' && brain.childRunning) ||
            (brain.state === 'waiting' && !brain.childRunning);
          const bodyHealthy = !body || (body.state === 'running' && body.childRunning);
          const workerDegraded = !brainHealthy || !bodyHealthy;
          if (publicState.state === 'online' && workerDegraded) publicState.state = 'degraded';
          return {
            ...publicAgent(agent),
            ...publicState,
            workers: publicWorkerState,
            metrics: metrics.byAgent[agent.id] ?? null,
          };
        });
        combined.push(publicSocialAgent(socialState, metrics.byAgent[SOCIAL_AGENT.id]));
        jsonResponse(response, 200, {
          generatedAt: Date.now(),
          agents: combined,
          overall: metrics.totals,
          telemetry: {
            eventsSeen: metrics.eventsSeen,
            invalidLines: metrics.invalidLines,
          },
          endpointHealth: endpointMetrics,
          sparks: Array.isArray(sparkMemory)
            ? sparkMemory.map(publicSparkMemory).filter(Boolean)
            : [],
          minecraftServer: {
            ...minecraftReachability,
            sessionRunning: tmuxSessions.has(minecraftSession),
          },
        }, method);
      } catch (error) {
        jsonResponse(response, 503, {
          error: 'snapshot_unavailable',
          detail: error instanceof Error ? error.message : 'unknown error',
        }, method);
      }
      return;
    }

    const staticFile = STATIC_FILES.get(pathname);
    if (!staticFile) {
      jsonResponse(response, 404, { error: 'not_found' }, method);
      return;
    }
    try {
      const [fileName, contentType] = staticFile;
      writeResponse(response, 200, contentType, await readFile(path.join(publicDir, fileName)), method);
    } catch {
      jsonResponse(response, 404, { error: 'not_found' }, method);
    }
  });
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_DASHBOARD_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DASHBOARD_PORT must be an integer from 1 to 65535');
  }
  return port;
}

export async function startDashboard(options = {}) {
  const port = parsePort(options.port ?? process.env.DASHBOARD_PORT);
  const server = createDashboardServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, resolve);
  });
  return server;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  startDashboard().then((server) => {
    const address = server.address();
    console.log(`Eddie Platinum Dashboard: http://${LOOPBACK_HOST}:${address.port}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
