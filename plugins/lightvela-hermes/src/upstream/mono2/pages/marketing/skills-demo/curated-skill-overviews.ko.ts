// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { CuratedSkillOverview } from "./curated-skill-overviews";

type KoreanSkillDefinition = {
  name: string;
  purpose: string;
  input: string;
  outcome: string;
  prompt: string;
};

function makeOverview(definition: KoreanSkillDefinition): CuratedSkillOverview {
  const { name, purpose, input, outcome, prompt } = definition;
  return {
    overview: [
      `${name}은(는) ${purpose} 위한 스킬입니다.`,
      `${input}을(를) 지정하면 작업을 구조화하고 ${outcome}을(를) 얻도록 도와줍니다.`,
    ],
    whoShouldUse: [
      { title: "실무 담당자", description: `명확한 절차로 ${purpose} 필요가 있는 사람에게 적합합니다.` },
      { title: "운영팀", description: `${input}에서 실제로 활용할 수 있는 결과물을 만들고 싶은 팀에게 적합합니다.` },
      { title: "의사결정자", description: `행동하기 전에 ${outcome}을(를) 확인하고 싶은 사람에게 적합합니다.` },
    ],
    problemsItSolves: [
      { title: "정보의 분포", description: "이 모든 것들이 필요한 배경으로" },
      { title: "결과물 품질", description: `${outcome}을(를) 만들 수 있도록 작업을 구조화합니다.` },
      { title: "그리고 다시 반복해서", description: "그리고 우리는 같은 종류의 요청에 대해" },
    ],
    keyCapabilities: [
      { title: "구조화된 분석", description: `${purpose} 위해 필요한 작업을 단계별로 나눕니다.` },
      { title: "맥락 반영", description: `${input}에 맞게 제안을 조정합니다.` },
      { title: "명확한 출력", description: `${outcome}을(를) 확인하기 쉬운 형태로 제시합니다.` },
      { title: "이 방법은", description: "그리고 우리는 이 모든 것을 통해" },
    ],
    basicUsage: `${input}을(를) 전달하고 중요한 제약 조건과 필요한 판단 및 결과물을 설명하세요. 적용하기 전에 ${name}의 출력을 확인하세요.`,
    examplePrompt: prompt,
  };
}

