import { open, stat } from 'node:fs/promises';

const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'prompt_tokens',
  'total_tokens',
];
const READ_CHUNK_BYTES = 1024 * 1024;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function duration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function blankMetrics() {
  return {
    requests: 0,
    meteredRequests: 0,
    unmeteredRequests: 0,
    errors: 0,
    turns: 0,
    durationMs: 0,
    lastActivityAt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
    model: null,
    provider: null,
  };
}

function eventTime(event) {
  const value = Number(event.observed_at_ms);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function applyEvent(metrics, event) {
  const observedAt = eventTime(event);
  if (observedAt && (!metrics.lastActivityAt || observedAt > metrics.lastActivityAt)) {
    metrics.lastActivityAt = observedAt;
  }

  if (event.event === 'api_usage') {
    const requestCount = count(event.request_count) || 1;
    metrics.requests += requestCount;
    if (event.usage_reported === true) metrics.meteredRequests += requestCount;
    else metrics.unmeteredRequests += requestCount;
    metrics.durationMs += duration(event.duration_ms);
    metrics.inputTokens += count(event.input_tokens);
    metrics.outputTokens += count(event.output_tokens);
    metrics.cacheReadTokens += count(event.cache_read_tokens);
    metrics.cacheWriteTokens += count(event.cache_write_tokens);
    metrics.reasoningTokens += count(event.reasoning_tokens);
    metrics.promptTokens += count(event.prompt_tokens);
    metrics.totalTokens += count(event.total_tokens);
    if (typeof event.model === 'string' && event.model) metrics.model = event.model;
    if (typeof event.provider === 'string' && event.provider) metrics.provider = event.provider;
  } else if (event.event === 'api_error') {
    metrics.errors += 1;
  } else if (event.event === 'turn_completed') {
    metrics.turns += 1;
  }
}

function publicMetrics(metrics) {
  const averageDurationMs = metrics.requests > 0
    ? Math.round(metrics.durationMs / metrics.requests)
    : 0;
  const usageCoverage = metrics.requests > 0
    ? metrics.meteredRequests / (metrics.meteredRequests + metrics.unmeteredRequests)
    : 1;
  return {
    requests: metrics.requests,
    meteredRequests: metrics.meteredRequests,
    unmeteredRequests: metrics.unmeteredRequests,
    usageCoverage,
    errors: metrics.errors,
    turns: metrics.turns,
    averageDurationMs,
    lastActivityAt: metrics.lastActivityAt,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    reasoningTokens: metrics.reasoningTokens,
    promptTokens: metrics.promptTokens,
    totalTokens: metrics.totalTokens,
    model: metrics.model,
    provider: metrics.provider,
  };
}

export function parseTelemetryLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || value.schema_version !== 1) return null;
  if (!['api_usage', 'api_error', 'turn_completed'].includes(value.event)) return null;
  if (typeof value.agent_id !== 'string' || !value.agent_id) return null;

  if (value.event === 'api_usage') {
    for (const field of TOKEN_FIELDS) {
      if (value[field] !== undefined && count(value[field]) !== value[field]) return null;
    }
    if (value.request_count !== undefined
      && (!Number.isSafeInteger(value.request_count) || value.request_count < 1)) return null;
  }
  return value;
}

export class TelemetryAccumulator {
  constructor() {
    this.total = blankMetrics();
    this.byAgent = new Map();
    this.invalidLines = 0;
    this.eventsSeen = 0;
  }

  addLine(line) {
    if (!line.trim()) return;
    const event = parseTelemetryLine(line);
    if (!event) {
      this.invalidLines += 1;
      return;
    }
    this.eventsSeen += 1;
    applyEvent(this.total, event);
    const agentMetrics = this.byAgent.get(event.agent_id) ?? blankMetrics();
    applyEvent(agentMetrics, event);
    this.byAgent.set(event.agent_id, agentMetrics);
  }

  snapshot() {
    return {
      totals: publicMetrics(this.total),
      byAgent: Object.fromEntries(
        [...this.byAgent.entries()].map(([agentId, metrics]) => [agentId, publicMetrics(metrics)]),
      ),
      eventsSeen: this.eventsSeen,
      invalidLines: this.invalidLines,
    };
  }
}

export class TelemetryFile {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.inode = null;
    this.partial = '';
    this.accumulator = new TelemetryAccumulator();
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
      this.accumulator = new TelemetryAccumulator();
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
