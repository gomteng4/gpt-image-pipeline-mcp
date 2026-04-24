const LICENSE_SERVER_URL =
  process.env.LICENSE_SERVER_URL ||
  "https://naver-blog-production.up.railway.app";

const REQUIRED_FEATURE = "image_pipeline";

interface LicenseCheckResult {
  valid: boolean;
  ownerKey?: string;
  user?: string;
  features?: string[];
  reason?: string;
}

/**
 * Naver_blog 라이선스 서버로 키 검증.
 * - valid=true 이고 features 에 REQUIRED_FEATURE 포함 시 통과.
 * - REQUIRED_FEATURE 체크는 DISABLE_FEATURE_CHECK=1 환경변수로 끌 수 있음 (초기 도입 시).
 */
export async function verifyLicense(key: string | undefined): Promise<LicenseCheckResult> {
  if (!key || key.trim().length === 0) {
    return { valid: false, reason: "X-License-Key 헤더 누락" };
  }
  const cleanKey = key.trim().toUpperCase();

  const url = `${LICENSE_SERVER_URL.replace(/\/$/, "")}/check?key=${encodeURIComponent(
    cleanKey
  )}&run_type=run`;

  try {
    const res = await fetch(url, { method: "GET" });
    const data = (await res.json()) as {
      valid?: boolean;
      user?: string;
      features?: string[];
      reason?: string;
    };
    if (!data.valid) {
      return { valid: false, reason: data.reason ?? "라이선스 무효" };
    }

    const features = data.features ?? [];
    const skipFeatureCheck = process.env.DISABLE_FEATURE_CHECK === "1";
    if (!skipFeatureCheck && !features.includes(REQUIRED_FEATURE)) {
      return {
        valid: false,
        reason: `이 라이선스에는 '${REQUIRED_FEATURE}' 기능 권한이 없습니다.`,
      };
    }

    return {
      valid: true,
      ownerKey: cleanKey,
      user: data.user,
      features,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, reason: `라이선스 서버 통신 실패: ${msg}` };
  }
}
