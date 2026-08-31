# WhatsApp에서 개성이 뚜렷한 Hermes Agent를 설정하는 방법

## 요약

**WhatsApp은 메시지를 주고받는 진입점일 뿐입니다. 에이전트의 역할, 말투, 행동 범위, 장기 맥락은 LightVela의 설정에서 정해지므로 진입점이 바뀌어도 에이전트의 정체성은 달라지지 않습니다.** 먼저 채널 가이드에 따라 WhatsApp을 인증하고 콘솔에 연결된 것으로 표시되는지 확인하세요. 그런 다음 에이전트 설정의 페르소나 섹션에서 개인 메시지, 알림, 고객 대화에 맞는 페르소나를 선택해 주입합니다. 고객이나 팀을 상대하는 에이전트라면 대상 사용자를 명시하고 브랜드 말투, 처리 범위, 사람에게 넘겨야 하는 조건도 추가하세요. 연결 후 테스트 메시지를 보내 예상한 대화에 답변이 도착하는지 확인합니다. 답변이 오지 않으면 모델 설정, 체험 크레딧 잔액, 채널 연결 상태를 차례로 점검하세요.

![WhatsApp에서 뚜렷한 페르소나를 사용하는 Hermes Agent](../images/use-case-04-whatsapp-persona-agent.png)

## 대상 독자

이 가이드는 WhatsApp에서 일관된 말투와 유용한 업무 맥락을 유지하는 Hermes Agent가 필요한 사용자를 위한 것입니다.
개인 비서, 일상 알림, 정보 정리처럼 대화 방식이 예측 가능해야 하는 1:1 상황에 특히 적합합니다.

WhatsApp은 현재 주로 1:1 대화용으로 설계되었습니다.
아직 WhatsApp을 연결하지 않은 경우 [채널 구성 - WhatsApp](../configuration/channel-whatsapp.md)부터 시작하세요.

## 전제 조건

- 실행 중인 LightVela Hermes Agent.
  아직 생성하지 않았다면 [빠른 시작](../02-quickstart.md)부터 시작하세요.

- 작동하는 모델 구성 또는 사용 가능한 평가판 크레딧.
  Hermes가 아직 응답할 수 없는 경우 [모델 구성](../configuration/model.md)을 완료하세요.

- [채널 구성 - WhatsApp](../configuration/channel-whatsapp.md)를 통해 인증이 완료되어 인증 메시지를 받을 수 있는 WhatsApp 계정입니다.

- 짧은 페르소나 설명.
  에이전트가 누구를 지원하고 어떤 문제를 다루며 어떤 말투를 사용할지, 어떤 작업 전에 반드시 확인을 받아야 할지 정하세요.

## 단계와 핵심 개념

### 1. 먼저 WhatsApp 채널을 연결하세요

LightVela 콘솔에서 대상 Hermes Agent를 열고 "채널"로 이동하여 WhatsApp을 선택합니다.
전화 승인, 인증 코드 또는 QR 흐름을 통해 [채널 구성 - WhatsApp](../configuration/channel-whatsapp.md)를 따른 다음 테스트 메시지를 보냅니다.

WhatsApp이 콘솔에 연결된 것으로 나타나고 Hermes Agent가 WhatsApp에 응답하는지 확인합니다.
채널이 아직 연결되지 않은 경우 특성을 조정하기 전에 인증, 모델 또는 신용 문제를 해결하십시오.

### 2. WhatsApp 사용 상황에 맞는 역할 설명을 작성합니다

WhatsApp 대화는 짧고 즉각적인 경우가 많으며, 같은 대화에서 개인 요청과 업무 요청이 섞일 수도 있습니다.
에이전트의 역할뿐 아니라 답변 길이, 추가 질문 방식, 고위험 작업의 경계도 함께 정하세요.

다음과 같은 역할 개요로 시작하세요.

```text
You are my everyday WhatsApp assistant.
Help me organize to-dos, follow-ups, and short messages, but do not take external actions without my confirmation.
Use a concise, natural, friendly tone by default. Use short sections when an explanation is needed instead of sending one long block.
If my request is missing a time, person, or goal, ask the single most important clarifying question first.
```

WhatsApp 에이전트가 고객이나 팀을 지원한다면 "my"를 실제 대상 사용자로 바꾸고 브랜드 말투, 지원 범위, 사람에게 요청을 넘겨야 하는 조건을 추가하세요.

### 3. Personality에서 Soul을 선택해 주입합니다

대상 에이전트 설정에서 "Personality" 섹션을 엽니다.
무작위 Soul을 뽑거나 성격 테스트를 사용해 원하는 역할에 더 가까운 Soul을 찾을 수 있습니다.

카드에 적힌 역할, 말투, 행동 설명을 검토하고 선택한 후 "Inject soul"을 클릭하세요.
LightVela는 선택된 Soul을 현재 Hermes Agent의 `SOUL.md`에 쓰고 이전 페르소나를 교체하기 전에 백업을 유지합니다.

