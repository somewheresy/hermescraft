import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAgentsTsv } from '../lib/config.js';

const HEADER = 'id\tdisplay_name\tusername\tapi_port\tprofile_dir\tprompt_id\tenabled';

test('parses the canonical TSV while ignoring comments and blank lines', () => {
  const agents = parseAgentsTsv(`${HEADER}\n# fleet\n\neddie\tEddie Platinum\tEddiePlatinum\t3002\truntime/profiles/eddie\tlead\ttrue\n`);
  assert.deepEqual(agents, [{
    id: 'eddie',
    displayName: 'Eddie Platinum',
    username: 'EddiePlatinum',
    apiPort: 3002,
    profileDir: 'runtime/profiles/eddie',
    promptId: 'lead',
    enabled: true,
  }]);
});

test('rejects a changed header instead of silently mis-mapping fields', () => {
  assert.throws(
    () => parseAgentsTsv('id\tdisplay_name\tapi_port\neddie\tEddie\t3002\n'),
    /header must be/,
  );
});

test('rejects duplicate ids and ports', () => {
  assert.throws(
    () => parseAgentsTsv(`${HEADER}\na\tA\tA\t3002\ta\tlead\ttrue\na\tB\tB\t3003\tb\tlead\ttrue\n`),
    /duplicate agent id/,
  );
  assert.throws(
    () => parseAgentsTsv(`${HEADER}\na\tA\tA\t3002\ta\tlead\ttrue\nb\tB\tB\t3002\tb\tlead\ttrue\n`),
    /duplicate api_port/,
  );
});

test('rejects invalid enabled values and ports', () => {
  assert.throws(
    () => parseAgentsTsv(`${HEADER}\na\tA\tA\t0\ta\tlead\ttrue\n`),
    /invalid api_port/,
  );
  assert.throws(
    () => parseAgentsTsv(`${HEADER}\na\tA\tA\t3002\ta\tlead\tyes\n`),
    /enabled must be true or false/,
  );
});
