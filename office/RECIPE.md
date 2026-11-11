# Office

코딩 에이전트들이 일하는 사무실을 위에, 파일·git·LLM 사용량 패널을 아래에 둔 Herdr 레이아웃이다. 이 문서만 보고 처음부터 다시 만들 수 있게 쓴다. 파일들은 이 레시피를 한 번 구현한 결과다.

<!-- ![Office](preview.png) -->

## 보이는 것

테마는 정하지 않는다(사용자 설정을 따른다). 터미널·패널 글꼴은 `D2Coding`. 시스템 제목 표시줄을 쓴다.

```
root  column · padding 8 · gap 8 · background canvas
├─ office-top     row · weight 3 · gap 8
│  ├─ office-floor     block · weight 1 · min 240 · radius 10 · border 1 border   → mod office {role: floor}
│  └─ office-term      column · weight 2   (layout.show/hide로 열고 닫음)
│     ├─ office-termbar   block · 32px   → mod office {role: termbar}
│     └─ office-tab       block · {tab: active} · 패인 카드 radius 10, focus 테두리 accent
└─ office-bottom  row · weight 2 · gap 8
   ├─ office-files    block · weight 1 · min 200 · chrome   → mod office-files
   ├─ office-git      block · weight 2 · chrome             → mod office-git
   └─ office-usage    block · 300px · min 240 · chrome      → mod office-usage
```

아래 세 칸은 모두 radius 10, 1px `border` 테두리, `chrome` 배경이다. 각 칸은 위에서부터 **헤더(36~40px) → 툴바(32px) → 내용** 순서다.

### 툴바 규칙 (세 패널 공통)

- 아이콘 16px, 기능마다 색 하나. 쓸 수 없는 버튼은 `dim`으로 흐리게, 쓸 일 자체가 없으면 숨긴다.
- 켜고 끄는 버튼은 **한 자리**에서 아이콘으로 상태를 보인다(눈 ↔ 빗금 눈, ☆ ↔ ★, 🔍 ↔ ✕). 걸러 내는 중이면 배경 `selected`.
- 펼치기/접기도 한 자리: 열린 것이 있으면 "모두 접기", 다 닫혀 있으면 "모두 펼치기".
- 상태 숫자는 버튼에 바로 쓴다(끌어오기 `↓n`, 푸시 `↑n`, 갱신 주기 `5분`).
- 툴팁은 기본 툴팁(커서를 가림) 대신 **창 오버레이**(`kind: window`, `frame: none`, 고정 `key`)로 아이콘 바로 위 30px, 아이콘 가운데에 띄운다. 글은 "지금 상태 · 누르면 무엇".

### 우클릭 메뉴 규칙 (파일·브랜치 공통)

- 팝업 너비 300~330px. 마우스 오른쪽 아래에 띄우되, 창에 공간이 모자라면 위·왼쪽으로 뒤집는다(`window.mouse_position()`, `viewport_size()`).
- 맨 위 머리줄에 대상(아이콘·이름)과 상태 배지.
- 자주 쓰는 것을 위에, 나머지는 하위 메뉴(▸)로 묶는다. 하위 메뉴는 같은 팝업 안에서 화면을 바꾸고 머리줄 `←`로 돌아온다. 팝업 높이는 가장 긴 화면에 맞춘다.
- 쓸 수 없는 항목은 숨긴다. 위험한 항목은 빨간 글씨 `#e67e80`, 확인 창을 거친다.
- 항목 30px: 색 아이콘 15px · 이름 · 오른쪽에 흐린 보조 글(실행될 명령, 복사될 경로 등).
- 키: `↑↓` 이동, `Enter`/`→` 실행·열기, `←`/`Backspace` 뒤로, `Esc` 닫기.

## 사무실 (`mods/office`)

