// office 아래 칸: 앱 런처. 기본 화면은 Spotlight처럼 검색창 + 앱 아이콘 격자, 앱을 누르면 들어간다.
//   런처 키: 검색창에서 ↑↓ = 칸 고르기(selected 바탕), Enter = 고른 칸 열기 후 왼쪽 칸에 포커스. 앱 화면에서 Esc = 격자로.
//   앱 화면: 위 막대(‹ 앱 · 아이콘 · 이름 · 부제) / 왼쪽 좁은 칸(툴바 + 관리 목록) / 오른쪽 넓은 칸(고른 항목, 없으면 "선택 내용이 없습니다")
//   앱 관리: 격자의 "앱 관리" 앱(manage)을 누르면 대화 상자(오버레이 역할 manage)로 뜬다. 앱마다 켜고 끄기.
//   끈 앱은 격자에서 숨기고 화면용 인스턴스를 만들지 않는다. 켜고 끄기는 공유 상태 office-apps.disabled로만 오가고,
//   런처는 렌더 때 이전 값과 비교해 새로 꺼진 앱을 dispose()로 멈추고(타이머·폴더 감시) 인스턴스를 버린다.
//   앱 관리 앱은 끌 수 없다(끄면 다시 켤 길이 없다): 스위치 대신 "항상 켜짐", 우클릭 메뉴에 "앱 끄기" 없음, disable-manage 무시.
// 앱 계약: init(props, cx) · list(cx, t) · detail?(cx, t) · subtitle?(t) · dispose?() — dispose는 선택, 끌 때 한 번 부른다.
//   move?(d, cx) — 왼쪽 칸에서 ↑(-1)/↓(+1). activate?(cx) — 왼쪽 칸에서 Enter.
//   emptyState?() → { text, sub } — detail이 null일 때 오른쪽 빈 화면 문구(없으면 기본 문구).
//   커밋 앱만: openCommit?(해시|"WORKTREE", cx) · openRange?(a, b, cx) — commit:/range: 명령이 부른다.
// 런처 격자는 APPS의 group으로 줄을 나눈다: "apps"(들어가는 앱) · "system"(설정·앱 관리처럼 창을 띄우는 것).
// 오버레이 역할(props.role): menu·prompt·confirm·tip — 파일 앱의 우클릭 메뉴와 입력·확인 창, 툴팁.
//   manage — 앱 관리 대화 상자(앱마다 켜고 끄기).
//   launcherMenu — 런처 격자의 앱 아이콘 우클릭 메뉴(열기 · 앱 끄기 · 앱 관리…, 앱 관리 앱은 열기만).
//   viewer — 떠 있는 파일 뷰어 창(kind "window", props { file: 절대 경로, on? }). 에이전트 활동의 파일 줄이 연다(files.js openViewer).
// 키·명령: office-apps.home(런처로), office-apps.open-<앱 id>(앱 열기), office-apps.show:<경로>(파일 열기),
//   office-apps.manage(앱 관리 대화 상자), office-apps.disable-<앱 id>(앱 끄기),
//   office-apps.commit:<해시|WORKTREE>(커밋 앱에서 그 커밋 열기), office-apps.range:<a>...<b>(커밋 앱에서 범위 비교),
//   office-apps.agent:<터미널 주소>(에이전트 앱에서 그 에이전트 줄 고르기, 사무실 오른쪽 패널의 "자세히 →"가 보낸다),
//   office-apps.files-toggle-hidden · files-toggle-ignored(파일 앱 ⋯ 메뉴가 보낸다: 숨김 파일 · gitignore 항목 보이기 전환)

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, theme, shared, setShared, nextCommand, run, openOverlay, closeOverlay, notify } from "herdr";
import { FilesApp, ROLES, ViewerWindow } from "./files.js";
import { popupAt } from "./menu.js";
import { BranchApp } from "./branch.js";
import { CommitApp } from "./commit.js";
import { PrApp } from "./pr.js";
import { AgentApp } from "./agent.js";
import { ServerApp } from "./server.js";

