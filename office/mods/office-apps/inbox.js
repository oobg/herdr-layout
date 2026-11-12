// office-apps의 알림함 앱: 여러 스페이스의 에이전트 중 "나를 기다리는 것"을 한 곳에 모아 처리한다.
//   왼쪽: 묶음 머리줄 "답 필요 n" · "완료 n"(안 본 사이 끝남) · "작업 중 n"(기본 접힘) · "상태 모름 n"(기본 접힘).
//         줄 = 프로그램 아이콘 · 스페이스 › 탭 · 경과("4분째 기다림", "12분 전 끝남"). 답 필요는 오래 기다린 순, 완료는 최근 순.
//         빈 묶음은 머리줄째 숨긴다. 대기 중(idle)은 기다리는 게 아니라서 넣지 않는다. 묶음 펼침은 localStorage.
//   오른쪽: 상태 한 줄 → 마지막 말 한 줄 → 요청 한 줄. Claude Code면 고른 줄 하나만 대화 기록(jsonl)에서 읽는다
//         (agent/activity.js·agent/parse.js. 크기가 그대로면 다시 읽지 않는다).
//         동작: 터미널로 가기(Enter·더블클릭과 같음) · 에이전트 앱에서 자세히(office-apps.agent:<주소>).
// 목록 만들기는 inbox/model.js(herdr를 import하지 않아 node로 시험한다).
// 갱신: 이 앱이 그려지는 동안만 타이머가 돈다. 고른 줄이 작업 중이면 4초, 아니면 1분(경과 글자만).
//   알렸는데 그려지지 않았으면(다른 앱으로 갔거나 칸이 숨음) 멈추고, 다시 그려질 때 이어 간다(에이전트 앱과 같은 방식).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, panes, layout, run, setShared, theme } from "herdr";
import { termInfo, sessionOf, readLog, machineOf } from "./agent/activity.js";
import { GROUPS, withSilent, buildGroups, visibleRows, openState, pick, elapsed, firstLine, isClaude, ago } from "./inbox/model.js";

const APPS = "mods/office-apps";
const FAST = 4000, REST = 60000, INFO_TTL = 15000;
// 상태 낱말: 에이전트 앱과 같은 말
const STATUS = { working: "작업 중", blocked: "입력 대기", done: "끝남", idle: "대기 중" };
// 작게 그리면 잘 안 보이는 기본 아이콘 대신 브랜드 로고(에이전트 앱의 그림을 쓴다)
const BRAND = [[/claude/i, `${APPS}/agent/icons/claude.svg`, "#d97757"], [/codex|openai/i, `${APPS}/agent/icons/openai.svg`, null]];

function load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 */ } }

// 이동: 그 터미널로. office 레이아웃이면 터미널 칸을 열고 office 모드에 고른 워크트리를 알린다(agent.js goTo와 같은 순서).
function goTo({ address, space }) {
  if (space) run("space.select", { id: space });
  run("agent.focus", { terminal: address });
  if (space && JSON.stringify(layout() ?? {}).includes('"office-term"')) {
    run("layout.show", { id: "office-term" });
    setShared("office.open", space);
  }
}

function programIcon(p, size, t) {
  const id = `${p?.key ?? ""} ${p?.name ?? ""}`;
  const b = BRAND.find(([re]) => re.test(id));
  if (b) return svg(b[1]).size(size).flex_none().text_color(b[2] ?? t.foreground);
  if (p?.icon) return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color || t.foreground) : image(p.icon).size(size).flex_none();
  return div().flex_none().text_size(size - 2).text_color(t.foreground).child((p?.name || "?").slice(0, 1));
}

export class InboxApp {
  init(_p, _cx) {
    this.sel = load("inbox.sel", null);           // 고른 줄의 key(터미널 주소)
    this.open = openState(load("inbox.open", null)); // 묶음 id → 펼쳤는지
    this.groups = { blocked: [], done: [], working: [], unknown: [] };
    this.rows = [];        // 보이는 줄(접힌 묶음 제외)
    this.info = {};        // 주소 → { pid, cwd, at }  (hc get)
    this.act = {};         // 주소 → 기록에서 뽑은 것(parse.js), 기록이 없으면 { empty }
    this.timer = null; this.busy = false; this.again = false;
    this.rendered = 0; this.notified = 0; this.minute = 0;
  }

  // ── 목록 ──────────────────────────────────────────────
  // 셸은 detail → subtitle → list 순서로 부르므로 detail과 list 둘 다에서 부른다(가볍다).
  prepare(cx) {
    const sps = spaces();
    this.groups = buildGroups(withSilent(agents(), panes() ?? [], sps), sps);
    this.rows = visibleRows(this.groups, this.open);
    const next = pick(this.rows, this.sel);
    // 고른 줄이 묶음을 떠났다(답해서 작업 중이 됨 등): 다음 줄의 기록을 기다리지 않고 바로 읽는다
    const moved = next !== this.sel && next && !this.act[next];
    this.sel = next;
    this.ensure(cx);
    if (moved) this.kick(cx);
  }

