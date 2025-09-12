import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import CDP from 'chrome-remote-interface';
type Client = any;
import path from 'node:path';

const scriptPath = path.resolve('tests/fixtures/sample-script.js');
const debug = !!process.env.DEBUG_CDP_TEST;
const debugLog = (...args: unknown[]) => { if (debug) console.log(...args); };

async function startDebuggedProcess(): Promise<{ proc: ChildProcess, port: number }>{
  const proc = spawn('node', ['--inspect-brk=0', scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' }
  });

  const port: number = await new Promise((resolve, reject) => {
    let resolved = false;
    proc.stderr?.on('data', (data: Buffer) => {
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

function resolveFrameUrl(frame: any, parsedScripts: any[]): string {
  const sid = frame && frame.location && frame.location.scriptId;
  const match = parsedScripts.find((ev) => ev.scriptId === sid && ev.url);
  return (frame && frame.url) || (match && match.url) || '<unknown>';
}

async function dumpLocalScope(Runtime: Client['Runtime'], callFrame: any, { only }: { only?: string[] } = {}) {
  try {
    const localScope = (callFrame.scopeChain || []).find((s: any) => s.type === 'local');
    if (!localScope || !localScope.object || !localScope.object.objectId) {
      debugLog('locals: <no local scope object>');
      return;
    }
    const { result } = await Runtime.getProperties({
      objectId: localScope.object.objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: true
    });
    const props = (result || [])
      .filter((p: any) => p && p.enumerable && p.name !== 'arguments')
      .filter((p: any) => !only || only.includes(p.name))
      .map((p: any) => {
        const v: any = p.value || {};
        const val = Object.prototype.hasOwnProperty.call(v, 'value') ? v.value : (v.description || v.type);
        return `${p.name}=${JSON.stringify(val)}`;
      });
    debugLog('locals:', props.join(', '));
  } catch (e: any) {
    debugLog('locals: <error reading locals>', e && e.message ? e.message : e);
  }
}

// MCP-style logging helpers (simulated)
function mcpLogCall(tool: string, params: unknown) {
  if (!debug) return;
  console.log(JSON.stringify({ event: 'mcp.tool_call', tool, params }, null, 2));
}
function mcpLogResult(tool: string, payloadObj: unknown) {
  if (!debug) return;
  const response = { content: [
    { type: 'text', text: JSON.stringify(payloadObj, null, 2) },
    { type: 'json', json: payloadObj }
  ] };
  console.log(JSON.stringify({ event: 'mcp.tool_result', tool, response }, null, 2));
}

test('debugger hits breakpoint', { timeout: 30000 }, async () => {
  const { proc, port } = await startDebuggedProcess();
  const client = await CDP({ host: '127.0.0.1', port });
  if (debug) {
    // eslint-disable-next-line no-console
    (client as any).on('event', (message: any) => {
      const { method, params } = message as any;
      const maybeUrl = params && (params.url || params.scriptId || params.reason);
      console.log('event', method, maybeUrl || '');
    });
  }
  const { Debugger, Runtime } = client;

  let unlistenScriptParsed: any;
  try {
    debugLog('connected to CDP on port', port);
    const parsedScripts: any[] = [];
    unlistenScriptParsed = (Debugger as any).scriptParsed((ev: any) => { parsedScripts.push(ev); });

    await Debugger.enable();
    await Runtime.enable();
    debugLog('Debugger and Runtime enabled');

    const bpByUrl = await Debugger.setBreakpointByUrl({ urlRegex: 'sample-script\\.js$', lineNumber: 3, columnNumber: 0 });
    debugLog('setBreakpointByUrl(pre-run)', bpByUrl);

    const firstPause = Debugger.paused();
    await Runtime.runIfWaitingForDebugger();
    await firstPause;
    debugLog('initial pause observed');

    const target = parsedScripts.find((ev) => ev.url && ev.url.includes('sample-script.js'));
    const targetScriptId = target && target.scriptId;
    if (target) debugLog('scriptParsed', target.url);
    debugLog('targetScriptId', targetScriptId);

    const bpResult = await Debugger.setBreakpoint({ location: { scriptId: targetScriptId, lineNumber: 3, columnNumber: 0 } });
    debugLog('setBreakpoint', bpResult);

    const pausedAtBreakpoint = Debugger.paused();
    const unlistenPaused = Debugger.paused((ev: any) => {
      if (!debug) return;
      try {
        const fr = ev.callFrames && ev.callFrames[0];
        const loc = fr && fr.location;
        debugLog('paused (listener)', ev.reason || '', loc ? `${loc.scriptId}:${loc.lineNumber}:${loc.columnNumber}` : '');
      } catch {}
    });

    await Debugger.resume();
    debugLog('resumed from initial pause, waiting for breakpoint');

    const bpPause = await pausedAtBreakpoint;
    try { if (typeof unlistenPaused === 'function') unlistenPaused(); } catch {}
    const topFrame = bpPause.callFrames[0];
    debugLog('paused(bp)', bpPause.reason, topFrame.location);
    assert.equal(topFrame.location.lineNumber + 1, 4);

    await dumpLocalScope(Runtime, topFrame, { only: ['a', 'b', 'sum'] });

    mcpLogCall('get_pause_info', {});
    mcpLogResult('get_pause_info', {
      reason: bpPause.reason,
      location: {
        url: resolveFrameUrl(topFrame, parsedScripts),
        line: topFrame.location.lineNumber + 1,
        column: (topFrame.location.columnNumber ?? 0) + 1
      },
      functionName: topFrame.functionName || null,
      scopeTypes: (topFrame.scopeChain || []).map((s: any) => s.type)
    });
    mcpLogCall('list_call_stack', { depth: 5 });
    mcpLogResult('list_call_stack', {
      frames: (bpPause.callFrames || []).slice(0, 5).map((f: any) => ({
        functionName: f.functionName || null,
        url: resolveFrameUrl(f, parsedScripts),
        line: f.location.lineNumber + 1,
        column: (f.location.columnNumber ?? 0) + 1
      }))
    });

    await Debugger.resume();
    try { await client.close(); } catch {}
    await new Promise((resolve) => proc.once('exit', resolve));
  } finally {
    try { await client.close(); } catch {}
    if (!proc.killed) { try { proc.kill('SIGKILL'); } catch {} }
    try { if (typeof unlistenScriptParsed === 'function') unlistenScriptParsed(); } catch {}
  }
});

test('inspect variables at breakpoint and step over', { timeout: 25000 }, async () => {
  const { proc, port } = await startDebuggedProcess();
  const client: Client = await CDP({ host: '127.0.0.1', port });
  const { Debugger, Runtime } = client;

  const parsedScripts: any[] = [];
  const unlistenScriptParsed = Debugger.scriptParsed((ev: any) => parsedScripts.push(ev));

  try {
    await Debugger.enable();
    await Runtime.enable();

    const firstPause = Debugger.paused();
    await Runtime.runIfWaitingForDebugger();
    await firstPause;

    const target = parsedScripts.find((ev) => ev.url && ev.url.includes('sample-script.js'));
    assert.ok(target, 'target script discovered');
    const targetScriptId = target.scriptId;

    const bp = await Debugger.setBreakpoint({ location: { scriptId: targetScriptId, lineNumber: 3, columnNumber: 0 } });
    debugLog('setBreakpoint(vars)', bp);

    const pausedAtBpP = Debugger.paused();
    await Debugger.resume();
    const pausedAtBp = await pausedAtBpP;

    const top = pausedAtBp.callFrames[0];
    assert.equal(top.location.lineNumber + 1, 4);

    const callFrameId = top.callFrameId;
    const evalA = await Debugger.evaluateOnCallFrame({ callFrameId, expression: 'a', returnByValue: true });
    const evalB = await Debugger.evaluateOnCallFrame({ callFrameId, expression: 'b', returnByValue: true });
    const evalSum = await Debugger.evaluateOnCallFrame({ callFrameId, expression: 'sum', returnByValue: true });
    mcpLogCall('evaluate_expression', { expr: 'a' });
    mcpLogResult('evaluate_expression', { result: evalA.result.value, consoleOutput: [] });
    mcpLogCall('evaluate_expression', { expr: 'b' });
    mcpLogResult('evaluate_expression', { result: evalB.result.value, consoleOutput: [] });
    mcpLogCall('evaluate_expression', { expr: 'sum' });
    mcpLogResult('evaluate_expression', { result: evalSum.result.value, consoleOutput: [] });
    debugLog('eval a =', evalA.result?.value);
    debugLog('eval b =', evalB.result?.value);
    debugLog('eval sum =', evalSum.result?.value);
    await dumpLocalScope(Runtime, top, { only: ['a', 'b', 'sum'] });
    assert.equal(evalA.result.value, 2);
    assert.equal(evalB.result.value, 3);
    assert.equal(evalSum.result.value, 5);

    const stepPauseP = Debugger.paused();
    mcpLogCall('step_over', {});
    await Debugger.stepOver();
    const stepPause = await stepPauseP;
    const topAfterStep = stepPause.callFrames[0];
    assert.equal(topAfterStep.location.lineNumber + 1, 5, 'stepped to return line');
    mcpLogResult('step_over', {
      status: `Paused at ${resolveFrameUrl(topAfterStep, parsedScripts)}:${topAfterStep.location.lineNumber + 1} (reason: ${stepPause.reason})`,
      consoleOutput: []
    });
    const callFrameId2 = topAfterStep.callFrameId;
    const evalSum2 = await Debugger.evaluateOnCallFrame({ callFrameId: callFrameId2, expression: 'sum', returnByValue: true });
    debugLog('after stepOver, sum =', evalSum2.result?.value);
    await dumpLocalScope(Runtime, topAfterStep, { only: ['sum'] });

    const stepOutPauseP = Debugger.paused();
    await Debugger.stepOut();
    const stepOutPause = await stepOutPauseP;
    const afterOut = stepOutPause.callFrames[0];
    assert.equal(afterOut.location.lineNumber + 1, 8, 'stepped out to next statement after call');
    const callFrameId3 = afterOut.callFrameId;
    const ta = await Debugger.evaluateOnCallFrame({ callFrameId: callFrameId3, expression: 'typeof a', returnByValue: true });
    const tb = await Debugger.evaluateOnCallFrame({ callFrameId: callFrameId3, expression: 'typeof b', returnByValue: true });
    const ts = await Debugger.evaluateOnCallFrame({ callFrameId: callFrameId3, expression: 'typeof sum', returnByValue: true });
    debugLog('after stepOut, typeof a =', ta.result?.value);
    debugLog('after stepOut, typeof b =', tb.result?.value);
    debugLog('after stepOut, typeof sum =', ts.result?.value);

    await Debugger.resume();
    try { await client.close(); } catch {}
    await new Promise((resolve) => proc.once('exit', resolve));
  } finally {
    try { await client.close(); } catch {}
    if (!proc.killed) { try { proc.kill('SIGKILL'); } catch {} }
    try { if (typeof unlistenScriptParsed === 'function') unlistenScriptParsed(); } catch {}
  }
});

test('step into function call and verify parameters', { timeout: 25000 }, async () => {
  const { proc, port } = await startDebuggedProcess();
  const client: Client = await CDP({ host: '127.0.0.1', port });
  const { Debugger, Runtime } = client;

  const parsedScripts: any[] = [];
  const unlistenScriptParsed = Debugger.scriptParsed((ev: any) => parsedScripts.push(ev));

  try {
    await Debugger.enable();
    await Runtime.enable();

    const firstPause = Debugger.paused();
    await Runtime.runIfWaitingForDebugger();
    await firstPause;

    const target = parsedScripts.find((ev) => ev.url && ev.url.includes('sample-script.js'));
    assert.ok(target, 'target script discovered');
    const targetScriptId = target.scriptId;

    await Debugger.setBreakpoint({ location: { scriptId: targetScriptId, lineNumber: 6, columnNumber: 0 } });

    const pauseAtCallP = Debugger.paused();
    await Debugger.resume();
    const pauseAtCall = await pauseAtCallP;
    const topAtCall = pauseAtCall.callFrames[0];
    assert.equal(topAtCall.location.lineNumber + 1, 7);

    const pauseInsideP = Debugger.paused();
    mcpLogCall('step_into', {});
    await Debugger.stepInto();
    const pauseInside = await pauseInsideP;
    const insideTop = pauseInside.callFrames[0];
    assert.equal(insideTop.location.lineNumber + 1, 3);
    mcpLogResult('step_into', { status: `Paused at ${resolveFrameUrl(insideTop, parsedScripts)}:${insideTop.location.lineNumber + 1} (reason: ${pauseInside.reason})`, consoleOutput: [] });

    const callFrameId = insideTop.callFrameId;
    const aVal = await Debugger.evaluateOnCallFrame({ callFrameId, expression: 'a', returnByValue: true });
    const bVal = await Debugger.evaluateOnCallFrame({ callFrameId, expression: 'b', returnByValue: true });
    mcpLogCall('evaluate_expression', { expr: 'a' });
    mcpLogResult('evaluate_expression', { result: aVal.result.value, consoleOutput: [] });
    mcpLogCall('evaluate_expression', { expr: 'b' });
    mcpLogResult('evaluate_expression', { result: bVal.result.value, consoleOutput: [] });
    debugLog('inside add(), a =', aVal.result?.value);
    debugLog('inside add(), b =', bVal.result?.value);
    await dumpLocalScope(Runtime, insideTop, { only: ['a', 'b'] });
    assert.equal(aVal.result.value, 2);
    assert.equal(bVal.result.value, 3);

    await Debugger.resume();
    try { await client.close(); } catch {}
    await new Promise((resolve) => proc.once('exit', resolve));
  } finally {
    try { await client.close(); } catch {}
    if (!proc.killed) { try { proc.kill('SIGKILL'); } catch {} }
    try { if (typeof unlistenScriptParsed === 'function') unlistenScriptParsed(); } catch {}
  }
});
