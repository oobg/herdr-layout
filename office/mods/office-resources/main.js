// 리소스 관리자: 사용량 패널 바로 밑에서 Herdr 터미널들이 쓰는 CPU·메모리를 보여 준다.
//   칸 높이가 FULL 이상이면 전체 표(스페이스 → 탭 → 터미널), 모자라면 메모리 한 줄(칩).
//   칸은 레이아웃이 사용량과 비율(6:4)로 나눠 준다. 한 줄일 때 누르면 팝업으로 전체 표를 띄운다.
// 데이터: 터미널마다 hc get으로 셸(뿌리) pid를 한 번 얻어 두고, 3초마다 ps 한 번으로 그 자손 트리 합을 낸다.
//   탭 = 소속 터미널 합, 스페이스 = 탭 합, 요약 = 이 컴퓨터 터미널 전체 합. 다른 기기는 exec on으로 같은 계산을 시도한다.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, hc, run, props, spaces, panes, terminals, machines, window, layout,
  setShared, openOverlay, closeOverlay } from "herdr";
import { SCRIPT, parseAll, treeSum, fmtMem, fmtCpu } from "./calc.js";

const ID = "office-resources";   // 레이아웃 블록 id이자 모드 이름
const FULL = 220;                // 이 높이부터 전체 표
const CHIP = 28;                 // 한 줄 칩 높이 (칸이 더 커도 맨 위에 붙인다)
const EVERY = 3000;              // 갱신 주기(ms)
const SPARK = 30;                // 탭 스파크라인 표본 수
const NUM_FONT = "D2Coding";     // 숫자 칸: 고정폭 글꼴로 자릿수를 맞춘다
const W_CPU = 48, W_MEM = 64;    // 숫자 칸 폭
const TOOL = { refresh: "#7fbbb3", fold: "#9da9a0" };   // 사용량 패널 툴바 색과 같게
const OK = "#a7c080";            // 상태를 보고하지 않는 터미널의 점 (사용량 패널의 정상 색)

const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);

