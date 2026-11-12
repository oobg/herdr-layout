// office-apps의 출력 감시 앱: 셸·개발 서버·테스트 터미널의 출력에서 오류 줄을 모아 본다(iTerm2 Triggers·Captured Output처럼).
//   왼쪽: 머리줄(에이전트 포함 · 모두 지우기) + 걸린 줄 목록(최근 순). 줄 = 터미널(스페이스 › 탭 · 프로그램) · 시각 / 걸린 줄 앞부분(모노 12) · ×n
//   오른쪽: 걸린 줄과 앞뒤 2줄 문맥(모노), 동작 = 그 터미널로 가기 · 에이전트에게 보내기(같은 스페이스의 에이전트에게 hc send) · 지우기
// 대상: panes()의 터미널 중 에이전트가 아닌 것(에이전트 앱 withSilent와 같은 판정). 에이전트는 "에이전트 포함"을 켜면 본다.
//   git·less·vim처럼 글을 보여 주기만 하는 프로그램은 코드·문서의 "error"가 걸리므로 늘 뺀다.
// 데이터: 터미널마다 `hc read <주소> --json --lines 1000`(원격은 주소에 machine/이 붙어 hc가 처리한다).
//   지난번 글과 같으면 건너뛰고, 다르면 새로 생긴 줄만 규칙에 넣는다(watch/rules.js: fresh·scan·merge).
//   처음 읽을 때는 읽은 창 전체를 본다: 이 앱은 보일 때만 읽으므로, 열기 전에 난 오류가 사람이 보러 온 것이다.
// 갱신: 이 앱이 그려지는 동안만 10초마다. 매 차례 끝에 다시 그리라고 알리고, 알렸는데 그려지지 않았으면(다른 앱·칸 숨김) 멈춘다.
// "에이전트에게 보내기"는 작업 중이면 확인 창(menu.js Confirm) → ACTIONS["watch.send"].
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { hc, panes, spaces, agents, layout, run, setShared, openOverlay, notify } from "herdr";
import { ACTIONS } from "./menu.js";
import { lines, fresh, scan, merge, fillAfter, message } from "./watch/rules.js";

const EVERY = 10000;
const HISTORY = "1000";      // 숨어 있던 동안 쌓인 출력까지 보도록 넉넉히
const CODE_FONT = "D2Coding";
const SILENT_AGENT = /claude|codex|grok|antigravity|gemini|cursor|opencode|\bamp\b|\bpi\b/i;
// 글을 보여 주기만 하는 프로그램(페이저·편집기·모니터): 화면의 코드·문서가 걸리므로 보지 않는다
const VIEWER = /^(git|less|more|most|man|bat|vi|vim|nvim|neovim|nano|emacs|hx|helix|micro|htop|btop|top|lazygit|tig|gitui|yazi|ranger|lf|nnn)$/i;
const STATUS = { working: "작업 중", blocked: "입력 대기", done: "끝남", idle: "대기 중" };

