// 명령 앱의 한국어 표: Herdr 명령 이름 → 한 줄 설명, 자주 쓰는 인자 이름 → 짧은 풀이.
//   `herdr-app commands`의 about(영어)을 옮긴 것. 표에 없는 명령(나중에 Herdr가 더한 것)은 영어 about을 그대로 쓴다.
//   herdr를 import하지 않는다(node로 표가 명령 목록을 다 덮는지 시험한다).
export const KO = {
  // 스페이스
  "space.new": "새 스페이스 만들기(이름·폴더·첫 탭·에이전트·기기)",
  "space.close": "스페이스 닫기(터미널도 끝냄)",
  "space.rename": "스페이스 이름 바꾸기",
  "space.move": "스페이스 순서 옮기기(1 = 맨 앞)",
  "space.select": "스페이스 보기(순서나 id로)",
  "space.next": "다음 스페이스 보기",
  "space.prev": "이전 스페이스 보기",
  // 탭
  "tab.new": "새 탭 만들기(터미널·에이전트, 또는 모드 하나)",
  "tab.close": "탭 닫기(터미널도 끝냄)",
  "tab.rename": "탭 이름 바꾸기",
  "tab.move": "탭 순서 옮기기(1 = 맨 앞)",
  "tab.select": "탭 보기(순서나 id로)",
  "tab.settle": "탭 재우기(목록에서 빼고 계속 실행)",
  "tab.unsettle": "재운 탭을 목록으로 되돌리기",
  "tab.next": "다음 탭 보기",
  "tab.prev": "이전 탭 보기",
  // 패인
  "pane.split": "패인 나누기(오른쪽·아래에 새 터미널이나 모드)",
  "pane.close": "패인 닫기(터미널도 끝냄)",
  "pane.zoom": "이 패인만 크게 보기, 다시 누르면 전부",
  "pane.focus": "패인으로 포커스 옮기기",
  "pane.go": "옆 패인으로 포커스 옮기기(왼쪽·오른쪽·위·아래)",
  "pane.swap": "패인 자리 바꾸기(방향이나 대상 패인과)",
  // 터미널
  "terminal.open": "터미널 열기(새 탭, 또는 오른쪽·아래)",
  "terminal.keep": "패인 없는 터미널(서브 에이전트)에 패인 주기",
  "terminal.park": "터미널을 패인에서 빼기(계속 실행)",
  "terminal.right_click": "터미널 오른쪽 클릭을 프로그램 또는 Herdr 메뉴로",
  "terminal.pin": "에이전트를 목록 맨 위에 고정하거나 풀기",
  "terminal.kill": "터미널 끝내기(서브 에이전트도)",
  "terminal.peek": "실행 중인 터미널을 탭 위에 띄워 엿보기",
  "terminal.show": "터미널을 이 패인에 잠깐 보이기(없으면 되돌리기)",
  "terminal.copy": "터미널에서 고른 글 복사",
  "terminal.scroll": "터미널 기록 스크롤(줄·쪽 수, 맨 위·맨 아래로)",
  "terminal.paste": "터미널에 붙여넣기",
  "terminal.paste_image": "클립보드 이미지를 파일로 터미널에 붙여넣기(Ctrl+V)",
  "terminal.search": "터미널 화면과 기록에서 찾기",
  // 에이전트
  "agent.focus": "에이전트 보기(서브 에이전트도)",
  "agent.next": "다음 에이전트 보기(에이전트 목록 순서)",
  "agent.prev": "이전 에이전트 보기",
  // 레이아웃·모드
  "layout.switch": "레이아웃 바꾸기(이름, 없으면 다음 것)",
  "layout.clone": "레이아웃 복제하고 보기",
  "mod.clone": "모드 복제",
  "layout.set": "개인 레이아웃 트리 통째로 바꾸기",
  "layout.toggle": "레이아웃 칸 숨기기·보이기 전환",
  "layout.show": "레이아웃 칸 보이기",
  "layout.hide": "레이아웃 칸 숨기기",
  "layout.resize": "레이아웃 칸 크기 정하기(px·비율)",
  "layout.select": "스택에서 한 칸 골라 보기",
  "layout.reset": "기본 레이아웃 되돌리기(옛 파일은 따로 둠)",
  "mod.open": "모드를 오버레이로 열기, 다시 부르면 닫기",
  "overlay.close": "오버레이 닫기(기본: 맨 위 창)",
  // 앱
  "app.help": "단축키 창 열기·닫기",
  "app.welcome": "환영 화면 다시 보기",
  "app.whats_new": "이번 버전에서 바뀐 것 보기",
  "app.feedback": "피드백 초안 쓰기(보내기 전에 검토)",
  "app.palette": "명령 팔레트 열기·닫기",
  "app.settings": "설정 열기(모양·알림·업데이트)",
  "app.check_updates": "새 Herdr 버전 지금 확인",
  "app.update_core": "herdr-core 업데이트(터미널은 계속 실행)",
  "app.reset": "비상 탈출: 레이아웃·키를 치우고 기본 화면으로",
  "app.theme": "테마 바꾸기",
  "app.zoom_in": "화면 크게",
  "app.zoom_out": "화면 작게",
  "app.zoom_reset": "화면 크기 원래대로",
  "app.update": "받아 둔 업데이트로 다시 시작(터미널은 계속 실행)",
  "app.quit": "Herdr 끝내기(macOS)",
  "app.hide": "Herdr 가리기(macOS)",
  "app.hide_others": "다른 앱 가리기(macOS)",
  "app.show_all": "모든 앱 보이기(macOS)",
  // 창
  "window.close": "창 닫기(Linux에서는 끝내기)",
  "window.minimize": "창 최소화",
  "window.maximize": "창 최대화, 다시 누르면 원래대로",
};

// 자주 쓰는 인자: 입력 칸 위 라벨에 이름 옆 괄호로 붙인다. 인자 이름 자체는 바꾸지 않는다(명령에 그대로 보낸다).
export const ARG_KO = {
  name: "이름",
  folder: "폴더",
  id: "대상 식별자",
  index: "순서, 1부터",
  direction: "방향: right·down 등",
  machine: "기기, 빈칸은 이 Mac",
  task: "첫 메시지",
  argv: "실행할 명령, 예: [\"claude\"]",
};

export const koOf = (name) => KO[name] ?? "";
export const argLabel = (arg) => (ARG_KO[arg] ? `${arg} (${ARG_KO[arg]})` : arg);