class Panel {
  init(_p, cx) {
    this.popup = props()?.role === "popup";   // 팝업 복사본: 늘 전체 표, 접기 대신 닫기
    this.size = null;
    this.roots = new Map();     // 주소 → { pid, tab } (hc get 한 번; 셸 pid는 터미널이 살아 있는 동안 같다)
    this.asking = new Set();    // hc get 중인 주소
    this.usage = new Map();     // 주소 → { cpu(기기 대비 %), mem(바이트) }
    this.sys = {};              // 기기 이름("" = 이 컴퓨터) → { ncpu, total, used, cpu }
    this.down = new Set();      // 리소스를 못 읽은 기기 이름
    this.hist = {};             // 탭 id → 최근 CPU 표본들
    this.busy = false;
    this.last = 0;
    const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
    this.folded = load("folded", {});     // 스페이스 id → 접힘
    this.details = load("details", false); // 지표 세부 정보 펼침
    this.tick(cx);
    cx.timer.every(EVERY, (cx) => this.tick(cx));
  }

  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 유지 */ } }

  // 보일 때만 읽는다: 앱 창이 앞에 있고, 이 칸이 숨겨지지 않았을 때(팝업은 열려 있는 동안 늘).
  // Herdr는 숨은 복사본의 타이머도 돌리므로 여기서 거른다.
  visible() {
    if (window()?.active === false) return false;
    if (this.popup) return true;
    if (this.size && this.size.height < 4) return false;
    const node = findNode(layout(), ID);
    return !node?.hidden;
  }

  tick(cx, force) {
    if (this.busy || (!force && !this.visible())) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.read();
      } finally {
        this.busy = false;
        this.last = Date.now();
        cx.notify();
      }
    });
  }

  async read() {
    const terms = (terminals() ?? []).filter((t) => t.state === "live" || t.state == null);
    const live = new Set(terms.map((t) => t.address));
    for (const a of [...this.roots.keys()]) if (!live.has(a)) this.roots.delete(a);
    // 새 터미널만 hc get (이미 아는 주소는 다시 묻지 않는다)
    await Promise.all(terms.filter((t) => !this.roots.has(t.address) && !this.asking.has(t.address)).map(async (t) => {
      this.asking.add(t.address);
      try {
        const r = await hc(["get", t.address, "--json"]);
        if (r.code !== 0) return;
        const d = JSON.parse(r.stdout);
        const m = machineOf(t.address);
        const tab = d.labels?.["herdr.tab"];
        this.roots.set(t.address, { pid: d.pid ?? d.foreground?.pid ?? null, tab: tab ? (m ? `${m}/${tab}` : tab) : null });
      } catch { /* 다음 주기에 다시 */ } finally { this.asking.delete(t.address); }
    }));
    // 기기마다 스크립트 한 번: 이 컴퓨터 + 연결된 다른 기기
    const names = [null, ...new Set(spaces().map((s) => s.machine).filter(Boolean))];
    const state = new Map((machines() ?? []).map((m) => [m.name, m.layout]));
    const usage = new Map();
    await Promise.all(names.map(async (m) => {
      const key = m ?? "";
      if (m && state.get(m) === "unavailable") { this.down.add(key); return; }
      try {
        const r = await exec("sh", ["-c", SCRIPT], m ? { on: m, timeout: 8000 } : { timeout: 8000 });
        const { tree, sys } = parseAll(r.stdout);
        if (!tree.procs.size) throw new Error("ps 출력 없음");
        this.sys[key] = sys;
        this.down.delete(key);
        for (const [a, root] of this.roots) {
          if ((machineOf(a) ?? "") !== key || root.pid == null) continue;
          const s = treeSum(tree, root.pid);
          if (s) usage.set(a, { cpu: s.cpu / sys.ncpu, mem: s.mem });
          else this.roots.delete(a);   // pid가 사라짐: 다음 주기에 다시 묻는다
        }
      } catch {
        this.down.add(key);
      }
    }));
    this.usage = usage;
    // 탭 스파크라인 표본
    const model = this.model();
    const seen = new Set();
    for (const sp of model) for (const tb of sp.tabs) {
      seen.add(tb.id);
      const h = (this.hist[tb.id] ??= []);
      h.push(tb.cpu ?? 0);
      if (h.length > SPARK) h.splice(0, h.length - SPARK);
    }
    for (const id of Object.keys(this.hist)) if (!seen.has(id)) delete this.hist[id];
  }

  // 스페이스 → 탭 → 터미널 트리와 합계. 터미널의 탭: 패인 → hc get 라벨 → (서브에이전트면) 부모의 탭.
  model() {
    const terms = terminals() ?? [];
    const byAddr = new Map(terms.map((t) => [t.address, t]));
    const paneTab = new Map();
    for (const p of panes()) if (p.terminal) paneTab.set(p.terminal, p.tab);
    const tabOf = (a, depth = 0) => {
      if (depth > 8) return null;
      const t = paneTab.get(a) ?? this.roots.get(a)?.tab;
      if (t) return t;
      const parent = byAddr.get(a)?.parent;
      return parent ? tabOf(parent, depth + 1) : null;
    };
    const inTab = new Map();
    for (const t of terms) {
      const tab = tabOf(t.address);
      if (!tab) continue;
      if (!inTab.has(tab)) inTab.set(tab, []);
      inTab.get(tab).push(t);
    }
    const add = (a, b) => (a == null ? b : b == null ? a : a + b);
    return spaces().map((sp) => {
      const tabs = sp.tabs.map((tb) => {
        const list = (inTab.get(tb.id) ?? []).map((t) => ({ t, u: this.usage.get(t.address) }));
        let cpu = null, mem = null;
        for (const x of list) { cpu = add(cpu, x.u?.cpu); mem = add(mem, x.u?.mem); }
        return { id: tb.id, name: tb.name, active: tb.active, terms: list, cpu, mem };
      });
      let cpu = null, mem = null;
      for (const tb of tabs) { cpu = add(cpu, tb.cpu); mem = add(mem, tb.mem); }
      return { sp, tabs, cpu, mem };
    });
  }

  // 이동: 그 터미널로. office 레이아웃이면 터미널 칸을 열고 office 모드에 고른 스페이스를 알린다(에이전트 앱 goTo와 같게).
  goTo(sp, tab, address) {
    run("space.select", { id: sp.id });
    run("tab.select", { id: tab });
    // 패인이 있으면 그 패인으로, 없으면(hc run 서브에이전트) 탭 위에 엿보기로 연다.
    if (panes().some((p) => p.terminal === address)) run("pane.focus", { terminal: address });
    else run("terminal.peek", { terminal: address });
    if (findNode(layout(), "office-term")) {
      run("layout.show", { id: "office-term" });
      setShared("office.open", sp.id);
    }
    if (this.popup) closeOverlay(props().overlay);
  }

  // 한 줄에서 누르면: 같은 표를 팝업으로(칩 오른쪽 끝에 맞춰 위쪽으로 띄운다).
  openPopup(e) {
    const b = e?.bounds, w = 300, h = 420;
    openOverlay({ mod: ID, kind: "popup", width: w, height: h, props: { role: "popup" },
      at: b ? { x: Math.max(8, Math.round(b.x + b.width - w)), y: Math.max(8, Math.round(b.y - h - 6)) } : "pointer" });
  }

  render(cx) {
    const t = theme();
    const full = this.popup || (this.size?.height ?? 0) >= FULL;
    return div().id("res-root").size_full()
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(full ? this.full(t, cx) : this.chip(t));
  }

  // 이 컴퓨터 스페이스들의 합(= 표의 스페이스 줄 합). Herdr 탭에 속하지 않은 터미널(다른 앱의 것)은 빠진다.
  total(model = this.model()) {
    let cpu = null, mem = null;
    for (const m of model) {
      if (m.sp.machine) continue;
      if (m.cpu != null) cpu = (cpu ?? 0) + m.cpu;
      if (m.mem != null) mem = (mem ?? 0) + m.mem;
    }
    return { cpu, mem };
  }

  // 한 줄: 메모리 칩 아이콘 + 메모리 합, 흐린 글자. 사용량 카드 밑에 붙어 보이게 테두리 없이.
  chip(t) {
    const { mem } = this.total();
    return h_flex().id("res-chip").w_full().h(CHIP).flex_none().px(14).gap(6).items_center().cursor_pointer()
      .text_color(t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((e) => this.openPopup(e))
      .child(svg(`mods/${ID}/chip.svg`).size(13).flex_none().text_color(t.dim))
      .child(div().text_size(12).font_family(NUM_FONT).child(mem == null ? "—" : fmtMem(mem)));
  }

  // 툴바 버튼: 사용량 패널과 같은 모양(아이콘 16, 기능색, hover 배경), 툴팁은 창 오버레이.
  btn(t, id, icon, color, tip, fn, spin) {
    return div().id(`res-${id}`).p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); })
      .on_click((_e, cx) => { this.hideTip(); fn(cx); cx.notify(); })
      .child(svg(`mods/${ID}/${icon}.svg`).size(16).text_color(color).when(Boolean(spin), (el) => el.spin(900)));
  }

  showTip(id, text, b) {
    this.hideTip();
    if (!b) return;
    const w = Math.round([...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 12 : 7), 0) + 20);
    this.tipFor = id;
    this.tipId = openOverlay({ mod: ID, kind: "window", key: `${ID}-tip`, frame: "none", width: w, height: 26,
      at: { x: Math.max(4, Math.round(b.x + b.width / 2 - w / 2)), y: Math.max(4, Math.round(b.y - 30)) },
      props: { role: "tip", text } });
  }

  hideTip() {
    if (this.tipId) closeOverlay(this.tipId);
    this.tipId = null; this.tipFor = null;
  }

  num(t, text, w, color) {
    return div().w(w).flex_none().flex().justify_end().font_family(NUM_FONT).text_size(12)
      .text_color(color ?? t.muted).child(text);
  }

  full(t, cx) {
    const model = this.model();
    const { cpu, mem } = this.total(model);
    const sys = this.sys[""];
    const card = v_flex().size_full().bg(t.chrome).text_size(13);
    const framed = this.popup ? card : card.rounded(10).border_1().border_color(t.border).overflow_hidden();
    return framed
      // 머리줄: 사용량 패널과 같은 40px, 제목 14 semibold
      .child(h_flex().h(40).pl(14).pr(8).flex_none().items_center().gap(2).border_b_1().border_color(t.border)
        .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child("리소스 관리자"))
        .child(this.btn(t, "refresh", "refresh", TOOL.refresh, this.busy ? "읽는 중" : "지금 새로 고침", (cx) => this.tick(cx, true), this.busy))
        .when(this.popup, (el) => el.child(this.btn(t, "close", "close", TOOL.fold, "닫기", () => closeOverlay(props().overlay)))))
      // 요약: 이 컴퓨터 터미널 합
      .child(h_flex().px(14).pt(10).pb(4).flex_none().items_baseline().gap(6)
        .child(div().text_size(16).font_semibold().font_family(NUM_FONT).text_color(t.foreground).child(fmtCpu(cpu)))
        .child(div().text_size(12).text_color(t.dim).child("CPU"))
        .child(div().w(8))
        .child(div().text_size(16).font_semibold().font_family(NUM_FONT).text_color(t.foreground).child(fmtMem(mem)))
        .child(div().text_size(12).text_color(t.dim).child("메모리")))
      // 지표 세부 정보: 기기 전체 두 줄
      .child(h_flex().id("res-details").px(14).py(4).flex_none().gap(4).items_center().cursor_pointer()
        .text_size(12).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.details = !this.details; this.save("details", this.details); cx.notify(); })
        .child(svg(`mods/${ID}/chevron-${this.details ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child("지표 세부 정보"))
      .when(this.details, (el) => el.child(v_flex().px(14).pl(30).pb(6).flex_none().gap(2).text_size(12).text_color(t.muted)
        .child(h_flex().justify_between()
          .child("이 컴퓨터 CPU")
          .child(div().font_family(NUM_FONT).child(sys ? `${fmtCpu(sys.cpu)} · ${sys.ncpu}코어` : "—")))
        .child(h_flex().justify_between()
          .child("이 컴퓨터 메모리")
          .child(div().font_family(NUM_FONT).child(sys?.total ? `${fmtMem(sys.used)} / ${fmtMem(sys.total)}` : "—")))))
      // 표 머리
      .child(h_flex().h(24).px(14).mt(4).flex_none().items_center().gap(6).border_b_1().border_color(t.border)
        .text_size(12).text_color(t.dim)
        .child(div().flex_1().child("이름"))
        .child(div().w(W_CPU).flex_none().flex().justify_end().child("CPU"))
        .child(div().w(W_MEM).flex_none().flex().justify_end().child("메모리")))
      .child(v_flex().id("res-list").flex_1().min_h(0).overflow_y_scrollbar().py(2).children(this.rows(t, model)));
  }

  rows(t, model) {
    const out = [];
    let machine;
    for (const m of model) {
      const key = m.sp.machine ?? "";
      if (m.sp.machine && this.down.has(key)) {
        // 연결 안 된 기기: 스페이스 대신 한 줄
        if (machine !== key) out.push(div().px(14).py(8).text_size(12).text_color(t.dim).whitespace_normal()
          .child(`${m.sp.machine}에 연결할 수 없어 리소스를 알 수 없습니다.`));
        machine = key;
        continue;
      }
      machine = key;
      out.push(this.spaceRow(t, m));
      if (this.folded[m.sp.id]) continue;
      for (const tb of m.tabs) {
        out.push(this.tabRow(t, m, tb));
        for (const x of tb.terms) out.push(this.termRow(t, m, tb, x));
      }
    }
    if (!out.length) out.push(div().px(14).py(8).text_size(12).text_color(t.dim).child("스페이스가 없습니다"));
    return out;
  }

  spaceRow(t, m) {
    const folded = !!this.folded[m.sp.id];
    const name = m.sp.machine ? `${m.sp.machine} · ${m.sp.name}` : m.sp.name;
    return h_flex().id(`res-s-${m.sp.id}`).h(28).pl(10).pr(14).flex_none().items_center().gap(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.folded = { ...this.folded, [m.sp.id]: !folded }; this.save("folded", this.folded); cx.notify(); })
      .child(svg(`mods/${ID}/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(name.toUpperCase()))
      .child(this.num(t, fmtCpu(m.cpu), W_CPU, t.foreground))
      .child(this.num(t, fmtMem(m.mem), W_MEM, t.foreground));
  }

  tabRow(t, m, tb) {
    return h_flex().id(`res-t-${tb.id}`).h(26).pl(28).pr(14).flex_none().items_center().gap(6)
      .hover((s) => s.bg(t.hover))
      .child(div().flex_1().min_w(0).truncate().text_color(tb.active && m.sp.active ? t.foreground : t.muted).child(tb.name))
      .child(this.spark(t, this.hist[tb.id] ?? []))
      .child(this.num(t, fmtCpu(tb.cpu), W_CPU))
      .child(this.num(t, fmtMem(tb.mem), W_MEM));
  }

  termRow(t, m, tb, { t: term, u }) {
    const dot = term.status && t[term.status] ? t[term.status] : OK;
    const name = term.program?.name || term.agent || term.address;
    return h_flex().id(`res-x-${term.address}`).h(24).pl(40).pr(14).flex_none().items_center().gap(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.goTo(m.sp, tb.id, term.address))
      .child(div().size(6).rounded(3).flex_none().bg(dot))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(term.address)))
      .child(this.num(t, fmtCpu(u?.cpu), W_CPU, t.dim))
      .child(this.num(t, fmtMem(u?.mem), W_MEM, t.dim));
  }

  // 최근 30표본 막대(1px + 간격 0.5px). 높이는 그 탭의 최대값 기준(최소 1%로 잡아 잔잡음이 커 보이지 않게).
  spark(t, h) {
    const H = 12, top = Math.max(1, ...h);
    const pad = Array(Math.max(0, SPARK - h.length)).fill(null);
    return h_flex().w(45).h(H).flex_none().items_end().gap(0.5).children([...pad, ...h].map((v) =>
      div().w(1).h(v == null ? 0 : Math.max(1, (v / top) * H)).bg(v ? t.muted : t.border)));
  }
}

// 레이아웃 트리에서 id로 노드 찾기
function findNode(n, id) {
  if (!n || typeof n !== "object") return null;
  if (n.id === id) return n;
  for (const c of n.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}

class Tip {
  init() {}
  render() {
    const t = theme();
    return div().size_full().flex().items_center().justify_center().rounded(6).bg(t.popover).border_1().border_color(t.border)
      .text_size(12).text_color(t.foreground).whitespace_nowrap().child(props()?.text ?? "");
  }
}

export default class Resources extends View {
  init(p, cx) {
    this.role = (props() ?? p ?? {}).role === "tip" ? new Tip() : new Panel();
    this.role.init(p, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }

  // 팝업이 Esc로 닫히면 hover 끝 이벤트가 오지 않으니, 떠 있는 툴팁 창을 여기서 닫는다.
  async close() {
    this.role.hideTip?.();
  }
}