const isAgent = (p) => Boolean(p.status || p.program?.agent || SILENT_AGENT.test(p.program?.key ?? ""));
const isViewer = (p) => VIEWER.test(p.program?.key ?? "") || VIEWER.test(p.program?.name ?? "");
const spaceLabel = (name) => (name === "~" ? "홈" : name);
const two = (n) => String(n).padStart(2, "0");
function clock(at) {
  const d = new Date(at), today = new Date().toDateString() === d.toDateString();
  return today ? `${two(d.getHours())}:${two(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
function load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 못 해도 동작은 같다 */ } }

// 터미널 → { address, space, tab, name, program, agent }  (탭 → 스페이스는 spaces()에서)
function terminalsNow() {
  const where = new Map();
  for (const s of spaces()) for (const t of s.tabs) where.set(t.id, { s, t });
  return (panes() ?? []).filter((p) => p.terminal && where.has(p.tab)).map((p) => {
    const { s, t } = where.get(p.tab);
    const prog = p.program?.name || p.title || "터미널";
    return { address: p.terminal, space: s.id, tab: t.id, program: p.program ?? null, agent: isAgent(p), viewer: isViewer(p),
      name: `${spaceLabel(s.name)} › ${t.name} · ${prog}` };
  });
}

// 그 터미널로: 스페이스·탭을 고르고 패인으로. office 레이아웃이면 터미널 칸을 연다(포트 앱 goTo와 같게).
function goTo(address) {
  const x = terminalsNow().find((m) => m.address === address);
  if (!x) { notify({ title: "터미널이 닫혔습니다", body: "이 오류가 난 터미널을 찾지 못했습니다", level: "info" }); return; }
  run("space.select", { id: x.space });
  run("tab.select", { id: x.tab });
  run("pane.focus", { terminal: address });
  if (JSON.stringify(layout() ?? {}).includes('"office-term"')) {
    run("layout.show", { id: "office-term" });
    setShared("office.open", x.space);
  }
}

// 같은 스페이스에서 받을 에이전트: 같은 탭 → 포커스된 것 → 첫 번째. 그 터미널 자신은 빼고, 입력 대기는 맨 뒤.
function recipient(term) {
  if (!term) return null;
  const list = (agents() ?? []).filter((a) => a.space === term.space && a.address !== term.address);
  const rank = (a) => (a.tab === term.tab ? 0 : 2) + (a.focused ? 0 : 1) + (a.status === "blocked" ? 4 : 0);
  return list.slice().sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
const agentName = (a) => (a.tab_name && a.tab_name !== String(a.tab_index) ? `${a.program?.name || a.title} (${a.tab_name})` : a.program?.name || a.title || a.address);

// 확인 창은 따로 뜨는 복사본이라 값만 받는다: ctx = { address, name, text }
async function send(ctx) {
  const r = await hc(["send", ctx.address, ctx.text, "--json"]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  if (r.code === 0) notify({ title: "에이전트에게 보냈습니다", body: ctx.name, level: "info" });
  else notify({ title: `${ctx.name}에게 보내지 못했습니다`, body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
}
ACTIONS["watch.send"] = send;

export class WatchApp {
  init(_p, _cx) {
    this.items = [];                 // 걸린 줄(watch/rules.js merge), 최근 순
    this.seen = {};                  // 주소 → { text, lines, how }  지난번 읽은 것
    this.names = {};                 // 주소 → 이름(터미널이 닫혀도 목록에 남기려고)
    this.sel = null;
    this.withAgents = load("watch.agents", false);
    this.loaded = false; this.targets = [];
    this.timer = null; this.busy = false; this.disposed = false;
    this.rendered = 0; this.notified = 0;
  }

  // ── 대상과 읽기 ────────────────────────────────────────
  watched() {
    return terminalsNow().filter((x) => !x.viewer && (this.withAgents || !x.agent));
  }

  ensure(cx) {
    this.rendered = Date.now();
    this.targets = this.watched();
    if (!this.timer && !this.busy) this.loop(cx, 0);
  }

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
        try { await this.refresh(); } catch { /* 다음 차례에 다시 */ }
        this.busy = false; this.loaded = true;
        // 매 차례 알린다: 그려지지 않으면 다음 차례에 멈추게(숨은 동안 계속 읽지 않도록)
        this.notified = Date.now(); cx.notify();
        this.loop(cx, EVERY);
      });
    });
  }

  async refresh() {
    const targets = this.watched();
    const live = new Set(targets.map((x) => x.address));
    for (const k of Object.keys(this.seen)) if (!live.has(k)) delete this.seen[k];   // 닫혔거나 뺀 터미널은 기준을 버린다
    for (const x of targets) {
      this.names[x.address] = x.name;
      const r = await hc(["read", x.address, "--json", "--lines", HISTORY]).catch(() => null);
      if (!r || r.code !== 0) continue;
      let d; try { d = JSON.parse(r.stdout); } catch { continue; }
      const prev = this.seen[x.address];
      if (prev && prev.text === d.text) continue;            // 그대로면 건너뛴다
      const cur = lines(d.text);
      const how = d.how ?? "history";
      // 전체 화면 앱으로 바뀌거나 돌아왔으면 기준이 맞지 않는다: 새 줄만 더하고 세지는 않는다
      const f = fresh(prev && prev.how === how ? prev.lines : prev ? [] : null, cur, how);
      const now = Date.now();
      if (f.screen) {
        this.items = merge(this.items, x.address, scan(cur, f.idx), now, false);
      } else {
        if (f.overlap) this.items = fillAfter(this.items, x.address, cur.slice(f.start));
        this.items = merge(this.items, x.address, scan(cur, f.start), now, f.overlap);
      }
      this.seen[x.address] = { text: d.text, lines: cur, how };
    }
  }

  // ── 셸 계약 ────────────────────────────────────────────
  current() { return this.items.find((x) => x.id === this.sel) ?? null; }

  select(id, cx) { this.sel = id; cx?.notify(); }

  move(d, _cx) {
    if (!this.items.length) return;
    const i = this.items.findIndex((x) => x.id === this.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(this.items.length - 1, i + d));
    this.sel = this.items[j].id;
  }

  activate(_cx) {
    const x = this.current();
    if (x) goTo(x.terminal);
  }

  emptyState() {
    if (!this.loaded) return { text: "출력을 읽는 중", sub: "" };
    if (!this.targets.length) return { text: "볼 터미널이 없습니다", sub: "셸·개발 서버·테스트 터미널을 열면 여기서 오류를 모읍니다" };
    return { text: "걸린 오류가 없습니다", sub: `터미널 ${this.targets.length}개의 출력을 10초마다 봅니다` };
  }

  subtitle(t) {
    return div().text_size(12).text_color(t.dim).truncate().child(`터미널 ${this.targets.length}개 보는 중`);
  }

  dismiss(id, cx) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.sel === id) this.sel = this.items[Math.min(i, this.items.length - 1)]?.id ?? null;
    cx.notify();
  }

  // ── 그리기 ─────────────────────────────────────────────
  prepare(cx) {
    this.ensure(cx);
    if (!this.current()) this.sel = this.items[0]?.id ?? null;
  }

  list(cx, t) {
    this.prepare(cx);
    const tool = (id, text, fn, on) => div().id(id).flex_none().px(6).py(2).rounded(4).text_size(12).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(fn).child(text);
    const head = h_flex().h(32).flex_none().px(6).gap(4).items_center().border_b_1().border_color(t.border)
      .child(tool("watch-agents", this.withAgents ? "✓ 에이전트 포함" : "에이전트 포함", (_e, cx) => {
        this.withAgents = !this.withAgents; save("watch.agents", this.withAgents);
        this.targets = this.watched(); cx.notify();
      }, this.withAgents))
      .child(div().flex_1())
      .when(this.items.length > 0, (el) => el.child(tool("watch-clear", "모두 지우기", (_e, cx) => { this.items = []; this.sel = null; cx.notify(); }, false)));

    const body = v_flex().id("watch-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
      .when(!this.items.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.loaded ? "없음" : "읽는 중")))
      .children(this.items.map((x) => {
        const on = x.id === this.sel;
        return v_flex().id(`watch-${x.id}`).h(44).flex_none().justify_center().gap(2).px(8).rounded(4).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((e, cx) => { this.select(x.id, cx); if (e.click_count >= 2) goTo(x.terminal); })
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.names[x.terminal] ?? x.terminal))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(clock(x.last))))
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().font_family(CODE_FONT).text_size(12).text_color(t.foreground).child(x.line.trim()))
            .when(x.count > 1, (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`×${x.count}`))));
      }));
    return v_flex().flex_1().min_h(0).child(head).child(body);
  }

  detail(cx, t) {
    this.prepare(cx);
    const x = this.current();
    if (!x) return null;
    const term = terminalsNow().find((m) => m.address === x.terminal) ?? null;
    const to = recipient(term);
    const btn = (id, text, fn) => div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn).child(text);
    const note = (text) => div().flex_none().text_size(12).text_color(t.dim).child(text);

    const sendIt = () => {
      if (!to) return;
      const ctx = { address: to.address, name: agentName(to), text: message(this.names[x.terminal] ?? x.terminal, x) };
      if (to.status === "working") {
        openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: { role: "confirm", action: "watch.send",
          title: "작업 중인 에이전트에게 보낼까요?", ctx, yes: "보내기",
          detail: `${ctx.name}이(가) 지금 작업 중입니다. 보내면 하던 일 사이에 이 오류 내용이 들어갑니다.` } });
      } else send(ctx);
    };

    const mono = (l, hit) => div().font_family(CODE_FONT).text_size(12).min_h(18)
      .text_color(hit ? t.foreground : t.muted).when(hit, (el) => el.font_semibold()).child(l || " ");
    const meta = [x.count > 1 ? `${x.count}번 · 처음 ${clock(x.first)} · 마지막 ${clock(x.last)}` : clock(x.last)];
    if (!term) meta.push("터미널이 닫혔습니다");

    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(this.names[x.terminal] ?? x.terminal))
        .when(Boolean(term), (el) => el.child(btn("watch-go", "그 터미널로 가기", () => goTo(x.terminal))))
        .when(Boolean(term && to), (el) => el.child(btn("watch-send", `${to.program?.name || "에이전트"}에게 보내기`, sendIt)))
        .when(Boolean(term && !to), (el) => el.child(note("이 스페이스에 에이전트가 없습니다"))))
      .child(v_flex().id("watch-detail").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(10)
        .child(div().text_size(12).text_color(t.dim).child(meta.join(" · ")))
        .child(v_flex().gap(1)
          .children([...x.before.map((l) => mono(l, false)), mono(x.line, true), ...x.after.map((l) => mono(l, false))]))
        .when(Boolean(to), (el) => el.child(div().text_size(12).text_color(t.dim)
          .child(`받는 에이전트: ${agentName(to)} · ${STATUS[to.status] ?? "상태 모름"}`)))
        .child(h_flex().child(btn("watch-dismiss", "지우기", (_e, cx) => this.dismiss(x.id, cx)))));
  }
}
