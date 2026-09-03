# Hermes Agent를 연중무휴 온라인 상태로 유지하는 방법

## 요약

**Hermes Agent는 로컬 컴퓨터가 아니라 클라우드 인스턴스에서 실행되므로 언제든 사용할 수 있습니다. 모델과 채널을 하나 이상 구성하면 어느 진입점에서 메시지를 보내든 같은 메모리와 행동 방식을 사용합니다.** 진정한 장기 가용성을 위해서는 세 가지가 필요합니다. 사용 가능한 계정 할당량이 있는 구성된 모델(체험 크레딧이 소진되면 아무 응답 없이 답하지 않을 수 있음), 연결됨으로 표시되는 채널 하나 이상, 사용자가 자리를 비운 동안 예약 작업을 처리하는 자동 작업입니다. 콘솔 상태만으로 가용성을 판단하지 말고 실제 채널을 통해 진짜 메시지를 보내세요. 문제가 발생하면 Diagnostics에서 최근 로그를 확인하고 내보내 원인을 찾으세요. 1, 3, 6, 12, 24시간 범위를 선택할 수 있습니다.

![LightVela 콘솔에서 온라인 상태인 Hermes Agent](../images/use-case-hermes-online.webp)

## 이 활용 방식이 필요한 사용자

컴퓨터를 계속 켜 두지 않고도 휴대전화, 팀 채널 또는 콘솔에서 접근 가능한 어시스턴트를 원한다면 이 방식을 사용하세요. 일일 브리핑, 미리 알림, 반복 상태 확인처럼 일정에 따른 루틴에도 적합합니다.

온라인 상태와 무인 운영은 같은 의미가 아닙니다. 신뢰할 수 있는 스킬을 선택하고, 반복 지침을 검토하고, 모델과 채널이 예상대로 계속 작동하는지 확인해야 합니다.

## 사전 요구 사항

- LightVela 콘솔에서 실행 중인 Hermes Agent. 계정 설정과 첫 에이전트 생성은 [빠른 시작](../02-quickstart.md)을 참고하세요.

- 정상 작동하는 모델 설정 또는 사용 가능한 체험 크레딧. Hermes가 답변을 생성하려면 모델이 필요합니다.

- 실제로 접근할 수 있도록 Telegram, WhatsApp, Discord, Slack, WeChat 같은 연결 채널 하나 이상.

- Hermes가 메시지를 기다리는 것 이상의 작업을 수행하게 하려는 경우 선택적인 반복 작업.

## 단계 및 핵심 개념

### 1. 실제로 사용하는 채널에서 에이전트에 접근 가능하게 만들기

Hermes에 연락할 기본 방법으로 채널 하나를 선택하세요. 개인 용도라면 하루에도 여러 번 확인하는 앱이 대개 가장 좋은 선택입니다. 채널을 연결하고 짧은 테스트 메시지를 보낸 뒤, 설정을 더 추가하기 전에 Hermes가 답하는지 확인하세요.

[Telegram](../configuration/channel-telegram.md), [WhatsApp](../configuration/channel-whatsapp.md), [Discord](../configuration/channel-discord.md), [Slack](../configuration/channel-slack.md), [WeChat](../configuration/channel-wechat.md)의 자세한 지침을 확인할 수 있습니다.

![연결된 채널이 있는 실행 중 Hermes Agent](../images/use-case-hermes-online-channel.png)

### 2. 작동하는 설정을 단순하고 확인하기 쉽게 유지

중요한 항목은 활성 모델, 연결된 채널, 설치된 스킬, 메모리입니다. 자주 변경할 필요는 없지만 답변이 도착하지 않거나 작업에 새 기능이 필요할 때 어디에서 확인할 수 있는지 알아 두면 좋습니다.

[모델 구성](../configuration/model.md)에서 활성 모델을 확인하고 공급자 또는 체험 크레딧 상태를 기록해 두세요. 스킬을 설치한다면 실제 워크플로에 필요한 항목만 추가하고 [스킬 구성](../configuration/skill.md)에서 검토하세요.

### 3. 메모리로 어시스턴트의 연속성 유지

상시 실행 어시스턴트는 매번 처음부터 시작하지 않을 때 더 유용합니다. 이후 대화에서도 유지할 선호도와 작업 컨텍스트를 Hermes에 알려 주고 [메모리 관리](../configuration/memory.md)에서 주기적으로 확인하세요.

예:

```text
Remember that I prefer updates in bullet points and that urgent work
should be labeled clearly.
```

이렇게 하면 다른 기기나 지원 채널에서 보낸 메시지도 백지에서 시작하지 않고 동일한 업무 관계를 이어 갈 수 있습니다.

### 4. 가용성을 실제 행동으로 이어야 할 때 예약 작업 추가

온라인 Hermes는 사용자의 메시지를 기다릴 수 있지만 작은 자동 작업을 설정하면 적절한 시점에 정해진 루틴을 시작할 수 있습니다. 성공 조건이 명확한 작업 하나로 시작하세요.

```text
Every weekday at 8:30 AM, prepare a short briefing with today’s
calendar priorities, open follow-ups, and the first action to take.
```

[자동 작업](../configuration/automation.md)에서 일정을 만들고, 필요하면 알림 채널을 선택한 뒤 처음 몇 차례 실행을 확인하세요. 결과가 너무 광범위하다면 즉시 다른 자동 작업을 추가하기보다 지침을 더 구체적으로 작성하세요.

![Hermes Agent의 최근 자동 작업 실행](../images/use-case-hermes-online-automation.png)

## FAQ

### Hermes를 사용하려면 노트북을 계속 켜 두어야 하나요?

아니요. Hermes는 LightVela 클라우드 환경에서 실행되므로 에이전트와 채널을 구성한 뒤에는 로컬 기기를 꺼도 됩니다.

### Hermes가 온라인인데 답하지 않는 이유는 무엇인가요?

먼저 채널 연결과 활성 모델 또는 체험 크레딧 상태를 확인하세요. 최근 설정을 변경했다면 업데이트가 끝날 때까지 기다린 뒤 간단한 테스트 메시지를 다시 보내세요. [진단](../configuration/diagnostics.md) 페이지에서 유지 관리와 최근 로그를 확인할 수 있습니다.

### 채널을 두 개 이상 연결할 수 있나요?

네. 지원되는 여러 채널이 같은 Hermes Agent를 가리킬 수 있습니다. 같은 에이전트 행동과 메모리를 공유하므로 기본 채널 하나를 선택하고 실제 액세스 요구를 해결할 때만 다른 채널을 추가하세요.

### 연중무휴 에이전트에 자동 작업을 설정해도 안전한가요?

범위가 명확한 지침과 신뢰할 수 있는 스킬만 사용하세요. 읽기 전용 또는 위험도가 낮은 루틴으로 시작해 출력을 검토하고, 자동으로 반복되기를 원하지 않는 작업을 수행할 권한은 자동 작업에 부여하지 마세요.

## 다음 단계

- [자동 작업](../configuration/automation.md) — 수동 프롬프트 없이 실행할 작업의 일정을 설정합니다.

- [메모리 관리](../configuration/memory.md) — 대화가 바뀌어도 유용한 선호도를 유지합니다.

- [진단](../configuration/diagnostics.md) — Hermes가 응답하지 않을 때 채널 또는 모델 문제를 조사합니다.
