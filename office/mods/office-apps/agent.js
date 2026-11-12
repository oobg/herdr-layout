// office-apps의 에이전트 앱: 에이전트가 지금 무엇을 하는지 보고, 그 터미널로 바로 간다.
//   왼쪽: 에이전트 목록. 서브에이전트는 부모 아래 들여쓴다. 줄 모양은 파일 앱 목록과 같다(높이 24, 모서리 4).
//         - hc run으로 띄운 서브에이전트 터미널: terminals()의 parent
//         - Claude Code 안에서 도는 서브에이전트: 그 터미널의 records(hc get)
//         두 번째 줄 "스페이스 · 탭"은 스페이스가 여럿일 때만. 더블클릭은 터미널로 이동, 우클릭은 메뉴(터미널로 이동·미리 보기·부모로 이동).
//   오른쪽: 요약 세 줄(지금 · 마지막 말 · 요청, 누르면 펼침) → 이번 턴 시간 띠(흐름 묶음마다 걸린 시간 비례, 3분 넘게 빈 곳은 쉼 칸)
//         → 단계 목록(살펴보기·고치기·실행·맡기기·기타·쉼, agent/timeline.js. 끝난 단계는 접힘, 지금 단계는 펼침) → 고친 파일.
//         고친 파일은 파일 앱 폴더 안이면 파일 앱에서, 밖이면 떠 있는 뷰어 창으로 연다(우클릭은 늘 뷰어 창).
//         단계 안 항목의 파일 대상(읽음·수정·작성)도 누르면 뷰어 창.
//   기록은 Claude Code 대화 기록(jsonl)에서 읽는다(agent/activity.js, agent/parse.js).
// 셸 계약: move(delta, cx) 선택 이동 · activate(cx) 그 터미널로 이동 · emptyState() 상세가 없을 때 안내 글자.
//   reveal(주소, cx): office-apps.agent:<주소> 명령이 부른다(그 터미널의 줄을 고른다).
// 갱신: 이 앱이 그려지는 동안만 타이머가 돈다. 고른 에이전트가 작업 중이면 4초, 다른 에이전트가 작업 중이면 15초,
//   모두 쉬면 1분(경과 시간 글자만). 기록 크기가 그대로면 다시 읽지 않고, 보여 줄 게 바뀔 때만 다시 그린다.
//   단, 고른 에이전트가 작업 중이면 "n분 n초째"·시간 띠가 흐르도록 4초마다 다시 그린다.
//   알렸는데 그려지지 않았으면(다른 앱으로 갔거나 칸이 숨음) 멈추고, 다시 그려질 때 이어 간다.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, panes, focused, layout, run, setShared, openOverlay, props, theme } from "herdr";
import { Menu, popupAt } from "./menu.js";
import { ROLES, openViewer } from "./files.js";
import { termInfo, sessionOf, readLog, machineOf } from "./agent/activity.js";
import { spans, phases, band, span, clock, phaseOf } from "./agent/timeline.js";

const ME = "mods/office-apps/agent";
const APPS = "mods/office-apps";
const SPINNER = "mods/workspace-chrome/spinner.svg";
const FAST = 4000, SLOW = 15000, REST = 60000;
// 상태 낱말: 서버 앱과 같은 말
const STATUS = { working: "작업 중", blocked: "입력 대기", done: "끝남", idle: "대기 중" };
// 도구 종류 → 아이콘 모양
const KIND = { 읽음: "read", 수정: "edit", 작성: "write", 검색: "search", 찾기: "search", 실행: "run", 서브에이전트: "agent", 웹: "web", 스킬: "skill" };
// 도구 종류 → 색(사무실 왼쪽 패널 office/main.js sections()의 KIND와 같은 값, 실행만 테마색)
const KIND_COLOR = { 읽음: "#7aa2f7", 수정: "#e69875", 작성: "#a7c080", 검색: "#7fbbb3", 찾기: "#7fbbb3", 서브에이전트: "#d699b6", 웹: "#83c092", 스킬: "#dbbc7f" };
const kindColor = (k, t) => (k === "실행" ? t.working : KIND_COLOR[k] ?? t.muted);
// 작게 그리면 잘 안 보이는 기본 아이콘 대신 브랜드 로고
const BRAND = [[/claude/i, `${ME}/icons/claude.svg`, "#d97757"], [/codex|openai/i, `${ME}/icons/openai.svg`, null]];
const PHASE_N = 8;       // 단계 목록을 처음에 몇 단계까지(앞은 "앞의 n단계" 한 줄로 접는다)
const CODE_FONT = "D2Coding";   // 시각(숫자) 글꼴
const LABEL_W = 64;      // 요약 줄의 왼쪽 라벨 열

