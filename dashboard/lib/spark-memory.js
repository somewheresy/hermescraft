import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SPARKS = Object.freeze([
  Object.freeze({
    id: 'spark1',
    displayName: 'Spark 1',
    target: 'somewheresystems@spark1.local',
    hostKeyAlias: 's2-spark1',
  }),
  Object.freeze({
    id: 'spark2',
    displayName: 'Spark 2',
    target: 'somewheresystems@10.0.0.18',
    hostKeyAlias: 'spark-20d2.local',
  }),
]);

export const REMOTE_MEMORY_COMMAND = "awk '/^MemTotal:/ { mt = $2 } /^MemAvailable:/ { ma = $2 } /^SwapTotal:/ { st = $2 } /^SwapFree:/ { sf = $2 } END { if (mt == \"\" || ma == \"\" || st == \"\" || sf == \"\") exit 1; print mt, ma, st, sf }' /proc/meminfo";

function kibibytesToBytes(value) {
  const bytes = value * 1024;
  if (!Number.isSafeInteger(bytes)) throw new Error('memory value exceeds safe integer range');
  return bytes;
}

export function parseMemorySample(stdout) {
  if (typeof stdout !== 'string') throw new Error('memory sample must be text');
  const fields = stdout.trim().split(/\s+/);
  if (fields.length !== 4 || fields.some((field) => !/^\d+$/.test(field))) {
    throw new Error('memory sample must contain four integer fields');
  }

  const [totalKiB, availableKiB, swapTotalKiB, swapFreeKiB] = fields.map(Number);
  if (!Number.isSafeInteger(totalKiB) || totalKiB <= 0) {
    throw new Error('memory total must be a positive safe integer');
  }
  if (!Number.isSafeInteger(availableKiB) || availableKiB > totalKiB) {
    throw new Error('memory available exceeds memory total');
  }
  if (!Number.isSafeInteger(swapTotalKiB) || !Number.isSafeInteger(swapFreeKiB) || swapFreeKiB > swapTotalKiB) {
    throw new Error('swap free exceeds swap total');
  }

  const totalBytes = kibibytesToBytes(totalKiB);
  const availableBytes = kibibytesToBytes(availableKiB);
  const usedBytes = totalBytes - availableBytes;
  const swapTotalBytes = kibibytesToBytes(swapTotalKiB);
  const swapFreeBytes = kibibytesToBytes(swapFreeKiB);

  return {
    memory: {
      totalBytes,
      usedBytes,
      availableBytes,
      utilizationPercent: (usedBytes / totalBytes) * 100,
    },
    swap: {
      totalBytes: swapTotalBytes,
      usedBytes: swapTotalBytes - swapFreeBytes,
    },
  };
}

export function buildSshArguments(spark, identityFile) {
  const args = [
    '-T',
    '-i', identityFile,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ConnectTimeout=2',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
  ];
  if (spark.hostKeyAlias) args.push('-o', `HostKeyAlias=${spark.hostKeyAlias}`);
  args.push(spark.target, REMOTE_MEMORY_COMMAND);
  return args;
}

export function probeSparkMemory(spark, {
  execFile = execFileCallback,
  identityFile = path.join(os.homedir(), 'Library', 'Application Support', 'NVIDIA', 'Sync', 'config', 'nvsync.key'),
  timeoutMs = 3_000,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile('ssh', buildSshArguments(spark, identityFile), {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024,
      windowsHide: true,
    }, (error, stdout = '') => {
      if (error) {
        reject(new Error('Spark memory probe failed'));
        return;
      }
      try {
        resolve(parseMemorySample(stdout));
      } catch {
        reject(new Error('Spark returned an invalid memory sample'));
      }
    });
  });
}

function projectState(spark, state, now, staleMs) {
  const sampleAge = state.sampledAt === null ? Infinity : Math.max(0, now - state.sampledAt);
  const usableSample = state.sample !== null && (
    state.lastAttemptSucceeded || sampleAge <= staleMs
  );
  if (!usableSample) {
    return {
      id: spark.id,
      displayName: spark.displayName,
      status: 'unavailable',
      memory: null,
      swap: null,
      sampledAt: state.sampledAt,
    };
  }
  return {
    id: spark.id,
    displayName: spark.displayName,
    status: state.lastAttemptSucceeded ? 'ok' : 'stale',
    memory: state.sample.memory,
    swap: state.sample.swap,
    sampledAt: state.sampledAt,
  };
}

export function createSparkMemoryMonitor({
  sparks = DEFAULT_SPARKS,
  cacheMs = 10_000,
  staleMs = 60_000,
  timeoutMs = 3_000,
  execFile = execFileCallback,
  identityFile,
  now = Date.now,
  probe = probeSparkMemory,
} = {}) {
  const states = new Map(sparks.map((spark) => [spark.id, {
    sample: null,
    sampledAt: null,
    lastAttemptAt: null,
    lastAttemptSucceeded: false,
    inFlight: null,
  }]));

  async function refresh(spark) {
    const state = states.get(spark.id);
    const currentTime = now();
    if (state.inFlight) {
      await state.inFlight;
      return projectState(spark, state, now(), staleMs);
    }
    if (state.lastAttemptAt !== null && currentTime - state.lastAttemptAt < cacheMs) {
      return projectState(spark, state, currentTime, staleMs);
    }

    state.lastAttemptAt = currentTime;
    const inFlight = (async () => {
      try {
        state.sample = await probe(spark, { execFile, identityFile, timeoutMs });
        state.sampledAt = now();
        state.lastAttemptSucceeded = true;
      } catch {
        state.lastAttemptSucceeded = false;
      }
    })();
    state.inFlight = inFlight;
    await inFlight;
    if (state.inFlight === inFlight) state.inFlight = null;
    return projectState(spark, state, now(), staleMs);
  }

  return {
    snapshot: () => Promise.all(sparks.map(refresh)),
  };
}
