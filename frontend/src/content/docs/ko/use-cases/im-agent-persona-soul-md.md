# SOUL.md로 IM 에이전트의 역할, 페르소나, 말투를 정의하는 방법

## 요약

**IM 에이전트가 “같은 사람”처럼 느껴지는지는 사용하는 채널이 아니라 페르소나에 달려 있습니다. `SOUL.md`에는 역할, 어조, 우선순위, 행동, 한계가 담기며 Hermes 런타임의 핵심 페르소나 파일입니다.** LightVela에서는 클라우드 파일 시스템을 직접 조작하지 않습니다. 에이전트 설정 페이지의 Persona 섹션은 페르소나를 무작위로 뽑는 방법과 짧은 퀴즈에 답하는 두 가지 진입점을 제공합니다. 페르소나 카드의 역할, 어조, 행동 설명을 확인한 뒤 Inject Persona를 선택해 적용합니다. 구체적인 사실보다 판단 가능한 원칙을 작성하세요. “결론을 먼저 말한다”, “불확실성을 명시한다”, “외부 메시지를 보내기 전에 확인한다”는 페르소나 규칙이고, 프로젝트 이름과 포트는 장기 메모리에 속합니다. 주입한 뒤 실제 대화 하나로 말투와 한계를 확인하세요.

![SOUL.md로 IM 에이전트의 역할, 페르소나, 말투 정의](../images/use-case-05-im-agent-persona-soul-md.png)

## 이 가이드가 필요한 사용자

개인 어시스턴트, 리서치 파트너, 학습 동반자, 일상적인 고객 소통 어시스턴트처럼 IM 에이전트에 안정적인 역할을 부여하고 싶은 사용자를 위한 가이드입니다.
아직 메시징 채널을 선택하지 않았다면 [AI 에이전트를 메시징 플랫폼에 연결하는 방법](./chinese-messaging-channels.md)부터 시작하세요.

## 먼저 세 가지 컨텍스트 계층 이해하기

### `SOUL.md`: 에이전트의 정체성과 작업 방식

`SOUL.md`는 역할, 말투, 우선순위, 행동, 경계처럼 안정적인 페르소나 규칙에 가장 적합합니다.
“결론을 먼저 제시한다”, “불확실성을 명확히 밝힌다”, “외부 메시지를 보내기 전에 확인한다”와 같은 규칙이 여기에 속합니다.

### 사용자 프로필: 사용자의 정체성과 원하는 응대 방식

사용자 프로필은 언어, 시간대, 정체성, 배경, 소통 선호도를 저장하기에 적합합니다.
예를 들어 “싱가포르에 거주한다”, “기본적으로 영어를 사용한다”, “마감일을 먼저 표시한다”는 보통 에이전트의 정체성 규칙이 아니라 사용자 선호도입니다.

### 장기 메모리: 함께 확립한 내용

장기 메모리는 프로젝트 상태, 결정, 공동 작업에서 재사용할 수 있는 컨텍스트에 적합합니다.
대화가 계속되면서 축적되며 [메모리 관리](../configuration/memory.md)에서 내용을 확인하거나 용량을 관리할 수 있습니다.

세 가지를 섞으면 에이전트의 정체성, 사용자 선호도, 임시 프로젝트 컨텍스트가 서로 간섭합니다.
분리해 두면 실제 사용자와 작업에 맞춰 대화를 조정하면서도 페르소나는 안정적으로 유지할 수 있습니다.

## 사전 요구 사항

- 실행 중인 LightVela Hermes Agent.
  아직 만들지 않았다면 [빠른 시작](../02-quickstart.md)부터 진행하세요.

- 구성된 모델과 사용할 수 있는 대화 채널 하나 이상.

- 짧은 페르소나 브리프.
  에이전트가 누구를 돕는지, 주요 업무가 무엇인지, 어떤 말투를 사용해야 하는지, 어떤 작업에 항상 확인이 필요한지 정합니다.

## 단계 및 핵심 개념

### 1. 다섯 가지 질문으로 페르소나 목표 정의

Soul을 선택하기 전에 다음 다섯 가지 질문에 답하세요.

- 에이전트는 어떤 존재인가?

- 주로 누구를 돕는가?

- 평소 어떤 말투를 사용해야 하는가?

- 정보가 불확실할 때 어떻게 행동해야 하는가?

- 어떤 외부 작업은 먼저 확인해야 하는가?

답을 다음과 같은 기획 브리프로 만드세요.

```text
Role: A research assistant for personal projects
Audience: A user who wants reliable conclusions quickly
Voice: Concise, professional, friendly, conclusion first, evidence second
Behavior: Break down questions, flag uncertainty, and ask only one key question when needed
Boundaries: Never send external messages, change files, or take high-risk actions without confirmation
```

이 템플릿은 페르소나를 선택하고 조정하는 데 도움이 됩니다.
LightVela가 임의의 클라우드 파일을 위한 범용 편집기를 제공한다는 의미는 아닙니다.

### 2. 에이전트 설정에서 Personality 열기

LightVela 콘솔에서 대상 Hermes Agent 설정을 열고 "Personality"를 선택합니다.
국제 사이트에서는 "Draw random soul"과 "Soul personality test" 두 가지 진입점을 제공합니다.

서로 다른 역할 유형을 탐색하려면 무작위 뽑기를 사용하세요.
소통 방식과 행동 선호도에 더 잘 맞는 Soul을 원한다면 페르소나 테스트를 사용하세요.

