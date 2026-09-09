# Discord 이벤트 봇에 AI 에이전트 기능 추가

## 요약

**Discord 이벤트 봇은 구성된 Hermes Agent 하나를 통해 승인된 이벤트 정보를 설명하고, 반복 질문에 답하고, 신규 참가자를 안내하고, 예약된 미리 알림을 보낼 수 있을 때 더 유용해집니다.** LightVela에서는 Discord를 연결하고 에이전트에 이벤트 브리프와 안전 경계를 제공하고, 실제 참가자 질문으로 테스트한 뒤 미리 알림 또는 요약에 범위가 좁은 예약 작업을 추가하는 방식으로 구현합니다.

이 방식은 반복 토너먼트, 레이드, 스터디 그룹, 커뮤니티 출시처럼 같은 정보를 여러 대화에서 반복해야 하는 이벤트에 가장 적합합니다.

![Discord 이벤트 커뮤니티를 지원하는 AI 에이전트](../images/use-case-discord-event-agent.webp)

## 대상 사용자와 예상 결과

날짜, 시간대, 등록, 규칙, 장소, 막판 미리 알림에 관한 질문에 지나치게 많은 시간을 쓰는 이벤트 주최자를 위한 활용 사례입니다.

예상 결과는 답변의 일관성을 유지하고 주최자가 적절한 시점에 올바른 정보를 반복하도록 돕는 이벤트 어시스턴트입니다.
사람 주최자만 내릴 수 있는 결정의 사실 출처를 대신하지 않으면서 반복 조율 작업을 줄여야 합니다.

## 사전 요구 사항

- 모델이 구성되어 실행 중인 LightVela Hermes Agent.

- Bot을 추가하고 구성할 수 있는 Discord 서버.

- 이벤트 이름, 날짜, 시간대, 등록 단계, 규칙, 링크, 연락 채널이 포함된 검토 완료 이벤트 브리프.

- 일정 업데이트를 담당하고 공지를 승인하는 모더레이터 또는 주최자.

- [Discord 채널 설정 가이드](../configuration/channel-discord.md)와 [예약 작업 가이드](../configuration/automation.md).

## 단계

### 1. 이벤트 브리프를 에이전트 운영 가이드로 전환

에이전트가 반복해도 되는 사실과 주최자의 승인이 필요한 작업을 먼저 구분하세요.
첫 번째 범주에는 게시된 시작 시각, 등록 마감, 참가 자격 규칙, 채널 위치가 포함됩니다.
두 번째 범주에는 일정 변경, 분쟁, 환불, 차단, 상금 결정, 예외가 포함됩니다.

다음과 같이 간결한 운영 가이드를 제공합니다.

```text
You are the event assistant for this Discord community.

Use the approved event brief for dates, time zones, registration, rules, and channel directions.
Answer in short steps and include the exact time zone when discussing schedules.
Never invent a time, rule, registration status, or announcement.
If event information is missing or has changed, direct the member to the event organizer.
Escalate disputes, moderation issues, eligibility exceptions, and prize questions to a human.
```

이벤트 브리프는 최신 상태로 유지하세요.
AI 에이전트는 반복 답변을 쉽게 만들 수 있지만 오래된 일정을 올바르게 만들 수는 없습니다.

### 2. Discord Bot 연결 및 좁은 운영 범위 선택

LightVela에서 Discord 채널을 연결하고 Discord Developer Portal 인증 절차를 완료합니다.
[Discord 설정 가이드](../configuration/channel-discord.md)에 따라 다음 설정을 완료하세요.

1. Bot을 만듭니다.

2. Message Content Intent를 활성화합니다.

3. 최소 권한 원칙에 따라 권한을 구성합니다.

4. View Channels, Send Messages, Read Message History의 최소 권한으로 봇을 초대합니다.

![Discord 봇 초대 및 서버 선택](../images/discord-event-bot-invite.webp)

