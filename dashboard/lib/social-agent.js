import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SOCIAL_LAUNCHD_TARGET = 'system/com.somewhere.eddie.agent';
export const DEFAULT_SOCIAL_HEARTBEAT_FILE = path.join(
  os.homedir(),
  '.local',
  'share',
  'eddie-platinum-agent',
  'state',
  'daemon_heartbeat.json',
);
export const DEFAULT_SOCIAL_HEARTBEAT_MAX_AGE_MS = 180_000;

export function parseLaunchdJob(source) {
  if (typeof source !== 'string') return { running: false, pid: null };
  const state = source.match(/^\s*state\s*=\s*(\S+)\s*$/m)?.[1] ?? '';
  const rawPid = source.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1] ?? '';
  const pid = Number(rawPid);
  return {
    running: state === 'running' && Number.isSafeInteger(pid) && pid > 1,
    pid: Number.isSafeInteger(pid) && pid > 1 ? pid : null,
  };
}

export function inspectSocialLaunchd(
  target = DEFAULT_SOCIAL_LAUNCHD_TARGET,
  { execFile = execFileCallback } = {},
) {
  return new Promise((resolve) => {
    execFile('/bin/launchctl', ['print', target], {
      timeout: 1_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    }, (error, stdout = '') => {
      resolve(error ? { running: false, pid: null } : parseLaunchdJob(stdout));
    });
  });
}

export async function readSocialHeartbeat(
  heartbeatFile = DEFAULT_SOCIAL_HEARTBEAT_FILE,
) {
  const payload = JSON.parse(await readFile(heartbeatFile, 'utf8'));
  const aliveAt = Date.parse(payload?.alive_at);
  const pid = Number(payload?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isFinite(aliveAt)) return null;
  return {
    pid,
    aliveAt,
    phase: typeof payload.phase === 'string' ? payload.phase.slice(0, 80) : null,
  };
}

export function projectSocialHealth(job, heartbeat, {
  now = Date.now(),
  heartbeatMaxAgeMs = DEFAULT_SOCIAL_HEARTBEAT_MAX_AGE_MS,
} = {}) {
  if (!job?.running) {
    return { state: 'offline', running: false, phase: null };
  }
  const age = heartbeat ? Math.max(0, now - heartbeat.aliveAt) : Infinity;
  const heartbeatHealthy = heartbeat !== null
    && heartbeat.pid === job.pid
    && age <= heartbeatMaxAgeMs;
  return {
    state: heartbeatHealthy ? 'online' : 'degraded',
    running: true,
    phase: heartbeatHealthy ? heartbeat.phase : null,
  };
}

export function createSocialAgentInspector({
  launchdTarget = DEFAULT_SOCIAL_LAUNCHD_TARGET,
  heartbeatFile = DEFAULT_SOCIAL_HEARTBEAT_FILE,
  heartbeatMaxAgeMs = DEFAULT_SOCIAL_HEARTBEAT_MAX_AGE_MS,
  now = Date.now,
  inspectJob = inspectSocialLaunchd,
  readHeartbeat = readSocialHeartbeat,
  execFile = execFileCallback,
} = {}) {
  return async () => {
    const [job, heartbeat] = await Promise.all([
      inspectJob(launchdTarget, { execFile }).catch(() => ({ running: false, pid: null })),
      readHeartbeat(heartbeatFile).catch(() => null),
    ]);
    return projectSocialHealth(job, heartbeat, {
      now: now(),
      heartbeatMaxAgeMs,
    });
  };
}
