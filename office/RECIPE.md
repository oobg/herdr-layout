# Office

코딩 에이전트들이 일하는 사무실을 위에, 앱 런처와 LLM 사용량 패널을 아래에 둔 Herdr 레이아웃이다. 이 레이아웃을 다시 만들거나 고치는 사람을 위한 구조 설명이다. Herdr 모드·레이아웃 규칙은 `~/.config/herdr-app/AGENTS.md`가 정본이다.

<!-- ![Office](preview.png) -->

## 레이아웃 (`layouts/office.json`)

테마는 정하지 않는다(사용자 설정을 따른다). 터미널 글꼴 `D2Coding`, 패널 글꼴 `Pretendard GOV`(`ui_font`), 터미널 안쪽 여백 `[12, 10]`.

```
root  column · padding 8 · gap 8 · background canvas
├─ office-top     row · weight 3 · gap 8
│  ├─ office-floor     block · weight 1 · min 240 · radius 10 · border 1 border   → mod office {role: floor}
│  └─ office-term      column · weight 2   (layout.show/hide로 열고 닫음)
│     ├─ office-termbar   block · 32px   → mod office {role: termbar}
│     └─ office-tab       block · {tab: active} · 패인 카드 radius 10, focus 테두리 accent
└─ office-bottom  row · weight 2 · gap 8
   ├─ office-apps     block · weight 1 · min 420 · radius 10 · border · chrome   → mod office-apps
   └─ office-side     column · 300px · min 240 · gap 6
      ├─ office-usage      block · weight 6 · min 160 · radius 10 · border · chrome   → mod office-usage
      └─ office-resources  block · weight 4 · min 28 (칠하지 않음: 카드는 모드가 전체 모드일 때만 그림) → mod office-resources
```

레이아웃이 쓰는 모드는 `office`, `office-apps`, `office-usage`, `office-resources` 넷이다. 모두 `place: none`(레이아웃이 자리를 정한다)이고 `office`만 `focusable`이다.

### 툴바 규칙 (패널 공통)

- 아이콘 16px, 기능마다 색 하나. 쓸 수 없는 버튼은 `dim`으로 흐리게, 쓸 일 자체가 없으면 숨긴다.
- 켜고 끄는 버튼은 **한 자리**에서 아이콘으로 상태를 보인다(눈 ↔ 빗금 눈, 🔍 ↔ ✕). 걸러 내는 중이면 배경 `selected`.
- 펼치기/접기도 한 자리: 열린 것이 있으면 "모두 접기", 다 닫혀 있으면 "모두 펼치기".
- 상태 숫자는 버튼에 바로 쓴다(사용량 패널의 갱신 주기 `5분`).
- 툴팁은 기본 툴팁(커서를 가림) 대신 **창 오버레이**(`kind: window`, `frame: none`, 고정 `key`)로 아이콘 바로 위에 띄운다. 글은 "지금 상태 · 누르면 무엇".

### 우클릭 메뉴 규칙 (파일·브랜치 공통, 런처 메뉴는 하위 메뉴 없이 같은 모양)

- 팝업 위치는 `menu.js`의 `popupAt(w, h)`: 마우스 오른쪽 아래가 기본, 창에 공간이 모자라면 위·왼쪽으로 뒤집는다.
- 맨 위 머리줄에 대상(아이콘·이름)과 상태 배지.
- 자주 쓰는 것을 위에, 나머지는 하위 메뉴(▸)로 묶는다. 하위 메뉴는 같은 팝업 안에서 화면을 바꾸고 머리줄 `←`로 돌아온다. 팝업 높이는 가장 긴 화면에 맞춘다.
- 쓸 수 없는 항목은 숨긴다. 위험한 항목은 빨간 글씨, 확인 창을 거친다.
- 항목 30px: 색 아이콘 15px · 이름 · 오른쪽에 흐린 보조 글(실행될 명령, 복사될 경로 등).
- 키: `↑↓` 이동, `Enter`/`→` 실행·열기, `←`/`Backspace` 뒤로, `Esc` 닫기.

## 사무실 (`mods/office`)

역할(`props.role`)은 `floor`(사무실 그림)와 `termbar`(터미널 칸 위 막대: 지금 스페이스 이름·브랜치와 `✕`) 두 개다.

