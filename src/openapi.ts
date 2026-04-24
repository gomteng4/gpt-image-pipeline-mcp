/**
 * Custom GPT Actions 용 OpenAPI 3.1 스펙 생성.
 * ChatGPT 의 "Import from URL" 에 이 엔드포인트(/openapi.json) 를 넣으면 자동 로드.
 */

export function buildOpenApiSpec(publicUrl: string) {
  const serverUrl = publicUrl.replace(/\/$/, "");
  return {
    openapi: "3.1.0",
    info: {
      title: "gpt-image-pipeline",
      description:
        "블로그 썸네일·본문 이미지 등 배치 이미지 파이프라인. " +
        "Naver_blog 라이선스 키(X-License-Key 헤더) 로 인증.",
      version: "1.0.0",
    },
    servers: [{ url: serverUrl }],
    security: [{ LicenseKeyAuth: [] }],
    components: {
      securitySchemes: {
        LicenseKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-License-Key",
          description:
            "Naver_blog 라이선스 키. 관리자로부터 발급받은 값.",
        },
      },
      schemas: {
        PromptItem: {
          type: "object",
          required: ["slideNo", "prompt"],
          properties: {
            slideNo: { type: "integer", description: "이미지 번호 (1부터)" },
            title: { type: "string", description: "이미지 원본 제목" },
            filename: {
              type: "string",
              description:
                "저장 파일명 (예: '01_SKT_미납_선불폰.png'). 생략 시 자동.",
            },
            prompt: { type: "string", description: "이미지 생성 프롬프트" },
          },
        },
        ImageItem: {
          type: "object",
          required: ["slideNo"],
          properties: {
            slideNo: { type: "integer" },
            filename: { type: "string" },
            data: {
              type: "string",
              description: "base64 인코딩된 이미지 (data 또는 imageUrl 중 하나 필수)",
            },
            imageUrl: {
              type: "string",
              description: "이미지 URL — 서버가 즉시 다운로드 (우선순위 높음)",
            },
            mimeType: { type: "string", description: "예: 'image/png'" },
          },
        },
      },
    },
    paths: {
      "/api/projects": {
        post: {
          operationId: "createProject",
          summary: "새 프로젝트 생성 (프롬프트 배열 저장)",
          description:
            "이미지 생성 전에 프로젝트와 프롬프트 목록을 저장합니다. " +
            "반환된 projectId 를 이후 이미지 저장 단계에서 사용.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["projectName", "prompts"],
                  properties: {
                    projectName: { type: "string" },
                    slideSize: {
                      type: "string",
                      description: "예: '1024x1024', '1200x630'",
                    },
                    targetPath: {
                      type: "string",
                      description:
                        "ZIP 다운로드 시 대상 폴더 힌트. 예: '콘텐츠/ommeca/썸네일/'",
                    },
                    thumbnailMode: { type: "boolean" },
                    prompts: {
                      type: "array",
                      items: { $ref: "#/components/schemas/PromptItem" },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "성공",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      projectId: { type: "string" },
                      projectName: { type: "string" },
                      totalPrompts: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        get: {
          operationId: "listProjects",
          summary: "내 프로젝트 목록",
          parameters: [
            {
              name: "nameContains",
              in: "query",
              schema: { type: "string" },
              description: "이름 부분 일치 필터 (선택)",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer" },
              description: "최대 개수 (기본 50)",
            },
          ],
          responses: {
            "200": {
              description: "성공",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/projects/{projectId}": {
        delete: {
          operationId: "deleteProject",
          summary: "프로젝트 전체 삭제 (이미지 + DB)",
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "confirmName",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "안전 가드 — 해당 프로젝트 이름 정확히 입력",
            },
          ],
          responses: {
            "200": {
              description: "삭제 성공",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/projects/{projectId}/images/batch": {
        post: {
          operationId: "addImagesBatch",
          summary: "여러 이미지를 한 번에 저장 (추천)",
          description:
            "프로젝트의 여러 이미지를 base64 또는 URL 로 한 번에 업로드. " +
            "팝업 승인 최소화를 위해 항상 이 엔드포인트를 사용할 것.",
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["images"],
                  properties: {
                    images: {
                      type: "array",
                      items: { $ref: "#/components/schemas/ImageItem" },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "성공",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/projects/{projectId}/status": {
        get: {
          operationId: "getProjectStatus",
          summary: "프로젝트 진행 상태 조회",
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "성공",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };
}