- **구역:** 스페이스마다 첫 터미널의 현재 폴더(없으면 만든 폴더)에서 `git rev-parse --git-common-dir`로 레포를 찾아 묶는다. 레포가 아니면 "기타" 구역, 맨 뒤.
- **테이블:** 폭 150, 워크트리 스페이스 하나에 하나. 아래에 브랜치 이름(없으면 스페이스 이름). 고른 테이블은 `selected` 배경과 `accent` 테두리.
- **캐릭터:** 테이블에 최대 4명, 넘치면 `+n`. 셔츠 색은 주소 해시로 고정 팔레트(`#7aa2d6 #8cc0a0 #d69a7a #b69ad6 #d6c27a #7ac6c6 #d67aa2 #a2b07a`)에서.
- **말풍선:** 흰 바탕에 에이전트 로고(`program.icon`, `tint`이면 `svg` 아니면 `image`), 우상단에 상태 뱃지.

  | 상태 | 뱃지 |
  |---|---|
  | `working` | 노란 `#e8b92e` 스피너 (`svg(spinner).spin(900)`) |
  | `blocked` | 빨간 `#e5484d` 원 안의 흰 `?` |
  | `done` | 채운 초록 `#30a46c` 원 |
  | 서브에이전트 일하는 중 | `terminals()`에서 `parent`가 이 에이전트인 것: 속이 빈 원(그 프로그램의 `tile` 색, 없으면 팔레트) 안에 로고 |

  Herdr 상태는 `working/blocked/done/idle`뿐이라 "문제로 멈춤"은 표시하지 않는다.
- **열고 닫기:** 테이블 클릭 → `space.select` + `layout.show office-term` + 공유 상태 `office.open`. 같은 테이블·빈 바닥·`✕`·`Esc`(사무실에 포커스) → `layout.hide`. 장면은 칸 가운데에 두고, 칸 너비가 바뀌면 `left/top`을 `transition(380ms, ease-out)`으로 옮긴다(레이아웃 칸 자체는 한 번에 바뀐다).
- **그래픽:** 지금은 도형. 로우폴리 모델을 부품별 투명 PNG(바닥 타일, 구역 러그, 테이블, 캐릭터)로 렌더해 개수에 맞춰 조립할 예정.

## 파일트리 (`mods/office-files`)

- 기본 `files` 모드를 바탕으로 한다. 포커스된 패인의 폴더(없으면 스페이스 폴더)를 보여 주고, 폴더별 500개·전체 5,000개까지.
- **헤더:** 열린 폴더 아이콘 · 프로젝트 이름(굵게) · `~/경로`(흐림, 누르면 `open`; 미리보기 중엔 그 파일을 `open -R`).
- **아이콘:** Material Icon Theme. `icons.json`은 `fileNames → fileExtensions(긴 확장자부터) → languageIds(확장자→언어 표) → file` 순으로 찾고, 라이트 테마면 `light` 표를 먼저 본다. 표는 모듈 변수에 두고, 비어 있으면 render에서 다시 읽는다(핫 리로드 대비).
- **git 색:** `git status --porcelain -z --ignored=matching`. 수정 `#6897bb`, 추가 `#629755`, 새 파일·충돌 `#d1675a`, 삭제 `#8c8c8c`, 무시됨(자신이나 상위가 `!!`) `#a07850`.
- **툴바:** 검색(`git ls-files -co --exclude-standard`, 없으면 `find`) · 숨김 파일 · gitignore 항목 · 새 파일 · 새 폴더 · 터미널 · 경로 복사 · (오른쪽) 펼치기/접기 · 다시 읽기. 새 파일 등은 마지막으로 누른 폴더 기준. 필터 상태는 저장한다.
- **우클릭:** 빈 영역(맨 위 폴더) / 폴더 / 파일로 나뉜다.
  - 파일 종류: `package.json` → 스크립트 실행 ▸·의존성 설치, 락 파일 → 다시 설치, `*.test|spec.*` → vitest 실행, `.sh/.py/.js/.ts` → 실행, `Makefile` → make 대상 ▸, `Dockerfile`·compose → 빌드·올리기·내리기, 이미지 → Quick Look, 압축 파일 → 풀기, `.env*` → `.env.example` 만들기. 패키지 매니저는 위로 올라가며 찾은 락 파일로.
  - git 상태: 새 파일 → git에 추가·gitignore / 수정 → diff·기록·blame·stage·되돌리기 / stage됨 → staged diff·빼기 / 커밋됨 → 마지막 커밋·기록·blame / 무시됨 → 왜 무시되는지 / 충돌 → 내 쪽·상대 쪽·해결됨을 **맨 위에**.
  - 공통: 다음으로 열기 ▸(기본 앱, 설치된 에디터, Finder, 터미널), 새 파일·폴더, 복사 ▸, 이름 바꾸기, 복제, (폴더) 압축, 휴지통(`trash`, 없으면 Finder).
