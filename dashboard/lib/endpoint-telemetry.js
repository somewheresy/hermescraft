import { open, stat } from 'node:fs/promises';

export const ALLOWED_INFERENCE_ENDPOINTS = Object.freeze([
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/messages',
  '/v1/responses/compact',
]);

const ALLOWED_ENDPOINT_SET = new Set(ALLOWED_INFERENCE_ENDPOINTS);
const ALLOWED_MODES = new Set(['nonstream', 'stream']);
export const FAILURE_KINDS = Object.freeze([
  'saturation',
  'timeout',
  'http_error',
  'schema_mismatch',
  'output_mismatch',
  'parity_mismatch',
  'request_failed',
]);
const FAILURE_KIND_SET = new Set(FAILURE_KINDS);
const SATURATION_REASON_CODES = new Set([
  'capacity_exhausted',
  'node_saturated',
  'all_nodes_saturated',
  'overloaded',
  'queue_full',
  'queue_timeout',
  'server_overloaded',
]);
const ALLOWED_FAILURE_REASON_CODES = new Set([
  ...SATURATION_REASON_CODES,
  'client_timeout',
  'internal_error',
  'invalid_request',
  'rate_limit_exceeded',
  'request_cancelled',
  'upstream_timeout',
]);
const LEGACY_TIMEOUT_MIN_MS = 120_000;
const LEGACY_TIMEOUT_MAX_MS = 125_000;
const READ_CHUNK_BYTES = 256 * 1024;
export const ENDPOINT_WINDOW_MS = 24 * 60 * 60 * 1_000;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function safeText(value, limit = 160) {
  if (typeof value !== 'string' || !value) return null;
  const cleaned = [...value].filter((character) => character >= ' ' && character !== '\u007f')
    .join('').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function blankFailureCounts() {
  return Object.fromEntries(FAILURE_KINDS.map((kind) => [kind, 0]));
}

function normalizeFailureKind({
  success,
  rawFailureKind,
  failureReasonCode,
  httpStatus,
  latencyMs,
  parity,
}) {
  if (success) return null;
  if (rawFailureKind === 'saturation') {
    return SATURATION_REASON_CODES.has(failureReasonCode) ? 'saturation' : 'request_failed';
  }
  if (rawFailureKind === 'parity_failure') {
    const timeoutShaped = httpStatus === null
      && latencyMs !== null
      && latencyMs >= LEGACY_TIMEOUT_MIN_MS
      && latencyMs <= LEGACY_TIMEOUT_MAX_MS;
    if (timeoutShaped) return 'timeout';
    if (httpStatus !== null && httpStatus >= 400) return 'http_error';
    return parity === 'mismatch' ? 'parity_mismatch' : 'request_failed';
  }
  return FAILURE_KIND_SET.has(rawFailureKind) ? rawFailureKind : 'request_failed';
}

function isReasoningVarianceFalsePositive({
  success,
  rawFailureKind,
  rawFailureReasonCode,
  httpStatus,
  schemaOk,
  smokeExpectation,
  parity,
}) {
  return !success
    && ['parity_failure', 'parity_mismatch'].includes(rawFailureKind)
    && rawFailureReasonCode === null
    && httpStatus === 200
    && schemaOk === true
    && smokeExpectation === 'match'
    && parity === 'mismatch';
}

export function parseEndpointTelemetryLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || value.schema_version !== 1) return null;
  if (value.event !== 'endpoint_check' || !ALLOWED_ENDPOINT_SET.has(value.endpoint)) return null;
  if (!ALLOWED_MODES.has(value.mode)) return null;
  if (value.endpoint === '/v1/responses/compact' && value.mode !== 'nonstream') return null;
  if (typeof value.success !== 'boolean') return null;
  const observedAt = timestamp(value.observed_at_ms);
  if (observedAt === null) return null;

  const numericFields = ['latency_ms', 'ttft_ms', 'prompt_tokens', 'output_tokens', 'total_tokens'];
  for (const field of numericFields) {
    if (value[field] !== undefined && value[field] !== null && count(value[field]) === null) return null;
  }
  const httpStatus = value.http_status === null || value.http_status === undefined
    ? null
    : count(value.http_status);
  if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599)) return null;
  if (value.schema_ok !== null && value.schema_ok !== undefined && typeof value.schema_ok !== 'boolean') return null;

  const rawSuccess = value.success;
  const rawFailureKind = safeText(value.failure_kind, 64);
  const candidateReasonCode = safeText(value.failure_reason_code, 64);
  const latencyMs = count(value.latency_ms);
  const rawParity = safeText(value.parity, 64);
  const schemaOk = typeof value.schema_ok === 'boolean' ? value.schema_ok : null;
  const smokeExpectation = safeText(value.smoke_expectation, 64);
  const projectedReasoningVariance = isReasoningVarianceFalsePositive({
    success: rawSuccess,
    rawFailureKind,
    rawFailureReasonCode: candidateReasonCode,
    httpStatus,
    schemaOk,
    smokeExpectation,
    parity: rawParity,
  });
  const success = rawSuccess || projectedReasoningVariance;
  const failureReasonCode = !success && ALLOWED_FAILURE_REASON_CODES.has(candidateReasonCode)
    ? candidateReasonCode
    : null;
  const parity = projectedReasoningVariance ? 'match_visible_only' : rawParity;
  const failureKind = normalizeFailureKind({
    success,
    rawFailureKind,
    failureReasonCode,
    httpStatus,
    latencyMs,
    parity,
  });
  const failureConfidence = failureKind === 'saturation'
    && value.failure_confidence === 'direct'
    ? 'direct'
    : null;

  return {
    endpoint: value.endpoint,
    mode: value.mode,
    success,
    observedAt,
    httpStatus,
    latencyMs,
    ttftMs: count(value.ttft_ms),
    promptTokens: count(value.prompt_tokens),
    outputTokens: count(value.output_tokens),
    totalTokens: count(value.total_tokens),
    schemaOk,
    parity,
    reasoningVariance: value.reasoning_variance === true || projectedReasoningVariance,
    failureKind,
    failureReasonCode,
    failureConfidence,
    model: safeText(value.model),
  };
}

