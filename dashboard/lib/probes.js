import http from 'node:http';
import net from 'node:net';
import { execFile as execFileCallback } from 'node:child_process';

const MAX_RESPONSE_BYTES = 32 * 1024;

function requestJson(port, requestPath, { timeoutMs = 750 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = http.get({
      host: '127.0.0.1',
      port,
      path: requestPath,
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_RESPONSE_BYTES) response.destroy();
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          finish({ reachable: true, value: null, protocolError: true });
          return;
        }
        try {
          const health = JSON.parse(body);
          finish({ reachable: true, value: health });
        } catch {
          finish({ reachable: true, value: null, protocolError: true });
        }
      });
      response.on('aborted', () => finish({ reachable: true, value: null, protocolError: true }));
      response.on('error', () => finish({ reachable: true, value: null, protocolError: true }));
    });

    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => finish({ reachable: false, value: null }));
  });
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeLabel(value, limit = 80) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^a-zA-Z0-9 _:-]/g, '').trim();
  return cleaned.slice(0, limit) || null;
}

function whitelistedGameState(state) {
  if (!state) return null;
  const position = state.position && typeof state.position === 'object'
    ? {
        x: finiteNumber(state.position.x),
        y: finiteNumber(state.position.y),
        z: finiteNumber(state.position.z),
      }
    : null;
  return {
    health: finiteNumber(state.health),
    maxHealth: finiteNumber(state.maxHealth),
    food: finiteNumber(state.food),
    position,
    dimension: safeLabel(state.dimension),
    biome: safeLabel(state.biome),
  };
}

function whitelistedTaskState(task) {
  task = task && typeof task === 'object' ? task : null;
  if (!task) return null;
  return {
    action: safeLabel(task.action, 40),
    status: safeLabel(task.status, 24),
    elapsedSeconds: finiteNumber(task.elapsedSeconds),
  };
}

export async function probeAgentObservability(agent, options = {}) {
  const result = await requestJson(agent.apiPort, '/observability', options);
  const data = result.value?.ok === true && result.value.data && typeof result.value.data === 'object'
    ? result.value.data
    : null;
  return {
    reachable: result.reachable,
    connected: data?.connected === true,
    reportedUsername: typeof data?.username === 'string' ? data.username : null,
    game: data?.connected === true ? whitelistedGameState(data) : null,
    task: whitelistedTaskState(data?.task),
    ...(result.protocolError ? { protocolError: true } : {}),
  };
}

export function probeTcpPort(port, { timeoutMs = 750 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, port });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function hasTmuxSession(sessionName, { execFile = execFileCallback } = {}) {
  return new Promise((resolve) => {
    execFile('tmux', ['has-session', '-t', `=${sessionName}`], {
      timeout: 750,
      windowsHide: true,
    }, (error) => resolve(!error));
  });
}

export function listTmuxSessions({ execFile = execFileCallback } = {}) {
  return new Promise((resolve) => {
    execFile('tmux', ['list-sessions', '-F', '#S'], {
      timeout: 750,
      windowsHide: true,
    }, (error, stdout = '') => {
      if (error) {
        resolve(new Set());
        return;
      }
      resolve(new Set(stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)));
    });
  });
}

export function summarizeAgentState({ enabled, brainRunning, bodyRunning, health }) {
  if (!enabled) return 'disabled';
  if (brainRunning && bodyRunning && health.reachable && health.connected) return 'online';
  if (brainRunning || bodyRunning || health.reachable) return 'degraded';
  return 'offline';
}

export async function inspectAgent(agent, dependencies = {}) {
  if (!agent.enabled) {
    return {
      state: 'disabled',
      brainRunning: false,
      bodyRunning: false,
      apiReachable: false,
      minecraftConnected: false,
      identityMatches: null,
      game: null,
      task: null,
    };
  }

  const sessionCheck = dependencies.hasTmuxSession ?? hasTmuxSession;
  const observabilityProbe = dependencies.probeAgentObservability ?? probeAgentObservability;
  const [brainRunning, bodyRunning, observation] = await Promise.all([
    sessionCheck(`mc-${agent.id}-brain`),
    sessionCheck(`mc-${agent.id}-body`),
    observabilityProbe(agent),
  ]);
  const reported = observation.reportedUsername;
  const identityMatches = reported ? reported === agent.username : null;
  let state = summarizeAgentState({
    enabled: true,
    brainRunning,
    bodyRunning,
    health: observation,
  });
  if (state === 'online' && identityMatches === false) state = 'degraded';
  return {
    state,
    brainRunning,
    bodyRunning,
    apiReachable: observation.reachable,
    minecraftConnected: observation.connected,
    identityMatches,
    game: observation.game,
    task: observation.task,
  };
}

export function createAgentInspector(dependencies = {}) {
  return (agent) => inspectAgent(agent, dependencies);
}
