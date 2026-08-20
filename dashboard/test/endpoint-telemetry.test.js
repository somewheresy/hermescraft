import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EndpointTelemetryAccumulator,
  EndpointTelemetryFile,
  parseEndpointTelemetryLine,
} from '../lib/endpoint-telemetry.js';

function event(overrides = {}) {
  return {
    schema_version: 1,
    event: 'endpoint_check',
    observed_at_ms: 1_000,
    endpoint: '/v1/responses',
    mode: 'nonstream',
    success: true,
    http_status: 200,
    latency_ms: 250,
    ttft_ms: 100,
    prompt_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    schema_ok: true,
    parity: 'golden',
    failure_kind: null,
    failure_reason_code: null,
    failure_confidence: null,
    model: 'qwen',
    ...overrides,
  };
}

test('accepts only content-free allowlisted inference checks', () => {
  assert.equal(parseEndpointTelemetryLine(JSON.stringify(event())).endpoint, '/v1/responses');
  for (const invalid of [
    event({ endpoint: '/v1/models/load' }),
    event({ endpoint: '/v1/unknown' }),
    event({ mode: 'post' }),
    event({ endpoint: '/v1/responses/compact', mode: 'stream' }),
    event({ latency_ms: -1 }),
    event({ success: 'yes' }),
  ]) {
    assert.equal(parseEndpointTelemetryLine(JSON.stringify(invalid)), null);
  }

  const parsed = parseEndpointTelemetryLine(JSON.stringify(event({
    response_text: 'private response',
    authorization: 'private credential',
    failure_reason_code: 'private_backend_code',
  })));
  assert.doesNotMatch(
    JSON.stringify(parsed),
    /private response|private credential|private_backend_code/,
  );
});

test('aggregates successes, failures, recovery, latency, and token use by route', () => {
  const accumulator = new EndpointTelemetryAccumulator();
  accumulator.addLine(JSON.stringify(event()));
  accumulator.addLine(JSON.stringify(event({
    observed_at_ms: 2_000,
    mode: 'stream',
    success: false,
    http_status: 503,
    latency_ms: 500,
    schema_ok: null,
    parity: 'fail',
    failure_kind: 'http_error',
  })));
  accumulator.addLine(JSON.stringify(event({
    observed_at_ms: 3_000,
    mode: 'stream',
    latency_ms: 300,
  })));

  const snapshot = accumulator.snapshot();
  assert.deepEqual(snapshot.overall, {
    checks: 3,
    successes: 2,
    failures: 1,
    failureCounts: {
      saturation: 0,
      timeout: 0,
      http_error: 1,
      schema_mismatch: 0,
      output_mismatch: 0,
      parity_mismatch: 0,
      request_failed: 0,
    },
    successRate: 2 / 3,
    routeCount: 2,
    healthyRoutes: 2,
    totalTokens: 36,
    lastCheckedAt: 3_000,
  });
  assert.equal(snapshot.routes[1].checks, 2);
  assert.equal(snapshot.routes[1].failures, 1);
  assert.equal(snapshot.routes[1].consecutiveFailures, 0);
  assert.equal(snapshot.routes[1].averageLatencyMs, 400);
  assert.equal(snapshot.routes[1].lastSuccess, true);
  assert.equal(snapshot.routes[1].lastFailureKind, 'http_error');
  assert.equal(snapshot.routes[1].lastFailureAt, 2_000);
});