function blankRoute(event) {
  return {
    endpoint: event.endpoint,
    mode: event.mode,
    checks: 0,
    successes: 0,
    failures: 0,
    failureCounts: blankFailureCounts(),
    consecutiveFailures: 0,
    latencyTotalMs: 0,
    latencySamples: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    lastSuccess: false,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastHttpStatus: null,
    lastLatencyMs: null,
    lastTtftMs: null,
    lastSchemaOk: null,
    lastParity: null,
    lastFailureKind: null,
    lastFailureReasonCode: null,
    lastFailureConfidence: null,
    lastFailureAt: null,
    model: null,
  };
}

function applyEvent(route, event) {
  route.checks += 1;
  if (event.success) {
    route.successes += 1;
    route.consecutiveFailures = 0;
    route.lastSuccessAt = event.observedAt;
  } else {
    route.failures += 1;
    route.consecutiveFailures += 1;
    route.failureCounts[event.failureKind] += 1;
    route.lastFailureKind = event.failureKind;
    route.lastFailureReasonCode = event.failureReasonCode;
    route.lastFailureConfidence = event.failureConfidence;
    route.lastFailureAt = event.observedAt;
  }
  if (event.latencyMs !== null) {
    route.latencyTotalMs += event.latencyMs;
    route.latencySamples += 1;
  }
  route.promptTokens += event.promptTokens ?? 0;
  route.outputTokens += event.outputTokens ?? 0;
  route.totalTokens += event.totalTokens ?? 0;
  route.lastSuccess = event.success;
  route.lastCheckedAt = event.observedAt;
  route.lastHttpStatus = event.httpStatus;
  route.lastLatencyMs = event.latencyMs;
  route.lastTtftMs = event.ttftMs;
  route.lastSchemaOk = event.schemaOk;
  route.lastParity = event.parity;
  if (event.model) route.model = event.model;
}

function publicRoute(route) {
  return {
    endpoint: route.endpoint,
    mode: route.mode,
    checks: route.checks,
    successes: route.successes,
    failures: route.failures,
    failureCounts: { ...route.failureCounts },
    successRate: route.checks ? route.successes / route.checks : 0,
    consecutiveFailures: route.consecutiveFailures,
    averageLatencyMs: route.latencySamples
      ? Math.round(route.latencyTotalMs / route.latencySamples)
      : null,
    promptTokens: route.promptTokens,
    outputTokens: route.outputTokens,
    totalTokens: route.totalTokens,
    lastSuccess: route.lastSuccess,
    lastCheckedAt: route.lastCheckedAt,
    lastSuccessAt: route.lastSuccessAt,
    lastHttpStatus: route.lastHttpStatus,
    lastLatencyMs: route.lastLatencyMs,
    lastTtftMs: route.lastTtftMs,
    lastSchemaOk: route.lastSchemaOk,
    lastParity: route.lastParity,
    lastFailureKind: route.lastFailureKind,
    lastFailureReasonCode: route.lastFailureReasonCode,
    lastFailureConfidence: route.lastFailureConfidence,
    lastFailureAt: route.lastFailureAt,
    model: route.model,
  };
}