const isClaude = (p, app) => /claude/i.test(`${p?.key ?? ""} ${p?.name ?? ""} ${app ?? ""}`);
const mins = (ms) => Math.max(0, Math.floor(ms / 60000));
function dur(ms) { const m = mins(ms); return m < 1 ? "방금" : m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`; }
function ago(at) {
  if (!at) return "";
  const m = mins(Date.now() - at);
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
}
function load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }

// 경로를 짧게: 프로젝트 안이면 상대 경로, Claude 임시 폴더면 그 안의 경로, 홈 아래면 ~/…
function shortPath(p, cwd) {
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  const tmp = /^\/(private\/)?tmp\/claude-[^/]+\/[^/]+\/[^/]+\/(scratchpad\/)?(.*)$/.exec(p);
  if (tmp) return tmp[3];
  const h = HOME(p);
  if (h && p.startsWith(h + "/")) return `~/${p.slice(h.length + 1)}`;
  return p;
}

// 파일 앱이 지금 여는 폴더와 머신(files.js location()과 같은 규칙). 공용 파일을 고치지 않으려고 같은 계산을 한다.
function filesRoot() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on: on ?? null };
}

// 고친 파일을 파일 앱에서 열 경로(파일 앱 폴더 기준). 그 폴더 밖이거나 다른 머신이면 null(열지 않는다).
function openable(abs, address, { cwd, on } = filesRoot()) {
  if (!cwd || (machineOf(address) ?? null) !== on) return null;
  return abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : null;
}

// 뷰어 창으로 열 수 있는 파일 대상: 파일 도구(읽음·수정·작성)의 절대 경로
const isFileKind = (kind) => ["읽음", "수정", "작성"].includes(kind);
const isFile = (kind, target) => ["읽음", "수정", "작성"].includes(kind) && typeof target === "string" && target.startsWith("/");

// 이동: 그 터미널로. office 레이아웃이면 터미널 칸을 열고 office 모드에 고른 워크트리를 알린다(office의 openSpace와 같게).
//   우클릭 메뉴(오버레이 복사본)도 부르므로 값만 받는다: { address, space }
function goTo({ address, space }) {
  if (space) run("space.select", { id: space });
  run("agent.focus", { terminal: address });
  if (space && JSON.stringify(layout() ?? {}).includes('"office-term"')) {
    run("layout.show", { id: "office-term" });
    setShared("office.open", space);
  }
}
const peek = (address) => run("terminal.peek", { terminal: address });

// ── 우클릭 메뉴 ────────────────────────────────────────────
// ctx = { title, program, address, space, kind, depth, parent: { address, space } }  (오버레이로 넘기므로 값만)
function menuItems(ctx) {
  const c = theme().muted, out = [];
  // Claude Code 안의 서브에이전트는 따로 터미널이 없다: 부모로 이동만
  if (ctx.kind !== "rec") {
    out.push({ label: "터미널로 이동", icon: `${APPS}/terminal.svg`, color: c, fn: () => goTo(ctx), hint: "더블클릭" });
    out.push({ label: "미리 보기", icon: `${APPS}/eye.svg`, color: c, fn: () => peek(ctx.address) });
  }
  if (ctx.depth > 0 && ctx.parent) out.push({ label: "부모로 이동", icon: `${APPS}/chevron-left.svg`, color: c, fn: () => goTo(ctx.parent) });
  return out;
}

const ROW = 30, HEAD = 34, MENU_W = 240;   // menu.js Menu와 같은 줄 높이·머리줄

class AgentMenu extends Menu {
  list() { return menuItems(props().ctx); }

  title(t, ctx) {
    return h_flex().h(HEAD - 6).mb(4).px(6).gap(8).items_center().border_b_1().border_color(t.border)
      .child(programIcon(ctx.program, 15, t))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(ctx.title));
  }
}

// 오버레이 역할 표(files.js ROLES)에 더한다. main.js가 이 파일을 import하므로 모든 복사본(오버레이 포함)에서 먼저 돈다.
function register() { ROLES["agent-menu"] = AgentMenu; }
register();

// agents()는 상태를 보고(OSC 7501)하는 터미널만 준다. Codex처럼 보고 훅이 없는 에이전트도 보이게,
//   칸에서 에이전트 프로그램이 돌고 있으면 상태 없이(null) 덧붙인다(office 모드의 withSilent와 같은 규칙).
const SILENT_AGENT = /claude|codex|grok|antigravity|gemini|cursor|opencode|\bamp\b|\bpi\b/i;
function withSilent(list, ps) {
  const have = new Set(list.map((a) => a.address));
  const spaceOf = new Map(spaces().flatMap((s) => s.tabs.map((x) => [x.id, s])));
  const extra = ps.filter((p) => p.terminal && !p.status && !have.has(p.terminal) && spaceOf.has(p.tab)
      && (p.program?.agent || SILENT_AGENT.test(p.program?.key ?? "")))
    .map((p) => {
      const s = spaceOf.get(p.tab), tab = s.tabs.find((x) => x.id === p.tab);
      return { address: p.terminal, pane: p.pane, space: s.id, space_name: s.name, tab: p.tab, tab_index: tab?.index ?? 0,
        tab_name: tab?.name ?? "", status: null, app: null, program: p.program, title: p.program?.name ?? p.title ?? "", seq: 0, pinned: false, focused: p.focused };
    });
  return extra.length ? [...list, ...extra] : list;
}

function programIcon(p, size, t) {
  const id = `${p?.key ?? ""} ${p?.name ?? ""}`;
  const b = BRAND.find(([re]) => re.test(id));
  if (b) return svg(b[1]).size(size).flex_none().text_color(b[2] ?? t.foreground);
  if (p?.icon) return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color || t.foreground) : image(p.icon).size(size).flex_none();
  return div().flex_none().text_size(size - 2).text_color(t.foreground).child((p?.name || "?").slice(0, 1));
}

export class AgentApp {
  init(_p, _cx) {
    register();
    this.sel = load("agent.sel", null);   // 고른 줄의 key: 터미널 주소, 안에서 도는 서브에이전트는 "주소#agentId"
    this.info = {};       // 주소 → { pid, cwd, statusAt, records, at }  (hc get)
    this.act = {};        // 줄 key → 기록에서 뽑은 활동(parse.js), 못 읽으면 { empty }
    this.rows = [];       // 지난 렌더의 목록(타이머가 쓴다)
    this.open = {};       // 펼친 것: say(마지막 말) · flow(도구 흐름) · ask(요청). 다른 줄을 고르면 접는다.
    this.loaded = false;  // 첫 갱신을 마쳤는지(빈 상태의 "읽는 중"과 "없음"을 가른다)
    this.fail = null;     // 고른 줄을 연달아 못 읽은 동안 { key, since }: 화면의 값이 그때에 멈춰 있다
    this.timer = null; this.busy = false;
    this.rendered = 0; this.notified = 0; this.minute = 0;
  }

  // ── 목록 만들기 ─────────────────────────────────────────
  build(ags = withSilent(agents(), panes() ?? []), terms = terminals() ?? [], sps = spaces()) {
    const tmap = new Map(terms.map((x) => [x.address, x]));
    const mine = new Set(ags.map((a) => a.address));
    const rows = [];
    const walk = (addr, depth, top, parent) => {
      // 터미널 서브에이전트(hc run)
      // 상태를 알리는 것만(hc run으로 띄운 셸·개발 서버는 빼고, office 오버뷰와 같게)
      for (const k of terms.filter((x) => x.parent === addr && x.state === "live" && x.status)) {
        const st = k.status === "error" ? "blocked" : STATUS[k.status] ? k.status : "idle";
        const row = { key: k.address, address: k.address, depth, status: st, kind: "term", top, parent,
          title: k.title || k.name || k.program?.name || k.address, program: k.program, app: k.report?.app ?? null,
          cwd: k.cwd ?? null, since: k.status_ms ?? this.info[k.address]?.statusAt ?? null };
        rows.push(row);
        walk(k.address, depth + 1, top, row);
      }
      // Claude Code 안의 서브에이전트(records). 부모 기록에서 끝난 걸 알면 그쪽을 믿는다.
      //   부모 기록은 부모 줄이나 그 서브에이전트 줄을 골랐을 때 다시 읽는다(refresh).
      const recs = tmap.get(addr)?.records ?? this.info[addr]?.records ?? {};
      const known = this.act[addr]?.agents ?? [], ended = this.act[addr]?.ended ?? {};
      for (const [id, r] of Object.entries(recs).slice(0, 12)) {
        // 부모 기록의 완료 알림(task-id)이 records보다 정확하다: records는 끝난 뒤에도 working으로 한동안 남는다
        const e = ended[id], g0 = known.find((x) => x.agentId === id);
        const g = e ? { ...(g0 ?? {}), running: false, failed: e.status !== "completed", tools: e.tools, ms: e.ms } : g0;
        const st = g ? (g.running ? "working" : g.failed ? "blocked" : "idle") : STATUS[r?.state] ? r.state : "idle";
        rows.push({ key: `${addr}#${id}`, address: addr, sub: id, depth, status: st, kind: "rec", top, parent,
          title: r?.title || g?.what || "서브에이전트", program: top.program, app: r?.app ?? null, since: g?.at ?? null, finished: g && !g.running ? g : null });
      }
    };
    const tabs = new Map(sps.flatMap((s) => s.tabs.map((x) => [x.id, x])));
    for (const a of ags) {
      if (mine.has(tmap.get(a.address)?.parent)) continue; // 부모 아래에서 그린다
      // 탭 단위 시각은 hc get의 상태 시각을 읽기 전까지 쓰는 짐작
      const tb = tabs.get(a.tab), tab = (a.status === "working" ? tb?.working_since : tb?.changed_at) ?? null;
      const row = { key: a.address, address: a.address, depth: 0, status: a.status, kind: "agent", a, space: a.space,
        title: a.title || a.program?.name || a.address, where: `${a.space_name} · ${a.tab_name}`,
        program: a.program, app: a.app, cwd: tmap.get(a.address)?.cwd ?? null,
        since: this.info[a.address]?.statusAt ?? tmap.get(a.address)?.status_ms ?? tab };
      row.top = row;
      rows.push(row);
      walk(a.address, 1, row, row);
    }
    // 에이전트가 있는 스페이스가 여럿일 때만 "스페이스 · 탭"을 붙인다
    this.manySpaces = new Set(ags.map((a) => a.space)).size > 1;
    return rows;
  }

  current() {
    return this.rows.find((r) => r.key === this.sel) ?? null;
  }

  select(key, cx) {
    if (key !== this.sel) { this.open = {}; this.fail = null; }
    this.sel = key;
    try { localStorage.setItem("agent.sel", JSON.stringify(key)); } catch { /* 이번 실행 동안만 */ }
    this.kick(cx);
    cx.notify();
  }

  // office-apps.agent:<주소> 명령: 그 터미널의 줄을 고른다.
  //   앱을 처음 여는 때는 목록이 비어 있어 첫 갱신이 아무것도 못 읽고 1분을 쉬므로, 목록을 먼저 만든다.
  reveal(address, cx) {
    this.rows = this.build();
    this.select(String(address), cx);
  }

  // ── 셸 계약 ────────────────────────────────────────────
  // ↑↓: 목록에서 선택을 옮긴다(끝에서 멈춘다)
  move(delta, cx) {
    if (!this.rows.length) return;
    const i = this.rows.findIndex((r) => r.key === this.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(this.rows.length - 1, i + delta));
    this.select(this.rows[j].key, cx);
  }

  // Enter: 고른 줄의 터미널로(안의 서브에이전트는 부모 터미널)
  activate(_cx) {
    const r = this.current();
    if (r) goTo(this.target(r));
  }

  // 상세가 없을 때(목록이 비었을 때) 셸이 그리는 안내
  emptyState() {
    return this.loaded
      ? { text: "실행 중인 에이전트가 없습니다", sub: "에이전트를 띄우면 여기에 보입니다" }
      : { text: "에이전트를 읽는 중", sub: "" };
  }

  // 줄 → 이동할 곳(값만). 안의 서브에이전트(rec)의 주소는 그 서브에이전트가 도는 터미널이다.
  target(r) {
    return { address: r.address, space: r.top?.space ?? null };
  }

  // ── 갱신 ───────────────────────────────────────────────
  interval() {
    const r = this.current(), v = r && this.act[r.key];
    if (r && (r.status === "working" || v?.agents?.some((g) => g.running))) return FAST;
    return this.rows.some((x) => x.status === "working") ? SLOW : REST;
  }

  // 렌더마다 부른다: 타이머가 멈춰 있으면 다시 건다(처음이면 바로 읽는다)
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

  // 앱을 끌 때(main.js toggle): 걸려 있는 after를 끊는다. 이미 읽는 중(busy)이면 끝난 뒤 loop가 disposed를 보고 다시 걸지 않는다.
  dispose() {
    this.disposed = true;
    this.timer?.cancel(); this.timer = null;
  }

  loop(cx, delay) {
    if (this.disposed) return;
    this.timer = cx.timer.after(delay, (cx) => {
      this.timer = null;
      if (this.disposed) return;
      // 지난번 알렸는데 그려지지 않았다: 안 보이는 중이니 멈춘다(다시 그려지면 ensure가 깨운다)
      if (this.notified > this.rendered) return;
      this.busy = true;
      cx.spawn(async (cx) => {
        let changed = false;
        try { changed = await this.refresh(); } catch { changed = this.failed() || changed; /* 다음 차례에 다시 */ }
        this.busy = false;
        if (!this.loaded) { this.loaded = true; changed = true; }
        const again = this.again; this.again = false;
        // 고른 줄이 작업 중이면 초 단위 경과(n분 n초째)와 시간 띠를 흐르게 매번 다시 그린다
        const ticking = this.current()?.status === "working";
        if (changed || again || ticking || Math.floor(Date.now() / 60000) !== this.minute) { this.notified = Date.now(); cx.notify(); }
        this.loop(cx, again ? 0 : this.interval());
      });
    });
  }

  // 고른 줄을 못 읽었다: 처음 못 읽은 시각을 둔다(이어서 실패하는 동안 그대로). 새로 생겼으면 true.
  failed() {
    const k = this.sel;
    if (this.fail?.key === k) return false;
    this.fail = { key: k, since: Date.now() };
    return true;
  }

  async refresh() {
    let changed = false, ok = true;
    const now = Date.now(), sel = this.current();
    // hc get: 고른 줄의 터미널은 매번, 다른 Claude 에이전트는 15초마다(안에서 도는 서브에이전트 목록·상태 시각)
    const want = this.rows.filter((r) => r.kind !== "rec" && isClaude(r.program, r.app)
      && (r.address === sel?.address || now - (this.info[r.address]?.at ?? 0) > SLOW));
    for (const r of want) {
      const i = await termInfo(r.address).catch(() => null);
      const prev = this.info[r.address];
      if (!i) { this.info[r.address] = { ...(prev ?? {}), at: now }; if (r.address === sel?.address) ok = false; continue; } // 못 읽으면 지난 값을 둔다
      this.info[r.address] = { ...i, at: now };
      if (JSON.stringify(i?.records ?? {}) !== JSON.stringify(prev?.records ?? {}) || i?.statusAt !== prev?.statusAt) changed = true;
    }
    // 고른 줄의 기록
    if (sel && isClaude(sel.program, sel.app)) {
      const i = this.info[sel.address] ?? {}, on = machineOf(sel.address);
      const prev = this.act[sel.key];
      // 셸을 못 돌렸으면(던짐) 지난 값을 두고 실패로 센다. 기록이 없으면(null) "찾지 못했습니다".
      let sess = null, v = null, threw = false;
      try {
        sess = await sessionOf(i.pid, i.cwd ?? sel.cwd ?? sel.top?.cwd, on);
        v = sess ? await readLog(sess, sel.sub ?? null, prev, on) : null;
      } catch { threw = true; ok = false; }
      if (threw) { /* 지난 값을 둔다 */ }
      else if (!v) { if (!prev?.empty) { this.act[sel.key] = { empty: true }; changed = true; } }
      else if (!v.same) { this.act[sel.key] = v; changed = true; }
      // 고른 줄이 안의 서브에이전트면 부모 기록도 읽는다: 그 줄의 상태(끝남·실패)는 부모 기록의 완료 알림에서 온다.
      //   크기가 그대로면 readLog가 건너뛰므로 읽는 양은 늘지 않는다.
      if (sess && !threw && sel.kind === "rec") {
        const pv = this.act[sel.address];
        const w = await readLog(sess, null, pv, on).catch(() => null);
        if (w && !w.same) { this.act[sel.address] = w; changed = true; }
      }
    }
    if (!ok) changed = this.failed() || changed;
    else if (this.fail) { this.fail = null; changed = true; }
    return changed;
  }

  // ── 그리기 ─────────────────────────────────────────────
  dot(status, t) {
    return div().size(7).flex_none().rounded_full().bg(t[status] ?? t.idle);
  }

  // 목록 오른쪽 글자: 작업 중이면 경과, 기다리면 "입력 대기", 끝났으면 "끝남", 쉬면 마지막 변화 시각
  right(r, t) {
    if (r.status === "working") return [r.since ? dur(Date.now() - r.since) : "", t.muted];
    if (r.status === "blocked") return [STATUS.blocked, t.blocked];
    if (r.status === "done") return [STATUS.done, t.done];
    return [r.kind === "rec" ? (r.finished ? STATUS.done : "") : ago(r.since), t.dim];
  }

  // 렌더마다: 목록을 새로 만들고, 고른 줄이 없으면 정하고, 타이머를 깨운다.
  // 셸은 detail → subtitle → list 순서로 부르므로 detail과 list 둘 다에서 부른다(목록 만들기는 가볍다).
  prepare(cx) {
    this.rows = this.build();
    if (!this.current() && this.rows.length) {
      // 고른 서브에이전트가 사라졌으면 그 부모, 처음이면 포커스된 에이전트, 없으면 첫 줄
      const parent = String(this.sel ?? "").split("#")[0], f = focused()?.terminal;
      this.sel = (this.rows.find((r) => r.key === parent) ?? this.rows.find((r) => r.address === f && !r.sub) ?? this.rows[0]).key;
      this.open = {};
    }
    this.ensure(cx);
  }

  // 우클릭 메뉴: 오버레이는 이 모드의 새 복사본이라 값만 넘긴다.
  openMenu(r) {
    const ctx = { title: r.title, program: r.program ?? null, kind: r.kind, depth: r.depth, ...this.target(r),
      parent: r.parent ? this.target(r.parent) : null };
    const h = 12 + HEAD + menuItems(ctx).length * ROW;
    openOverlay({ mod: "office-apps", kind: "popup", at: popupAt(MENU_W, h), width: MENU_W, height: h, props: { role: "agent-menu", ctx } });
  }

  list(cx, t) {
    this.prepare(cx);
    return v_flex().id("agent-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
      .when(!this.rows.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.loaded ? "없음" : "읽는 중")))
      .children(this.rows.map((r) => {
        const on = r.key === this.sel, [right, rc] = this.right(r, t);
        const top = r.depth === 0, where = top && this.manySpaces ? r.where : "";
        // 파일 앱 목록 줄과 같은 모양: 높이 24 · 모서리 4 · 들여쓰기 16. 스페이스 줄이 붙으면 그만큼 높인다.
        return v_flex().id(`ag-${r.key}`).h(where ? 40 : 24).flex_none().justify_center().pl(6 + r.depth * 16).pr(8).rounded(4).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((e, cx) => { this.select(r.key, cx); if (e.click_count >= 2) goTo(this.target(r)); })
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.select(r.key, cx); this.openMenu(r); })
          .child(h_flex().gap(8).items_center()
            .child(this.dot(r.status, t))
            .when(r.kind !== "rec", (el) => el.child(programIcon(r.program, 14, t)))   // 서브에이전트는 부모와 같은 아이콘이라 뺀다
            .child(div().flex_1().min_w(0).truncate().text_size(top ? 13 : 12)
              .text_color(top || r.status === "working" ? t.foreground : t.muted).child(r.title))
            .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11).text_color(rc).child(right))))
          .when(Boolean(where), (el) => el.child(div().pl(r.kind !== "rec" ? 37 : 15).truncate().text_size(11).text_color(t.dim).child(where)));
      }));
  }

  // 부제: 숫자는 최상위 에이전트 기준으로만. 사람이 볼 일(입력 대기)이 있을 때만 그 수를 더한다.
  subtitle(t) {
    const tops = this.rows.filter((r) => r.depth === 0);
    const blocked = tops.filter((r) => r.status === "blocked").length;
    return h_flex().gap(10).items_center().text_size(12).text_color(t.dim).truncate()
      .child(div().flex_none().child(`에이전트 ${tops.length}`))
      .when(blocked > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child(`${STATUS.blocked} ${blocked}`)));
  }

  // 이름: 터미널 제목. 서버 앱과 같은 사람으로 보이게 상세 머리줄에는 "프로그램 이름 · 제목"
  name(r) {
    const p = r.kind !== "rec" ? r.program?.name : null;
    return p && p !== r.title ? `${p} · ${r.title}` : r.title;
  }

  detail(cx, t) {
    this.prepare(cx);
    const r = this.current();
    if (!r) return null;
    const v = this.act[r.key];
    const claude = isClaude(r.program, r.app);
    const btn = (id, text, fn) => div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn).child(text);

    // 연달아 못 읽은 지 1분이 넘었다: 아래 값이 그때에 멈춰 있다고 밝힌다
    const stale = this.fail?.key === r.key ? mins(Date.now() - this.fail.since) : 0;
    const staleNote = stale >= 1 ? div().pt(6).text_size(12).text_color(t.muted).child(`${stale}분째 새로 읽지 못했습니다`) : null;
    const items = [];
    if (claude && v && !v.empty) items.push(...this.activity(r, v, staleNote, cx, t));
    else {
      items.push(this.nowRow(r, null, null, Date.now(), t));
      if (staleNote) items.push(staleNote);
      items.push(this.note(!claude ? "Claude Code 에이전트만 하는 일을 읽을 수 있습니다" : !v ? "기록을 읽는 중" : "대화 기록을 찾지 못했습니다", t));
    }

    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(programIcon(r.program, 16, t))
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(this.name(r)))
        .when(r.kind === "rec", (el) => el.child(btn("agent-go-parent", "부모로 이동", () => goTo(this.target(r.parent ?? r.top)))))
        .when(r.kind !== "rec", (el) => el
          .child(btn("agent-go", "터미널로 이동", () => goTo(this.target(r))))
          .child(btn("agent-peek", "미리 보기", () => peek(r.address)))))
      .child(v_flex().id("agent-detail").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(2).text_size(13).children(items));
  }

  // 요약 한 줄: 왼쪽 라벨(64) · 내용 · 오른쪽 시각. onClick이 있으면 누를 수 있다.
  line(id, label, body, right, rc, t, onClick) {
    return h_flex().id(id).min_h(22).py(1).gap(8).items_start()
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click(onClick))
      .child(div().w(LABEL_W).flex_none().pt(1).text_size(12).text_color(t.muted).child(label))
      .child(body.flex_1().min_w(0))
      .when(Boolean(right), (el) => el.child(div().flex_none().pt(1).text_size(12).text_color(rc).child(right)));
  }

  // "지금" 줄. sp·ph: 이번 턴 흐름(spans)과 단계(phases), 기록이 없으면 null.
  //   작업 중: 스피너 + 도는 도구의 설명(실행이면 Bash description, 아니면 "종류 대상") + " · 단계 이름 단계" / "n분 n초째"
  //            도는 도구가 없으면(도구 사이 생각하는 중) "작업 중" + 단계 / 작업 중이 된 뒤 경과.
  //   아니면: 상태 점 + 상태 낱말 / 마지막 변화 시각.
  nowRow(r, v, ph, now, t) {
    if (r.status !== "working") {
      const word = r.kind === "rec" && r.finished ? (r.finished.failed ? "실패" : STATUS.done) : STATUS[r.status] ?? "";
      return this.line("agent-now", "지금", h_flex().gap(8).items_center().min_h(20)
        .child(this.dot(r.status, t)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(word)),
      r.since ? ago(r.since) : "", t.muted, t);
    }
    const cur = [...(v?.flow ?? [])].reverse().find((f) => f.running);
    // 실행은 묶음의 마지막 호출이 아니라 아직 도는 호출의 설명(parse.js running)
    const run1 = cur?.kind === "실행" ? v.running?.[v.running.length - 1] : null;
    const desc = !cur ? STATUS.working
      : run1 ? run1.target || "실행"
      : `${cur.kind}${cur.target ? ` ${isFileKind(cur.kind) ? cur.target.split("/").pop() : cur.target}` : ""}`;
    const from = run1?.at ?? cur?.at ?? r.since;
    // 단계: 도는 도구의 단계(뒤에서 도는 서브에이전트일 수 있다), 없으면 마지막 단계
    const stage = cur ? { name: phaseOf(cur.kind) } : [...(ph ?? [])].reverse().find((p) => !p.rest);
    return this.line("agent-now", "지금", h_flex().gap(8).items_center().min_h(20)
      .child(svg(SPINNER).size(13).flex_none().text_color(t.working).spin(900))
      .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.foreground).child(desc))
      .when(Boolean(stage), (el) => el.child(div().flex_none().text_color(t.muted).child(`· ${stage.name} 단계`))),
    from ? `${span(now - from)}째` : "", t.working, t);
  }

  note(text, t) {
    return div().pt(14).text_size(12).text_color(t.dim).child(text);
  }

  // 펼치기 글자(누르면 this.open[k]를 뒤집는다)
  toggle(id, k, text, cx, t) {
    return div().id(id).pt(2).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.open[k] = !this.open[k]; cx.notify(); }).child(text);
  }

  // 활동: 요약 세 줄 → 이번 턴 시간 띠 → 단계 목록 → 고친 파일
  activity(r, v, staleNote, cx, t) {
    const out = [], now = Date.now(), working = r.status === "working";
    const sp = spans(v.flow, { working, now, lastAt: v.lastAt });
    const ph = phases(sp, { working });
    const flip = (k) => (_e, cx) => { this.open[k] = !this.open[k]; cx.notify(); };

    // ── 1. 요약 세 줄 ──
    const sum = [this.nowRow(r, v, ph, now, t)];
    if (v.say) {
      const open = this.open.say;
      sum.push(this.line("agent-say", "마지막 말",
        div().text_size(13).text_color(t.foreground).when(!open, (x) => x.truncate()).child(open ? v.say : v.say.replace(/\s*\n\s*/g, " ")),
        ago(v.sayAt || v.lastAt), t.muted, t, flip("say")));
    }
    if (v.ask) {
      const open = this.open.ask;
      sum.push(this.line("agent-ask", r.kind === "rec" ? "맡은 일" : "요청",
        div().text_size(13).text_color(open ? t.foreground : t.dim).when(!open, (x) => x.truncate()).child(open ? v.ask : v.ask.replace(/\s*\n\s*/g, " ")),
        ago(v.askAt), t.muted, t, flip("ask")));
    }
    // 세션을 못 찾아 폴더의 최근 기록을 짐작해 읽었다: 같은 폴더의 다른 에이전트 기록일 수 있다고 밝힌다
    if (v.guessed) sum.push(div().pt(4).text_size(12).text_color(t.muted).child("세션을 특정하지 못해 이 폴더의 최근 기록을 보여 줍니다"));
    if (staleNote) sum.push(staleNote);
    out.push(v_flex().pb(10).border_b_1().border_color(t.border).children(sum));

    const head = (text) => div().pt(16).pb(4).text_size(12).font_semibold().text_color(t.muted).child(text);
    const icon = (k, c) => svg(`${ME}/icons/act_${KIND[k] ?? "other"}.svg`).size(13).flex_none().text_color(c ?? t.dim);

    if (sp.length) {
      // ── 2. 시간 띠 ──
      const b = band(sp);
      // 쉼 칸은 한 칸이 띠를 다 차지하지 않게 일한 시간 합의 1/4까지만 넓힌다
      const busy = b.cells.filter((c) => !c.rest).reduce((a, c) => a + c.ms, 0);
      const grow = (c) => Math.max(1, (c.rest ? Math.min(c.ms, Math.max(busy / 4, 1000)) : c.ms) / 1000);
      out.push(head(`이번 턴 · 도구 ${v.tools}번 · ${span(b.to - b.from)}`));
      out.push(h_flex().h(10).gap(2).overflow_hidden().children(b.cells.map((c) => {
        const el = div().h_full().min_w(3).flex_grow(grow(c)).flex_basis(0).rounded(2);
        if (c.rest) return el.border_1().border_color(t.border);
        if (c.running) return el.bg(t.working).loop("opacity", { from: 0.35, to: 1, period: 900 });
        return el.bg(kindColor(c.kind, t)).opacity(0.8);
      })));
      out.push(h_flex().pt(3).justify_between().font_family(CODE_FONT).text_size(10.5).text_color(t.muted)
        .child(div().child(clock(b.from))).child(div().child(clock(b.to))));

      // ── 3. 단계 목록 ──
      const over = Math.max(0, ph.length - PHASE_N), cut = this.open.phases ? 0 : over;
      const list = ph.slice(cut);
      const rows = [];
      if (over) rows.push(h_flex().id("agent-phases-more").h(22).cursor_pointer().on_click(flip("phases"))
        .child(div().w(22).flex_none())
        .child(div().text_size(12).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .child(this.open.phases ? "앞의 단계 접기" : `앞의 ${over}단계`)));
      list.forEach((p, i) => rows.push(this.phaseView(p, cut + i, list[i - 1], list[i + 1], r, v, now, icon, t)));
      out.push(v_flex().pt(12).children(rows));
    } else if (!v.ask && !v.say) out.push(this.note("이번 턴에 한 일이 아직 없습니다", t));

    // ── 4. 고친 파일: 짧은 경로. 파일 앱 폴더 안이면 누르면 파일 앱에서, 밖(임시 폴더·홈 등)이면 뷰어 창으로 연다.
    //   우클릭은 어디 있든 뷰어 창(파일 앱으로 옮겨 가지 않고 잠깐 볼 때).
    //   짐작한 기록(guessed)이면 다른 에이전트가 고친 파일일 수 있어 보이지 않는다.
    if (v.edited.length && !v.guessed) {
      const root = filesRoot();
      out.push(head(`고친 파일 ${v.edited.length + v.moreEdited}`));
      out.push(...v.edited.map((f, i) => {
        const rel = openable(f.path, r.address, root), abs = f.path.startsWith("/"), on = machineOf(r.address);
        return h_flex().id(`agent-file-${i}`).h(24).px(6).gap(6).items_center().rounded(4)
          .when(Boolean(rel) || abs, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).underline())
            .on_click(() => (rel ? run(`office-apps.show:${rel}`) : openViewer(f.path, on))))
          .when(abs, (el) => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openViewer(f.path, on); }))
          .child(icon(f.kind))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(rel ? t.foreground : t.muted).child(shortPath(f.path, v.cwd)));
      }));
      if (v.moreEdited) out.push(div().pl(25).text_size(11).text_color(t.dim).child(`외 ${v.moreEdited}개`));
    }
    return out;
  }

  // 단계 한 덩어리: 왼쪽 22px 열(세로선 + 점, 쉼 앞뒤 선은 흐리게) · 머리 줄(이름 · 요약 · 걸린 시간 · 접힘 표시) · 펼치면 항목 줄.
  //   끝난 단계는 접힘, 지금 단계는 펼침. 누른 것은 this.open["ph:<순번>:<시작 시각>"]에 둔다(다른 에이전트를 고르면 비운다).
  phaseView(p, idx, prev, next, r, v, now, icon, t) {
    const key = `ph:${idx}:${p.from}`;   // 같은 시각에 시작한 단계가 둘일 수 있어 순번을 붙인다
    const open = !p.rest && (this.open[key] ?? p.current);
    const seg = (show, dim) => div().w(1).bg(t.border).opacity(!show ? 0 : dim ? 0.35 : 1);
    const dot = div().size(7).flex_none().rounded_full()
      .when(p.rest, (x) => x.border_1().border_color(t.border))
      .when(!p.rest, (x) => x.bg(p.current ? t.working : t.muted));
    const left = v_flex().w(22).flex_none().items_center()
      .child(seg(Boolean(prev), p.rest || prev?.rest).h(8).flex_none())
      .child(dot)
      .child(seg(Boolean(next), p.rest || next?.rest).flex_1().min_h(0));
    const headRow = h_flex().id(`agent-${key}`).h(24).gap(8).items_center()
      .when(!p.rest, (x) => x.cursor_pointer().on_click((_e, cx) => { this.open[key] = !open; cx.notify(); }))
      .child(div().flex_none().text_size(13).text_color(p.current ? t.foreground : t.muted).when(!p.rest, (x) => x.font_semibold()).child(p.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(p.summary))
      .child(div().flex_none().text_size(12).text_color(p.current ? t.working : t.dim).child(p.current ? `${span(p.ms)}째` : span(p.ms)))
      .when(!p.rest, (x) => x.child(svg(`${APPS}/${open ? "chevron-down" : "chevron-right"}.svg`).size(12).flex_none().text_color(t.dim)));
    return h_flex().items_stretch().child(left).child(v_flex().flex_1().min_w(0).pb(4).child(headRow)
      .when(open, (x) => x.children(p.items.map((s, j) => this.stepRow(s, `${key}-${j}`, r, v, icon, t)))));
  }

  // 단계 안 항목 줄: 시각 · 종류 아이콘 · "종류 ×n" · 대상(파일이면 파일명, 누르면 뷰어 창) · 걸린 시간(도는 줄은 "…째")
  stepRow(s, id, r, v, icon, t) {
    const c = kindColor(s.kind, t);
    const file = isFile(s.kind, s.target);
    return h_flex().id(`agent-st-${id}`).min_h(20).gap(6).items_center()
      .child(div().w(34).flex_none().font_family(CODE_FONT).text_size(10.5).text_color(t.muted).child(clock(s.from)))
      .child(icon(s.kind, c))
      .child(div().flex_none().text_size(12).text_color(s.running ? t.foreground : c).when(s.running, (x) => x.font_semibold())
        .child(`${s.kind}${s.n > 1 ? ` ×${s.n}` : ""}`))
      .child(div().id(`agent-tg-${id}`).flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
        .child(s.target ? (isFileKind(s.kind) ? s.target.split("/").pop() : s.target) : "")
        .when(file, (x) => x.cursor_pointer().hover((h) => h.underline()).on_click(() => openViewer(s.target, machineOf(r.address)))))
      .child(div().flex_none().text_size(11).text_color(s.running ? t.working : t.dim).child(s.running ? `${span(Date.now() - s.from)}째` : span(s.ms)));
  }
}

// 홈 폴더: 경로 앞부분(/Users/<이름>, /home/<이름>)에서 읽는다. 원격 에이전트도 그 머신의 홈으로 줄인다.
function HOME(p) {
  return /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/)/.exec(p)?.[1] ?? null;
}
