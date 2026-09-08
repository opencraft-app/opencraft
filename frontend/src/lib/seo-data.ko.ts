export const KOREAN_DEFAULT_SEO_TITLE = "LightVela | 나만의 클라우드 AI 에이전트";
export const KOREAN_SEO_TITLE_SUFFIX = "LightVela · 나만의 클라우드 AI 에이전트";
export const KOREAN_SEO_DESCRIPTION =
  "LightVela는 언제든 사용할 수 있는 나만의 AI 에이전트를 클라우드에서 만들고 운영하는 관리형 플랫폼입니다.";
export const KOREAN_SEO_KEYWORDS = [
  "LightVela",
  "클라우드 AI 에이전트",
  "개인 AI 에이전트",
  "AI 어시스턴트",
  "Hermes Agent",
  "AI 에이전트 호스팅",
  "예약 작업",
  "Telegram 봇",
  "WhatsApp 봇",
].join(", ");

export const KOREAN_STATIC_PAGE_TITLES: Record<string, string> = {
  "/about": "LightVela 소개",
  "/account": "계정",
  "/account/orders": "주문 내역",
  "/auth/email-bind-result": "이메일 연결 결과",
  "/auth/forgot-password": "비밀번호 재설정",
  "/auth/invite": "초대 코드",
  "/auth/sign-in": "로그인",
  "/auth/sign-up": "계정 만들기",
  "/auth/sign-up-code": "인증 코드 확인",
  "/blog": "블로그",
  "/changelog": "업데이트 소식",
  "/cookie-policy": "쿠키 정책",
  "/dashboard/create": "에이전트 만들기",
  "/dashboard/setup": "초기 설정",
  "/dashboard/success": "에이전트를 만들었습니다",
  "/open-source-licenses": "오픈 소스 라이선스",
  "/plans/select": "플랜 선택",
  "/privacy-policy": "개인정보 처리방침",
  "/subscribe": "플랜 선택",
  "/support": "지원 및 피드백",
  "/terms-of-service": "서비스 이용약관",
};

const KOREAN_AGENT_SECTION_TITLES: Record<string, string> = {
  achievements: "성과",
  automations: "예약 작업",
  channels: "채널",
  chat: "채팅",
  files: "파일",
  memory: "메모리",
  models: "모델",
  persona: "페르소나",
  skills: "스킬",
  workbench: "워크벤치",
};

export function getKoreanProductPageTitle(pathname: string): string | null {
  if (pathname === "/agents") return "내 에이전트";
  const agentSection = pathname.match(/^\/agents\/([^/]+)$/)?.[1];
  if (agentSection) return KOREAN_AGENT_SECTION_TITLES[agentSection] ?? "내 에이전트";
  return KOREAN_STATIC_PAGE_TITLES[pathname] ?? null;
}

export const KOREAN_DOC_PAGE_TITLES: Record<string, string> = {
  "/docs": "문서",
  "/docs/overview": "LightVela란 무엇인가요",
  "/docs/quickstart": "빠른 시작",
  "/docs/core-concepts": "핵심 개념",
  "/docs/configuration": "설정",
  "/docs/configuration/model": "모델 설정",
  "/docs/configuration/skill": "스킬 설정",
  "/docs/configuration/automation": "예약 작업",
  "/docs/configuration/agent-chat": "채팅",
  "/docs/faq": "자주 묻는 질문",
  "/docs/plans": "요금제",
};

export const KOREAN_PAGE_DESCRIPTIONS: Record<string, string> = {
  "/about":
    "LightVela가 클라우드 AI 에이전트를 쉽고 편리한 관리형 서비스로 제공하는 이유와 앞으로의 방향을 소개합니다.",
  "/blog": "LightVela 블로그에서 클라우드로 호스팅되는 AI 에이전트의 제품 공지, 업데이트, 활용 사례를 소개합니다.",
  "/changelog": "LightVela의 새로운 기능, 제품 업데이트, 사용성 개선 내용을 확인하세요.",
  "/cookie-policy": "LightVela가 사용하는 쿠키의 유형과 목적, 사용자가 선택할 수 있는 관리 방법을 설명합니다.",
  "/open-source-licenses": "LightVela에서 사용하는 오픈 소스 소프트웨어의 저작권 표시와 라이선스 정보입니다.",
  "/privacy-policy": "LightVela의 개인정보 수집, 이용, 보관, 공유 방식과 사용자의 권리를 설명합니다.",
  "/subscribe": "Hermes Agent 사용 방식에 맞는 LightVela 플랜을 선택하세요.",
  "/support": "LightVela에 피드백, 문제 신고, 기능 요청을 보낼 수 있습니다.",
  "/terms-of-service": "LightVela 플랫폼의 접속과 이용에 적용되는 서비스 이용약관입니다.",
  "/docs": "빠른 시작, 핵심 개념, 모델, 채널, 스킬, 예약 작업 설정 방법을 안내하는 LightVela 문서입니다.",
  "/docs/overview":
    "LightVela가 Hermes Agent를 클라우드에서 호스팅해 메모리와 여러 채널을 갖춘 상시 실행 개인 AI 에이전트를 제공하는 방식을 소개합니다.",
};

export type KoreanPublicRoutePath =
  | "/"
  | "/about"
  | "/blog"
  | "/changelog"
  | "/cookie-policy"
  | "/open-source-licenses"
  | "/privacy-policy"
  | "/subscribe"
  | "/terms-of-service";

export function koreanRouteTitle(path: KoreanPublicRoutePath): string {
  const title = path === "/" ? KOREAN_DEFAULT_SEO_TITLE : KOREAN_STATIC_PAGE_TITLES[path];
  if (!title) throw new Error(`[seo-data.ko] missing title for ${path}`);
  return title;
}

export function koreanRouteDescription(path: KoreanPublicRoutePath): string {
  const description = path === "/" ? KOREAN_SEO_DESCRIPTION : KOREAN_PAGE_DESCRIPTIONS[path];
  if (!description) throw new Error(`[seo-data.ko] missing description for ${path}`);
  return description;
}
