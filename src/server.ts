#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const server = new Server(
  {
    name: "gpt-image-pipeline",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${req.params.name}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await handler(req.params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[gpt-image-pipeline] MCP server listening on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`[gpt-image-pipeline] fatal: ${e}\n`);
  process.exit(1);
});
