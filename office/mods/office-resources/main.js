// 리소스 관리자: Herdr 터미널들이 쓰는 메모리·CPU를 보여 준다.
//   레이아웃에서 사용량과 같은 탭 묶음(stack "office-side")에 들어가 있고, 탭 머리줄은 role "tabs"가 그린다.
//   칸 높이가 FULL 이상이면 요약 + 터미널 목록(메모리 큰 순), 모자라면 메모리 한 줄(칩). 칩을 누르면 팝업으로 같은 목록.
// 데이터: 터미널마다 hc get으로 셸(뿌리) pid를 한 번 얻어 두고, 3초마다 ps 한 번으로 그 자손 트리 합을 낸다.
//   요약 = 이 컴퓨터 터미널 전체 합. 다른 기기는 exec on으로 같은 계산을 시도한다.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, hc, run, props, spaces, panes, terminals, machines, window, layout,
  setShared, openOverlay, closeOverlay } from "herdr";
import { SCRIPT, parseAll, treeSum, fmtMem, fmtCpu } from "./calc.js";

const ID = "office-resources";   // 레이아웃 블록 id이자 모드 이름
const STACK = "office-side";     // 사용량·리소스 탭 묶음 id
const TABS = [{ id: "office-usage", label: "사용량" }, { id: ID, label: "리소스" }];
const FULL = 220;                // 이 높이부터 목록
const CHIP = 28;                 // 한 줄 칩 높이 (칸이 더 커도 맨 위에 붙인다)
const EVERY = 3000;              // 갱신 주기(ms)
const TOP = 3;                   // 스페이스마다 처음 보이는 줄 수. 나머지는 한 줄로 접는다
const CPU_MIN = 1;               // 이 % 이상일 때만 줄에 CPU를 쓴다
const NUM_FONT = "D2Coding";     // 숫자: 고정폭 글꼴로 자릿수를 맞춘다
const TOOL = { refresh: "#7fbbb3", fold: "#9da9a0" };   // 사용량 패널 툴바 색과 같게

// 브랜드 로고로 바꿔 보여 줄 프로그램(office 모드와 같게): Herdr 기본 아이콘은 작게 그리면 잘 안 보인다.
const BRAND = [
  [/claude/i, `mods/${ID}/icons/claude.svg`, "#d97757"],
  [/codex|openai/i, `mods/${ID}/icons/openai.svg`, null],   // null = 글자색
];

const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);
const spaceLabel = (name) => (name === "~" ? "홈" : name);
// 이름으로 쓸 만한 탭 이름인가: 숫자뿐("1"), 커밋 해시("show 93e8…"), 셸 이름은 아니다.
const meaningful = (name) => {
  const s = String(name ?? "").trim();
  return !!s && !/^\d+$/.test(s) && !/^show\s+[0-9a-f]{7,}$/i.test(s) && !/^(zsh|bash|fish|sh)$/i.test(s);
};

function programIcon(p, size, t) {
  const id = `${p?.key ?? ""} ${p?.name ?? ""}`;
  const brand = BRAND.find(([re]) => re.test(id));
  if (brand) return svg(brand[1]).size(size).flex_none().text_color(brand[2] ?? t.foreground);
  if (p?.icon) return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color || t.muted) : image(p.icon).size(size).flex_none();
  return null;
}

