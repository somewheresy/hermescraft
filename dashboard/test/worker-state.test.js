import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadAgentWorkerStates, loadWorkerState, projectWorkerState } from '../lib/worker-state.js';

test('loads the content-free fleet worker schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-worker-state-'));
  await writeFile(path.join(root, 'eddie-brain.json'), JSON.stringify({
    agent_id: 'eddie',
    component: 'brain',
    state: 'running',
    pid: 100,
    child_pid: '101',
    restart_count: 2,
    last_exit_code: null,
    updated_at: '2026-07-15T12:00:00Z',
  }));

  const state = await loadWorkerState(root, 'eddie', 'brain');
  assert.deepEqual(state, {
    state: 'running',
    childRunning: true,
    restartCount: 2,
    lastExitCode: null,
    updatedAt: Date.parse('2026-07-15T12:00:00Z'),
    invalid: false,
  });
  assert.equal(state.pid, undefined);
});

test('marks malformed or mismatched state invalid and missing state null', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-worker-state-'));
  await writeFile(path.join(root, 'eddie-body.json'), '{bad json');
  assert.equal((await loadWorkerState(root, 'eddie', 'body')).invalid, true);
  assert.equal(await loadWorkerState(root, 'actual1', 'brain'), null);
});

test('loads both components and applies the controller staleness contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-worker-state-'));
  await mkdir(root, { recursive: true });
  const updatedAt = '2026-07-15T12:00:00Z';
  for (const component of ['brain', 'body']) {
    await writeFile(path.join(root, `eddie-${component}.json`), JSON.stringify({
      agent_id: 'eddie',
      component,
      state: 'backing_off',
      pid: 100,
      child_pid: '',
      restart_count: 3,
      last_exit_code: 1,
      updated_at: updatedAt,
    }));
  }
  const states = await loadAgentWorkerStates(root, 'eddie');
  const recent = Date.parse(updatedAt) + 10_000;
  const old = Date.parse(updatedAt) + 31_000;
  assert.equal(projectWorkerState(states.brain, false, recent).stale, false);
  assert.equal(projectWorkerState(states.brain, false, old).stale, true);
  assert.equal(projectWorkerState(states.brain, true, old).stale, false);
});

test('accepts the healthy between-turn waiting state without a child process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-worker-state-'));
  await writeFile(path.join(root, 'eddie-brain.json'), JSON.stringify({
    agent_id: 'eddie',
    component: 'brain',
    state: 'waiting',
    pid: 100,
    child_pid: '',
    restart_count: 0,
    last_exit_code: 0,
    updated_at: '2026-07-15T12:00:00Z',
  }));

  const state = await loadWorkerState(root, 'eddie', 'brain');
  assert.equal(state.state, 'waiting');
  assert.equal(state.childRunning, false);
  assert.equal(state.restartCount, 0);
  assert.equal(state.lastExitCode, 0);
});

test('preserves a supervisor setup failure for the dashboard', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-worker-state-'));
  await writeFile(path.join(root, 'eddie-brain.json'), JSON.stringify({
    agent_id: 'eddie',
    component: 'brain',
    state: 'failed',
    pid: 100,
    child_pid: '',
    restart_count: 0,
    last_exit_code: 1,
    updated_at: '2026-07-15T12:00:00Z',
  }));

  const state = await loadWorkerState(root, 'eddie', 'brain');
  assert.equal(state.state, 'failed');
  assert.equal(state.childRunning, false);
  assert.equal(state.lastExitCode, 1);
});
