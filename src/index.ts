#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import CDP, { Client } from 'chrome-remote-interface';
// Note: No debug trace wrappers; using standard MCP server behavior


// Create the MCP server
const server = new McpServer({
    name: 'devtools-debugger-mcp',
    version: '1.0.0'
});

// Node.js debugging state
let nodeDebugClient: Client | null = null;
let nodeProcess: import('child_process').ChildProcess | null = null;
let scriptIdToUrl: Record<string, string> = {};
let consoleMessages: string[] = [];
let lastPausedParams: any | null = null;
let pauseCounter = 0;
let pauseMap: Record<string, any> = {};
let currentPauseId: string | null = null;

type OutputFormat = 'text' | 'json';

function summarizeFrame(frame: any) {
    const fileUrl = frame.url || scriptIdToUrl[frame.location.scriptId] || '<unknown>';
    return {
        functionName: frame.functionName || null,
        url: fileUrl,
        line: frame.location.lineNumber + 1,
        column: (frame.location.columnNumber ?? 0) + 1
    };
}

function mcpContent(payload: unknown, format?: OutputFormat) {
    // MCP spec supports text/image/resource. We encode structured data as a single text block.
    // Default is JSON (minified) to reduce tokens; pass format: 'text' for pretty 2-space JSON.
    const text = format === 'text' ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    return [{ type: 'text', text } as any];
}


// Log when server starts
console.error('devtools-debugger-mcp server starting...');

// Defer connecting the MCP transport until after tools are registered
const transport = new StdioServerTransport();


// Node.js debugging tools
server.tool(
    'start_node_debug',
    { scriptPath: z.string().describe('Path to the Node.js script to debug'), format: z.enum(['text','json']).optional() },
    async (params) => {
        if (nodeDebugClient) {
            return {
                content: [{ type: 'text', text: 'Error: A debug session is already active.' }],
                isError: true
            };
        }
        try {
            const scriptPath = params.scriptPath;
            nodeProcess = spawn('node', ['--inspect-brk=0', scriptPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, NODE_OPTIONS: '' }
            });

            const inspectorPort = await new Promise<number>((resolve, reject) => {
                let resolved = false;
                nodeProcess?.stderr?.on('data', (data) => {
                    const msg = data.toString();
                    const match = msg.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
                    if (match) {
                        resolved = true;
                        resolve(Number(match[1]));
                    }
                });
                nodeProcess?.on('exit', () => {
                    if (!resolved) {
                        reject(new Error('Node process exited before debugger attached'));
                    }
                });
            });

            nodeDebugClient = await CDP({ host: '127.0.0.1', port: inspectorPort });

            const pausedPromise = new Promise<any>((resolve) => {
                nodeDebugClient!.Debugger.paused((params) => {
                    lastPausedParams = params;
                    resolve(params);
                });
            });

            await nodeDebugClient.Debugger.enable();
            await nodeDebugClient.Runtime.enable();
            // Trigger pause delivery if runtime is waiting for debugger
            try { await nodeDebugClient.Runtime.runIfWaitingForDebugger(); } catch {}

            scriptIdToUrl = {};
            consoleMessages = [];

            nodeDebugClient.Debugger.scriptParsed(({ scriptId, url }) => {
                if (url) scriptIdToUrl[scriptId] = url;
            });
            nodeDebugClient.Runtime.consoleAPICalled(({ type, args }) => {
                const text = args
                    .map((arg) => (arg.value !== undefined ? arg.value : arg.description))
                    .join(' ');
                consoleMessages.push(`[${type}] ${text}`);
            });

            const pausedEvent = await pausedPromise;

            const callFrame = pausedEvent.callFrames[0];
            const scriptId = callFrame.location.scriptId;
            const fileUrl =
                scriptIdToUrl[scriptId] || callFrame.url || '<unknown>';
            const line = callFrame.location.lineNumber + 1;
            consoleMessages = [];

            // Track pause
            lastPausedParams = pausedEvent;
            currentPauseId = 'p' + ++pauseCounter;
            pauseMap[currentPauseId] = pausedEvent;

            return {
                content: mcpContent({
                    status: `Debugger attached. Paused at ${fileUrl}:${line} (reason: ${pausedEvent.reason}).`,
                    pauseId: currentPauseId,
                    frame: summarizeFrame(callFrame)
                }, params.format as any)
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Failed to start debug session - ${
                            error instanceof Error ? error.message : error
                        }`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    'set_breakpoint',
    {
        filePath: z
            .string()
            .describe('Path of the script file to break in'),
        line: z.number().describe('1-based line number to set breakpoint at')
    },
    async (params) => {
        if (!nodeDebugClient) {
            return {
                content: [{ type: 'text', text: 'Error: No active debug session.' }],
                isError: true
            };
        }
        try {
            const fileUrl = params.filePath.startsWith('file://')
                ? params.filePath
                : 'file://' + params.filePath;
            const lineNumber = params.line - 1;
            const { breakpointId } =
                await nodeDebugClient.Debugger.setBreakpointByUrl({
                    url: fileUrl,
                    lineNumber,
                    columnNumber: 0
                });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Breakpoint set at ${params.filePath}:${params.line} (ID: ${breakpointId}).`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Failed to set breakpoint - ${error instanceof Error ? error.message : error}`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    'set_breakpoint_condition',
    {
        filePath: z.string().optional(),
        urlRegex: z.string().optional(),
        line: z.number().describe('1-based line number'),
        column: z.number().optional(),
        condition: z.string().describe('Breakpoint condition, e.g. x > 0 or console.log("msg") || false'),
        format: z.enum(['text', 'json']).optional()
    },
    async (params) => {
        if (!nodeDebugClient) return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
        try {
            const lineNumber = params.line - 1;
            const column = params.column ?? 0;
            let result;
            if (params.urlRegex) {
                result = await nodeDebugClient.Debugger.setBreakpointByUrl({ urlRegex: params.urlRegex, lineNumber, columnNumber: column, condition: params.condition });
            } else if (params.filePath) {
                const fileUrl = params.filePath.startsWith('file://') ? params.filePath : 'file://' + params.filePath;
                result = await nodeDebugClient.Debugger.setBreakpointByUrl({ url: fileUrl, lineNumber, columnNumber: column, condition: params.condition });
            } else {
                return { content: [{ type: 'text', text: 'Error: Provide filePath or urlRegex.' }], isError: true };
            }
            return { content: mcpContent({ breakpointId: (result as any).breakpointId, locations: (result as any).locations }, params.format) };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: Failed to set conditional breakpoint - ${error instanceof Error ? error.message : error}` }], isError: true };
        }
    }
);

