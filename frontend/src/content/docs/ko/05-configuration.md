# 구성 개요

## 요약

**Agent 콘솔 사이드바에는 Channels, Models, Skills, Scheduled Tasks가 각각 별도 페이지로 있습니다. 설정을 바꾸기 전에 대상 Bot을 선택하세요. 채널 카드에서 메시징 앱을 연결하고 모델을 선택하거나 플랜 크레딧을 사용하며, 필요하면 Skills.sh 또는 ClawHub의 스킬을 설치합니다. Soul, Memory, Diagnostics, Advanced Settings, Labs는 다른 섹션에 있고 Cloud Storage는 사용자 메뉴에서 엽니다. Bot이 온라인이고 플랜의 모델 크레딧을 사용할 수 있거나 모델이 설정되어 있다면 채널을 먼저 연결하지 않고 일상 → 채팅에서 메시지를 보낼 수 있습니다.**

---

Agent 콘솔은 사이드바의 **Channels**, **Models**, **Skills**, **Scheduled Tasks** 페이지에서 주요 설정을 제공합니다. 구성할 Bot을 선택한 뒤 해당 페이지를 여세요. 이 가이드는 진입점과 결과 확인 방법을 설명합니다.

## 이 페이지에서는 다음을 다루고 있습니다.

- 콘솔에 들어가는 방법

- Bot 전환기와 선택한 Bot 정보

- Channels, Models, Skills, Cloud Storage의 진입점

- 구성 후 성공 상태

- Bot 관리, 모델 전환, 여러 채널 연결과 같은 일반적인 작업

---

## 콘솔에 들어가세요

로그인한 뒤 [Agent 콘솔](/agents/overview/)을 열고 설정할 Hermes Agent와 Bot을 선택하세요.


웹 채팅은 일상 영역에 있습니다. 메시징 앱을 사용할 때만 외부 채널을 연결하세요.
---

## Bot과 선택한 Bot 정보

Bot 표시줄에서 원하는 Bot의 아바타를 선택합니다. 화면이 좁으면 먼저 탐색 패널을 여세요. 모델, 메모리, 스킬, 채널, 예약 작업을 바꾸기 전에 이름을 확인하세요. 웹 채팅과 대화 목록은 선택한 Bot에 속하며 추가 Bot도 웹 채팅을 사용할 수 있습니다. 웹 채팅에는 메시징 채널 연결이 필요하지 않습니다.

추가 Bot을 만들려면 생성 기능을 사용할 수 있고 플랜 한도에 여유가 있을 때 **새 Bot**을 선택합니다. **이름**은 필수이고 **설명**은 선택 사항입니다. 필요하면 외형을 조정하세요. 기본 선택은 **빈 Bot 만들기**입니다. 복사할 수 있는 Bot이 있으면 **고급**을 열고 특정 원본 Bot을 선택합니다. 사용 중인 Bot을 복사하려면 **Bot 관리 → Bot 복사**를 엽니다. 생성 양식에서 해당 원본이 미리 선택됩니다. 원본을 확인하고 **만들기**를 선택한 뒤 완료될 때까지 기다립니다.

Hermes Agent를 선택하면 기본 정보가 아래와 같이 표시됩니다.

- 아바타

- 이름(수정하려면 이름이나 연필 아이콘을 클릭한 다음 Enter를 눌러 저장하세요)

- 상태(● 실행 중 / ● 알 수 없음)

- 생성 시간

- 삭제 버튼(오른쪽 휴지통 아이콘)

> ⚠️ **삭제하면 되돌릴 수 없습니다**
>
> 추가 Bot을 삭제하면 해당 Bot의 프로필과 데이터가 영구적으로 삭제됩니다. 기본 Bot을 삭제하면 Hermes Agent 전체와 관련 데이터가 삭제되며, 다른 Bot을 먼저 모두 삭제해야 합니다.

---

## 채널, 모델, 스킬 구성

### Channels

Agent 사이드바에서 **Channels**를 엽니다. Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, Lark 카드에서 대상 채널의 **+ Connect**를 선택하세요. WhatsApp, WeChat, WeCom, Lark는 QR 코드 인증을 사용하고 Telegram, Discord, Slack은 자격 증명을 사용합니다. QQ는 QR 코드 또는 App ID / Secret을 사용할 수 있습니다. [WhatsApp 가이드](./configuration/channel-whatsapp.md)를 참고하세요.

### Models

**Models**에서 활성 모델을 확인하거나 공급자를 설정합니다. 자체 API 키 없이 플랜의 모델 크레딧을 사용할 수 있으며 필요할 때 공급자를 추가할 수 있습니다. 각 Bot은 한 번에 하나의 기본 모델을 사용하고 별도 대체 모델을 구성할 수도 있습니다. [모델 구성](./configuration/model.md)과 [모델 전환](./configuration/multiple-models.md)을 참고하세요.

### Skills

**Skills**에서 개별 스킬을 검색하거나 [Skills.sh](https://skills.sh/)와 [ClawHub](https://clawhub.ai/)의 **Skill Packages**를 둘러봅니다. **Install**을 선택하고 **Installed**에서 결과를 확인하세요. [스킬 구성](./configuration/skill.md)을 참고하세요.

## 구성 후 성공 상태

구성이 완료되면 콘솔에 다음 상태가 표시되어야 합니다.

- "연결된 채널" 목록에는 하나 이상의 레코드가 있습니다(예: "WeChat")

- "현재 모델"은 선택 사항입니다. Launch 체험 크레딧을 사용하는 경우 구성이 필요하지 않습니다.

- "설치된 스킬"은 필요에 따라 구성하며 비어 있어도 됩니다.

"연결된 채널"에 하나 이상의 항목이 있으면 해당 메시징 플랫폼에서 봇을 찾아 대화를 시작할 수 있습니다. Hermes Agent는 기본 모델 또는 Launch 체험 크레딧을 사용해 응답을 생성합니다.

---

## 일반적인 작업

- **모델 전환:** 선택한 Bot의 **Models**에서 구성된 사용 가능한 모델을 선택합니다. Bot의 메모리는 유지됩니다. [모델 전환](./configuration/multiple-models.md)을 참고하세요.
- **여러 채널 연결:** **Channels**에서 필요한 카드의 **+ Connect**를 선택합니다. 같은 Bot에 연결된 채널은 해당 Bot의 페르소나와 메모리를 공유합니다.
- **Bot 관리:** 설정을 변경하기 전에 Bot 탭을 선택합니다. 생성 기능을 사용할 수 있다면 [Bot 관리](./configuration/bots.md)를 참고하세요.
- **Cloud Storage 열기:** Agent 사이드바가 아닌 사용자 메뉴에서 엽니다.

---

## 다음 단계

각 모듈의 세부 구성:

- [Bot 관리](./configuration/bots.md) — Bot 생성, 복사, 전환, 이름 변경, 삭제

- [모델 구성](./configuration/model.md) — 모델 소스, API 키 획득 및 선택 안내

- [채널 구성 - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [WeCom](./configuration/channel-wecom.md) / [Lark](./configuration/channel-feishu.md)

- [스킬 구성](./configuration/skill.md) — Skills.sh / ClawHub 사용 및 스킬 설치

관련 참고자료:

- [핵심 개념](./04-core-concepts.md)

- [빠른 시작](./02-quickstart.md)
