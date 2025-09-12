# devtools-debugger-mcp

An MCP server exposing full Chrome DevTools Protocol debugging for Node.js applications (breakpoints, stepping, scopes, call stacks, eval, and source maps) and Chrome tab automation (JS execution, screenshots, network monitoring, navigation, DOM actions).

## Why use an MCP server like this?
This type of MCP Server is useful When you need to manually configure your browser to be in a certain state before you let an AI tool like Cline poke at it. You can also use this tool to listen to and pull network events into its context. 

## Features

- Full Node.js debugger: breakpoints, conditional breakpoints, logpoints, pause-on-exceptions
- Stepping: step over/into/out, continue to location, restart frame
- Inspection: locals/closure scopes, `this` preview, object property drill-down
- Evaluate expressions in the current call frame with console capture
- Call-stack and pause-state introspection
- Chrome automation: list tabs, execute JS, navigate, capture screenshots, query/click DOM, monitor network

## Installation

```bash
npm install devtools-debugger-mcp
```

## Configuration

The server can be configured through environment variables in your MCP settings:

```json
{
  "devtools-debugger-mcp": {
    "command": "node",
    "args": ["path/to/devtools-debugger-mcp/dist/index.js"],
    "env": {
      "CHROME_DEBUG_URL": "http://localhost:9222",
      "CHROME_CONNECTION_TYPE": "direct",
      "CHROME_ERROR_HELP": "custom error message"
    }
  }
}
```

Alternatively, if installed locally, you can point to the CLI binary:

```json
{
  "devtools-debugger-mcp": {
    "command": "devtools-debugger-mcp",
    "env": {
      "CHROME_DEBUG_URL": "http://localhost:9222"
    }
  }
}
```

## Node.js Debugging

This MCP server can debug Node.js programs by launching your script with the built‑in inspector (`--inspect-brk=0`) and speaking the Chrome DevTools Protocol (CDP).

How it works
- `start_node_debug` spawns `node --inspect-brk=0 your-script.js`, waits for the inspector WebSocket, attaches, and returns the initial pause (first line) with a `pauseId` and top call frame.
- You can then set breakpoints (by file path or URL regex), choose pause-on-exceptions, and resume/step. At each pause, tools can inspect scopes, evaluate expressions, and read console output captured since the last step/resume.
- When the process exits, the server cleans up the CDP session and resets its state.

Quickstart (from an MCP-enabled client)
1) Start a debug session
```json
{ "tool": "start_node_debug", "params": { "scriptPath": "/absolute/path/to/app.js" } }
```
2) Set a breakpoint (file path + 1-based line)
```json
{ "tool": "set_breakpoint", "params": { "filePath": "/absolute/path/to/app.js", "line": 42 } }
```
3) Run to next pause (optionally include console/stack)
```json
{ "tool": "resume_execution", "params": { "includeConsole": true, "includeStack": true } }
```
4) Inspect at a pause
```json
{ "tool": "inspect_scopes", "params": { "maxProps": 15 } }
{ "tool": "evaluate_expression", "params": { "expr": "user.name" } }
```
5) Step
```json
{ "tool": "step_over" }
{ "tool": "step_into" }
{ "tool": "step_out" }
```
6) Finish
```json
{ "tool": "stop_debug_session" }
```

Node.js tool reference (summary)
- `start_node_debug({ scriptPath, format? })` — Launches Node with inspector and returns initial pause.
- `set_breakpoint({ filePath, line })` — Breakpoint by file path (1-based line).
- `set_breakpoint_condition({ filePath?, urlRegex?, line, column?, condition, format? })` — Conditional breakpoint or by URL regex.
- `add_logpoint({ filePath?, urlRegex?, line, column?, message, format? })` — Logpoint via conditional breakpoint that logs and returns `false`.
- `set_exception_breakpoints({ state })` — `none | uncaught | all`.
- `blackbox_scripts({ patterns })` — Ignore frames from matching script URLs.
- `list_scripts()` / `get_script_source({ scriptId? | url? })` — Discover and fetch script sources.
- `continue_to_location({ filePath, line, column? })` — Run until a specific source location.
- `restart_frame({ frameIndex, pauseId?, format? })` — Re-run the selected frame.
- `resume_execution({ includeScopes?, includeStack?, includeConsole?, format? })` — Continue to next pause or exit.
- `step_over|step_into|step_out({ includeScopes?, includeStack?, includeConsole?, format? })` — Stepping with optional context in the result.
- `evaluate_expression({ expr, pauseId?, frameIndex?, returnByValue?, format? })` — Evaluate in a paused frame; defaults to top frame.
- `inspect_scopes({ maxProps?, pauseId?, frameIndex?, includeThisPreview?, format? })` — Locals/closures and `this` summary.
- `get_object_properties({ objectId, maxProps?, format? })` — Drill into object previews.
- `list_call_stack({ depth?, pauseId?, includeThis?, format? })` — Top N frames summary.
- `get_pause_info({ pauseId?, format? })` — Pause reason/location summary.
- `read_console({ format? })` — Console messages since the last step/resume.
- `stop_debug_session()` — Kill process and detach.

