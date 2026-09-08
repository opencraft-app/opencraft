# AI 에이전트를 메시징 플랫폼에 연결하는 방법

## 요약

**Hermes Agent를 메시징 플랫폼에 연결하는 방식은 하나의 개념에 기반합니다. 채널은 진입점이고, 실제로 작업하는 주체는 에이전트입니다. 하나의 클라우드 에이전트가 연결된 모든 채널에서 같은 모델, 스킬, 메모리를 공유하므로 플랫폼마다 별도의 봇을 만들 필요가 없습니다.** 절차는 네 단계입니다. 먼저 지역에서 채널을 사용할 수 있는지 확인합니다. 국제 지역은 Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, Lark를 지원하고 중국 지역은 WeChat, QQ, WeCom, Lark, DingTalk를 지원합니다. 다음으로 플랫폼에서 인증을 완료해 자격 증명을 얻고, 콘솔에서 연결한 뒤 채널이 연결됨으로 표시되는지 확인합니다. 마지막으로 테스트 메시지를 보내고 메시지를 보낸 동일한 대화에 답변이 도착하는지 확인합니다. 자격 증명은 민감 정보이므로 장기 컨텍스트에 기록하거나 채팅에 붙여넣지 마세요.

![LightVela 메시징 플랫폼 연결](../images/use-case-messaging-platforms.webp)

## 이 가이드가 필요한 사용자

웹 콘솔뿐 아니라 메시징 앱에서 Hermes와 대화하고 싶은 사용자를 위한 가이드입니다. 개인 용도로는 Telegram, 커뮤니티 용도로는 Discord처럼 하나의 어시스턴트를 두 곳 이상에서 사용하고 싶을 때도 도움이 됩니다.

하나의 채널로 시작하세요. 서로 다른 상황, 대상 또는 기기 사용 습관을 분명히 충족할 때만 다른 채널을 추가하세요.

## 사전 요구 사항

- 실행 중인 Hermes Agent가 있는 LightVela 계정. 에이전트를 만들어야 한다면 [빠른 시작](../02-quickstart.md)을 이용하세요.

- 채널 연결 후 Hermes가 답할 수 있도록 정상 작동하는 모델 설정 또는 체험 크레딧.

- 연결하려는 플랫폼에 대한 액세스 권한. 일부 플랫폼은 QR 코드 인증을 사용하고, 다른 플랫폼은 봇 토큰 또는 플랫폼 자격 증명이 필요합니다.

- 설정을 마친 직후 보낼 수 있는 테스트 메시지.

## 단계 및 핵심 개념

### 1. 대화에 맞는 채널 선택

연결할 수 있는 플랫폼 수가 아니라 실제로 어시스턴트를 사용할 위치에 따라 선택하세요. Telegram, WhatsApp, Discord, Slack, WeChat은 일반적인 선택입니다.

| 채널 | 적합한 용도 |
| --- | --- |
| Telegram | 개인 메시지, 가벼운 루틴, 일대일 대화 |
| WhatsApp | WhatsApp을 기본으로 사용하는 일상 소통과 알림 |
| Discord | 커뮤니티, 개발자 그룹, 체계적인 토론 공간 |
| Slack | 팀 협업, 워크스페이스 알림, 채널 워크플로 |
| WeChat | WeChat을 매일 사용하는 사용자의 개인 대화 |

LightVela는 그 밖의 지원 채널에도 설정 페이지를 제공합니다. 현재 Hermes Agent에서 사용할 수 있는 채널은 콘솔의 Channel 페이지를 기준으로 확인하세요.

### 2. 플랫폼별 연결 절차 완료

콘솔에서 Channel 영역을 열고 플랫폼을 선택한 뒤 해당 인증 또는 자격 증명 절차를 따릅니다. 다른 플랫폼의 자격 증명을 복사하지 말고 플랫폼별 가이드를 사용하세요.

- [Telegram](../configuration/channel-telegram.md)
- [WhatsApp](../configuration/channel-whatsapp.md)
- [Discord](../configuration/channel-discord.md)
- [Slack](../configuration/channel-slack.md)
- [WeChat](../configuration/channel-wechat.md)

