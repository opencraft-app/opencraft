# LightVela에서 스크립트 작업 실행하기

스크립트 작업은 AI 모델을 호출하지 않고 Bash 또는 Python 스크립트를 일정에 맞춰 실행할 수 있으므로 클라우드 호스팅 Agent의 실용적인 활용 방식입니다.
명확하고 예측 가능한 규칙을 가진 반복 시스템 점검이 있을 때 사용할 수 있습니다.
사용자는 디스크 사용량 알림과 누락되거나 오래된 파일을 감지하는 점검에 이를 활용하고 있습니다.

## 스크립트가 해결할 수 있는 일반적인 문제

많은 작은 시스템 문제는 간단한 점검으로 감지할 수 있습니다.
그러나 이런 점검은 무언가 작동을 멈출 때까지 잊히기 쉽습니다.

- 디스크 사용량이 알아차리지 못한 채 증가합니다.
- 일일 내보내기가 새 파일 생성을 멈춥니다.
- 백업 파일이 오래됩니다.
- 다른 작업에 영향을 준 뒤에야 문제가 발견됩니다.

LightVela에서는 스크립트 작업에 Bash 또는 Python 코드, 일정, 유효 시간 창, 전달 채널을 구성할 수 있습니다.
작업은 모델을 호출하지 않으므로 모델 토큰을 소비하지 않습니다.
[예약 작업 문서](https://lightvela.ai/docs/configuration/automation?from=social_x)에서 사용할 수 있는 일정 및 알림 옵션을 설명합니다.

## 사례 1: 디스크 사용량 알림

매일 아침 Bash 스크립트 작업이 사용 가능한 디스크 공간을 확인하고 사용량이 80%에 도달할 때만 보고합니다.

스크립트:

```bash
used=$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')

if [ "$used" -ge 80 ]; then
  echo "Disk usage alert: ${used}% used."
fi
```

![디스크 사용량 알림용 반복 스크립트 작업 만들기](../images/scheduled-task-script-1.webp)

디스크 사용량이 임계값보다 낮으면 스크립트는 아무것도 출력하지 않으며 알림도 전송되지 않습니다.
이렇게 하면 주의가 필요한 경우를 제외하고 일상 점검을 조용하게 유지할 수 있습니다.

## 사례 2: 누락되거나 오래된 내보내기

매주 평일 저녁에 Python 스크립트 작업이 최신 내보내기 파일이 존재하고 지난 24시간 내에 업데이트되었는지 확인합니다.

스크립트:

```python
from pathlib import Path
from time import time

file = Path("/path/to/latest-export.csv")

if not file.exists() or time() - file.stat().st_mtime > 86400:
    print("Export alert: the latest file is missing or over 24 hours old.")
```

![누락되거나 오래된 내보내기를 확인하는 반복 스크립트 작업 편집](../images/scheduled-task-script-2.webp)

예시 경로를 실제 내보내기 위치로 바꾸세요.
파일이 존재하고 최신 상태라면 스크립트는 불필요한 메시지를 보내지 않고 조용히 완료됩니다.

## IM에서 직접 업데이트 받기

LightVela에서는 [채널 구성](https://lightvela.ai/docs/configuration?from=social_x)을 통해 Agent를 WhatsApp, Telegram, WeChat, Discord 등에 연결할 수 있습니다.
하나 또는 여러 채널을 동시에 연결할 수 있습니다.
예약 작업에서 구성된 각 채널을 전환하여 스크립트 알림을 어디로 보낼지 결정할 수 있습니다.

![스크립트 작업이 디스크 사용량 점검 결과를 Telegram으로 직접 전송](../images/scheduled-task-script-3.webp)

스크립트가 비어 있지 않은 표준 출력을 생성하면 Hermes가 그 출력을 IM으로 직접 보냅니다.
스크립트가 아무것도 출력하지 않으면 작업은 알림을 보내지 않고 완료됩니다.

## 여러 작업 관리하기

필요한 만큼 예약 작업을 설정할 수 있습니다.
생성한 뒤에는 스크립트와 일정을 편집하고, 일시 중지하며, 이전 실행을 탐색할 수 있습니다.
특히 중요한 파일에 접근하는 경우에는 예약하기 전에 모든 스크립트를 테스트하세요.

![스크립트 작업이 있는 현재 작업 목록](../images/scheduled-task-script-4.webp)

LightVela를 사용하면 개인 Hermes Agent가 다른 일에 집중하는 동안에도 예측 가능한 점검을 계속 처리할 수 있습니다.
