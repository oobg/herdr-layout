// office-apps의 작업 공간 앱: 스페이스·탭·칸을 한눈에 보고 정리한다.
//   왼쪽: 맨 위 "정리" 한 줄, 그 아래 스페이스 › 탭 트리(탭은 들여쓴다). 스페이스는 화살표를 눌러 접는다(localStorage).
//         스페이스 줄 = 이름 · 기기(원격일 때) · 탭 수, 보이는 스페이스는 "지금". 탭 줄 = 이름 · 칸 수 · 상태 낱말
//         (답 필요·작업 중·완료, 접어 둔 탭은 흐린 "접어 둠").
//   오른쪽: 스페이스 = 폴더·브랜치·기기, 탭 요약, 가기·이름 바꾸기·닫기.
//           탭 = 칸 목록(누르면 그 칸으로), 가기·이름 바꾸기·접어 두기/펼치기·닫기.
//           정리 = 닫아도 될 만한 탭(workspace/tidy.js candidates)을 이유와 함께, 체크한 것만 한 번에 닫는다.
// 셸 계약: move(delta, cx) 선택 이동 · activate(cx) 고른 스페이스·탭으로 가기 · emptyState().
// 데이터는 spaces()·panes()·agents()(모두 살아 있는 값, 바뀌면 다시 그려진다)라 타이머가 없다.
// 확인 창·이름 입력 창은 오버레이 복사본이라 값만 넘기고, 동작은 ACTIONS["workspace.*"]·ROLES["workspace-prompt"]에 둔다.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, focused, layout, home, run, setShared, openOverlay, closeOverlay, props, theme } from "herdr";
import { ACTIONS } from "./menu.js";
import { ROLES } from "./files.js";
import { viewedTabs, panesOf, hasWorking, tabWord, candidates, stillClosable, treeRows, agentCount, tilde, WORD } from "./workspace/tidy.js";

const APPS = "mods/office-apps";
const BRAND = [[/claude/i, `${APPS}/agent/icons/claude.svg`, "#d97757"], [/codex|openai/i, `${APPS}/agent/icons/openai.svg`, null]];

function load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 */ } }
const viewed = () => viewedTabs(spaces(), focused()?.tab ?? null);
const where = (p, machine) => tilde(p, machine ? null : home());

// ── 가기 ─────────────────────────────────────────────────
// office 레이아웃이면 터미널 칸을 열고 office 모드에 스페이스를 알린다(agent.js goTo와 같게).
function reveal(space) {
  if (space && JSON.stringify(layout() ?? {}).includes('"office-term"')) {
    run("layout.show", { id: "office-term" });
    setShared("office.open", space);
  }
}
function goSpace(space) { run("space.select", { id: space }); reveal(space); }
function goTab(space, tab) { run("space.select", { id: space }); run("tab.select", { id: tab }); reveal(space); }
function goPane(space, tab, pane) { goTab(space, tab); run("pane.focus", { pane }); }

// ── 확인 창·입력 창 동작(값만 받는다) ──────────────────────
const ACT = {
  // ctx: { kind: "space"|"tab", id }
  rename: (ctx, name) => run(ctx.kind === "space" ? "space.rename" : "tab.rename", { id: ctx.id, name }),
  closeSpace: (ctx) => run("space.close", { id: ctx.id, confirmed: true }),
  closeTab: (ctx) => run("tab.close", { id: ctx.id, confirmed: true }),
  // ctx: { ids }. 창을 연 뒤 보게 됐거나 작업을 시작한 탭은 건너뛴다.
  closeTabs: (ctx) => {
    for (const id of stillClosable(ctx.ids, spaces(), panes() ?? [], viewed())) run("tab.close", { id, confirmed: true });
  },
};

function confirm(action, ctx, title, detail, opts = {}) {
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: opts.tall ? 260 : 210,
    props: { role: "confirm", action: `workspace.${action}`, ctx, title, detail, yes: opts.yes, danger: Boolean(opts.danger) } });
}

