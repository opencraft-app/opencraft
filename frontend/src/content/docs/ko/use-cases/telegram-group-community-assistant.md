# Telegram 그룹에서 AI 커뮤니티 도우미를 사용하는 방법: Q&A, 요약, 알림

## 요약

**LightVela에서 Telegram 그룹 메시지를 사용하려면 BotFather에서 Bot의 Group Privacy를 끄고, Bot을 그룹에 추가한 뒤 `@bot_username`을 멘션하여 대화를 시작해야 합니다.**
이 가이드는 현재 확인된 설정만 다룹니다. 새 구성원 참여 이벤트나 멘션 없는 자동 응답을 지원 기능으로 가정하지 않으며, 같은 Hermes Agent를 그룹 Q&A·요약·알림에 활용하는 방법을 설명합니다.

![그룹 Q&A, 요약 및 알림을 위한 Telegram 그룹 AI 커뮤니티 도우미](../images/use-case-08-telegram-group-community-assistant.png)

## 시작하기 전에

[채널 구성 - Telegram](../configuration/channel-telegram.md)에 따라 Hermes Agent에 연결한 Telegram Bot이 필요합니다.
해당 Bot을 사용할 그룹에 구성원으로 추가할 권한도 있어야 합니다.

## Telegram 그룹 메시지 활성화

### 1. BotFather를 열고 Bot을 선택합니다

1. Telegram에서 `@BotFather`를 엽니다.
2. `/mybots`를 보냅니다.
3. Hermes Agent에 연결된 봇을 선택하세요.

### 2. 그룹 개인 정보 보호 비활성화

1. "봇 설정"을 엽니다.
2. "그룹 개인정보 보호"를 선택하세요.
3. "끄기" 또는 "개인 정보 보호 모드 비활성화"를 선택하십시오.

이 설정을 사용하면 Bot이 이를 언급하는 그룹 메시지를 받을 수 있습니다.

### 3. Telegram 그룹에 봇 추가

1. 사용하려는 Telegram 그룹을 엽니다.
2. "구성원 추가" 또는 이에 상응하는 그룹 관리 작업을 선택합니다.
3. 사용자 이름으로 Bot을 검색하고 그룹에 추가합니다.

### 4. Bot을 멘션하여 그룹 메시지를 테스트합니다

`@bot_username summarize the discussion so far`와 같이 Bot을 언급하는 메시지를 보냅니다.

예상되는 결과는 동일한 그룹의 Hermes Agent 응답입니다.

## 확인된 메시지 범위

| 상호작용 | 현재 문서화된 범위 | 유효성을 검사하는 방법 |
|---|---|---|
| 그룹 대화 | Bot을 그룹에 추가하고 Group Privacy를 끈 뒤 메시지에서 Bot을 멘션 | 그룹에서 `@bot_username hello`를 보내고 같은 대화에 응답이 나타나는지 확인 |
| 직접 대화 | 연결된 Telegram Bot을 통해 지원 | Bot과의 1:1 채팅에서 메시지를 보내고 답장을 확인 |
| 신규 회원 자동 환영 또는 멘션 없는 응답 | 이 설정 가이드에서 구성하지 않음 | 운영 워크플로에 포함하기 전에 별도로 검증 |

## 봇을 커뮤니티 도우미로 사용

그룹 테스트에 성공하면 [SOUL.md 페르소나 가이드](./im-agent-persona-soul-md.md)에 따라 역할과 정보 경계를 명확히 정하세요.
구성원이 언제 에이전트의 답변을 받을 수 있는지 알 수 있도록 그룹에서는 Bot을 명시적으로 멘션해 요청합니다.

| 작업흐름 | 그룹 프롬프트 예시 | 확인 결과 |
|---|---|---|
| 자주 묻는 질문 | `@bot_username answer only from the prepared FAQ` | 답변은 준비된 자료를 사용하거나 명확하게 사람의 전달을 요청합니다 |
| 토론 요약 | `@bot_username summarize decisions, action items, owners, and open questions` | 응답은 확인된 결정과 해결되지 않은 항목을 구분합니다 |
| 알림 초안 | `@bot_username draft a reminder with time, audience, purpose, and cancellation method` | 자동 작업을 사용하여 보내기 전에 초안을 검토하세요 |

검색, 요약 또는 예약된 콘텐츠의 경우 신뢰할 수 있는 스킬을 선택하고 [스킬 구성](../configuration/skill.md)에서 해당 권한을 검토하세요.
예약된 메시지에 사용하기 전에 지원되는 대상 채널에서 자동 작업을 별도로 검증하세요.

## 안전 및 작동 경계

Group Privacy를 끄면 Telegram 그룹 메시지가 Bot에 전달될 수 있지만, 그것만으로 안전이 보장되지는 않습니다.
그룹 규칙을 정하고 민감한 정보를 공유하지 않으며 고위험 외부 작업 전에 확인을 받는 절차가 필요합니다.
누가 에이전트에 민감한 작업을 요청할 수 있는지는 [Telegram 및 WhatsApp 안전 경계 가이드](./telegram-whatsapp-safety-boundaries.md)를 참고해 정하세요.

## FAQ

### 지금 그룹에 LightVela Telegram 봇을 추가할 수 있나요?

예.
BotFather에서 그룹 개인 정보 보호를 비활성화하고 Bot을 그룹에 추가한 다음 `@bot_username`로 언급하여 대화를 시작합니다.

### 그룹 개인정보 보호를 비활성화하면 봇이 그룹으로 응답하게 되나요?

Group Privacy를 끄는 것은 문서화된 설정의 필수 단계입니다.
이후 Bot을 그룹에 추가하고 테스트 메시지에서 멘션해야 합니다.

### 이 가이드에는 신규 회원을 위한 자동 환영 메시지가 구성되어 있나요?

아니요.
이 가이드는 Bot을 언급하면서 시작된 그룹 대화를 문서화합니다.
커뮤니티에 약속하기 전에 회원 가입 이벤트와 자동 환영 워크플로를 별도로 검증하세요.

### WhatsApp 그룹을 대안으로 사용할 수 있나요?

현재 WhatsApp 채널 문서에는 여전히 그룹 채팅이 지원되지 않는다고 명시되어 있습니다.
Telegram 그룹 메시지 지원이 WhatsApp까지 확장된다고 가정하지 마십시오.

## 다음 단계

- [채널 구성 - Telegram](../configuration/channel-telegram.md) - 봇을 연결하고 그룹 메시지 설정 단계를 반복합니다.

- [스킬을 사용하여 IM 에이전트를 고객 서비스, 커뮤니티 또는 동반자 도우미로 전환하는 방법](./im-agent-skill-scenarios.md) - 그룹 Q&A 및 요약을 위한 스킬과 콘텐츠를 준비합니다.

- [SOUL.md를 사용하여 IM 에이전트의 역할, 성격 및 음성을 정의하는 방법](./im-agent-persona-soul-md.md) - 보조자의 역할과 경계를 정의합니다.