- **방:** 스페이스마다 첫 터미널의 현재 폴더(없으면 만든 폴더)에서 `git rev-parse --git-common-dir`로 레포를 찾아 묶는다. 홈 폴더(`~`) 스페이스는 늘 있는 "사장님방"(맨 앞, 임원용 책상, 비어 있으면 책상 하나), 레포가 아니면 "기타"(맨 뒤).
- **배치:** 방 한 줄에 테이블 3개(`COLS`), 방 사이 통로 1.2m. 방의 왼쪽(xmin)·뒤(ymax) 가장자리 칸에 벽, 왼쪽 벽 윗부분에 방 이름 명패(벽 기울기대로 비튼 SVG를 실행 중에 만든다). 소품은 방 이름을 시드로 한 난수로 고르고 놓아, 다시 그려도 같은 자리다.
- **테이블:** 워크트리 스페이스 하나에 4인 책상 하나. 아래에 브랜치 이름(없으면 스페이스 이름) 이름표. 자리는 얼굴이 보이는 안쪽부터 채운다.
- **머리 위 알약:** 상태 낱말이 먼저 읽히게 색 알약에 쓰고 로고는 작게.

  | 상태 | 알약 |
  |---|---|
  | `blocked` | 빨강 `#e5484d` "답 필요", 깜빡이며 살짝 튐 |
  | `working` | 노랑 `#e8b92e` 스피너 + "작업 중 n분"(`working_since` 기준) |
  | `done` | 초록 `#30a46c` ✓ "완료 n분 전" |
  | `idle` | 회색 "대기" |

  일하는 서브에이전트(`terminals()`에서 `parent`가 이 에이전트)가 있으면 `+n`. Herdr는 완료를 한 번 보면 `idle`로 바꾸지만, 사무실은 다음 일을 시작할 때까지 완료로 둔다.
- **로고:** Claude Code는 Claude 별(`icons/claude.svg`, `#d97757`), Codex는 OpenAI 로고(`icons/openai.svg`). 그 밖에는 `program.icon`.
- **열고 닫기:** 테이블 클릭 → `space.select` + `layout.show office-term` + 공유 상태 `office.open`. 같은 테이블·빈 바닥·`✕`·`Esc`(사무실에 포커스)·"전체 보기" → `layout.hide`.
- **오버뷰:** 터미널 칸이 열려 있으면 사무실 칸 위 40%는 장면, 아래는 고른 워크트리의 오버뷰다. 레포 이름 · 브랜치·머신 · `↑n ↓n`(`git status -b -uno`, 10초마다), 입력 대기 에이전트가 있으면 "답하기" 버튼, 에이전트 줄(상태·이름·경과·창 제목)과 그 아래 이번 턴 활동(`activity.js`가 Claude Code 대화 기록 jsonl 끝 2MB에서 도구 호출을 읽는다), 서브에이전트 줄. 변경 파일 섹션은 없다(파일·커밋 앱이 맡는다).
- **사무실 추가:** 머리줄 "+ 사무실 추가하기" → `pickFolder` → `space.new`.

### 스프라이트 (`sprites/`, `tools/render-office.py`)

사무실 그림은 Blender로 렌더한 아이소메트릭 투명 PNG를 겹쳐 그린다. 모든 층이 같은 카메라·같은 캔버스라 같은 좌표에 그대로 겹치면 맞는다.

```sh
blender -b --factory-startup --python tools/render-office.py -- <에셋 폴더> office/mods/office/sprites [--sample]
```

