# Telegram에서 개성이 뚜렷한 Hermes Agent를 설정하는 방법

## 요약

**Telegram은 에이전트에 접속하는 진입점일 뿐입니다. 에이전트의 말투, 작업 방식, 하지 말아야 할 일은 페르소나와 장기 맥락에서 결정됩니다.** 설정 과정은 두 단계입니다. 먼저 채널 가이드에 따라 BotFather에서 Bot과 토큰을 만들고 Hermes Agent에 연결한 뒤, 콘솔에 연결된 것으로 표시되는지 확인합니다. 다음으로 에이전트 설정의 페르소나 섹션에서 지속적으로 사용할 역할, 말투, 행동 경계를 선택해 주입합니다. 페르소나는 오래 유지할 행동 원칙을, 사용자 프로필은 어떤 방식으로 응대받고 싶은지를, 장기 메모리는 확인된 사실과 프로젝트 배경을 담당합니다. Telegram 그룹 메시지를 사용하려면 BotFather에서 Group Privacy를 끄고 Bot을 그룹에 추가한 뒤 `@bot_username`을 멘션하여 대화를 시작해야 합니다.

![Telegram에서 뚜렷한 페르소나를 사용하는 Hermes Agent](../images/use-case-03-telegram-persona-agent.png)

## 대상 독자

이 가이드는 시간이 지나도 Telegram에서 일관된 페르소나를 유지하는 Hermes Agent가 필요한 사용자를 위한 것입니다.
개인 비서, 연구 파트너, 학습 도우미처럼 예측 가능한 방식으로 소통해야 하는 일상 에이전트에 적합합니다.

Telegram은 그룹 개인정보 보호가 비활성화된 후 연결된 봇을 언급하는 직접 대화 및 그룹 메시지를 지원합니다.
Telegram을 연결해야 하는 경우 [채널 - Telegram 구성](../configuration/channel-telegram.md)부터 시작하세요.

## 전제 조건

- 실행 중인 LightVela Hermes Agent.
  아직 생성하지 않았다면 [빠른 시작](../02-quickstart.md)부터 시작하세요.

- 작동하는 모델 구성 또는 사용 가능한 평가판 크레딧.
  Hermes가 아직 응답할 수 없는 경우 [모델 구성](../configuration/model.md)을 완료하세요.

- Telegram 계정과 봇은 [채널 구성 - Telegram](../configuration/channel-telegram.md)에 따라 연결됩니다.

- 에이전트가 수행하길 원하는 역할에 대한 첫 번째 아이디어.
  간결한 연구 보조자, 환자 연구 파트너 또는 실행 중심 알림 보조자가 될 수 있습니다.

## 단계와 핵심 개념

### 1. Hermes Agent를 Telegram에 연결합니다

LightVela 콘솔에서 대상 Hermes Agent를 열고 "채널"로 이동하여 Telegram을 선택합니다.
[채널 구성 - Telegram](../configuration/channel-telegram.md)에 따라 봇을 생성하고 HTTP API 토큰을 붙여넣은 후 테스트 메시지를 보냅니다.

Telegram이 콘솔에 연결된 것으로 나타나고 봇이 Hermes Agent 응답을 받는지 확인합니다.
이후의 문제를 성격 구성 문제와 더 쉽게 구별할 수 있도록 채널을 먼저 확인하십시오.

### 2. 에이전트가 일할 방식을 설명합니다

뚜렷한 페르소나는 이름이나 유행어만으로 만들어지지 않습니다.
설정하기 전에 지속적으로 유지할 역할, 말투, 작업 방식, 행동 경계를 적어 보세요.

다음과 같은 짧은 개요를 시작점으로 사용하세요.

```text
You are my research assistant. Help me break down questions, compare reliable sources, and write clear conclusions.
Give the conclusion first, then the key evidence. State uncertainty instead of presenting guesses as facts.
Use a professional, direct, friendly tone. Do not be performatively cute, and do not invent certainty.
Ask for confirmation before sending messages, changing files, or taking other external actions.
```

이 개요는 적합한 Soul을 선택하는 데 도움이 되며 Telegram이 연결된 후 에이전트의 동작을 개선하기 위한 언어를 제공합니다.

### 3. Personality에서 Soul을 선택해 주입합니다

대상 에이전트 설정에서 "Personality" 섹션을 엽니다.
"Draw random soul" 또는 "Soul personality test"를 사용한 뒤 각 카드의 설명을 검토하세요.

역할에 가장 잘 맞는 Soul을 선택하고 "Inject soul"을 클릭하세요.
LightVela는 ​​선택된 페르소나를 현재 Hermes Agent의 `SOUL.md`에 쓰고 기존 구성을 교체하기 전에 백업을 유지합니다.

