const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const relative = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

const byId = (id) => document.getElementById(id);

function tokenText(value) {
  const safe = Number.isFinite(value) ? value : 0;
  return { short: compact.format(safe), full: number.format(safe) };
}

function setToken(id, value) {
  const element = byId(id);
  const text = tokenText(value);
  element.textContent = text.short;
  element.title = text.full;
}

function setCount(id, value) {
  const element = byId(id);
  element.textContent = number.format(Number.isFinite(value) ? value : 0);
}

function relativeTime(timestamp) {
  if (!timestamp) return '—';
  const value = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(value)) return '—';
  const seconds = Math.round((value - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return relative.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

function gibibytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const value = bytes / (1024 ** 3);
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: value < 10 ? 2 : 1,
  })} GiB`;
}

function utilizationPercent(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

function sparkStatus(value) {
  return ['ok', 'stale', 'unavailable'].includes(value) ? value : 'unavailable';
}

function sparkStatusLabel(status) {
  if (status === 'ok') return 'Live';
  if (status === 'stale') return 'Stale';
  return 'Unavailable';
}

function sparkDetail(label, value) {
  const detail = document.createElement('div');
  detail.className = 'spark-detail';
  const key = document.createElement('span');
  key.textContent = label;
  const metric = document.createElement('strong');
  metric.textContent = value;
  detail.append(key, metric);
  return detail;
}

function renderSpark(spark) {
  const status = sparkStatus(spark?.status);
  const memory = spark?.memory ?? {};
  const swap = spark?.swap ?? {};
  const percent = utilizationPercent(memory.utilizationPercent);
  const hasMemory = percent !== null
    && Number.isFinite(memory.usedBytes)
    && Number.isFinite(memory.totalBytes);

  const card = document.createElement('article');
  card.className = `spark-card spark-card-${status}`;

  const header = document.createElement('div');
  header.className = 'spark-card-header';
  const identity = document.createElement('div');
  identity.className = 'spark-identity';
  const name = document.createElement('h3');
  name.textContent = spark?.displayName || spark?.id || 'Spark';
  const description = document.createElement('span');
  description.textContent = 'GB10 unified memory';
  identity.append(name, description);

  const statusElement = document.createElement('span');
  statusElement.className = `spark-status spark-status-${status}`;
  statusElement.textContent = sparkStatusLabel(status);
  header.append(identity, statusElement);

  const usage = document.createElement('div');
  usage.className = 'spark-usage';
  const utilization = document.createElement('strong');
  utilization.textContent = hasMemory ? `${Math.round(percent)}%` : '—';
  const usageCopy = document.createElement('span');
  usageCopy.textContent = hasMemory
    ? `${gibibytes(memory.usedBytes)} used of ${gibibytes(memory.totalBytes)}`
    : 'Memory sample unavailable';
  usage.append(utilization, usageCopy);

  const meter = document.createElement('div');
  meter.className = 'spark-meter';
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-label', `${name.textContent} memory utilization`);
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  if (hasMemory) meter.setAttribute('aria-valuenow', String(Math.round(percent)));
  const meterFill = document.createElement('span');
  meterFill.style.width = hasMemory ? `${percent}%` : '0%';
  if (percent !== null && percent >= 90) meter.dataset.pressure = 'critical';
  else if (percent !== null && percent >= 75) meter.dataset.pressure = 'warning';
  meter.append(meterFill);

  const details = document.createElement('div');
  details.className = 'spark-details';
  const swapValue = Number.isFinite(swap.usedBytes) && Number.isFinite(swap.totalBytes)
    ? `${gibibytes(swap.usedBytes)} / ${gibibytes(swap.totalBytes)}`
    : '—';
  details.append(
    sparkDetail('Available', gibibytes(memory.availableBytes)),
    sparkDetail('Swap', swapValue),
  );

  const freshness = document.createElement('p');
  freshness.className = 'spark-freshness';
  const sampled = relativeTime(spark?.sampledAt);
  freshness.textContent = sampled === '—'
    ? 'No successful sample yet'
    : `${status === 'ok' ? 'Sampled' : 'Last sample'} ${sampled}`;

  card.append(header, usage, meter, details, freshness);
  return card;
}

function renderSparks(sparks) {
  const cards = byId('spark-cards');
  if (!Array.isArray(sparks) || sparks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spark-empty';
    empty.textContent = 'Spark memory telemetry is unavailable.';
    cards.replaceChildren(empty);
    return;
  }
  cards.replaceChildren(...sparks.map(renderSpark));
}

const failureKindLabels = {
  saturation: 'saturation',
  timeout: 'timeout',
  http_error: 'HTTP',
  schema_mismatch: 'schema',
  output_mismatch: 'output',
  parity_mismatch: 'parity',
  request_failed: 'other',
};

function failureBreakdown(counts) {
  const entries = Object.entries(failureKindLabels)
    .map(([kind, label]) => [label, counts?.[kind] ?? 0])
    .filter(([, count]) => Number.isSafeInteger(count) && count > 0);
  return entries.map(([label, count]) => `${number.format(count)} ${label}`).join(' · ');
}

function renderEndpointHealth(health) {
  const metrics = health?.overall ?? {};
  const routes = Array.isArray(health?.routes) ? health.routes : [];
  const indicator = byId('endpoint-indicator');
  const allHealthy = routes.length > 0 && routes.every((route) => route.lastSuccess);
  indicator.className = `live-indicator ${allHealthy ? 'live' : routes.length ? 'stale' : ''}`;
  byId('endpoint-counts').textContent = routes.length
    ? `Past 24h · ${number.format(metrics.healthyRoutes ?? 0)} / ${number.format(metrics.routeCount ?? 0)} passing · ${number.format(metrics.successes ?? 0)} successes · ${number.format(metrics.failures ?? 0)} failures · ${number.format(metrics.totalTokens ?? 0)} tokens`
    : 'No endpoint sweep recorded in the past 24 hours';
  const failures = failureBreakdown(metrics.failureCounts);
  byId('endpoint-failure-breakdown').textContent = failures
    ? `Failure causes (24h) · ${failures}`
    : 'No failures in the past 24 hours';
  byId('endpoint-freshness').textContent = metrics.lastCheckedAt
    ? `Last sweep ${relativeTime(metrics.lastCheckedAt)}`
    : 'Scheduled every 15 minutes';

  const rows = routes.map((route) => {
    const row = document.createElement('tr');
    const status = statePill(route.lastSuccess ? 'online' : 'offline');
    status.textContent = route.lastSuccess ? 'passing' : 'failing';
    const rate = `${Math.round((route.successRate ?? 0) * 100)}%`;
    const latency = Number.isFinite(route.lastLatencyMs)
      ? `${number.format(route.lastLatencyMs)} ms`
      : '—';
    const endpoint = document.createElement('code');
    endpoint.textContent = route.endpoint;
    endpoint.title = route.model ?? '';
    const failureSummary = failureBreakdown(route.failureCounts);
    const lastFailure = route.lastFailureReasonCode
      ? `${route.lastFailureKind} (${route.lastFailureReasonCode})`
      : route.lastFailureKind;
    const validation = failureSummary
      ? `${failureSummary}${lastFailure ? ` · last ${lastFailure}` : ''}`
      : route.lastParity
        ?? (route.lastSchemaOk === true ? 'schema ok' : route.lastSchemaOk === false ? 'schema mismatch' : '—');
    row.append(
      cell(endpoint, 'endpoint-cell'),
      cell(route.mode),
      cell(status),
      cell(number.format(route.successes ?? 0), 'number'),
      cell(number.format(route.failures ?? 0), 'number'),
      cell(rate, 'number'),
      cell(latency, 'number'),
      cell(route.lastHttpStatus === null ? '—' : String(route.lastHttpStatus), 'number'),
      cell(validation),
      cell(number.format(route.totalTokens ?? 0), 'number'),
      cell(relativeTime(route.lastCheckedAt), 'activity-cell'),
    );
    return row;
  });
  if (rows.length === 0) {
    const row = document.createElement('tr');
    const empty = cell('No scheduled or on-demand endpoint sweep was recorded in the past 24 hours.');
    empty.colSpan = 11;
    row.append(empty);
    rows.push(row);
  }
  byId('endpoint-rows').replaceChildren(...rows);
}

function statePill(value) {
  const pill = document.createElement('span');
  pill.className = `pill pill-${value}`;
  pill.textContent = value;
  return pill;
}

function booleanStatus(value, positiveLabel, negativeLabel) {
  const container = document.createElement('span');
  container.className = value ? 'boolean boolean-on' : 'boolean boolean-off';
  const dot = document.createElement('span');
  dot.className = 'boolean-dot';
  dot.setAttribute('aria-hidden', 'true');
  container.append(dot, document.createTextNode(value ? positiveLabel : negativeLabel));
  return container;
}

function workerStatus(supervisorRunning, worker) {
  if (!worker) return booleanStatus(supervisorRunning, 'supervisor', 'stopped');
  const healthy = supervisorRunning && (worker.childRunning || worker.state === 'waiting');
  const container = document.createElement('span');
  container.className = healthy ? 'boolean boolean-on' : 'boolean boolean-off';
  const dot = document.createElement('span');
  dot.className = 'boolean-dot';
  dot.setAttribute('aria-hidden', 'true');
  const restartLabel = `${worker.restartCount} restart${worker.restartCount === 1 ? '' : 's'}`;
  const parts = [worker.state.replace('_', ' '), restartLabel];
  if (worker.lastExitCode !== null && worker.lastExitCode !== 0) parts.push(`exit ${worker.lastExitCode}`);
  if (worker.stale) parts.push('stale');
  container.append(dot, document.createTextNode(parts.join(' · ')));
  return container;
}

function cell(content, className = '') {
  const element = document.createElement('td');
  element.className = className;
  if (content instanceof Node) element.append(content);
  else element.textContent = content;
  return element;
}

function renderAgent(agent) {
  const metrics = agent.metrics ?? {};
  const isSocial = agent.workload === 'social';
  const row = document.createElement('tr');
  row.dataset.state = agent.state;

  const identity = document.createElement('div');
  identity.className = 'agent-identity';
  const name = document.createElement('strong');
  name.textContent = agent.displayName;
  const detail = document.createElement('span');
  detail.textContent = isSocial ? `${agent.id} · social` : `${agent.id} · :${agent.apiPort}`;
  identity.append(name, detail);

  const tokens = tokenText(metrics.totalTokens ?? 0);
  const tokenElement = document.createElement('span');
  tokenElement.className = 'token-cell';
  tokenElement.textContent = tokens.short;
  tokenElement.title = `${tokens.full} total tokens`;

  const game = agent.game;
  const position = game?.position;
  const vitals = game
    ? `♥ ${game.health ?? '—'}  ◆ ${game.food ?? '—'} · ${position?.x ?? '—'}, ${position?.y ?? '—'}, ${position?.z ?? '—'}`
    : '—';
  const task = agent.task?.action
    ? `${agent.task.action} · ${agent.task.status ?? 'unknown'}${agent.task.elapsedSeconds !== null ? ` · ${agent.task.elapsedSeconds}s` : ''}`
    : isSocial ? 'social automation' : 'idle';

  row.append(
    cell(identity),
    cell(statePill(agent.state)),
    cell(isSocial
      ? booleanStatus(agent.daemonRunning, 'daemon', 'stopped')
      : workerStatus(agent.brainRunning, agent.workers?.brain)),
    cell(isSocial ? '—' : workerStatus(agent.bodyRunning, agent.workers?.body)),
    cell(isSocial
      ? 'not applicable'
      : booleanStatus(agent.minecraftConnected, 'connected', agent.apiReachable ? 'disconnected' : 'offline')),
    cell(isSocial ? '—' : vitals, 'vitals-cell'),
    cell(task, 'task-cell'),
    cell(metrics.model ?? '—', 'model-cell'),
    cell(number.format(metrics.requests ?? 0), 'number'),
    cell(tokenElement, 'number'),
    cell(relativeTime(metrics.lastActivityAt), 'activity-cell'),
  );
  return row;
}

function renderSummary(snapshot) {
  const metrics = snapshot.overall;
  setToken('total-tokens', metrics.totalTokens);
  setToken('prompt-tokens', metrics.promptTokens);
  setToken('output-tokens', metrics.outputTokens);
  setToken('cache-read-tokens', metrics.cacheReadTokens);
  setCount('requests', metrics.requests);
  setCount('turns', metrics.turns);
  byId('reasoning-tokens').textContent = `${number.format(metrics.reasoningTokens)} reasoning`;
  byId('cache-write-tokens').textContent = `${number.format(metrics.cacheWriteTokens)} cache write`;
  byId('average-duration').textContent = `${number.format(metrics.averageDurationMs)} ms average`;
  byId('errors').textContent = `${number.format(metrics.errors)} request errors`;

  const coveragePercent = Math.round(metrics.usageCoverage * 100);
  byId('usage-coverage').textContent = metrics.requests
    ? `${coveragePercent}% usage reporting coverage`
    : 'No requests yet';

  renderSparks(snapshot.sparks);
  renderEndpointHealth(snapshot.endpointHealth);

  const rows = byId('agent-rows');
  rows.replaceChildren(...snapshot.agents.map(renderAgent));
  const online = snapshot.agents.filter((agent) => agent.state === 'online').length;
  const enabled = snapshot.agents.filter((agent) => agent.enabled).length;
  const restarts = snapshot.agents.reduce((sum, agent) => (
    sum + (agent.workers?.brain?.restartCount ?? 0) + (agent.workers?.body?.restartCount ?? 0)
  ), 0);
  byId('fleet-counts').textContent = `${online} online / ${enabled} enabled · ${restarts} restarts`;
  const serverUp = snapshot.minecraftServer?.reachable === true;
  const serverSession = snapshot.minecraftServer?.sessionRunning === true;
  byId('server-indicator').className = `live-indicator ${serverUp ? 'live' : serverSession ? '' : 'stale'}`;
  byId('server-status').textContent = `Minecraft :${snapshot.minecraftServer?.port ?? '—'} ${serverUp ? 'reachable' : 'offline'} · tmux ${serverSession ? 'running' : 'stopped'}`;
  byId('telemetry-health').textContent = snapshot.telemetry.invalidLines
    ? `${snapshot.telemetry.invalidLines} malformed telemetry lines ignored`
    : `${number.format(snapshot.telemetry.eventsSeen)} telemetry events`;
}

let refreshInFlight = false;

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!response.ok) throw new Error(`snapshot returned ${response.status}`);
    const snapshot = await response.json();
    renderSummary(snapshot);
    byId('live-indicator').className = 'live-indicator live';
    byId('refresh-status').textContent = `Live · ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
  } catch {
    byId('live-indicator').className = 'live-indicator stale';
    byId('refresh-status').textContent = 'Telemetry unavailable';
  } finally {
    refreshInFlight = false;
  }
}

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 2_000);