const ME = "mods/office-apps";
const DISABLED = "office-apps.disabled";   // { 앱 id: true } — 끈 앱
// 앱 목록. make가 없는 앱은 아직 준비 중(격자에는 보이되 들어가면 안내만). action이 있는 앱은 들어가지 않고 그 동작만 한다.
//   locked 앱은 끌 수 없다. group은 격자·앱 관리에서 나누는 줄(GROUPS 순서): 동작 방식이 아니라 여기 적은 값으로만 나눈다.
const APPS = [
  { id: "files", group: "apps", name: "파일", desc: "파일트리와 뷰어(코드·마크다운·이미지)", color: "#3d7de5", make: () => new FilesApp() },
  { id: "branch", group: "apps", name: "브랜치", desc: "로컬·원격 브랜치 관리", color: "#2f9e6f", make: () => new BranchApp() },
  { id: "commit", group: "apps", name: "커밋", desc: "커밋 기록과 변경 내용", color: "#e07b39", make: () => new CommitApp() },
  { id: "pr", group: "apps", name: "PR", desc: "풀 리퀘스트 목록과 리뷰", color: "#8b5cf6", make: () => new PrApp() },
  { id: "agent", group: "apps", name: "에이전트", desc: "에이전트와 서브에이전트가 하는 일", color: "#d97757", make: () => new AgentApp() },
  { id: "server", group: "apps", name: "서버", desc: "Herdr에 등록한 머신(서버) 관리", color: "#4f8fa8", make: () => new ServerApp() },
  { id: "settings", group: "system", name: "설정", desc: "Herdr 설정 창 열기", color: "#6b7280", action: () => run("app.settings") },
  { id: "manage", group: "system", name: "앱 관리", desc: "앱 켜고 끄기", color: "#475569", locked: true, action: () => openManage() },
];
// 격자·앱 관리의 줄 순서와 줄 제목
const GROUPS = [{ id: "apps", title: "앱" }, { id: "system", title: "설정" }];
// 줄 제목: 작은 흐린 글자, 장식 없이
const groupTitle = (title, t) => div().text_size(12).text_color(t.muted).child(title);
const isLocked = (id) => Boolean(APPS.find((a) => a.id === id)?.locked);

// 끈 앱 { id: true }. 공유 상태에 끌 수 없는 앱이 꺼져 있다고 적혀 있어도 빼고 돌려준다.
function disabled() {
  const d = shared(DISABLED) ?? {};
  if (!APPS.some((a) => a.locked && d[a.id])) return d;
  const out = { ...d };
  for (const a of APPS) if (a.locked) delete out[a.id];
  return out;
}

// 앱 켜고 끄기: 공유 상태만 바꾼다. 인스턴스 정리는 런처가 공유 상태 변화를 보고 한다(syncDisabled).
//   대화 상자(오버레이 복사본)와 런처의 disable- 명령이 함께 쓴다.
function setDisabled(id, off) {
  if (isLocked(id) || !APPS.some((a) => a.id === id)) return;   // 앱 관리 앱은 끄지 않는다
  const d = { ...disabled() };
  if (Boolean(d[id]) === off) return;
  if (off) d[id] = true; else delete d[id];
  setShared(DISABLED, d);
}

// 앱 관리 대화 상자 열기. 격자의 앱 관리 앱, office-apps.manage 명령(우클릭 메뉴 "앱 관리…")이 함께 쓴다.
const MANAGE_W = 420, MANAGE_H = 520;
function openManage() {
  openOverlay({ mod: "office-apps", kind: "dialog", width: MANAGE_W, height: MANAGE_H, props: { role: "manage" } });
}