- `<에셋 폴더>`: Office_48_Standalone_Pack, Lowpoly_People_Standalone_Pack을 각각 `office/`, `people/`에 푼 폴더. 패키지의 스크립트는 실행하지 않고 GLB만 가져온다. `--sample`은 캐릭터 3명만 렌더한다.
- 카메라: 정사영, 회전 (60, 0, 45), 캔버스 512px에 4.6m. 바닥 한 칸 3.6 × 4.2m.
- 결과
  - `table.png`, `seat<i>_empty.png`, `seat<i>_<캐릭터>.png`: 4인 벤치 책상, 자리별 빈 의자, 의자 + 앉아 타이핑하는 사람(테이블에 가려지는 부분은 holdout으로 투명). 캐릭터 12명.
  - `boss_table.png`, `boss_seat_*.png`: 사장님방 책상과 자리.
  - `prop_<이름>.png`: 화분·캐비닛·정수기·화이트보드·책장·휴지통.
  - `room_floor.png`, `room_wall_xmin.png`, `room_wall_ymax.png`, `room_corner.png`: 방 바닥과 벽(벽 높이 2m). 테이블 캔버스의 두 배 크기 캔버스.
  - `manifest.json`: 캔버스 크기, 월드 원점 픽셀, 월드 축의 화면 벡터(`ex`, `ey`, `ez`), 자리별 머리·바닥 위치, 테이블 클릭 영역, 사장님방·소품·방 정보.
- 모드는 `manifest.json`을 한 번 읽어 모듈 변수에 두고, 방·사장님방 정보가 없는 예전 형식이면 다시 읽는다.

## 앱 런처 (`mods/office-apps`)

### 런처 (`main.js`)

- **런처 화면:** 검색창(앱 이름·설명·id로 거름) + 앱 아이콘 격자(타일 56px, 앱 색 바탕 + 흰 아이콘 `apps/<id>.svg`). 앱 관리는 격자의 `manage` 앱으로 연다.
  격자는 `APPS`의 `group`(`"apps"` | `"system"`, `GROUPS` 순서)으로 줄을 나누고 줄마다 작은 흐린 제목("앱" · "설정")을 단다. 걸러서 빈 줄은 제목째 숨긴다. 앱 관리 대화 상자 목록도 같은 순서·제목.
- **앱 화면:** 위 막대 44px(`‹ 앱` · 타일 · 이름 · 앱의 `subtitle`) / 왼쪽 250px(`list`) / 오른쪽 나머지(`detail`, 바탕 `background`로 강조). `detail`이 `null`이면 앱의 `emptyState()` 문구, 없으면 "선택 내용이 없습니다 · 왼쪽에서 항목을 고르세요".
- **키보드:** 왼쪽 칸에 런처의 포커스 핸들(`track_focus`)을 달고, 그 칸 자체가 포커스를 가졌을 때만 ↑↓ → `move(-1|+1, cx)`, Enter → `activate(cx)`. 칸을 누르면 GPUI가 포커스를 준다(안쪽 입력 상자는 자기가 먼저 가져가고, 그때는 키를 가로채지 않는다). 격자에서 눌러 들어갈 때도 이 칸에 포커스(시작 복원·명령으로 열 때는 키보드를 옮기지 않음).
- **앱 관리:** 대화 상자(오버레이 역할 `manage`, 420×520)에서 앱마다 스위치. 끈 앱 목록은 공유 상태 `office-apps.disabled`(`{ id: true }`)에 두고, 대화 상자가 `setShared`로 바로 바꾼다. 런처는 렌더 때 이전 값과 비교해(`syncDisabled`) 새로 꺼진 앱의 인스턴스를 `dispose()`한 뒤 버리고, 보던 앱이 꺼졌으면 런처 화면으로 돌아간다. 끈 앱은 격자에서 숨기고 인스턴스를 만들지 않는다.
- **앱 인스턴스:** 켜진 앱을 처음 열 때(`go`) 만든다. 렌더 중에는 입력 상자 등을 만들 수 없어서 이벤트·명령 처리 시점에 만든다. 마지막으로 연 앱 id는 `localStorage`의 `app`.
- **우클릭 메뉴:** 앱 아이콘 우클릭 → 오버레이 `launcherMenu`(열기 · 앱 끄기 · 앱 관리…). 오버레이는 모드의 새 복사본이라 상태를 나누지 않으므로, 고른 동작은 `run("office-apps.<명령>")`으로 런처에 돌려보낸다.
- **명령**(`nextCommand`)

  | 명령 | 하는 일 |
  |---|---|
  | `office-apps.home` | 런처로 |
  | `office-apps.open-<id>` | 앱 열기 (`action` 앱이면 그 동작) |
  | `office-apps.show:<경로>` | 파일 앱을 열고 그 파일을 보여 줌(프로젝트 기준 상대 경로) |
  | `office-apps.manage` | 앱 관리 대화 상자 |
  | `office-apps.disable-<id>` | 앱 끄기 (`manage`는 무시) |
  | `office-apps.commit:<해시\|WORKTREE>` | 커밋 앱을 열고 `openCommit(값, cx)`. 커밋 앱이 꺼져 있으면 알림만 |
  | `office-apps.range:<a>...<b>` | 커밋 앱을 열고 `openRange(a, b, cx)`(첫 `...`로 나눔). 꺼져 있으면 알림만 |
  | `office-apps.files-toggle-hidden` · `files-toggle-ignored` | 파일 앱 숨김 파일 · gitignore 항목 보이기 전환(툴바 `⋯` 메뉴가 보냄) |

  `herdr-app do office-apps.open-files`처럼 클릭 없이 시험할 때 쓴다.

