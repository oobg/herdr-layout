# herdr-layout

Herdr 앱용 **Office** 레이아웃입니다. 위쪽은 코딩 에이전트들이 일하는 사무실이고, 아래쪽은 앱 런처와 LLM 사용량 패널입니다. 구조와 고치는 방법은 [office/RECIPE.md](office/RECIPE.md)에 있습니다.

<!-- TODO: 미리보기 추가 (터미널 내용·이메일이 찍히지 않게 찍는다) -->
<!-- ![Office](office/preview.png) -->

```
┌──────────── 사무실 ────────────┬──────────── 터미널 ────────────┐
│ 레포마다 방, 워크트리마다 테이블    │ 테이블을 누르면 열림 (1 : 2)       │
├───────────────────────────────┴──────────┬────────────────────┤
│ 앱 런처 (즐겨찾기 · 앱 · 에이전트 · 설정 줄)         │ 탭: 사용량 | 리소스   │
│                                          │ (300px)            │
└──────────────────────────────────────────┴────────────────────┘
```

## 화면 구성

### 사무실 (위)

- 레포 하나가 방 하나, 워크트리 스페이스 하나가 테이블 하나입니다. 홈 폴더(`~`) 스페이스는 늘 있는 "사장님방", 레포가 아닌 스페이스는 "기타" 방에 모입니다. 방 이름은 왼쪽 벽 명패에 씁니다.
- 그래픽은 Blender로 렌더한 아이소메트릭 스프라이트(방·테이블·의자·사람·소품)를 겹쳐 그립니다.
- 에이전트는 테이블에 앉은 사람입니다. 머리 위 알약에 상태를 씁니다.

  | 상태 | 표시 |
  |---|---|
  | 답 필요 | 빨강 "답 필요", 깜빡임 |
  | 작업 중 | 노랑 "작업 중 n분" |
  | 완료 | 초록 "완료 n분 전" (다음 일을 시작할 때까지 유지) |
  | 대기 | 회색 "대기" |
  | 상태 모름 | 회색 "상태 모름" (상태를 알리지 않는 에이전트) |

  알약 색은 테마의 상태색을 따르고, 글자는 바탕에 따라 흰색이나 검정으로 바뀝니다.

  서브에이전트가 일하는 중이면 알약 끝에 `+n`이 붙습니다.
- 테이블을 누르면 그 워크트리로 바뀌고 오른쪽에 터미널 칸이 열립니다(사무실 1 : 터미널 2). 사무실 칸 아래쪽에는 고른 워크트리의 오버뷰(레포·브랜치·앞섬/뒤처짐·지금 브랜치 CI가 실패나 진행 중이면 "CI 실패"/"CI 진행 중"(누르면 배포 앱), 에이전트별 상태와 요약(지금 하는 일, 마지막 말, 시간 띠, "자세히 →"로 에이전트 앱), 서브에이전트, 그 세션이 게시한 아티팩트(누르면 브라우저로))가 나옵니다. 같은 테이블, 빈 바닥, `✕`, `Esc`, "전체 보기"로 닫습니다.
- 머리줄의 "+ 사무실 추가하기"는 폴더를 골라 새 스페이스를 엽니다.

### 앱 런처 (아래 왼쪽)

검색창과 앱 아이콘 격자입니다. 격자는 "앱"(파일·브랜치·커밋·PR·배포·워크트리·검토·메모), "에이전트"(에이전트·알림함·세션·작업 공간·출력·포트·서버·명령), 창을 띄우는 "설정"(설정·앱 관리) 줄로 나뉘고, 검색 결과가 없는 줄은 제목째 숨깁니다. 타일 그림이 없는 앱은 모두 같은 회청색 바탕에 이름 첫 글자로 그립니다. 앱을 누르면 들어가고, 앱 화면은 위 막대(`‹ 앱` · 아이콘 · 이름 · 부제), 왼쪽 목록(250px), 오른쪽 상세로 나뉩니다. 고른 항목이 없으면 "선택 내용이 없습니다"(앱마다 다른 안내일 수 있음)가 나옵니다.