function routeOrder(route) {
  const endpoint = ALLOWED_INFERENCE_ENDPOINTS.indexOf(route.endpoint);
  return endpoint * 2 + (route.mode === 'stream' ? 1 : 0);
}

export class EndpointTelemetryAccumulator {
  constructor({ clock = Date.now, windowMs = ENDPOINT_WINDOW_MS } = {}) {
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new TypeError('windowMs must be a positive safe integer');
    }
    this.clock = clock;
    this.windowMs = windowMs;
    this.events = [];
    this.eventsSeen = 0;
    this.invalidLines = 0;
  }

  addLine(line) {
    if (!line.trim()) return;
    const event = parseEndpointTelemetryLine(line);
    if (!event) {
      this.invalidLines += 1;
      return;
    }
    this.eventsSeen += 1;
    this.events.push(event);
  }

  snapshot() {
    const windowEndAt = this.clock();
    if (timestamp(windowEndAt) === null) throw new TypeError('clock returned an invalid timestamp');
    const windowStartAt = windowEndAt - this.windowMs;
    this.events = this.events.filter((event) => event.observedAt >= windowStartAt);
    const windowEvents = this.events
      .filter((event) => event.observedAt <= windowEndAt)
      .sort((left, right) => left.observedAt - right.observedAt);
    const routesByKey = new Map();
    for (const event of windowEvents) {
      const key = `${event.endpoint}\u0000${event.mode}`;
      const route = routesByKey.get(key) ?? blankRoute(event);
      applyEvent(route, event);
      routesByKey.set(key, route);
    }
    const routes = [...routesByKey.values()].map(publicRoute)
      .sort((left, right) => routeOrder(left) - routeOrder(right));
    const checks = routes.reduce((sum, route) => sum + route.checks, 0);
    const successes = routes.reduce((sum, route) => sum + route.successes, 0);
    const failures = routes.reduce((sum, route) => sum + route.failures, 0);
    const failureCounts = blankFailureCounts();
    for (const route of routes) {
      for (const kind of FAILURE_KINDS) failureCounts[kind] += route.failureCounts[kind];
    }
    return {
      overall: {
        checks,
        successes,
        failures,
        failureCounts,
        successRate: checks ? successes / checks : 0,
        routeCount: routes.length,
        healthyRoutes: routes.filter((route) => route.lastSuccess).length,
        totalTokens: routes.reduce((sum, route) => sum + route.totalTokens, 0),
        lastCheckedAt: routes.reduce((latest, route) => (
          !latest || route.lastCheckedAt > latest ? route.lastCheckedAt : latest
        ), null),
      },
      routes,
      windowMs: this.windowMs,
      windowStartAt,
      windowEndAt,
      eventsSeen: this.eventsSeen,
      invalidLines: this.invalidLines,
    };
  }
}

export class EndpointTelemetryFile {
  constructor(filePath, accumulatorOptions = {}) {
    this.filePath = filePath;
    this.accumulatorOptions = { ...accumulatorOptions };
    this.offset = 0;
    this.inode = null;
    this.partial = '';
    this.accumulator = new EndpointTelemetryAccumulator(this.accumulatorOptions);
    this.readPromise = null;
  }

  async refresh() {
    if (!this.readPromise) {
      this.readPromise = this.#refresh().finally(() => {
        this.readPromise = null;
      });
    }
    await this.readPromise;
    return this.accumulator.snapshot();
  }

  async #refresh() {
    let metadata;
    try {
      metadata = await stat(this.filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (this.inode !== null && (metadata.ino !== this.inode || metadata.size < this.offset)) {
      this.offset = 0;
      this.partial = '';
      this.accumulator = new EndpointTelemetryAccumulator(this.accumulatorOptions);
    }
    this.inode = metadata.ino;
    if (metadata.size === this.offset) return;

    const handle = await open(this.filePath, 'r');
    try {
      let remaining = metadata.size - this.offset;
      while (remaining > 0) {
        const length = Math.min(remaining, READ_CHUNK_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        remaining -= bytesRead;
        const lines = (this.partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
        this.partial = lines.pop() ?? '';
        for (const line of lines) this.accumulator.addLine(line);
      }
    } finally {
      await handle.close();
    }
  }
}
