# 구성 개요

## 요약

**LightVela의 모든 설정은 로그인 후 오른쪽 상단에서 여는 "My Hermes" 콘솔에 모여 있습니다. 상단에는 에이전트 인스턴스 탭이 있고, 그 아래에 모델·채널·스킬의 세 가지 설정 버튼이 있습니다. 모델에서는 모델 Coding Plan, 모델 API, 사용자 지정 OpenAI 호환 엔드포인트를 선택합니다. 채널은 메시징 플랫폼과 연결하는 진입점으로, QR 코드나 토큰 또는 앱 ID가 필요합니다. 스킬에서는 재사용 가능한 기능 팩을 설치합니다. 콘솔에서는 이 밖에도 채팅, 작업, 메모리 관리, 클라우드 스토리지, 모델 전환, 진단 센터를 이용할 수 있습니다. 모델과 채널 등 기본 설정을 마치면 메시징 채널에서 에이전트와 대화할 수 있습니다.**

---

모든 LightVela 구성은 "My Hermes" 콘솔에 집중되어 있으며 세 가지 구성 버튼으로 구성됩니다.

1. 모델

2. 채널

3. 스킬

이 페이지에서는 콘솔의 전체 구조와 각 버튼의 기능을 소개합니다. 자세한 작업은 해당 하위 페이지를 참조하세요.

## 이 페이지에서는 다음을 다루고 있습니다.

- 콘솔에 들어가는 방법

- Hermes Agent 인스턴스 정보 버튼

- 세 가지 구성 버튼의 기능 및 진입점

- 구성 후 성공 상태

- 모델 전환, 여러 채널 연결, Hermes Agent 다시 생성과 같은 일반적인 작업

---

## 콘솔에 들어가세요

로그인 후 오른쪽 상단의 "My Hermes"를 클릭하여 콘솔에 들어갑니다. 페이지 상단에는 "홈으로 돌아가기" 버튼이 있습니다.

---

## Hermes Agent 인스턴스 정보

콘솔 상단에는 Hermes Agent 탭이 있습니다. 각 탭은 하나의 Hermes Agent 인스턴스를 나타냅니다(Launch 플랜은 1개만 지원). 인스턴스 한도에 도달하면 오른쪽의 "+ 만들기" 버튼을 사용할 수 없게 됩니다.

Hermes Agent를 선택하면 기본 정보가 아래와 같이 표시됩니다.

- 아바타

- 이름(수정하려면 이름이나 연필 아이콘을 클릭한 다음 Enter를 눌러 저장하세요)

- 상태(● 실행 중 / ● 알 수 없음)

- 생성 시간

- 삭제 버튼(오른쪽 휴지통 아이콘)

> ⚠️ **삭제하면 되돌릴 수 없습니다**
>
> 휴지통 아이콘을 클릭하면 모든 대화 메모리, 연결된 채널 및 설치된 스킬을 포함하여 Hermes Agent 인스턴스가 영구적으로 삭제됩니다. Launch 플랜의 인스턴스 한도가 남아 있는 경우 나중에 새 Hermes Agent를 생성할 수 있습니다.

---

## 구성 버튼 3개

세 개의 버튼은 왼쪽에서 오른쪽으로 배열되어 있습니다. 권장 구성 순서는 1 → 2 → 3입니다.

### 1. 채널

![](./images/4-2.webp)

**목적**: Hermes Agent를 메시징 플랫폼에 연결하고 사용자에게 대화 진입점을 제공합니다.

**채널별 연결 방법**:

| 채널 | 액세스 방법 | 요구 사항 |
|---|---|---|
| WeChat | QR 코드 인증 | WeChat이 설치된 전화기 |
| Telegram | 봇 토큰 액세스 | BotFather를 통해 Telegram 봇을 생성하고 봇 토큰을 얻습니다. |
| WhatsApp | WhatsApp Business API 연결 | Meta 개발자 계정, WhatsApp Business 계정, 기본 Cloud API 설정 |
| Discord | 봇 토큰 액세스 | Discord 개발자 포털에서 애플리케이션을 생성하고 봇을 추가한 후 서버에 초대합니다. |
| Slack | 봇 토큰/앱 토큰 액세스 | Slack 앱을 생성하고, 소켓 모드를 활성화하고, 봇/앱 토큰을 얻습니다. |
| QQ | AppID / AppSecret 연결 | QQ 계정, QQ Open Platform에서 생성한 봇의 AppID / AppSecret |
| WeCom | QR 코드 인증 | WeCom이 설치된 전화기 |
| Lark | QR 코드 인증 | Lark가 설치된 휴대폰(또는 데스크톱 Lark가 이미 로그인되어 있음) |

