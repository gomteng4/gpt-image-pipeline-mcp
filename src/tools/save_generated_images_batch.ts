import { getSupabase, getBucket, safeStorageKey } from "../lib/supabase.js";

export const saveGeneratedImagesBatchSchema = {
  name: "save_generated_images_batch",
  description:
    "여러 장의 이미지를 한 번에 저장합니다 (추천 — 승인 팝업 절약). " +
    "부분 실패 허용: 성공한 것은 done, 실패한 것은 failed + error_message 기록.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "프로젝트 uuid" },
      images: {
        type: "array",
        description: "이미지 배열 — 각 아이템에 data(base64) 또는 imageUrl 중 하나",
        items: {
          type: "object",
          properties: {
            slideNo: { type: "number" },
            filename: {
              type: "string",
              description: "파일명. 지정 안 하면 DB 에 저장된 filename 사용 또는 자동",
            },
            data: {
              type: "string",
              description:
                "base64 인코딩된 이미지 데이터. 우선순위 2 (imageUrl 이 있으면 그쪽 우선).",
            },
            imageUrl: {
              type: "string",
              description:
                "이미지 URL (GPT 가 방금 생성한 이미지). 서버가 즉시 다운로드. 우선순위 1.",
            },
            mimeType: {
              type: "string",
              description: "MIME 타입. 생략 시 image/png 가정.",
            },
          },
          required: ["slideNo"],
        },
      },
    },
    required: ["projectId", "images"],
  },
} as const;

interface ImageInput {
  slideNo: number;
  filename?: string;
  data?: string;
  imageUrl?: string;
  mimeType?: string;
}

interface Args {
  projectId: string;
  images: ImageInput[];
  ownerKey?: string | null;
}

function stripDataUrl(s: string): string {
  const m = s.match(/^data:[^;]+;base64,(.*)$/);
  return m ? m[1] : s;
}

async function fetchImageBytes(url: string): Promise<{ buffer: Buffer; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`imageUrl 다운로드 실패: HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || "image/png";
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), mime };
}

/**
 * 이미지 시그니처 검증 — 손상된/빈 데이터 거부.
 * PNG: 89 50 4E 47, JPEG: FF D8 FF, WebP: RIFF...WEBP, GIF: GIF8
 */
function validateImageSignature(buffer: Buffer): { ok: boolean; detected?: string; reason?: string } {
  if (buffer.length < 12) {
    return { ok: false, reason: `데이터가 너무 작음 (${buffer.length}B)` };
  }
  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { ok: true, detected: "image/png" };
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ok: true, detected: "image/jpeg" };
  }
  // WebP (RIFF....WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { ok: true, detected: "image/webp" };
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { ok: true, detected: "image/gif" };
  }
  return {
    ok: false,
    reason: `알 수 없는 이미지 포맷 (signature: ${Array.from(buffer.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")})`,
  };
}

export async function handleSaveGeneratedImagesBatch(args: Args) {
  if (!args.images?.length) throw new Error("images 배열이 비어 있습니다.");
  const sb = getSupabase();
  const bucket = getBucket();

  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("id, owner_key")
    .eq("id", args.projectId)
    .maybeSingle();
  if (projErr) throw new Error(`프로젝트 조회 실패: ${projErr.message}`);
  if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${args.projectId}`);
  if (args.ownerKey && project.owner_key && project.owner_key !== args.ownerKey) {
    throw new Error("이 프로젝트의 소유자가 아닙니다.");
  }

  const results: Array<{
    slideNo: number;
    status: "done" | "failed";
    storagePath?: string;
    error?: string;
  }> = [];

  for (const img of args.images) {
    try {
      const { data: slide } = await sb
        .from("slide_prompts")
        .select("id, filename")
        .eq("project_id", args.projectId)
        .eq("slide_no", img.slideNo)
        .maybeSingle();
      if (!slide) throw new Error(`slide_no ${img.slideNo} 없음`);

      let buffer: Buffer;
      let mime = img.mimeType ?? "image/png";

      if (img.imageUrl && img.imageUrl.length > 0) {
        const fetched = await fetchImageBytes(img.imageUrl);
        buffer = fetched.buffer;
        if (!img.mimeType) mime = fetched.mime;
      } else if (img.data && img.data.length > 0) {
        buffer = Buffer.from(stripDataUrl(img.data), "base64");
      } else {
        throw new Error("data 또는 imageUrl 중 하나는 필수");
      }
      if (buffer.length === 0) throw new Error("빈 이미지 데이터");

      const sig = validateImageSignature(buffer);
      if (!sig.ok) {
        throw new Error(
          `이미지 시그니처 검증 실패: ${sig.reason}. ` +
            `재시도하세요. base64 가 잘렸거나 손상되었을 가능성 있습니다.`
        );
      }
      if (sig.detected) mime = sig.detected;

      const ext = mime.includes("jpeg") ? "jpg" : mime.split("/")[1] ?? "png";
      // 표시용 (한글 OK)
      const displayFilename =
        (img.filename && img.filename.replace(/[\\/]/g, "_").trim()) ||
        (slide.filename ?? `slide-${img.slideNo}.${ext}`);
      // Storage 키 (ASCII only, S3 호환)
      const storageFilename =
        safeStorageKey(displayFilename) || `slide-${img.slideNo}.${ext}`;
      const storagePath = `projects/${args.projectId}/${storageFilename}`;

      const { error: upErr } = await sb.storage
        .from(bucket)
        .upload(storagePath, buffer, { contentType: mime, upsert: true });
      if (upErr) throw new Error(`storage upload: ${upErr.message}`);

      await sb
        .from("slide_prompts")
        .update({
          status: "done",
          storage_path: storagePath,
          error_message: null,
          filename: displayFilename,
        })
        .eq("id", slide.id);

      results.push({ slideNo: img.slideNo, status: "done", storagePath });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb
        .from("slide_prompts")
        .update({ status: "failed", error_message: msg })
        .eq("project_id", args.projectId)
        .eq("slide_no", img.slideNo);
      results.push({ slideNo: img.slideNo, status: "failed", error: msg });
    }
  }

  return {
    ok: true,
    projectId: args.projectId,
    doneCount: results.filter((r) => r.status === "done").length,
    failedCount: results.filter((r) => r.status === "failed").length,
    results,
  };
}
