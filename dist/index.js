#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChromeAPI } from './chrome-api.js';
import { processImage, saveImage } from './image-utils.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import CDP from 'chrome-remote-interface';
// Get Chrome debug URL from environment variable or use default
const chromeDebugUrl = process.env.CHROME_DEBUG_URL || 'http://localhost:9222';
console.error(`Using Chrome debug URL: ${chromeDebugUrl}`);
const chromeApi = new ChromeAPI({ baseUrl: chromeDebugUrl });
// Create the MCP server
const server = new McpServer({
    name: 'devtools-debugger-mcp',
    version: '1.0.0'
});
// Node.js debugging state
let nodeDebugClient = null;
let nodeProcess = null;
let scriptIdToUrl = {};
let consoleMessages = [];
let lastPausedParams = null;
let pauseCounter = 0;
let pauseMap = {};
let currentPauseId = null;
let defaultOutputFormat = 'both';
function summarizeFrame(frame) {
    const fileUrl = frame.url || scriptIdToUrl[frame.location.scriptId] || '<unknown>';
    return {
        functionName: frame.functionName || null,
        url: fileUrl,
        line: frame.location.lineNumber + 1,
        column: (frame.location.columnNumber ?? 0) + 1
    };
}
function mcpContent(payload, format) {
    // MCP spec supports text/image/resource. We encode JSON as text.
    // 'json' here means "JSON string in a text block"; 'both' is treated same as 'text' to avoid duplication.
    const fmt = format || defaultOutputFormat;
    const text = JSON.stringify(payload, null, 2);
    return [{ type: 'text', text }];
}
// Add the list_tabs tool
server.tool('list_tabs', {}, // No input parameters needed
async () => {
    try {
        console.error('Attempting to list Chrome tabs...');
        const tabs = await chromeApi.listTabs();
        console.error(`Successfully found ${tabs.length} tabs`);
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify(tabs, null, 2)
                }]
        };
    }
    catch (error) {
        console.error('Error in list_tabs tool:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return {
            content: [{
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }],
            isError: true
        };
    }
});
// Add the capture_screenshot tool
server.tool('capture_screenshot', {
    tabId: z.string().describe('ID of the Chrome tab to capture. Only send this unless you are having issues with the result.'),
    format: z.enum(['jpeg', 'png']).optional()
        .describe('Initial capture format (jpeg/png). Note: Final output will be WebP with PNG fallback'),
    quality: z.number().min(1).max(100).optional()
        .describe('Initial capture quality (1-100). Note: Final output uses WebP quality settings'),
    fullPage: z.boolean().optional()
        .describe('Capture full scrollable page')
}, async (params) => {
    try {
        console.error(`Attempting to capture screenshot of tab ${params.tabId}...`);
        const rawBase64Data = await chromeApi.captureScreenshot(params.tabId, {
            format: params.format,
            quality: params.quality,
            fullPage: params.fullPage
        });
        console.error('Screenshot captured, optimizing with WebP...');
        try {
            // Process image with the following strategy:
            // 1. Try WebP with quality 80 (best balance of quality/size)
            // 2. If >1MB, try WebP with quality 60 and near-lossless
            // 3. If WebP fails, fall back to PNG with maximum compression
            const processedImage = await processImage(rawBase64Data);
            console.error(`Image optimized successfully (${processedImage.data.startsWith('data:image/webp') ? 'WebP' : 'PNG'}, ${Math.round(processedImage.size / 1024)}KB)`);
            // Save the image and get the filepath
            const filepath = await saveImage(processedImage);
            console.error(`Screenshot saved to: ${filepath}`);
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'Screenshot successful.',
                            path: filepath
                        })
                    }]
            };
        }
        catch (error) {
            console.error('Image processing failed:', error);
            return {
                content: [{
                        type: 'text',
                        text: `Error processing screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }],
                isError: true
            };
        }
    }
    catch (error) {
        console.error('Error in capture_screenshot tool:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return {
            content: [{
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }],
            isError: true
        };
    }
});
// Add the execute_script tool
server.tool('execute_script', {
    tabId: z.string().describe('ID of the Chrome tab to execute the script in'),
    script: z.string().describe('JavaScript code to execute in the tab')
}, async (params) => {
    try {
        console.error(`Attempting to execute script in tab ${params.tabId}...`);
        const result = await chromeApi.executeScript(params.tabId, params.script);
        console.error('Script execution successful');
        return {
            content: [{
                    type: 'text',
                    text: result || 'undefined'
                }]
        };
    }
    catch (error) {
        console.error('Error in execute_script tool:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return {
            content: [{
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }],
            isError: true
        };
    }
});
// Log when server starts
console.error('devtools-debugger-mcp server starting...');
// Start the server
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
// Add the load_url tool
server.tool('load_url', {
    tabId: z.string().describe('ID of the Chrome tab to load the URL in'),
    url: z.string().url().describe('URL to load in the tab')
}, async (params) => {
    try {
        console.error(`Attempting to load URL ${params.url} in tab ${params.tabId}...`);
        await chromeApi.loadUrl(params.tabId, params.url);
        console.error('URL loading successful');
        return {
            content: [{
                    type: 'text',
                    text: `Successfully loaded ${params.url} in tab ${params.tabId}`
                }]
        };
    }
    catch (error) {
        console.error('Error in load_url tool:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return {
            content: [{
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }],
            isError: true
        };
    }
});
// Add the capture_network_events tool
server.tool('capture_network_events', {
    tabId: z.string().describe('ID of the Chrome tab to monitor'),
    duration: z.number().min(1).max(60).optional()
        .describe('Duration in seconds to capture events (default: 10)'),
    filters: z.object({
        types: z.array(z.enum(['fetch', 'xhr'])).optional()
            .describe('Types of requests to capture'),
        urlPattern: z.string().optional()
            .describe('Only capture URLs matching this pattern')
    }).optional()
}, async (params) => {
    try {
        console.error(`Attempting to capture network events from tab ${params.tabId}...`);
        const events = await chromeApi.captureNetworkEvents(params.tabId, {
            duration: params.duration,
            filters: params.filters
        });
        console.error(`Network event capture successful, captured ${events.length} events`);
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify(events, null, 2)
                }]
        };
    }
    catch (error) {
        console.error('Error in capture_network_events tool:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return {
            content: [{
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }],
            isError: true
        };
    }
});
// Add the query_dom_elements tool
server.tool('query_dom_elements', {
    tabId: z.string().describe('ID of the Chrome tab to query'),
    selector: z.string().describe('CSS selector to find elements')
}, async (params) => {
    try {
        console.error(`Attempting to query DOM elements in tab ${params.tabId}...`);
        const elements = await chromeApi.queryDOMElements(params.tabId, params.selector);
        console.error(`Successfully found ${elements.length} elements matching selector`);
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify(elements, null, 2)
                }]
        };
    }
    catch (error) {
        console.error('Error in query_dom_elements tool:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return {
            content: [{
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }],
            isError: true
        };
    }
});
// Add the click_element tool
server.tool('click_element', {
    tabId: z.string().describe('ID of the Chrome tab containing the element'),
    selector: z.string().describe('CSS selector to find the element to click')
}, async (params) => {
    try {
        console.error(`Attempting to click element in tab ${params.tabId}...`);
        const result = await chromeApi.clickElement(params.tabId, params.selector);
        console.error('Successfully clicked element');
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({
                        message: 'Successfully clicked element',
                        consoleOutput: result.consoleOutput
                    }, null, 2)
                }]
        };
    }
    catch (error) {
        console.error('Error in click_element tool:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return {
            content: [{
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }],
            isError: true
        };
    }
});
// Node.js debugging tools
server.tool('start_node_debug', { scriptPath: z.string().describe('Path to the Node.js script to debug'), format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
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
        const inspectorPort = await new Promise((resolve, reject) => {
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
        const pausedPromise = new Promise((resolve) => {
            nodeDebugClient.Debugger.paused((params) => {
                lastPausedParams = params;
                resolve(params);
            });
        });
        await nodeDebugClient.Debugger.enable();
        await nodeDebugClient.Runtime.enable();
        scriptIdToUrl = {};
        consoleMessages = [];
        nodeDebugClient.Debugger.scriptParsed(({ scriptId, url }) => {
            if (url)
                scriptIdToUrl[scriptId] = url;
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
        const fileUrl = scriptIdToUrl[scriptId] || callFrame.url || '<unknown>';
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
            }, params.format)
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: Failed to start debug session - ${error instanceof Error ? error.message : error}`
                }
            ],
            isError: true
        };
    }
});
server.tool('set_breakpoint', {
    filePath: z
        .string()
        .describe('Path of the script file to break in'),
    line: z.number().describe('1-based line number to set breakpoint at')
}, async (params) => {
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
        const { breakpointId } = await nodeDebugClient.Debugger.setBreakpointByUrl({
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
    }
    catch (error) {
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
});
server.tool('set_breakpoint_condition', {
    filePath: z.string().optional(),
    urlRegex: z.string().optional(),
    line: z.number().describe('1-based line number'),
    column: z.number().optional(),
    condition: z.string().describe('Breakpoint condition, e.g. x > 0 or console.log("msg") || false'),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (params) => {
    if (!nodeDebugClient)
        return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
    try {
        const lineNumber = params.line - 1;
        const column = params.column ?? 0;
        let result;
        if (params.urlRegex) {
            result = await nodeDebugClient.Debugger.setBreakpointByUrl({ urlRegex: params.urlRegex, lineNumber, columnNumber: column, condition: params.condition });
        }
        else if (params.filePath) {
            const fileUrl = params.filePath.startsWith('file://') ? params.filePath : 'file://' + params.filePath;
            result = await nodeDebugClient.Debugger.setBreakpointByUrl({ url: fileUrl, lineNumber, columnNumber: column, condition: params.condition });
        }
        else {
            return { content: [{ type: 'text', text: 'Error: Provide filePath or urlRegex.' }], isError: true };
        }
        return { content: mcpContent({ breakpointId: result.breakpointId, locations: result.locations }, params.format) };
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: Failed to set conditional breakpoint - ${error instanceof Error ? error.message : error}` }], isError: true };
    }
});
server.tool('add_logpoint', {
    filePath: z.string().optional(),
    urlRegex: z.string().optional(),
    line: z.number(),
    column: z.number().optional(),
    message: z.string().describe('Log message template; use {expr} to interpolate JS expression'),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (params) => {
    if (!nodeDebugClient)
        return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
    const toCondition = (msg) => {
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
        }
        else if (params.filePath) {
            const fileUrl = params.filePath.startsWith('file://') ? params.filePath : 'file://' + params.filePath;
            result = await nodeDebugClient.Debugger.setBreakpointByUrl({ url: fileUrl, lineNumber, columnNumber: column, condition });
        }
        else {
            return { content: [{ type: 'text', text: 'Error: Provide filePath or urlRegex.' }], isError: true };
        }
        return { content: mcpContent({ breakpointId: result.breakpointId, locations: result.locations, kind: 'logpoint' }, params.format) };
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: Failed to add logpoint - ${error instanceof Error ? error.message : error}` }], isError: true };
    }
});
server.tool('set_exception_breakpoints', { state: z.enum(['none', 'uncaught', 'all']).describe('Pause on exceptions'), format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
    if (!nodeDebugClient)
        return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
    try {
        await nodeDebugClient.Debugger.setPauseOnExceptions({ state: params.state });
        return { content: mcpContent({ ok: true, state: params.state }, params.format) };
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: Failed to set exception breakpoints - ${error instanceof Error ? error.message : error}` }], isError: true };
    }
});
server.tool('blackbox_scripts', { patterns: z.array(z.string()).describe('Regex patterns for script URLs to blackbox'), format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
    if (!nodeDebugClient)
        return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
    try {
        await nodeDebugClient.Debugger.setBlackboxPatterns({ patterns: params.patterns });
        return { content: mcpContent({ ok: true, patterns: params.patterns }, params.format) };
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: Failed to set blackbox patterns - ${error instanceof Error ? error.message : error}` }], isError: true };
    }
});
server.tool('list_scripts', { format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
    const scripts = Object.entries(scriptIdToUrl).map(([scriptId, url]) => ({ scriptId, url }));
    return { content: mcpContent({ scripts }, params?.format) };
});
server.tool('get_script_source', { scriptId: z.string().optional(), url: z.string().optional(), format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
    if (!nodeDebugClient)
        return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
    try {
        let sid = params.scriptId;
        if (!sid && params.url) {
            sid = Object.keys(scriptIdToUrl).find((k) => scriptIdToUrl[k] === params.url);
        }
        if (!sid)
            return { content: [{ type: 'text', text: 'Error: Provide scriptId or url.' }], isError: true };
        const { scriptSource } = await nodeDebugClient.Debugger.getScriptSource({ scriptId: sid });
        return { content: mcpContent({ scriptId: sid, url: scriptIdToUrl[sid] || null, source: scriptSource }, params.format) };
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: Failed to get script source - ${error instanceof Error ? error.message : error}` }], isError: true };
    }
});
server.tool('continue_to_location', { filePath: z.string(), line: z.number(), column: z.number().optional(), format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
    if (!nodeDebugClient)
        return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
    try {
        const url = params.filePath.startsWith('file://') ? params.filePath : 'file://' + params.filePath;
        const scriptId = Object.keys(scriptIdToUrl).find((k) => scriptIdToUrl[k] === url);
        if (!scriptId)
            return { content: [{ type: 'text', text: `Error: Script not found for ${url}` }], isError: true };
        const lineNumber = params.line - 1;
        const columnNumber = (params.column ?? 1) - 1;
        const pausePromise = new Promise((resolve) => {
            nodeDebugClient.Debugger.paused((p) => {
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
            const top = result.callFrames[0];
            return { content: mcpContent({ status: `Paused at ${summarizeFrame(top).url}:${summarizeFrame(top).line}`, pauseId: currentPauseId, frame: summarizeFrame(top) }, params.format) };
        }
        else {
            return { content: mcpContent({ status: 'Execution completed.' }, params.format) };
        }
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: Failed to continue to location - ${error instanceof Error ? error.message : error}` }], isError: true };
    }
});
server.tool('restart_frame', { frameIndex: z.number().min(0).describe('Frame index to restart'), pauseId: z.string().optional(), format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
    if (!nodeDebugClient || !lastPausedParams)
        return { content: [{ type: 'text', text: 'Error: No active pause state.' }], isError: true };
    try {
        const pause = params.pauseId ? pauseMap[params.pauseId] : lastPausedParams;
        if (!pause)
            return { content: [{ type: 'text', text: 'Error: Invalid pauseId.' }], isError: true };
        const frame = pause.callFrames[params.frameIndex];
        if (!frame)
            return { content: [{ type: 'text', text: 'Error: Invalid frame index.' }], isError: true };
        const pausePromise = new Promise((resolve) => {
            nodeDebugClient.Debugger.paused((p) => {
                lastPausedParams = p;
                currentPauseId = 'p' + ++pauseCounter;
                pauseMap[currentPauseId] = p;
                resolve(p);
            });
        });
        await nodeDebugClient.Debugger.restartFrame({ callFrameId: frame.callFrameId });
        const result = await pausePromise;
        const top = result.callFrames[0];
        return { content: mcpContent({ status: `Restarted frame; now at ${summarizeFrame(top).url}:${summarizeFrame(top).line}`, pauseId: currentPauseId, frame: summarizeFrame(top) }, params.format) };
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: Failed to restart frame - ${error instanceof Error ? error.message : error}` }], isError: true };
    }
});
server.tool('get_object_properties', { objectId: z.string(), maxProps: z.number().min(1).max(100).optional(), format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
    if (!nodeDebugClient)
        return { content: [{ type: 'text', text: 'Error: No active debug session.' }], isError: true };
    try {
        const { result } = await nodeDebugClient.Runtime.getProperties({ objectId: params.objectId, ownProperties: true, generatePreview: true });
        const items = (result || []).slice(0, params.maxProps ?? 50).map((p) => ({ name: p.name, type: p.value?.type, value: p.value?.value ?? p.value?.description, objectId: p.value?.objectId }));
        return { content: mcpContent({ properties: items }, params.format) };
    }
    catch (error) {
        return { content: [{ type: 'text', text: `Error: Failed to get object properties - ${error instanceof Error ? error.message : error}` }], isError: true };
    }
});
server.tool('read_console', { format: z.enum(['text', 'json', 'both']).optional() }, async (params) => {
    const out = consoleMessages.slice();
    consoleMessages = [];
    return { content: mcpContent({ consoleOutput: out }, params.format) };
});
server.tool('set_output_format', { format: z.enum(['text', 'json', 'both']).describe('Default content format for all tool responses') }, async (params) => {
    defaultOutputFormat = params.format;
    return { content: mcpContent({ ok: true, defaultFormat: defaultOutputFormat }, 'json') };
});
server.tool('resume_execution', {
    includeScopes: z.boolean().optional(),
    includeStack: z.boolean().optional(),
    includeConsole: z.boolean().optional(),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (options) => {
    if (!nodeDebugClient) {
        return {
            content: [{ type: 'text', text: 'Error: No active debug session.' }],
            isError: true
        };
    }
    try {
        const pausePromise = new Promise((resolve) => {
            nodeDebugClient.Debugger.paused((params) => {
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
            const ev = result;
            const topFrame = ev.callFrames[0];
            const fileUrl = topFrame.url || scriptIdToUrl[topFrame.location.scriptId] || '<unknown>';
            const line = topFrame.location.lineNumber + 1;
            const output = consoleMessages.slice();
            consoleMessages = [];
            const payload = {
                status: `Paused at ${fileUrl}:${line} (reason: ${ev.reason})`,
                pauseId: currentPauseId,
                frame: summarizeFrame(topFrame)
            };
            if (options?.includeConsole)
                payload.consoleOutput = output;
            if (options?.includeStack) {
                payload.stack = result.callFrames.map(summarizeFrame);
            }
            if (options?.includeScopes) {
                // Build scopes snapshot
                const scopes = [];
                for (const s of topFrame.scopeChain || []) {
                    if (!s.object || !s.object.objectId)
                        continue;
                    const { result: props } = await nodeDebugClient.Runtime.getProperties({ objectId: s.object.objectId, ownProperties: true });
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
            return { content: mcpContent(payload, options?.format) };
        }
        else {
            const exitCode = nodeProcess?.exitCode;
            await nodeDebugClient.close();
            nodeDebugClient = null;
            nodeProcess = null;
            scriptIdToUrl = {};
            lastPausedParams = null;
            consoleMessages = [];
            pauseMap = {};
            currentPauseId = null;
            return { content: mcpContent({ status: `Execution resumed until completion. Process exited with code ${exitCode}.` }, options?.format) };
        }
    }
    catch (error) {
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
});
server.tool('step_over', {
    includeScopes: z.boolean().optional(),
    includeStack: z.boolean().optional(),
    includeConsole: z.boolean().optional(),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (options) => {
    if (!nodeDebugClient) {
        return {
            content: [{ type: 'text', text: 'Error: No active debug session.' }],
            isError: true
        };
    }
    try {
        const pausePromise = new Promise((resolve) => {
            nodeDebugClient.Debugger.paused((params) => {
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
            const params = result;
            const topFrame = params.callFrames[0];
            const fileUrl = topFrame.url ||
                scriptIdToUrl[topFrame.location.scriptId] ||
                '<unknown>';
            const line = topFrame.location.lineNumber + 1;
            const payload = {
                status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                pauseId: currentPauseId,
                frame: summarizeFrame(topFrame)
            };
            if (options?.includeConsole) {
                payload.consoleOutput = consoleMessages.slice();
            }
            consoleMessages = [];
            if (options?.includeStack) {
                payload.stack = result.callFrames.map(summarizeFrame);
            }
            if (options?.includeScopes) {
                const scopes = [];
                for (const s of topFrame.scopeChain || []) {
                    if (!s.object || !s.object.objectId)
                        continue;
                    const { result: props } = await nodeDebugClient.Runtime.getProperties({ objectId: s.object.objectId, ownProperties: true });
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
            return { content: mcpContent(payload, options?.format) };
        }
        else {
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
    }
    catch (error) {
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
});
server.tool('step_into', {
    includeScopes: z.boolean().optional(),
    includeStack: z.boolean().optional(),
    includeConsole: z.boolean().optional(),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (options) => {
    if (!nodeDebugClient) {
        return {
            content: [{ type: 'text', text: 'Error: No active debug session.' }],
            isError: true
        };
    }
    try {
        const pausePromise = new Promise((resolve) => {
            nodeDebugClient.Debugger.paused((params) => {
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
            const params = result;
            const topFrame = params.callFrames[0];
            const fileUrl = topFrame.url ||
                scriptIdToUrl[topFrame.location.scriptId] ||
                '<unknown>';
            const line = topFrame.location.lineNumber + 1;
            const payload = {
                status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                pauseId: currentPauseId,
                frame: summarizeFrame(topFrame)
            };
            if (options?.includeConsole)
                payload.consoleOutput = consoleMessages.slice();
            consoleMessages = [];
            if (options?.includeStack)
                payload.stack = result.callFrames.map(summarizeFrame);
            if (options?.includeScopes) {
                const scopes = [];
                for (const s of topFrame.scopeChain || []) {
                    if (!s.object || !s.object.objectId)
                        continue;
                    const { result: props } = await nodeDebugClient.Runtime.getProperties({ objectId: s.object.objectId, ownProperties: true });
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
            return { content: mcpContent(payload, options?.format) };
        }
        else {
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
    }
    catch (error) {
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
});
server.tool('step_out', {
    includeScopes: z.boolean().optional(),
    includeStack: z.boolean().optional(),
    includeConsole: z.boolean().optional(),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (options) => {
    if (!nodeDebugClient) {
        return {
            content: [{ type: 'text', text: 'Error: No active debug session.' }],
            isError: true
        };
    }
    try {
        const pausePromise = new Promise((resolve) => {
            nodeDebugClient.Debugger.paused((params) => {
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
            const params = result;
            const topFrame = params.callFrames[0];
            const fileUrl = topFrame.url ||
                scriptIdToUrl[topFrame.location.scriptId] ||
                '<unknown>';
            const line = topFrame.location.lineNumber + 1;
            const payload = {
                status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                pauseId: currentPauseId,
                frame: summarizeFrame(topFrame)
            };
            if (options?.includeConsole)
                payload.consoleOutput = consoleMessages.slice();
            consoleMessages = [];
            if (options?.includeStack)
                payload.stack = result.callFrames.map(summarizeFrame);
            if (options?.includeScopes) {
                const scopes = [];
                for (const s of topFrame.scopeChain || []) {
                    if (!s.object || !s.object.objectId)
                        continue;
                    const { result: props } = await nodeDebugClient.Runtime.getProperties({ objectId: s.object.objectId, ownProperties: true });
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
            return { content: mcpContent(payload, options?.format) };
        }
        else {
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
    }
    catch (error) {
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
});
server.tool('evaluate_expression', {
    expr: z.string().describe('JavaScript expression to evaluate'),
    pauseId: z.string().optional().describe('Specific pauseId to evaluate in'),
    frameIndex: z.number().min(0).optional().describe('Call frame index within the pause (default 0)'),
    returnByValue: z.boolean().optional().describe('Return primitives by value (default true)'),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (params) => {
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
            const text = evalResponse.exceptionDetails.exception?.description ||
                evalResponse.exceptionDetails.text;
            return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
        }
        const resultObj = evalResponse.result;
        let output;
        if (resultObj.value !== undefined) {
            output = resultObj.value;
        }
        else {
            output = resultObj.description || resultObj.type;
        }
        const outputLogs = consoleMessages.slice();
        consoleMessages = [];
        return { content: mcpContent({ result: output, consoleOutput: outputLogs }, params.format) };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: Evaluation failed - ${error instanceof Error ? error.message : error}`
                }
            ],
            isError: true
        };
    }
});
// Inspect locals/closure scopes at current pause
server.tool('inspect_scopes', {
    maxProps: z.number().min(1).max(50).optional().describe('Maximum properties per scope to include (default 15)'),
    pauseId: z.string().optional().describe('Specific pause to inspect (default current)'),
    frameIndex: z.number().min(0).optional().describe('Call frame index (default 0)'),
    includeThisPreview: z.boolean().optional().describe('Include shallow preview of this (default true)'),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (params) => {
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
    function summarizeValue(v) {
        if (!v)
            return { type: 'undefined' };
        if (v.value !== undefined)
            return { type: typeof v.value, value: v.value };
        return { type: v.type, description: v.description, className: v.className, objectId: v.objectId };
    }
    async function listProps(objectId) {
        const { result } = await nodeDebugClient.Runtime.getProperties({ objectId, ownProperties: true, generatePreview: false });
        const entries = (result || []).slice(0, maxProps).map((p) => ({ name: p.name, ...summarizeValue(p.value) }));
        return entries;
    }
    const scopes = [];
    for (const s of frame.scopeChain || []) {
        if (!s.object || !s.object.objectId)
            continue;
        const props = await listProps(s.object.objectId);
        // Skip huge globals; only include a light summary
        if (s.type === 'global') {
            scopes.push({ type: s.type, variables: props.slice(0, 5), truncated: true });
        }
        else {
            scopes.push({ type: s.type, variables: props });
        }
    }
    let thisSummary = null;
    const includeThis = params.includeThisPreview !== false;
    if (includeThis && frame.this && frame.this.type) {
        const t = frame.this;
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
});
// List current call stack (top N frames)
server.tool('list_call_stack', {
    depth: z.number().min(1).max(50).optional().describe('Maximum frames to include (default 10)'),
    pauseId: z.string().optional(),
    includeThis: z.boolean().optional(),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (params) => {
    if (!nodeDebugClient || !lastPausedParams) {
        return {
            content: [{ type: 'text', text: 'Error: No active pause state.' }],
            isError: true
        };
    }
    const pause = params.pauseId ? pauseMap[params.pauseId] : lastPausedParams;
    if (!pause)
        return { content: [{ type: 'text', text: 'Error: Invalid pauseId.' }], isError: true };
    const depth = params?.depth ?? 10;
    const frames = (pause.callFrames || []).slice(0, depth).map((f) => {
        const base = summarizeFrame(f);
        if (params?.includeThis && f.this)
            base.thisType = f.this.type;
        return base;
    });
    return { content: mcpContent({ frames, pauseId: params.pauseId || currentPauseId }, params.format) };
});
// Provide minimal pause inspection to aid debugging/tests
server.tool('get_pause_info', {
    pauseId: z.string().optional().describe('Specific pause to describe (default current)'),
    format: z.enum(['text', 'json', 'both']).optional()
}, async (args) => {
    if (!lastPausedParams) {
        return {
            content: [{ type: 'text', text: 'Error: No active pause state.' }],
            isError: true
        };
    }
    try {
        const pause = args?.pauseId ? pauseMap[args.pauseId] : lastPausedParams;
        const top = pause.callFrames[0];
        const fileUrl = top.url || scriptIdToUrl[top.location.scriptId] || '<unknown>';
        const info = {
            reason: pause.reason,
            pauseId: args?.pauseId || currentPauseId,
            location: {
                url: fileUrl,
                line: top.location.lineNumber + 1,
                column: (top.location.columnNumber ?? 0) + 1
            },
            functionName: top.functionName || null,
            scopeTypes: (top.scopeChain || []).map((s) => s.type)
        };
        return { content: mcpContent(info, args?.format) };
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: Failed to get pause info - ${error instanceof Error ? error.message : error}`
                }
            ],
            isError: true
        };
    }
});
server.tool('stop_debug_session', {}, async () => {
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
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: Failed to stop debug session - ${error instanceof Error ? error.message : error}`
                }
            ],
            isError: true
        };
    }
});
// Handle process termination
process.on('SIGINT', () => {
    server.close().catch(console.error);
    process.exit(0);
});
