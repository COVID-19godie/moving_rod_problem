#!/usr/bin/env node
"use strict";

const process = require("node:process");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, JSONRPCMessageSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const {
  describeMovingRodSchemaTool,
  measureMovingRodTool,
  simulateMovingRodTool
} = require("./simulator");

function stringifyJson(value) {
  return JSON.stringify(value);
}

function tryDecodeLine(buffer, encoding) {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/\r$/, "").replace(/^\uFEFF/, "");
    return JSONRPCMessageSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function decodeMessageBuffer(buffer) {
  const candidates = ["utf-8", "utf-16le"];
  if (process.platform === "win32") {
    candidates.push("gb18030", "gbk");
  }
  for (const encoding of candidates) {
    const parsed = tryDecodeLine(buffer, encoding);
    if (parsed) {
      return parsed;
    }
  }
  return JSONRPCMessageSchema.parse(JSON.parse(buffer.toString("utf8").replace(/\r$/, "").replace(/^\uFEFF/, "")));
}

function looksLikeUtf16Le(buffer) {
  const sampleLength = Math.min(buffer.length, 96);
  if (sampleLength < 4) {
    return false;
  }
  let zeroCount = 0;
  let oddZeroCount = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      zeroCount += 1;
      if (index % 2 === 1) {
        oddZeroCount += 1;
      }
    }
  }
  return zeroCount >= sampleLength / 6 && oddZeroCount >= zeroCount / 2;
}

class WindowsCompatibleStdioServerTransport extends StdioServerTransport {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    super(stdin, stdout);
    this._stdin = stdin;
    this._buffer = Buffer.alloc(0);
    this._startedCompat = false;
    this._onCompatData = chunk => {
      this._buffer = this._buffer.length > 0 ? Buffer.concat([this._buffer, chunk]) : chunk;
      this._processCompatBuffer();
    };
    this._onCompatError = error => this.onerror?.(error);
  }

  async start() {
    if (this._startedCompat) {
      throw new Error("WindowsCompatibleStdioServerTransport already started");
    }
    this._startedCompat = true;
    this._stdin.on("data", this._onCompatData);
    this._stdin.on("error", this._onCompatError);
  }

  _processCompatBuffer() {
    while (this._buffer.length > 0) {
      const utf16 = looksLikeUtf16Le(this._buffer);
      const delimiter = utf16 ? Buffer.from([0x0a, 0x00]) : Buffer.from([0x0a]);
      const index = this._buffer.indexOf(delimiter);
      if (index === -1) {
        break;
      }
      const rawLine = this._buffer.subarray(0, index);
      this._buffer = this._buffer.subarray(index + delimiter.length);
      if (rawLine.length === 0) {
        continue;
      }
      try {
        this.onmessage?.(decodeMessageBuffer(rawLine));
      } catch (error) {
        this.onerror?.(error);
      }
    }
  }

  async close() {
    this._stdin.off("data", this._onCompatData);
    this._stdin.off("error", this._onCompatError);
    if (this._stdin.listenerCount("data") === 0) {
      this._stdin.pause();
    }
    this._buffer = Buffer.alloc(0);
    this.onclose?.();
  }
}

const tools = [
  {
    name: "moving_rod_simulate_scene",
    description: "Simulate the segmented inclined-track single-rod or double-rod problem and return structured time-series evidence.",
    inputSchema: {
      type: "object",
      properties: {
        scene: { type: "object" },
        solve_options: {
          type: "object",
          properties: {
            dt: { type: "number" },
            t_end: { type: "number" },
            max_steps: { type: "number" },
            sample_every: { type: "number" }
          }
        }
      },
      required: ["scene"]
    }
  },
  {
    name: "moving_rod_measure_scene",
    description: "Measure a prior moving-rod simulation by run_id or inline simulation payload using compact structured queries.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        simulation: { type: "object" },
        query: { type: "object" }
      },
      required: ["query"]
    }
  },
  {
    name: "moving_rod_describe_scene_schema",
    description: "Describe the supported scene schema, query schema, and examples for the moving-rod MCP.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

async function callToolByName(name, args) {
  if (name === "moving_rod_simulate_scene") {
    const result = await simulateMovingRodTool(args || {});
    return { content: [{ type: "text", text: stringifyJson(result) }], structuredContent: result };
  }
  if (name === "moving_rod_measure_scene") {
    const result = await measureMovingRodTool(args || {});
    return { content: [{ type: "text", text: stringifyJson(result) }], structuredContent: result };
  }
  if (name === "moving_rod_describe_scene_schema") {
    const result = describeMovingRodSchemaTool();
    return { content: [{ type: "text", text: stringifyJson(result) }], structuredContent: result };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function createServer() {
  const server = new Server(
    { name: "moving_rod_mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    try {
      return await callToolByName(name, args || {});
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: stringifyJson({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }],
        isError: true
      };
    }
  });

  return server;
}

async function main() {
  if (process.stdout.setDefaultEncoding) {
    process.stdout.setDefaultEncoding("utf8");
  }
  const transport = new WindowsCompatibleStdioServerTransport();
  const server = createServer();
  await server.connect(transport);
  console.error("moving_rod_mcp started");
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  main,
  tools
};
