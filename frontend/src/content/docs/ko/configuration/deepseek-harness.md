# DeepSeek Harness

## 요약

**DeepSeek Harness는 LightVela에서 Hermes Agent와 함께 설치할 수 있는 플러그인 우선 AI 에이전트 프레임워크입니다. Labs 페이지에서 기존 Hermes 설정, 채널, 스킬, 메모리를 변경하지 않은 채 설치, 상태, 재시작, WebUI 액세스, 지원되는 모델 공급자 키, SkillHub가 포함된 프로필을 관리할 수 있습니다. Hermes Agent에서 사용하는 모델 공급자 설정은 [모델 구성](./model.md)을 참고하세요.**

![DeepSeek Harness 개요](../images/deepseek-harness-01.png)

Beta 안내: DeepSeek Harness는 Labs에서 조기 체험으로 제공되는 기능입니다. 업스트림 프레임워크와 플러그인 생태계가 발전함에 따라 호환성에 영향을 주는 업데이트가 이루어질 수 있습니다.

## DeepSeek Harness가 추가하는 기능

DeepSeek Harness(DSH)는 AI 모델이 실제 작업을 수행하는 데 필요한 환경과 도구를 제공하는 오픈 소스 에이전트 하네스입니다.
LightVela에서 DSH는 Hermes Agent와 별도의 관리형 환경으로 실행됩니다. 이 환경에서는 프로젝트 파일로 작업하고, 도구와 스킬을 사용하며, 세션을 관리하고, WebUI를 통해 에이전트와 상호작용할 수 있습니다.

![Labs의 DeepSeek Harness 페이지](../images/deepseek-harness-02.png)

LightVela는 DSH를 위한 관리형 진입점을 제공합니다.
패키지를 직접 설치하거나 공개 서버 주소를 설정하거나 터미널에서 DSH 서비스를 운영할 필요가 없습니다.
Labs의 "DeepSeek Harness" 페이지에서 관리형 런타임을 설치하고, 정상 상태인지 확인하고, 승인된 모델 공급자를 구성하고, 인스턴스 전용 WebUI를 열고, 필요할 때 DSH를 재시작할 수 있습니다.

## DeepSeek Harness 설치