- 키보드: 왼쪽 목록을 누르면 그 칸이 키를 받습니다. ↑↓로 항목을 옮기고 Enter로 엽니다(입력 상자에 커서가 있을 때는 입력 상자가 받음). 런처 검색창에서는 ↑↓로 칸을 고르고 Enter로 열며(검색어를 바꾸면 첫 칸), 앱 화면에서 Esc를 누르면 격자로 돌아갑니다. 오른쪽 상세는 Tab·Shift+Tab으로 버튼·체크·입력칸을 차례로 오가고(끝에서 왼쪽 목록으로), Enter = 버튼, Space = 체크, ⌘Enter = 보내기·저장, Esc = 왼쪽 목록으로(검토·작업 공간·메모·배포·포트·알림함). 앱 칸은 `pane.go`(기본 키 ⌘⌥+방향키)로 들어올 수 있습니다.

- 앱 관리: 격자의 "앱 관리" 앱을 누르면 대화 상자가 떠서 앱마다 켜고 끕니다(Esc·✕로 닫음). 끈 앱은 격자에서 숨기고 인스턴스를 만들지 않습니다. 앱 관리 앱은 끌 수 없습니다.
- 즐겨찾기: 앱 아이콘 우클릭 → "즐겨찾기에 추가"로 격자 맨 위 "즐겨찾기" 줄에 모읍니다(자기 줄에도 그대로 남음). 순서는 즐겨찾기 줄에서 우클릭 → "앞으로"/"뒤로". 검색 중에는 즐겨찾기 줄을 숨기고, 검색창 ↑↓는 즐겨찾기 줄부터 지나갑니다. 꺼 둔 앱은 즐겨찾기 줄에도 보이지 않습니다.
- 앱 아이콘 우클릭: 열기 · 즐겨찾기에 추가/빼기 · 앞으로/뒤로(즐겨찾기 줄에서) · 앱 끄기 · 앱 관리….
- 마지막으로 연 앱을 기억합니다.

| 앱 | 하는 일 |
|---|---|
| 파일 | 포커스된 패인의 폴더 트리(Material Icon Theme 아이콘, git 상태 색, 우클릭 메뉴). 숨김 파일·gitignore 항목 보이기와 경로 복사는 툴바 `⋯` 메뉴에 있습니다. 파일을 누르면 오른쪽에 형식별 뷰어: 코드·텍스트, GitHub 스타일 마크다운, 이미지, PDF, CSV·엑셀, 파워포인트, 워드, 압축 파일 목록, 오디오·동영상 등. |
| 브랜치 | 로컬·원격·태그 목록과 고른 브랜치의 추적 상태, 받을 커밋, 최근 커밋. 체크아웃·만들기·이름 변경·삭제는 바로, 끌어오기·푸시·병합·리베이스는 새 터미널 탭에서 실행합니다. |
| 커밋 | 현재 브랜치의 커밋 기록(200개씩)과 "커밋 안 된 변경". 고른 커밋의 본문·작성자·해시, 바뀐 파일, 파일별 diff. git은 읽기만 합니다. |
| PR | `gh`로 PR 목록(열림·내 PR·리뷰 요청·닫힘)과 상세(본문, 체크, 리뷰·코멘트, 바뀐 파일). 머지·닫기·체크아웃은 확인 창을 거칩니다(구현됨). |
| 에이전트 | 에이전트와 서브에이전트 목록. 고른 에이전트의 이번 턴(요청, 마지막 말, 도구 흐름, 고친·읽은 파일)을 Claude Code 대화 기록에서 읽습니다. 터미널로 이동, 엿보기. |
| 배포 | GitHub Actions 실행 목록·잡 단계 진행·실패 로그·배포 환경, 다시 실행·취소·끝나면 알림·에이전트에게 실패 알리기 |
| 워크트리 | git 워크트리 목록·변경, 새 워크트리 만들기와 그 폴더에서 Claude 띄우기, 지우기, 이슈에서 시작 |
| 검토 | 에이전트 작업 폴더별 변경과 diff를 보고, 줄을 골라 그 에이전트에게 피드백 보내기 |
| 메모 | 작업 공간마다 메모와 할 일(레포 밖 Herdr 데이터 폴더에 저장), 에이전트에게 보내기·복사 |
| 알림함 | 여러 스페이스의 에이전트 중 답 필요·완료·상태 모름을 한 곳에 모아 보고 그 터미널로 간다(상태 모름 줄은 한 번 누르면 바로). 완료는 사무실처럼 다음 일을 시작할 때까지 남고, 지금 브랜치 CI가 실패하면 맨 위에 "CI 실패" 줄. |
| 세션 | 지금 폴더의 지난 Claude Code 세션(요청·마지막 말·고친 파일·아티팩트)을 보고 이어하기 |
| 작업 공간 | 스페이스·탭·칸을 트리로 보고 이동·이름 바꾸기·접어 두기·닫기, 닫아도 될 탭을 한 번에 정리. 정리 화면에서 쉬는 Claude Code를 재워 메모리를 비우고(대화는 기록에 남음), 잠든 탭에서 깨우기나 Enter로 같은 대화를 이어 감 |
| 출력 | 셸·개발 서버·테스트 터미널 출력의 오류 줄을 문맥과 함께 모아 보고, 그 터미널로 가거나 에이전트에게 보내기 |
| 포트 | 기기별 열린 포트와 띄운 터미널, 브라우저로 열기·터미널로 가기·종료 |
| 서버 | 이 컴퓨터와 `hc machine ls`의 머신 목록, 머신 정보, 그 머신의 스페이스·에이전트, 리소스(CPU·메모리·저장 공간·배터리·네트워크). 새 스페이스·새 터미널, 기기 추가(SSH 또는 명령, `hc machine add`), 제거(확인 창, `hc machine rm`). 기기 추가·제거는 구현됨. |
| 명령 | Herdr 명령과 앱 명령을 이름·설명·단축키로 찾아 실행(최근 10개, 위험 명령은 확인 창) |
| 설정 | 들어가지 않고 Herdr 설정 창(`app.settings`)을 엽니다. |
| 앱 관리 | 앱마다 켜고 끄는 대화 상자를 띄웁니다. 이 앱은 끌 수 없습니다(항상 켜짐). |

