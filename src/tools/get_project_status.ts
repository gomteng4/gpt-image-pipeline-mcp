import { getSupabase } from "../lib/supabase.js";

export const getProjectStatusSchema = {
  name: "get_project_status",
  description: "프로젝트의 전체 슬라이드 진행 상태를 요약합니다 (done / pending / in_progress / failed).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "프로젝트 uuid" },
    },
    required: ["projectId"],
  },
} as const;

interface Args {
  projectId: string;
}

export async function handleGetProjectStatus(args: Args) {
  const sb = getSupabase();

  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("id, name, slide_size, target_path, thumbnail_mode, created_at")
    .eq("id", args.projectId)
    .maybeSingle();

  if (projErr) {
    throw new Error(`프로젝트 조회 실패: ${projErr.message}`);
  }
  if (!project) {
    throw new Error(`프로젝트를 찾을 수 없습니다: ${args.projectId}`);
  }

  const { data: slides, error: slErr } = await sb
    .from("slide_prompts")
    .select("slide_no, title, filename, status, storage_path, error_message")
    .eq("project_id", args.projectId)
    .order("slide_no", { ascending: true });

  if (slErr) {
    throw new Error(`슬라이드 조회 실패: ${slErr.message}`);
  }

  const counts = { pending: 0, in_progress: 0, done: 0, failed: 0 };
  for (const s of slides ?? []) {
    if (s.status in counts) counts[s.status as keyof typeof counts] += 1;
  }

  return {
    project,
    counts,
    total: slides?.length ?? 0,
    slides: slides ?? [],
  };
}
