// office-apps의 작업 공간 앱: 스페이스·탭·칸을 한눈에 보고 정리한다.
//   왼쪽: 맨 위 "정리" 한 줄, 그 아래 스페이스 › 탭 트리(탭은 들여쓴다). 스페이스는 화살표를 눌러 접는다(localStorage).
//         스페이스 줄 = 이름 · 기기(원격일 때) · 탭 수, 보이는 스페이스는 "지금". 탭 줄 = 이름 · 칸 수 · 상태 낱말
//         (답 필요·작업 중·완료, 접어 둔 탭은 흐린 "접어 둠").
//   오른쪽: 스페이스 = 폴더·브랜치·기기, 탭 요약, 가기·이름 바꾸기·닫기.
//           탭 = 칸 목록(누르면 그 칸으로), 가기·이름 바꾸기·접어 두기/펼치기·닫기.
//           정리 = 닫아도 될 만한 탭(workspace/tidy.js review)을 이유와 함께, 체크한 것만 한 번에 닫는다.
//                  그 아래 흐린 "후보에서 뺀 탭 n · 이유별 수"(누르면 펼쳐 탭마다 이유).
//                  닫기(탭·스페이스·일괄)는 모두 취소 우선이고, 실행 직전에 창을 열 때보다 위험해진 탭은 빼고 알린다.
//                  그 아래 "재울 수 있는 에이전트": 쉬는 Claude Code를 /exit로 끝내 메모리를 비우고(workspace/sleep.js·sleeper.js),
//                  잠든 기록(data/office-apps/sleeping.json)으로 같은 칸에서 claude --resume. 트리 탭 줄엔 "잠듦", 탭 상세엔 "깨우기".
// 셸 계약: move(delta, cx) 선택 이동 · activate(cx) 고른 스페이스·탭으로 가기 · emptyState().
// 데이터는 spaces()·panes()·agents()(모두 살아 있는 값, 바뀌면 다시 그려진다). 타이머는 잠든 기록 읽기와
//   재울 만한 칸의 기록 확인(TICK)에만 쓰고, 앱이 안 보이면 멈춘다.
// 확인 창·이름 입력 창은 오버레이 복사본이라 값만 넘기고, 동작은 ACTIONS["workspace.*"]·ROLES["workspace-prompt"]에 둔다.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, focused, layout, home, run, setShared, openOverlay, closeOverlay, notify, props, theme } from "herdr";
import { ACTIONS } from "./menu.js";
import { ROLES } from "./files.js";
import { viewedTabs, panesOf, hasWorking, tabWord, review, skipSummary, riskOf, recheckTidy, recheckClose, treeRows, agentCount, tilde, WORD } from "./workspace/tidy.js";
import { sleepable, confirmed, pruneSleeping, paneState, sleepingTabs, savedLine, SLEPT } from "./workspace/sleep.js";
import { readSleeping, updateSleeping, probe, sleepAgents, wake, forget } from "./workspace/sleeper.js";

const PROBE_AGAIN = 60000;   // 재울 만한 칸의 기록을 다시 확인하는 간격
const TICK = 15000;          // 앱이 보이는 동안 잠든 기록·후보를 다시 보는 간격

const APPS = "mods/office-apps";
const CLEAR = "#00000000";     // 키보드 커서가 없을 때 체크 줄 테두리(자리만 잡아 커서가 와도 줄이 움직이지 않게)
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
// 터미널을 끝내는 닫기(탭·스페이스·일괄 정리)는 창을 열 때 탭마다 위험도(workspace/tidy.js riskOf)를 ctx.snap에 담고,
// 실행 직전에 다시 재서 더 위험해진 것(작업 중·답 필요·새 에이전트·셸 아닌 프로그램·지금 보는 탭·잠듦)은 닫지 않고 알린다.
// 확인 창은 오버레이 복사본이라 잠든 기록은 파일에서 다시 읽는다.
async function liveOpts() {
  const ps = panes() ?? [];
  const rs = await readSleeping().catch(() => []);
  return { sps: spaces(), ps, opts: { viewed: viewed(), asleep: sleepingTabs(rs ?? [], ps) } };
}
const listOf = (xs) => xs.map((x) => `${x.name} · ${x.why}`).join("\n").slice(0, 400);

