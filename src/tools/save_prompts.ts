import { getSupabase } from "../lib/supabase.js";

export const savePromptsSchema = {
  name: "save_prompts",
  description:
    "프로젝트를 생성하고 이미지별 프롬프트 배열을 저장합니다. " +
    "이 MCP 는 범용 이미지 파이프라인입니다 — 썸네일 / 본문 이미지 / 슬라이드 / 카드뉴스 등 " +
    "어느 용도든 동일한 방식으로 처리합니다. " +
    "이미 동일한 projectName 이 있으면 새로 만듭니다 (중복 허용). " +
    "반환된 projectId 는 이후 모든 툴 호출에서 사용합니다.",
  inputSchema: {
    type: "object",
    properties: {
      projectName: {
        type: "string",
        description: "프로젝트 이름 (예: '2026-04 선불폰 썸네일 배치' / '영어 회화 PPT')",
      },
      slideSize: {
        type: "string",
        description: "이미지 해상도 문자열 (예: '1920x1080', '1200x630'). 선택 사항.",
      },
      targetPath: {
        type: "string",
        description:
          "ZIP 다운로드 시 풀릴 로컬 경로 힌트. 예: '콘텐츠/ommeca/썸네일/'. " +
          "ZIP 내부에 이 경로의 마지막 폴더명으로 디렉터리가 생성됨. 선택.",
      },
      thumbnailMode: {
        type: "boolean",
        description:
          "true 면 Naver_blog 의 `콘텐츠/{계정}/썸네일/` 배치용으로 표시. 웹앱 UI 에 배지 표시. 선택 (기본 false).",
      },
      prompts: {
        type: "array",
        description: "이미지별 프롬프트 배열",
        items: {
          type: "object",
          properties: {
            slideNo: { type: "number", description: "이미지 번호 (1부터)" },
            title: { type: "string", description: "이미지의 원본 제목 (선택, 썸네일 배치 시 필수)" },
            prompt: { type: "string", description: "이미지 생성 프롬프트" },
            filename: {
              type: "string",
              description:
                "저장·다운로드 파일명. 예: 'thumbnail.png', 'image_1.png', " +
                "'01_SKT_미납_선불폰_셀프_개통.png'. 확장자 포함. " +
                "생략 시 자동 'slide-{N}.png'. 선택.",
            },
          },
          required: ["slideNo", "prompt"],
        },
      },
    },
    required: ["projectName", "prompts"],
  },
} as const;

interface PromptInput {
  slideNo: number;
  title?: string;
  prompt: string;
  filename?: string;
}

interface SavePromptsArgs {
  projectName: string;
  slideSize?: string;
  targetPath?: string;
  thumbnailMode?: boolean;
  prompts: PromptInput[];
  ownerKey?: string | null;
}

export async function handleSavePrompts(args: SavePromptsArgs) {
  const sb = getSupabase();

  if (!args.prompts?.length) {
    throw new Error("prompts 배열이 비어 있습니다.");
  }

  const { data: project, error: projErr } = await sb
    .from("projects")
    .insert({
      name: args.projectName,
      slide_size: args.slideSize ?? null,
      target_path: args.targetPath ?? null,
      thumbnail_mode: args.thumbnailMode ?? false,
      owner_key: args.ownerKey ?? null,
    })
    .select()
    .single();

  if (projErr || !project) {
    throw new Error(`프로젝트 생성 실패: ${projErr?.message}`);
  }

  const rows = args.prompts.map((p) => ({
    project_id: project.id,
    slide_no: p.slideNo,
    title: p.title ?? null,
    prompt: p.prompt,
    filename: p.filename ?? null,
    status: "pending",
    owner_key: args.ownerKey ?? null,
  }));

  const { error: insErr } = await sb.from("slide_prompts").insert(rows);
  if (insErr) {
    // 프롬프트 저장 실패 시 프로젝트 롤백 (cascade 로 자동)
    await sb.from("projects").delete().eq("id", project.id);
    throw new Error(`프롬프트 저장 실패: ${insErr.message}`);
  }

  return {
    projectId: project.id,
    projectName: project.name,
    totalPrompts: rows.length,
    message: `${rows.length}개 프롬프트가 저장되었습니다. 다음 단계: get_next_prompt 호출.`,
  };
}
