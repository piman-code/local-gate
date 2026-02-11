# Local Gate (한국어 안내)

Local Gate는 Obsidian에서 로컬 AI 모델(Ollama / LM Studio)을 검색하고, 그 결과를 **Agent Client**에 연결해 바로 선택해서 사용할 수 있게 해주는 플러그인입니다.

## 중요한 전제

이 플러그인은 단독으로 채팅 UI를 제공하지 않습니다.  
실제 실행과 대화는 **Agent Client (`agent-client`)**가 담당하고, Local Gate는 모델 검색/적용/동기화를 담당합니다.

## 주요 기능

- 로컬 모델 자동 검색
  - Ollama: `ollama list` + `ollama show`
  - LM Studio: `GET /v1/models`
- 모델 기능(capabilities) 표시
  - 예: `completion`, `tools`, `vision`, `thinking`, `embedding`
- 호환성 게이트
  - 채팅 불가/툴 미지원 모델은 `blocked` 처리
  - `blocked` 모델은 Apply 비활성화
- Agent Client 연동
  - `Local Ollama`, `Local LM Studio` 에이전트 동기화
  - 모델 적용 시 Agent Client 설정 즉시 반영(재시작 의존성 최소화)
- 다중 노트 참조
  - `Folder @mentions`
  - `Multi @mentions (Folders/Files)`

## 설치 방법 (BRAT)

1. Obsidian에서 BRAT 플러그인을 설치/활성화합니다.
2. `BRAT -> Add a beta plugin`을 엽니다.
3. 저장소 URL을 입력합니다: `https://github.com/piman-code/local-gate`
4. Community Plugins에서 `Local Gate`를 활성화합니다.

## 실행 방법 (빠른 시작)

1. **Agent Client** 플러그인을 먼저 설치/활성화합니다.
2. `codex-acp` 실행 경로가 준비되어 있는지 확인합니다.
3. Ollama 또는 LM Studio 중 최소 1개를 실행합니다.
4. Local Gate 설정에서 다음 항목을 확인합니다.
   - `Codex ACP command`
   - `Ollama base URL` 또는 `LM Studio base URL`
   - `Publish profiles to Agent Client` = ON
5. `Scan local models`를 실행합니다.
6. `Discovered Local Models`에서 원하는 모델에 `Apply`를 누릅니다.
7. Agent Client 채팅창에서 에이전트를 `Local Ollama` 또는 `Local LM Studio`로 전환해 사용합니다.

## 자주 쓰는 명령어 (Command Palette)

- `Local Gate: Switch Local AI Profile`
- `Local Gate: Apply Last Profile`
- `Local Gate: Scan Local Models`
- `Local Gate: Sync Models to Agent Client`
- `Local Gate: Copy Folder @Mentions`
- `Local Gate: Copy Multi @Mentions (Folders/Files)`

## 문제 해결

- 모델이 스캔되는데 적용이 안 되는 경우
  - `blocked` 사유를 확인하세요. (`embedding-only`, `no tools capability` 등)
- 채팅창에 자동 반영이 안 되는 경우
  - 클립보드 복사는 완료되며, 안내 문구에 `paste manually`가 표시될 수 있습니다.
  - 이 경우 채팅 입력창에 직접 붙여넣으면 정상 동작합니다.
- 적용 모델이 즉시 안 바뀌는 것처럼 보일 때
  - `Sync to Agent Client`를 1회 실행하고 Agent Client 세션을 재시작해 확인하세요.

## 크레딧

- 이 플러그인의 실제 채팅 실행 기반은 **Agent Client**입니다.
- Agent Client 리포지토리: `https://github.com/RAIT-09/obsidian-agent-client`
