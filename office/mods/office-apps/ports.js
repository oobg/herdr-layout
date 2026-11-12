// office-apps의 포트 앱: 열려 있는(LISTEN) TCP 포트와 그것을 띄운 터미널을 본다.
//   왼쪽: 툴바(시스템 포트 보기 · 다시 읽기) + 기기별 머리줄(이 Mac, 원격) 아래 포트 줄(":3000" · 프로세스 · 스페이스 › 탭 또는 "터미널 밖")
//   오른쪽: 포트·주소·pid·명령줄·띄운 터미널, 동작(브라우저로 열기 · 그 터미널로 가기 · 종료)
// 데이터: 기기마다 sh 스크립트 한 번(ports/parse.js의 SCRIPT: macOS lsof, Linux ss 또는 /proc/net/tcp, 공통 ps).
//   터미널마다 hc get으로 셸(뿌리) pid를 한 번 얻어 두고(office-resources와 같게), 리스닝 pid의 조상 체인에서 가장 가까운 셸을 찾는다.
// 갱신: 이 앱이 그려지는 동안만 5초마다(에이전트 앱과 같은 방식: 알렸는데 그려지지 않았으면 멈추고, 다시 그려지면 깨운다).
// 종료는 확인 창(menu.js Confirm) → ACTIONS["ports.kill"]이 pid의 명령줄이 그대로인지 다시 보고 kill -TERM.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, spaces, panes, terminals, machines, layout, run, notify, shared, setShared, openOverlay, closeOverlay } from "herdr";
import { ACTIONS } from "./menu.js";
import { SCRIPT, parseAll, order } from "./ports/parse.js";

const ME = "mods/office-apps";
const LOCAL = "";                          // 이 Mac의 키
const TICK = "office-apps.ports.tick";     // 종료 뒤 다시 읽으라는 신호
const EVERY = 5000;
const CODE_FONT = "D2Coding";
const TOOL = { sys: "#9da9a0", refresh: "#7fbbb3" };
const DANGER = "#e67e80";

const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);
const spaceLabel = (name) => (name === "~" ? "홈" : name);
const keyOf = (m, p) => `${m}|${p.port}|${p.pid ?? ""}`;
const opts = (on, timeout = 10000) => (on ? { on, timeout } : { timeout });

// 확인 창은 따로 뜨는 복사본이라 함수를 넘길 수 없어, 모듈이 불릴 때 동작을 등록해 둔다(menu.js는 고치지 않는다).
// ctx = { pid, port, name, command, on }. 창이 떠 있는 사이 pid가 다른 프로세스에 다시 쓰였을 수 있어 명령줄을 다시 본다.
ACTIONS["ports.kill"] = async (ctx) => {
  const o = opts(ctx.on);
  const title = `:${ctx.port} ${ctx.name}`;
  try {
    const now = await exec("ps", ["-ww", "-o", "command=", "-p", String(ctx.pid)], o);
    if (now.stdout.trim() !== String(ctx.command ?? "").trim()) {
      notify({ title: "이미 끝난 프로세스입니다", body: `${title} · 목록을 다시 읽습니다`, level: "info" });
    } else {
      const r = await exec("kill", ["-TERM", String(ctx.pid)], o);
      if (r.code === 0) notify({ title: "종료 신호를 보냈습니다", body: title, level: "info" });
      else notify({ title: `${title}을(를) 종료하지 못했습니다`, body: (r.stderr || r.stdout || "").trim().slice(0, 200), level: "error" });
    }
  } catch (e) {
    notify({ title: `${title}을(를) 종료하지 못했습니다`, body: String(e?.message ?? e).slice(0, 200), level: "error" });
  }
  setShared(TICK, Date.now());
};

// 그 터미널로: 스페이스·탭을 고르고 패인(없으면 엿보기)으로. office 레이아웃이면 터미널 칸을 연다(office-resources goTo와 같게).
function goTo(sp, tab, address) {
  run("space.select", { id: sp.id });
  run("tab.select", { id: tab });
  if (panes().some((p) => p.terminal === address)) run("pane.focus", { terminal: address });
  else run("terminal.peek", { terminal: address });
  if (JSON.stringify(layout() ?? {}).includes('"office-term"')) {
    run("layout.show", { id: "office-term" });
    setShared("office.open", sp.id);
  }
}

export class PortsApp {
  init(_p, cx) {
    this.data = new Map();      // 기기 키 → { name, os, ports, error }
    this.roots = new Map();     // 터미널 주소 → { pid, tab } (hc get 한 번)
    this.asking = new Set();
    this.loaded = false;
    this.timer = null; this.busy = false; this.again = false;
    this.rendered = 0; this.notified = 0;
    this.tick = shared(TICK);
    try { this.showSys = JSON.parse(localStorage.getItem("ports.sys") ?? "false") === true; } catch { this.showSys = false; }
    try { this.sel = JSON.parse(localStorage.getItem("ports.sel") ?? "null"); } catch { this.sel = null; }
    this.loop(cx, 0);
  }