class Panel {
  init(_p, cx) {
    this.popup = props()?.role === "popup";   // 팝업 복사본: 늘 목록, 접기 대신 닫기
    this.size = null;
    this.roots = new Map();     // 주소 → { pid, tab } (hc get 한 번; 셸 pid는 터미널이 살아 있는 동안 같다)
    this.asking = new Set();    // hc get 중인 주소
    this.usage = new Map();     // 주소 → { cpu(기기 대비 %), mem(바이트) }
    this.sys = {};              // 기기 이름("" = 이 컴퓨터) → { ncpu, total, used, cpu }
    this.down = new Set();      // 리소스를 못 읽은 기기 이름
    this.busy = false;
    try { this.more = JSON.parse(localStorage.getItem("more") ?? "null") ?? {}; } catch { this.more = {}; }  // 스페이스 → 나머지 펼침
    try { this.shut = JSON.parse(localStorage.getItem("shut") ?? "null") ?? {}; } catch { this.shut = {}; }  // 스페이스 → 접힘
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
    if (node?.hidden) return false;
    const stack = findNode(layout(), STACK);
    return stack?.type !== "stack" || (stack.active ?? stack.children?.[0]?.id) === ID;
  }

  tick(cx, force) {
    if (this.busy || (!force && !this.visible())) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.read();
      } finally {
        this.busy = false;
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
  }

  // 터미널 한 줄씩, 메모리 큰 순. 터미널의 탭: 패인 → hc get 라벨 → (서브에이전트면) 부모의 탭.
  // Herdr 탭에 속하지 않은 터미널(다른 앱의 것)은 빠진다.
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
    const where = new Map();
    for (const sp of spaces()) for (const tb of sp.tabs) where.set(tb.id, { sp, tb });
    const rows = [];
    for (const t of terms) {
      if (t.state != null && t.state !== "live") continue;
      const w = where.get(tabOf(t.address));
      if (!w) continue;
      const u = this.usage.get(t.address);
      const p = t.program;
      // 이름: 셸이면 의미 있는 탭 이름, 아니면 "셸". 그 밖의 프로그램(에이전트, Git 등)은 프로그램 이름.
      const tabOk = meaningful(w.tb.name);
      const name = p?.shell || !p?.name ? (tabOk ? w.tb.name : "셸") : p.name;
      const extra = tabOk && name !== w.tb.name ? w.tb.name : null;
      rows.push({ address: t.address, program: p, name, sub: extra,
        sp: w.sp, tab: w.tb.id, machine: w.sp.machine ?? "", cpu: u?.cpu ?? null, mem: u?.mem ?? null });
    }
    rows.sort((a, b) => (b.mem ?? -1) - (a.mem ?? -1));
    return rows;
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

