# LightVela로 개인 AI 비서를 구축하는 방법

## 요약

**개인 AI 비서를 만들 때는 모든 기능을 한꺼번에 자동화하지 마세요. 먼저 평소 사용하는 채팅 앱에서 클라우드 Hermes Agent에 접속할 수 있게 한 뒤 메모리, 스킬, 자동 작업을 차례로 추가하는 것이 좋습니다.** 다섯 구성 요소는 각각 다른 문제를 해결합니다. 모델은 추론 품질을, 채널은 에이전트에 접속할 위치를 결정합니다. 메모리는 사용자의 작업 방식을 계속 기억하게 하고, 스킬은 재사용 가능한 절차를 제공하며, 자동 작업은 사용자가 자리를 비운 동안 합의한 일을 실행합니다. 첫 주에는 모델 하나를 설정하고 채널 하나를 연결한 뒤 메모리가 세션을 넘어 유지되는지만 확인하세요. 이 경로가 안정된 다음 스킬과 자동 작업을 추가하면 문제가 생겼을 때 원인이 어느 레이어에 있는지 쉽게 찾을 수 있습니다.

![채널 전반에 걸쳐 LightVela를 갖춘 개인 AI 비서](../images/use-case-personal-ai-assistant.webp)

## 대상 독자

이 구성은 사용자의 선호도를 아는 비서 하나로 일상 계획, 후속 조사, 알림, 질문을 처리하고 싶을 때 적합합니다. 복잡한 워크플로는 필요하지 않습니다. Hermes Agent 하나와 평소 자주 확인하는 채널 하나로 시작하세요.

이는 시간대, 선호하는 요약 형식, 작업 중인 프로젝트 또는 매일 아침 원하는 도움의 종류와 같은 상황을 반복할 때 특히 유용합니다.

## 전제 조건

