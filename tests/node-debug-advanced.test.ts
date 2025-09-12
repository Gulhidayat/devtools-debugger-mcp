import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import CDP from 'chrome-remote-interface';
type Client = any;
import path from 'node:path';

const scriptPath = path.resolve('tests/fixtures/advanced-script.js');
const debug = !!process.env.DEBUG_CDP_TEST;
const log = (...args: unknown[]) => { if (debug) console.log(...args); };

function mcpCall(tool: string, params: unknown) {
  if (!debug) return;
  console.log(JSON.stringify({ event: 'mcp.tool_call', tool, params }, null, 2));
}
function mcpResult(tool: string, payloadObj: unknown) {
  if (!debug) return;
  const response = { content: [
    { type: 'text', text: JSON.stringify(payloadObj, null, 2) },
    { type: 'json', json: payloadObj }
  ] };
  console.log(JSON.stringify({ event: 'mcp.tool_result', tool, response }, null, 2));
}

async function startDebuggedProcess(file: string): Promise<{ proc: ChildProcess, port: number }>{
  const proc = spawn('node', ['--inspect-brk=0', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  const port = await new Promise<number>((resolve, reject) => {
    let resolved = false;
    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      const match = msg.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { resolved = true; resolve(Number(match[1])); }
    });
    proc.on('exit', () => { if (!resolved) reject(new Error('process exited early')); });
  });
  return { proc, port };
}

function frameUrl(frame: any, parsedScripts: any[]): string {
  const sid = frame && frame.location && frame.location.scriptId;
  const match = parsedScripts.find((ev) => ev.scriptId === sid && ev.url);
  return (frame && frame.url) || (match && match.url) || '<unknown>';
}

async function getProps(Runtime: Client['Runtime'], objectId: string, limit = 20) {
  if (!objectId) return [];
  const { result } = await Runtime.getProperties({ objectId, ownProperties: true, generatePreview: true });
  return (result || []).slice(0, limit).map((p: any) => {
    const v = p.value || {};
    const val = Object.prototype.hasOwnProperty.call(v, 'value') ? v.value : (v.description || v.type);
    return { name: p.name, type: v.type, value: val, objectId: v.objectId };
  });
}

async function collectScopes(Runtime: Client['Runtime'], frame: any, parsedScripts: any[]) {
  const scopes: any[] = [];
  for (const s of frame.scopeChain || []) {
    const type = s.type;
    if (!s.object || !s.object.objectId) continue;
    const variables = await getProps(Runtime, s.object.objectId, type === 'global' ? 5 : 20);
    scopes.push({ type, variables, truncated: type === 'global' });
  }
  let thisSummary: any = null;
  if (frame.this) {
    const t = frame.this;
    thisSummary = { type: t.type, description: t.description, className: t.className };
    if (t.objectId) thisSummary.preview = await getProps(Runtime, t.objectId, 8);
  }
  return {
    frame: {
      functionName: frame.functionName || null,
      url: frameUrl(frame, parsedScripts),
      line: frame.location.lineNumber + 1,
      column: (frame.location.columnNumber ?? 0) + 1
    },
    this: thisSummary,
    scopes
  };
}