### 오버레이 역할

오버레이는 `openOverlay({ mod: "office-apps", props: { role, ... } })`로 띄우고, 기본 내보내기(`OfficeApps`)가 `props.role`로 역할 클래스를 고른다. 역할이 없으면 런처다.

| 역할 | 어디 | 하는 일 |
|---|---|---|
| `menu` | `menu.js` `Menu` | 파일트리 우클릭 메뉴 |
| `confirm` | `menu.js` `Confirm` | 확인 창. `ACTIONS[props.action](props.ctx)`를 부른다 |
| `prompt` | `files.js` | 이름 입력 창(새 파일·폴더·이름 바꾸기) |
| `tip` | `files.js` | 툴바 툴팁 창 |
| `launcherMenu` | `main.js` | 런처 앱 아이콘 우클릭 메뉴 |
| `manage` | `main.js` `ManageDialog` | 앱 관리 대화 상자(앱마다 켜고 끄기) |
| `branch-menu`, `branch-prompt` | `branch.js` | 브랜치 우클릭 메뉴와 입력 창 |

역할 표는 `files.js`의 `ROLES`와 `main.js`의 `ALL_ROLES`, 확인 창 동작 표는 `menu.js`의 `ACTIONS`다. 브랜치·PR·서버 앱은 이 공용 파일을 고치지 않고, 모듈이 불릴 때 자기 동작을 표에 더한다(`branch.*`, `pr.merge`·`pr.close`·`pr.checkout`, `serverRemove`). `main.js`가 모든 앱 파일을 import하므로 오버레이 복사본에서도 먼저 등록된다. 확인 창은 따로 뜨는 복사본이라 함수를 넘길 수 없고, `ctx`에는 값만 담는다.

### 앱