- LightVela 계정 및 실행 중인 Hermes Agent. 아직 생성하지 않았다면 [빠른 시작](https://lightvela.ai/docs/quickstart)부터 시작하세요.

- 하나의 대화 채널. Telegram, WhatsApp, Discord, Slack 및 WeChat는 일반적인 시작점입니다. 매일 열 가능성이 가장 높은 것을 선택하세요.

- 작동하는 모델 구성 또는 사용 가능한 평가판 크레딧. Hermes가 아직 응답할 수 없는 경우 [모델 구성](https://lightvela.ai/docs/configuration/model)을 참조하세요.

- 먼저 도움을 받고 싶은 내용에 대한 간략한 아이디어. 하루 계획을 세우거나 후속 조치를 취하는 것과 같은 단일 루틴이면 충분합니다.

## 단계와 핵심 개념

### 1. Hermes를 일상 흐름에 연결합니다

메시징 채널 하나를 연결한 뒤, 평소 하루 일정을 정리하는 곳에서 첫 메시지를 보내세요. 채널은 단순한 전달 수단이 아니라 비서에게 자연스럽게 다시 돌아오게 만드는 사용 습관입니다. [Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), [Discord](https://lightvela.ai/docs/configuration/channel-discord), [Slack](https://lightvela.ai/docs/configuration/channel-slack), [WeChat](https://lightvela.ai/docs/configuration/channel-wechat) 설정 가이드를 참고하세요.

![LightVela 콘솔의 채널 페이지](../images/personal-ai-assistant-channel.webp)

광범위한 요청보다는 명확한 소개로 시작하세요. 예를 들면:

```text
I want you to be my personal planning assistant. I am in Singapore time.
Keep daily plans short, call out deadlines first, and ask one follow-up question when something is unclear.
```

### 2. 반복되는 컨텍스트는 메모리에 맡깁니다

Hermes는 시간이 지나면서 유용한 맥락을 축적하므로 대화할 때마다 선호도를 다시 설명할 필요가 없습니다. 시간대, 브리핑 구성 방식, 중요한 프로젝트 이름, 미리 계획하고 싶은 요일처럼 계속 활용할 사실과 업무 선호도를 알려 주세요.

요청을 직접 명시할 수도 있습니다.

```text
Remember that I prefer a concise weekday briefing at 8:00 AM,
with meetings, deadlines, and the three most important next actions.
```

[메모리 관리](https://lightvela.ai/docs/configuration/memory) 페이지에서는 메모리와 Hermes가 축적한 사용자 프로필 정보를 검토할 수 있습니다. 메모리는 반복을 줄여야 하며, 지나가는 모든 세부 사항에 대한 쓰레기장이 되어서는 안 됩니다.

### 3. 실제 작업에 필요할 때만 스킬을 추가합니다

Hermes는 별도 스킬 없이도 대화할 수 있습니다. 정보 검색, 할 일 목록 정리, 반복 보고서 준비처럼 필요한 작업을 구체적으로 설명할 수 있을 때 스킬을 추가하세요. 기능의 범위가 분명해져 비서의 동작을 이해하고 신뢰하기 쉬워집니다.

![LightVela 콘솔의 스킬 페이지](../images/personal-ai-assistant-skills.webp)

ClawHub에서 적합한 옵션을 찾아본 후 [스킬 구성](https://lightvela.ai/docs/configuration/skill)을 사용하여 설치하세요. 무엇이든 설치하기 전에 설명을 읽고 신뢰할 수 있는 소스를 선택하세요.

### 4. 유용한 대화를 반복 가능한 점검으로 전환합니다

프롬프트의 유용성이 확인되면 일정에 따라 반복 실행할지 결정하세요. 간단한 자동 작업을 만들면 매번 대화를 시작할 필요 없이 Hermes가 아침 계획, 하루 마감 검토, 주간 우선순위 정리를 수행할 수 있습니다.

예를 들면:

```text
Every weekday at 8:00 AM, prepare a concise plan for today.
Start with deadlines and meetings, then suggest three focused next actions.
```

[자동 작업](https://lightvela.ai/docs/configuration/automation)에서 일정 및 알림 채널을 설정하세요. 첫 번째 자동 작업을 작게 유지하십시오. 몇 가지 실제 결과를 본 후에 지침을 구체화할 수 있습니다.

![LightVela 콘솔의 자동 작업 페이지](../images/personal-ai-assistant-automations.webp)

## FAQ

### Hermes를 유용하게 사용하려면 모든 기능을 구성해야 하나요?

아니요. 채널과 작동하는 모델만으로 시작하기에 충분합니다. 유지할 가치가 있는 반복 작업을 찾으면서 메모리, 스킬 및 자동 작업을 점차적으로 추가하세요.

### Hermes는 내가 보내는 모든 메시지를 기억하나요?

아니요. 메모리는 선호도, 반복 작업, 안정적인 컨텍스트 등 대화 전반에 걸쳐 유용하게 유지되는 정보를 위한 것입니다. 필요한 경우 Hermes에 정보를 기억하거나 잊어버리도록 요청한 다음 메모리 관리에서 검토할 수 있습니다.

### 두 대 이상의 채널에서 동일한 어시스턴트를 사용할 수 있나요?

예. 여러 연결된 채널은 동일한 Hermes Agent를 가리킬 수 있으므로 지원되는 메시징 플랫폼 간에 이동하는 동안 도우미가 동일한 컨텍스트를 유지할 수 있습니다.

### 무엇을 먼저 자동화해야 하나요?

예측 가능한 시간에 이미 반복하고 있는 작업을 선택하세요. 아침 계획, 짧은 일일 검토 또는 주간 우선순위 확인은 결과가 도움이 되는지 빠르게 알 수 있기 때문에 좋은 첫 번째 후보입니다.

## 다음 단계

- [채팅](https://lightvela.ai/docs/configuration/agent-chat) — 콘솔에서 직접 Hermes와 작업합니다.

- [메모리 관리](https://lightvela.ai/docs/configuration/memory) — 어시스턴트가 대화 전반에 걸쳐 유지하는 내용을 검토하세요.

- [자동 작업](https://lightvela.ai/docs/configuration/automation) — 유용하다고 입증된 루틴을 예약합니다.
