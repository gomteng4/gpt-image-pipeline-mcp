import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다. .env 를 확인하세요."
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function getBucket(): string {
  return process.env.SUPABASE_BUCKET || "generated-slides";
}

/**
 * Supabase Storage(S3 호환) 는 객체 키에 한글/특수문자 거부 ("Invalid key" 에러).
 * 표시용 filename 은 그대로 두되, 실제 storage path 에 쓸 안전한 ASCII 문자열로 변환.
 *
 * 변환 규칙:
 * - 영문/숫자/_/-/. 만 유지
 * - 그 외 (한글·공백·특수) → "_"
 * - 연속된 _ 압축, 양끝 _ 제거
 * - 빈 문자열이면 "file" 반환
 */
export function safeStorageKey(name: string): string {
  if (!name) return "file";
  let s = name.replace(/[^A-Za-z0-9._-]/g, "_");
  s = s.replace(/_+/g, "_");
  s = s.replace(/^[_.]+|[_.]+$/g, "");
  return s.length > 0 ? s : "file";
}