class Launcher {
  init(_p, cx) {
    this.app = null;          // 들어가 있는 앱 id
    this.lh = cx.focus_handle();   // 앱 화면 왼쪽 칸의 키보드 포커스(↑↓ · Enter를 앱의 move/activate로)
    this.seen = disabled();   // 마지막으로 본 끈 앱 목록(새로 꺼진 앱을 찾는 기준)
    this.inst = {};           // 앱 id → 인스턴스(켜진 앱을 처음 열 때 만든다)
    this.query = "";
    this.sel = 0;             // 런처 격자에서 고른 칸(걸러진 목록의 순번). 검색어가 바뀌면 첫 칸으로
    this.search = InputState.new({ placeholder: "앱 검색" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); this.sel = 0; cx.notify(); });
    // Enter: 고른 칸(기본은 걸러진 첫 앱)을 열고, 들어갔으면 왼쪽 칸이 키보드를 받는다
    this.search.on("submit", (_e, cx) => {
      const list = this.homeList(), a = list[Math.min(this.sel, list.length - 1)];
      if (!a) return;
      this.go(a.id, cx);
      if (this.app) this.lh?.focus();
      cx.notify();
    });
    try { this.go(JSON.parse(localStorage.getItem("app") ?? "null"), cx); } catch { /* 런처부터 */ }
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "home") this.go(null, cx);
        // commit:<해시|WORKTREE>  커밋 앱에서 그 커밋(또는 작업 트리 변경)을 연다
        else if (c.startsWith("commit:")) this.toCommit(cx, (app) => app.openCommit?.(c.slice(7), cx));
        // range:<a>...<b>  커밋 앱에서 두 지점 사이를 비교한다(첫 "..."로 나눈다)
        else if (c.startsWith("range:")) {
          const s = c.slice(6), i = s.indexOf("...");
          if (i > 0 && i + 3 < s.length) this.toCommit(cx, (app) => app.openRange?.(s.slice(0, i), s.slice(i + 3), cx));
        }
        // 파일 앱 ⋯ 메뉴(오버레이 복사본)가 보내는 보기 전환
        else if (c === "files-toggle-hidden") this.inst.files?.toggleView?.("showHidden", cx);
        else if (c === "files-toggle-ignored") this.inst.files?.toggleView?.("hideIgnored", cx);
        else if (c.startsWith("open-")) this.go(c.slice(5), cx);
        // 런처 우클릭 메뉴(오버레이 복사본)가 보내는 명령
        else if (c === "manage") openManage();
        // 끌 수 없는 앱(앱 관리)은 setDisabled가 무시한다
        else if (c.startsWith("disable-")) setDisabled(c.slice(8), true);
        // agent:<터미널 주소>  에이전트 앱을 열고 그 줄을 고른다. 꺼져 있으면 열지 않고 알린다.
        else if (c.startsWith("agent:")) {
          if (this.disabled().agent) notify({ title: "에이전트 앱이 꺼져 있습니다", body: "앱 관리에서 켜면 열 수 있습니다", level: "info" });
          else { this.go("agent", cx); this.inst.agent?.reveal?.(c.slice(6), cx); }
        }
        // show:<경로>  파일 앱에서 그 파일을 연다(프로젝트 기준 상대 경로)
        else if (c.startsWith("show:")) { this.go("files", cx); this.inst.files?.show(c.slice(5), cx); }
        cx.notify();
      }
    });
  }

  disabled() { return disabled(); }

  // 커밋 앱을 열고 그 인스턴스에 일을 넘긴다. 꺼져 있으면 열지 않고 알린다.
  toCommit(cx, fn) {
    if (this.disabled().commit) {
      notify({ title: "커밋 앱이 꺼져 있습니다", body: "앱 관리에서 켜면 열 수 있습니다", level: "info" });
      return;
    }
    this.go("commit", cx);
    const app = this.inst.commit;
    if (app) fn(app);
  }

  // 공유 상태의 끈 앱 목록을 이전 값과 비교해, 새로 꺼진 앱을 정리한다. 렌더마다 부른다
  //   (setShared는 모든 모드를 다시 그리므로 대화 상자에서 끈 것도 여기로 온다).
  syncDisabled() {
    const d = disabled();
    if (d === this.seen) return;
    for (const id of Object.keys(d)) {
      if (this.seen[id]) continue;
      // 앱이 건 타이머·감시는 런처 쪽에 걸려 있어 인스턴스만 버리면 계속 돈다. 먼저 멈추게 한다.
      try { this.inst[id]?.dispose?.(); } catch { /* 정리 실패해도 끄기는 마친다 */ }
      delete this.inst[id];
      if (this.app === id) {
        this.app = null;
        try { localStorage.setItem("app", "null"); } catch { /* 이번 실행 동안만 */ }
      }
    }
    this.seen = d;
  }

  // 앱 열기. 앱 인스턴스는 여기(이벤트·명령 처리 시점)에서 만든다: 렌더 중에는 입력 상자 등을 만들 수 없다.
  go(id, cx) {
    const act = APPS.find((a) => a.id === id)?.action;
    if (act && !this.disabled()[id]) { act(); return; }
    this.app = id && !this.disabled()[id] ? id : null;
    const def = APPS.find((a) => a.id === this.app);
    if (def?.make && !this.inst[this.app]) { this.inst[this.app] = def.make(); this.inst[this.app].init({}, cx); }
    try { localStorage.setItem("app", JSON.stringify(this.app)); } catch { /* 이번 실행 동안만 */ }
  }

  // 켜진 앱만 열 때 만든다(go). 끈 앱은 만들지 않고, 끄면 있던 인스턴스도 정리(dispose)한 뒤 버린다.
  instance(id) {
    return this.disabled()[id] ? null : this.inst[id] ?? null;
  }

  render(cx) {
    const t = theme();
    this.syncDisabled();
    if (this.app && this.disabled()[this.app]) this.app = null;
    return v_flex().id("office-apps").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(this.app ? this.appView(this.app, cx, t) : this.home(t));
  }

  tile(a, size, t) {
    return tile(a, size);
  }

  // 앱 아이콘 우클릭 메뉴. 오버레이는 이 모드의 새 복사본이라 상태를 나누지 않으므로, 고른 동작은 명령으로 돌려받는다.
  openMenu(a) {
    const h = menuHeight(menuItems(a));
    openOverlay({ mod: "office-apps", kind: "popup", at: popupAt(MENU_W, h), width: MENU_W, height: h,
      props: { role: "launcherMenu", app: a.id } });
  }

  // 런처 격자에 보이는 앱: 끈 앱을 빼고 검색어(이름·설명·id)로 거른 뒤 줄(GROUPS) 순서로 편다.
  //   격자 그리기와 검색창 Enter·↑↓가 같은 목록·같은 순번을 쓴다.
  homeList() {
    const q = this.query, off = this.disabled();
    const list = APPS.filter((a) => !off[a.id] && (!q || a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q) || a.id.includes(q)));
    return GROUPS.flatMap((g) => list.filter((a) => a.group === g.id));
  }

  // 런처: 검색창 + 격자. 앱 이름·설명으로 거른다.
  //   검색창에서 ↑↓로 칸을 고르고(고른 칸은 selected 바탕) Enter로 연다(submit).
  home(t) {
    const q = this.query, list = this.homeList();
    // 끈 앱이 생기면 목록이 줄어드니 고른 칸을 목록 안으로 당긴다
    this.sel = Math.max(0, Math.min(this.sel ?? 0, list.length - 1));
    const sel = list[this.sel]?.id;
    // 그룹별 줄. 걸러서 빈 줄은 제목째 숨긴다
    const rows = GROUPS.map((g) => ({ ...g, apps: list.filter((a) => a.group === g.id) })).filter((g) => g.apps.length);
    const icon = (a) => v_flex().id(`app-${a.id}`).w(92).py(8).gap(8).items_center().rounded(10).cursor_pointer()
      .when(a.id === sel, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      // 격자에서 눌러 들어가면 왼쪽 칸이 키보드를 받는다(검색창에 있던 포커스를 옮김).
      //   go()에서는 하지 않는다: 시작할 때 복원·명령(show:·commit: 등)으로 열릴 때 터미널의 키보드를 뺏지 않게.
      .on_click((_e, cx) => { this.go(a.id, cx); if (this.app) this.lh?.focus(); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(a); })
      .child(this.tile(a, 56, t))
      .child(div().text_size(13).text_color(t.foreground).child(a.name));
    return v_flex().size_full().min_h(0)
      // 검색창의 ↑↓(입력 상자에서 올라온 키): 격자의 고른 칸을 앞뒤로 옮긴다. ←→는 입력 상자 커서에 둔다.
      .on_key_down((e, cx) => {
        const m = e.modifiers;
        if (m.shift || m.alt || m.control || m.platform || !list.length) return;
        if (e.key === "up") this.sel = (this.sel - 1 + list.length) % list.length;
        else if (e.key === "down") this.sel = (this.sel + 1) % list.length;
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(48).flex_none().px(16).gap(10).items_center().border_b_1().border_color(t.border)
        .child(svg(`${ME}/search.svg`).size(16).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.search).h(30).text_size(15).text_color(t.foreground))))
      .child(v_flex().id("apps-grid").flex_1().min_h(0).overflow_y_scrollbar().p(20).gap(18)
        .children(rows.map((g) => v_flex().gap(6)
          .child(div().px(4).child(groupTitle(g.title, t)))
          .child(h_flex().flex_wrap().gap(18).children(g.apps.map(icon)))))
        .when(list.length === 0, (el) => el.child(div().pt(8).text_color(t.muted).child(q ? "맞는 앱이 없습니다" : "켜진 앱이 없습니다"))));
  }

  back(t) {
    return h_flex().id("apps-back").px(6).py(3).gap(2).items_center().rounded(6).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.go(null, cx); cx.notify(); })
      .child(svg(`${ME}/apps/back.svg`).size(14).text_color(t.foreground)).child(div().text_size(13).child("앱"));
  }

  // 앱 화면: 위 막대 / 왼쪽 목록 / 오른쪽 내용
  appView(id, cx, t) {
    const a = APPS.find((x) => x.id === id), app = this.instance(id);
    const detail = app?.detail?.(cx, t) ?? null;
    // 빈 화면 문구: 앱이 emptyState()로 정하면 그것, 아니면 기본. 준비 중인 앱(인스턴스 없음)은 앱 설명
    const empty = (!detail && app?.emptyState?.()) || null;
    return v_flex().size_full().min_h(0)
      // Esc: 격자(홈)로 돌아가 검색창에 포커스. 안쪽에서 Esc를 쓰는 곳(입력 상자 지우기 등)이 먼저 멈추면 오지 않는다.
      .on_key_down((e, cx) => {
        const m = e.modifiers;
        if (e.key !== "escape" || m.shift || m.alt || m.control || m.platform) return;
        this.go(null, cx);
        this.search.focus();
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b_1().border_color(t.border)
        .child(this.back(t))
        .child(div().w(1).h(18).bg(t.border))
        .child(this.tile(a, 24, t))
        .child(div().flex_none().text_size(15).font_semibold().child(a.name))
        .child(div().flex_1().min_w(0).child(app?.subtitle?.(t) ?? div())))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        // 왼쪽: 관리 목록(좁게)
        //   포커스(this.lh)를 달아 ↑↓ → app.move(-1|+1), Enter → app.activate(). 이 칸을 누르면 GPUI가 포커스를 이 칸에 준다
        //   (안쪽 입력 상자를 누르면 입력 상자가 먼저 포커스를 가져가 이 칸은 뺏지 않는다). 키는 이 칸 자체가 포커스를
        //   가졌을 때만 받는다: 입력 상자에 포커스가 있으면 같은 키가 이리로 올라와도 그냥 둔다.
        //   (코드를 다시 불러와 init 없이 남은 인스턴스라 this.lh가 없으면 키 처리 없이 그린다)
        .child(v_flex().id("apps-left").when(Boolean(this.lh), (el) => el.track_focus(this.lh)).w(LEFT).h_full().flex_none().min_h(0).border_r_1().border_color(t.border)
          .on_key_down((e, cx) => {
            if (!app || !this.lh?.is_focused()) return;
            const m = e.modifiers;
            if (m.shift || m.alt || m.control || m.platform) return;
            if (e.key === "up" || e.key === "down") { if (!app.move) return; app.move(e.key === "up" ? -1 : 1, cx); }
            else if (e.key === "enter") { if (!app.activate) return; app.activate(cx); }
            else return;
            cx.stop_propagation(); cx.notify();
          })
          .child(app ? app.list(cx, t) : v_flex().p(16).gap(6).child(div().text_color(t.muted).child("준비 중인 앱입니다"))
            .child(div().text_size(12).text_color(t.dim).child(a.desc))))
        // 오른쪽: 고른 항목(강조: 더 넓고 밝은 바탕)
        .child(v_flex().flex_1().h_full().min_w(0).min_h(0).bg(t.background)
          .child(detail ?? v_flex().size_full().items_center().justify_center().gap(10)
            .child(this.tile(a, 40, t).opacity(0.5))
            .child(div().text_size(14).text_color(t.muted).child(empty?.text ?? "선택 내용이 없습니다"))
            .child(div().text_size(12).text_color(t.dim).child(app ? (empty ? empty.sub ?? "" : "왼쪽에서 항목을 고르세요") : a.desc)))));
  }
}

