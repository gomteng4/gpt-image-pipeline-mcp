#!/usr/bin/env node
import "dotenv/config";
import express, { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getSupabase, getBucket } from "./lib/supabase.js";
import { generateImage } from "./lib/openai.js";
import { verifyLicense } from "./lib/license.js";
import {
  savePromptsSchema,
  handleSavePrompts,
} from "./tools/save_prompts.js";
import { handleDeleteProject } from "./tools/delete_project.js";
import { handleListProjects } from "./tools/list_projects.js";
import { handleSaveGeneratedImagesBatch } from "./tools/save_generated_images_batch.js";
import { buildOpenApiSpec } from "./openapi.js";
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

app.use(express.json({ limit: "100mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "gpt-image-pipeline-mcp" });
});

interface BatchItem {
  slideNo: number;
  title?: string;
  filename?: string;
  prompt: string;
}

interface BatchGenerateBody {
  projectName: string;
  targetPath?: string;
  thumbnailMode?: boolean;
  slideSize?: string;
  size?: "1024x1024" | "1536x1024" | "1024x1536" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  items: BatchItem[];
}

// 승인 0번 경로: 웹앱 → 이 엔드포인트 → OpenAI Images API → Supabase
app.post("/batch-generate", async (req, res) => {
  const body = req.body as BatchGenerateBody;
  if (!body?.projectName || !Array.isArray(body?.items) || body.items.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "projectName 과 items[] 가 필수입니다.",
    });
  }

  const sb = getSupabase();
  const bucket = getBucket();

  const { data: project, error: projErr } = await sb
    .from("projects")
    .insert({
      name: body.projectName,
      slide_size: body.slideSize ?? null,
      target_path: body.targetPath ?? null,
      thumbnail_mode: body.thumbnailMode ?? false,
    })
    .select()
    .single();

  if (projErr || !project) {
    return res.status(500).json({
      ok: false,
      error: `프로젝트 생성 실패: ${projErr?.message}`,
    });
  }

  const promptRows = body.items.map((it) => ({
    project_id: project.id,
    slide_no: it.slideNo,
    title: it.title ?? null,
    prompt: it.prompt,
    filename: it.filename ?? null,
    status: "in_progress",
  }));

  const { error: insErr } = await sb.from("slide_prompts").insert(promptRows);
  if (insErr) {
    await sb.from("projects").delete().eq("id", project.id);
    return res.status(500).json({
      ok: false,
      error: `프롬프트 저장 실패: ${insErr.message}`,
    });
  }

  const results: Array<{
    slideNo: number;
    status: "done" | "failed";
    storagePath?: string;
    error?: string;
  }> = [];

  const size = body.size ?? "1024x1024";
  const quality = body.quality ?? "high";

  for (const it of body.items) {
    try {
      const img = await generateImage(it.prompt, size, quality);
      const buffer = Buffer.from(img.base64, "base64");

      const filename =
        (it.filename && it.filename.replace(/[\\/]/g, "_").trim()) ||
        `slide-${it.slideNo}.png`;
      const storagePath = `projects/${project.id}/${filename}`;

      const { error: upErr } = await sb.storage
        .from(bucket)
        .upload(storagePath, buffer, {
          contentType: img.mimeType,
          upsert: true,
        });
      if (upErr) throw new Error(`storage upload: ${upErr.message}`);

      await sb
        .from("slide_prompts")
        .update({
          status: "done",
          storage_path: storagePath,
          error_message: null,
        })
        .eq("project_id", project.id)
        .eq("slide_no", it.slideNo);

      results.push({ slideNo: it.slideNo, status: "done", storagePath });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb
        .from("slide_prompts")
        .update({ status: "failed", error_message: msg })
        .eq("project_id", project.id)
        .eq("slide_no", it.slideNo);
      results.push({ slideNo: it.slideNo, status: "failed", error: msg });
    }
  }

  return res.json({
    ok: true,
    projectId: project.id,
    projectName: project.name,
    targetPath: project.target_path,
    doneCount: results.filter((r) => r.status === "done").length,
    failedCount: results.filter((r) => r.status === "failed").length,
    results,
  });
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

// =============================================================
// Custom GPT Actions 용 REST API (라이선스 헤더 기반)
// =============================================================

const licenseRouter = express.Router();

licenseRouter.use(async (req, res, next) => {
  const key = (req.header("X-License-Key") || "").trim();
  const result = await verifyLicense(key);
  if (!result.valid) {
    return res.status(403).json({ ok: false, error: result.reason });
  }
  (req as any).ownerKey = result.ownerKey;
  (req as any).user = result.user;
  next();
});

// POST /api/projects — save_prompts 래퍼
licenseRouter.post("/projects", async (req, res) => {
  try {
    const args = { ...req.body, ownerKey: (req as any).ownerKey };
    const result = await handleSavePrompts(args);
    res.json({ ok: true, ...result });
  } catch (e: unknown) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /api/projects — 내 프로젝트 목록
licenseRouter.get("/projects", async (req, res) => {
  try {
    const nameContains = typeof req.query.nameContains === "string" ? req.query.nameContains : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await handleListProjects({
      nameContains,
      limit,
      ownerKey: (req as any).ownerKey,
    });
    res.json({ ok: true, ...result });
  } catch (e: unknown) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// DELETE /api/projects/:projectId — delete_project 래퍼
licenseRouter.delete("/projects/:projectId", async (req, res) => {
  try {
    const confirmName = (req.query.confirmName as string) || (req.body?.confirmName as string) || "";
    const result = await handleDeleteProject({
      projectId: req.params.projectId,
      confirmName,
      ownerKey: (req as any).ownerKey,
    });
    res.json(result);
  } catch (e: unknown) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /api/projects/:projectId/images/batch — 여러 장 한 번에 저장
licenseRouter.post("/projects/:projectId/images/batch", async (req, res) => {
  try {
    const result = await handleSaveGeneratedImagesBatch({
      projectId: req.params.projectId,
      images: req.body?.images || [],
      ownerKey: (req as any).ownerKey,
    });
    res.json(result);
  } catch (e: unknown) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /api/projects/:projectId/status — 진행 상태 조회
licenseRouter.get("/projects/:projectId/status", async (req, res) => {
  const sb = getSupabase();
  try {
    const { data: project } = await sb
      .from("projects")
      .select("id, name, slide_size, target_path, thumbnail_mode, created_at, owner_key")
      .eq("id", req.params.projectId)
      .maybeSingle();
    if (!project) return res.status(404).json({ ok: false, error: "프로젝트 없음" });
    const ownerKey = (req as any).ownerKey;
    if (project.owner_key && ownerKey && project.owner_key !== ownerKey) {
      return res.status(403).json({ ok: false, error: "소유자 아님" });
    }
    const { data: slides } = await sb
      .from("slide_prompts")
      .select("slide_no, title, filename, status, storage_path, error_message")
      .eq("project_id", req.params.projectId)
      .order("slide_no", { ascending: true });
    res.json({ ok: true, project, slides: slides ?? [] });
  } catch (e: unknown) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.use("/api", licenseRouter);

// OpenAPI 스펙 (Custom GPT Actions 가 import 하는 엔드포인트)
app.get("/openapi.json", (req, res) => {
  const host = req.get("host") || "localhost:3333";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.") || host.startsWith("0.");
  const proto = req.header("x-forwarded-proto") || (isLocal ? "http" : "https");
  const publicUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
  res.json(buildOpenApiSpec(publicUrl));
});

// Privacy Policy (Custom GPT Actions 등록 시 필수)
app.get("/privacy", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>gpt-image-pipeline · Privacy Policy</title></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.7">
<h1>개인정보 처리방침</h1>
<p>본 서비스(<code>gpt-image-pipeline</code>)는 Naver_blog 라이선스 소유자의 이미지 파이프라인 운영을 위한 내부 도구입니다.</p>
<h2>수집 정보</h2>
<ul>
<li>라이선스 키 (X-License-Key 헤더)</li>
<li>프로젝트 이름·프롬프트·생성된 이미지</li>
</ul>
<h2>보관·이용</h2>
<ul>
<li>Supabase Storage 에 암호화 저장</li>
<li>라이선스 소유자 본인만 조회·다운로드 가능</li>
<li>제3자 제공 없음</li>
</ul>
<h2>문의</h2>
<p>운영자 이메일로 문의.</p>
</body></html>`);
});

const port = Number(process.env.PORT ?? 3333);
app.listen(port, () => {
  process.stderr.write(
    `[gpt-image-pipeline] MCP HTTP server listening on :${port} (POST /mcp, /api/*, /openapi.json)\n`
  );
});