첫 출시에서는 이벤트 채널 하나 또는 지원되는 Discord 대화 하나를 선택해 워크플로를 확장하기 전에 테스트하세요.
답변, 권한 동작, 알림 전달을 더 쉽게 점검할 수 있습니다.

![Discord Bot 권한 구성](../images/discord-5-global.webp)

### 3. 참가자가 실제로 물어볼 질문 테스트

소수의 참가자 질문으로 에이전트를 테스트합니다.

```text
When does the tournament start in UTC+8?

What do I need to do before joining tonight's raid?

Where do I register and when does registration close?

The schedule changed. Can you announce the new time?
```

이벤트 브리프에 필요한 정보가 있다면 처음 세 질문에는 간결하고 근거 있는 답변을 제공해야 합니다.
마지막 질문을 받았을 때 에이전트가 공지를 지어내거나 일정을 몰래 변경해서는 안 됩니다.
주최자 또는 승인된 업데이트 절차로 안내해야 합니다.

### 4. 참가자 지원에 에이전트 활용

핵심 답변이 안정적으로 작동하면 다음과 같은 반복 가능한 참가자 지원에 에이전트를 사용하세요.

- 참가자가 요청한 시간대로 이벤트 일정 설명.

- 신규 멤버를 등록, 규칙, 지원 채널로 안내.

- 이벤트 참가 전에 필요한 단계 요약.

- 게시된 참가 자격 규칙에 관한 질문에 답변.

- 민감한 문제를 사람 주최자에게 전달.

다음과 같은 예시 프롬프트를 사용할 수 있습니다.

```text
@YourEventBot What do I need to prepare before tonight's raid?

@YourEventBot I am new here. Which channel has the tournament rules?

@YourEventBot Can you summarize the registration steps in three bullets?
```

대상 Discord 설정에서 지원하는 멘션 또는 대화 방식을 사용하세요.
모든 서버 채널이나 그룹 채팅 방식이 똑같이 작동한다고 가정하지 마세요.

### 5. 예약된 미리 알림 및 요약 추가

예측 가능한 주기로 진행되는 이벤트에는 예약 작업을 사용합니다.
LightVela는 일회성 실행, 고정 요일, 고정 간격과 선택적인 유효 기간 및 알림 채널을 지원합니다.
고정 요일, 고정 간격 또는 일회성 실행을 선택할 수 있습니다.
나중에 예약 작업을 일시 중지, 편집 또는 삭제할 수도 있습니다.

![Discord 이벤트용 예약 작업 구성](../images/automation-2-global-en.webp)

```text
One day before the tournament, remind the event channel about the start time, time zone, registration deadline, and rules channel.
Use only the approved event brief.
If the brief is missing a detail, tell the organizer which detail needs review.
```

이 예시에서 봇은 "Game tournament reminder" 예약 작업을 실행합니다.

![토너먼트 미리 알림을 보내는 Discord 봇](../images/discord-event-reminder.webp)

주최자를 위한 이벤트 후 요약도 예약할 수 있습니다.

```text
After the event, summarize the published results, unanswered participant questions, and issues that need moderator review.
Do not infer winners, penalties, or policy decisions from incomplete information.
```

일련의 미리 알림을 추가하기 전에 첫 예약 출력부터 검토하세요.
[예약 작업 설정 가이드](../configuration/automation.md)는 일정, 작업 지침, 유효 기간, 알림 설정 위치를 설명합니다.

## 실무 체크리스트

| 이벤트 단계 | 작업 | LightVela 구성 요소 | 예상 결과 또는 실패 신호 |
| --- | --- | --- | --- |
| 출시 전 | 검토된 일정, 시간대, 규칙, 링크, 지원 요청 경로 추가 | 에이전트 컨텍스트 | 참가자에게 동일한 승인 답변을 제공할 수 있음 |
| 연결 | Bot을 초대하고 원하는 대화에서 테스트 | Discord 채널 | Bot이 답하고 필요한 최소 권한만 보유함 |
| 참가자 지원 | 일정, 등록, 준비 사항 질문 | Hermes Agent | 답변이 간결하고 구체적이며 브리프에 근거함 |
| 미리 알림 | 이벤트 전 메시지 하나 예약 | 예약 작업 | 예상 시각에 선택한 채널로 메시지가 도착함 |
| 이벤트 후 | 주최자용 요약 생성 | 예약 작업 또는 Chat | 알려진 결과, 미해결 질문, 사람의 후속 조치를 구분함 |

