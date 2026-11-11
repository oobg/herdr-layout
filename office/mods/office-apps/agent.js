// office-apps의 에이전트 앱: 에이전트와 서브에이전트가 지금 하는 일.
//   왼쪽: 에이전트 목록. 서브에이전트는 부모 아래 들여쓴다.
//         - hc run으로 띄운 서브에이전트 터미널: terminals()의 parent
//         - Claude Code 안에서 도는 서브에이전트: 그 터미널의 records(hc get)
//   오른쪽: 고른 에이전트의 이번 턴(요청, 마지막 말, 도구 흐름, 서브에이전트, 고친·읽은 파일)과 이동·엿보기.
//   기록은 Claude Code 대화 기록(jsonl)에서 읽는다(agent/activity.js, agent/parse.js).
// 갱신: 이 앱이 그려지는 동안만 타이머가 돈다. 고른 에이전트가 작업 중이면 4초, 다른 에이전트가 작업 중이면 15초,
//   모두 쉬면 1분(경과 시간 글자만). 기록 크기가 그대로면 다시 읽지 않고, 보여 줄 게 바뀔 때만 다시 그린다.
//   알렸는데 그려지지 않았으면(다른 앱으로 갔거나 칸이 숨음) 멈추고, 다시 그려질 때 이어 간다.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, focused, layout, run, setShared } from "herdr";
import { termInfo, sessionOf, readLog, machineOf } from "./agent/activity.js";

const ME = "mods/office-apps/agent";
const SPINNER = "mods/workspace-chrome/spinner.svg";
const FAST = 4000, SLOW = 15000, REST = 60000;
const STATUS = { working: "작업 중", blocked: "입력 대기", done: "완료", idle: "대기" };
// 도구 종류 → 아이콘·색(office 오버뷰와 같은 짝)
const KIND = {
  읽음: ["read", "#7aa2f7"], 수정: ["edit", "#e69875"], 작성: ["write", "#a7c080"], 검색: ["search", "#7fbbb3"], 찾기: ["search", "#7fbbb3"],
  실행: ["run", "#e8b92e"], 서브에이전트: ["agent", "#d699b6"], 웹: ["web", "#83c092"], 스킬: ["skill", "#dbbc7f"],
};
// 파일 위치 글자 색: 프로젝트는 초록, 클로드 쪽은 Claude 주황, Herdr는 파랑, 홈은 회색
const PLACE = { 프로젝트: "#a7c080", "클로드 임시": "#d97757", 클로드: "#d97757", Herdr: "#7aa2f7", 홈: "#9da9a0" };
// 작게 그리면 잘 안 보이는 기본 아이콘 대신 브랜드 로고
const BRAND = [[/claude/i, `${ME}/icons/claude.svg`, "#d97757"], [/codex|openai/i, `${ME}/icons/openai.svg`, null]];