- 파일을 바꾼 뒤엔 공유 상태 `office-files.tick`을 바꿔 트리가 다시 읽게 한다. 오버레이의 "미리보기"는 `office-files.preview`로 알린다.

## 브랜치 · 커밋 (`mods/office-git`)

- **브랜치 화면:** HEAD 줄 · 로컬(이름의 `/`로 폴더) · 원격(리모트별 폴더) · 태그(처음엔 접힘). 아이콘 색은 현재 `#e5739d`, 즐겨찾기·기본 `#e8b92e`, 나머지 `#6ca0dc`. 추적 정보는 `↑n`(초록)·`↓n`(파랑)·`원격 없음`(빨강).
- **읽는 것:** `for-each-ref`(HEAD, symref, upstream, track), `worktree list --porcelain`, `branch --merged HEAD`, `status --porcelain -uno`. `.git` 폴더를 감시하고 15초마다도 다시 읽는다.
- **툴바:** ☆/★ 즐겨찾기만 · 🔍 검색 · 가져오기 · 끌어오기(`↓n`, 추적 없거나 원격 없으면 숨김, 갈라졌으면 리베이스로) · 푸시(`↑n`, 추적 없으면 `push -u`, 갈라졌으면 비활성) · 새 브랜치 · 임시 저장(변경 없으면 비활성) · 임시 저장 목록 · 커밋 로그 · PR(`gh` 있을 때) · ⋯ 더보기(이름 변경, 태그, 상태, 병합된 브랜치 정리, 웹, lazygit) · (오른쪽) 펼치기/접기 · 다시 읽기. 즐겨찾기는 공유 상태 `office-git.favorites`에 레포별로.
- **우클릭(로컬):** 맨 위에 상황별 "할 일" — 추적 없음 → 원격에 올리기 / 뒤처짐 → 끌어오기·빨리 감기 / 앞섬 → 푸시 / 갈라짐 → 리베이스·병합으로 끌어오기, 강제 푸시(`--force-with-lease`, 확인) / 원격 없음 → 다시 올리기·추적 정리. 체크아웃은 현재면 숨김, 다른 워크트리에 있으면 "워크트리 열기", 변경이 있으면 "임시 저장 후 체크아웃"도. 삭제는 병합됨 → 바로 삭제, 아니면 강제 삭제(확인), 현재·기본·다른 워크트리면 숨김. 그 밖에 로그, 즐겨찾기, 새 브랜치·워크트리, 비교 ▸, 합치기 ▸(병합됐으면 숨김), 복사 ▸, 이름 바꾸기(기본이면 숨김).
- **우클릭(원격/태그):** 이미 로컬이 추적 중이면 "로컬로 체크아웃", 아니면 추적 브랜치 만들기. 원격에서 삭제(기본이면 숨김). 태그는 로그·새 브랜치·비교·복사.
- **커밋 화면:** `git log <ref> -n400 --date-order`. 레인 그래프(줄 26px, 레인 14px, 색 `#7aa2f7 #a7c080 #e69875 #d699b6 #83c092 #dbbc7f #7fbbb3 #e67e80`), 머지 커밋은 속 빈 점. 제목 · ref 칩(태그 노랑, HEAD 분홍, 브랜치 파랑) · 작성자 · 날짜("오늘/어제 오후 3:06", 그 밖은 "26. 11. 9. 오후 1:02") · 짧은 해시. 검색은 제목·해시 앞부분·작성자.
- 충돌·인증이 생길 수 있는 작업(비교, diff, 리베이스, 병합, 푸시, stash pop)은 새 터미널 탭에서 실행하고 터미널 칸을 연다.

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

## 파일

- `layouts/office.json`: 레이아웃
- `mods/office/`: 사무실과 터미널 막대
- `mods/office-files/`: 파일트리(`main.js`), 우클릭 메뉴·확인 창(`menu.js`), 아이콘(`icons/`, `icons.json`, MIT 라이선스)
- `mods/office-git/`: 브랜치·커밋(`main.js`), 메뉴·입력·확인 창과 git 동작(`actions.js`)
- `mods/office-usage/`: 사용량(`main.js`), Grok 토큰 갱신(`grok_refresh.py`), 로고(`icons/`)
- `../tools/build-icons.py`: Material Icon Theme 패키지에서 아이콘과 `icons.json` 생성
- `../install.sh`: 위 파일들을 `~/.config/herdr-app`에 복사