| 앱 (id) | 파일 | 내용 |
|---|---|---|
| 파일 (`files`) | `files.js`, `viewers.js`, `markdown.js`, `menu.js`, `viewers/` | 아래 참고 |
| 브랜치 (`branch`) | `branch.js` | 왼쪽: 툴바(검색·가져오기·끌어오기·푸시·새 브랜치·임시 저장·더보기·다시 읽기) + 로컬/원격/태그. 오른쪽: 고른 브랜치의 추적 상태(원격·현재 브랜치 대비 앞섬/뒤처짐), 동작 버튼, 받을 커밋, 최근 커밋. `.git` 감시 + 15초마다 다시 읽음. 짧은 일(체크아웃·만들기·이름 변경·삭제)은 바로, 결과를 사람이 봐야 하는 일(끌어오기·푸시·병합·리베이스·원격 삭제)은 새 터미널 탭에서. 위험한 동작은 확인 창. |
| 커밋 (`commit`) | `commit.js`, `commit/git.js` | 왼쪽: 검색 + 현재 브랜치 커밋 목록(200개씩, 더 불러오기), 맨 위에 "커밋 안 된 변경"(있을 때만). 오른쪽: 제목·본문·작성자·시각·해시, 바뀐 파일, 고른 파일의 diff. git은 `.git` 아래에 쓰지 않는 옵션으로 읽기만 한다. 파싱은 `commit/git.js`(herdr를 import하지 않아 node로 시험 가능). |
| PR (`pr`) | `pr.js` | `gh`로 왼쪽: 필터(열림·내 PR·리뷰 요청·닫힘) + 목록, 오른쪽: 상태, base ← head, 본문, 체크, 리뷰·코멘트, 바뀐 파일, 동작. 머지(`--match-head-commit`)·닫기·체크아웃은 확인 창을 거친다(구현됨). 동작 뒤 공유 상태를 바꿔 다시 읽는다. |
| 에이전트 (`agent`) | `agent.js`, `agent/activity.js`, `agent/parse.js` | 왼쪽: 에이전트 목록, 서브에이전트(`hc run`으로 띄운 터미널은 `terminals()`의 `parent`, Claude Code 안의 서브에이전트는 `hc get`의 records)는 부모 아래 들여쓴다. 오른쪽: 이번 턴의 요청·마지막 말·도구 흐름·서브에이전트·고친/읽은 파일, 터미널로 이동·엿보기. 기록은 터미널 앞쪽 프로세스 pid → `~/.claude/sessions/<pid>.json`의 sessionId로 찾고, 못 찾으면 그 폴더의 가장 최근 jsonl. 이 앱이 그려지는 동안만 타이머가 돈다(고른 에이전트 작업 중 4초, 다른 에이전트 작업 중 15초, 모두 쉬면 1분). `office/activity.js`를 옮겨 와 고친 것이다(다른 모드라 import로 나눠 쓸 수 없다). |
| 서버 (`server`) | `server.js`, `server/add.js`, `server/resources.js` | 왼쪽: 툴바(기기 추가·다시 읽기) + 머신 목록(이 컴퓨터 + `hc machine ls`, 연결 상태, 스페이스 수). 오른쪽: 주소·연결 방식·호스트·hc 버전, 그 머신의 스페이스·에이전트, 새 스페이스·새 터미널·제거(확인 창 → `hc machine rm`). 리소스는 칸이 넓으면 오른쪽 열(260px), 좁으면 정보 줄 아래. 기기 추가·제거는 구현됨. |
| 설정 (`settings`) | `main.js` | `action` 앱: 들어가지 않고 `run("app.settings")`로 Herdr 설정 창을 연다. |
| 앱 관리 (`manage`) | `main.js` | `action` 앱: `openManage`로 앱 관리 대화 상자를 띄운다(`office-apps.manage`와 같은 함수). `locked`라 끌 수 없다: 관리 목록에 "항상 켜짐", 우클릭 메뉴는 열기만, `disable-manage`와 공유 상태의 `manage: true`는 무시. |

#### 파일 앱