  // 한 줄에서 누르면: 같은 목록을 팝업으로(칩 오른쪽 끝에 맞춰 위쪽으로 띄운다).
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
      .child(full ? this.full(t) : this.chip(t));
  }

  // 이 컴퓨터 터미널들의 합
  total(rows = this.model()) {
    let cpu = null, mem = null, n = 0;
    for (const r of rows) {
      if (r.machine || r.mem == null) continue;
      cpu = (cpu ?? 0) + (r.cpu ?? 0);
      mem = (mem ?? 0) + r.mem;
      n++;
    }
    return { cpu, mem, n };
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

  full(t) {
    const rows = this.model();
    const { cpu, mem, n } = this.total(rows);
    const sys = this.sys[""];
    const card = v_flex().size_full().bg(t.chrome).text_size(13);
    const inTabs = findNode(layout(), STACK)?.type === "stack";   // 탭 묶음이 테두리·제목을 대신한다
    const framed = this.popup || inTabs ? card : card.rounded(10).border_1().border_color(t.border).overflow_hidden();
    const here = window()?.platform === "macos" ? "이 Mac" : "이 컴퓨터";
    const share = sys?.total && mem != null ? mem / sys.total * 100 : null;
    return framed
      // 머리줄: 사용량 패널과 같은 40px, 제목 14 semibold (탭 안에서는 탭 이름이 제목이라 뺀다)
      .when(!inTabs, (el) => el.child(h_flex().h(40).pl(14).pr(8).flex_none().items_center().gap(2).border_b_1().border_color(t.border)
        .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child("리소스 관리자"))
        .child(this.btn(t, "refresh", "refresh", TOOL.refresh, this.busy ? "읽는 중" : "지금 새로 고침", (cx) => this.tick(cx, true), this.busy))
        .when(this.popup, (el) => el.child(this.btn(t, "close", "close", TOOL.fold, "닫기", () => closeOverlay(props().overlay))))))
      // 요약: 이 컴퓨터 터미널이 쓰는 메모리 합, 무엇의 합인지와 기기 대비 비율
      .child(v_flex().px(14).pt(12).pb(10).flex_none().gap(2).border_b_1().border_color(t.border)
        .child(div().text_size(20).font_semibold().font_family(NUM_FONT).text_color(t.foreground).child(fmtMem(mem)))
        .child(div().text_size(12).text_color(t.dim).truncate()
          .child(mem == null ? "읽는 중" : `터미널 ${n}개가 쓰는 메모리 · CPU ${fmtCpu(cpu)}`))
        .when(share != null, (el) => el.child(div().text_size(12).text_color(t.dim).truncate()
          .child(`${here} 메모리 ${Math.round(sys.total / 1024 ** 3)} GB 중 ${share < 1 ? "1% 미만" : `${Math.round(share)}%`}`))))
      .child(v_flex().id("res-list").flex_1().min_h(0).overflow_y_scrollbar().py(4).children(this.rows(t, rows)));
  }

  rows(t, rows) {
    const out = [];
    const groups = new Map([["", []]]);
    for (const sp of spaces()) if (sp.machine && !groups.has(sp.machine)) groups.set(sp.machine, []);
    for (const r of rows) groups.get(r.machine)?.push(r);
    for (const [key, list] of groups) {
      if (key) {
        out.push(div().px(14).pt(12).pb(2).text_size(11).text_color(t.dim).truncate().child(key));
        if (this.down.has(key)) {
          out.push(div().px(14).py(6).text_size(12).text_color(t.dim).whitespace_normal()
            .child(`${key}에 연결할 수 없어 리소스를 알 수 없습니다.`));
          continue;
        }
      }
      if (!list.length) {
        if (!key) out.push(div().px(14).py(8).text_size(12).text_color(t.dim).child("터미널이 없습니다"));
        continue;
      }
      // 스페이스별로 묶는다: 메모리 합이 큰 스페이스부터, 그 안은 메모리 큰 순(rows가 이미 정렬돼 있다).
      const bySp = new Map();
      for (const r of list) {
        if (!bySp.has(r.sp.id)) bySp.set(r.sp.id, { sp: r.sp, list: [], mem: 0, cpu: 0 });
        const g = bySp.get(r.sp.id);
        g.list.push(r); g.mem += r.mem ?? 0; g.cpu += r.cpu ?? 0; if (r.mem != null) g.known = true;
      }
      for (const g of [...bySp.values()].sort((a, b) => b.mem - a.mem)) {
        const fk = `${key}|${g.sp.id}`;
        const shut = !!this.shut[fk];
        out.push(this.spaceRow(t, fk, g, shut));
        if (shut) continue;
        // 한 줄만 남으면 접지 않는다
        const fold = g.list.length > TOP + 1;
        const open = !fold || !!this.more[fk];
        for (const r of fold ? g.list.slice(0, TOP) : g.list) out.push(this.row(t, r));
        if (!fold) continue;
        const rest = g.list.slice(TOP);
        out.push(this.restRow(t, fk, rest, open));
        if (open) for (const r of rest) out.push(this.row(t, r));
      }
    }
    return out;
  }

  // 스페이스 머리줄: chevron | 이름 | 메모리 합(CPU는 1% 이상일 때만). 누르면 접고 펼친다.
  spaceRow(t, fk, g, shut) {
    return h_flex().id(`res-sp-${fk}`).h(30).px(14).mt(4).flex_none().items_center().gap(10).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.shut = { ...this.shut, [fk]: !shut }; this.save("shut", this.shut); cx.notify(); })
      .child(div().w(16).flex_none().flex().justify_center()
        .child(svg(`mods/${ID}/chevron-${shut ? "right" : "down"}.svg`).size(12).text_color(t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(spaceLabel(g.sp.name)))
      .when(g.cpu >= CPU_MIN, (el) => el.child(div().flex_none().font_family(NUM_FONT).text_size(11).text_color(t.dim).child(`CPU ${fmtCpu(g.cpu)}`)))
      .child(div().flex_none().font_family(NUM_FONT).text_size(12).font_semibold().text_color(t.foreground).child(g.known ? fmtMem(g.mem) : "—"));
  }

  // 한 줄: 아이콘 | 이름 / 탭 이름(있으면, 흐리게) | 메모리 / CPU(1% 이상일 때만). 누르면 그 터미널로.
  row(t, r) {
    const icon = programIcon(r.program, 16, t);
    const showCpu = r.cpu != null && r.cpu >= CPU_MIN;
    return h_flex().id(`res-x-${r.address}`).h(r.sub ? 40 : 30).pl(26).pr(14).flex_none().items_center().gap(10).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.goTo(r.sp, r.tab, r.address))
      .child(div().w(16).flex_none().flex().justify_center().when(!!icon, (el) => el.child(icon)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).text_color(t.foreground).child(r.name))
        .when(!!r.sub, (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(r.sub))))
      .child(v_flex().flex_none().items_end()
        .child(div().font_family(NUM_FONT).text_size(12).text_color(t.muted).child(fmtMem(r.mem)))
        .when(showCpu, (el) => el.child(div().font_family(NUM_FONT).text_size(11).text_color(t.dim).child(`CPU ${fmtCpu(r.cpu)}`))));
  }

  restRow(t, key, rest, open) {
    const sum = rest.some((r) => r.mem != null) ? rest.reduce((s, r) => s + (r.mem ?? 0), 0) : null;
    return h_flex().id(`res-more-${key || "here"}`).h(30).pl(26).pr(14).flex_none().items_center().gap(10).cursor_pointer()
      .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.more = { ...this.more, [key]: !open }; this.save("more", this.more); cx.notify(); })
      .child(div().w(16).flex_none().flex().justify_center()
        .child(svg(`mods/${ID}/chevron-${open ? "down" : "right"}.svg`).size(12).text_color(t.dim)))
      .child(div().flex_1().min_w(0).truncate().child(`나머지 ${rest.length}개`))
      .child(div().flex_none().font_family(NUM_FONT).child(fmtMem(sum)));
  }
}

