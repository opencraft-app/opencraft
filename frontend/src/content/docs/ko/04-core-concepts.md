# 핵심 개념

## 요약

**LightVela에는 다섯 가지 핵심 개념이 있습니다. Hermes Agent는 클라우드 인스턴스이고 Bot은 그 안의 독립된 프로필입니다. 각 Bot은 모델 설정, 연결 채널, 스킬과 별도의 페르소나, 메모리, 예약 작업을 가질 수 있습니다. 같은 Bot에 연결된 채널은 설정을 공유하지만 서로 다른 Bot의 설정은 자동으로 공유되지 않습니다. 메시지는 채널을 통해 대상 Bot에 전달되고, Bot은 필요하면 스킬과 모델을 사용한 뒤 같은 채널로 답합니다.**

---

LightVela의 다섯 가지 핵심 개념은 Hermes Agent, Bot, 모델, 채널, 스킬입니다. 이 페이지에서는 관계를 설명합니다.

## 이 페이지에서는 다음을 다루고 있습니다.

- 다섯 가지 개념의 관계

- Hermes Agent 인스턴스의 특성

- 모델, 채널 및 스킬의 위치 지정 및 구성 진입점

- 완전한 대화의 내부 흐름

---

## 개념 간 관계

```text
Hermes Agent (cloud instance)
  └─ Bot profiles (main Bot and optional additional Bots)
       ├─ Primary model and optional fallbacks
       ├─ Connected channels
       └─ Skills, Soul, memory, scheduled tasks
```

| 개념 | 역할 | 설명 |
|---|---|---|
| Hermes Agent | 대화 주제 | AI 에이전트 인스턴스 자체 |
| Bot | 독립된 프로필 | 자체 모델, 채널, 스킬, 페르소나, 메모리, 예약 작업을 가짐 |
| 모델 | 언어 능력 | Hermes Agent가 호출하는 대형 언어 모델 |
| 채널 | 상호작용 진입점 | 사용자가 Hermes Agent와 채팅하는 플랫폼 |
| 스킬 | 기능 확장 | Hermes Agent로 호출 가능한 추가 기능 패키지 |


---

## Hermes Agent

Hermes Agent는 LightVela의 AI 에이전트 인스턴스입니다. Hermes Agent를 생성하는 것은 클라우드에서 독립적인 에이전트 인스턴스를 시작하는 것과 같습니다.

Hermes Agent에는 다음과 같은 특성이 있습니다.

- **전용 클라우드 환경**: 각 Hermes Agent는 전용 환경에서 실행되며 다른 인스턴스와 리소스가 격리됩니다.

- **영구적 메모리**: 대화 내용은 여러 세션에 걸쳐 저장되며 에이전트는 응답할 때 과거 컨텍스트를 사용합니다.

- **항상 온라인**: 24/7로 실행되며 사용자의 로컬 장치에 의존하지 않습니다.

현재 Launch 플랜은 최대 1개의 Hermes Agent 인스턴스 생성을 지원합니다.

---

## Bot

각 Hermes Agent에는 기본 Bot이 있으며 플랜 한도와 기능 제공 상태에 따라 추가 Bot을 사용할 수 있습니다. Bot은 같은 클라우드 인스턴스에 있지만 설정과 데이터는 분리됩니다. 모델, 채널, 스킬, 메모리를 바꾸기 전에 대상 Bot을 선택하세요. [Bot 관리](./configuration/bots.md)를 참고하세요.

---

## 모델

모델은 Hermes Agent 사고와 반응을 주도하는 대형 언어 모델(LLM)입니다. LightVela는 모델 자체를 교육하지 않습니다. 대신 사용자는 콘솔의 "모델" 카드에서 호출 방법을 선택합니다.

| 방법 | 결제 모드 | API 키 소스 | 사용 사례 |
|---|---|---|---|
| 모델 Coding Plan | 월간 | 공급자 | 고주파 사용 |
| 모델 API | 사용량 기준 과금 | 제공업체 | 사용 빈도가 낮거나 시험적으로 사용할 때 |
| 커스텀 모델 | 엔드포인트에 따라 다름 | 사용자 제공 | 해외 모델 또는 OpenAI 호환 엔드포인트 연결 |