- 기본 `files` 모드를 바탕으로 한다. 포커스된 패인의 폴더(없으면 스페이스 폴더)를 보여 주고, 폴더별 500개·전체 5,000개까지. 폴더 감시 + 10초마다 다시 읽음.
- **부제:** `~/경로`(누르면 `open`).
- **아이콘:** Material Icon Theme(`icons/`, `icons.json`, `tools/build-icons.py`로 생성). `fileNames → fileExtensions(긴 확장자부터) → languageIds(확장자→언어 표) → file` 순으로 찾고, 라이트 테마면 `light` 표를 먼저 본다.
- **git 색:** `git status --porcelain -z --ignored=matching`. 수정 파랑, 추가 초록, 새 파일·충돌 빨강, 삭제 회색, 무시됨 갈색.
- **툴바(한 줄):** 검색(`git ls-files -co --exclude-standard`, 없으면 `find`) · 새 파일 · 새 폴더 · 터미널 · 펼치기/접기 · 다시 읽기 · `⋯`(숨김 파일 보이기 ✓ · gitignore 항목 감추기 ✓ · 경로 복사, `menu.js`의 `kind: "tools"` 메뉴). 걸러 내는 중이면 `⋯`에 배경. 필터 상태는 `localStorage`.
- **키보드:** `move`는 보이는 줄(`visible()`, `rows()`와 같은 거르기)로 커서를 옮기고 파일이면 미리보기를 연다. 검색 중이면 검색 결과를 오간다. `activate`는 폴더 펼치기/접기, 파일 열기.
- **우클릭(`menu.js`):** 빈 영역 / 폴더 / 파일, 파일 종류(`package.json` 스크립트, 테스트, 실행 파일, `Makefile`, Docker, 이미지, 압축, `.env*`), git 상태(새 파일·수정·stage됨·커밋됨·무시됨·충돌)마다 항목이 바뀐다. 공통: 다음으로 열기 ▸, 새 파일·폴더, 복사 ▸, 이름 바꾸기, 복제, 압축, 휴지통(`trash`, 없으면 Finder). 파일을 바꾼 뒤엔 공유 상태 `office-apps.tick`을 바꿔 트리가 다시 읽게 한다.
- **뷰어(`viewers.js`):** 확장자로 미리보기 종류를 고른다. 추가 설치 없이 macOS 기본 도구와 Python 표준 라이브러리만 쓴다. 만든 미리보기는 `data/office-apps/preview/<경로·수정 시각 해시>/`에 두고 같은 파일은 다시 만들지 않는다.

  | 종류 | 대상 |
  |---|---|
  | `code` | 코드·텍스트(읽기 전용 편집기, 색 입힘), JSON, 압축 파일 목록(`unzip`, `tar`), 16진수 덤프(`xxd`) |
  | `md` | 마크다운(`markdown.js`) |
  | `pages` | 이미지, `sips`로 바꾸는 이미지(HEIC·PSD·RAW 등), PDF(`viewers/pdf.swift`, 처음 쓸 때 `xcrun swiftc`로 `data/office-apps/bin/pdfpages`에 컴파일, 실패하면 `swift`로 실행), Quick Look(`qlmanage`) 미리보기 |
  | `table` | CSV·TSV, 엑셀(`viewers/office.py`) |
  | `slides` | 파워포인트(`viewers/office.py`) |

  워드·RTF 등은 `textutil`로 글을 뽑아 마크다운으로 보여 주고, 오디오는 `mdls` 정보와 Quick Look 그림을 함께 보여 준다.
- **마크다운(`markdown.js`):** `TextView.markdown`이 그리는 것(표·체크박스·취소선·자동 링크·인용)은 그대로 넘기고, 못 그리는 것만 블록으로 떼어 낸다: 코드 블록(읽기 전용 편집기로 색), `> [!NOTE]` 알림, 그림만 있는 줄(여러 줄 HTML로 감싼 그림 포함, 배지는 한 줄에 나란히). 각주는 위첨자 번호로 바꾸고 내용은 문서 끝에 모은다. 원격 그림은 `curl`로 받아 캐시한다.
- **글꼴:** 코드·마크다운 뷰어는 `D2Coding`(`CODE_FONT`), 나머지 패널은 레이아웃의 `Pretendard GOV`.

### 새 앱 추가하기

1. **앱 클래스**를 `mods/office-apps/<id>.js`에 만든다. 런처가 부르는 메서드:

   | 메서드 | 필수 | 하는 일 |
   |---|---|---|
   | `init(props, cx)` | 예 | 처음 열 때 한 번. `props`는 `{}`, `cx`는 런처의 것이다. 타이머(`cx.timer.every`)·비동기 작업(`cx.spawn`)은 여기서 시작하고, 바뀌면 `cx.notify()` |
   | `list(cx, t)` | 예 | 왼쪽 250px 칸의 내용(툴바 + 목록). `t`는 `theme()` |
   | `detail(cx, t)` | 아니오 | 오른쪽 칸의 내용. `null`이면 "선택 내용이 없습니다" |
   | `subtitle(t)` | 아니오 | 위 막대의 앱 이름 옆 부제 |
   | `move(d, cx)` | 아니오 | 왼쪽 칸에 포커스가 있을 때 ↑(`-1`)/↓(`+1`). 고른 항목을 옮긴다(셸이 이어서 `cx.notify()`) |
   | `activate(cx)` | 아니오 | 왼쪽 칸에서 Enter. 고른 항목을 연다·펼친다 |
   | `emptyState()` | 아니오 | `detail`이 `null`일 때 오른쪽 문구 `{ text, sub }` |
   | `dispose()` | 아니오 | 앱을 끌 때 한 번. 타이머·감시를 멈춘다 |
   | `openCommit(값, cx)` · `openRange(a, b, cx)` | 커밋 앱만 | `office-apps.commit:` · `range:` 명령이 앱을 연 뒤 부른다 |

   지금 스페이스를 보는 앱은 파일·브랜치 앱과 같은 규칙(포커스된 패인의 폴더, 없으면 스페이스 폴더, 다른 머신이면 `on`)을 따른다.