  current() {
    return this.rows.find((r) => r.key === this.sel) ?? null;
  }

  select(key, cx) {
    this.sel = key;
    save("inbox.sel", key);
    this.kick(cx);
    cx.notify();
  }

  fold(id, cx) {
    this.open[id] = !this.open[id];
    save("inbox.open", this.open);
    this.rows = visibleRows(this.groups, this.open);
    this.sel = pick(this.rows, this.sel);
    this.kick(cx);
    cx.notify();
  }

  target(r) {
    return { address: r.address, space: r.space ?? null };
  }

  // ── 셸 계약 ────────────────────────────────────────────
  // ↑↓: 보이는 줄 사이에서 선택을 옮긴다(끝에서 멈춘다)
  move(delta, cx) {
    if (!this.rows.length) return;
    const i = this.rows.findIndex((r) => r.key === this.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(this.rows.length - 1, i + delta));
    this.select(this.rows[j].key, cx);
  }

  // Enter: 고른 줄의 터미널로
  activate(_cx) {
    const r = this.current();
    if (r) goTo(this.target(r));
  }

  emptyState() {
    const { working, unknown } = this.groups;
    const rest = [working.length && `작업 중 ${working.length}`, unknown.length && `상태 모름 ${unknown.length}`].filter(Boolean).join(" · ");
    return { text: "기다리는 에이전트가 없습니다", sub: rest ? `${rest} — 왼쪽 묶음을 펼쳐 볼 수 있습니다` : "" };
  }

  dispose() {
    this.disposed = true;
    this.timer?.cancel(); this.timer = null;
  }

  // ── 갱신 ───────────────────────────────────────────────
  interval() {
    return this.current()?.status === "working" ? FAST : REST;
  }

  ensure(cx) {
    this.rendered = Date.now();
    this.minute = Math.floor(Date.now() / 60000);
    if (!this.timer && !this.busy) this.loop(cx, 0);
  }

  kick(cx) {
    if (this.busy) { this.again = true; return; }
    this.timer?.cancel(); this.timer = null;
    this.loop(cx, 0);
  }

  loop(cx, delay) {
    if (this.disposed) return;
    this.timer = cx.timer.after(delay, (cx) => {
      this.timer = null;
      if (this.disposed) return;
      if (this.notified > this.rendered) return;   // 안 보이는 중: 다시 그려지면 ensure가 깨운다
      this.busy = true;
      cx.spawn(async (cx) => {
        let changed = false;
        try { changed = await this.refresh(); } catch { /* 다음 차례에 다시 */ }
        this.busy = false;
        const again = this.again; this.again = false;
        if (changed || again || Math.floor(Date.now() / 60000) !== this.minute) { this.notified = Date.now(); cx.notify(); }
        this.loop(cx, again ? 0 : this.interval());
      });
    });
  }

  // 고른 줄 하나만: Claude Code면 hc get(pid) → 세션 기록 → 끝부분(크기가 그대로면 건너뜀)
  async refresh() {
    const r = this.current();
    if (!r || !isClaude(r.program, r.app)) return false;
    const now = Date.now(), on = machineOf(r.address);
    if (now - (this.info[r.address]?.at ?? 0) > INFO_TTL) {
      const i = await termInfo(r.address).catch(() => null);
      this.info[r.address] = i ? { pid: i.pid, cwd: i.cwd, at: now } : { ...(this.info[r.address] ?? {}), at: now };
    }
    // pid·폴더를 하나도 모르면(hc get 실패) 지난 값을 둔다. 폴더는 칸의 cwd로 물러선다.
    const i = this.info[r.address] ?? {}, prev = this.act[r.address];
    const cwd = i.cwd ?? (panes() ?? []).find((p) => p.terminal === r.address)?.cwd ?? null;
    if (!i.pid && !cwd) return false;
    // 셸을 못 돌렸으면(던짐) 지난 값을 둔다. 기록이 없으면(null) "찾지 못했습니다".
    let v;
    try {
      const sess = await sessionOf(i.pid, cwd, on);
      v = sess ? await readLog(sess, null, prev?.empty ? null : prev, on) : null;
    } catch { return false; }
    if (!v) { if (prev?.empty) return false; this.act[r.address] = { empty: true }; return true; }
    if (v.same) return false;
    this.act[r.address] = v;
    return true;
  }

