import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMOTE_SPARK_COMMAND,
  buildSshArguments,
  createSparkMemoryMonitor,
  parseMemorySample,
  parseSparkSample,
  probeSparkMemory,
} from '../lib/spark-memory.js';

const SPARKS = [
  { id: 'spark1', displayName: 'Spark 1', target: 'user@192.0.2.1' },
  {
    id: 'spark2',
    displayName: 'Spark 2',
    target: 'user@192.0.2.2',
    hostKeyAlias: 'spark2.example',
  },
];

const MEMORY = {
  memory: {
    totalBytes: 102_400,
    usedBytes: 76_800,
    availableBytes: 25_600,
    utilizationPercent: 75,
  },
  swap: {
    totalBytes: 10_240,
    usedBytes: 6_144,
  },
};

function statusPayload({ daemon = 'running', pid = 42, active = null } = {}) {
  return {
    object: 'local.status_report',
    daemon: { state: daemon, pid: daemon === 'running' ? pid : null },
    api: { inference: { inference_readiness: active ? 'ready' : 'idle' } },
    model: { active },
    cluster: { state: { membership_status: 'connected' } },
  };
}

function sampleText(options) {
  return `100 25 10 4\n${JSON.stringify(statusPayload(options))}\n`;
}

const IDLE_SAMPLE = {
  ...MEMORY,
  runtime: {
    daemonRunning: true,
    inferenceReadiness: 'idle',
    activeModel: null,
    clusterMembership: 'connected',
  },
};

test('parses fixed /proc/meminfo fields and rejects malformed samples', () => {
  assert.deepEqual(parseMemorySample('100 25 10 4\n'), MEMORY);

  for (const invalid of [
    '',
    '100 25 10',
    '100 25 10 4 1',
    '100 25.5 10 4',
    '100 -1 10 4',
    '0 0 0 0',
    '100 101 10 4',
    '100 25 10 11',
    '100 25 10 nope',
  ]) {
    assert.throws(() => parseMemorySample(invalid), Error, invalid);
  }
});

test('parses idle, daemon-down, and serving Actual runtime states', () => {
  assert.deepEqual(parseSparkSample(sampleText()), IDLE_SAMPLE);
  assert.equal(
    parseSparkSample(sampleText({ daemon: 'not_running' })).runtime.daemonRunning,
    false,
  );
  assert.deepEqual(
    parseSparkSample(sampleText({ active: { canonical_name: 'qwen3.8-27b-Q4_K_M' } })).runtime,
    {
      daemonRunning: true,
      inferenceReadiness: 'ready',
      activeModel: 'qwen3.8-27b-Q4_K_M',
      clusterMembership: 'connected',
    },
  );
  assert.throws(() => parseSparkSample('100 25 10 4\nnot json'), /invalid runtime status/);
});

test('uses execFile with a fixed read-only SSH command and strict options', async () => {
  const spark = SPARKS[1];
  const identityFile = '/private/key with spaces';
  const expectedArgs = buildSshArguments(spark, identityFile);
  assert.equal(expectedArgs.at(-2), spark.target);
  assert.equal(expectedArgs.at(-1), REMOTE_SPARK_COMMAND);
  assert.ok(expectedArgs.includes('BatchMode=yes'));
  assert.ok(expectedArgs.includes('ConnectionAttempts=1'));
  assert.ok(expectedArgs.includes('StrictHostKeyChecking=yes'));
  assert.ok(expectedArgs.includes('HostKeyAlias=spark2.example'));

  const result = await probeSparkMemory(spark, {
    identityFile,
    timeoutMs: 1234,
    execFile: (command, args, options, callback) => {
      assert.equal(command, 'ssh');
      assert.deepEqual(args, expectedArgs);
      assert.equal(options.timeout, 1234);
      assert.equal(options.maxBuffer, 32 * 1024);
      assert.equal(options.shell, undefined);
      callback(null, sampleText(), 'private stderr');
    },
  });
  assert.deepEqual(result, IDLE_SAMPLE);
});

test('distinguishes idle and serving daemons while caching failures', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const monitor = createSparkMemoryMonitor({
    sparks: SPARKS,
    now: () => 1_000,
    probe: async (spark) => {
      calls.push(spark.id);
      await gate;
      if (spark.id === 'spark2') throw new Error('private remote failure');
      return IDLE_SAMPLE;
    },
  });

  const first = monitor.snapshot();
  const concurrent = monitor.snapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['spark1', 'spark2']);
  release();

  const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
  assert.deepEqual(firstSnapshot, concurrentSnapshot);
  assert.equal(firstSnapshot[0].status, 'idle');
  assert.equal(firstSnapshot[1].status, 'unavailable');
  assert.equal(firstSnapshot[1].memory, null);

  const cached = await monitor.snapshot();
  assert.equal(cached[1].status, 'unavailable');
  assert.deepEqual(calls, ['spark1', 'spark2']);
  assert.doesNotMatch(JSON.stringify(cached), /private remote failure/);
});

test('projects stopped and active-model states from successful samples', async () => {
  let sample = {
    ...IDLE_SAMPLE,
    runtime: { ...IDLE_SAMPLE.runtime, daemonRunning: false },
  };
  let clock = 1_000;
  const monitor = createSparkMemoryMonitor({
    sparks: [SPARKS[0]],
    cacheMs: 0,
    now: () => clock,
    probe: async () => sample,
  });
  assert.equal((await monitor.snapshot())[0].status, 'daemon-down');

  clock += 1;
  sample = {
    ...IDLE_SAMPLE,
    runtime: { ...IDLE_SAMPLE.runtime, activeModel: 'qwen3.8-27b-Q4_K_M' },
  };
  assert.equal((await monitor.snapshot())[0].status, 'serving');
});

test('retains a failed last-good sample as stale, expires it, and recovers', async () => {
  let clock = 1_000;
  let calls = 0;
  let recover = false;
  const monitor = createSparkMemoryMonitor({
    sparks: [SPARKS[0]],
    now: () => clock,
    probe: async () => {
      calls += 1;
      if (calls > 1 && !recover) throw new Error('unreachable');
      return IDLE_SAMPLE;
    },
  });

  let snapshot = await monitor.snapshot();
  assert.equal(snapshot[0].status, 'idle');
  assert.equal(snapshot[0].sampledAt, 1_000);

  clock = 11_000;
  snapshot = await monitor.snapshot();
  assert.equal(snapshot[0].status, 'stale');
  assert.deepEqual(snapshot[0].memory, MEMORY.memory);
  assert.equal(calls, 2);

  clock = 61_001;
  snapshot = await monitor.snapshot();
  assert.equal(snapshot[0].status, 'unavailable');
  assert.equal(snapshot[0].memory, null);

  recover = true;
  clock = 71_001;
  snapshot = await monitor.snapshot();
  assert.equal(snapshot[0].status, 'idle');
  assert.deepEqual(snapshot[0].memory, MEMORY.memory);
  assert.equal(snapshot[0].sampledAt, 71_001);
});
