# 빠른 시작

## 요약

**LightVela에서 첫 대화를 시작하는 데는 약 5분이 걸립니다. 로그인한 뒤 플랜을 활성화하고, 플랫폼이 Hermes Agent 인스턴스를 생성하도록 한 다음 모델을 구성하거나 플랜에 포함된 월간 모델 크레딧을 사용하세요. 이어서 메시징 채널 하나를 연결하고 메시지를 보내 답장을 받으면 됩니다. 모든 과정은 브라우저에서 진행되므로 서버를 구매하거나 로컬 환경에 배포할 필요가 없습니다. 가장 빠른 방법은 플랜 크레딧을 사용하고 QR 코드로 WeChat을 연결하는 것입니다. 자체 모델 API 키와 다른 채널은 나중에 추가할 수 있습니다.**

---

이 튜토리얼에서는 로그인부터 WeChat에서 Hermes 응답 수신까지 전체 프로세스를 안내합니다. 약 5분 정도 소요됩니다.

## 이 페이지에서는 다음을 다루고 있습니다.

- LightVela에 로그인

- Launch 플랜 활성화 및 Hermes 인스턴스 생성

- Telegram / WhatsApp / Discord / Slack / WeChat 채널 연결하기

- WeChat으로 메시지 보내고 답장 받기

> 💡 **전제 조건**
>
> - Google 또는 GitHub 계정
>
> Launch 플랜에는 100 체험 크레딧이 포함되어 있으므로 사전에 대형 언어 모델 API 키를 준비하지 않고도 채팅을 시작할 수 있습니다.

---

## 1. LightVela에 로그인하세요

[lightvela.ai](https://lightvela.ai)에 접속해 오른쪽 상단의 "로그인"을 클릭하세요. 로그인 창에서 Google 또는 GitHub를 선택하고 약관에 동의한 뒤 인증을 완료하세요.

![](../images/2-1.webp)

---

## 2. Launch 플랜 활성화

[구독 페이지](/subscribe)에서 Launch 계열의 **100크레딧 Launch** 옵션을 선택하고 플랜 카드의 절차를 따릅니다. 확정 전에 표시된 가격과 첫 구매 혜택을 확인하세요.


> ⚠️ **신규 사용자 혜택**
>
> 조건을 충족하는 신규 사용자는 Launch를 1개월간 무료로 체험할 수 있습니다. 현재 조건과 이용 가능 여부는 [구독 페이지](/subscribe/)에서 확인하세요.


---

## 3. Hermes Agent 열기

플랜을 활성화한 후 [Agent 콘솔](/agents/overview/)을 엽니다. LightVela가 해당 플랜의 클라우드 인스턴스를 준비합니다. 콘솔에서 Agent 생성을 요청하면 화면 안내에 따라 진행하고 상태가 **Running**이 될 때까지 기다립니다. 사이드바에는 **Channels**, **Models**, **Skills**, **Scheduled Tasks**가 표시됩니다. 자체 API 키 없이 플랜 모델 크레딧을 사용할 수 있습니다.

---

## 4. WeChat 연결

Agent 사이드바에서 **Channels**를 열고 **WeChat** 카드의 **+ Connect**를 선택한 뒤 QR 코드 안내를 따릅니다. 휴대폰의 WeChat으로 스캔하고 인증을 마치세요. 메시지를 보내기 전에 콘솔에 연결된 상태로 표시되는지 확인합니다. 코드 만료나 연결 실패 시 [WeChat 가이드](./configuration/channel-wechat.md)를 참고하세요.

---

## 5. 첫 번째 메시지 보내기

WeChat에서 추가된 봇 계정을 찾아 테스트 메시지를 보냅니다.

```
Hi
```

![](../images/2-7.webp)

몇 초 내에 Hermes로부터 응답을 받아야 합니다. Hermes는 이제 WeChat을 통해 채팅할 수 있습니다.

> 💡 **메시지 청구**
>
> 모델 호출에는 기본적으로 Launch 옵션의 100크레딧이 사용됩니다. 크레딧이 부족하면 구매 가능한 [추가 팩](./credits.md)을 구입하거나 **Models**에서 자체 API 키를 설정하세요.

---

## 고급: 자신만의 모델 구성(선택 사항)

특정 공급자가 필요하면 Agent 사이드바에서 **Models**를 열고 공급자와 모델을 선택한 후 API 키를 추가하여 기본 모델로 설정하세요. [모델 구성](./configuration/model.md)을 참고하세요.

---

## FAQ

| 문제 | 확인할 사항 | 다음 단계 |
|---|---|---|
| Launch를 활성화할 수 없음 | 판매 여부, 대상 자격, 결제 상태 | [구독 페이지](/subscribe)와 최종 결제 메시지를 확인하고 완료된 주문을 중복 진행하지 마세요. |
| Agent 준비가 오래 걸림 | 콘솔에 준비 중 표시 또는 오류가 있는지 | Agent 개요를 한 번 새로고침하고 변화가 없다면 [Diagnostics](./configuration/diagnostics.md)나 지원팀을 이용하세요. |
| WeChat QR 코드가 만료됨 | 휴대폰에서 인증을 완료했는지 | **Channels**로 돌아가 새 연결을 시작하세요. |
| 메시지에 답이 없음 | 채널 연결, Agent 상태, 모델 크레딧 | **Channels**와 **Diagnostics**를 확인하세요. 크레딧이 부족하면 [추가 옵션](./credits.md)을 참고하세요. |
---

## 다음 단계

- [핵심 개념](./04-core-concepts.md) — 다섯 가지 핵심 개념 이해: Hermes Agent, Bot, 모델, 채널 및 스킬

- [구성 개요](./05-configuration.md) — 전체 콘솔 구조

- [스킬 구성](./configuration/skill.md) — Skills.sh 또는 ClawHub의 스킬 설치
