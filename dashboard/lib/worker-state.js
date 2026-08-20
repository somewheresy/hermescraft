import { readFile } from 'node:fs/promises';
import path from 'node:path';

const COMPONENTS = new Set(['brain', 'body']);
const STATES = new Set(['starting', 'running', 'waiting', 'backing_off', 'failed', 'stopping', 'stopped']);
const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

function invalidState() {
  return {
    state: 'invalid',
    childRunning: false,
    restartCount: 0,
    lastExitCode: null,
    updatedAt: null,
    invalid: true,
  };
}

function parseWorkerState(source, expectedAgentId, expectedComponent) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return invalidState();
  }
  if (!value || typeof value !== 'object') return invalidState();
  const updatedAt = Date.parse(value.updated_at);
  const exitCodeValid = value.last_exit_code === null || Number.isInteger(value.last_exit_code);
  if (value.agent_id !== expectedAgentId ||
      value.component !== expectedComponent ||
      !STATES.has(value.state) ||
      !Number.isSafeInteger(value.restart_count) || value.restart_count < 0 ||
      !exitCodeValid || !Number.isFinite(updatedAt)) {
    return invalidState();
  }
  const childPid = typeof value.child_pid === 'string' ? value.child_pid : '';
  return {
    state: value.state,
    childRunning: value.state === 'running' && /^\d+$/.test(childPid),
    restartCount: value.restart_count,
    lastExitCode: value.last_exit_code,
    updatedAt,
    invalid: false,
  };
}

export async function loadWorkerState(stateDir, agentId, component) {
  if (!AGENT_ID.test(agentId) || !COMPONENTS.has(component)) return invalidState();
  try {
    const source = await readFile(path.join(stateDir, `${agentId}-${component}.json`), 'utf8');
    return parseWorkerState(source, agentId, component);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return invalidState();
  }
}

export async function loadAgentWorkerStates(stateDir, agentId) {
  const [brain, body] = await Promise.all([
    loadWorkerState(stateDir, agentId, 'brain'),
    loadWorkerState(stateDir, agentId, 'body'),
  ]);
  return { brain, body };
}

export function projectWorkerState(worker, supervisorRunning, now = Date.now()) {
  if (!worker) return null;
  return {
    ...worker,
    stale: !supervisorRunning && worker.updatedAt !== null && now - worker.updatedAt > 30_000,
  };
}
