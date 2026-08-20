import { readFile } from 'node:fs/promises';

export const AGENT_COLUMNS = [
  'id',
  'display_name',
  'username',
  'api_port',
  'profile_dir',
  'prompt_id',
  'enabled',
];

const AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

function parseBoolean(value, lineNumber) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`agents.tsv line ${lineNumber}: enabled must be true or false`);
}

function parsePort(value, lineNumber) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`agents.tsv line ${lineNumber}: invalid api_port`);
  }
  return port;
}

export function parseAgentsTsv(source) {
  const rows = source
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), lineNumber: index + 1 }))
    .filter(({ text }) => text && !text.startsWith('#'));

  if (rows.length === 0) {
    throw new Error('agents.tsv is empty');
  }

  const header = rows[0].text.split('\t');
  if (header.length !== AGENT_COLUMNS.length ||
      header.some((column, index) => column !== AGENT_COLUMNS[index])) {
    throw new Error(`agents.tsv header must be: ${AGENT_COLUMNS.join('\t')}`);
  }

  const seenIds = new Set();
  const seenPorts = new Set();
  return rows.slice(1).map(({ text, lineNumber }) => {
    const fields = text.split('\t');
    if (fields.length !== AGENT_COLUMNS.length) {
      throw new Error(
        `agents.tsv line ${lineNumber}: expected ${AGENT_COLUMNS.length} tab-separated fields`,
      );
    }

    const [id, displayName, username, rawPort, profileDir, promptId, rawEnabled] = fields;
    if (!AGENT_ID.test(id)) {
      throw new Error(`agents.tsv line ${lineNumber}: invalid agent id`);
    }
    if (!displayName || !username || !profileDir || !promptId) {
      throw new Error(`agents.tsv line ${lineNumber}: required field is blank`);
    }
    const apiPort = parsePort(rawPort, lineNumber);
    if (seenIds.has(id)) {
      throw new Error(`agents.tsv line ${lineNumber}: duplicate agent id ${id}`);
    }
    if (seenPorts.has(apiPort)) {
      throw new Error(`agents.tsv line ${lineNumber}: duplicate api_port ${apiPort}`);
    }
    seenIds.add(id);
    seenPorts.add(apiPort);

    return {
      id,
      displayName,
      username,
      apiPort,
      profileDir,
      promptId,
      enabled: parseBoolean(rawEnabled, lineNumber),
    };
  });
}

export async function loadAgents(filePath) {
  return parseAgentsTsv(await readFile(filePath, 'utf8'));
}