봇 토큰, 애플리케이션 ID, 비밀 정보는 비밀번호처럼 취급하세요. 그룹 채팅, 공개 문서 또는 다른 사람에게 보내는 메시지에 붙여넣지 마세요. 자격 증명이 노출되었다면 Hermes를 다시 연결하기 전에 해당 자격 증명을 발급한 플랫폼에서 교체하세요.

![LightVela 채널 연결 페이지](../images/use-case-messaging-connection.png)

### 3. 간단한 대화로 연결 확인

콘솔에서 채널이 연결됨으로 표시되면 해당 플랫폼에서 봇 또는 대화를 찾아 짧은 메시지를 보냅니다.

```text
Hi Hermes. Please reply with the channel you received this from.
```

이 테스트는 전체 경로를 확인합니다. 플랫폼이 메시지를 전달할 수 있고, Hermes에 작동하는 모델이 있으며, 답변이 같은 위치로 돌아오는지 점검합니다. 작동하지 않으면 먼저 연결 상태를 확인한 뒤 [모델 구성](../configuration/model.md)에서 활성 모델을 확인하세요.

### 4. 채널 간 공유할 항목 결정

여러 채널을 같은 Hermes Agent에 연결하면 각 채널은 동일한 어시스턴트로 들어가는 서로 다른 문이 됩니다. 따라서 지원되는 채널에서 에이전트가 같은 메모리, 작업 선호도, 설치된 스킬을 유지할 수 있습니다.

[메모리 관리](../configuration/memory.md)에서 Hermes가 유지할 장기 컨텍스트를 확인하세요. 특정 채널의 대상이 다르거나 매우 다른 역할이 필요하다면 서로 무관한 기대를 하나의 대화 기록에 섞지 말고 활용 사례를 분리하는 편을 고려하세요.

![채널 간 공유되는 동일한 Hermes Agent 컨텍스트](../images/use-case-messaging-memory.png)

커뮤니티에 Discord 채널을 사용하려면 [Discord용 LightVela: 채널을 지원하는 AI 에이전트 Discord 봇](./discord-community-agent.md)을 계속 읽어 보세요.

## FAQ

### 하나의 Hermes Agent에 여러 메시징 플랫폼을 연결할 수 있나요?

네. 지원되는 채널은 같은 에이전트를 가리킬 수 있으므로, 동일하게 설정된 행동과 메모리를 유지하면서 여러 메시징 앱에서 접근할 수 있습니다.

### 어떤 채널을 먼저 연결해야 하나요?

가장 자주 사용하는 채널을 선택하세요. 첫 메시지를 쉽게 보낼 수 있어야 개인 어시스턴트를 실제로 활용할 가능성이 커집니다. Telegram, WhatsApp, Discord, Slack, WeChat에는 각각 자세한 설정 가이드가 있습니다.

### 채널이 연결됨으로 표시되는데 Hermes가 답하지 않는 이유는 무엇인가요?

간단한 테스트 메시지를 보낸 뒤 활성 모델 또는 체험 크레딧을 사용할 수 있는지 확인하세요. 문제가 계속되면 채널을 다시 연결하고 [진단](../configuration/diagnostics.md)에서 유지 관리 옵션과 최근 로그를 확인하세요.

### 하나의 봇 자격 증명을 여러 Hermes Agent에서 공유할 수 있나요?

플랫폼과 의도한 워크플로에서 명확히 지원하지 않는다면 공유하지 마세요. 하나의 자격 증명을 하나의 분명한 목적에 연결해 두면 문제 해결과 액세스 제어가 훨씬 쉬워집니다.

## 다음 단계

- [모델 구성](../configuration/model.md) - Hermes가 답변할 모델을 사용할 수 있는지 확인합니다.

- [메모리 관리](../configuration/memory.md) - 연결된 채널이 공유하는 컨텍스트를 관리합니다.

- [예약 작업](../configuration/automation.md) - 적절한 경우 일정에 따른 업데이트를 연결된 채널로 전송합니다.