const isClaude = (p, app) => /claude/i.test(`${p?.key ?? ""} ${p?.name ?? ""} ${app ?? ""}`);
const mins = (ms) => Math.max(0, Math.floor(ms / 60000));
function dur(ms) { const m = mins(ms); return m < 1 ? "방금" : m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`; }
function ago(at) {
  if (!at) return "";
  const m = mins(Date.now() - at);
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
}
function load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }

export class AgentApp {
  init(_p, _cx) {
    this.sel = load("agent.sel", null);   // 고른 줄의 key: 터미널 주소, 안에서 도는 서브에이전트는 "주소#agentId"
    this.info = {};       // 주소 → { pid, cwd, statusAt, records, at }  (hc get)
    this.act = {};        // 줄 key → 기록에서 뽑은 활동(parse.js), 못 읽으면 { empty }
    this.rows = [];       // 지난 렌더의 목록(타이머가 쓴다)
    this.timer = null; this.busy = false;
    this.rendered = 0; this.notified = 0; this.minute = 0;
  }

  // ── 목록 만들기 ─────────────────────────────────────────
  build(ags = agents(), terms = terminals() ?? [], sps = spaces()) {
    const tmap = new Map(terms.map((x) => [x.address, x]));
    const mine = new Set(ags.map((a) => a.address));
    const rows = [];
    const walk = (addr, depth, top) => {
      // 터미널 서브에이전트(hc run)
      // 상태를 알리는 것만(hc run으로 띄운 셸·개발 서버는 빼고, office 오버뷰와 같게)
      for (const k of terms.filter((x) => x.parent === addr && x.state === "live" && x.status)) {
        const st = k.status === "error" ? "blocked" : STATUS[k.status] ? k.status : "idle";
        rows.push({ key: k.address, address: k.address, depth, status: st, kind: "term", top,
          title: k.title || k.name || k.program?.name || k.address, program: k.program, app: k.report?.app ?? null,
          cwd: k.cwd ?? null, since: k.status_ms ?? this.info[k.address]?.statusAt ?? null });
        walk(k.address, depth + 1, top);
      }
      // Claude Code 안의 서브에이전트(records). 부모 기록에서 끝난 걸 알면 그쪽을 믿는다.
      const recs = tmap.get(addr)?.records ?? this.info[addr]?.records ?? {};
      const known = this.act[addr]?.agents ?? [], ended = this.act[addr]?.ended ?? {};
      for (const [id, r] of Object.entries(recs).slice(0, 12)) {
        // 부모 기록의 완료 알림(task-id)이 records보다 정확하다: records는 끝난 뒤에도 working으로 한동안 남는다
        const e = ended[id], g0 = known.find((x) => x.agentId === id);
        const g = e ? { ...(g0 ?? {}), running: false, failed: e.status !== "completed", tools: e.tools, ms: e.ms } : g0;
        const st = g ? (g.running ? "working" : g.failed ? "blocked" : "idle") : STATUS[r?.state] ? r.state : "idle";
        rows.push({ key: `${addr}#${id}`, address: addr, sub: id, depth, status: st, kind: "rec", top,
          title: r?.title || g?.what || "서브에이전트", program: top.program, app: r?.app ?? null, since: g?.at ?? null, finished: g && !g.running ? g : null });
      }
    };
    const tabs = new Map(sps.flatMap((s) => s.tabs.map((x) => [x.id, x])));
    for (const a of ags) {
      if (mine.has(tmap.get(a.address)?.parent)) continue; // 부모 아래에서 그린다
      // 탭 단위 시각은 hc get의 상태 시각을 읽기 전까지 쓰는 짐작
      const tb = tabs.get(a.tab), tab = (a.status === "working" ? tb?.working_since : tb?.changed_at) ?? null;
      const row = { key: a.address, address: a.address, depth: 0, status: a.status, kind: "agent", a,
        title: a.title || a.program?.name || a.address, where: `${a.space_name} · ${a.tab_name}`,
        program: a.program, app: a.app, cwd: tmap.get(a.address)?.cwd ?? null,
        since: this.info[a.address]?.statusAt ?? tmap.get(a.address)?.status_ms ?? tab };
      row.top = row;
      rows.push(row);
      walk(a.address, 1, row);
    }
    return rows;
  }

  current() {
    const rows = this.rows;
    return rows.find((r) => r.key === this.sel) ?? null;
  }

  select(key, cx) {
    this.sel = key;
    try { localStorage.setItem("agent.sel", JSON.stringify(key)); } catch { /* 이번 실행 동안만 */ }
    this.kick(cx);
    cx.notify();
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

  loop(cx, delay) {
    this.timer = cx.timer.after(delay, (cx) => {
      this.timer = null;
      // 지난번 알렸는데 그려지지 않았다: 안 보이는 중이니 멈춘다(다시 그려지면 ensure가 깨운다)
      if (this.notified > this.rendered) return;
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

  async refresh() {
    let changed = false;
    const now = Date.now(), sel = this.current();
    // hc get: 고른 줄의 터미널은 매번, 다른 Claude 에이전트는 15초마다(안에서 도는 서브에이전트 목록·상태 시각)
    const want = this.rows.filter((r) => r.kind !== "rec" && isClaude(r.program, r.app)
      && (r.address === sel?.address || now - (this.info[r.address]?.at ?? 0) > SLOW));
    for (const r of want) {
      const i = await termInfo(r.address).catch(() => null);
      const prev = this.info[r.address];
      if (!i) { this.info[r.address] = { ...(prev ?? {}), at: now }; continue; } // 못 읽으면 지난 값을 둔다
      this.info[r.address] = { ...i, at: now };
      if (JSON.stringify(i?.records ?? {}) !== JSON.stringify(prev?.records ?? {}) || i?.statusAt !== prev?.statusAt) changed = true;
    }
    // 고른 줄의 기록
    if (sel && isClaude(sel.program, sel.app)) {
      const i = this.info[sel.address] ?? {}, on = machineOf(sel.address);
      const sess = await sessionOf(i.pid, i.cwd ?? sel.cwd ?? sel.top?.cwd, on).catch(() => null);
      const prev = this.act[sel.key];
      const v = sess ? await readLog(sess, sel.sub ?? null, prev?.size, on).catch(() => null) : null;
      if (!v) { if (!prev?.empty) { this.act[sel.key] = { empty: true }; changed = true; } }
      else if (!v.same) { this.act[sel.key] = v; changed = true; }
    }
    return changed;
  }

  // ── 그리기 ─────────────────────────────────────────────
  dot(status, t) {
    return div().size(7).flex_none().rounded_full().bg(t[status] ?? t.idle);
  }

  // 목록 오른쪽 글자: 작업 중이면 경과, 기다리면 "입력 대기", 끝났으면 "완료", 쉬면 마지막 변화 시각
  right(r, t) {
    if (r.status === "working") return [r.since ? dur(Date.now() - r.since) : "", t.muted];
    if (r.status === "blocked") return [STATUS.blocked, t.blocked];
    if (r.status === "done") return [STATUS.done, t.done];
    return [r.kind === "rec" ? (r.finished ? "완료" : "") : ago(r.since), t.dim];
  }

  // 렌더마다: 목록을 새로 만들고, 고른 줄이 없으면 정하고, 타이머를 깨운다.
  // 셸은 detail → subtitle → list 순서로 부르므로 detail과 list 둘 다에서 부른다(목록 만들기는 가볍다).
  prepare(cx) {
    this.rows = this.build();
    if (!this.current() && this.rows.length) {
      // 고른 서브에이전트가 사라졌으면 그 부모, 처음이면 포커스된 에이전트, 없으면 첫 줄
      const parent = String(this.sel ?? "").split("#")[0], f = focused()?.terminal;
      this.sel = (this.rows.find((r) => r.key === parent) ?? this.rows.find((r) => r.address === f && !r.sub) ?? this.rows[0]).key;
    }
    this.ensure(cx);
  }

  list(cx, t) {
    this.prepare(cx);
    return v_flex().id("agent-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
      .when(!this.rows.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("실행 중인 에이전트가 없습니다")))
      .children(this.rows.map((r) => {
        const on = r.key === this.sel, [right, rc] = this.right(r, t);
        const top = r.depth === 0;
        return v_flex().id(`ag-${r.key}`).ml(r.depth * 14).px(8).py(top ? 6 : 4).gap(2).rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => this.select(r.key, cx))
          .child(h_flex().gap(8).items_center()
            .child(this.dot(r.status, t))
            .child(div().flex_1().min_w(0).truncate().text_size(top ? 13 : 12)
              .text_color(top || r.status === "working" ? t.foreground : t.muted).when(top, (x) => x.font_semibold()).child(r.title))
            .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11).text_color(rc).child(right))))
          .when(top, (el) => el.child(div().pl(15).truncate().text_size(11).text_color(t.dim).child(r.where)));
      }));
  }

  subtitle(t) {
    const n = (s) => this.rows.filter((r) => r.status === s).length;
    const parts = [["working", n("working")], ["blocked", n("blocked")], ["done", n("done")]].filter(([, c]) => c > 0);
    const tops = this.rows.filter((r) => r.depth === 0).length;
    return h_flex().gap(10).items_center().text_size(12).text_color(t.dim).truncate()
      .child(div().flex_none().child(`에이전트 ${tops}`))
      .children(parts.map(([s, c]) => div().flex_none().text_color(s === "working" ? t.muted : t[s]).child(`${STATUS[s]} ${c}`)));
  }

  icon(p, size, t) {
    const id = `${p?.key ?? ""} ${p?.name ?? ""}`;
    const b = BRAND.find(([re]) => re.test(id));
    if (b) return svg(b[1]).size(size).flex_none().text_color(b[2] ?? t.foreground);
    if (p?.icon) return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color || t.foreground) : image(p.icon).size(size).flex_none();
    return div().flex_none().text_size(size - 2).text_color(t.foreground).child((p?.name || "?").slice(0, 1));
  }

  // 이동: 그 터미널로. office 레이아웃이면 터미널 칸을 열고 office 모드에 고른 워크트리를 알린다(office의 openSpace와 같게).
  go(r) {
    const space = r.top?.a?.space;
    if (space) run("space.select", { id: space });
    run("agent.focus", { terminal: r.address });
    if (space && JSON.stringify(layout() ?? {}).includes('"office-term"')) {
      run("layout.show", { id: "office-term" });
      setShared("office.open", space);
    }
  }

  detail(cx, t) {
    this.prepare(cx);
    const r = this.current();
    if (!r) return null;
    const v = this.act[r.key];
    const claude = isClaude(r.program, r.app);
    const btn = (id, text, fn) => div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn).child(text);
    const where = r.kind === "agent" ? r.where : r.kind === "rec" ? `${r.top.title} 안의 서브에이전트` : `${r.top.title} 아래 터미널`;

    // 상태 줄: 상태 낱말에만 색
    const [label, color] = [STATUS[r.status] ?? "", t[r.status] ?? t.muted];
    const since = r.status === "working" && r.since ? `${dur(Date.now() - r.since)}째` : r.since ? ago(r.since) : "";
    const facts = [since, v?.model ? v.model.replace(/^claude-/, "") : null, v?.lastAt ? `마지막 기록 ${ago(v.lastAt)}` : null].filter(Boolean);

    const items = [h_flex().gap(8).items_baseline()
        .child(div().flex_none().text_color(color).font_semibold().child(r.kind === "rec" && r.finished ? (r.finished.failed ? "실패" : "완료") : label))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(facts.join(" · ")))];

    if (!claude) items.push(this.note("Claude Code 에이전트만 하는 일을 읽을 수 있습니다", t));
    else if (!v) items.push(this.note("기록을 읽는 중", t));
    else if (v.empty) items.push(this.note("대화 기록을 찾지 못했습니다", t));
    else items.push(...this.activity(r, v, t));

    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(this.icon(r.program, 16, t))
        .child(div().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(r.title))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where))
        .when(r.kind === "rec", (el) => el.child(btn("agent-go-parent", "부모로 이동", () => this.go(r.top))))
        .when(r.kind !== "rec", (el) => el
          .child(btn("agent-go", "터미널로 이동", () => this.go(r)))
          .child(btn("agent-peek", "엿보기", () => run("terminal.peek", { terminal: r.address })))))
      .child(v_flex().id("agent-detail").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(2).text_size(13).children(items));
  }

  note(text, t) {
    return div().pt(14).text_size(12).text_color(t.dim).child(text);
  }

  // 활동: 요청 → 마지막 말 → 이번 턴 → 서브에이전트 → 고친 파일 → 읽은 파일
  activity(r, v, t) {
    const out = [];
    const head = (text) => div().pt(16).pb(4).text_size(12).font_semibold().text_color(t.muted).child(text);
    const kindOf = (k) => KIND[k] ?? ["other", t.muted];
    const icon = (k) => svg(`${ME}/icons/act_${kindOf(k)[0]}.svg`).size(13).flex_none().text_color(kindOf(k)[1]);
    const spin = () => svg(SPINNER).size(13).flex_none().text_color(t.working).spin(900);
    const place = (p) => {
      const h = HOME(p);
      if (v.cwd && p.startsWith(v.cwd + "/")) return ["프로젝트", p.slice(v.cwd.length + 1)];
      const tmp = /^\/(private\/)?tmp\/claude-[^/]+\/[^/]+\/[^/]+\/(scratchpad\/)?(.*)$/.exec(p);
      if (tmp) return ["클로드 임시", tmp[3]];
      if (h && p.startsWith(`${h}/.claude/`)) return ["클로드", p.slice(h.length + 9)];
      if (h && p.startsWith(`${h}/.config/herdr-app/`)) return ["Herdr", p.slice(h.length + 20)];
      if (h && p.startsWith(h + "/")) return ["홈", `~/${p.slice(h.length + 1)}`];
      return [null, p];
    };
    const short = (k, target) => (["읽음", "수정", "작성"].includes(k) && target ? place(target)[1].split("/").pop() : target);

    // 서브에이전트에게 준 지시는 길어서 앞부분만
    const ask = r.kind === "rec" && v.ask.length > 320 ? `${v.ask.slice(0, 320).trimEnd()}…` : v.ask;
    if (ask) out.push(head(r.kind === "rec" ? "맡은 일" : "요청"), div().text_size(13).text_color(t.foreground).child(ask));
    if (v.say) out.push(head("마지막 말"), div().text_size(12).text_color(t.muted).child(v.say));

    if (v.flow.length) {
      out.push(head(`이번 턴 · 도구 ${v.tools}번${v.askAt ? ` · ${ago(v.askAt)} 시작` : ""}`));
      if (v.hidden) out.push(div().pl(19).text_size(11).text_color(t.dim).child(`앞의 ${v.hidden}묶음 생략`));
      out.push(...v.flow.map((f, i) => h_flex().id(`agent-flow-${i}`).gap(6).items_center().min_h(20)
        .child(f.running ? spin() : icon(f.kind))
        .child(div().flex_none().text_size(12).text_color(f.running ? t.foreground : kindOf(f.kind)[1]).when(f.running, (x) => x.font_semibold())
          .child(`${f.kind}${f.n > 1 ? ` ×${f.n}` : ""}`))
        .when(Boolean(f.target), (x) => x.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(short(f.kind, f.target))))));
    } else if (!v.ask) out.push(this.note("이번 턴에 한 일이 아직 없습니다", t));

    // 서브에이전트: 누르면 그 서브에이전트를 고른다(목록에 있을 때)
    // 기록 끝에서 띄운 줄이 잘려 나간 서브에이전트도 터미널의 records로 채운다
    const extra = r.kind === "rec" ? [] : this.rows.filter((x) => x.kind === "rec" && x.address === r.address && !v.agents.some((g) => g.agentId === x.sub))
      .map((x) => ({ agentId: x.sub, what: x.title, type: "", running: x.status === "working", at: null }));
    const subs = [...v.agents, ...extra];
    if (subs.length) {
      out.push(head(`서브에이전트 ${subs.length}`));
      out.push(...subs.map((g, i) => {
        const key = g.agentId ? `${r.address}#${g.agentId}` : null;
        const there = key && this.rows.some((x) => x.key === key);
        const state = g.running ? `작업 중${g.at ? ` · ${dur(Date.now() - g.at)}` : ""}` : g.failed ? "실패" : [
          "완료", Number.isFinite(g.tools) ? `도구 ${g.tools}번` : null,
          Number.isFinite(g.ms) ? (g.ms < 60000 ? `${Math.round(g.ms / 1000)}초` : `${Math.round(g.ms / 60000)}분`) : null,
        ].filter(Boolean).join(" · ");
        return h_flex().id(`agent-sub-${i}`).gap(6).items_center().min_h(22).rounded(4)
          .when(Boolean(there), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.select(key, cx)))
          .child(g.running ? spin() : icon("서브에이전트"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(g.what))
          .when(Boolean(g.type), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(g.type)))
          .child(div().flex_none().text_size(11).text_color(g.running ? t.working : g.failed ? t.blocked : t.muted).child(state));
      }));
    }

    const files = (title, list, more) => {
      if (!list.length) return;
      out.push(head(`${title} ${list.length + more}`));
      out.push(...list.map((f) => {
        const [at, path] = place(f.path);
        return h_flex().gap(6).items_center().min_h(20)
          .child(icon(f.kind))
          .when(Boolean(at), (x) => x.child(div().flex_none().text_size(11).text_color(PLACE[at] ?? t.muted).child(at)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(path));
      }));
      if (more) out.push(div().pl(19).text_size(11).text_color(t.dim).child(`외 ${more}개`));
    };
    files("고친 파일", v.edited, v.moreEdited);
    files("읽은 파일", v.read, v.moreRead);
    return out;
  }
}

// 홈 폴더: 경로 앞부분(/Users/<이름>, /home/<이름>)에서 읽는다. 원격 에이전트도 그 머신의 홈으로 줄인다.
function HOME(p) {
  return /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/)/.exec(p)?.[1] ?? null;
}
