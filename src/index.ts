#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChromeAPI } from './chrome-api.js';
import { processImage, saveImage } from './image-utils.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import CDP, { Client } from 'chrome-remote-interface';

// Get Chrome debug URL from environment variable or use default
const chromeDebugUrl = process.env.CHROME_DEBUG_URL || 'http://localhost:9222';
console.error(`Using Chrome debug URL: ${chromeDebugUrl}`);

const chromeApi = new ChromeAPI({ baseUrl: chromeDebugUrl });

// Create the MCP server
const server = new McpServer({
    name: 'chrome-tools',
    version: '1.3.0'
});

// Node.js debugging state
let nodeDebugClient: Client | null = null;
let nodeProcess: import('child_process').ChildProcess | null = null;
let scriptIdToUrl: Record<string, string> = {};
let consoleMessages: string[] = [];
let lastPausedParams: any | null = null;

// Add the list_tabs tool
server.tool(
    'list_tabs',
    {}, // No input parameters needed
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
        } catch (error) {
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
    }
);

// Add the capture_screenshot tool
server.tool(
    'capture_screenshot',
    {
        tabId: z.string().describe('ID of the Chrome tab to capture. Only send this unless you are having issues with the result.'),
        format: z.enum(['jpeg', 'png']).optional()
            .describe('Initial capture format (jpeg/png). Note: Final output will be WebP with PNG fallback'),
        quality: z.number().min(1).max(100).optional()
            .describe('Initial capture quality (1-100). Note: Final output uses WebP quality settings'),
        fullPage: z.boolean().optional()
            .describe('Capture full scrollable page')
    },
    async (params) => {
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
            } catch (error) {
                console.error('Image processing failed:', error);
                return {
                    content: [{
                        type: 'text',
                        text: `Error processing screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }],
                    isError: true
                };
            }
        } catch (error) {
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
    }
);

// Add the execute_script tool
server.tool(
    'execute_script',
    {
        tabId: z.string().describe('ID of the Chrome tab to execute the script in'),
        script: z.string().describe('JavaScript code to execute in the tab')
    },
    async (params) => {
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
        } catch (error) {
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
    }
);

// Log when server starts
console.error('Chrome Tools MCP Server starting...');

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);

// Add the load_url tool
server.tool(
    'load_url',
    {
        tabId: z.string().describe('ID of the Chrome tab to load the URL in'),
        url: z.string().url().describe('URL to load in the tab')
    },
    async (params) => {
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
        } catch (error) {
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
    }
);

// Add the capture_network_events tool
server.tool(
    'capture_network_events',
    {
        tabId: z.string().describe('ID of the Chrome tab to monitor'),
        duration: z.number().min(1).max(60).optional()
            .describe('Duration in seconds to capture events (default: 10)'),
        filters: z.object({
            types: z.array(z.enum(['fetch', 'xhr'])).optional()
                .describe('Types of requests to capture'),
            urlPattern: z.string().optional()
                .describe('Only capture URLs matching this pattern')
        }).optional()
    },
    async (params) => {
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
        } catch (error) {
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
    }
);

// Add the query_dom_elements tool
server.tool(
    'query_dom_elements',
    {
        tabId: z.string().describe('ID of the Chrome tab to query'),
        selector: z.string().describe('CSS selector to find elements')
    },
    async (params) => {
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
        } catch (error) {
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
    }
);

// Add the click_element tool
server.tool(
    'click_element',
    {
        tabId: z.string().describe('ID of the Chrome tab containing the element'),
        selector: z.string().describe('CSS selector to find the element to click')
    },
    async (params) => {
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
        } catch (error) {
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
    }
);

// Node.js debugging tools
server.tool(
    'start_node_debug',
    { scriptPath: z.string().describe('Path to the Node.js script to debug') },
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

            return {
                content: [
                    {
                        type: 'text',
                        text: `Debugger attached. Paused at ${fileUrl}:${line} (reason: ${pausedEvent.reason}).`
                    }
                ]
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
    'resume_execution',
    {},
    async () => {
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
                    resolve(params);
                });
            });
            const exitPromise = new Promise((resolve) => {
                nodeProcess?.once('exit', () => resolve(null));
            });
            await nodeDebugClient.Debugger.resume();
            const result = await Promise.race([pausePromise, exitPromise]);
            if (result && typeof result === 'object') {
                const params = result as any;
                const topFrame = params.callFrames[0];
                const fileUrl =
                    topFrame.url ||
                    scriptIdToUrl[topFrame.location.scriptId] ||
                    '<unknown>';
                const line = topFrame.location.lineNumber + 1;
                const output = consoleMessages.slice();
                consoleMessages = [];
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                                    consoleOutput: output
                                },
                                null,
                                2
                            )
                        }
                    ]
                };
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
    {},
    async () => {
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
                const output = consoleMessages.slice();
                consoleMessages = [];
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                                    consoleOutput: output
                                },
                                null,
                                2
                            )
                        }
                    ]
                };
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
    {},
    async () => {
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
                const output = consoleMessages.slice();
                consoleMessages = [];
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                                    consoleOutput: output
                                },
                                null,
                                2
                            )
                        }
                    ]
                };
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
    {},
    async () => {
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
                const output = consoleMessages.slice();
                consoleMessages = [];
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    status: `Paused at ${fileUrl}:${line} (reason: ${params.reason})`,
                                    consoleOutput: output
                                },
                                null,
                                2
                            )
                        }
                    ]
                };
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
        expr: z
            .string()
            .describe('JavaScript expression to evaluate in current pause context')
    },
    async (params) => {
        if (!nodeDebugClient || !lastPausedParams) {
            return {
                content: [{ type: 'text', text: 'Error: No active pause state.' }],
                isError: true
            };
        }
        try {
            const callFrameId = lastPausedParams.callFrames[0].callFrameId;
            const evalResponse = await nodeDebugClient.Debugger.evaluateOnCallFrame({
                callFrameId,
                expression: params.expr,
                includeCommandLineAPI: true,
                returnByValue: true
            });
            if (evalResponse.exceptionDetails) {
                const text =
                    evalResponse.exceptionDetails.exception?.description ||
                    evalResponse.exceptionDetails.text;
                return {
                    content: [{ type: 'text', text: `Error: ${text}` }],
                    isError: true
                };
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
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            { result: output, consoleOutput: outputLogs },
                            null,
                            2
                        )
                    }
                ]
            };
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