test('advanced: scopes, this, arguments, and call stack across steps', { timeout: 30000 }, async () => {
  const { proc, port } = await startDebuggedProcess(scriptPath);
  const client: Client = await CDP({ host: '127.0.0.1', port });
  const { Debugger, Runtime } = client;

  const parsedScripts: any[] = [];
  const unScript = Debugger.scriptParsed((ev: any) => parsedScripts.push(ev));
  const consoleBuf: string[] = [];
  const unConsole = Runtime.consoleAPICalled(({ type, args }: any) => {
    const text = (args || []).map((a: any) => (Object.prototype.hasOwnProperty.call(a, 'value') ? a.value : a.description)).join(' ');
    consoleBuf.push(`[${type}] ${text}`);
  });

  try {
    await Debugger.enable();
    await Runtime.enable();

    const onStart = Debugger.paused();
    await Runtime.runIfWaitingForDebugger();
    await onStart;
    const pause1P = Debugger.paused();
    await Debugger.resume();
    const pause1 = await pause1P;
    const f1 = pause1.callFrames[0];
    assert.equal(f1.functionName, 'inc');

    mcpCall('inspect_scopes', { maxProps: 15 });
    const scope1 = await collectScopes(Runtime, f1, parsedScripts);
    mcpResult('inspect_scopes', scope1);
    log('pause1', scope1);

    const names1 = scope1.scopes.reduce((acc: string[], s: any) => acc.concat((s.variables || []).map((v: any) => v.name)), []);
    assert.ok(names1.includes('before') && names1.includes('s'));
    const sVar = scope1.scopes.find((s: any) => s.type === 'local').variables.find((v: any) => v.name === 's');
    const countVar = scope1.scopes.flatMap((s: any) => s.variables || []).find((v: any) => v.name === 'count');
    assert.equal(sVar && sVar.value, 2);
    assert.equal(countVar && countVar.value, 12);

    const cfId = f1.callFrameId;
    const a0 = await Debugger.evaluateOnCallFrame({ callFrameId: cfId, expression: 'arguments[0]', returnByValue: true });
    const metaNested = await Debugger.evaluateOnCallFrame({ callFrameId: cfId, expression: 'meta.nested.a', returnByValue: true });
    mcpCall('evaluate_expression', { expr: 'arguments[0]' });
    mcpResult('evaluate_expression', { result: a0.result.value, consoleOutput: [] });
    mcpCall('evaluate_expression', { expr: 'meta.nested.a' });
    mcpResult('evaluate_expression', { result: metaNested.result.value, consoleOutput: [] });
    assert.equal(a0.result.value, 2);
    assert.equal(metaNested.result.value, 1);

    const onAfterOut = Debugger.paused();
    mcpCall('step_out', {});
    await Debugger.stepOut();
    const pause2 = await onAfterOut;
    const f2 = pause2.callFrames[0];
    mcpResult('step_out', { status: `Paused at ${frameUrl(f2, parsedScripts)}:${f2.location.lineNumber + 1} (reason: ${pause2.reason})`, consoleOutput: consoleBuf.splice(0) });

    const stack2 = (pause2.callFrames || []).slice(0, 5).map((cf: any) => ({ functionName: cf.functionName || null, url: frameUrl(cf, parsedScripts), line: cf.location.lineNumber + 1 }));
    mcpCall('list_call_stack', { depth: 5 });
    mcpResult('list_call_stack', { frames: stack2 });

    const pause3P = Debugger.paused();
    await Debugger.resume();
    const pause3 = await pause3P;
    const f3 = pause3.callFrames[0];
    assert.equal(f3.functionName, 'times');

    mcpCall('inspect_scopes', { maxProps: 10 });
    const scope3 = await collectScopes(Runtime, f3, parsedScripts);
    mcpResult('inspect_scopes', scope3);
    const local3 = scope3.scopes.find((s: any) => s.type === 'local');
    const nVar = local3 && local3.variables.find((v: any) => v.name === 'n');
    assert.equal(nVar && nVar.value, 5);
    const thisPreview = scope3.this && scope3.this.preview;
    const multProp = (thisPreview || []).find((p: any) => p.name === 'mult');
    assert.equal(multProp && multProp.value, 3);

    const thisMult = await Debugger.evaluateOnCallFrame({ callFrameId: f3.callFrameId, expression: 'this.mult', returnByValue: true });
    mcpCall('evaluate_expression', { expr: 'this.mult' });
    mcpResult('evaluate_expression', { result: thisMult.result.value, consoleOutput: [] });
    assert.equal(thisMult.result.value, 3);

    const pause4P = Debugger.paused();
    mcpCall('step_over', {});
    await Debugger.stepOver();
    const pause4 = await pause4P;
    const f4 = pause4.callFrames[0];
    mcpResult('step_over', { status: `Paused at ${frameUrl(f4, parsedScripts)}:${f4.location.lineNumber + 1} (reason: ${pause4.reason})`, consoleOutput: consoleBuf.splice(0) });

    await Debugger.resume();
    try { await client.close(); } catch {}
    await new Promise((r) => proc.once('exit', r));
  } finally {
    try { await client.close(); } catch {}
    if (!proc.killed) { try { proc.kill('SIGKILL'); } catch {} }
    try { if (typeof unScript === 'function') unScript(); } catch {}
    try { if (typeof unConsole === 'function') unConsole(); } catch {}
  }
});
