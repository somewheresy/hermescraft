import assert from 'node:assert/strict';
import { mkdtemp, appendFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseTelemetryLine, TelemetryAccumulator, TelemetryFile } from '../lib/telemetry.js';

function event(overrides = {}) {
  return {
    schema_version: 1,
    event: 'api_usage',
    observed_at_ms: 1_000,
    agent_id: 'eddie',
    usage_reported: true,
    request_count: 1,
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_write_tokens: 4,
    reasoning_tokens: 2,
    prompt_tokens: 134,
    total_tokens: 154,
    duration_ms: 1_200,
    model: 'gemma-4-31B-it-Q8_0',
    provider: 'custom',
    ...overrides,
  };
}

test('parses only supported, nonnegative telemetry records', () => {
  assert.deepEqual(parseTelemetryLine(JSON.stringify(event())), event());
  assert.equal(parseTelemetryLine('{broken'), null);
  assert.equal(parseTelemetryLine(JSON.stringify(event({ total_tokens: -1 }))), null);
  assert.equal(parseTelemetryLine(JSON.stringify(event({ schema_version: 2 }))), null);
});

test('aggregates overall and per-agent token accounting without double counting', () => {
  const accumulator = new TelemetryAccumulator();
  accumulator.addLine(JSON.stringify(event()));
  accumulator.addLine(JSON.stringify(event({
    agent_id: 'actual1',
    observed_at_ms: 2_000,
    input_tokens: 50,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    prompt_tokens: 50,
    total_tokens: 60,
    duration_ms: 800,
  })));
  accumulator.addLine(JSON.stringify({
    schema_version: 1,
    event: 'api_error',
    observed_at_ms: 3_000,
    agent_id: 'eddie',
  }));
  accumulator.addLine(JSON.stringify({
    schema_version: 1,
    event: 'turn_completed',
    observed_at_ms: 4_000,
    agent_id: 'eddie',
  }));
  accumulator.addLine('not json');

  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.totals.totalTokens, 214);
  assert.equal(snapshot.totals.promptTokens, 184);
  assert.equal(snapshot.totals.outputTokens, 30);
  assert.equal(snapshot.totals.cacheReadTokens, 30);
  assert.equal(snapshot.totals.cacheWriteTokens, 4);
  assert.equal(snapshot.totals.requests, 2);
  assert.equal(snapshot.totals.errors, 1);
  assert.equal(snapshot.totals.turns, 1);
  assert.equal(snapshot.totals.averageDurationMs, 1_000);
  assert.equal(snapshot.byAgent.eddie.totalTokens, 154);
  assert.equal(snapshot.invalidLines, 1);
});

test('request coverage follows provider-reported request counts', () => {
  const accumulator = new TelemetryAccumulator();
  accumulator.addLine(JSON.stringify(event({ request_count: 3 })));
  accumulator.addLine(JSON.stringify(event({ request_count: 2, usage_reported: false })));

  const totals = accumulator.snapshot().totals;
  assert.equal(totals.requests, 5);
  assert.equal(totals.meteredRequests, 3);
  assert.equal(totals.unmeteredRequests, 2);
  assert.equal(totals.usageCoverage, 3 / 5);
  assert.equal(parseTelemetryLine(JSON.stringify(event({ request_count: 0 }))), null);
});

test('tails appended JSONL and resets after truncation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-telemetry-'));
  const file = path.join(directory, 'events.jsonl');
  await writeFile(file, `${JSON.stringify(event())}\n`);
  const telemetry = new TelemetryFile(file);

  assert.equal((await telemetry.refresh()).totals.totalTokens, 154);
  await appendFile(file, `${JSON.stringify(event({ total_tokens: 60, prompt_tokens: 50, output_tokens: 10 }))}\n`);
  assert.equal((await telemetry.refresh()).totals.totalTokens, 214);

  await writeFile(file, `${JSON.stringify(event({ total_tokens: 9, prompt_tokens: 7, output_tokens: 2 }))}\n`);
  assert.equal((await telemetry.refresh()).totals.totalTokens, 9);
});
