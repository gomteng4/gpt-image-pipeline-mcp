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
          summary: "새 프로젝트 생성 (titles 권장)",
          description:
            "**권장 사용법**: titles 배열 (제목 문자열 N개) 만 보냅니다. " +
            "서버가 표준 썸네일 prompt 와 ASCII 안전 파일명을 자동 생성하므로 " +
            "ChatGPT 가 prompts 배열 전체를 컨텍스트에 보유하지 않아 콜라주 시도 자체가 불가능합니다. " +
            "기존 prompts 직접 지정도 호환 유지. 반환된 projectId 를 이후 단계에서 사용.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["projectName"],
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
                    titles: {
                      type: "array",
                      description:
                        "권장: 제목 문자열 배열만 전송. 서버가 표준 썸네일 prompt 와 ASCII 파일명 자동 생성.",
                      items: { type: "string" },
                    },
                    prompts: {
                      type: "array",
                      description: "기존 호환 — prompt 직접 지정 시 사용.",
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
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      projects: {
                        type: "array",
                        items: { type: "object", properties: {} },
                      },
                      count: { type: "integer" },
                    },
                  },
                },
              },
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
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      deletedProjectId: { type: "string" },
                      deletedProjectName: { type: "string" },
                      removedStorage: { type: "integer" },
                    },
                  },
                },
              },
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
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      projectId: { type: "string" },
                      doneCount: { type: "integer" },
                      failedCount: { type: "integer" },
                      results: {
                        type: "array",
                        items: { type: "object", properties: {} },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/projects/{projectId}/add-prompt": {
        post: {
          operationId: "addSinglePrompt",
          summary: "제목 1개 추가 → 프롬프트 즉시 반환 (콜라주 방지 핵심)",
          description:
            "제목 1개를 받아 슬라이드를 추가하고, 서버가 생성한 프롬프트를 즉시 반환합니다. " +
            "반환된 prompt 로 이미지 1장 생성 후 addImagesBatch 를 호출하세요. " +
            "다음 제목으로 이 엔드포인트를 다시 호출하는 방식으로 반복합니다.",
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
                  required: ["title"],
                  properties: {
                    title: { type: "string", description: "이미지 제목 (한 번에 1개만)" },
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
                      slideNo: { type: "integer" },
                      title: { type: "string" },
                      filename: { type: "string" },
                      prompt: { type: "string" },
                      instruction: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/projects/{projectId}/next-prompt": {
        get: {
          operationId: "getNextPrompt",
          summary: "다음 처리할 프롬프트 1개 반환 (자동으로 in_progress 표시)",
          description:
            "프로젝트의 pending 슬라이드 중 가장 작은 slide_no 를 반환하고 status 를 in_progress 로 갱신합니다. " +
            "더 이상 pending 이 없으면 done=true 반환. " +
            "이 엔드포인트로 받은 단 하나의 프롬프트로 정확히 이미지 1장만 생성하고, " +
            "addImagesBatch 로 즉시 저장한 뒤 다시 이 엔드포인트를 호출하는 순차 흐름을 권장합니다.",
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
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      done: { type: "boolean" },
                      slideId: { type: "string" },
                      slideNo: { type: "integer" },
                      title: { type: "string" },
                      filename: { type: "string" },
                      prompt: { type: "string" },
                      instruction: { type: "string" },
                      doneCount: { type: "integer" },
                      message: { type: "string" },
                    },
                  },
                },
              },
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
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      project: { type: "object", properties: {} },
                      slides: {
                        type: "array",
                        items: { type: "object", properties: {} },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