test('classifies direct saturation and keeps timeout, schema, output, and parity distinct', () => {
  const accumulator = new EndpointTelemetryAccumulator();
  const failures = [
    event({
      observed_at_ms: 1_000,
      success: false,
      http_status: 503,
      schema_ok: null,
      failure_kind: 'saturation',
      failure_reason_code: 'queue_timeout',
      failure_confidence: 'direct',
    }),
    event({
      observed_at_ms: 2_000,
      success: false,
      http_status: null,
      latency_ms: 120_400,
      schema_ok: null,
      failure_kind: 'timeout',
      failure_reason_code: 'client_timeout',
    }),
    event({
      observed_at_ms: 3_000,
      success: false,
      schema_ok: false,
      failure_kind: 'schema_mismatch',
    }),
    event({
      observed_at_ms: 4_000,
      success: false,
      failure_kind: 'output_mismatch',
    }),
    event({
      observed_at_ms: 5_000,
      success: false,
      failure_kind: 'parity_mismatch',
    }),
    event({
      observed_at_ms: 6_000,
      success: false,
      failure_kind: 'request_failed',
    }),
  ];
  for (const failure of failures) accumulator.addLine(JSON.stringify(failure));

  const snapshot = accumulator.snapshot();
  assert.deepEqual(snapshot.overall.failureCounts, {
    saturation: 1,
    timeout: 1,
    http_error: 0,
    schema_mismatch: 1,
    output_mismatch: 1,
    parity_mismatch: 1,
    request_failed: 1,
  });
  assert.equal(snapshot.routes[0].lastFailureKind, 'request_failed');
  assert.equal(snapshot.routes[0].failureCounts.saturation, 1);
});

test('requires an allowlisted direct queue reason before accepting saturation', () => {
  const missingReason = parseEndpointTelemetryLine(JSON.stringify(event({
    success: false,
    failure_kind: 'saturation',
    failure_confidence: 'direct',
  })));
  const unknownReason = parseEndpointTelemetryLine(JSON.stringify(event({
    success: false,
    failure_kind: 'saturation',
    failure_reason_code: 'private_vendor_reason',
    failure_confidence: 'direct',
  })));

  assert.equal(missingReason.failureKind, 'request_failed');
  assert.equal(missingReason.failureConfidence, null);
  assert.equal(unknownReason.failureKind, 'request_failed');
  assert.equal(unknownReason.failureReasonCode, null);
});

test('projects timeout-shaped legacy parity failures without rewriting real mismatches', () => {
  const legacyTimeout = parseEndpointTelemetryLine(JSON.stringify(event({
    success: false,
    http_status: null,
    latency_ms: 120_136,
    schema_ok: null,
    parity: 'golden_fail',
    failure_kind: 'parity_failure',
  })));
  const legacyParity = parseEndpointTelemetryLine(JSON.stringify(event({
    success: false,
    http_status: 200,
    latency_ms: 5_000,
    parity: 'mismatch',
    failure_kind: 'parity_failure',
  })));
  const legacyHttp = parseEndpointTelemetryLine(JSON.stringify(event({
    success: false,
    http_status: 502,
    latency_ms: 402,
    schema_ok: null,
    parity: 'golden_fail',
    failure_kind: 'parity_failure',
  })));
  const legacyUnknown = parseEndpointTelemetryLine(JSON.stringify(event({
    success: false,
    http_status: 200,
    latency_ms: 402,
    schema_ok: null,
    parity: 'golden_fail',
    failure_kind: 'parity_failure',
  })));

  assert.equal(legacyTimeout.failureKind, 'timeout');
  assert.equal(legacyParity.failureKind, 'parity_mismatch');
  assert.equal(legacyHttp.failureKind, 'http_error');
  assert.equal(legacyUnknown.failureKind, 'request_failed');
});

test('unknown failure kinds stay visible as request failures', () => {
  const parsed = parseEndpointTelemetryLine(JSON.stringify(event({
    success: false,
    failure_kind: 'new_private_failure',
  })));

  assert.equal(parsed.failureKind, 'request_failed');
});

test('tails appended endpoint telemetry and resets after truncation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-endpoints-'));
  const file = path.join(root, 'events.jsonl');
  await writeFile(file, `${JSON.stringify(event())}\n`);
  const telemetry = new EndpointTelemetryFile(file);
  assert.equal((await telemetry.refresh()).overall.checks, 1);

  await appendFile(file, `${JSON.stringify(event({ observed_at_ms: 2_000 }))}\n`);
  assert.equal((await telemetry.refresh()).overall.checks, 2);

  await writeFile(file, `${JSON.stringify(event({ observed_at_ms: 3_000, mode: 'stream' }))}\n`);
  const snapshot = await telemetry.refresh();
  assert.equal(snapshot.overall.checks, 1);
  assert.equal(snapshot.routes[0].mode, 'stream');
});