2. **`main.js`의 `APPS`에 등록**한다: `{ id, group: "apps", name, desc, color, make: () => new XxxApp() }`(창만 띄우는 항목은 `group: "system"`). 들어가지 않고 동작만 하는 앱은 `make` 대신 `action: () => ...`. `make`도 `action`도 없으면 격자에는 보이되 들어가면 "준비 중인 앱입니다"가 나온다. 파일 맨 위에 import를 더한다.
3. **아이콘** `apps/<id>.svg`를 둔다. 런처가 앱 색 타일 위에 `text_color("#ffffff")`로 칠하므로 단색 SVG로 그린다(지금 아이콘들과 같은 형식).
4. **확인 창**이 필요하면 지금은 `menu.js`의 `ACTIONS`에 동작을 등록하는 방식이다. 모듈 최상위(함수 밖)에 `ACTIONS["<id>.<동작>"] = (ctx) => ...`를 두고, `openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: { role: "confirm", action, title, detail, ctx } })`로 띄운다. `ctx`에는 값만 담는다. 새 오버레이 역할이 필요하면 같은 방식으로 `files.js`의 `ROLES`에 더한다(`branch.js` 끝 참고).
5. `herdr-app check office/mods/office-apps` → `./install.sh` → `herdr-app do office-apps.open-<id>` → `herdr-app shot`, `herdr-app status`의 errors 확인.

## LLM 사용량 (`mods/office-usage`)

- 설치된 CLI(`sh -lc command -v`)만 보인다. 각 CLI가 로그인해 둔 구독 계정으로 조회한다.

  | 프로바이더 | 토큰 | 조회 |
  |---|---|---|
  | Claude | 키체인 `Claude Code-credentials` | `GET api.anthropic.com/api/oauth/usage` (`five_hour`, `seven_day`, Fable 주간) |
  | Codex | `~/.codex/auth.json` | `GET chatgpt.com/backend-api/wham/usage` (`primary/secondary_window`) |
  | Antigravity | agy가 관리 | `agy -p /usage --output-format json` (명령이라 할당량을 쓰지 않음; `num_turns > 0`이면 업데이트 안내) |
  | Grok | `~/.grok/auth.json` | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` |

- **Grok 토큰 갱신:** 만료 2분 전부터, Grok CLI가 꺼져 있을 때만(`pgrep -x grok`). `grok_refresh.py`가 `auth.json.lock`을 잡고 다시 읽은 뒤 OIDC `refresh_token`으로 갱신해, Grok과 같은 형식(들여쓰기 2, 비ASCII 그대로)으로 임시 파일에 쓰고 바꿔치기한다(권한 600).
- **로그인 필요:** "로그인이 필요해요 · `<명령>` 실행 →" 링크가 새 탭에서 `claude /login`, `codex login`, `agy`, `grok login`을 연다.
- **줄:** 이름 · 사용률 % / 막대(높이 6) / "N시간 M분 후 초기화". 색: 70% 미만 `#a7c080`, 주의 `#e8b92e`, 경고 `#f76b15`, 100% `#e5484d`.
- **Antigravity:** 사용률·초기화 시각이 같은 모델을 한 줄로("모든 모델 (25개)"), 모델 계열 이름은 칸보다 길면 `frames`로 한 글자씩 왼쪽으로 흘리고(140ms), 양 끝에서 약 1.7초 멈춘 뒤 처음으로 점프한다.
- **헤더:** "10:51 갱신 · 5분 후 다시". 마지막 조회 뒤 주기가 지나면 다시 읽는다(30초마다 확인).
- **프로바이더 머리줄:** `⠿` 손잡이(끌어서 순서), 펼침 화살표, 로고(Claude는 Anthropic 별 `#d97757`, Codex는 OpenAI, Grok은 글자색), 🌐 사용량 웹페이지, 접혀도 보이는 최대 사용률.
- **툴바:** 펼치기/접기 · 정렬(사용률순 ↔ 내 순서) · 순서 초기화(내 순서를 바꿨을 때만) · ⏱ 주기(1·5·15·30분, 버튼에 글자) · 흘리기 켜기/끄기 · (오른쪽) 새로 고침(읽는 동안 회전). 설정은 `localStorage`.