**버튼에서 제공하는 항목**: 채널 드롭다운, "액세스 승인" 버튼, 선택한 채널 소개, "세부 정보 보기" 링크, "연결된 채널" 목록.

자세한 내용은 [WeChat](./configuration/channel-wechat.md), [Telegram](./configuration/channel-telegram.md), [WhatsApp](./configuration/channel-whatsapp.md), [Discord](./configuration/channel-discord.md), [Slack](./configuration/channel-slack.md), [QQ](./configuration/channel-qq.md), [WeCom](./configuration/channel-wecom.md), [Lark](./configuration/channel-feishu.md) 채널 구성 문서를 참조하세요.

---

### 2. 모델

![](./images/4-1.webp)

**목적**: Hermes Agent에 대한 대형 언어 모델을 구성합니다. Launch 플랜에는 100개의 체험 크레딧이 포함되어 있으므로 처음에는 이 단계를 건너뛰고 크레딧이 소진된 후 모델을 구성할 수 있습니다.

**버튼에서 제공하는 항목**: 소스 드롭다운(모델 Coding Plan / 모델 API / 사용자 지정 모델), 모델 드롭다운, API 키 입력란, 프로바이더 소개, API 키 발급 링크, "현재 모델" 목록.

> ⚠️ **하나의 모델만 활성화됩니다**
>
> 현재 각 Hermes Agent에는 활성 모델 구성이 하나만 있을 수 있습니다. 새로운 "기본값으로 추가" 작업은 기존 구성을 덮어씁니다.

자세한 내용은 [모델 구성](./configuration/model.md)을 참조하세요.

---

### 3. 스킬

![](./images/4-3.webp)

**목적**: 할 일 정리, 일일 보고서 생성, 웹 검색 등 Hermes Agent 기능을 확장합니다.

**버튼에서 제공하는 항목**: 스킬 이름 검색창, "스킬 설치" 버튼, "SkillHub로 이동" 링크, "설치된 스킬" 목록. 설치 전에 [SkillHub](https://skillhub.tencent.com)에서 정확한 스킬 이름을 확인하세요.

> ⚠️ **신뢰할 수 있는 스킬만 설치**
>
> 스킬에는 런타임 시 Hermes Agent 기능을 호출할 수 있는 권한이 있습니다. 신뢰할 수 있는 소스에서만 스킬을 설치하세요.

자세한 내용은 [스킬 구성](./configuration/skill.md)을 참조하세요.

---

## 구성 후 성공 상태

구성이 완료되면 콘솔에 다음 상태가 표시되어야 합니다.

- "연결된 채널" 목록에는 하나 이상의 레코드가 있습니다(예: "WeChat")

- "현재 모델"은 선택 사항입니다. Launch 체험 크레딧을 사용하는 경우 구성이 필요하지 않습니다.

- "설치된 스킬"은 필요에 따라 구성하며 비어 있어도 됩니다.

"연결된 채널"에 하나 이상의 항목이 있으면 해당 메시징 플랫폼에서 봇을 찾아 대화를 시작할 수 있습니다. Hermes Agent는 기본 모델 또는 Launch 체험 크레딧을 사용해 응답을 생성합니다.

---

## 일반적인 작업

### 모델 전환

"모델" 버튼에서 소스와 모델을 다시 선택하고 API 키를 입력한 후 "기본값으로 추가"를 클릭합니다. 새 구성이 이전 구성을 덮어쓰지만 대화 메모리에는 영향을 주지 않습니다.

### 여러 채널 연결

"채널" 버튼에서 드롭다운 옵션을 하나씩 전환하고 "액세스 승인"을 클릭하세요. 여러 채널이 동일한 Hermes Agent를 가리키고 메모리 및 에이전트 동작을 공유합니다.

### Hermes Agent 재생성

현재 Hermes Agent를 삭제하려면 기본 정보 영역 오른쪽의 휴지통 아이콘을 클릭하고, 다시 만들려면 "+ Hermes Agent 생성"을 클릭하세요. **모든 대화 메모리가 삭제됩니다**.

---

## 다음 단계

각 모듈의 세부 구성:

- [모델 구성](./configuration/model.md) — 모델 소스, API 키 획득 및 선택 안내

- [채널 구성 - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [WeCom](./configuration/channel-wecom.md) / [Lark](./configuration/channel-feishu.md)

- [스킬 구성](./configuration/skill.md) — SkillHub 사용 및 스킬 설치

관련 참고자료:

- [핵심 개념](./04-core-concepts.md)

- [빠른 시작](./02-quickstart.md)
