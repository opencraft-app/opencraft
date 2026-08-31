# Discord용 LightVela: 채널을 지원하는 AI 에이전트 Discord 봇

## 요약

**LightVela에서는 클라우드 호스팅 Hermes Agent를 Discord에 연결하고, 승인된 커뮤니티 컨텍스트와 운영 경계를 제공하여 반복 질문, 신규 사용자 안내, 이벤트 지원에 활용할 수 있습니다.** 최소 절차는 에이전트 생성, 지침 구성, Discord 채널 연결, 봇 초대, 지원되는 Discord 대화에서 실제 질문 테스트 순서입니다.

[Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)와 [Viktor](https://slack.com/marketplace/A0A2VN5TR5K-viktor)처럼 최근 등장한 공유 에이전트 제품은 그룹이 이미 소통하는 공간에서 에이전트가 작업할 때 더 유용해지는 이유를 보여 줍니다.
LightVela는 별도의 봇 애플리케이션을 먼저 개발하고 호스팅하지 않아도 Discord 커뮤니티에서 이러한 방식을 사용할 수 있게 합니다.

![Discord 커뮤니티에 연결된 LightVela Agent](../images/use-case-discord-community-agent.webp)

## 대상 사용자와 예상 결과

이미 사용 중인 대화 공간에서 신뢰할 수 있는 AI 도우미가 필요한 게임 커뮤니티, 개발자 커뮤니티, 관심사 그룹, 이벤트 서버를 위한 활용 사례입니다.

예상 결과는 승인된 질문에 답하고, 올바른 채널이나 이벤트 정보로 안내하고, 신규 사용자 정착을 지원하며, 자동 작업이 적합한 경우 구성된 미리 알림을 보낼 수 있도록 충분한 정보를 제공받은 Discord 에이전트입니다.

사람 모더레이터를 대체하는 것은 아닙니다.
민감한 운영 결정, 계정 작업, 분쟁, 승인된 지식 범위를 벗어난 모든 문제는 사람이 처리해야 합니다.

## 사전 요구 사항

- 모델이 구성되어 실행 중인 LightVela Hermes Agent.

- 봇을 추가할 권한이 있는 Discord 계정과 서버.

- 서버 규칙, FAQ, 이벤트 세부 정보, 채널 용도, 지원 요청 연락처처럼 승인된 원본 자료.

- 에이전트가 답해도 되는 내용, 거절해야 하는 내용, 사람에게 전달해야 하는 시점을 정의한 명확한 경계.

- 참고할 [Discord 채널 설정 가이드](../configuration/channel-discord.md)와 [자동 작업 가이드](../configuration/automation.md).

## 단계

### 1. 봇을 초대하기 전에 에이전트 생성

Discord 자격 증명보다 에이전트의 역할과 목표에서 시작하세요.
Discord 봇은 Hermes로 들어가는 진입점이므로 연결 후의 행동은 LightVela에서 구성한 지침과 모델에 따라 결정됩니다.

커뮤니티에서 가장 자주 나오는 질문과 각 질문에 필요한 최소 답변을 적어 보세요.
예를 들어 규칙 페이지, 지원 채널, 이벤트 일정, 등록 절차, 모더레이터에게 전달하는 경로를 목록으로 만듭니다.

### 2. 승인된 커뮤니티 컨텍스트 제공

사용이 허용된 정보와 반드시 지켜야 할 경계를 에이전트에 구성합니다.
다음과 같은 지침으로 시작할 수 있습니다.

```text
You are the community assistant for this Discord server.

Answer questions using approved information.
Help members find the right channel or event details.
Be friendly and concise.
Escalate sensitive moderation issues to human moderators.
Never invent rules, announcements, or event times.
If the approved information does not answer a question, say that you do not know and point the member to a human moderator.
```

지속적으로 적용할 운영 선호도는 에이전트의 구성된 컨텍스트에 보관하세요.
변경되는 일정, 공지, 이벤트 자료는 에이전트가 사용하기 전에 검토할 수 있는 워크플로에 보관하세요.
봇 토큰, 비밀번호, 불필요한 개인 정보는 장기 컨텍스트에 넣지 마세요.

### 3. Discord 연결 및 봇 초대

LightVela에서 채널 설정을 열고 Discord를 선택합니다.
Discord Application을 만들거나 선택하고, Bot을 추가하고, 토큰을 생성한 뒤 Discord 연결 카드에 토큰을 붙여넣습니다.

Discord Developer Portal에서 메시지 콘텐츠를 읽는 데 필요한 Message Content Intent를 활성화합니다.
채널 보기, 메시지 보내기, 메시지 기록 읽기처럼 서버에 필요한 최소한의 봇 범위와 권한만 사용하세요.
그런 다음 초대 링크를 생성해 원하는 서버에 봇을 추가합니다.

현재 인증 및 권한 절차 전체는 [Discord 설정 단계](../configuration/channel-discord.md)를 따르세요.

![Developer Portal의 Discord 봇 권한](../images/discord-6-global.webp)

### 4. 실제 커뮤니티 질문으로 에이전트 테스트

콘솔에서 Discord가 연결됨으로 표시되면 지원되는 Discord 대화에서 대표적인 질문 몇 개를 보냅니다.
유용한 답변과 안전한 불확실성을 모두 테스트할 질문을 사용하세요.

```text
Where can I find the event schedule?

Which channel should I use for technical support?

I am new here. What should I read first?

What is the rule for an issue that is not covered in the FAQ?
```

유창한 답변만으로는 충분하지 않습니다.
에이전트가 승인된 정보를 사용하고, 답변을 간결하게 유지하고, 규칙을 지어내지 않고, 모더레이터가 필요한 질문은 전달해야 합니다.

봇이 답하지 않으면 Discord 채널이 연결됨으로 표시되는지, 모델을 사용할 수 있는지, 봇에 메시지 읽기 및 보내기 권한이 있는지, Message Content Intent가 활성화되어 있는지 먼저 확인하세요.

### 5. 핵심 흐름이 작동한 뒤 반복 지원 추가

질의응답이 안정적으로 작동하면 등록 미리 알림, 이벤트 카운트다운, 모더레이터 요약 같은 반복 작업에 범위가 좁은 자동 작업을 추가합니다.
LightVela 자동 작업은 일회성 실행, 고정 요일, 고정 간격을 지원하며 선택적으로 유효 기간과 알림 채널을 설정할 수 있습니다.

예:

```text
Every Thursday at 18:00, remind the event channel about Saturday's tournament.
Use only the approved schedule and rules.
Include the start time, time zone, registration deadline, and the channel for questions.
If any detail is missing, say which detail needs a moderator update instead of guessing.
```

미리 알림 하나로 시작하고 더 많은 예약 작업을 추가하기 전에 출력을 검토하세요.
사용 가능한 일정 및 알림 설정은 [자동 작업](../configuration/automation.md)을 참고하세요.

## 실무 체크리스트

| 단계 | 작업 | LightVela 구성 요소 | 예상 결과 또는 실패 신호 |
| --- | --- | --- | --- |
| 정의 | 커뮤니티 역할, 승인된 사실, 지원 요청 규칙 작성 | 에이전트 지침 | 모더레이터가 에이전트가 답할 수 있는 내용과 없는 내용을 설명할 수 있음 |
| 연결 | Discord Bot 토큰을 추가하고 최소 권한으로 봇 초대 | Discord 채널 | Discord가 연결됨으로 표시되고 봇이 서버에 있음 |
| 테스트 | 알려진 FAQ 질문과 알려지지 않았거나 민감한 질문 요청 | Discord 대화 | 첫 질문에는 근거 있는 답변을 제공하고, 두 번째 질문은 거절하거나 사람에게 전달함 |
| 반복 | 좁은 일정으로 미리 알림 또는 요약 하나 추가 | 자동 작업 | 예상 시각에 선택한 알림 채널로 메시지가 도착함 |
| 검토 | 답변, 일정, 변경된 이벤트 정보 확인 | 에이전트 및 자동 작업 관리 | 오래된 규칙과 공지가 혼란을 일으키기 전에 수정됨 |

## 공유 Discord 에이전트가 도울 수 있는 작업

### 반복되는 질문에 답하기

모든 커뮤니티에는 반복되는 질문이 있습니다.

- 이벤트 일정은 어디에 있나요?

- 지원용 채널은 무엇인가요?

- 토너먼트에는 어떻게 참가하나요?

- 서버 규칙은 어디에 있나요?

멤버는 모더레이터가 온라인이 될 때까지 기다리지 않고 지원되는 Discord 대화에서 에이전트에 질문할 수 있습니다.
승인된 정보가 명확하면 답변도 일관되며, 정보가 없을 때는 모른다고 말할 수 있습니다.

### 이벤트 관리자가 되지 않고 이벤트 지원

이벤트에서는 등록, 시간대, 규칙 미리 알림, 막판 변경에 관한 작은 질문이 많이 발생합니다.
에이전트가 반복 질문에 답하고 구성된 미리 알림을 전달하는 동안, 주최자는 원본 정보와 최종 결정에 대한 통제권을 유지할 수 있습니다.

### 신규 멤버의 첫 시간을 개선

신규 멤버는 다음과 같은 간단한 질문으로 시작할 수 있습니다.

```text
I am new here. Where should I start?
```

에이전트가 올바른 채널로 안내하고 승인된 커뮤니티 기본 사항을 설명하며 다음 단계 하나를 제안할 수 있습니다.
에이전트에 운영 결정을 맡기지 않으면서도 첫 상호작용을 유용하게 만듭니다.

## Discord 봇을 처음부터 코딩하는 방식과 비교

매우 특화된 명령이나 제품 전용 워크플로가 필요하면 사용자 지정 Discord 봇이 적합합니다.
대신 애플리케이션 로직, 자격 증명, 배포, 지속적인 유지 관리를 직접 책임져야 합니다.
LightVela는 에이전트에서 시작하며 콘솔에서 행동을 설명할 수 있습니다.

| 일반적인 코드 기반 봇 | Discord용 LightVela |
| --- | --- |
| 명령과 이벤트 핸들러 작성 | 에이전트가 수행할 작업 설명 |
| FAQ와 규칙을 코드 또는 데이터베이스에 저장 | 승인된 컨텍스트와 경계를 에이전트에 제공 |
| 미리 알림용 스케줄러 구축 | 콘솔에서 자동 작업 생성 |
| 행동 변경 사항 배포 | 에이전트 지침을 업데이트하고 결과 검토 |
| 봇 인프라와 로직 유지 관리 | 커뮤니티 운영 및 관리에 집중 |

모든 사용자 지정 봇이 불필요해지는 것은 아닙니다.
전체 봇 제품을 구축하기 전에 커뮤니티가 유용한 Discord 에이전트를 출시할 수 있는 실용적인 방법을 제공합니다.

## 검증 및 경계

알려진 질문, 정보가 없는 질문, 민감한 운영 질문을 각각 하나 이상 사용해 시나리오를 확인하세요.
에이전트가 승인된 답변을 사용하고, 불확실성을 인정하고, 임의로 답하지 않고 사람에게 전달하는지 검토합니다.

Discord 설정 가이드는 채널 계층에서 봇 인증, 서버 및 채널 상호작용, 메시지 콘텐츠 액세스, 능동적 메시지를 설명합니다.
또한 현재 그룹 채팅 지원의 제한 사항도 설명합니다.
광범위한 멤버 멘션이나 특정 다중 사용자 대화 방식이 필요한 경우 공개 출시 전에 대상 서버에서 해당 동작을 확인하세요.

차단, 악용 신고, 분쟁, 정책 변경, 승인된 컨텍스트에 추가되지 않은 공지는 사람 모더레이터가 계속 책임져야 합니다.

## FAQ

### Discord 봇을 코딩해야 하나요?

이 활용 사례에서는 필요하지 않습니다.
LightVela에서 Hermes를 구성하고 Discord 채널을 연결한 뒤 생성된 Bot을 서버에 초대하면 됩니다.
LightVela가 제공하지 않는 매우 구체적인 명령이나 워크플로에는 사용자 지정 코드가 여전히 적합합니다.

### 에이전트가 서버 규칙에 관한 질문에 답할 수 있나요?

네. 규칙이 승인된 컨텍스트에 포함되어 있고 프롬프트에서 규칙을 지어내거나 무시하지 않도록 지시한 경우 가능합니다.
규칙이 불명확하거나 문제가 민감하면 사람 모더레이터에게 안내하도록 설정하세요.

### 이벤트 미리 알림을 자동으로 보낼 수 있나요?

네. Discord 채널 문서에는 채널 계층에서 능동적 메시지를 지원한다고 나와 있습니다.
[자동 작업](../configuration/automation.md)에서 일정, 작업 지침, 유효 기간, 알림 채널을 정의하세요.

### 에이전트가 운영 결정을 내려야 하나요?

아니요.
설명, 안내, 미리 알림, 요약에 활용하고 집행과 민감한 사안에 대한 권한은 사람 모더레이터가 유지해야 합니다.

## 결론

Hermes Agent를 만들고, 승인된 커뮤니티 컨텍스트를 제공하고, Discord를 연결하고, 봇을 초대한 뒤 자동 작업을 추가하기 전에 실제 질문으로 테스트하세요.
이 순서를 따르면 서버 규칙, 권한, 사람에게 전달하는 경계를 직접 통제하면서 개인 AI 에이전트를 유용한 커뮤니티 도우미로 전환할 수 있습니다.

더 집중된 형태의 활용 사례는 [Discord 이벤트 봇에 AI 에이전트 기능 추가](./discord-event-agent.md)를 참고하세요.