function ask(kind, id, title, value) {
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 210,
    props: { role: "workspace-prompt", ctx: { kind, id }, title, value,
      hint: kind === "space" ? "비우면 첫 터미널이 있는 곳 이름으로 돌아갑니다" : "비우면 번호로 돌아갑니다" } });
}

// 이름 입력 창: 지금 이름을 채워 두고 전부 골라 둔다. 비운 이름도 보낸다(자동 이름으로 되돌리기). 그대로면 닫기만.
class WorkspacePrompt {
  init(_p, cx) {
    const v = props()?.value ?? "";
    this.text = v;
    this.input = InputState.new({ value: v });
    if (v) this.input.set_selected_range({ start: 0, end: v.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  submit() {
    const p = props(), name = this.text.trim();
    closeOverlay(p.overlay);
    if (name !== (p.value ?? "")) ACT.rename(p.ctx, name);
  }

  render() {
    const t = theme(), p = props();
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).cursor_pointer().text_size(12.5)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("ws-prompt").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(p.title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(12).text_color(t.dim).child(p.hint ?? ""))
      .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(13))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button("ws-p-no", "취소", false, () => closeOverlay(p.overlay)))
        .child(button("ws-p-yes", "바꾸기", true, () => this.submit())));
  }
}

// 확인 창(menu.js Confirm)과 오버레이 역할 표(files.js ROLES)에 더한다. main.js가 ROLES를 펼쳐 복사하기 전에 들어가야 하므로 최상위에서.
function register() {
  for (const [k, f] of Object.entries(ACT)) ACTIONS[`workspace.${k}`] = f;
  ROLES["workspace-prompt"] = WorkspacePrompt;
}
register();

// 프로그램 아이콘(agent.js와 같은 규칙: Claude·Codex는 브랜드 로고)
function programIcon(p, size, t) {
  const b = BRAND.find(([re]) => re.test(`${p?.key ?? ""} ${p?.name ?? ""}`));
  if (b) return svg(b[1]).size(size).flex_none().text_color(b[2] ?? t.foreground);
  if (p?.icon) return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color || t.foreground) : image(p.icon).size(size).flex_none();
  return div().w(size).flex_none().text_size(size - 3).text_color(t.muted).child((p?.name || "·").slice(0, 1));
}

const word = (tab, t) => {
  const w = tabWord(tab);
  return w && div().flex_none().text_size(11).text_color(t[w[1]] ?? t.dim).child(w[0]);
};

export class WorkspaceApp {
  init(_p, _cx) {
    register();
    this.sel = load("workspace.sel", "tidy");   // "tidy" | "s:<id>" | "t:<id>"
    this.fold = load("workspace.fold", {});     // 접은 스페이스 { id: true }
    this.checks = {};                           // 정리 화면에서 사람이 바꾼 체크 { 탭 id: bool }
    this.rows = [];
  }

  // 렌더마다: 트리와 정리 후보를 새로 만든다(셸은 detail → subtitle → list 순서로 부른다).
  prepare() {
    const sps = spaces(), ps = panes() ?? [];
    this.sps = sps; this.ps = ps; this.ags = agents() ?? [];
    this.viewed = viewedTabs(sps, focused()?.tab ?? null);
    this.cands = candidates(sps, ps, { viewed: this.viewed });
    this.rows = treeRows(sps, this.fold);
    if (!this.current()) {
      // 고른 탭이 접힌 스페이스 안이면 그 스페이스, 사라졌으면 정리
      const tab = this.sel?.startsWith("t:") ? sps.find((s) => s.tabs.some((x) => `t:${x.id}` === this.sel)) : null;
      this.sel = tab ? `s:${tab.id}` : "tidy";
    }
  }

  current() { return this.rows.find((r) => r.key === this.sel) ?? null; }

  select(key, cx) {
    this.sel = key;
    save("workspace.sel", key);
    cx.notify();
  }

  toggleFold(id, cx) {
    if (this.fold[id]) delete this.fold[id]; else this.fold[id] = true;
    save("workspace.fold", this.fold);
    cx.notify();
  }