server.tool(
    'add_logpoint',
    {
        filePath: z.string().optional(),
        urlRegex: z.string().optional(),
        line: z.number(),
        column: z.number().optional(),
        message: z.string().describe('Log message template; use {expr} to interpolate JS expression'),
        format: z.enum(['text', 'json']).optional()
    },
    async (params) => {
        if (!nodeDebugClient) return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
        const toCondition = (msg: string) => {
            // Replace {expr} with ${expr} inside a template literal
            const tpl = '`' + msg.replace(/`/g, '\\`').replace(/\{([^}]+)\}/g, '${$1}') + '`';
            return `console.log(${tpl}); false`;
        };
        try {
            const condition = toCondition(params.message);
            const lineNumber = params.line - 1;
            const column = params.column ?? 0;
            let result;
            if (params.urlRegex) {
                result = await nodeDebugClient.Debugger.setBreakpointByUrl({ urlRegex: params.urlRegex, lineNumber, columnNumber: column, condition });
            } else if (params.filePath) {
                const fileUrl = params.filePath.startsWith('file://') ? params.filePath : 'file://' + params.filePath;
                result = await nodeDebugClient.Debugger.setBreakpointByUrl({ url: fileUrl, lineNumber, columnNumber: column, condition });
            } else {
                return { content: [{ type: 'text', text: 'Error: Provide filePath or urlRegex.' }], isError: true };
            }
            return { content: mcpContent({ breakpointId: (result as any).breakpointId, locations: (result as any).locations, kind: 'logpoint' }, params.format) };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: Failed to add logpoint - ${error instanceof Error ? error.message : error}` }], isError: true };
        }
    }
);

