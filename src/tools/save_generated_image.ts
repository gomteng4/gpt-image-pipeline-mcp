import { getSupabase, getBucket } from "../lib/supabase.js";

export const saveGeneratedImageSchema = {
  name: "save_generated_image",
  description:
    "GPT가 방금 생성한 이미지 파일을 받아 Supabase Storage 에 저장하고 해당 슬라이드 status 를 done 으로 갱신합니다. " +
    "★ 이 툴은 URL 방식을 쓰지 않습니다. 반드시 파일 자체(base64) 를 전달하세요. " +
    "한 번에 1장씩만 처리하며, 여러 슬라이드를 묶어서 보내지 마세요.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "프로젝트 uuid" },
      slideNo: {
        type: "number",
        description: "해당 이미지의 슬라이드 번호 (get_next_prompt 가 반환한 값)",
      },
      files: {
        type: "array",
        description:
          "이미지 파일 배열. 일반적으로 1개만. 2개 이상 보내면 첫 번째 파일만 사용됩니다.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "파일명 (예: 'slide-3.png'). 확장자 기반 content-type 추론에 사용.",
            },
            mimeType: {
              type: "string",
              description: "MIME 타입 (예: 'image/png', 'image/jpeg'). 선택 — name 으로 추론 가능.",
            },
            data: {
              type: "string",
              description:
                "base64 인코딩된 파일 내용 (data URL prefix 'data:image/png;base64,' 는 있어도 없어도 됨).",
            },
          },
          required: ["name", "data"],
        },
        minItems: 1,
      },
    },
    required: ["projectId", "slideNo", "files"],
  },
} as const;

interface FileInput {
  name: string;
  mimeType?: string;
  data: string;
}

interface Args {
  projectId: string;
  slideNo: number;
  files: FileInput[];
}

function stripDataUrlPrefix(s: string): string {
  const match = s.match(/^data:[^;]+;base64,(.*)$/);
  return match ? match[1] : s;
}

function inferMime(name: string, provided?: string): string {
  if (provided) return provided;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function extFromMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

export async function handleSaveGeneratedImage(args: Args) {
  if (!args.files?.length) {
    throw new Error("files 배열이 비어 있습니다.");
  }

  const sb = getSupabase();
  const bucket = getBucket();

  const file = args.files[0];
  const mime = inferMime(file.name, file.mimeType);
  const ext = extFromMime(mime);

  let buffer: Buffer;
  try {
    buffer = Buffer.from(stripDataUrlPrefix(file.data), "base64");
  } catch (e: unknown) {
    throw new Error(
      `base64 디코딩 실패: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (buffer.length === 0) {
    throw new Error("파일 데이터가 비어 있습니다.");
  }

  const { data: slide, error: fetchErr } = await sb
    .from("slide_prompts")
    .select("id, slide_no, filename")
    .eq("project_id", args.projectId)
    .eq("slide_no", args.slideNo)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`슬라이드 조회 실패: ${fetchErr.message}`);
  }
  if (!slide) {
    throw new Error(
      `이미지 항목을 찾을 수 없습니다. projectId=${args.projectId}, slideNo=${args.slideNo}`
    );
  }

  const sanitized =
    typeof slide.filename === "string" && slide.filename.trim().length > 0
      ? slide.filename.replace(/[\\/]/g, "_").trim()
      : null;
  const finalName = sanitized ?? `slide-${args.slideNo}.${ext}`;
  const storagePath = `projects/${args.projectId}/${finalName}`;

  const { error: upErr } = await sb.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: mime,
      upsert: true,
    });

  if (upErr) {
    await sb
      .from("slide_prompts")
      .update({
        status: "failed",
        error_message: `storage upload: ${upErr.message}`,
      })
      .eq("id", slide.id);
    throw new Error(`Storage 업로드 실패: ${upErr.message}`);
  }

  const { error: updErr } = await sb
    .from("slide_prompts")
    .update({
      status: "done",
      storage_path: storagePath,
      error_message: null,
    })
    .eq("id", slide.id);

  if (updErr) {
    throw new Error(`DB 업데이트 실패: ${updErr.message}`);
  }

  const { data: signed } = await sb.storage
    .from(bucket)
    .createSignedUrl(storagePath, 60 * 60);

  return {
    ok: true,
    slideNo: args.slideNo,
    storagePath,
    bucket,
    size: buffer.length,
    mimeType: mime,
    signedUrl: signed?.signedUrl ?? null,
    message: `슬라이드 ${args.slideNo} 저장 완료. 다음 단계: get_next_prompt 재호출.`,
  };
}