const LEFT = 250;   // 왼쪽 관리 칸 폭(가운데 내용 칸을 강조하려고 좁게)

// 앱 타일 그림: 브러시드 금속 사물 오브제 PNG(apps/tiles/<id>.png, 투명 배경, 256px).
//   한 장으로 생성한 8개 격자를 잘라 만들었다. 테마와 관계없이 같은 그림을 쓴다.
//   그림이 없는 앱(TILES에 없음)은 앱 색(APPS color) div 위에 이름 첫 글자를 흰색으로 그린다.
const TILES = new Set(["files", "branch", "commit", "pr", "agent", "server", "settings", "manage"]);
function tile(a, size) {
  if (TILES.has(a.id)) return image(`${ME}/apps/tiles/${a.id}.png`).size(size).flex_none();
  return div().size(size).flex_none().rounded(Math.round(size * 0.24)).bg(a.color).flex().items_center().justify_center()
    .text_size(Math.round(size * 0.42)).font_semibold().text_color("#ffffff").child(a.name.slice(0, 1));
}

// 런처 우클릭 메뉴의 치수: 파일 우클릭 메뉴(menu.js)와 같은 줄 높이·구분선·머리줄.
const ROW = 30, SEP = 9, HEAD = 34, MENU_W = 240;
const menuHeight = (items) => 12 + HEAD + items.reduce((h, it) => h + (it === "-" ? SEP : ROW), 0);