server.tool(
    'set_exception_breakpoints',
    { state: z.enum(['none', 'uncaught', 'all']).describe('Pause on exceptions'), format: z.enum(['text','json']).optional() },
    async (params) => {
        if (!nodeDebugClient) return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
        try {
            await nodeDebugClient.Debugger.setPauseOnExceptions({ state: params.state });
            return { content: mcpContent({ ok: true, state: params.state }, params.format) };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: Failed to set exception breakpoints - ${error instanceof Error ? error.message : error}` }], isError: true };
        }
    }
);

server.tool(
    'blackbox_scripts',
    { patterns: z.array(z.string()).describe('Regex patterns for script URLs to blackbox'), format: z.enum(['text','json']).optional() },
    async (params) => {
        if (!nodeDebugClient) return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
        try {
            await nodeDebugClient.Debugger.setBlackboxPatterns({ patterns: params.patterns });
            return { content: mcpContent({ ok: true, patterns: params.patterns }, params.format) };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: Failed to set blackbox patterns - ${error instanceof Error ? error.message : error}` }], isError: true };
        }
    }
);

server.tool(
    'list_scripts',
    { format: z.enum(['text','json']).optional() },
    async (params) => {
        const scripts = Object.entries(scriptIdToUrl).map(([scriptId, url]) => ({ scriptId, url }));
        return { content: mcpContent({ scripts }, params?.format) };
    }
);

server.tool(
    'get_script_source',
    { scriptId: z.string().optional(), url: z.string().optional(), format: z.enum(['text','json']).optional() },
    async (params) => {
        if (!nodeDebugClient) return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
        try {
            let sid = params.scriptId;
            if (!sid && params.url) {
                sid = Object.keys(scriptIdToUrl).find((k) => scriptIdToUrl[k] === params.url);
            }
            if (!sid) return { content: [{ type: 'text', text: 'Error: Provide scriptId or url.' }], isError: true };
            const { scriptSource } = await nodeDebugClient.Debugger.getScriptSource({ scriptId: sid });
            return { content: mcpContent({ scriptId: sid, url: scriptIdToUrl[sid] || null, source: scriptSource }, params.format) };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: Failed to get script source - ${error instanceof Error ? error.message : error}` }], isError: true };
        }
    }
);

server.tool(
    'continue_to_location',
    { filePath: z.string(), line: z.number(), column: z.number().optional(), format: z.enum(['text','json']).optional() },
    async (params) => {
        if (!nodeDebugClient) return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
        try {
            const url = params.filePath.startsWith('file://') ? params.filePath : 'file://' + params.filePath;
            const scriptId = Object.keys(scriptIdToUrl).find((k) => scriptIdToUrl[k] === url);
            if (!scriptId) return { content: [{ type: 'text', text: `Error: Script not found for ${url}` }], isError: true };
            const lineNumber = params.line - 1;
            const columnNumber = (params.column ?? 1) - 1;

            const pausePromise = new Promise<any>((resolve) => {
                nodeDebugClient!.Debugger.paused((p) => {
                    lastPausedParams = p;
                    currentPauseId = 'p' + ++pauseCounter;
                    pauseMap[currentPauseId] = p;
                    resolve(p);
                });
            });
            const exitPromise = new Promise((resolve) => nodeProcess?.once('exit', () => resolve(null)));
            await nodeDebugClient.Debugger.continueToLocation({ location: { scriptId, lineNumber, columnNumber } });
            const result = await Promise.race([pausePromise, exitPromise]);
            if (result && typeof result === 'object') {
                const top = (result as any).callFrames[0];
                return { content: mcpContent({ status: `Paused at ${summarizeFrame(top).url}:${summarizeFrame(top).line}`, pauseId: currentPauseId, frame: summarizeFrame(top) }, params.format) };
            } else {
                return { content: mcpContent({ status: 'Execution completed.' }, params.format) };
            }
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: Failed to continue to location - ${error instanceof Error ? error.message : error}` }], isError: true };
        }
    }
);