한 번에 하나의 Soul만 에이전트에 대해 활성화됩니다.
새로운 것을 주입하면 WhatsApp은 새로운 대화에서 새로운 성격을 사용하여 응답하므로 확인하기 전에 이전 역할과 새 역할을 비교하십시오.

### 4. WhatsApp에서 새 대화를 시작합니다

Soul이 삽입된 후 WhatsApp 대화에서 다음 메시지를 보냅니다.

```text
/new
```

이렇게 하면 새 대화가 시작될 때 Hermes Agent가 새 `SOUL.md`를 읽을 수 있습니다.
이전 대화 내용이 여전히 동일하게 들리면 추가 테스트에 앞서 `/new`가 성공적으로 전송되었는지 확인하세요.

간단한 자가 점검을 통해 결과를 확인하세요.

```text
Explain who you serve, your default reply style, and what you do when a request would send a message outside this chat.
```

### 5. 실제 메시지로 WhatsApp 말투를 조정합니다

WhatsApp에서 유용한 페르소나는 특정 캐릭터처럼 말하는 것에 그치지 않습니다.
메시지 길이와 묶음 방식, 추가 질문을 던지는 시점까지 포함합니다.

세 가지 종류의 메시지로 테스트해 보세요.

```text
Turn this content into three messages I could send to a colleague.
```

```text
Remind me to follow up on this tomorrow at 3 PM, and first tell me what information you plan to record.
```

```text
This request might trigger an external action. List the risks and what you need me to confirm first.
```

답변이 너무 긴 경우 "기본 답변을 세 개의 짧은 섹션 아래에 유지"와 같은 기본 설정을 저장하세요.
에이전트에 안정적인 프로젝트 컨텍스트가 필요한 경우 [메모리 관리](../configuration/memory.md) 기능을 사용하여 유용하게 유지되어야 하는 사실을 보존하세요.

## 고객 서비스 워크플로와 페르소나를 구분합니다

페르소나는 에이전트의 역할과 말투를 정의합니다.
스킬은 특정 작업을 수행하는 방법을 제공하고, 자동 작업은 언제 선제적으로 일을 시작할지 정합니다.
메모리와 사용자 프로필은 장기적으로 유지할 맥락을 담당합니다.

예를 들어, 따뜻한 고객 서비스 성격은 주문 조회, 지식 기반 검색 또는 환불 기능을 자동으로 제공하지 않습니다.
이러한 기능에는 모델 구성, 스킬, 참조 파일 및 명시적인 작업 경계가 필요합니다.

성격, 사용자 선호도, 장기 메모리의 경계에 대한 더 자세한 설명은 [Hermes Agent의 성격은 어디에서 오는가](../hermes-agent/10-persona-user-memory.md)를 읽어보세요.

## FAQ

### WhatsApp 번호 하나를 Hermes Agent 하나에 연결해야 하나요?

일반적으로 WhatsApp 번호 하나는 Hermes Agent 하나에 연결하는 것이 좋습니다.
서로 다른 역할이 여러 개 필요하다면 같은 대화에서 페르소나를 계속 바꾸지 말고 WhatsApp 번호와 Hermes Agent 인스턴스를 분리하세요.

### 새 Soul을 주입하면 WhatsApp 기록이나 메모리가 삭제되나요?

아니요.
새 Soul을 주입하면 에이전트의 현재 `SOUL.md`가 바뀌고 `/new`는 새 대화를 시작합니다.
장기 메모리와 사용자 프로필은 별도 컨텍스트 레이어에 그대로 남지만, 새 페르소나에 따라 Hermes가 해당 맥락을 해석하고 활용하는 방식은 달라질 수 있습니다.

### WhatsApp 그룹에서 이 설정을 사용할 수 있나요?

현재 WhatsApp 문서에서는 일대일 대화를 지원되는 범위로 정의하므로 그룹은 이 가이드의 일부가 아닙니다.
현재 채널 제한 사항은 [채널 구성 - WhatsApp](../configuration/channel-whatsapp.md)를 확인하세요.

### WhatsApp 에이전트가 먼저 메시지를 보낼 수 있나요?

선제 메시지에는 WhatsApp 메시지 템플릿과 대화 가능 시간 규칙도 적용됩니다.
예약된 알림을 원할 경우 [자동 작업](../configuration/automation.md)를 읽고 전달 방법이 실제 WhatsApp 채널 한도에 맞는지 확인하세요.

## 다음 단계

- [Telegram에서 독특한 개성을 지닌 Hermes Agent를 구성하는 방법](./telegram-persona-agent.md) - 다른 국제 메시징 채널과 설정을 비교합니다.

- [SOUL.md를 사용하여 IM 에이전트의 역할, 성격 및 음성을 정의하는 방법](./im-agent-persona-soul-md.md) - 성격, 사용자 프로필, 메모리 및 기술을 별도로 유지하십시오.

- [채널 구성 - WhatsApp](../configuration/channel-whatsapp.md) - 전체 WhatsApp 인증 및 문제 해결 흐름을 따르세요.

- [자동 작업](../configuration/automation.md) - 대화에서 이미 테스트된 알림 또는 리뷰를 예약합니다.
