import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseTextContent(callToolResult: any) {
  const block = (callToolResult.content || []).find((c: any) => c.type === 'text');
  assert.ok(block, 'expected text content block');
  const txt = block.text || '';
  const trimmed = txt.trim();
  return JSON.parse(trimmed);
}

test('MCP e2e: start, inspect_scopes, get_object_properties (text mode)', { timeout: 110000 }, async () => {
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/src/index.js'], stderr: 'pipe' });
  const client = new Client({ name: 'mcp-e2e-test', version: '0.0.0' });
  const reqOpts = { timeout: 100000 } as const;
  try {
    await client.connect(transport);
    if (transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        // eslint-disable-next-line no-console
        console.log('[server-stderr]', s.trim());
      });
    }

    await client.ping({ timeout: 5000 });

    // No global format changes; each call specifies its own format

    const scriptPath = path.resolve('tests/fixtures/advanced-script.js');
    const startRes = await client.callTool({ name: 'start_node_debug', arguments: { scriptPath, format: 'text' } }, undefined, reqOpts);
    const startPayload = parseTextContent(startRes);
    assert.ok(startPayload.pauseId, 'has pauseId');

    // Resume from Break on start to the next debugger pause inside inc(step)
    const resumeRes = await client.callTool({ name: 'resume_execution', arguments: { includeConsole: true, format: 'text' } }, undefined, reqOpts);
    const resumePayload = parseTextContent(resumeRes);
    const pauseId = resumePayload.pauseId ?? startPayload.pauseId;

    const scopesRes = await client.callTool({ name: 'inspect_scopes', arguments: { pauseId, format: 'text', maxProps: 20 } }, undefined, reqOpts);
    const scopes = parseTextContent(scopesRes);
    const closure = (scopes.scopes || []).find((s: any) => s.type === 'closure');
    assert.ok(closure, 'closure scope present');
    const metaVar = (closure.variables || []).find((v: any) => v.name === 'meta');
    assert.ok(metaVar && metaVar.objectId, 'meta objectId available');

    const propsRes = await client.callTool({ name: 'get_object_properties', arguments: { objectId: metaVar.objectId, format: 'text', maxProps: 50 } }, undefined, reqOpts);
    const props = parseTextContent(propsRes).properties || [];
    const tag = props.find((p: any) => p.name === 'tag');
    assert.equal(tag && tag.value, 'C');
    const nested = props.find((p: any) => p.name === 'nested');
    assert.ok(nested && nested.objectId, 'nested objectId available');

    const nestedRes = await client.callTool({ name: 'get_object_properties', arguments: { objectId: nested.objectId, format: 'text' } }, undefined, reqOpts);
    const nestedProps = parseTextContent(nestedRes).properties || [];
    const aProp = nestedProps.find((p: any) => p.name === 'a');
    assert.equal(aProp && aProp.value, 1);
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
  }
});
