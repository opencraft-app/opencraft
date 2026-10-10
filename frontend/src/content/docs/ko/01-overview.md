# LightVela란 무엇인가요?

## 요약

**LightVela는 Tencent Lighthouse 팀이 제공하는 클라우드 AI 에이전트 제품입니다. 사용자가 만드는 개인 AI 어시스턴트는 현재 Hermes Agent를 기반으로 실행됩니다. LightVela가 클라우드 배포와 운영, 24/7 가동을 관리하므로 구성 파일을 작성하거나 SSH로 서버에 접속할 필요가 없습니다. 시각적 관리 패널에서 항목을 선택해 설정한 뒤 웹의 일상 → 채팅에서 Bot과 바로 대화하거나 평소 사용하는 메시징 앱을 연결할 수 있습니다. 대화가 이어져도 에이전트는 사용자를 기억하며, 사용자가 모델과 도구, 페르소나를 선택합니다. 현재 플랜과 신규 사용자 혜택은 [구독 페이지](/subscribe/)에서 확인할 수 있습니다.**

---

> 시간이 지남에 따라 사용자를 더 잘 이해하는 클라우드 호스팅 Hermes Agent입니다.

LightVela는 Tencent Lighthouse 팀의 클라우드 AI 에이전트 제품입니다. 모든 사람이 **진정으로 자신에게 속한 AI 동반자**를 소유할 수 있도록 설계되었습니다. 매번 자기 소개를 요청하는 도구가 아니라 **당신을 알고, 기억하고, 시간이 지남에 따라 더 잘 이해하는** 장기적인 존재입니다.

에이전트는 24/7 온라인 상태를 유지하고 독립적으로 실행되며 항상 채팅할 준비가 되어 있습니다. 모델, 도구 및 페르소나를 결정합니다.

시각적 콘솔을 통해 구성 장벽을 낮췄습니다. 구성 파일이나 서버 로그인이 필요 없으며 웹 페이지에서 옵션을 선택하기만 하면 설정이 완료됩니다.

사용자가 만드는 개인 AI 어시스턴트는 현재 Hermes Agent를 기반으로 실행됩니다. 이 문서에서는 모델, 도구, 페르소나, 대화 채널을 설정하는 방법을 설명합니다.

![1.00](../images/1-1.webp)

***

## 누구를 위한 것인가

* AI 에이전트를 사용하고 싶지만 서버, 컨테이너, API 인증 및 관련 인프라에 대한 기술적 지식이 없는 사용자

* 독립형 앱 대신 일상적인 메시징 플랫폼(Telegram / WhatsApp / Discord / Slack / WeChat)을 통해 AI와 상호 작용하는 것을 선호하는 사용자

* 여러 대형 언어 모델 공급자(ChatGPT, Claude, Gemini, Deepseek, Qwen, Zhipu, Hunyuan 등 포함) 중에서 선택하려는 사용자

* 매번 처음부터 시작하는 대신 대화 전반에 걸쳐 지속적인 메모리가 필요한 사용자

## 적합하지 않음

* 데이터가 장치 외부로 유출되지 않고 완전한 로컬 실행이 필요한 사용자

* 기본 모델을 훈련하거나 미세 조정해야 하는 사용자

* 에이전트를 자신의 웹사이트나 애플리케이션에 통합해야 하는 개발자

***

## 제품특징

* **완전 관리형 배포**: 클라우드는 환경 설정 및 런타임 관리를 자동으로 처리합니다. 서버 운영, 컨테이너 이미지 또는 인프라 지식이 필요하지 않습니다.

* **전용 클라우드 환경**: 각 Hermes Agent 인스턴스에는 자체 클라우드 환경, 리소스 격리, 24/7 가용성 및 로컬 장치에 대한 종속성이 없습니다.

* **다중 모델 지원**: 주류 중국어 대형 언어 모델, 공급자 Coding Plan 구독 또는 OpenAI 호환 엔드포인트에 연결합니다. [모델 구성](./configuration/model.md)을 참조하세요.

* **다중 채널 액세스**: Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, Lark에서 Hermes Agent와 대화할 수 있습니다

* **스킬 확장**: 콘솔에서 [Skills.sh](https://skills.sh/) 및 [ClawHub](https://clawhub.ai/)의 스킬이나 스킬 패키지를 검색하고 설치합니다.

* **사용 준비 완료**: Launch 플랜에는 체험 크레딧이 포함되어 있으므로 모델을 별도로 구성하지 않고도 활성화 후 채팅을 시작할 수 있습니다.

* **전용 클라우드 스토리지**: 대화 및 메모리 데이터는 독립적으로 저장됩니다.

***

## 작동 원리

LightVela는 클라우드에서 Hermes Agent를 실행합니다. 웹 채팅에서 메시지를 보내거나 필요할 때 외부 메시징 앱을 연결할 수 있습니다.

```
User (sends a message in Web Chat or a connected messaging app)
      ↓
User-dedicated Hermes Agent instance in the LightVela cloud
      ↓
Calls the configured large language model (GPT / Claude / Gemin / ...)
      ↓
Response returns to the same conversation entry point
```

웹 채팅에서 대화할 때 외부 채널은 필요하지 않습니다.

1. **모델**: Hermes Agent가 호출하는 대형 언어 모델입니다. Launch 플랜에는 체험 크레딧이 포함되어 있으며 직접 사용할 수 있습니다. 자신만의 API 키를 구성할 수도 있습니다

2. **채팅 진입점**: My Agent의 채팅에서 선택한 Bot과 대화합니다. Telegram, WhatsApp, Discord, WeChat 등 메시징 앱에서 사용할 때만 채널을 설정합니다

3. **스킬**(선택 사항): Hermes Agent의 추가 기능

![1.00](../images/1-2.webp)

***

## 플랜에 대하여

플랜 하나로 Hermes Agent 클라우드 인스턴스 하나를 이용합니다. 해당 인스턴스 안에서 Launch 계열은 Bot을 최대 5개, Cruise 계열은 최대 10개 지원합니다. Bot은 독립된 프로필이며 추가 Hermes 인스턴스가 아닙니다.

| 플랜 옵션 | 월별 모델 크레딧 | Bot 수 |
|---|---:|---:|
| Launch | 100 | 5 |
| Launch AI | 4,500 | 5 |
| Cruise | 200 | 10 |
| Cruise AI | 10,000 | 10 |

가격, 첫 구매 혜택 및 판매 여부는 달라질 수 있습니다. 구매 전 [구독 페이지](/subscribe)를 확인하세요. 활성 플랜 사용자라면 일회성 [추가 크레딧 팩](./credits.md)도 구매할 수 있습니다.
***

## 등대와의 관계(선택)

Tencent Cloud에 익숙한 사용자의 경우: LightVela는 Tencent Lighthouse 클라우드 에이전트 배포 기능을 즉시 사용할 수 있는 패키지로 이해할 수 있습니다. LightVela는 Tencent Cloud 계정, 리소스 관리 및 클라우드 리소스 운영과 같은 개념을 제거하고 에이전트 구성 및 메시징 플랫폼에 연결이라는 두 가지 핵심 작업만 남깁니다.

Cloud 에이전트를 처음 사용하는 경우 이 섹션을 건너뛸 수 있습니다.

***

## 다음 단계

* **[빠른 시작](./02-quickstart.md)** — 5분 안에 첫 번째 대화를 완료하세요.

* **[핵심 개념](./04-core-concepts.md)** — 다섯 가지 핵심 개념 이해: Hermes Agent, Bot, 모델, 채널 및 스킬

* **[구성 개요](./05-configuration.md)** — 콘솔 기능 및 구성 흐름