// 앱 아이콘 우클릭 메뉴 항목. 런처(창 높이)와 메뉴 오버레이(그리기)가 함께 쓴다.
//   앱 관리 앱은 끌 수 없고 "열기"가 곧 앱 관리라 "열기"만 둔다.
function menuItems(a) {
  if (!a) return [];
  const open = { label: "열기", icon: `${ME}/open.svg`, color: "#7aa2f7", hint: a.action ? a.desc.replace(/ 열기$/, "") : "", cmd: `open-${a.id}` };
  if (a.locked) return [open];
  return [
    open,
    { label: "앱 끄기", icon: `${ME}/eye-off.svg`, color: "#dbbc7f", hint: "앱 관리에서 다시 켬", cmd: `disable-${a.id}` },
    "-",
    { label: "앱 관리…", icon: `${ME}/apps/manage.svg`, color: "#7fbbb3", cmd: "manage" },
  ];
}

// 런처 우클릭 메뉴(props { app }). 파일 메뉴와 같은 모양으로 그린다.
//   ↑↓ 고르기 · Enter 실행 · Esc 닫기
class LauncherMenu {
  init(_p, cx) {
    this.at = -1;
    this.h = cx.focus_handle();
    this.h.focus();
  }

  items() {
    return menuItems(APPS.find((x) => x.id === props().app));
  }