또한 Launch 플랜에는 100 체험 크레딧이 포함되어 있으므로 구성 없이 즉시 채팅할 수 있습니다. 체험 크레딧이 소진된 후에는 자신만의 API 키를 구성할 수 있습니다.

지원되는 모델, API 키 획득 및 모델 선택 지침은 [모델 구성](./configuration/model.md)을 참조하세요.

> Bot은 한 번에 하나의 기본 모델을 사용합니다. 다른 모델이나 대체 모델도 구성할 수 있으며 활성 모델을 바꿀 때 이전 설정을 삭제할 필요가 없습니다. [모델 전환](./configuration/multiple-models.md)을 참고하세요.

---

## 채널

채널은 사용자가 Hermes Agent와 채팅하는 메시징 플랫폼 진입점입니다. LightVela는 현재 다음 채널을 지원합니다.

| 채널 | 액세스 방법 | 사용 사례 |
|---|---|---|
| WeChat | QR 코드 인증 | 매일 개인 사용, 중국 사용자에게 적합 |
| Telegram | 봇 토큰 액세스 | 개인 또는 팀 메시징, 간단한 설정, 경량 예약 작업에 적합 |
| WhatsApp | WhatsApp으로 QR 코드 스캔 | 국제 사용자 통신, 고객 서비스, 알림 및 미리 알림 |
| Discord | 봇 토큰 액세스 | 커뮤니티 운영, 개발자 커뮤니티, 게임 또는 관심 그룹 |
| Slack | 봇 토큰/앱 토큰 액세스 | 팀 협업, 작업 공간 알림 및 채널 기반 워크플로우 |

**Channels**의 **WeChat** 카드에서 **+ Connect**를 선택하고 휴대폰으로 QR 코드를 스캔하세요.

각 채널에 대한 자세한 액세스 단계: [채널 구성 - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md).

> 💡 **여러 개의 채널이 공존할 수 있습니다**
>
> 같은 Bot에 연결된 채널은 해당 Bot의 페르소나와 메모리를 공유합니다. 다른 Bot의 설정은 자동으로 공유되지 않습니다.

---

## 스킬

스킬은 Hermes Agent에서 호출할 수 있는 추가 기능 패키지입니다. Hermes Agent는 할 일 정리, 일일 보고서 생성, 웹 검색, 이미지 생성 등과 같은 특정 작업을 위한 기본 대화 이상으로 확장됩니다.

국제 사이트의 스킬은 [Skills.sh](https://skills.sh/)와 [ClawHub](https://clawhub.ai/)에서 제공됩니다. 콘솔의 **Skills** 페이지에서 출처와 설명을 확인한 뒤 설치하세요.

콘솔에서 **Skills**를 열고 개별 스킬을 검색하거나 **Skill Packages**를 둘러본 뒤 **Install**을 선택합니다. **Installed**에서 결과를 확인하세요. [스킬 구성](./configuration/skill.md)을 참고하세요.

> ⚠️ **설치 전 보안 점검**
>
> 스킬에는 런타임 시 Hermes Agent 기능을 호출할 수 있는 권한이 있습니다. 스킬을 설치하기 전에 작성자가 신뢰할 수 있는지 확인하고 다운로드 수가 많고 평가가 좋은 스킬을 선호합니다.

---

## 상호작용 흐름

전체 대화 흐름은 다음과 같이 작동합니다.

1. 사용자는 채널(예: WeChat)을 통해 Hermes Agent에 메시지를 보냅니다.

2. Hermes Agent는 메시지를 기반으로 스킬을 호출해야 하는지 여부를 결정합니다.

3. 모델은 컨텍스트를 처리하고 응답을 생성합니다.

4. 응답은 원본 채널을 통해 사용자에게 반환됩니다.

---

## 다음 단계

- [구성 개요](./05-configuration.md) — 전체 콘솔 기능 가이드

- [빠른 시작](./02-quickstart.md) — Hermes Agent가 생성되지 않은 경우 시작하기
