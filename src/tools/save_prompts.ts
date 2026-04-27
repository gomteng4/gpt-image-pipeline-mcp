import { getSupabase } from "../lib/supabase.js";

export const savePromptsSchema = {
  name: "save_prompts",
  description:
    "프로젝트를 생성하고 이미지별 프롬프트를 저장합니다. " +
    "**권장 사용법**: titles 배열만 보내면 서버가 표준 템플릿으로 prompts 자동 생성 (콜라주 방지). " +
    "기존 prompts 배열 직접 지정도 호환 유지. " +
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
      titles: {
        type: "array",
        description:
          "**권장**: 제목 문자열 배열만 보냅니다. 서버가 각 제목으로 표준 썸네일 prompt 와 안전한 ASCII 파일명을 자동 생성. " +
          "이렇게 하면 GPT 가 prompt 배열 전체를 컨텍스트에 보유하지 않아 콜라주 시도 자체가 불가능.",
        items: { type: "string" },
      },
      prompts: {
        type: "array",
        description:
          "기존 호환용 — prompt 직접 지정. titles 와 동시 사용 가능 (titles 우선 처리 후 prompts 항목은 별도 슬라이드로 추가).",
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
    required: ["projectName"],
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
  titles?: string[];
  prompts?: PromptInput[];
  ownerKey?: string | null;
}

/** 제목을 ASCII 안전 파일명 키워드로 변환 (영문/숫자/언더스코어). */
function titleToAsciiSlug(title: string): string {
  // 한글·특수문자를 모두 제거하고 영문 소문자/숫자만 남김
  // 매우 단순한 규칙: 공백 → 단일 _, 기타 문자 제거
  let s = (title || "").trim().toLowerCase();
  s = s.replace(/[^\x20-\x7e]/g, ""); // non-ASCII 제거
  s = s.replace(/[^\w\s-]/g, "");      // 영숫자·_·공백·하이픈 외 제거
  s = s.replace(/[\s-]+/g, "_");        // 공백/하이픈 → _
  s = s.replace(/_+/g, "_");
  s = s.replace(/^_|_$/g, "");
  return s || "image";
}

/** 제목 → 표준 썸네일 prompt (단일 이미지 강제, 콜라주 차단). */
function buildThumbnailPrompt(title: string): string {
  return (
    `Modern minimal blog thumbnail for the topic "${title}". ` +
    `Square 1024x1024, single standalone image, flat design, clean white or solid color background, ` +
    `bold sans-serif Korean title typography. ` +
    `Strictly NO collage, NO grid, NO multiple panels, NO split layout. ` +
    `Output exactly ONE image.`
  );
}

export async function handleSavePrompts(args: SavePromptsArgs) {
  const sb = getSupabase();

  // titles 또는 prompts 중 하나는 있어야 함
  const hasTitles = Array.isArray(args.titles) && args.titles.length > 0;
  const hasPrompts = Array.isArray(args.prompts) && args.prompts.length > 0;
  if (!hasTitles && !hasPrompts) {
    throw new Error("titles 또는 prompts 중 하나는 필수입니다.");
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

  // 슬라이드 row 빌드 — titles 우선, 그 다음 prompts
  type Row = {
    project_id: string;
    slide_no: number;
    title: string | null;
    prompt: string;
    filename: string | null;
    status: string;
    owner_key: string | null;
  };
  const rows: Row[] = [];

  if (hasTitles) {
    args.titles!.forEach((t, idx) => {
      const slideNo = idx + 1;
      const slug = titleToAsciiSlug(t);
      const num = String(slideNo).padStart(2, "0");
      rows.push({
        project_id: project.id,
        slide_no: slideNo,
        title: t,
        prompt: buildThumbnailPrompt(t),
        filename: `${num}_${slug}.png`,
        status: "pending",
        owner_key: args.ownerKey ?? null,
      });
    });
  }

  if (hasPrompts) {
    const startNo = rows.length;
    args.prompts!.forEach((p, idx) => {
      rows.push({
        project_id: project.id,
        slide_no: p.slideNo ?? startNo + idx + 1,
        title: p.title ?? null,
        prompt: p.prompt,
        filename: p.filename ?? null,
        status: "pending",
        owner_key: args.ownerKey ?? null,
      });
    });
  }

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
    message:
      `${rows.length}개 프롬프트가 저장되었습니다. ` +
      `다음 단계: getNextPrompt 호출 → 단일 prompt 받기 → ChatGPT 가 1장만 생성 → addImagesBatch (배열 길이 1) → getNextPrompt 반복. ` +
      `절대 한 번에 여러 장 생성하지 마세요.`,
  };
}