const ACT = {
  // ctx: { kind: "space"|"tab", id }
  rename: (ctx, name) => run(ctx.kind === "space" ? "space.rename" : "tab.rename", { id: ctx.id, name }),
  // ctx: { id, name, snap }. 창을 연 뒤 생긴 탭이나 더 위험해진 탭이 있으면 스페이스째 닫지 않는다.
  closeSpace: async (ctx) => {
    const { sps, ps, opts } = await liveOpts();
    const s = sps.find((x) => x.id === ctx.id);
    if (!s) return;
    const bad = recheckClose(s.tabs.map((tb) => tb.id), ctx.snap, sps, ps, opts);
    if (bad.length) return notify({ title: `스페이스 '${ctx.name}'를 닫지 않았습니다`, body: `창을 연 뒤 바뀐 탭이 있습니다\n${listOf(bad)}`, level: "warning" });
    run("space.close", { id: ctx.id, confirmed: true });
  },
  // ctx: { id, name, snap }
  closeTab: async (ctx) => {
    const { sps, ps, opts } = await liveOpts();
    const bad = recheckClose([ctx.id], ctx.snap, sps, ps, opts);
    if (bad.length) return notify({ title: `탭 '${ctx.name}'을 닫지 않았습니다`, body: bad[0].why, level: "warning" });
    run("tab.close", { id: ctx.id, confirmed: true });
  },
  // ctx: { ids, snap }. 지금도 후보이고 더 위험해지지 않은 탭만 닫고, 뺀 것은 이름과 이유를 알린다.
  closeTabs: async (ctx) => {
    const { sps, ps, opts } = await liveOpts();
    const { keep, dropped } = recheckTidy(ctx.ids, ctx.snap, sps, ps, opts);
    for (const id of keep) run("tab.close", { id, confirmed: true });
    if (dropped.length) notify({ title: `${dropped.length}개는 닫지 않았습니다${keep.length ? ` · ${keep.length}개 닫음` : ""}`, body: listOf(dropped), level: "warning" });
  },
  // ctx: { items }. 재우기(workspace/sleeper.js): 다시 확인하고 하나씩 /exit.
  sleep: (ctx) => sleepAgents(ctx),
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

// 상태 낱말. 상태가 없는 탭에 잠든 Claude가 있으면 "잠듦"(흐리게).
const wordOf = (tab, slept) => tabWord(tab) ?? (slept ? [SLEPT, "muted"] : null);
const word = (tab, t, slept = false) => {
  const w = wordOf(tab, slept);
  return w && div().flex_none().text_size(11).text_color(t[w[1]] ?? t.dim).child(w[0]);
};

export class WorkspaceApp {
  init(_p, _cx) {
    register();
    this.sel = load("workspace.sel", "tidy");   // "tidy" | "s:<id>" | "t:<id>"
    this.fold = load("workspace.fold", {});     // 접은 스페이스 { id: true }
    this.checks = {};                           // 정리 화면에서 사람이 바꾼 체크 { 탭 id: bool }
    this.zchecks = {};                          // 재울 에이전트 체크 { 터미널 주소: true } (기본 해제)
    this.rows = [];
    this.sleeping = [];                         // data/office-apps/sleeping.json
    this.probes = {};                           // 주소 → 기록 확인 결과(workspace/sleeper.js probe)
    this.timer = null; this.busy = false; this.rendered = 0; this.notified = 0;
  }

  dispose() { this.disposed = true; this.timer?.cancel?.(); this.timer = null; }

  // 앱이 보이는 동안 TICK마다: 잠든 기록을 읽어 정리하고, 재울 만한 칸의 기록을 확인한다.
  // 알렸는데 그려지지 않았으면(안 보이는 중) 멈추고, 다시 그려질 때 prepare가 깨운다(agent.js와 같은 방식).
  ensure(cx) {
    if (this.disposed || this.timer || this.busy) return;
    this.timer = cx.timer.after(this.loaded ? TICK : 0, (cx) => {
      this.timer = null;
      if (this.disposed || this.notified > this.rendered) return;
      this.busy = true;
      cx.spawn(async (cx) => {
        let changed = false;
        try { changed = await this.refresh(); } catch { /* 다음 차례에 */ }
        this.busy = false;
        if (!this.loaded) { this.loaded = true; changed = true; }
        // 바뀐 게 없어도 1분에 한 번은 다시 그린다: 안 보이는 중이면 그려지지 않아 다음 차례에 멈춘다
        const minute = Math.floor(Date.now() / 60000);
        if (changed || minute !== this.minute) { this.minute = minute; this.notified = Date.now(); cx.notify(); }
        this.ensure(cx);
      });
    });
  }

  async refresh() {
    const before = JSON.stringify([this.sleeping, this.probes]);
    const ps = panes() ?? [];
    // 잠든 기록: 칸에서 다른 프로그램이 돌면 조용히 지운다
    const rs = await readSleeping();
    const { drop } = pruneSleeping(rs, ps);
    this.sleeping = drop.length ? (await updateSleeping((cur) => pruneSleeping(cur, panes() ?? []).keep)) ?? rs : rs;
    // 재울 만한 칸: 확인한 지 오래됐으면 다시. 사라진 칸의 결과는 버린다.
    const pre = sleepable(spaces(), ps, { viewed: viewed(), sleeping: this.sleeping });
    const want = new Set(pre.map((c) => c.address));
    for (const k of Object.keys(this.probes)) if (!want.has(k)) delete this.probes[k];
    for (const c of pre) {
      if (Date.now() - (this.probes[c.address]?.at ?? 0) < PROBE_AGAIN) continue;
      this.probes[c.address] = await probe(c.address);
    }
    return JSON.stringify([this.sleeping, this.probes]) !== before;
  }

  // 잠든 기록 하나를 깨우고, 칸이 있으면 그리로 간다
  async wakeOne(rec, cx) {
    const to = await wake(rec);
    this.sleeping = this.sleeping.filter((r) => r.address !== rec.address);
    if (to) goPane(to.space, to.tab, to.pane);
    cx?.notify?.();
  }

  wakeTab(tabId, cx) {
    const recs = this.zTabs?.get(tabId) ?? [];
    if (!recs.length) return false;
    cx.spawn(async (cx) => { for (const r of recs) await this.wakeOne(r, cx); });
    return true;
  }

  // 렌더마다: 트리와 정리 후보를 새로 만든다(셸은 detail → subtitle → list 순서로 부른다).
  prepare(cx) {
    if (cx) this.ensure(cx);
    const sps = spaces(), ps = panes() ?? [];
    this.sps = sps; this.ps = ps; this.ags = agents() ?? [];
    this.viewed = viewedTabs(sps, focused()?.tab ?? null);
    // 잠든 칸이 있는 탭은 닫기 후보에서 뺀다(깨울 곳이 사라진다). 뺀 탭은 이유와 함께 정리 화면 아래에.
    this.zTabs = sleepingTabs(this.sleeping, ps);
    ({ cands: this.cands, skipped: this.skipped } = review(sps, ps, { viewed: this.viewed, asleep: this.zTabs }));
    this.zcands = confirmed(sleepable(sps, ps, { viewed: this.viewed, sleeping: this.sleeping }), this.probes);
    this.orphans = this.sleeping.filter((r) => paneState(r, ps) === "gone");
    // 후보에서 빠진 칸의 체크는 버린다(나중에 다시 후보가 되면 해제된 채로)
    for (const k of Object.keys(this.zchecks)) if (!this.zcands.some((c) => c.address === k)) delete this.zchecks[k];
    this.rows = treeRows(sps, this.fold);
    if (!this.current()) {
      // 고른 탭이 접힌 스페이스 안이면 그 스페이스, 사라졌으면 정리
      const tab = this.sel?.startsWith("t:") ? sps.find((s) => s.tabs.some((x) => `t:${x.id}` === this.sel)) : null;
      this.sel = tab ? `s:${tab.id}` : "tidy";
    }
  }

  current() { return this.rows.find((r) => r.key === this.sel) ?? null; }

  // 확인 창을 열 때의 위험도(실행 직전 비교용, workspace/tidy.js riskOf)
  snap(ids) { return riskOf(ids, this.sps, this.ps, { viewed: this.viewed, asleep: this.zTabs }); }

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
  // 잠든 탭이면 깨운다(깨운 뒤 그 칸으로 간다)
  activate(cx) {
    const r = this.current();
    if (r?.kind === "space") goSpace(r.space.id);
    else if (r?.kind === "tab" && !this.wakeTab(r.tab.id, cx)) goTab(r.space.id, r.tab.id);
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
    this.prepare(cx);
    this.rendered = Date.now();
    const saved = savedLine(this.sleeping);
    // 정리 줄 바로 아래에 흐린 한 줄(고를 수 없다): 잠든 에이전트 수와 재울 때 잰 메모리 합
    const els = this.rows.map((r) => this.row(r, t));
    if (saved) els.splice(1, 0, div().flex_none().px(8).pb(6).truncate().text_size(11).text_color(t.dim).child(saved));
    return v_flex().id("ws-list").flex_1().min_h(0).overflow_y_scrollbar().p(4).children(els);
  }

  row(r, t) {
    const on = r.key === this.sel;
    const base = (el) => el.rounded(4).when(on, (x) => x.bg(t.selected)).when(!on, (x) => x.hover((s) => s.bg(t.hover)));
    if (r.kind === "tidy") {
      const n = this.cands.length + this.zcands.length;
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
    const tab = r.tab, slept = this.zTabs.has(tab.id), w = word(tab, t, slept), shown = this.viewed.has(tab.id);
    return base(h_flex().id(`ws-${r.key}`).h(24).flex_none().pl(26).pr(8).gap(6).items_center().cursor_pointer()
      .on_click((e, cx) => { this.select(r.key, cx); if (e.click_count >= 2) goTab(r.space.id, tab.id); }))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5)
        .text_color(w && wordOf(tab, slept)[1] === "dim" ? t.dim : shown ? t.foreground : t.muted).child(tab.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`칸 ${tab.panes}`))
      .when(Boolean(w), (el) => el.child(w));
  }

  // ── 오른쪽 ────────────────────────────────────────────
  // 런처 키 계약: 지난 그리기에서 모은 멈출 곳(버튼·체크, 화면 순서). run은 그 줄의 on_click과 같은 함수.
  focusables() { return this.stops ?? []; }

  // 그리면서 멈출 곳을 모은다. 키보드 커서가 있으면 true(테두리 t.accent로 그린다).
  stop(id, kind, fn) {
    (this.stops || (this.stops = [])).push({ id, kind, run: (cx) => fn(null, cx) });
    return Boolean(this.kb?.on?.(id));
  }

  detail(cx, t) {
    this.stops = [];
    this.prepare(cx);
    const r = this.current();
    if (!r) return null;
    if (r.kind === "tidy") return this.tidy(t);
    if (r.kind === "space") return this.spaceView(r.space, t);
    return this.tabView(r.space, r.tab, t);
  }

  btn(id, text, fn, t, danger = false) {
    const on = fn ? this.stop(id, "button", fn) : false;
    return div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(on ? t.accent : t.border).text_size(12)
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
    const close = () => confirm("closeSpace", { id: s.id, name: s.name, snap: this.snap(s.tabs.map((tb) => tb.id)) }, `스페이스 '${s.name}' 닫기`,
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
          const w = word(tab, t, this.zTabs.has(tab.id));
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
    const slept = this.zTabs.get(tab.id) ?? [];
    // 터미널을 끝내므로 상태와 무관하게 취소 우선(danger). 실행 직전에 다시 본다(ACT.closeTab).
    const close = () => confirm("closeTab", { id: tab.id, name: tab.name, snap: this.snap([tab.id]) }, `탭 '${tab.name}' 닫기`,
      `칸 ${mine.length}개의 터미널을 끝냅니다.` +
        (busy ? " 작업 중인 에이전트가 있습니다. 닫으면 하던 일이 멈춥니다." : agentsIn ? ` 에이전트 ${agentsIn}개의 대화 화면도 닫힙니다.` : "") +
        (slept.length ? " 잠든 에이전트가 있어 닫으면 새 탭에서 깨워야 합니다." : ""),
      { yes: "닫기", danger: true });
    const sub = [s.name, shown ? "지금 보는 탭" : "", tab.settled ? "접어 둠" : "", slept.length ? SLEPT : ""].filter(Boolean).join(" · ");
    return v_flex().size_full().min_h(0)
      .child(this.head(tab.name, sub, [
        ...(slept.length ? [this.btn("ws-wake", "깨우기", (_e, cx) => this.wakeTab(tab.id, cx), t)] : []),
        this.btn("ws-go", "이 탭으로 가기", () => goTab(s.id, tab.id), t),
        this.btn("ws-rename", "이름 바꾸기", () => ask("tab", tab.id, "탭 이름 바꾸기", tab.named ? tab.name : ""), t),
        tab.settled
          ? this.btn("ws-settle", "펼치기", () => run("tab.unsettle", { id: tab.id }), t)
          : this.btn("ws-settle", "접어 두기", () => run("tab.settle", { id: tab.id }), t),
        this.btn("ws-close", "닫기…", close, t, true),
      ], t))
      .child(v_flex().id("ws-detail").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10)
        .child(div().px(6).pb(4).text_size(12).font_semibold().text_color(t.muted).child(`칸 ${mine.length}`))
        .when(!mine.length, (el) => el.child(div().px(6).text_size(12).text_color(t.dim).child("칸이 없습니다")))
        .children(mine.map((p) => this.paneRow(s, tab, p, t, slept.some((r) => r.address === p.terminal)))));
  }

  // 칸 한 줄: 아이콘 · 제목 · 상태 낱말 / 폴더 · 브랜치. 누르면 그 칸으로.
  // 잠든 칸은 "잠듦"(흐리게).
  paneRow(s, tab, p, t, slept = false) {
    const place = [p.cwd ? where(p.cwd, s.machine) : "", p.branch ?? ""].filter(Boolean).join(" · ");
    const w = WORD[p.status] ?? (slept ? SLEPT : null);
    return v_flex().id(`ws-p-${p.pane}`).min_h(40).px(6).py(4).justify_center().rounded(4).cursor_pointer().hover((x) => x.bg(t.hover))
      .on_click(() => goPane(s.id, tab.id, p.pane))
      .child(h_flex().gap(8).items_center()
        .child(p.terminal ? programIcon(p.program, 14, t) : div().w(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(p.focused ? t.foreground : t.muted)
          .child(p.title || p.program?.name || p.mod || "칸"))
        .when(Boolean(w), (el) => el.child(div().flex_none().text_size(11).text_color(slept && !p.status ? t.muted : t[p.status] ?? t.dim).child(w))))
      .when(Boolean(place), (el) => el.child(div().pl(22).truncate().text_size(11).text_color(t.dim).child(place)));
  }

  // 정리: 후보마다 체크 · 탭 이름 · 스페이스 / 이유. 체크 기본값은 규칙(끝난 에이전트만 해제), 사람이 바꾼 건 this.checks.
  tidy(t) {
    const cs = this.cands;
    const on = (c) => this.checks[c.tab.id] ?? c.check;
    const picked = cs.filter(on);
    const ids = picked.map((c) => c.tab.id);
    const closeAll = () => {
      const snap = this.snap(ids);
      for (const c of picked) if (snap[c.tab.id]) snap[c.tab.id].check = c.check;
      confirm("closeTabs", { ids, snap }, `탭 ${picked.length}개 닫기`,
        picked.map((c) => `${c.space.name} › ${c.tab.name}`).join("\n"), { yes: "닫기", danger: true, tall: picked.length > 3 });
    };
    return v_flex().size_full().min_h(0)
      .child(this.head("정리", "", [this.btn("ws-close-picked", picked.length ? `선택한 ${picked.length}개 닫기…` : "선택한 탭 없음", picked.length ? closeAll : null, t, true)], t))
      .child(v_flex().id("ws-detail").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10)
        .when(!cs.length, (el) => el.child(div().px(6).pt(2).text_size(13).text_color(t.muted).child("닫을 만한 탭이 없습니다")))
        .children(cs.map((c) => {
          const v = on(c), flip = (_e, cx) => { this.checks[c.tab.id] = !v; cx.notify(); };
          const f = this.stop(`ws-c-${c.tab.id}`, "check", flip);
          return h_flex().id(`ws-c-${c.tab.id}`).min_h(40).px(6).py(4).gap(10).items_center().rounded(4).cursor_pointer().hover((x) => x.bg(t.hover))
            .border_1().border_color(f ? t.accent : CLEAR)
            .on_click(flip)
            .child(div().size(14).flex_none().rounded(3).border_1().border_color(v ? t.foreground : t.border)
              .flex().items_center().justify_center().text_size(11).text_color(t.foreground).child(v ? "✓" : ""))
            .child(v_flex().flex_1().min_w(0)
              .child(h_flex().gap(8).items_center()
                .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(v ? t.foreground : t.muted).child(c.tab.name))
                .child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(c.space.name)))
              .child(div().truncate().text_size(11).text_color(t.dim).child(c.reason)));
        }))
        .child(this.skippedSection(t))
        .child(this.sleepSection(t)));
  }

  // 후보에서 뺀 탭: 흐린 머리줄 하나(누르면 펼침). 펼치면 줄마다 탭 이름 · 스페이스 / 이유. 줄은 누를 수 없다.
  skippedSection(t) {
    const xs = this.skipped ?? [];
    if (!xs.length) return div();
    const open = Boolean(this.skipOpen);
    const sum = skipSummary(xs).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(" · ");
    const fold = (_e, cx) => { this.skipOpen = !open; cx.notify(); }, f = this.stop("ws-skip-head", "button", fold);
    return v_flex().pt(10)
      .child(h_flex().id("ws-skip-head").h(24).px(6).gap(6).items_center().rounded(4).cursor_pointer().hover((x) => x.bg(t.hover))
        .border_1().border_color(f ? t.accent : CLEAR)
        .on_click(fold)
        .child(svg(`${APPS}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`후보에서 뺀 탭 ${xs.length}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(sum)))
      .when(open, (el) => el.children(xs.map((x) => h_flex().min_h(22).pl(24).pr(6).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(x.tab.name))
        .child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(x.space.name))
        .child(div().flex_none().max_w(200).truncate().text_size(11).text_color(t.dim).child(x.why)))));
  }

  // 재울 수 있는 에이전트(기본 체크 해제) · 칸이 닫힌 잠든 에이전트(깨우면 새 탭)
  sleepSection(t) {
    const zs = this.zcands, picked = zs.filter((c) => this.zchecks[c.address]);
    const sleepAll = () => confirm("sleep",
      { items: picked.map((c) => ({ address: c.address, pane: c.pane, tab: c.tab.id, space: c.space.id, tabName: c.tab.name })) },
      `에이전트 ${picked.length}개 재우기`,
      `${picked.map((c) => `${c.space.name} › ${c.tab.name}`).join("\n")}\n\n대화는 기록에 남고, 깨우면 같은 칸에서 이어집니다. 셸 상태(환경 변수 등)는 남지만 Claude 안의 진행 중 작업은 없어야 합니다.`,
      { yes: `${picked.length}개 재우기`, danger: true, tall: true });
    const os = this.orphans ?? [];
    return v_flex()
      .child(h_flex().pt(14).pb(4).px(6).gap(8).items_center()
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.muted).child(`재울 수 있는 에이전트 ${zs.length}`))
        .when(zs.length > 0, (el) => el.child(this.btn("ws-sleep-picked", picked.length ? `선택한 ${picked.length}개 재우기…` : "선택한 것 없음", picked.length ? sleepAll : null, t, true))))
      .child(div().px(6).pb(6).text_size(11).text_color(t.dim)
        .child("완료·대기이고 20분 넘게 변화 없는 Claude Code 중 백그라운드 작업이 없는 것. 프로세스를 끝내 메모리를 비우고, 깨우면 같은 대화로 이어 갑니다"))
      .when(!zs.length, (el) => el.child(div().px(6).pt(2).text_size(12.5).text_color(t.muted).child(this.loaded ? "재울 만한 에이전트가 없습니다" : "기록을 확인하는 중")))
      .children(zs.map((c) => {
        const v = Boolean(this.zchecks[c.address]);
        const flip = (_e, cx) => { if (v) delete this.zchecks[c.address]; else this.zchecks[c.address] = true; cx.notify(); };
        const f = this.stop(`ws-z-${c.address}`, "check", flip);
        return h_flex().id(`ws-z-${c.address}`).min_h(40).px(6).py(4).gap(10).items_center().rounded(4).cursor_pointer().hover((x) => x.bg(t.hover))
          .border_1().border_color(f ? t.accent : CLEAR)
          .on_click(flip)
          .child(div().size(14).flex_none().rounded(3).border_1().border_color(v ? t.foreground : t.border)
            .flex().items_center().justify_center().text_size(11).text_color(t.foreground).child(v ? "✓" : ""))
          .child(v_flex().flex_1().min_w(0)
            .child(h_flex().gap(8).items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(v ? t.foreground : t.muted).child(c.tab.name))
              .child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(c.space.name)))
            .child(div().truncate().text_size(11).text_color(t.dim).child(c.reason)));
      }))
      .when(os.length > 0, (el) => el
        .child(div().pt(14).pb(4).px(6).text_size(12).font_semibold().text_color(t.muted).child(`칸이 닫힌 잠든 에이전트 ${os.length}`))
        .children(os.map((r) => h_flex().id(`ws-o-${r.address}`).min_h(40).px(6).py(4).gap(8).items_center()
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(12.5).text_color(t.foreground).child(r.tabName || r.address))
            .child(div().truncate().text_size(11).text_color(t.dim).child(`${where(r.cwd, r.machine)}${r.machine ? ` · ${r.machine}` : ""} · 깨우면 새 탭에서 이어 갑니다`)))
          .child(this.btn(`ws-o-wake-${r.address}`, "깨우기", (_e, cx) => cx.spawn(async (cx) => this.wakeOne(r, cx)), t))
          .child(this.btn(`ws-o-forget-${r.address}`, "기록 지우기", (_e, cx) => cx.spawn(async (cx) => {
            await forget(r); this.sleeping = this.sleeping.filter((x) => x.address !== r.address); cx.notify();
          }), t)))));
  }
}