### LLM 사용량 (아래 오른쪽)

- 프로바이더마다 5시간·주간 사용률 막대와 초기화까지 남은 시간. 70% 노랑, 90% 주황, 100% 빨강.
- Antigravity처럼 모델이 많으면 사용률이 같은 모델을 한 줄로 묶고, 긴 이름은 흘려 보여 줍니다.
- 프로바이더 접기, `⠿`로 끌어서 순서 바꾸기, 사용률 높은 순 정렬, 자동 갱신 주기(1·5·15·30분), 웹 사용량 페이지 열기.

### 리소스 관리자 (사용량 옆 탭)

- 오른쪽 칸 위의 탭 줄에서 "사용량"과 "리소스"를 오갑니다.
- 리소스 탭 맨 위에 터미널들이 쓰는 메모리 합과, 이 Mac 메모리 중 몇 %인지 보여 줍니다.
- 그 아래는 스페이스별 묶음입니다. 스페이스 머리줄(이름 · 메모리 합, 누르면 접힘) 아래에 터미널을 메모리 큰 순으로 보여 줍니다. 줄마다 프로그램 이름(Claude Code, Codex, 셸 등)과 메모리, CPU는 1% 이상일 때만 씁니다. 스페이스마다 위 3개 밖은 "나머지 N개" 한 줄로 접힙니다. 줄을 누르면 그 터미널로 이동합니다.
- 칸이 220px보다 낮으면 메모리 한 줄로 줄고, 누르면 같은 목록을 팝업으로 띄웁니다.

## 설치

```sh
./install.sh                                # office/layouts, office/mods/*를 ~/.config/herdr-app 으로 복사
herdr-app do layout.switch --name office    # 또는 Herdr 설정에서 office 선택
```