## 검증 및 경계

다음 네 가지 테스트로 이벤트 워크플로를 검증하세요.

1. 알려진 일정 정보를 질문하고 시간대가 명시되는지 확인합니다.

2. 등록 단계를 질문하고 에이전트가 올바른 채널 또는 링크로 안내하는지 확인합니다.

3. 의도적으로 빠뜨린 규칙을 질문하고 에이전트가 모른다고 인정하는지 확인합니다.

4. 일정 변경이나 운영 결정을 요청하고 에이전트가 직접 결정하지 않고 사람에게 전달하는지 확인합니다.

현재 Discord 채널 문서는 채널 계층에서 봇 인증, 서버 및 채널 상호작용, 메시지 콘텐츠 액세스, 능동적 메시지를 다룹니다.
또한 현재 그룹 채팅 지원의 제한 사항을 알립니다.
광범위한 @멘션 기반 이벤트 어시스턴트를 약속하기 전에 대상 서버에서 정확한 멘션 및 다중 사용자 상호작용 동작을 확인하세요.

에이전트에 참가 승인, 제재 부과, 분쟁 해결, 검토되지 않은 일정 변경 공지, 비밀 정보 처리를 맡겨서는 안 됩니다.
이벤트의 공식 사실 출처는 사람 주최자가 계속 책임집니다.

## FAQ

### 에이전트가 서로 다른 시간대의 이벤트 질문에 답할 수 있나요?

이벤트 브리프에 기준 시간대가 있고 참가자가 대상 시간대를 제공하면 게시된 이벤트 시간을 설명할 수 있습니다.
참가자가 결과를 확인할 수 있도록 원래 시각과 변환된 시각을 모두 포함하도록 요청하세요.

### 예약 작업이 Discord 이벤트 미리 알림을 보낼 수 있나요?

네. Discord 채널 문서는 채널 계층에서 능동적 메시지를 지원한다고 설명합니다.
미리 알림 텍스트, 일정, 유효 기간, 알림 채널을 포함한 예약 작업을 만들고 중요한 마감에 의존하기 전에 첫 전송을 테스트하세요.

### 에이전트가 이벤트 일정을 직접 업데이트할 수 있나요?

아니요.
승인된 일정을 반복하고 제안된 변경 사항을 주최자에게 전달해야 합니다.
이벤트 브리프를 업데이트하고 변경된 시각을 게시하기 전에 다음 응답을 검토하세요.

### 사용자 지정 이벤트 봇을 대체할 수 있나요?

항상 그런 것은 아닙니다.
주요 요구 사항이 자연어 질의응답, 근거 있는 이벤트 안내, 예약된 소통이라면 LightVela가 적합합니다.
매우 특화된 명령, 데이터베이스 기반 등록, 대진표 관리, 외부 티켓 워크플로에는 사용자 지정 봇이 더 적합할 수 있습니다.

## 결론

에이전트에 검토된 이벤트 브리프를 제공하고, Discord에 연결하고, 실제 참가자 질문으로 테스트하고, 미리 알림 또는 요약용 범위가 좁은 예약 작업 하나를 추가하세요.
이 순서를 따르면 이벤트 권한, 정책 변경, 민감한 결정은 사람 주최자에게 남겨 두면서 이벤트 봇에 유용한 AI 에이전트 행동을 추가할 수 있습니다.

더 폭넓은 커뮤니티 활용 방식은 [Discord용 LightVela: 채널을 지원하는 AI 에이전트 Discord 봇](./discord-community-agent.md)을 참고하세요.