1. [LightVela Agents](https://lightvela.ai/agents/)를 엽니다.
2. 왼쪽 탐색 메뉴의 Labs 아래에서 DeepSeek Harness를 선택합니다.
3. Beta 안내를 확인한 뒤 Install and try now를 선택합니다.
4. 설치가 진행되는 동안 페이지를 열어 둡니다.
   정상적인 설치에는 보통 1~3분이 걸립니다.

![DeepSeek Harness 설치](../images/deepseek-harness-03.png)

## 모델 공급자 구성

DeepSeek Harness를 설치하면 기본 DSH 카드 아래에 Model Configuration 카드가 표시됩니다.
현재 국제 사이트에서 승인된 공급자 목록은 다음과 같습니다.

- DeepSeek
- MiniMax
- MiniMax China
- Moonshot AI
- Moonshot AI China
- OpenRouter
- Anthropic
- Groq
- OpenAI

공급자를 추가하려면 다음 단계를 따르세요.

1. 공급자 목록에서 공급자를 선택합니다.
2. API Key 필드에 해당 API 키를 붙여넣습니다.
3. Save를 선택합니다.
4. 구성된 공급자 목록에 해당 공급자가 표시되는지 확인합니다.

![DeepSeek Harness 모델 공급자 양식](../images/deepseek-harness-04.png)

공급자를 제거하려면 삭제 작업을 선택하고 제거를 확인합니다.
제거한 뒤에도 나중에 새 API 키로 동일한 공급자를 다시 추가할 수 있습니다.

![구성된 DeepSeek Harness 공급자](../images/deepseek-harness-05.png)

## DeepSeek Harness WebUI 열기

서비스 상태가 running이면 DeepSeek Harness 카드에서 Access WebUI를 선택합니다.

![Access WebUI 버튼](../images/deepseek-harness-06.png)

LightVela는 DeepSeek Harness WebUI에 전용 액세스 도메인과 기본 신원 인증을 제공하므로 본인만 WebUI에 접근할 수 있습니다.
인증을 마치면 현재 에이전트 인스턴스의 WebUI를 열고, 이미 구성한 공급자를 사용해 간단한 테스트를 시작할 수 있습니다.
기존 Hermes Agent를 별도로 테스트하려면 [채팅](./agent-chat.md)을 이용하세요.

![DeepSeek Harness WebUI](../images/deepseek-harness-07.png)

## 플러그인 이해하기

DeepSeek Harness는 플러그인 우선 아키텍처를 사용합니다.
플러그인은 스킬 카탈로그, 메시징 커넥터, 기타 런타임 구성 요소와 같은 기능 또는 연동 요소를 DSH 프로필에 제공합니다.
DSH 페이지 왼쪽 하단의 Plugin Plaza를 클릭하면 플러그인 광장을 방문할 수 있습니다.

### 플러그인 설치 및 사용

Plugin Plaza에서는 브라우저 도구, 메모리, 자동화, UI 개선, 외부 연동 등 DeepSeek Harness 환경에 추가할 기능을 살펴볼 수 있습니다.

![Plugin Plaza 검색](../images/deepseek-harness-08.png)

플러그인을 열어 추가되는 기능을 확인한 뒤 원하는 플러그인을 설치하세요.
설치한 플러그인은 명시적으로 언급하지 않아도 워크스페이스에서 바로 사용할 수 있습니다.
LightVela에서 관리하는 Hermes 스킬은 [스킬 구성](./skill.md)을 참고하세요.

### 설치된 플러그인 확인

설치된 플러그인 목록은 DSH WebUI > Plugin Plaza > Installed에서 확인할 수 있습니다.

![설치된 DeepSeek Harness 플러그인](../images/deepseek-harness-09.png)

## 워크스페이스 사용

워크스페이스는 세션 중 DeepSeek Harness가 작업하는 프로젝트 디렉터리입니다.
WebUI에서 Add Workspace 아이콘을 클릭해 워크스페이스 디렉터리를 엽니다.

![Add Workspace 아이콘](../images/deepseek-harness-10.png)

그런 다음 클라우드 호스팅 DSH 환경에서 새 폴더를 만들거나 기존 폴더를 선택해 프로젝트의 워크스페이스로 지정할 수 있습니다.
에이전트는 해당 워크스페이스의 파일을 이용해 프로젝트를 파악하고, 파일을 편집하고, 명령을 실행하고, 클라우드 워크스페이스 안에서 작업을 수행할 수 있습니다.

![Select Workspace Directory 대화 상자](../images/deepseek-harness-11.png)

워크스페이스는 프로젝트와 해당 세션을 체계적으로 관리하는 데도 도움이 됩니다.
워크스페이스에서 만든 세션은 해당 디렉터리와 연결되므로, 같은 프로젝트로 돌아와 관련 세션 기록을 이어서 사용할 수 있습니다.
추가 권한이 필요한 작업에는 활성 DSH 권한 정책이 계속 적용되며 WebUI에서 승인을 요청할 수 있습니다.
DSH 외부에서 LightVela 파일을 관리하는 방법은 [클라우드 스토리지](./files.md)를 참고하세요.

## DeepSeek Harness 재시작

DSH가 설치되어 있지만 설정 변경 후 다시 로드해야 하거나 비정상 상태에서 복구해야 할 때 Restart를 사용합니다.
재시작 작업은 DeepSeek Harness 서비스에만 적용됩니다.
Hermes Agent는 독립적으로 계속 실행됩니다.

![DeepSeek Harness 재시작 버튼](../images/deepseek-harness-12.png)

## 일반적인 문제

| 증상 | 가능한 원인 | 해결 방법 |
| --- | --- | --- |
| 설치가 완료되지 않음 | 관리형 설치 작업이 정상적으로 끝나지 않음 | 페이지의 오류를 확인하고 잠시 기다린 뒤 DeepSeek Harness 페이지에서 다시 시도합니다. |
| WebUI가 열리지 않음 | 서비스가 준비되지 않았거나 현재 세션에 인스턴스 접근 권한이 없음 | DSH가 running으로 표시되는지 확인한 뒤, 로그인한 상태에서 Labs 페이지를 통해 WebUI를 다시 엽니다. |
| 모델이 요청에 응답하지 못함 | 구성된 공급자가 없거나, 키가 유효하지 않거나, 공급자 계정을 사용할 수 없음 | 구성된 공급자 목록을 확인하고 필요하면 API 키를 업데이트한 뒤 간단한 요청을 다시 실행합니다. |
| 저장된 API 키가 보이지 않음 | 정상적인 동작임 | API 키는 쓰기 전용입니다. 저장된 키를 유지하려면 필드를 비워 두고, 교체하려면 새 키를 입력합니다. |
| 채널이 연결되지 않음 | 플러그인은 있지만 계정 구성이 완료되지 않음 | DSH WebUI에서 채널을 구성하고 인증합니다. |
| 변경 후 DSH가 비정상 상태로 보임 | 서비스를 다시 로드해야 할 수 있음 | Restart를 사용하고 running 상태가 될 때까지 기다린 뒤 WebUI와 공급자를 다시 확인합니다. |

## 현재 지원 범위

LightVela의 DeepSeek Harness는 관리형 Labs 기능으로 설계되었습니다.
설치, 상태, 재시작, 승인된 공급자 자격 증명, 제어된 WebUI 진입점을 제공합니다.

현재 Labs 페이지는 임의 패키지 설치, 사용자 지정 플러그인 업로드, 네트워크 원시 포트 접근, 사용자 지정 공급자 엔드포인트, 사용자 지정 공급자 프로토콜, 고급 모델 매개변수 편집을 지원하지 않습니다.
이러한 제한은 기능이 아직 Beta인 동안 관리형 인스턴스의 동작을 예측 가능하게 유지하기 위한 것입니다.

기존 Hermes Agent 설정을 변경하지 않고 플러그인 기반 에이전트 환경, SkillHub 연동, 지원되는 채널 구성 요소를 살펴보고 싶을 때 DeepSeek Harness를 사용하세요.

## FAQ

### DeepSeek Harness가 Hermes Agent를 대체하나요?

아니요.
Hermes와 별도의 서비스로 함께 실행됩니다.
기존 Hermes 메모리, 스킬, 채널, 설정은 변경되지 않습니다.

### 저장한 API 키가 보이지 않는 이유는 무엇인가요?

API 키는 쓰기 전용입니다.
기존 키를 유지하려면 필드를 비워 두고, 교체하려면 새 키를 입력하세요.

### 아무 공급자나 모델 또는 사용자 지정 Base URL을 추가할 수 있나요?

현재 LightVela Labs 페이지는 선택기에 표시되는 공급자만 지원합니다.
사용자 지정 모델이나 Base URL 등 추가 모델 구성은 DeepSeek Harness WebUI에서 직접 관리할 수 있습니다.

### DeepSeek Harness 스킬과 Hermes 스킬은 같은가요?

아니요.
DeepSeek Harness와 Hermes Agent는 서로 별개의 환경입니다.
DeepSeek Harness를 설치해도 Hermes 스킬이 DSH로 자동 복사되지 않으며, DSH의 플러그인 또는 스킬 설정도 Hermes Agent 설정을 변경하지 않습니다.

### DeepSeek Harness에 Beta 표시가 있는 이유는 무엇인가요?

Labs에서 조기 체험으로 제공되는 기능이기 때문입니다.
DSH 또는 플러그인 업데이트로 호환성 변경이 생길 수 있으므로 업데이트 후에는 워크플로를 다시 확인하세요.
