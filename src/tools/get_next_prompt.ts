import { getSupabase } from "../lib/supabase.js";

export const getNextPromptSchema = {
  name: "get_next_prompt",
  description:
    "다음으로 처리할 프롬프트 1개를 반환합니다. 슬라이드 번호가 가장 작은 pending 항목을 선택하고 status 를 in_progress 로 변경합니다. " +
    "더 이상 pending 이 없으면 done=true 를 반환합니다.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "save_prompts 가 반환한 projectId (uuid)",
      },
    },
    required: ["projectId"],
  },
} as const;

interface Args {
  projectId: string;
}

export async function handleGetNextPrompt(args: Args) {
  const sb = getSupabase();

  const { data: next, error } = await sb
    .from("slide_prompts")
    .select("id, slide_no, title, prompt, status, filename")
    .eq("project_id", args.projectId)
    .eq("status", "pending")
    .order("slide_no", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`조회 실패: ${error.message}`);
  }

  if (!next) {
    const { count } = await sb
      .from("slide_prompts")
      .select("id", { count: "exact", head: true })
      .eq("project_id", args.projectId)
      .eq("status", "done");

    return {
      done: true,
      message: "더 이상 pending 프롬프트가 없습니다.",
      doneCount: count ?? 0,
    };
  }

  const { error: updErr } = await sb
    .from("slide_prompts")
    .update({ status: "in_progress" })
    .eq("id", next.id);

  if (updErr) {
    throw new Error(`status 갱신 실패: ${updErr.message}`);
  }

  return {
    done: false,
    slideId: next.id,
    slideNo: next.slide_no,
    title: next.title,
    prompt: next.prompt,
    filename: next.filename,
    instruction:
      "이 프롬프트로 이미지 1장을 생성한 뒤, 즉시 save_generated_image 툴을 호출해 파일을 전달하세요. " +
      "image_url 사용 금지 — 반드시 파일 자체를 base64 로 전달합니다. " +
      (next.filename
        ? `최종 저장 파일명은 '${next.filename}' 로 이미 지정되어 있습니다.`
        : "파일명은 자동(slide-{N}.png) 으로 부여됩니다."),
  };
}
