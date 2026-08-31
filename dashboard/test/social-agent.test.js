import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createSocialAgentInspector,
  inspectSocialLaunchd,
  parseLaunchdJob,
  projectSocialHealth,
  readSocialHeartbeat,
} from '../lib/social-agent.js';

test('parses a running launchd job without accepting invalid PIDs', () => {
  assert.deepEqual(parseLaunchdJob('state = running\npid = 74789\n'), {
    running: true,
    pid: 74789,
  });
  for (const invalid of [
    '',
    'state = exited\npid = 74789\n',
    'state = running\npid = 1\n',
    'state = running\npid = nope\n',
  ]) {
    assert.equal(parseLaunchdJob(invalid).running, false);
  }
});

test('queries only the fixed system launchd target', async () => {
  const state = await inspectSocialLaunchd('system/com.somewhere.eddie.agent', {
    execFile: (command, args, options, callback) => {
      assert.equal(command, '/bin/launchctl');
      assert.deepEqual(args, ['print', 'system/com.somewhere.eddie.agent']);
      assert.equal(options.shell, undefined);
      callback(null, 'state = running\npid = 74789\n');
    },
  });
  assert.deepEqual(state, { running: true, pid: 74789 });
});

test('reads only a valid content-free heartbeat', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-social-heartbeat-'));
  const heartbeatFile = path.join(root, 'heartbeat.json');
  await writeFile(heartbeatFile, JSON.stringify({
    pid: 74789,
    alive_at: '2026-08-31T14:00:00Z',
    phase: 'scheduled',
    ignored: 'private detail',
  }));
  assert.deepEqual(await readSocialHeartbeat(heartbeatFile), {
    pid: 74789,
    aliveAt: Date.parse('2026-08-31T14:00:00Z'),
    phase: 'scheduled',
  });
});

test('requires launchd and a fresh matching heartbeat for online state', () => {
  const now = Date.parse('2026-08-31T14:03:00Z');
  const job = { running: true, pid: 74789 };
  const fresh = {
    pid: 74789,
    aliveAt: now - 30_000,
    phase: 'scheduled',
  };
  assert.deepEqual(projectSocialHealth(job, fresh, { now }), {
    state: 'online',
    running: true,
    phase: 'scheduled',
  });
  assert.equal(projectSocialHealth(job, { ...fresh, pid: 12 }, { now }).state, 'degraded');
  assert.equal(projectSocialHealth(job, { ...fresh, aliveAt: now - 181_000 }, { now }).state, 'degraded');
  assert.equal(projectSocialHealth({ running: false, pid: null }, fresh, { now }).state, 'offline');
});

test('inspector degrades safely when heartbeat loading fails', async () => {
  const inspector = createSocialAgentInspector({
    inspectJob: async () => ({ running: true, pid: 74789 }),
    readHeartbeat: async () => { throw new Error('private path details'); },
  });
  assert.deepEqual(await inspector(), {
    state: 'degraded',
    running: true,
    phase: null,
  });
});