  // ── 그리기 ─────────────────────────────────────────────
  list(cx, t) {
    this.prepare(cx);
    const heads = GROUPS.filter((g) => this.groups[g.id].length);
    return v_flex().id("inbox-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
      .when(!heads.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("없음")))
      .children(heads.flatMap((g) => {
        const rows = this.groups[g.id], open = this.open[g.id];
        const head = h_flex().id(`inbox-g-${g.id}`).h(26).flex_none().px(6).gap(6).items_center().rounded(4).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.fold(g.id, cx))
          .child(svg(`${APPS}/${open ? "chevron-down" : "chevron-right"}.svg`).size(12).flex_none().text_color(t.dim))
          .child(div().flex_none().text_size(12).font_semibold().text_color(g.id === "blocked" ? t.blocked : t.muted).child(g.title))
          .child(div().flex_none().text_size(12).text_color(t.dim).child(String(rows.length)));
        return [head, ...(open ? rows.map((r) => this.row(r, t)) : [])];
      }));
  }

  row(r, t) {
    const on = r.key === this.sel, right = elapsed(r);
    return h_flex().id(`inbox-${r.key}`).h(26).flex_none().pl(24).pr(8).gap(8).items_center().rounded(4).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((e, cx) => { this.select(r.key, cx); if (e.click_count >= 2) goTo(this.target(r)); })
      .child(programIcon(r.program, 14, t))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(r.where))
      .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11).text_color(r.group === "blocked" ? t.blocked : t.dim).child(right)));
  }

  subtitle(t) {
    const b = this.groups.blocked.length, d = this.groups.done.length;
    return h_flex().gap(10).items_center().text_size(12).text_color(t.dim).truncate()
      .child(div().flex_none().text_color(b ? t.blocked : t.dim).child(`답 필요 ${b}`))
      .child(div().flex_none().child("·"))
      .child(div().flex_none().child(`완료 ${d}`));
  }

  detail(cx, t) {
    this.prepare(cx);
    const r = this.current();
    if (!r) return null;
    const btn = (id, text, fn) => div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn).child(text);
    const title = r.program?.name && r.program.name !== r.title ? `${r.program.name} · ${r.title}` : r.title;

    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(programIcon(r.program, 16, t))
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(r.where))
        .child(btn("inbox-go", "터미널로 가기", () => goTo(this.target(r))))
        .child(btn("inbox-agent", "에이전트 앱에서 자세히", () => run(`office-apps.agent:${r.address}`))))
      .child(v_flex().id("inbox-detail").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(2).text_size(13)
        .child(this.state(r, t))
        .child(div().pt(2).truncate().text_size(12).text_color(t.dim).child(title))
        .children(this.talk(r, t)));
  }

  // 상태 한 줄: 낱말 + 경과(색만으로 가르지 않게 낱말을 늘 쓴다)
  state(r, t) {
    const word = r.status ? STATUS[r.status] ?? r.status : "상태 모름";
    const since = elapsed(r);
    return h_flex().gap(8).items_center().min_h(24)
      .child(div().size(7).flex_none().rounded_full().bg(r.status ? t[r.status] ?? t.idle : t.idle))
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(word))
      .when(Boolean(since), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(since)));
  }

  // 마지막 말 · 요청 한 줄씩
  talk(r, t) {
    const note = (text) => div().pt(14).text_size(12).text_color(t.dim).child(text);
    if (!isClaude(r.program, r.app)) {
      return [note(r.status ? "Claude Code 에이전트만 대화를 읽을 수 있습니다" : "상태를 알리지 않는 에이전트입니다. 터미널에서 확인하세요")];
    }
    const v = this.act[r.address];
    if (!v) return [note("기록을 읽는 중")];
    if (v.empty) return [note("대화 기록을 찾지 못했습니다")];
    const line = (label, text, at) => h_flex().pt(12).gap(10).items_baseline()
      .child(div().flex_none().w(56).text_size(12).font_semibold().text_color(t.muted).child(label))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(text))
      .when(Boolean(at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(at)));
    const out = [];
    // 세션을 못 찾아 폴더의 최근 기록을 짐작해 읽었다: 다른 에이전트의 말일 수 있다
    if (v.guessed) out.push(div().pt(10).text_size(12).text_color(t.muted).child("세션을 특정하지 못해 이 폴더의 최근 기록을 보여 줍니다"));
    const say = firstLine(v.say), ask = firstLine(v.ask);
    const sayAt = v.sayAt || v.lastAt;
    if (say) out.push(line("마지막 말", say, sayAt ? ago(Date.now() - sayAt) : ""));
    if (ask) out.push(line("요청", ask, v.askAt ? ago(Date.now() - v.askAt) : ""));
    if (!say && !ask) out.push(note("이번 턴에 한 말이 아직 없습니다"));
    return out;
  }
}