  // ── 셸 계약 ────────────────────────────────────────────
  move(delta, cx) {
    if (!this.rows.length) return;
    const i = this.rows.findIndex((r) => r.key === this.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(this.rows.length - 1, i + delta));
    this.select(this.rows[j].key, cx);
  }

  // Enter: 고른 스페이스·탭으로 간다(정리 줄은 하는 일 없음)
  activate(_cx) {
    const r = this.current();
    if (r?.kind === "space") goSpace(r.space.id);
    else if (r?.kind === "tab") goTab(r.space.id, r.tab.id);
  }

  emptyState() {
    return { text: "스페이스가 없습니다", sub: "새 스페이스를 만들면 여기에 보입니다" };
  }

  subtitle(t) {
    const sps = this.sps ?? spaces(), n = sps.reduce((s, x) => s + x.tabs.length, 0);
    return div().text_size(12).text_color(t.dim).truncate().child(`스페이스 ${sps.length} · 탭 ${n}`);
  }

  // ── 왼쪽 ──────────────────────────────────────────────
  list(cx, t) {
    this.prepare();
    return v_flex().id("ws-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
      .children(this.rows.map((r) => this.row(r, t)));
  }

  row(r, t) {
    const on = r.key === this.sel;
    const base = (el) => el.rounded(4).when(on, (x) => x.bg(t.selected)).when(!on, (x) => x.hover((s) => s.bg(t.hover)));
    if (r.kind === "tidy") {
      const n = this.cands.length;
      return base(h_flex().id("ws-tidy").h(28).flex_none().px(8).mb(4).gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => this.select("tidy", cx)))
        .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child("정리"))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(n ? `후보 ${n}` : "없음"));
    }
    if (r.kind === "space") {
      const s = r.space, open = !this.fold[s.id];
      return base(h_flex().id(`ws-${r.key}`).h(26).flex_none().items_center())
        // 화살표만 접기, 나머지는 고르기(겹친 클릭이 둘 다 불리지 않게 나란히 둔다)
        .child(div().id(`ws-fold-${s.id}`).h_full().pl(4).pr(2).flex().items_center().flex_none().cursor_pointer()
          .on_click((_e, cx) => this.toggleFold(s.id, cx))
          .child(svg(`${APPS}/chevron-${open ? "down" : "right"}.svg`).size(14).text_color(t.muted)))
        .child(h_flex().id(`ws-pick-${s.id}`).flex_1().min_w(0).h_full().pr(8).gap(6).items_center().cursor_pointer()
          .on_click((e, cx) => { this.select(r.key, cx); if (e.click_count >= 2) goSpace(s.id); })
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(s.name))
          .when(Boolean(s.machine), (el) => el.child(div().flex_none().max_w(80).truncate().text_size(11).text_color(t.muted).child(s.machine)))
          .when(s.active, (el) => el.child(div().flex_none().text_size(11).text_color(t.foreground).child("지금")))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`탭 ${s.tabs.length}`)));
    }
    const tab = r.tab, w = word(tab, t), shown = this.viewed.has(tab.id);
    return base(h_flex().id(`ws-${r.key}`).h(24).flex_none().pl(26).pr(8).gap(6).items_center().cursor_pointer()
      .on_click((e, cx) => { this.select(r.key, cx); if (e.click_count >= 2) goTab(r.space.id, tab.id); }))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5)
        .text_color(w && tabWord(tab)[1] === "dim" ? t.dim : shown ? t.foreground : t.muted).child(tab.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`칸 ${tab.panes}`))
      .when(Boolean(w), (el) => el.child(w));
  }

  // ── 오른쪽 ────────────────────────────────────────────
  detail(cx, t) {
    this.prepare();
    const r = this.current();
    if (!r) return null;
    if (r.kind === "tidy") return this.tidy(t);
    if (r.kind === "space") return this.spaceView(r.space, t);
    return this.tabView(r.space, r.tab, t);
  }

  btn(id, text, fn, t, danger = false) {
    return div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .when(Boolean(fn), (el) => el.text_color(danger ? t.ansi1 : t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn))
      .when(!fn, (el) => el.text_color(t.dim))
      .child(text);
  }

  head(title, sub, buttons, t) {
    return v_flex().flex_none().px(14).py(10).gap(8).border_b_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(title))
        .when(Boolean(sub), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(sub))))
      .when(buttons.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(buttons)));
  }

  info(label, value, t) {
    return h_flex().min_h(22).gap(10).items_center().text_size(12)
      .child(div().w(44).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(value));
  }

  section(text, t) {
    return div().pt(14).pb(4).text_size(12).font_semibold().text_color(t.muted).child(text);
  }

  spaceView(s, t) {
    const { all, working } = agentCount(s.id, this.ags);
    const lines = [this.info("폴더", where(s.folder, s.machine) || "홈", t)];
    if (s.branch) lines.push(this.info("브랜치", s.branch, t));
    lines.push(this.info("기기", s.machine ?? "이 컴퓨터", t));
    const close = () => confirm("closeSpace", { id: s.id }, `스페이스 '${s.name}' 닫기`,
      `탭 ${s.tabs.length}개와 그 안의 터미널을 모두 끝냅니다.` +
        (all ? ` 에이전트 ${all}개${working ? `(작업 중 ${working}개)` : ""}도 함께 끝납니다.` : ""),
      { yes: "닫기", danger: true });
    return v_flex().size_full().min_h(0)
      .child(this.head(s.name, s.active ? "지금 보는 스페이스" : "", [
        this.btn("ws-go", "이 스페이스로 가기", () => goSpace(s.id), t),
        this.btn("ws-rename", "이름 바꾸기", () => ask("space", s.id, "스페이스 이름 바꾸기", s.named ? s.name : ""), t),
        this.btn("ws-close", "닫기…", close, t, true),
      ], t))
      .child(v_flex().id("ws-detail").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(12)
        .children(lines)
        .child(this.section(`탭 ${s.tabs.length}`, t))
        .children([...s.tabs].sort((a, b) => a.index - b.index).map((tab) => {
          const w = word(tab, t);
          return h_flex().id(`ws-st-${tab.id}`).h(24).px(6).gap(8).items_center().rounded(4).cursor_pointer().hover((x) => x.bg(t.hover))
            .on_click((_e, cx) => { if (this.fold[s.id]) { delete this.fold[s.id]; save("workspace.fold", this.fold); } this.select(`t:${tab.id}`, cx); })
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(tab.settled ? t.dim : t.foreground).child(tab.name))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(`칸 ${tab.panes}`))
            .when(Boolean(w), (el) => el.child(w));
        })));
  }

  tabView(s, tab, t) {
    const mine = panesOf(tab.id, this.ps), busy = hasWorking(tab, mine), shown = this.viewed.has(tab.id);
    const agentsIn = mine.filter((p) => p.status || p.program?.agent).length;
    const close = () => confirm("closeTab", { id: tab.id }, `탭 '${tab.name}' 닫기`,
      `칸 ${mine.length}개의 터미널을 끝냅니다.` +
        (busy ? " 작업 중인 에이전트가 있습니다. 닫으면 하던 일이 멈춥니다." : agentsIn ? ` 에이전트 ${agentsIn}개의 대화 화면도 닫힙니다.` : ""),
      { yes: "닫기", danger: busy });
    const sub = [s.name, shown ? "지금 보는 탭" : "", tab.settled ? "접어 둠" : ""].filter(Boolean).join(" · ");
    return v_flex().size_full().min_h(0)
      .child(this.head(tab.name, sub, [
        this.btn("ws-go", "이 탭으로 가기", () => goTab(s.id, tab.id), t),
        this.btn("ws-rename", "이름 바꾸기", () => ask("tab", tab.id, "탭 이름 바꾸기", tab.named ? tab.name : ""), t),
        tab.settled
          ? this.btn("ws-settle", "펼치기", () => run("tab.unsettle", { id: tab.id }), t)
          : this.btn("ws-settle", "접어 두기", () => run("tab.settle", { id: tab.id }), t),
        this.btn("ws-close", "닫기…", close, t, busy),
      ], t))
      .child(v_flex().id("ws-detail").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10)
        .child(div().px(6).pb(4).text_size(12).font_semibold().text_color(t.muted).child(`칸 ${mine.length}`))
        .when(!mine.length, (el) => el.child(div().px(6).text_size(12).text_color(t.dim).child("칸이 없습니다")))
        .children(mine.map((p) => this.paneRow(s, tab, p, t))));
  }

  // 칸 한 줄: 아이콘 · 제목 · 상태 낱말 / 폴더 · 브랜치. 누르면 그 칸으로.
  paneRow(s, tab, p, t) {
    const place = [p.cwd ? where(p.cwd, s.machine) : "", p.branch ?? ""].filter(Boolean).join(" · ");
    const w = WORD[p.status];
    return v_flex().id(`ws-p-${p.pane}`).min_h(40).px(6).py(4).justify_center().rounded(4).cursor_pointer().hover((x) => x.bg(t.hover))
      .on_click(() => goPane(s.id, tab.id, p.pane))
      .child(h_flex().gap(8).items_center()
        .child(p.terminal ? programIcon(p.program, 14, t) : div().w(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(p.focused ? t.foreground : t.muted)
          .child(p.title || p.program?.name || p.mod || "칸"))
        .when(Boolean(w), (el) => el.child(div().flex_none().text_size(11).text_color(t[p.status] ?? t.dim).child(w))))
      .when(Boolean(place), (el) => el.child(div().pl(22).truncate().text_size(11).text_color(t.dim).child(place)));
  }

  // 정리: 후보마다 체크 · 탭 이름 · 스페이스 / 이유. 체크 기본값은 규칙(끝난 에이전트만 해제), 사람이 바꾼 건 this.checks.
  tidy(t) {
    const cs = this.cands;
    const on = (c) => this.checks[c.tab.id] ?? c.check;
    const picked = cs.filter(on);
    const closeAll = () => confirm("closeTabs", { ids: picked.map((c) => c.tab.id) }, `탭 ${picked.length}개 닫기`,
      picked.map((c) => `${c.space.name} › ${c.tab.name}`).join("\n"), { yes: "닫기", danger: true, tall: picked.length > 3 });
    return v_flex().size_full().min_h(0)
      .child(this.head("정리", "", [this.btn("ws-close-picked", picked.length ? `선택한 ${picked.length}개 닫기…` : "선택한 탭 없음", picked.length ? closeAll : null, t, true)], t))
      .child(v_flex().id("ws-detail").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10)
        .child(div().px(6).pb(8).text_size(12).text_color(t.dim)
          .child("지금 보는 탭, 작업 중인 에이전트가 있는 탭, 스페이스의 하나뿐인 탭은 넣지 않습니다"))
        .when(!cs.length, (el) => el.child(div().px(6).pt(6).text_size(13).text_color(t.muted).child("닫을 만한 탭이 없습니다")))
        .children(cs.map((c) => {
          const v = on(c);
          return h_flex().id(`ws-c-${c.tab.id}`).min_h(40).px(6).py(4).gap(10).items_center().rounded(4).cursor_pointer().hover((x) => x.bg(t.hover))
            .on_click((_e, cx) => { this.checks[c.tab.id] = !v; cx.notify(); })
            .child(div().size(14).flex_none().rounded(3).border_1().border_color(v ? t.foreground : t.border)
              .flex().items_center().justify_center().text_size(11).text_color(t.foreground).child(v ? "✓" : ""))
            .child(v_flex().flex_1().min_w(0)
              .child(h_flex().gap(8).items_center()
                .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(v ? t.foreground : t.muted).child(c.tab.name))
                .child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(c.space.name)))
              .child(div().truncate().text_size(11).text_color(t.dim).child(c.reason)));
        })));
  }
}