server.tool(
    'restart_frame',
    { frameIndex: z.number().min(0).describe('Frame index to restart'), pauseId: z.string().optional(), format: z.enum(['text','json']).optional() },
    async (params) => {
        if (!nodeDebugClient || !lastPausedParams) return { content: [{ type: 'text', text: 'Error: No active pause state.' }], isError: true };
        try {
            const pause = params.pauseId ? pauseMap[params.pauseId] : lastPausedParams;
            if (!pause) return { content: [{ type: 'text', text: 'Error: Invalid pauseId.' }], isError: true };
            const frame = pause.callFrames[params.frameIndex];
            if (!frame) return { content: [{ type: 'text', text: 'Error: Invalid frame index.' }], isError: true };
            const pausePromise = new Promise<any>((resolve) => {
                nodeDebugClient!.Debugger.paused((p) => {
                    lastPausedParams = p;
                    currentPauseId = 'p' + ++pauseCounter;
                    pauseMap[currentPauseId] = p;
                    resolve(p);
                });
            });
            await nodeDebugClient.Debugger.restartFrame({ callFrameId: frame.callFrameId });
            const result = await pausePromise;
            const top = (result as any).callFrames[0];
            return { content: mcpContent({ status: `Restarted frame; now at ${summarizeFrame(top).url}:${summarizeFrame(top).line}`, pauseId: currentPauseId, frame: summarizeFrame(top) }, params.format) };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: Failed to restart frame - ${error instanceof Error ? error.message : error}` }], isError: true };
        }
    }
);

server.tool(
    'get_object_properties',
    { objectId: z.string(), maxProps: z.number().min(1).max(100).optional(), format: z.enum(['text','json']).optional() },
    async (params) => {
        if (!nodeDebugClient) return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
        try {
            const { result } = await nodeDebugClient.Runtime.getProperties({ objectId: params.objectId, ownProperties: true, generatePreview: true });
            const items = (result || []).slice(0, params.maxProps ?? 50).map((p) => ({ name: p.name, type: p.value?.type, value: p.value?.value ?? p.value?.description, objectId: p.value?.objectId }));
            return { content: mcpContent({ properties: items }, params.format) };
        } catch (error) {
            return { content: [{ type: 'text', text: `Error: Failed to get object properties - ${error instanceof Error ? error.message : error}` }], isError: true };
        }
    }
);

server.tool(
    'read_console',
    { format: z.enum(['text','json']).optional() },
    async (params) => {
        const out = consoleMessages.slice();
        consoleMessages = [];
        return { content: mcpContent({ consoleOutput: out }, params.format) };
    }
);

// removed global format tool to avoid agent confusion; each call can specify format directly

server.tool(
    'resume_execution',
    {
        includeScopes: z.boolean().optional(),
        includeStack: z.boolean().optional(),
        includeConsole: z.boolean().optional(),
        format: z.enum(['text', 'json']).optional()
    },
    async (options) => {
        if (!nodeDebugClient) {
            return {
                content: [{ type: 'text', text: 'Error: No active debug session.' }],
                isError: true
            };
        }
        try {
            const pausePromise = new Promise<any>((resolve) => {
                nodeDebugClient!.Debugger.paused((params) => {
                    lastPausedParams = params;
                    currentPauseId = 'p' + ++pauseCounter;
                    pauseMap[currentPauseId] = params;
                    resolve(params);
                });
            });
            const exitPromise = new Promise((resolve) => {
                nodeProcess?.once('exit', () => resolve(null));
            });
            await nodeDebugClient.Debugger.resume();
            const result = await Promise.race([pausePromise, exitPromise]);
            if (result && typeof result === 'object') {
                const ev = result as any;
                const topFrame = ev.callFrames[0];
                const fileUrl = topFrame.url || scriptIdToUrl[topFrame.location.scriptId] || '<unknown>';
                const line = topFrame.location.lineNumber + 1;
                const output = consoleMessages.slice();
                consoleMessages = [];

                const payload: any = {
                    status: `Paused at ${fileUrl}:${line} (reason: ${ev.reason})`,
                    pauseId: currentPauseId,
                    frame: summarizeFrame(topFrame)
                };
                if (options?.includeConsole) payload.consoleOutput = output;
                if (options?.includeStack) {
                    payload.stack = (result as any).callFrames.map(summarizeFrame);
                }
                if (options?.includeScopes) {
                    // Build scopes snapshot
                    const scopes: any[] = [];
                    for (const s of topFrame.scopeChain || []) {
                        if (!s.object || !s.object.objectId) continue;
                        const { result: props } = await nodeDebugClient!.Runtime.getProperties({ objectId: s.object.objectId, ownProperties: true });
                        const variables = (props || []).slice(0, 15).map((p) => ({
                            name: p.name,
                            type: p.value?.type,
                            value: p.value?.value ?? p.value?.description,
                            objectId: p.value?.objectId
                        }));
                        scopes.push({ type: s.type, variables });
                    }
                    payload.scopes = scopes;
                }
                return { content: mcpContent(payload, options?.format as any) };
            } else {
                const exitCode = nodeProcess?.exitCode;
                await nodeDebugClient.close();
                nodeDebugClient = null;
                nodeProcess = null;
                scriptIdToUrl = {};
                lastPausedParams = null;
                consoleMessages = [];
                pauseMap = {};
                currentPauseId = null;
                return { content: mcpContent({ status: `Execution resumed until completion. Process exited with code ${exitCode}.` }, options?.format as any) };
            }
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Resume failed - ${error instanceof Error ? error.message : error}`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    'step_over',
    {
        includeScopes: z.boolean().optional(),
        includeStack: z.boolean().optional(),
        includeConsole: z.boolean().optional(),
        format: z.enum(['text', 'json']).optional()
    },
    async (options) => {
        if (!nodeDebugClient) {
            return {
                content: [{ type: 'text', text: 'Error: No active debug session.' }],
                isError: true
            };
        }
        try {
            const pausePromise = new Promise<any>((resolve) => {
                nodeDebugClient!.Debugger.paused((params) => {
                    lastPausedParams = params;
                    currentPauseId = 'p' + ++pauseCounter;
                    pauseMap[currentPauseId] = params;
                    resolve(params);
                });
            });
            const exitPromise = new Promise((resolve) => {
                nodeProcess?.once('exit', () => resolve(null));
            });
            await nodeDebugClient.Debugger.stepOver();
            const result = await Promise.race([pausePromise, exitPromise]);
            if (result && typeof result === 'object') {
                const params = result as any;
                const topFrame = params.callFrames[0];
                const fileUrl =
                    topFrame.url ||
                    scriptIdToUrl[topFrame.location.scriptId] ||
                    '<unknown>';
                const line = topFrame.location.lineNumber + 1;
                const payload: any = {
                    status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                    pauseId: currentPauseId,
                    frame: summarizeFrame(topFrame)
                };
                if (options?.includeConsole) {
                    payload.consoleOutput = consoleMessages.slice();
                }
                consoleMessages = [];
                if (options?.includeStack) {
                    payload.stack = (result as any).callFrames.map(summarizeFrame);
                }
                if (options?.includeScopes) {
                    const scopes: any[] = [];
                    for (const s of topFrame.scopeChain || []) {
                        if (!s.object || !s.object.objectId) continue;
                        const { result: props } = await nodeDebugClient!.Runtime.getProperties({ objectId: s.object.objectId, ownProperties: true });
                        const variables = (props || []).slice(0, 15).map((p) => ({
                            name: p.name,
                            type: p.value?.type,
                            value: p.value?.value ?? p.value?.description,
                            objectId: p.value?.objectId
                        }));
                        scopes.push({ type: s.type, variables });
                    }
                    payload.scopes = scopes;
                }
                return { content: mcpContent(payload, options?.format as any) };
            } else {
                const exitCode = nodeProcess?.exitCode;
                await nodeDebugClient.close();
                nodeDebugClient = null;
                nodeProcess = null;
                scriptIdToUrl = {};
                lastPausedParams = null;
                consoleMessages = [];
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Execution resumed until completion. Process exited with code ${exitCode}.`
                        }
                    ]
                };
            }
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Step over failed - ${error instanceof Error ? error.message : error}`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    'step_into',
    {
        includeScopes: z.boolean().optional(),
        includeStack: z.boolean().optional(),
        includeConsole: z.boolean().optional(),
        format: z.enum(['text', 'json']).optional()
    },
    async (options) => {
        if (!nodeDebugClient) {
            return {
                content: [{ type: 'text', text: 'Error: No active debug session.' }],
                isError: true
            };
        }
        try {
            const pausePromise = new Promise<any>((resolve) => {
                nodeDebugClient!.Debugger.paused((params) => {
                    lastPausedParams = params;
                    currentPauseId = 'p' + ++pauseCounter;
                    pauseMap[currentPauseId] = params;
                    resolve(params);
                });
            });
            const exitPromise = new Promise((resolve) => {
                nodeProcess?.once('exit', () => resolve(null));
            });
            await nodeDebugClient.Debugger.stepInto();
            const result = await Promise.race([pausePromise, exitPromise]);
            if (result && typeof result === 'object') {
                const params = result as any;
                const topFrame = params.callFrames[0];
                const fileUrl =
                    topFrame.url ||
                    scriptIdToUrl[topFrame.location.scriptId] ||
                    '<unknown>';
                const line = topFrame.location.lineNumber + 1;
                const payload: any = {
                    status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                    pauseId: currentPauseId,
                    frame: summarizeFrame(topFrame)
                };
                if (options?.includeConsole) payload.consoleOutput = consoleMessages.slice();
                consoleMessages = [];
                if (options?.includeStack) payload.stack = (result as any).callFrames.map(summarizeFrame);
                if (options?.includeScopes) {
                    const scopes: any[] = [];
                    for (const s of topFrame.scopeChain || []) {
                        if (!s.object || !s.object.objectId) continue;
                        const { result: props } = await nodeDebugClient!.Runtime.getProperties({ objectId: s.object.objectId, ownProperties: true });
                        const variables = (props || []).slice(0, 15).map((p) => ({
                            name: p.name,
                            type: p.value?.type,
                            value: p.value?.value ?? p.value?.description,
                            objectId: p.value?.objectId
                        }));
                        scopes.push({ type: s.type, variables });
                    }
                    payload.scopes = scopes;
                }
                return { content: mcpContent(payload, options?.format as any) };
            } else {
                const exitCode = nodeProcess?.exitCode;
                await nodeDebugClient.close();
                nodeDebugClient = null;
                nodeProcess = null;
                scriptIdToUrl = {};
                lastPausedParams = null;
                consoleMessages = [];
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Execution resumed until completion. Process exited with code ${exitCode}.`
                        }
                    ]
                };
            }
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Step into failed - ${error instanceof Error ? error.message : error}`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    'step_out',
    {
        includeScopes: z.boolean().optional(),
        includeStack: z.boolean().optional(),
        includeConsole: z.boolean().optional(),
        format: z.enum(['text', 'json', 'both']).optional()
    },
    async (options) => {
        if (!nodeDebugClient) {
            return {
                content: [{ type: 'text', text: 'Error: No active debug session.' }],
                isError: true
            };
        }
        try {
            const pausePromise = new Promise<any>((resolve) => {
                nodeDebugClient!.Debugger.paused((params) => {
                    lastPausedParams = params;
                    currentPauseId = 'p' + ++pauseCounter;
                    pauseMap[currentPauseId] = params;
                    resolve(params);
                });
            });
            const exitPromise = new Promise((resolve) => {
                nodeProcess?.once('exit', () => resolve(null));
            });
            await nodeDebugClient.Debugger.stepOut();
            const result = await Promise.race([pausePromise, exitPromise]);
            if (result && typeof result === 'object') {
                const params = result as any;
                const topFrame = params.callFrames[0];
                const fileUrl =
                    topFrame.url ||
                    scriptIdToUrl[topFrame.location.scriptId] ||
                    '<unknown>';
                const line = topFrame.location.lineNumber + 1;
                const payload: any = {
                    status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                    pauseId: currentPauseId,
                    frame: summarizeFrame(topFrame)
                };
                if (options?.includeConsole) payload.consoleOutput = consoleMessages.slice();
                consoleMessages = [];
                if (options?.includeStack) payload.stack = (result as any).callFrames.map(summarizeFrame);
                if (options?.includeScopes) {
                    const scopes: any[] = [];
                    for (const s of topFrame.scopeChain || []) {
                        if (!s.object || !s.object.objectId) continue;
                        const { result: props } = await nodeDebugClient!.Runtime.getProperties({ objectId: s.object.objectId, ownProperties: true });
                        const variables = (props || []).slice(0, 15).map((p) => ({
                            name: p.name,
                            type: p.value?.type,
                            value: p.value?.value ?? p.value?.description,
                            objectId: p.value?.objectId
                        }));
                        scopes.push({ type: s.type, variables });
                    }
                    payload.scopes = scopes;
                }
                return { content: mcpContent(payload, (options as any)?.format) };
            } else {
                const exitCode = nodeProcess?.exitCode;
                await nodeDebugClient.close();
                nodeDebugClient = null;
                nodeProcess = null;
                scriptIdToUrl = {};
                lastPausedParams = null;
                consoleMessages = [];
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Execution resumed until completion. Process exited with code ${exitCode}.`
                        }
                    ]
                };
            }
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Step out failed - ${error instanceof Error ? error.message : error}`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    'evaluate_expression',
    {
        expr: z.string().describe('JavaScript expression to evaluate'),
        pauseId: z.string().optional().describe('Specific pauseId to evaluate in'),
        frameIndex: z.number().min(0).optional().describe('Call frame index within the pause (default 0)'),
        returnByValue: z.boolean().optional().describe('Return primitives by value (default true)'),
        format: z.enum(['text', 'json']).optional()
    },
    async (params) => {
        if (!nodeDebugClient || !lastPausedParams) {
            return {
                content: [{ type: 'text', text: 'Error: No active pause state.' }],
                isError: true
            };
        }
        try {
            const pause = params.pauseId ? pauseMap[params.pauseId] : lastPausedParams;
            if (!pause) {
                return { content: [{ type: 'text', text: 'Error: Invalid pauseId.' }], isError: true };
            }
            const idx = params.frameIndex ?? 0;
            const callFrameId = pause.callFrames[idx]?.callFrameId;
            if (!callFrameId) {
                return { content: [{ type: 'text', text: 'Error: Invalid frame index.' }], isError: true };
            }
            const evalResponse = await nodeDebugClient.Debugger.evaluateOnCallFrame({
                callFrameId,
                expression: params.expr,
                includeCommandLineAPI: true,
                returnByValue: params.returnByValue ?? true
            });
            if (evalResponse.exceptionDetails) {
                const text =
                    evalResponse.exceptionDetails.exception?.description ||
                    evalResponse.exceptionDetails.text;
                return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
            }
            const resultObj = evalResponse.result;
            let output: unknown;
            if (resultObj.value !== undefined) {
                output = resultObj.value;
            } else {
                output = resultObj.description || resultObj.type;
            }
            const outputLogs = consoleMessages.slice();
            consoleMessages = [];
            return { content: mcpContent({ result: output, consoleOutput: outputLogs }, params.format) };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Evaluation failed - ${
                            error instanceof Error ? error.message : error
                        }`
                    }
                ],
                isError: true
            };
        }
    }
);

// Inspect locals/closure scopes at current pause
server.tool(
    'inspect_scopes',
    {
        maxProps: z.number().min(1).max(50).optional().describe('Maximum properties per scope to include (default 15)'),
        pauseId: z.string().optional().describe('Specific pause to inspect (default current)'),
        frameIndex: z.number().min(0).optional().describe('Call frame index (default 0)'),
        includeThisPreview: z.boolean().optional().describe('Include shallow preview of this (default true)'),
        format: z.enum(['text', 'json']).optional()
    },
    async (params) => {
        if (!nodeDebugClient || !lastPausedParams) {
            return {
                content: [{ type: 'text', text: 'Error: No active pause state.' }],
                isError: true
            };
        }
        const maxProps = params?.maxProps ?? 15;
        const pause = params.pauseId ? pauseMap[params.pauseId] : lastPausedParams;
        if (!pause) {
            return { content: [{ type: 'text', text: 'Error: Invalid pauseId.' }], isError: true };
        }
        const idx = params.frameIndex ?? 0;
        const frame = pause.callFrames[idx];
        const fileUrl = frame.url || scriptIdToUrl[frame.location.scriptId] || '<unknown>';
        function summarizeValue(v: any) {
            if (!v) return { type: 'undefined' };
            if (v.value !== undefined) return { type: typeof v.value, value: v.value };
            return { type: v.type, description: v.description, className: (v as any).className, objectId: (v as any).objectId };
        }
        async function listProps(objectId: string) {
            const { result } = await nodeDebugClient!.Runtime.getProperties({ objectId, ownProperties: true, generatePreview: false });
            const entries = (result || []).slice(0, maxProps).map((p) => ({ name: p.name, ...summarizeValue(p.value) }));
            return entries;
        }
        const scopes: any[] = [];
        for (const s of frame.scopeChain || []) {
            if (!s.object || !s.object.objectId) continue;
            const props = await listProps(s.object.objectId);
            // Skip huge globals; only include a light summary
            if (s.type === 'global') {
                scopes.push({ type: s.type, variables: props.slice(0, 5), truncated: true });
            } else {
                scopes.push({ type: s.type, variables: props });
            }
        }
        let thisSummary: any = null;
        const includeThis = params.includeThisPreview !== false;
        if (includeThis && frame.this && (frame.this as any).type) {
            const t: any = frame.this;
            thisSummary = summarizeValue(t);
            if (t.objectId) {
                const preview = await listProps(t.objectId);
                thisSummary.preview = preview;
            }
        }
        const payload = {
            frame: {
                functionName: frame.functionName || null,
                url: fileUrl,
                line: frame.location.lineNumber + 1,
                column: (frame.location.columnNumber ?? 0) + 1
            },
            this: thisSummary,
            scopes
        };
        return { content: mcpContent(payload, params.format) };
    }
);

// List current call stack (top N frames)
server.tool(
    'list_call_stack',
    {
        depth: z.number().min(1).max(50).optional().describe('Maximum frames to include (default 10)'),
        pauseId: z.string().optional(),
        includeThis: z.boolean().optional(),
        format: z.enum(['text', 'json', 'both']).optional()
    },
    async (params) => {
        if (!nodeDebugClient || !lastPausedParams) {
            return {
                content: [{ type: 'text', text: 'Error: No active pause state.' }],
                isError: true
            };
        }
        const pause = params.pauseId ? pauseMap[params.pauseId] : lastPausedParams;
        if (!pause) return { content: [{ type: 'text', text: 'Error: Invalid pauseId.' }], isError: true };
        const depth = params?.depth ?? 10;
        const frames = (pause.callFrames || []).slice(0, depth).map((f: any) => {
            const base: any = summarizeFrame(f);
            if (params?.includeThis && f.this) base.thisType = f.this.type;
            return base;
        });
        return { content: mcpContent({ frames, pauseId: params.pauseId || currentPauseId }, params.format as any) };
    }
);

// Provide minimal pause inspection to aid debugging/tests
server.tool(
    'get_pause_info',
    {
        pauseId: z.string().optional().describe('Specific pause to describe (default current)'),
        format: z.enum(['text', 'json']).optional()
    },
    async (args) => {
        if (!lastPausedParams) {
            return {
                content: [{ type: 'text', text: 'Error: No active pause state.' }],
                isError: true
            };
        }
        try {
            const pause = args?.pauseId ? pauseMap[args.pauseId] : lastPausedParams;
            const top = pause.callFrames[0];
            const fileUrl =
                top.url || scriptIdToUrl[top.location.scriptId] || '<unknown>';
            const info = {
                reason: pause.reason,
                pauseId: args?.pauseId || currentPauseId,
                location: {
                    url: fileUrl,
                    line: top.location.lineNumber + 1,
                    column: (top.location.columnNumber ?? 0) + 1
                },
                functionName: top.functionName || null,
                scopeTypes: (top.scopeChain || []).map((s: any) => s.type)
            };
            return { content: mcpContent(info, args?.format) };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Failed to get pause info - ${
                            error instanceof Error ? error.message : error
                        }`
                    }
                ],
                isError: true
            };
        }
    }
);

server.tool(
    'stop_debug_session',
    {},
    async () => {
        try {
            if (nodeProcess) {
                nodeProcess.kill();
                nodeProcess = null;
            }
            if (nodeDebugClient) {
                await nodeDebugClient.close();
                nodeDebugClient = null;
            }
            scriptIdToUrl = {};
            consoleMessages = [];
            lastPausedParams = null;
            pauseMap = {};
            currentPauseId = null;
            pauseCounter = 0;
            return {
                content: [{ type: 'text', text: 'Debug session terminated.' }]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: Failed to stop debug session - ${
                            error instanceof Error ? error.message : error
                        }`
                    }
                ],
                isError: true
            };
        }
    }
);

// Handle process termination
process.on('SIGINT', () => {
    server.close().catch(console.error);
    process.exit(0);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception in MCP server:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in MCP server:', reason);
});

// Now connect MCP transport after all handlers are in place
await server.connect(transport);