  dispose() {
    this.disposed = true;
    this.timer?.cancel(); this.timer = null;
  }

  // ── 갱신 ───────────────────────────────────────────────
  // 렌더마다 부른다: 멈춰 있으면 다시 건다
  ensure(cx) {
    this.rendered = Date.now();
    if (shared(TICK) !== this.tick) { this.tick = shared(TICK); this.kick(cx); return; }
    if (!this.timer && !this.busy) this.loop(cx, this.at ? Math.max(0, EVERY - (Date.now() - this.at)) : 0);
  }

  kick(cx) {
    if (this.busy) { this.again = true; return; }
    this.timer?.cancel(); this.timer = null;
    this.urgent = true;
    this.loop(cx, 0);
  }

  loop(cx, delay) {
    if (this.disposed) return;
    this.timer = cx.timer.after(delay, (cx) => {
      this.timer = null;
      if (this.disposed) return;
      // 지난번 알렸는데 그려지지 않았다: 안 보이는 중이니 멈춘다(다시 그려지면 ensure가 깨운다)
      if (!this.urgent && this.notified > this.rendered) return;
      this.urgent = false;
      this.busy = true;
      cx.spawn(async (cx) => {
        try { await this.read(); } catch { /* 다음 차례에 다시 */ }
        this.busy = false; this.loaded = true; this.at = Date.now();
        const again = this.again; this.again = false;
        this.notified = Date.now(); cx.notify();
        this.urgent = again;   // 다시 읽기를 바로 이어 할 때는 그리기 전이라도 건너뛰지 않는다
        this.loop(cx, again ? 0 : EVERY);
      });
    });
  }

  // 목록에 보일 기기: 이 Mac + 레이아웃·스페이스에 보이는 원격 기기(이름순)
  machineList() {
    const state = new Map((machines() ?? []).filter((m) => m.name).map((m) => [m.name, m.layout]));
    const names = new Set([...state.keys(), ...spaces().map((s) => s.machine).filter(Boolean)]);
    return [{ key: LOCAL, name: null, layout: "ready" },
      ...[...names].sort((a, b) => a.localeCompare(b)).map((n) => ({ key: n, name: n, layout: state.get(n) ?? null }))];
  }

  async read() {
    const terms = (terminals() ?? []).filter((t) => t.state === "live" || t.state == null);
    const live = new Set(terms.map((t) => t.address));
    for (const a of [...this.roots.keys()]) if (!live.has(a)) this.roots.delete(a);
    // 새 터미널만 hc get (셸 pid는 터미널이 살아 있는 동안 같다)
    await Promise.all(terms.filter((t) => !this.roots.has(t.address) && !this.asking.has(t.address)).map(async (t) => {
      this.asking.add(t.address);
      try {
        const r = await hc(["get", t.address, "--json"]);
        if (r.code !== 0) return;
        const d = JSON.parse(r.stdout);
        const m = machineOf(t.address), tab = d.labels?.["herdr.tab"];
        this.roots.set(t.address, { pid: d.pid ?? d.foreground?.pid ?? null, tab: tab ? (m ? `${m}/${tab}` : tab) : null });
      } catch { /* 다음 주기에 다시 */ } finally { this.asking.delete(t.address); }
    }));
    // 기기마다 스크립트 한 번. 한 기기가 실패해도 다른 기기는 그대로.
    const list = this.machineList();
    const next = new Map();
    await Promise.all(list.map(async (m) => {
      const prev = this.data.get(m.key);
      if (m.name && m.layout === "unavailable") { next.set(m.key, { ...prev, name: m.name, ports: [], error: "연결되지 않았습니다" }); return; }
      const roots = new Map();
      for (const [a, r] of this.roots) if ((machineOf(a) ?? LOCAL) === m.key && r.pid != null) roots.set(r.pid, a);
      try {
        const r = await exec("sh", ["-c", SCRIPT], opts(m.name));
        const { os, ports, ok, pids } = parseAll(r.stdout, roots);
        if (!ok) throw new Error((r.stderr || "출력이 없습니다").trim().slice(0, 120));
        // 셸이 바뀌었으면(keep 터미널 등) pid가 사라진다: 다음 주기에 hc get을 다시 묻는다
        for (const [pid, a] of roots) if (!pids.has(pid)) this.roots.delete(a);
        next.set(m.key, { name: m.name, os, ports, error: null });
      } catch (e) {
        next.set(m.key, { name: m.name, os: prev?.os, ports: prev?.ports ?? [], error: `포트를 읽지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}` });
      }
    }));
    this.data = next;
  }