const DEFINITIONS: Record<string, KoreanSkillDefinition> = {
  "charon-fan/agent-playbook/self-improving-agent": {
    name: "Self-Improving Agent", purpose: "우리는 과거 실행, 실패, 수정에서", input: "이 모든 것이", outcome: "이 모든 것이", prompt: "이 실패한 실행을 다시 한번 생각해보고, 다시 사용할 수 있는 교훈과 다음 번에 적용하기 전에 검증하는 방법을 제안해 주세요.",
  },
  "vercel-labs/skills/find-skills": {
    name: "Find Skills", purpose: "특정 작업에 맞는 전문 스킬를 찾아보세요.", input: "그리고 그 모든 것은", outcome: "이 모든 것은 스킬 후보와 관련한 설치 방법입니다.", prompt: "경쟁사의 가격 페이지를 비교하고, 주마다 변경사항을 정리할 수 있는 스킬를 찾아보세요.",
  },
  "steipete/clawdis/weather": {
    name: "Weather", purpose: "현재 날씨와 예측을 확인해", input: "그리고 그 도시, 지역, 공항, 좌표, 그리고 우리가 원하는 날짜의 범위", outcome: "기상정보는 기획을 위해", prompt: "금요일부터 일요일까지 교토의 날씨와 야외에서 가장 좋은 오후를 알려주세요.",
  },
  "juliusbrussee/caveman/caveman": {
    name: "Caveman", purpose: "그리고 그 모든 기술적인 정보를 남기고", input: "그리고 그 모든 것을", outcome: "그리고 그 답은 간단하고 간단하고 즉각적인 행동으로 옮길 수 있습니다.", prompt: "이 세 가지 명령어들을 설명해 주세요.",
  },
  "mattpocock/skills/to-issues": {
    name: "To Issues", purpose: "이 문제를 해결하기 위해", input: "이 모든 것이", outcome: "그리고 그 모든 것이", prompt: "승인된 PRD를 검토할 수 있는 수직분열문제로 나눌 수 있습니다.",
  },
  "roin-orca/skills/simple": {
    name: "Simple", purpose: "그리고 그 아이디어는", input: "이 모든 것은", outcome: "이 모든 것은", prompt: "이 기능을 정리하고, 가능한 두 가지 아이디어를 비교하고, 실행하기 전에 선택한 정책을 기록하세요.",
  },
  "gracefullight/stock-checker/stock-analysis": {
    name: "Stock Analysis", purpose: "그리고, 이 모든 것을", input: "이 모든 것은", outcome: "그리고 이 모든 것이", prompt: "이 표지판을 실적, 변동, 트렌드, 위험에서 분석하고, 사실과 추측을 구분해 보세요.",
  },
  "molezzz/openclaw-stock-skill/akshare-stock": {
    name: "AKShare Stock", purpose: "AKShare에서 얻을 수 있는 금융 데이터를", input: "자산을 확인하고 중국 시장에 대한 지표와 날짜를 확인하고", outcome: "그리고, 이 모든 것이", prompt: "이 회사의 최근 데이터를 가져와 평가, 성과, 주식 이동을 정리해 보세요.",
  },
  "anthropics/financial-services-plugins/earnings-analysis": {
    name: "Earnings Analysis", purpose: "자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자, 자", input: "이 모든 것은", outcome: "그리고 그 결과, 우리는", prompt: "이분기 재정을 분석하고, 이전분기와 시장 예측의 변화를 강조합니다.",
  },
  "okx/agent-skills/okx-sentiment-tracker": {
    name: "OKX Sentiment Tracker", purpose: "그리고 이 모든 것들이", input: "자산을, 자료를, 기간을,", outcome: "시장 배경과 신호를 포함하는 센티멘트 개요", prompt: "7일 동안 BTC와 ETH의 성분을 추적하고, 급변에 대한 원인으로 알려주세요.",
  },
  "phuryn/pm-skills/sentiment-analysis": {
    name: "Sentiment Analysis", purpose: "그리고 그 다음에는,", input: "이 모든 것은", outcome: "그리고 그 주제, 감정의 강도, 대표적인 예입니다.", prompt: "이 리뷰를 분석하고 주제별로 정리해 주어야 합니다.",
  },
  "personamanagmentlayer/pcl/finance-expert": {
    name: "Finance Expert", purpose: "그리고 그 결과, 우리는", input: "이 자료는 우리가 재무에 대해 어떻게 판단하고 있는지", outcome: "그리고 그 시나리오와 한계를 포함해서", prompt: "이 두 가지 재무제안들을 비교하고, 그 두 가지 예제를 제시하고, 보수적이고, 기본적이고, 낙관적인 세 가지 시나리오를 만들어 보세요.",
  },
  "coreyhaines31/marketingskills/content-strategy": {
    name: "Content Strategy", purpose: "그리고 그 모든 것을", input: "우리의 독자, 제품, 채널, 목표, 기존 콘텐츠", outcome: "그리고 그 모든 것이", prompt: "이 제품에서 4분기 콘텐츠 전략을 세우고 주제, 형태, 배포, 지표까지 포함해 주세요.",
  },
  "coreyhaines31/marketingskills/social-content": {
    name: "Social Content", purpose: "그리고 저는 이 모든 SNS에 대해", input: "브랜드는 물론이고, 독자들도, 플랫폼도, 음색도, 캠페인이", outcome: "이 모든 것은", prompt: "이 발표를 한 주 동안 링크드인과 X에 게시하여 같은 문장을 반복하지 않도록 하세요.",
  },
  "composiohq/awesome-claude-skills/content-research-writer": {
    name: "Content Research Writer", purpose: "그리고 그 주제들을 연구하고,", input: "이 책에서, 저는 이 책을 읽었습니다.", outcome: "그리고 그 이유는", prompt: "이 주제에 대해 연구하고 개발자를 위한 기사를 만들고, 그 원본과 확인을 주장하는 것을 보여주세요.",
  },
  "googleworkspace/cli/persona-content-creator": {
    name: "Persona Content Creator", purpose: "이 모든 것은 페르소나와", input: "페르소나, 목적, 채널, 음향, 참고 자료", outcome: "그리고 그 모든 것은", prompt: "기술에 대해 신중하게 생각하는 독자들에게는, 이 광고를 과장하지 않고 솔직하게 써주세요.",
  },
  "resciencelab/opc-skills/seo-geo": {
    name: "SEO GEO", purpose: "검색 및 생성 인공지능 응답에서 쉽게 찾을 수 있는", input: "이 모든 것이", outcome: "기술, 편집, 구조화된 데이터의 개선에 대한 우선 순위", prompt: "이 가격 페이지를 SEO와 GEO의 관점에서 검토하고 구조, 인용, JSON-LD의 개선에 우선순위를 표시해 주세요.",
  },
  "mattpocock/skills/edit-article": {
    name: "Edit Article", purpose: "이 기사는 우리가 어떻게 해야 하는지", input: "이 글은 문헌, 독자, 음향, 편집 제한입니다.", outcome: "이 글은 더 쉽게 읽을 수 있는", prompt: "먼저 문장 순서로 기사를 표시하고, 그 다음 기술적인 주장을 바꾸지 않고 기사를 편집하십시오.",
  },
  "karpathy/nanochat/read-arxiv-paper": {
    name: "Read arXiv Paper", purpose: "이 모든 것을 알 수 있습니다.", input: "이 문서는", outcome: "이 모든 것이", prompt: "이 arXiv 기사를 읽어보세요. 주요한 기여와 방법, 근거와 한계를 설명해 주세요.",
  },
  "googleworkspace/cli/persona-researcher": {
    name: "Persona Researcher", purpose: "그리고 그 주제들은", input: "페르소나, 질문, 조사 범위, 사용 가능한 자료", outcome: "이 책에서", prompt: "이 제품 범위를 중소기업 IT 관리자의 관점에서 조사하고 판단 기준과 질문, 우려를 정리해 보세요.",
  },
  "nexscope-ai/amazon-skills/amazon-product-research": {
    name: "Amazon Product Research", purpose: "아마존의 상품과 시장 기회를 조사합니다.", input: "이 모든 것이 다른 종류의 제품입니다.", outcome: "그리고, 우리는 이 문제를 해결하기 위해", prompt: "아마존에 있는 이 카테고리를 조사하고 수요와 경쟁, 리뷰 문제, 차별화 기회를 비교해 보세요.",
  },
  "coreyhaines31/marketingskills/customer-research": {
    name: "Customer Research", purpose: "고객들의 목소리와 메시지를", input: "인터뷰, 리뷰, 설문조사, 질문, 대상 부문", outcome: "그리고, 우리는 이 문제를 해결하고,", prompt: "이 인터뷰를 분석하고, 도전과 목표, 반대, 대표적인 발언을 지도로 그려보세요.",
  },
  "firecrawl/firecrawl-workflows/firecrawl-market-research": {
    name: "Firecrawl Market Research", purpose: "인터넷에서 정보를 수집하고", input: "이 모든 것이 바로", outcome: "이 모든 것은", prompt: "이 시장에 대해 조사하고 경쟁사 5개를 비교하고 그 결과를 뒷받침하는 페이지를 참조하세요.",
  },
  "firecrawl/firecrawl-workflows/firecrawl-deep-research": {
    name: "Firecrawl Deep Research", purpose: "그리고 그 결과,", input: "그 결과, 우리는 이 문제를 해결하기 위해", outcome: "이 모든 것이", prompt: "이 질문을 자세히 조사하고, 자료를 비교하여 결론, 불확실성, 해결되지 않은 부분을 구분해 보세요.",
  },
  "anthropics/skills/pdf": {
    name: "PDF", purpose: "PDF에서 정보를 읽고 추출하고 비교합니다.", input: "이 자료를 수집하고, 비교하고, 요약하는", outcome: "이 문서의 위치와 연결된 구조적 정보입니다.", prompt: "이 두 PDF를 비교하고, 각 조건의 차이를 보여드리겠습니다.",
  },
  "coreyhaines31/marketingskills/image": {
    name: "Image", purpose: "그리고 저는 마케팅 영상을", input: "그 이유는, 그 이유는, 그 이유는, 그 이유는,", outcome: "이 사진들을 만드는 데 사용할 수 있는", prompt: "이 발표를 위해 세 가지 시각적인 디자인을 생각해 보세요. 각각의 영상 제작 프로프트를 만들어 보세요.",
  },
  "github/awesome-copilot/prd": {
    name: "PRD", purpose: "그리고 우리는 제품 아이디어를", input: "이 모든 것은 우리가 가진 기술적인 배경에 대한 문제점, 사용자, 목표, 제한,", outcome: "그 범위, 사용 사례, 수용 조건, 해결되지 않은 사항과 함께", prompt: "이 아이디어를 간단하게 PRD로 만들어내세요. 목표, 목적, 흐름, 수용 조건, 위험요소를 포함합니다.",
  },
  "google-labs-code/stitch-skills/enhance-prompt": {
    name: "Enhance Prompt", purpose: "이 모든 것은", input: "이 모든 것은", outcome: "이 모든 것을 할 수 있습니다.", prompt: "이 UI 생성 프로프트를 의도적으로 유지하고, 구조, 상태, 시각적 제한을 추가하여 개선하세요.",
  },
  "github/awesome-copilot/documentation-writer": {
    name: "Documentation Writer", purpose: "그리고 그 다음에는,", input: "코드, 인터페이스, 대상 독자, 문서의 종류", outcome: "예를 들어,", prompt: "초보자를 위한 이 API를 문서화하고 요구사항, 최소한의 사례, 일반적인 오류, 문제 해결을 포함해 주세요.",
  },
  "wshobson/agents/data-storytelling": {
    name: "Data Storytelling", purpose: "그리고 그 결과,", input: "데이터, 분석 결과, 독자, 우리가 지원하고 싶은 의사결정", outcome: "그 배경과 근거, 추천 영상, 결론을 담은 이야기입니다.", prompt: "이 결과를 경영진들에게서 배경을, 세 가지 발견, 추천 그래프, 제안된 판단에 따라 정리해 보세요.",
  },
};

export const CURATED_SKILL_OVERVIEWS_KO: Readonly<Record<string, CuratedSkillOverview>> =
  Object.fromEntries(Object.entries(DEFINITIONS).map(([rawId, definition]) => [rawId, makeOverview(definition)]));