  enter(it) {
    closeOverlay(props().overlay);
    run(`office-apps.${it.cmd}`);
  }

  render() {
    const t = theme(), p = props(), a = APPS.find((x) => x.id === p.app), list = this.items();
    const usable = list.map((it, i) => (it === "-" ? -1 : i)).filter((i) => i >= 0);
    return v_flex().id("launcher-menu").track_focus(this.h).size_full().p(6).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = usable.indexOf(this.at);
        if (e.key === "escape") closeOverlay(p.overlay);
        else if (e.key === "down") this.at = usable[(k + 1) % usable.length];
        else if (e.key === "up") this.at = usable[(k - 1 + usable.length) % usable.length];
        else if (e.key === "enter" && this.at >= 0) return this.enter(list[this.at]);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      // 머리줄: 우클릭한 앱(아이콘, 이름)
      .when(Boolean(a), (el) => el.child(h_flex().h(HEAD - 6).mb(4).px(6).gap(8).items_center().border_b_1().border_color(t.border)
        .child(tile(a, 16))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(a.name))))
      .children(list.map((it, i) => it === "-"
        ? div().h(1).my(4).mx(6).bg(t.border)
        : h_flex().id(`lm-${i}`).h(ROW).px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .when(this.at === i, (el) => el.bg(t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.enter(it))
          .child(svg(it.icon).size(15).flex_none().text_color(it.color))
          .child(div().flex_none().text_color(t.foreground).child(it.label))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(it.hint ?? ""))));
  }
}

