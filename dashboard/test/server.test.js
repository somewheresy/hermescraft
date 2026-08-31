import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDashboardServer, DEFAULT_DASHBOARD_PORT } from '../server.js';

const HEADER = 'id\tdisplay_name\tusername\tapi_port\tprofile_dir\tprompt_id\tenabled';

test('serves a read-only snapshot with no private profile path', async (context) => {
  const now = Date.now();
  assert.equal(DEFAULT_DASHBOARD_PORT, 9120);
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-dashboard-'));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'runtime', 'telemetry'), { recursive: true });
  await writeFile(
    path.join(root, 'config', 'agents.tsv'),
    `${HEADER}\neddie\tEddie Platinum\tEddiePlatinum\t3002\tprivate/profile/path\tlead\ttrue\n`,
  );
  const minecraftEvent = {
      schema_version: 1,
      event: 'api_usage',
      observed_at_ms: 1_000,
      agent_id: 'eddie',
      usage_reported: true,
      request_count: 1,
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      prompt_tokens: 10,
      total_tokens: 12,
  };
  const socialEvent = {
    ...minecraftEvent,
    observed_at_ms: 2_000,
    agent_id: 'eddie-social',
    input_tokens: 5,
    output_tokens: 2,
    prompt_tokens: 5,
    total_tokens: 7,
    model: 'qwen-social',
  };
  await writeFile(
    path.join(root, 'runtime', 'telemetry', 'events.jsonl'),
    `${JSON.stringify(minecraftEvent)}\n${JSON.stringify(socialEvent)}\n`,
  );
  await writeFile(
    path.join(root, 'runtime', 'telemetry', 'endpoint_checks.jsonl'),
    `${JSON.stringify({
      schema_version: 1,
      event: 'endpoint_check',
      observed_at_ms: now,
      endpoint: '/v1/responses',
      mode: 'nonstream',
      success: true,
      http_status: 200,
      latency_ms: 250,
      prompt_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      schema_ok: true,
      parity: 'golden',
      model: 'qwen',
      private_response: 'must stay private',
    })}\n`,
  );

  const server = createDashboardServer({
    rootDir: root,
    agentInspector: async () => ({
      state: 'online',
      brainRunning: true,
      bodyRunning: true,
      apiReachable: true,
      minecraftConnected: true,
      identityMatches: true,
      secretContent: 'must not reach the browser',
    }),
    minecraftProbe: async (port) => ({ reachable: true, port }),
    sessionLister: async () => new Set(['mc-server']),
    socialAgentInspector: async () => ({
      state: 'online', running: true, phase: null, pid: 74789, privateDetail: 'hidden',
    }),
    workerStateLoader: async () => ({
      brain: {
        state: 'waiting', childRunning: false, restartCount: 0,
        lastExitCode: 0, updatedAt: Date.now(), invalid: false,
      },
      body: {
        state: 'running', childRunning: true, restartCount: 0,
        lastExitCode: null, updatedAt: Date.now(), invalid: false,
      },
    }),
    sparkMemoryMonitor: {
      snapshot: async () => [{
        id: 'spark1',
        displayName: 'Spark 1',
        status: 'serving',
        memory: {
          totalBytes: 102_400,
          usedBytes: 76_800,
          availableBytes: 25_600,
          utilizationPercent: 75,
        },
        swap: { totalBytes: 10_240, usedBytes: 6_144 },
        runtime: {
          daemonRunning: true,
          inferenceReadiness: 'ready',
          activeModel: 'qwen3.8-27b-Q4_K_M',
          clusterMembership: 'connected',
        },
        sampledAt: 1_000,
        target: 'private-hostname',
        identityFile: 'private-key-path',
        stderr: 'private remote output',
      }, {
        id: 'spark2',
        displayName: 'Spark 2',
        status: 'idle',
        memory: {
          totalBytes: 100,
          usedBytes: 75,
          availableBytes: 50,
        },
        swap: { totalBytes: 10, usedBytes: 2 },
        sampledAt: 1_000,
      }],
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');

  const response = await fetch(`http://127.0.0.1:${address.port}/api/snapshot`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  const snapshot = await response.json();
  assert.equal(snapshot.overall.totalTokens, 19);
  assert.equal(snapshot.agents[0].state, 'online');
  assert.equal(snapshot.agents[0].workers.brain.restartCount, 0);
  assert.equal(snapshot.endpointHealth.overall.checks, 1);
  assert.equal(snapshot.endpointHealth.overall.successes, 1);
  assert.equal(snapshot.endpointHealth.routes[0].endpoint, '/v1/responses');
  assert.deepEqual(snapshot.agents[1], {
    id: 'eddie-social',
    displayName: 'Eddie Platinum — Social',
    username: 'EddiePlatinum',
    apiPort: null,
    promptId: 'social',
    enabled: true,
    workload: 'social',
    state: 'online',
    daemonRunning: true,
    brainRunning: false,
    bodyRunning: false,
    apiReachable: false,
    minecraftConnected: false,
    identityMatches: null,
    game: null,
    task: null,
    workers: { brain: null, body: null },
    metrics: {
      requests: 1,
      meteredRequests: 1,
      unmeteredRequests: 0,
      usageCoverage: 1,
      errors: 0,
      turns: 0,
      averageDurationMs: 0,
      lastActivityAt: 2_000,
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      promptTokens: 5,
      totalTokens: 7,
      model: 'qwen-social',
      provider: null,
    },
  });
  assert.deepEqual(snapshot.minecraftServer, {
    reachable: true,
    port: 25565,
    sessionRunning: true,
  });
  assert.deepEqual(snapshot.sparks, [{
    id: 'spark1',
    displayName: 'Spark 1',
    status: 'serving',
    memory: {
      totalBytes: 102_400,
      usedBytes: 76_800,
      availableBytes: 25_600,
      utilizationPercent: 75,
    },
    swap: { totalBytes: 10_240, usedBytes: 6_144 },
    runtime: {
      daemonRunning: true,
      inferenceReadiness: 'ready',
      activeModel: 'qwen3.8-27b-Q4_K_M',
      clusterMembership: 'connected',
    },
    sampledAt: 1_000,
  }, {
    id: 'spark2',
    displayName: 'Spark 2',
    status: 'unavailable',
    memory: null,
    swap: null,
    runtime: null,
    sampledAt: 1_000,
  }]);
  assert.equal(snapshot.agents[0].profileDir, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /private\/profile\/path/);
  assert.doesNotMatch(JSON.stringify(snapshot), /must not reach the browser/);
  assert.doesNotMatch(JSON.stringify(snapshot), /must stay private/);
  assert.doesNotMatch(JSON.stringify(snapshot), /74789|privateDetail|hidden/);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-hostname|private-key-path|private remote output/);

  const mutation = await fetch(`http://127.0.0.1:${address.port}/api/snapshot`, { method: 'POST' });
  assert.equal(mutation.status, 405);
});

test('keeps the dashboard available when the Spark monitor fails', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-dashboard-spark-failure-'));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'runtime', 'telemetry'), { recursive: true });
  await writeFile(path.join(root, 'config', 'agents.tsv'), `${HEADER}\n`);
  await writeFile(path.join(root, 'runtime', 'telemetry', 'events.jsonl'), '');

  const server = createDashboardServer({
    rootDir: root,
    minecraftProbe: async (port) => ({ reachable: true, port }),
    sessionLister: async () => new Set(['mc-server']),
    socialAgentInspector: async () => { throw new Error('private Social probe failure'); },
    sparkMemoryMonitor: {
      snapshot: async () => { throw new Error('private SSH failure details'); },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/snapshot`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.deepEqual(snapshot.sparks, []);
  assert.equal(snapshot.agents[0].id, 'eddie-social');
  assert.equal(snapshot.agents[0].state, 'offline');
  assert.doesNotMatch(JSON.stringify(snapshot), /private SSH failure details/);
  assert.doesNotMatch(JSON.stringify(snapshot), /private Social probe failure/);
});

test('does not serve arbitrary filesystem paths', async (context) => {
  const server = createDashboardServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/..%2f..%2fetc%2fpasswd`);
  assert.equal(response.status, 404);
});
