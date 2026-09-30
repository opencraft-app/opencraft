# Achievements

## 요약

**Achievements 페이지는 현재 Bot의 Hermes Agent 사용 진행 상황을 보여줍니다. 잠금 해제됨, 발견됨, 비밀 Achievements, 도달한 최고 티어를 요약하고, 각 카드의 상태, 카테고리, 진행률, 집계 규칙, 가능한 경우 출처 세션을 표시합니다.** 이 페이지에서 현재 Bot의 Hermes 기록을 다시 스캔하여 도구 사용, 디버깅, 모델 설정, 메모리, Skills, 문서 작업, 자동화가 인식되었는지 확인할 수 있습니다.

![통계 카드, 상태 필터, 카테고리 필터, Achievement 카드 목록을 보여주는 Achievements 페이지](../../images/achievements-overview.webp)

---

Achievements는 직접 설정하는 기능이 아닙니다. LightVela는 현재 Bot의 Hermes Agent 과거 행동을 바탕으로 Achievements를 생성합니다. 어떤 Agent 기능을 이미 탐색했는지, Achievements 모듈이 최신 기록을 읽었는지 확인할 때 사용합니다.

LightVela를 처음 사용하는 경우 [Chat](./agent-chat.md), [Skills 설정](./skill.md), [메모리 관리](./memory.md), [Scheduled Tasks](./automation.md) 같은 기본 흐름을 먼저 시도한 뒤 Achievements로 돌아와 진행 상황을 확인하세요.

## 시작하기 전

1. LightVela에 로그인하고 하나 이상의 Hermes Agent가 활성 상태인지 확인합니다.
2. 확인하려는 Bot의 콘솔을 엽니다.
3. 의미 있는 진행 상황을 보려면 해당 Bot에 실제 대화, 도구 호출, 설정 변경, 예약 작업 활동이 있어야 합니다.

Achievements는 Bot별로 읽습니다. 다른 Bot으로 전환하면 스냅샷과 진행 상황이 달라질 수 있습니다.

## Achievements 열기

1. LightVela에 로그인합니다.
2. My Hermes 콘솔을 엽니다.
3. 설정 내비게이션에서 Achievements를 선택합니다.
4. 현재 Bot의 Hermes 기록을 읽을 때까지 기다립니다.

로드가 끝나면 통계 카드, 상태 및 카테고리 필터, Achievements 카드 목록이 표시됩니다.

## 통계 카드 읽기

페이지 상단에는 네 가지 통계가 표시됩니다.

| 통계 | 의미 |
| --- | --- |
| 잠금 해제됨 | 조건을 완료한 Achievements 수와 현재 표시 가능한 전체 수입니다. |
| 발견됨 | 진행 상황은 있지만 아직 잠금 해제되지 않은 Achievements입니다. |
| 비밀 Achievements | 관련 행동이 나타날 때까지 정확한 조건이 숨겨진 Achievements입니다. |
| 최고 티어 | 현재 Bot이 도달한 최고 티어입니다. 순서는 Copper, Silver, Gold, Diamond, Olympian입니다. |

Hermes 기록을 읽는 중이라는 메시지가 보이면 Achievements 모듈이 아직 세션을 스캔하는 중입니다. 통계를 판단하기 전에 스캔이 끝날 때까지 기다리세요.

## Achievements 필터링

통계 아래의 두 필터를 사용합니다.

1. **상태 필터**: 전체, 잠금 해제됨, 발견됨, 비밀을 선택합니다.
2. **카테고리 필터**: Agent Autonomy, Debugging Chaos, Vibe Coding, Hermes Native, Research/Web, Tool Mastery, Model Lore, Lifestyle 같은 카테고리로 필터링합니다.

일치하는 Achievements가 없으면 두 필터를 전체로 되돌립니다. 그래도 비어 있으면 현재 Bot의 기록을 다시 스캔하세요.

## Achievement 카드 읽기

각 카드에는 다음 정보가 포함될 수 있습니다.

