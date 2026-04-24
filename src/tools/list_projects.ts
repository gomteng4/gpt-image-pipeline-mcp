import { getSupabase } from "../lib/supabase.js";

export const listProjectsSchema = {
  name: "list_projects",
  description:
    "프로젝트 목록을 반환합니다 (최신순). nameContains 를 주면 이름으로 필터링.",
  inputSchema: {
    type: "object",
    properties: {
      nameContains: {
        type: "string",
        description: "프로젝트 이름에 포함된 부분 문자열 (대소문자 무시). 선택.",
      },
      limit: {
        type: "number",
        description: "최대 반환 개수 (기본 50).",
      },
    },
  },
} as const;

interface Args {
  nameContains?: string;
  limit?: number;
  ownerKey?: string | null;
}

export async function handleListProjects(args: Args) {
  const sb = getSupabase();

  let q = sb
    .from("projects")
    .select("id, name, slide_size, target_path, thumbnail_mode, created_at, owner_key")
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 50);

  if (args.ownerKey) {
    q = q.eq("owner_key", args.ownerKey);
  }
  if (args.nameContains && args.nameContains.length > 0) {
    q = q.ilike("name", `%${args.nameContains}%`);
  }

  const { data: projects, error } = await q;
  if (error) throw new Error(`목록 조회 실패: ${error.message}`);

  const result = [];
  for (const p of projects ?? []) {
    const { count: total } = await sb
      .from("slide_prompts")
      .select("id", { count: "exact", head: true })
      .eq("project_id", p.id);
    const { count: done } = await sb
      .from("slide_prompts")
      .select("id", { count: "exact", head: true })
      .eq("project_id", p.id)
      .eq("status", "done");
    result.push({
      id: p.id,
      name: p.name,
      slideSize: p.slide_size,
      targetPath: p.target_path,
      thumbnailMode: p.thumbnail_mode,
      createdAt: p.created_at,
      total: total ?? 0,
      done: done ?? 0,
    });
  }

  return { projects: result, count: result.length };
}
