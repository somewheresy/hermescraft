import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createSocialAgentInspector,
  processIsSocialDaemon,
  readSocialPid,
} from '../lib/social-agent.js';

test('reads only a valid non-system PID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermescraft-social-pid-'));
  const pidFile = path.join(root, 'eddie.pid');

  await writeFile(pidFile, '74789\n');
  assert.equal(await readSocialPid(pidFile), 74789);
  for (const invalid of ['', '1', '-2', '12x', '9007199254740992']) {
    await writeFile(pidFile, invalid);
    assert.equal(await readSocialPid(pidFile), null);
  }
});

test('recognizes only the expected Social daemon command', async () => {
  const invoke = (stdout, error = null) => processIsSocialDaemon(74789, {
    execFile: (command, args, options, callback) => {
      assert.equal(command, '/bin/ps');
      assert.deepEqual(args, ['-p', '74789', '-o', 'command=']);
      assert.equal(options.shell, undefined);
      callback(error, stdout);
    },
  });

  assert.equal(await invoke('/usr/bin/python /Users/s2/project/scripts/eddie_daemon.py\n'), true);
  assert.equal(await invoke('/usr/bin/python /Users/s2/project/scripts/other.py\n'), false);
  assert.equal(await invoke('', new Error('missing process')), false);
});

test('projects stale and failed PID probes as offline without leaking details', async () => {
  const running = createSocialAgentInspector({
    readPid: async () => 74789,
    processMatches: async () => true,
  });
  assert.deepEqual(await running(), { running: true });

  const missing = createSocialAgentInspector({ readPid: async () => null });
  assert.deepEqual(await missing(), { running: false });

  const failed = createSocialAgentInspector({
    readPid: async () => { throw new Error('private path details'); },
  });
  assert.deepEqual(await failed(), { running: false });
});