- `install.sh`는 `rsync --checksum`으로 내용이 바뀐 파일만 씁니다(바뀐 파일 목록을 출력). Herdr는 모드 폴더의 파일이 저장될 때마다 그 모드를 다시 불러오므로, 바뀌지 않은 파일은 다시 쓰지 않습니다. `gpui-kit.d.ts`, `jsconfig.json`은 복사하지 않습니다.
- `HERDR_APP_HOME`을 주면 그 폴더에 설치합니다.
- `office/mods/` 아래 폴더를 모두 복사합니다.
- 예전 버전을 설치했다면 설치본에 `mods/office-files`, `mods/office-git`이 남아 있을 수 있습니다. 지금 레이아웃은 이 둘을 쓰지 않습니다. `install.sh`는 이 폴더들을 지우지 않습니다.
- `ctrl-shift-l`(`layout.switch`)로 다른 레이아웃으로 바꿉니다. 지우려면 `layouts/office.json`과 `mods/office*` 폴더를 삭제합니다.

### 필요한 것

- 글꼴
  - 터미널: [D2Coding](https://github.com/naver/d2codingfont). 설치되어 있지 않으면 JetBrains Mono로 보입니다.
  - 패널: [Pretendard GOV](https://github.com/orioncactus/pretendard). `office/mods/office/fonts/`에 들어 있어(OFL) 따로 설치하지 않아도 됩니다.
  - 파일 앱의 코드·마크다운 뷰어: D2Coding.
- 사용량 패널은 Claude Code, Codex, Antigravity(`agy`), Grok CLI 중 설치되어 로그인된 것만 보여 줍니다.
- PR 앱은 `gh`가 필요합니다.
- 파일 앱의 엑셀·파워포인트 뷰어는 `python3`(표준 라이브러리만), PDF 뷰어는 Swift(PDFKit, 처음 쓸 때 `xcrun swiftc`로 컴파일), 나머지 뷰어는 macOS 기본 도구(`sips`, `qlmanage`, `textutil` 등)를 씁니다.

### 이 레이아웃이 하는 일 (설치 전에 확인하세요)

Herdr 모드는 신뢰받는 코드라 네트워크와 프로그램 실행에 제한이 없습니다. 이 레이아웃은 다음을 합니다.

| 모드 | 네트워크 | 실행하는 프로그램 | 모드 폴더 밖 파일 |
|---|---|---|---|
| `office` | 없음 | `git`(레포 이름, 브랜치 상태), `sh`, `head`(아티팩트 제목), `open`(아티팩트 링크를 기본 브라우저로) | `~/.claude/projects/`의 대화 기록 읽기(오버뷰 활동), 방 명패 SVG를 `data/office-plates/`에 쓰기 |
| `office-apps` | `git fetch/pull/push`(브랜치 앱, 누를 때만), `gh`(PR 앱), `curl`(마크다운의 원격 그림), `hc`(서버 앱, 원격 머신 연결), `gh run`(배포 앱) | 주요 프로그램: `git`, `gh`, `hc`(`hc read`·`hc send`: 출력·검토·메모·배포 앱), `lsof`·`ps`·`kill`(포트 앱, 종료는 확인 창), `claude`(워크트리·세션·작업 공간 앱에서 띄우거나 이어하기), `open`, `pbcopy`, `python3`, `swift`/`xcrun`, `curl`, `sips`, `qlmanage`, `textutil`, `mdls`, `unzip`, `tar`, `ditto`, `xxd`, `trash`(없으면 `osascript`로 Finder), 에디터 CLI, 우클릭으로 고른 명령. 그 밖에 `sh` 스크립트 안의 기본 도구(`cp`, `mv`, `rm`, `stat`, `find`, `chmod`, 서버 리소스용 `iostat`·`vm_stat`·`sysctl`·`netstat`·`route`·`diskutil`·`df`·`pmset`·`ioreg`·`networksetup`·`ipconfig`, Linux 머신은 `/proc`·`/sys` 읽기와 `ip`) | 현재 레포 읽기와 고른 동작에 따른 변경(파일 만들기·이름 변경·복제·휴지통 이동·압축, `.gitignore`·`.env.example` 쓰기, `git add/restore`, 체크아웃·브랜치 만들기·삭제·stash, PR 머지·닫기·체크아웃), `~/.claude/`의 대화 기록·세션 읽기(에이전트·세션 앱), `git worktree add/remove`(워크트리 앱), 메모 `data/office-apps/notes/`와 재운 에이전트 기록 `data/office-apps/sleeping.json` 쓰기, 미리보기 캐시 `data/office-apps/preview/`와 PDF 렌더러 `data/office-apps/bin/` 쓰기 |
| `office-usage` | `api.anthropic.com`, `chatgpt.com`, `cli-chat-proxy.grok.com`, `auth.x.ai` | `security`(키체인), `agy`, `pgrep`, `python3` | `~/.codex/auth.json`, `~/.grok/auth.json` 읽기, **Grok 토큰이 만료되면 `~/.grok/auth.json`에 새 토큰을 씀** |
| `office-resources` | 없음 | `hc get`(터미널 pid), `sh`·`ps`·`sysctl`·`vm_stat`(3초마다, 다른 기기는 `exec on`) | 없음 |

- 사용량 조회는 각 CLI가 로그인해 둔 계정의 토큰을 요청 헤더에만 씁니다. 토큰을 저장하거나 출력하지 않습니다.
- 사용량 API는 공개 API가 아니라 각 CLI와 Orca가 쓰는 내부 엔드포인트입니다. 바뀌면 그 칸에 오류가 뜹니다.
- Grok 토큰 갱신은 Grok CLI가 꺼져 있을 때만, Grok과 같은 잠금 파일(`auth.json.lock`)을 잡고 합니다. 드물게 Grok 로그인이 풀리면 `grok login`으로 복구됩니다.

## 확인

```sh
herdr-app check office/mods/<모드>    # 모드를 한 번 불러와 오류 확인. 수정할 때마다
herdr-app shot [file.png]             # 마지막으로 그린 창을 PNG로 저장
herdr-app status                      # 화면 상태와 파일·모드 오류(errors)
```

클릭 없이 앱을 시험하는 명령:

```sh
herdr-app do office-apps.home                  # 런처로
herdr-app do office-apps.open-<앱 id>          # 앱 열기 (files, branch, commit, pr, actions, worktrees, review, notes,
                                               #   agent, inbox, sessions, workspace, watch, ports, server, palette, settings, manage)
herdr-app do 'office-apps.show:<경로>'          # 파일 앱에서 그 파일 열기 (프로젝트 기준 상대 경로)
herdr-app do office-apps.manage                # 앱 관리 대화 상자
herdr-app do office-apps.disable-<앱 id>       # 앱 끄기 (다시 켜기는 앱 관리에서, manage는 끌 수 없음)
herdr-app do 'office-apps.commit:<해시>'        # 커밋 앱에서 그 커밋 열기 (WORKTREE면 커밋 안 된 변경)
herdr-app do 'office-apps.range:<a>...<b>'      # 커밋 앱에서 두 지점 사이 비교
herdr-app do 'office-apps.agent:<터미널 주소>'   # 에이전트 앱에서 그 에이전트 고르기
herdr-app do 'office-apps.favorite:<앱 id>'     # 런처 즐겨찾기에 더하기/빼기
```

### 주의

- 모드를 짧은 시간에 여러 번 다시 불러오면 Herdr의 JS 런타임이 메모리 부족이 될 수 있습니다. `herdr-app status`의 errors에 `out of memory`가 보이면 Herdr를 재시작하세요.
- 재설치 뒤에는 `herdr-app status`의 errors를 확인합니다.

## 개발

```sh
python3 tools/build-icons.py <material-icon-theme 패키지 폴더>   # 파일 아이콘 다시 만들기
blender -b --factory-startup --python tools/render-office.py -- <에셋 폴더> office/mods/office/sprites   # 사무실 스프라이트 다시 렌더
```

자세한 내용은 [office/RECIPE.md](office/RECIPE.md)를 보세요.

## 라이선스

<!-- TODO: 라이선스 결정 -->
파일 아이콘은 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)(MIT, `office/mods/office-apps/LICENSE-material-icon-theme`), Claude·OpenAI 로고는 [Simple Icons](https://simpleicons.org)(CC0, `office/mods/office/icons/NOTICE.md`)에서 가져왔습니다. Pretendard GOV는 OFL(`office/mods/office/fonts/LICENSE-PretendardGOV.txt`)입니다.