  // ── 목록 ───────────────────────────────────────────────
  // 터미널 주소 → { sp, tab, label }. 패인 → hc get 라벨 → (hc run 터미널이면) 부모의 탭.
  whereOf(address) {
    if (!address) return null;
    const byAddr = new Map((terminals() ?? []).map((t) => [t.address, t]));
    const paneTab = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.tab]));
    const tabOf = (a, depth = 0) => {
      if (depth > 8) return null;
      const t = paneTab.get(a) ?? this.roots.get(a)?.tab;
      if (t) return t;
      const parent = byAddr.get(a)?.parent;
      return parent ? tabOf(parent, depth + 1) : null;
    };
    const id = tabOf(address);
    for (const sp of spaces()) {
      const tb = sp.tabs.find((x) => x.id === id);
      if (tb) return { sp, tab: tb.id, label: `${spaceLabel(sp.name)} › ${tb.name || tb.index + 1}` };
    }
    return null;
  }

  // 기기별 묶음: [{ m, d, shown: [포트], hidden: n }]
  groups() {
    return this.machineList().map((m) => {
      const d = this.data.get(m.key);
      const all = order(d?.ports ?? []);
      const shown = this.showSys ? all : all.filter((p) => !p.system);
      return { m, d, shown: shown.map((p) => ({ ...p, key: keyOf(m.key, p), machine: m.name })), hidden: all.length - shown.length };
    });
  }

  rows() { return this.groups().flatMap((g) => g.shown); }
  // 고른 줄. 없거나 숨겨졌으면 첫 줄을 고른다(목록·상세 어느 쪽이 먼저 그려져도 같게).
  current(rows = this.rows()) {
    const r = rows.find((x) => x.key === this.sel);
    if (r || !rows.length) return r ?? null;
    this.pick(rows[0].key);
    return rows[0];
  }

  pick(key) {
    this.sel = key;
    try { localStorage.setItem("ports.sel", JSON.stringify(key)); } catch { /* 이번 실행 동안만 */ }
  }

  toggleSys(cx) {
    this.showSys = !this.showSys;
    try { localStorage.setItem("ports.sys", JSON.stringify(this.showSys)); } catch { /* 이번 실행 동안만 */ }
    cx?.notify?.();
  }

  // ── 셸 계약 ────────────────────────────────────────────
  move(delta, cx) {
    const rows = this.rows();
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.key === this.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + delta));
    this.pick(rows[j].key);
    cx?.notify?.();
  }

  // Enter: 이 Mac 포트면 브라우저로, 원격이면 띄운 터미널로(종료는 Enter에 두지 않는다)
  activate(_cx) {
    const r = this.current();
    if (!r) return;
    if (!r.machine) return this.openBrowser(r);
    const w = this.whereOf(r.term);
    if (w) goTo(w.sp, w.tab, r.term);
  }

  emptyState() {
    if (!this.loaded) return { text: "포트를 읽는 중", sub: "" };
    const hidden = this.groups().reduce((n, g) => n + g.hidden, 0);
    return { text: "열려 있는 포트가 없습니다", sub: hidden ? `시스템 포트 ${hidden}개는 숨겨 두었습니다 · 툴바의 눈 단추로 봅니다` : "개발 서버를 띄우면 여기에 보입니다" };
  }

  subtitle(t) {
    const n = this.rows().length;
    return div().truncate().text_size(12).text_color(t.dim).child(this.loaded ? `포트 ${n}개` : "");
  }

  toolbar(t) {
    const btn = (id, icon, color, tip, on, fn) => div().id(`pt-${id}`).p(4).rounded(4).flex_none().cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); })
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.hideTip(); fn(cx); cx.notify(); })
      .child(svg(icon).size(16).text_color(color));
    // 한 자리 토글: 숨기는 중(걸러 내는 중)이면 빗금 눈 + 배경
    return h_flex().min_h(32).flex_none().py(2).px(6).gap(2).items_center().border_b_1().border_color(t.border)
      .child(btn("sys", `${ME}/${this.showSys ? "eye" : "eye-off"}.svg`, TOOL.sys,
        this.showSys ? "시스템 포트 보는 중 · 누르면 숨기기" : "시스템 포트 숨김 · 누르면 보기", !this.showSys, (cx) => this.toggleSys(cx)))
      .child(div().flex_1())
      .child(btn("refresh", `${ME}/refresh.svg`, this.busy ? t.dim : TOOL.refresh, "다시 읽기", false, (cx) => this.kick(cx)));
  }

  row(r, t) {
    const w = this.whereOf(r.term);
    return v_flex().id(`pt-row-${r.key}`).flex_none().px(8).py(4).gap(1).rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(this.sel === r.key, (el) => el.bg(t.selected))
      .on_click((e, cx) => { this.pick(r.key); if (e.click_count >= 2) this.activate(cx); cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().font_family(CODE_FONT).text_size(12.5).text_color(t.foreground).child(`:${r.port}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.name)))
      .child(div().truncate().text_size(11).text_color(w ? t.muted : t.dim).child(w ? w.label : "터미널 밖"));
  }

  list(cx, t) {
    this.ensure(cx);
    const groups = this.groups();
    this.current(groups.flatMap((g) => g.shown));
    const many = groups.length > 1;
    const body = [];
    for (const g of groups) {
      body.push(h_flex().flex_none().px(8).pt(many ? 8 : 4).pb(2).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.muted).child(g.m.name ?? "이 Mac"))
        .when(g.hidden > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`시스템 ${g.hidden}개 숨김`))));
      if (g.d?.error) body.push(div().px(8).py(2).text_size(11).text_color(t.dim).child(g.d.error));
      else if (!g.shown.length) body.push(div().px(8).py(2).text_size(11).text_color(t.dim).child(this.loaded ? "열린 포트 없음" : "읽는 중"));
      for (const r of g.shown) body.push(this.row(r, t));
    }
    return v_flex().flex_1().min_h(0)
      .child(this.toolbar(t))
      .child(v_flex().id("pt-list").flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1).children(body));
  }

  // ── 상세 ───────────────────────────────────────────────
  detail(cx, t) {
    const r = this.current();
    if (!r) return null;
    const w = this.whereOf(r.term);
    const btn = (id, text, fn, danger = false) => div().id(id).px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12).flex_none()
      .text_color(danger ? DANGER : t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn)
      .child(text);
    const line = (k, v, mono = false) => h_flex().gap(12).items_start()
      .child(div().w(76).flex_none().text_color(t.muted).child(k))
      .child(div().flex_1().min_w(0).text_color(t.foreground).when(mono, (el) => el.font_family(CODE_FONT).text_size(12.5)).child(v));
    const info = [
      line("포트", String(r.port), true),
      line("주소", r.addrs.join(", "), true),
      r.pid != null ? line("pid", String(r.pid), true) : null,
      r.command ? line("명령줄", r.command, true) : null,
      h_flex().gap(12).items_start()
        .child(div().w(76).flex_none().text_color(t.muted).child("띄운 터미널"))
        .child(div().flex_1().min_w(0).text_color(w ? t.foreground : t.dim).child(w ? w.label : "터미널 밖")),
      r.machine ? line("기기", r.machine) : null,
    ].filter(Boolean);
    return v_flex().id("pt-root").size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_none().font_family(CODE_FONT).text_size(14).font_semibold().text_color(t.foreground).child(`:${r.port}`))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(r.name))
        .when(!r.machine, (el) => el.child(btn("pt-open", "브라우저로 열기", () => this.openBrowser(r))))
        .when(Boolean(w), (el) => el.child(btn("pt-go", "그 터미널로 가기", () => goTo(w.sp, w.tab, r.term))))
        .when(r.pid != null, (el) => el.child(btn("pt-kill", "종료…", () => this.confirmKill(r), true))))
      .child(v_flex().id("pt-detail").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(12).gap(6)
        .children(info)
        .when(r.all, (el) => el.child(div().pt(4).text_size(12).text_color(t.dim).child("같은 네트워크에서 접속할 수 있습니다"))));
  }

  openBrowser(r) {
    const url = `http://localhost:${r.port}`;
    exec("open", [url]).then((x) => {
      if (x.code !== 0) notify({ title: "브라우저를 열지 못했습니다", body: (x.stderr || url).trim().slice(0, 200), level: "error" });
    }, (e) => notify({ title: "브라우저를 열지 못했습니다", body: String(e?.message ?? e).slice(0, 200), level: "error" }));
  }

  confirmKill(r) {
    openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 210, props: {
      role: "confirm", action: "ports.kill", title: `:${r.port} ${r.name} 종료`, yes: "종료", danger: true,
      ctx: { pid: r.pid, port: r.port, name: r.name, command: r.command, on: r.machine ?? null },
      detail: r.command || `pid ${r.pid}`,
    } });
  }

  // 툴팁: files.js와 같은 창 오버레이(role "tip")를 같은 key로 띄운다.
  showTip(id, text, b) {
    this.hideTip();
    if (!b) return;
    const w = Math.round([...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 12 : 7), 0) + 20);
    this.tipFor = id;
    this.tipId = openOverlay({ mod: "office-apps", kind: "window", key: "office-apps-tip", frame: "none", width: w, height: 26,
      at: { x: Math.max(4, Math.round(b.x + b.width / 2 - w / 2)), y: Math.max(4, Math.round(b.y - 30)) },
      props: { role: "tip", text } });
  }

  hideTip() {
    if (this.tipId) closeOverlay(this.tipId);
    this.tipId = null; this.tipFor = null;
  }
}