// 앱 관리 대화 상자(props.role "manage"). 파일 앱의 확인 창(menu.js Confirm)과 같은 모양.
//   오버레이 복사본이라 런처와 상태를 나누지 않는다: 스위치는 공유 상태를 바로 바꾸고, 런처가 그 변화를 보고 정리한다.
//   Esc · ✕로 닫는다.
class ManageDialog {
  init(_p, cx) {
    this.h = cx.focus_handle();
    this.h.focus();
  }

  render() {
    const t = theme(), p = props(), off = disabled();
    return v_flex().id("apps-manage").track_focus(this.h).size_full().min_h(0).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      // 머리줄: 제목 + 닫기
      .child(h_flex().flex_none().pl(18).pr(10).pt(14).pb(6).gap(8).items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("앱 관리"))
        .child(div().id("apps-manage-close").p(5).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => closeOverlay(p.overlay))
          .child(svg(`${ME}/close.svg`).size(14).text_color(t.muted))))
      .child(div().flex_none().px(18).pb(8).text_size(12).text_color(t.muted).child("끈 앱은 런처에서 숨기고, 열려 있던 화면과 타이머(git·네트워크 요청)도 멈춥니다."))
      // 격자와 같은 줄 순서·제목으로 나눈다
      .child(v_flex().id("apps-manage-list").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(12).gap(2)
        .children(GROUPS.flatMap((g) => [div().px(6).pt(8).pb(2).child(groupTitle(g.title, t)), ...APPS.filter((a) => a.group === g.id).map((a) => {
          const on = !off[a.id];
          // 끌 수 없는 앱은 누를 수 없고, 스위치 대신 흐린 "항상 켜짐"
          return h_flex().id(`apps-tg-${a.id}`).py(8).px(6).gap(12).items_center().rounded(8)
            .when(!a.locked, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => setDisabled(a.id, on)))
            .child(tile(a, 32))
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(13).font_semibold().text_color(on ? t.foreground : t.muted).child(a.name))
              .child(div().truncate().text_size(12).text_color(t.muted).child(a.desc + (a.make || a.action ? "" : " · 준비 중"))))
            // 스위치(끌 수 없는 앱은 안내 글자)
            .child(a.locked
              ? div().flex_none().text_size(12).text_color(t.dim).child("항상 켜짐")
              : div().w(36).h(20).flex_none().rounded(10).bg(on ? t.accent : t.border).p(2).flex().when(on, (el) => el.justify_end())
                .child(div().size(16).rounded_full().bg("#ffffff")));
        })])));
  }
}

const ALL_ROLES = { ...ROLES, launcherMenu: LauncherMenu, manage: ManageDialog, viewer: ViewerWindow };

export default class OfficeApps extends View {
  init(p, cx) {
    const R = ALL_ROLES[(props() ?? p ?? {}).role] ?? Launcher;
    this.role = new R();
    this.role.init(p, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }
}
