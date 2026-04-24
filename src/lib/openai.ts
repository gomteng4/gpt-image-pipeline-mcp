import OpenAI from "openai";

let cached: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (cached) return cached;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY 환경변수가 필요합니다. Railway Variables 또는 .env 를 확인하세요."
    );
  }
  cached = new OpenAI({ apiKey: key });
  return cached;
}

export interface GeneratedImage {
  base64: string;
  mimeType: string;
}

/**
 * gpt-image-1 모델로 단일 이미지 생성.
 * 반환: { base64, mimeType }
 */
export async function generateImage(
  prompt: string,
  size: "1024x1024" | "1536x1024" | "1024x1536" | "auto" = "1024x1024",
  quality: "low" | "medium" | "high" | "auto" = "high"
): Promise<GeneratedImage> {
  const client = getOpenAI();

  const res = await client.images.generate({
    model: "gpt-image-1",
    prompt,
    size,
    quality,
    n: 1,
  });

  const data = res.data?.[0];
  if (!data || !data.b64_json) {
    throw new Error("OpenAI 이미지 응답에 b64_json 이 없습니다.");
  }

  return {
    base64: data.b64_json,
    mimeType: "image/png",
  };
}
