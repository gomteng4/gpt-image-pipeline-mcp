import { getSupabase, getBucket } from "../lib/supabase.js";

export const deleteProjectSchema = {
  name: "delete_project",
  description:
    "프로젝트 전체를 삭제합니다 (Supabase Storage 파일 + DB 레코드). " +
    "안전 가드: projectId 에 대응하는 프로젝트 이름과 confirmName 이 일치해야 삭제됨.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "삭제할 프로젝트의 uuid" },
      confirmName: {
        type: "string",
        description: "안전 가드 — 해당 프로젝트의 정확한 이름 입력",
      },
    },
    required: ["projectId", "confirmName"],
  },
} as const;

interface Args {
  projectId: string;
  confirmName: string;
  ownerKey?: string | null;
}

export async function handleDeleteProject(args: Args) {
  const sb = getSupabase();
  const bucket = getBucket();

  const query = sb.from("projects").select("id, name, owner_key").eq("id", args.projectId);
  const { data: project, error: fetchErr } = await query.maybeSingle();
  if (fetchErr) throw new Error(`프로젝트 조회 실패: ${fetchErr.message}`);
  if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${args.projectId}`);

  if (project.name !== args.confirmName) {
    throw new Error(
      `confirmName 이 일치하지 않습니다. 실제 이름="${project.name}" vs 입력="${args.confirmName}"`
    );
  }

  if (args.ownerKey && project.owner_key && project.owner_key !== args.ownerKey) {
    throw new Error("이 프로젝트의 소유자가 아닙니다.");
  }

  const { data: slides } = await sb
    .from("slide_prompts")
    .select("storage_path")
    .eq("project_id", args.projectId);

  const paths = (slides ?? [])
    .map((s) => s.storage_path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  if (paths.length > 0) {
    await sb.storage.from(bucket).remove(paths).catch(() => {});
  }

  const { error: delErr } = await sb.from("projects").delete().eq("id", args.projectId);
  if (delErr) throw new Error(`삭제 실패: ${delErr.message}`);

  return {
    ok: true,
    deletedProjectId: args.projectId,
    deletedProjectName: project.name,
    removedStorage: paths.length,
  };
}
