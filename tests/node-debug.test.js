import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';
import path from 'node:path';

const scriptPath = path.resolve('tests/fixtures/sample-script.js');

async function startDebuggedProcess() {
  const proc = spawn('node', ['--inspect-brk=0', scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' }
  });

  const port = await new Promise((resolve, reject) => {
    let resolved = false;
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      const match = msg.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        resolved = true;
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', () => {
      if (!resolved) reject(new Error('process exited early'));
    });
  });

  return { proc, port };
}

test('debugger hits breakpoint', async () => {
  const { proc, port } = await startDebuggedProcess();
  const client = await CDP({ host: '127.0.0.1', port });
  const { Debugger, Runtime } = client;
  await Debugger.enable();
  await Runtime.enable();
  const fileUrl = 'file://' + scriptPath;
  await Debugger.setBreakpointByUrl({ url: fileUrl, lineNumber: 3, columnNumber: 0 });
  const paused = new Promise((resolve) => Debugger.paused(resolve));
  await Debugger.resume();
  const bpPause = await paused;
  const topFrame = bpPause.callFrames[0];
  assert.equal(topFrame.location.lineNumber + 1, 4);
  await Debugger.resume();
  await new Promise((resolve) => proc.once('exit', resolve));
  await client.close();
});