// 레이아웃 트리에서 id로 노드 찾기
function findNode(n, id) {
  if (!n || typeof n !== "object") return null;
  if (n.id === id) return n;
  for (const c of n.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}

// 탭 머리줄: 사용량 / 리소스. 누르면 layout.select로 탭 묶음의 보이는 칸을 바꾼다.
class Tabs {
  init() { this.picked = null; }
  render(cx) {
    const t = theme();
    const stack = findNode(layout(), STACK);
    const active = this.picked ?? stack?.active ?? TABS[0].id;
    return h_flex().id("res-tabs").size_full().px(8).gap(2).items_end().border_b_1().border_color(t.border).bg(t.chrome)
      .children(TABS.map((tab) => {
        const on = tab.id === active;
        return div().id(`tab-${tab.id}`).px(10).pt(8).pb(6).cursor_pointer().text_size(13)
          .border_b_2().border_color(on ? t.foreground : "#00000000")
          .text_color(on ? t.foreground : t.dim).when(on, (el) => el.font_semibold())
          .when(!on, (el) => el.hover((s) => s.text_color(t.muted)))
          .on_click((_e, cx) => {
            this.picked = tab.id;
            run("layout.select", { stack: STACK, child: tab.id });
            cx.notify();
          })
          .child(tab.label);
      }));
  }
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
    const role = (props() ?? p ?? {}).role;
    this.role = role === "tip" ? new Tip() : role === "tabs" ? new Tabs() : new Panel();
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
