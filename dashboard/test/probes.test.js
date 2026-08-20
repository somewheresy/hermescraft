import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  inspectAgent,
  listTmuxSessions,
  probeAgentObservability,
  summarizeAgentState,
} from '../lib/probes.js';

test('observability probes only the content-free loopback endpoint', async (context) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/observability');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      data: {
        connected: true,
        username: 'EddiePlatinum',
        health: 20,
        maxHealth: 20,
        food: 20,
        position: { x: 1, y: 64, z: 2 },
        dimension: 'overworld',
        biome: 'plains',
        task: null,
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const observation = await probeAgentObservability({ apiPort: address.port });
  assert.deepEqual(observation, {
    reachable: true,
    connected: true,
    reportedUsername: 'EddiePlatinum',
    game: {
      health: 20,
      maxHealth: 20,
      food: 20,
      position: { x: 1, y: 64, z: 2 },
      dimension: 'overworld',
      biome: 'plains',
    },
    task: null,
  });
});

test('agent inspection uses canonical tmux names and reports online', async () => {
  const sessions = [];
  const agent = {
    id: 'eddie',
    username: 'EddiePlatinum',
    apiPort: 3002,
    enabled: true,
  };
  const result = await inspectAgent(agent, {
    hasTmuxSession: async (name) => {
      sessions.push(name);
      return true;
    },
    probeAgentObservability: async () => ({
      reachable: true,
      connected: true,
      reportedUsername: 'EddiePlatinum',
      game: { health: 20, food: 20, position: { x: 1, y: 64, z: 2 } },
      task: null,
    }),
  });
  assert.deepEqual(sessions, ['mc-eddie-brain', 'mc-eddie-body']);
  assert.equal(result.state, 'online');
  assert.equal(result.identityMatches, true);
  assert.equal(result.game.health, 20);
});

test('observability probe defensively whitelists fields', async (context) => {
  const secret = 'private chat should never leave the probe';
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    assert.equal(request.url, '/observability');
    response.end(JSON.stringify({
      ok: true,
      data: {
        connected: true,
        username: 'EddiePlatinum',
        health: 18,
        maxHealth: 20,
        food: 17,
        position: { x: 1.5, y: 64, z: -2 },
        dimension: 'overworld',
        biome: 'plains',
        task: { action: 'goto', status: 'running', elapsedSeconds: 9, result: secret },
        unreadChat: [{ message: secret }],
        scene: secret,
        inventory: [{ name: secret }],
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const details = await probeAgentObservability({ apiPort: address.port });
  assert.deepEqual(details, {
    reachable: true,
    connected: true,
    reportedUsername: 'EddiePlatinum',
    game: {
      health: 18,
      maxHealth: 20,
      food: 17,
      position: { x: 1.5, y: 64, z: -2 },
      dimension: 'overworld',
      biome: 'plains',
    },
    task: { action: 'goto', status: 'running', elapsedSeconds: 9 },
  });
  assert.doesNotMatch(JSON.stringify(details), /private chat/);
});

test('state is degraded for partial lifecycle and disabled agents are not probed', async () => {
  assert.equal(summarizeAgentState({
    enabled: true,
    brainRunning: true,
    bodyRunning: false,
    health: { reachable: false, connected: false },
  }), 'degraded');

  let called = false;
  const result = await inspectAgent({ id: 'off', enabled: false }, {
    hasTmuxSession: async () => { called = true; },
    probeAgentObservability: async () => { called = true; },
  });
  assert.equal(result.state, 'disabled');
  assert.equal(called, false);
});

test('tmux sessions are inventoried in one process call', async () => {
  let calls = 0;
  const sessions = await listTmuxSessions({
    execFile: (command, args, options, callback) => {
      calls += 1;
      assert.equal(command, 'tmux');
      assert.deepEqual(args, ['list-sessions', '-F', '#S']);
      callback(null, 'mc-server\nmc-eddie-body\nmc-eddie-brain\n');
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(sessions, new Set(['mc-server', 'mc-eddie-body', 'mc-eddie-brain']));
});