## 리소스 관리자 (`mods/office-resources`)

- 칸은 사용량과 6:4 비율로 나눈다(레이아웃 크기는 `px`·`weight`뿐이라 사용량이 내용 높이만 쓰게 할 수 없다). 칸 높이가 220px 이상이면(`on_size_change`) 전체 표, 미만이면 28px 한 줄(메모리 칩 아이콘 + 이 컴퓨터 터미널 메모리 합, 흐린 글자)을 칸 맨 위(사용량 카드 바로 아래)에 붙인다. 한 줄을 누르면 같은 표를 팝업(300×420)으로 띄운다.
- 전체 표: 머리줄(새로 고침, 팝업이면 닫기) / 요약 CPU·메모리 / ▶ 지표 세부 정보(이 컴퓨터 CPU·코어 수, 사용 중/전체 메모리) / 이름 | CPU | 메모리. 스페이스(대문자, 접기) → 탭(최근 30표본 CPU 막대) → 터미널(상태 점, 누르면 그 터미널로 이동). 숫자는 D2Coding으로 오른쪽 정렬.
- 계산(`calc.js`, herdr 없이 node로 돌려 볼 수 있음): 터미널마다 `hc get`의 뿌리(셸) pid를 한 번 얻어 두고, 3초마다 기기당 `ps -A -o pid=,ppid=,pcpu=,rss=` 한 번으로 자손 트리 합을 낸다. CPU는 코어 수로 나눠 기기 전체 대비 %. 터미널의 탭은 패인 → `herdr.tab` 라벨 → 서브에이전트면 부모의 탭. 다른 기기는 같은 스크립트를 `exec on`으로 돌리고, 실패하거나 연결이 없으면 "<기기>에 연결할 수 없어 리소스를 알 수 없습니다." 한 줄.
- 갱신은 앱 창이 앞에 있고 칸이 숨겨지지 않았을 때만(Herdr는 숨은 복사본의 타이머도 돌리므로 틱에서 거른다).

## `mods/office-git` (레이아웃에서 쓰지 않음)

예전 아래 칸의 독립 브랜치·커밋 그래프 모드다. 레포에 남아 있지만 지금 레이아웃은 쓰지 않고, 브랜치 앱(`office-apps/branch.js`)의 이식 원본이다. `install.sh`는 `mods/` 아래 폴더를 모두 복사하므로 설치본에는 들어간다. 예전 버전을 설치했던 곳에는 `mods/office-files`(지금의 `office-apps` 이전 이름)도 남아 있을 수 있다.

## 파일

- `layouts/office.json`: 레이아웃
- `mods/office/`: 사무실과 터미널 막대(`main.js`), 오버뷰 활동 읽기(`activity.js`), 스프라이트(`sprites/`), 로고·활동 아이콘(`icons/`), 패널 글꼴(`fonts/`, OFL)
- `mods/office-apps/`: 런처(`main.js`), 앱(`files.js`, `branch.js`, `commit.js`, `pr.js`, `agent.js`, `server.js`와 같은 이름 폴더), 파일 우클릭 메뉴·확인 창·`ACTIONS`(`menu.js`), 뷰어(`viewers.js`, `markdown.js`, `viewers/`), 앱 아이콘(`apps/`), 파일 아이콘(`icons/`, `icons.json`, MIT 라이선스)
- `mods/office-usage/`: 사용량(`main.js`), Grok 토큰 갱신(`grok_refresh.py`), 로고(`icons/`)
- `mods/office-resources/`: 리소스 관리자(`main.js`), ps 합계 계산(`calc.js`)
- `mods/office-git/`: 쓰지 않는 예전 모드(브랜치 앱의 이식 원본)
- `../tools/render-office.py`: 사무실 스프라이트 렌더(Blender)
- `../tools/build-icons.py`: Material Icon Theme 패키지에서 파일 아이콘과 `icons.json` 생성
- `../install.sh`: 위 파일들 중 바뀐 것만 `~/.config/herdr-app`에 복사