Notes
- File paths are converted to `file://` URLs internally for CDP compatibility.
- `line` is 1-based; CDP is 0-based internally.
- The server buffers console output between pauses; fetch via `includeConsole` on step/resume or with `read_console`.
- Use `set_output_format({ format: 'text' | 'json' | 'both' })` to set default response formatting.

### Environment Variables

- `CHROME_DEBUG_URL`: The URL where Chrome's remote debugging interface is available (default: http://localhost:9222)
- `CHROME_CONNECTION_TYPE`: Connection type identifier for logging (e.g., "direct", "ssh-tunnel", "docker")
- `CHROME_ERROR_HELP`: Custom error message shown when connection fails

## Setup Guide

### Native Setup (Windows/Mac/Linux)

1. Launch Chrome with remote debugging enabled:
   ```bash
   # Windows
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

   # Mac
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

   # Linux
   google-chrome --remote-debugging-port=9222
   ```

2. Configure MCP settings:
   ```json
   {
     "env": {
       "CHROME_DEBUG_URL": "http://localhost:9222",
       "CHROME_CONNECTION_TYPE": "direct"
     }
   }
   ```

### WSL Setup

When running in WSL, you'll need to set up an SSH tunnel to connect to Chrome running on Windows:

1. Launch Chrome on Windows with remote debugging enabled
2. Create an SSH tunnel:
   ```bash
   ssh -N -L 9222:localhost:9222 windowsuser@host
   ```
3. Configure MCP settings:
   ```json
   {
     "env": {
       "CHROME_DEBUG_URL": "http://localhost:9222",
       "CHROME_CONNECTION_TYPE": "ssh-tunnel",
       "CHROME_ERROR_HELP": "Make sure the SSH tunnel is running: ssh -N -L 9222:localhost:9222 windowsuser@host"
     }
   }
   ```

### Docker Setup

When running Chrome in Docker:

1. Launch Chrome container:
   ```bash
   docker run -d --name chrome -p 9222:9222 chromedp/headless-shell
   ```

2. Configure MCP settings:
   ```json
   {
     "env": {
       "CHROME_DEBUG_URL": "http://localhost:9222",
       "CHROME_CONNECTION_TYPE": "docker"
     }
   }
   ```

## Tools

### list_tabs
Lists all available Chrome tabs.

### execute_script
Executes JavaScript code in a specified tab.
Parameters:
- `tabId`: ID of the Chrome tab
- `script`: JavaScript code to execute

### capture_screenshot
Captures a screenshot of a specified tab, automatically optimizing it for AI model consumption.
Parameters:
- `tabId`: ID of the Chrome tab
- `format`: Image format (jpeg/png) - Note: This is only for initial capture. Final output uses WebP with PNG fallback
- `quality`: JPEG quality (1-100) - Note: For initial capture only
- `fullPage`: Capture full scrollable page

Image Processing:
1. WebP Optimization (Primary Format):
   - First attempt: WebP with quality 80 and high compression effort
   - Second attempt: WebP with quality 60 and near-lossless compression if first attempt exceeds 1MB
2. PNG Fallback:
   - Only used if WebP processing fails
   - Includes maximum compression and color palette optimization
3. Size Constraints:
   - Maximum dimensions: 900x600 (maintains aspect ratio)
   - Maximum file size: 1MB
   - Progressive size reduction if needed

### capture_network_events
Monitors and captures network events from a specified tab.
Parameters:
- `tabId`: ID of the Chrome tab
- `duration`: Duration in seconds to capture
- `filters`: Optional type and URL pattern filters

### load_url
Navigates a tab to a specified URL.
Parameters:
- `tabId`: ID of the Chrome tab
- `url`: URL to load

### query_dom_elements
Queries and retrieves detailed information about DOM elements matching a CSS selector.
Parameters:
- `tabId`: ID of the Chrome tab
- `selector`: CSS selector to find elements
Returns:
- Array of DOM elements with properties including:
  - `nodeId`: Unique identifier for the node
  - `tagName`: HTML tag name
  - `textContent`: Text content of the element
  - `attributes`: Object containing all element attributes
  - `boundingBox`: Position and dimensions of the element
  - `isVisible`: Whether the element is visible
  - `ariaAttributes`: ARIA attributes for accessibility

### click_element
Clicks on a DOM element and captures any console output triggered by the click.
Parameters:
- `tabId`: ID of the Chrome tab
- `selector`: CSS selector to find the element to click
Returns:
- Object containing:
  - `message`: Success/failure message
  - `consoleOutput`: Array of console messages triggered by the click

### Node.js Debugger Tools

See the dedicated "Node.js Debugging" section above for quickstart and the complete tool reference.

## License

MIT