| 필드 | 의미 |
| --- | --- |
| 이름과 설명 | 해당 Achievement가 나타내는 Hermes Agent 행동입니다. 비밀 Achievements는 발견되기 전까지 비밀로 표시됩니다. |
| 상태 | 잠금 해제됨, 발견됨, 또는 비밀입니다. |
| 티어 | 티어형 Achievements는 Copper, Silver, Gold, Diamond, Olympian을 표시할 수 있습니다. |
| 진행률 | 현재 진행 상황, 다음 기준값, 또는 백분율입니다. 비밀 Achievements는 조건이 숨겨집니다. |
| 집계 규칙 | 펼치면 도구 호출, 로그 확인, 모델 설정, 문서 작업 등 무엇을 세는지 확인할 수 있습니다. |
| 출처 세션 | 일부 Achievements는 진행 증거가 된 세션 제목을 표시합니다. |

집계 규칙은 Hermes Agent 기록에서 가져옵니다. 카드에 규칙이 반환되지 않았다고 표시되어도 해당 Achievement를 잠금 해제할 수 없다는 뜻은 아닙니다.

## 기록 다시 스캔하기

방금 대화, 도구 호출, 설정 변경을 완료했지만 페이지가 바뀌지 않았다면 기록을 다시 스캔합니다.

1. Achievements를 엽니다.
2. 오른쪽 위의 다시 스캔 버튼을 클릭합니다.
3. 버튼 회전이 멈추거나 기록 읽기 메시지가 사라질 때까지 기다립니다.
4. 통계 카드와 관련 Achievements 카드가 바뀌었는지 확인합니다.

다시 스캔은 현재 Bot의 Hermes 기록을 읽습니다. 기록이 긴 Bot은 시간이 더 걸릴 수 있습니다.

## 진행 상황이 인식되었는지 확인하기

실제 작업을 완료한 뒤 다음 순서로 확인합니다.

1. 현재 Bot에서 로그 확인, 도구 사용, 모델 설정 변경, 예약 작업 실행, 문서 유지보수처럼 집계될 수 있는 행동을 수행합니다.
2. Achievements로 돌아와 다시 스캔합니다.
3. 상태 필터에서 발견됨 또는 잠금 해제됨을 선택합니다.
4. 관련 카드의 집계 규칙을 열고 진행률, 백분율, 출처 세션 정보가 바뀌었는지 확인합니다.

변화가 없다면 먼저 해당 작업이 지금 보고 있는 Bot에서 일어났는지 확인하세요.

## FAQ

### 기능을 사용한 직후 Achievement가 바로 바뀌지 않는 이유는 무엇인가요?

페이지는 현재 Bot의 기록 스냅샷을 읽습니다. 최근 활동 후에는 다시 스캔해야 할 수 있습니다. 기록이 많으면 스캔에도 시간이 더 걸립니다.

### 비밀 Achievements가 있는 이유는 무엇인가요?

비밀 조건은 Hermes Agent가 관련 행동을 감지한 뒤 표시됩니다. 디버깅, 도구, 메모리, Skills, 플러그인, 모델 설정, 자동화 워크플로에서 Hermes Agent를 계속 사용하면 더 많은 조건이 드러납니다.

### Achievements 로드에 실패하는 이유는 무엇인가요?

Hermes Agent가 일시적으로 사용할 수 없거나, 데이터 파싱이 실패했거나, Achievements 명령이 실패했을 수 있습니다. 먼저 새로고침하거나 다시 시도하세요. 문제가 계속되면 [Diagnostics](./diagnostics.md)에서 서비스 상태와 로그를 확인합니다.

### Bot을 전환하면 Achievements가 달라지는 이유는 무엇인가요?

Achievements는 현재 Bot의 기록에서 읽습니다. Bot마다 대화, 도구 호출, 메모리, Skills, 모델 설정 기록이 다르기 때문에 진행 상황도 달라질 수 있습니다.

### Achievements가 플랜, 크레딧, 권한에 영향을 주나요?

아니요. Achievements는 사용 진행 상황만 표시합니다. 플랜, AI 크레딧, Bot 할당량, 권한은 변경하지 않습니다. 과금 정보는 [Plans](../plans.md)와 [Credits](../credits.md)를 확인하세요.
