import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const DEFAULT_SOCIAL_PID_FILE = '/tmp/eddie-daemon.pid';

export async function readSocialPid(pidFile = DEFAULT_SOCIAL_PID_FILE) {
  const value = (await readFile(pidFile, 'utf8')).trim();
  if (!/^[0-9]+$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

export function processIsSocialDaemon(pid, { execFile = execFileCallback } = {}) {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 1_000,
      maxBuffer: 4 * 1024,
      windowsHide: true,
    }, (error, stdout = '') => {
      resolve(!error && /(?:^|\/)eddie_daemon\.py(?:\s|$)/.test(stdout.trim()));
    });
  });
}

export function createSocialAgentInspector({
  pidFile = DEFAULT_SOCIAL_PID_FILE,
  readPid = readSocialPid,
  processMatches = processIsSocialDaemon,
} = {}) {
  return async () => {
    try {
      const pid = await readPid(pidFile);
      return { running: pid !== null && await processMatches(pid) };
    } catch {
      return { running: false };
    }
  };
}