각 카드의 역할, 말투, 행동 설명을 검토한 뒤 기획 브리프와 가장 잘 맞는 카드를 선택합니다.

### 3. 선택한 Soul을 `SOUL.md`에 주입

Soul을 선택하고 "Inject soul"을 클릭합니다.
LightVela가 선택한 Soul을 현재 Hermes Agent의 `SOUL.md`에 기록하며, 기존 파일을 교체하기 전에 백업합니다.

에이전트에서는 한 번에 하나의 페르소나만 활성화됩니다.
역할을 바꾸려면 다시 주입하기 전에 새 카드의 경계를 검토하세요.

주입에 성공하면 IM 채널로 돌아가 다음 명령을 보냅니다.

```text
/new
```

새 대화가 시작될 때 Hermes Agent가 새 `SOUL.md`를 읽습니다.
기존 대화에는 이전 페르소나 스냅샷이 남아 있을 수 있으므로 이 단계가 중요합니다.

### 4. 대화를 통해 사용자 선호도와 지속적인 사실 추가

모든 정보를 `SOUL.md`에 넣지 마세요.
안정적인 페르소나는 간결하게 유지하고 개인 선호도와 프로젝트 사실은 사용자 프로필과 장기 메모리에서 처리합니다.

예를 들어 Hermes에게 다음과 같이 말할 수 있습니다.

```text
Remember that I am in Singapore time and want a concise weekday plan at 8:00 AM, with deadlines listed first.
```

또는:

```text
Forget the Friday evening reminder preference I mentioned earlier. Do not schedule it again.
```

Hermes는 대화에서 기억하기와 잊기 요청을 처리합니다.
[메모리 관리](../configuration/memory.md)에서 Memory와 User Profile의 콘텐츠 및 용량을 확인하세요.

### 5. 실제 작업에 필요한 스킬만 설치

페르소나는 에이전트의 작업 방식을 정의하지만 외부 기능을 자동으로 추가하지는 않습니다.
웹을 탐색하거나, 자료를 정리하거나, 정보를 조회하거나, 다른 구체적인 작업을 수행하게 하려면 적절한 스킬을 설치하고 먼저 출처와 권한을 확인하세요.

[스킬 구성](../configuration/skill.md)부터 시작하세요.
스킬과 페르소나는 서로를 보완해야 하며, 불명확한 페르소나 경계를 보완하기 위해 고위험 스킬을 사용해서는 안 됩니다.

## 페르소나 활성화 확인

새 대화를 시작한 뒤 자기소개만 요청하지 말고 최소한 다음 네 가지 사례를 테스트하세요.

```text
What is your current role, main job, and default voice?
```

```text
How do you respond when you are uncertain about a fact?
```

```text
If I ask you to send a message to an external service, what do you do first?
```

```text
Turn this material into conclusions, evidence, and questions that still need confirmation.
```

에이전트가 역할, 말투, 안전 경계를 유지하는지, 사용자 프로필과 장기 메모리의 관련 컨텍스트를 계속 사용할 수 있는지 확인하세요.
행동이 불안정하다면 다른 Soul을 선택하거나 주입하기 전에 페르소나 규칙을 단순화하세요.

## FAQ

### 클라우드 `SOUL.md`를 직접 편집해야 하나요?

대개 필요하지 않습니다.
LightVela의 Personality 진입점에서 Soul을 생성하고 주입하므로 일반 사용에는 직접적인 클라우드 파일 시스템 작업이 필요하지 않습니다.

### `SOUL.md`를 바꾸면 모든 메시징 채널에 영향을 주나요?

같은 Hermes Agent의 에이전트 수준 행동에 영향을 줍니다.
해당 에이전트가 Telegram과 WhatsApp에 연결되어 있으면 새 대화에서 두 채널 모두 같은 페르소나를 사용하지만, 각 채널의 인증, 메시지 형식, 기능 제한은 서로 다릅니다.

### `SOUL.md`가 메모리를 대체할 수 있나요?

아니요.
`SOUL.md`는 안정적인 정체성과 행동 규칙을 설명하고, 메모리는 변하는 사실, 프로젝트 컨텍스트, 공유 경험을 보관해야 합니다.

### 한 에이전트에서 여러 페르소나를 동시에 활성화할 수 있나요?

현재 한 에이전트에서는 한 번에 하나의 페르소나만 활성화됩니다.
완전히 다른 역할이 필요하다면 하나의 에이전트에서 Soul을 반복해서 덮어쓰지 말고 별도의 에이전트를 만드세요.

### 언제 `/new`를 보내야 하나요?

새 페르소나를 주입한 뒤 IM 채널에서 `/new`를 보내세요.
대화 초기화 중 새 Soul을 불러오도록 명확히 지시할 수 있습니다.

## 다음 단계

- [Telegram에서 뚜렷한 페르소나를 가진 Hermes Agent를 구성하는 방법](./telegram-persona-agent.md) - 일대일 Telegram 대화에 페르소나를 적용합니다.

- [WhatsApp에서 뚜렷한 페르소나를 가진 Hermes Agent를 구성하는 방법](./whatsapp-persona-agent.md) - 일대일 WhatsApp 대화에 페르소나를 적용합니다.

- [Hermes Agent의 페르소나는 어디에서 오는가](../hermes-agent/10-persona-user-memory.md) - Persona, 사용자 선호도, 장기 메모리를 자세히 이해합니다.

- [클라우드 스토리지](../configuration/files.md) - 에이전트가 사용할 참고 자료와 작업 파일을 관리합니다.
