#!/usr/bin/env node
import "dotenv/config";
import express, { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  savePromptsSchema,
  handleSavePrompts,
} from "./tools/save_prompts.js";
import {
  getNextPromptSchema,
  handleGetNextPrompt,
} from "./tools/get_next_prompt.js";
import {
  saveGeneratedImageSchema,
  handleSaveGeneratedImage,
} from "./tools/save_generated_image.js";
import {
  getProjectStatusSchema,
  handleGetProjectStatus,
} from "./tools/get_project_status.js";

const TOOLS = [
  savePromptsSchema,
  getNextPromptSchema,
  saveGeneratedImageSchema,
  getProjectStatusSchema,
];

const HANDLERS: Record<string, (args: unknown) => Promise<unknown>> = {
  save_prompts: (args) => handleSavePrompts(args as any),
  get_next_prompt: (args) => handleGetNextPrompt(args as any),
  save_generated_image: (args) => handleSaveGeneratedImage(args as any),
  get_project_status: (args) => handleGetProjectStatus(args as any),
};

function buildServer(): Server {
  const server = new Server(
    {
      name: "gpt-image-pipeline",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = HANDLERS[req.params.name];
    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await handler(req.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

const app = express();

app.use(express.json({ limit: "50mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "gpt-image-pipeline-mcp" });
});

app.all("/mcp", async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e: unknown) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: e instanceof Error ? e.message : String(e),
        },
        id: null,
      });
    }
  }
});

const port = Number(process.env.PORT ?? 3333);
app.listen(port, () => {
  process.stderr.write(
    `[gpt-image-pipeline] MCP HTTP server listening on :${port} (POST /mcp)\n`
  );
});