에이전트에 이미 다른 Soul이 있는 경우 새 에이전트를 삽입하면 현재 활성 상태인 페르소나가 대체됩니다.
교체를 확인하기 전에 카드의 역할, 음성 및 경계를 검토하십시오.

### 4. Telegram에서 새 대화를 시작합니다

Soul을 주입한 뒤 Telegram 채팅으로 돌아가 다음 명령을 보냅니다.

```text
/new
```

Hermes Agent는 새 대화가 시작되면 새 `SOUL.md`를 읽습니다.
`/new`를 보내지 않고 이전 대화를 계속하는 경우 해당 대화는 여전히 이전 페르소나 스냅샷을 사용할 수 있습니다.

새로운 대화가 시작되면 빠른 자가 점검을 요청하세요.

```text
In three sentences, explain your current role, what you can help me with, and what you will not do for me.
```

### 5. 실제 작업으로 말투를 조정합니다

"당신은 누구인가요?"라는 질문만으로 페르소나를 판단하지 마세요.
평소 실제로 요청할 만한 작업 몇 가지로 테스트합니다.

```text
Turn this research material into conclusions, evidence, and questions that still need confirmation.
```

```text
I have three deadlines today. Rank them by risk, then give me a concise plan.
```

```text
This request would send content to an external service. What would you do first?
```

에이전트가 예상된 음성을 유지하고, 불확실성을 표시하고, 외부 작업 주변의 경계를 존중하는지 확인하세요.
언어, 시간대 또는 브리핑 형식과 같은 사용자별 기본 설정이 있는 경우 모든 기본 설정을 페르소나 규칙으로 전환하는 대신 Hermes에 이를 기억하도록 요청하세요.

## 성격, 사용자 선호도, 메모리가 어떻게 조화를 이루는가

`SOUL.md`에는 에이전트의 안정적인 역할, 말투, 우선순위, 행동 경계를 넣는 것이 적합합니다.
사용자 프로필에는 사용자의 신원, 언어, 시간대, 소통 선호도를 기록합니다.
장기 메모리는 함께 작업하며 확인된 사실, 프로젝트 상태, 재사용할 맥락을 보관합니다.

더 자세한 설명은 [Hermes Agent의 성격은 어디에서 오는가](../hermes-agent/10-persona-user-memory.md)와 [메모리 관리](../configuration/memory.md)를 읽어보세요.

## FAQ

### Telegram 봇은 자신만의 개성을 갖고 있나요?

성격은 BotFather 토큰이 아닌 Telegram에 연결된 Hermes Agent에 속합니다.
동일한 Hermes Agent가 지원되는 다른 채널에 연결된 경우 해당 채널은 동일한 에이전트 수준 페르소나 및 내구성 컨텍스트를 사용합니다.

### `/new`는 메모리를 삭제하나요?

아니요.
`/new`는 세션 시작 시 새 `SOUL.md`가 로드되도록 새로운 대화를 시작합니다.
에이전트의 장기 메모리 또는 사용자 프로필은 삭제되지 않습니다.

### Telegram Bot을 그룹에 추가할 수 있나요?

예.
BotFather에서 `/mybots`를 보내고 Bot을 선택한 다음 "Bot 설정" → "그룹 개인정보 보호"를 열고 개인정보 보호 모드를 끄세요.
그룹에 Bot을 추가하고 `@bot_username`와 대화를 시작하세요.
전체 설정은 [채널 구성 - Telegram](../configuration/channel-telegram.md)를 참조하세요.

### 모델을 바꾸면 에이전트의 개성이 사라지나요?

일반적으로 그렇지 않습니다.
모델, 에이전트 페르소나 및 장기 메모리는 별도의 구성 레이어이지만 모델을 변경하면 추론, 도구 사용 및 응답 스타일의 작은 세부 사항이 변경될 수 있습니다.

## 다음 단계

- [WhatsApp에서 개성이 뚜렷한 Hermes Agent를 구성하는 방법](./whatsapp-persona-agent.md) - 동일한 에이전트 성격을 1:1 WhatsApp 대화에 적용합니다.

- [SOUL.md를 사용하여 IM 에이전트의 역할, 성격 및 목소리를 정의하는 방법](./im-agent-persona-soul-md.md) - Soul, 성격 및 장기 메모리 간의 경계를 이해합니다.

- [채널 구성 - Telegram](../configuration/channel-telegram.md) - 전체 Telegram 봇 연결 흐름을 따릅니다.

- [스킬 구성](../configuration/skill.md) - 실용적인 업무 능력으로 안정적인 성격을 확장합니다.
