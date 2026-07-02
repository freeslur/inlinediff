<div align="center">

# Inline Diff

**무엇을 남길지, 하나씩 — Git에 닿기 전에 결정하세요.**

[![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#라이선스)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.80+-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Status](https://img.shields.io/badge/status-early%20release-orange.svg)](#상태)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#기여)

[English](README.md)

</div>

---

AI 에이전트에게 프로젝트를 맡기고 잠깐 자리를 비웁니다. 돌아와 보니 파일 스무 개가
바뀌어 있습니다. 어떤 건 정확히 원하던 대로고, 어떤 건 미묘하게, 조용히 틀렸습니다.
이제 이 둘을 골라내야 하는데 — `wip`, `fix`, `이번엔-진짜-수정` 같은 커밋으로 Git
히스토리를 무덤으로 만들지 않으면서요.

Inline Diff는 바로 그 "골라내는 단계"를 위해 만들었습니다.

Git과는 완전히 분리된, 프로젝트의 *accepted baseline*(승인된 기준 상태)을 따로
보관하고, 당신이 마지막으로 "좋아"라고 한 시점 이후로 바뀐 모든 걸 보여 줍니다.
좋은 건 받아들이고, 아닌 건 되돌리고, 아직 확신이 안 서는 건 잠시 미뤄 둡니다 — 그것도
파일 전체가 아니라 변경 하나하나 단위로, 늘 쓰던 에디터 안에서요. Git은 당신이 마음을
정한 다음에야 등장합니다.

> Git은 당신이 내린 결정을 기록합니다. Inline Diff는 그 결정을 *내리는* 곳입니다.

그리고 어떤 도구가 바꿨는지는 따지지 않습니다. Claude Code, Codex, Prettier 한 번,
일회용 셸 스크립트 — 무엇이 파일을 건드렸든 Inline Diff는 똑같이 보여 줍니다. 이게
에디터 내장 "수락/거절"이 못 메우는 빈틈입니다. 그것들은 *자기 자신이* 만든 변경만,
그것도 실행 중일 때만 알거든요.

## 데모

<!-- 워크스루 GIF를 녹화하면 여기에 넣는다. -->

> 📹 _워크스루 GIF는 준비 중입니다._ 우선은 Inline Diff 뷰에서 **Initialize Project**를
> 실행하고, 에이전트로 파일을 좀 바꾼 뒤, 바뀐 파일을 열어 동작을 확인해 보세요.

## 어떻게 동작하나

Inline Diff는 마지막으로 승인한 상태를 `.inlinediff/` 안의 자체 저장소에 보관합니다.
당신의 실제 Git 저장소는 건드리지 않습니다 — index, HEAD, stash, 설정 모두 그대로 둡니다.

그다음은 단순한 반복입니다.

- **스캔** — 작업 중인 파일을 accepted baseline과 비교해 바뀐 것을 목록으로 보여 줍니다.
- **열기** — 파일을 클릭하면 디스크의 실제 파일을 대상으로 VS Code inline diff가 열립니다.
- **결정** — 파일 전체를 수락/거절하거나, 각 hunk의 CodeLens로 변경 하나씩 처리합니다.
- **보류** — 애매한 변경은 **Keep for Review**로 표시해 두고 나머지는 한 번에 수락한 뒤,
  사람의 판단이 필요한 부분만 다시 봅니다.

수락하면 baseline이 그만큼 앞으로 갱신되고, 거절하면 baseline 내용이 그 부분에 다시
쓰입니다. 어느 쪽이든 Git staging은 검토가 *끝난 뒤* 커밋을 다듬는 용도로 비워 둡니다 —
검토 *도중의* 메모장으로 쓰지 않습니다.

## 기능

- 바뀐 모든 것을 트리로 표시: added, modified, deleted, binary 파일
- 복사본이 아니라 실제 프로젝트 파일을 대상으로 여는 inline diff
- 파일 단위 **그리고** 변경 단위의 수락/거절
- 애매한 변경을 미뤄 두고 나머지를 한 번에 수락하는 **Keep for Review**
- Git 저장소·index·설정과 완전히 격리된 baseline
- 인코딩을 보존하는 텍스트 처리, 텍스트 diff 경로에서 제외되는 binary 파일
- 큰 변경 세트에서도 가볍게 동작하는 lazy hunk 계산
- 파일이 편집 중이거나 저장되지 않았을 때는 스스로 숨는 변경 액션

## 사용 환경

- **VS Code 1.80** 이상.
- **Git 2.32** 이상이 `PATH`에 있어야 합니다. Inline Diff는 baseline을 유지하려고 Git을
  직접 호출하며, 전역 Git 설정과 분리된 상태를 유지하기 위해 `GIT_CONFIG_GLOBAL`(Git 2.32에
  추가)에 의존합니다.

## 시작하기

VS Code 마켓플레이스에서 **Inline Diff**를 설치하세요. Extensions 뷰(`Ctrl+Shift+X`)를
열고 _Inline Diff_를 검색해 **설치**를 누르면 됩니다.

소스에서 빌드하고 싶다면 로컬에서 VSIX를 빌드해 설치할 수 있습니다.

```powershell
pwsh ./scripts/build.ps1 -Task Install
pwsh ./scripts/build.ps1 -Task Package   # → dist/inlinediff-0.1.2.vsix
code --install-extension dist/inlinediff-0.1.2.vsix
```

이후 워크스페이스를 열고 Activity Bar의 **Inline Diff** 뷰를 연 뒤, 뷰 제목 표시줄의
**+** 버튼(**Initialize Project**)을 누르세요. Command Palette에서
`Inline Diff: Initialize Project`로 실행해도 됩니다. 그다음 파일을 수정하고 같은 뷰에서
변경을 검토하세요.

알아 두면 좋은 점 몇 가지:

- 프로젝트 루트에 `.diffignore`를 두면 생성 파일이나 로컬 전용 경로를 검토에서 숨길 수
  있습니다. `.gitignore`와는 별개로, Inline Diff가 추적하는 대상만 제어하며 Git에는 전혀
  영향을 주지 않습니다. 나중에 ignore 규칙을 바꿔도 이미 승인된 파일은 안전하게 유지됩니다.
- 2 MiB가 넘는 텍스트 파일과 binary 파일은 의도적으로 diff 추적에서 제외합니다.
- Inline Diff는 인라인 diff를 표시하려면 `diffEditor.codeLens: true`와
  `diffEditor.renderSideBySide: false`가 필요합니다. Initialize 시점에 워크스페이스
  settings에 이 값을 기록하며, 이후 diff를 열 때 설정이 맞지 않으면 확인 후 다시 기록합니다.
  기존 값은 매번 미리 백업합니다. 이건 VS Code 전역 설정이라 Inline Diff뿐 아니라 **모든**
  diff 편집기 — Git diff, 다른 익스텐션의 diff까지 — 에 영향을 줍니다. Command Palette에서
  `Inline Diff: Restore Diff Settings`를 실행하면 이전 설정으로 되돌릴 수 있습니다.

## 다중 프로젝트

프로젝트란 **루트에 `.inlinediff`가 있는, 열려 있는 워크스페이스 폴더**입니다 — 그게 전부입니다.
폴더 여러 개를 한 번에 열면(멀티 루트 워크스페이스) `.inlinediff`를 가진 폴더 각각이 독립된
프로젝트로 나타나며, 서로 조율하지 않습니다.

- **각 프로젝트는 자기 기준선(baseline)부터 검토합니다.** 기준선은 초기화한 시점에 정해지고,
  자기 루트의 `.diffignore`만 따르며, Accept/Reject도 그 프로젝트에만 영향을 줍니다. 한
  프로젝트에서 내린 결정은 다른 프로젝트를 건드리지 않습니다.
- **Inline Diff는 프로젝트 안에서 다른 스토어를 찾지 않습니다.** 트리 안쪽에 박힌 `.inlinediff`는
  (예: 자체 `.inlinediff`를 가진 폴더를 복사해 넣은 경우) 그냥 무시되는 데이터입니다 — 바깥
  프로젝트는 그 안의 소스 파일을 다른 파일과 똑같이 추적하지만, `.inlinediff/` 내부는 추적하지
  않습니다. 그 폴더는 *직접* 워크스페이스 루트로 열었을 때만 비로소 자기 프로젝트가 됩니다.

## Git으로 하면 안 되나요?

됩니다. 그런데 Git은 — 일부러 — 이 문제의 반대쪽 절반을 잘합니다.

Git의 가치는 *이미 내린 결정*의 깨끗하고 의도된 이력에 있습니다. 작동하는 코드에
이르기까지의 실패한 실험, 디버그 한 줄, "이 방식으로도 해 볼까" 같은 걸 매번 커밋하는
사람은 거의 없고, 설령 그렇게 하더라도 남에게 보이기 전에 squash로 지웁니다. 어느 버전이
맞는지 아직 고르고 있는 그 지저분한 중간 과정은 그냥 증발합니다.

Inline Diff는 그 중간에 살도록 만들었습니다. 더 나은 `git diff`가 되려는 것도 아니고,
Git을 대체하려는 것도 아닙니다. Git은 잘하는 일을 계속하면 됩니다 — 당신이 확정한 코드를
기록하는 일. 그 *이전*의 모든 것, 즉 결정하고, 되돌리고, "이건 남기고 저건 버리는" 과정은
Inline Diff가 맡아서, 어느 것도 당신의 히스토리에 새어 들지 않게 합니다.

## 로드맵

약속이 아니라 방향입니다. 장기 목표는 결정 단계 — AI가 만든 변경을 수락하고 거절하는
과정 — 를 오래 남는 것으로 바꾸는 것입니다. 작게 검토 가능한 단위, 그리고 다시 들여다볼
수 있는 결정으로요.

- **레이어 검토** — 한 파일의 변경 흐름을 읽기 전용 중간 스냅샷으로 나눠, 잘 돌던 코드가
  *언제부터* 망가지기 시작했는지 봅니다.
- **인라인 스태싱** — 특정 변경을 파일에서 잠시 빼 뒀다가 나중에 다시 적용합니다.
- **이름 있는 체크포인트와 결정 이력** — 기준점을 만들고, 그에 대해 무엇이 수락·거절됐는지
  되짚습니다.
- **거절 이유 남기기** — 변경을 *왜* 거절했는지 기록해, 그냥 버려지는 대신 다음 변경의
  길잡이가 되게 합니다.
- **에이전트용 CLI·TUI·MCP** — 터미널에서 검토를 실행하고, 검토 흔적을 외부 코딩
  에이전트에 노출해 에디터뿐 아니라 에이전트가 직접 읽고 행동하게 합니다.
- **팀 검토와 PR 근거** — 같은 baseline과 체크포인트를 사람·에이전트가 공유하고, 검토
  흔적을 PR로 묶습니다.

## 안전 경고

거절은 baseline 내용을 선택한 파일 부분에 다시 씁니다. 다른 에디터, 포매터, 빌드 도구,
스크립트가 같은 파일을 같은 순간에 바꾸고 있다면, 거절이 적용되는 동안 그 외부 변경이
덮어써질 수 있습니다.

**다른 무언가가 대상 파일에 활발히 쓰고 있지 않을 때만 거절하세요.**

## 상태

Inline Diff는 `0.1.2` — 초기 릴리스입니다. 핵심 검토 흐름(스캔, 열기, 수락, 거절,
보류)은 안정적이며 테스트로 검증되어 있습니다. [로드맵](#로드맵) 항목은 아직 남아
있습니다. 버그 제보와 피드백을 환영합니다.

## 기여

이슈와 PR을 환영합니다. 변경을 보내기 전 표준 점검:

```powershell
pwsh ./scripts/build.ps1 -Task Check        # 타입 검사, 린트, 테스트, 빌드
pwsh ./scripts/build.ps1 -Task ReleaseCheck # 로컬 release 패키징 게이트
```

이 프로젝트는 Bun 위의 TypeScript이고, Biome로 포맷·린트하며, 테스트 우선으로
개발합니다.

## 라이선스

MIT License와 Apache License, Version 2.0의 dual license입니다. 프로젝트에 맞는 쪽을
쓰면 됩니다. [`LICENSE`](LICENSE), [`LICENSE-MIT`](LICENSE-MIT),
[`LICENSE-APACHE`](LICENSE-APACHE)를 참고하세요.
