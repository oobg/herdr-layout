// office-apps의 명령 앱: Herdr의 모든 명령(commands()) + 이 레이아웃의 앱 명령(office-apps.*)을 찾아 실행한다.
//   왼쪽: 검색창 + 목록(줄 = 사람 말 한 줄 · 흐린 명령 이름 · 오른쪽 단축키). 최근 실행한 10개는 맨 위 "최근" 묶음.
//   오른쪽: 고른 명령의 설명 전체, 인자(필수 인자가 있으면 입력 칸), 단축키, 실행 버튼.
//   키: 검색창에서 ↑↓ = 고르기, Enter = 실행(필수 인자가 있으면 첫 입력 칸으로). 입력 칸에서 Enter = 실행.
//   클릭: 인자가 필요 없는 명령은 바로 실행, 필요하면 오른쪽 입력 칸으로.
//   위험해 보이는 명령(이름에 close·kill·reset·remove·quit)은 확인 창(menu.js Confirm, danger)을 거친다.
//   단축키는 herdr keys()(keys.json과 같은 내용)를 읽기만 한다 — 키를 묶는 일은 하지 않는다.
//   순수 함수(목록·단축키·위험 판단·인자 만들기·검색)는 palette/core.js(herdr를 import하지 않아 node로 시험).
//   Herdr 명령 설명은 palette/ko.js의 한국어 한 줄로 보이고, 상세에서 그 아래 영어 원문을 흐리게 둔다. 검색은 둘 다에서.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { commands, keys, readTextFile, appHome, run, notify, shared, setShared, openOverlay } from "herdr";
import { ACTIONS } from "./menu.js";
import * as P from "./palette/core.js";
import { argLabel } from "./palette/ko.js";

const ME = "mods/office-apps";
const CODE_FONT = "D2Coding";
const RECENT = "office-apps.palette.recent";   // 최근 실행(이름 배열). 공유 상태 + localStorage에 같이 둔다
const LS_RECENT = "palette.recent";

// 최근 실행 목록: 확인 창(오버레이 복사본)에서 실행해도 앱이 알 수 있게 공유 상태를 먼저 본다.
function recent() {
  const s = shared(RECENT);
  if (Array.isArray(s)) return s;
  try { const v = JSON.parse(localStorage.getItem(LS_RECENT) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function remember(name) {
  const next = P.pushRecent(recent(), name);
  try { localStorage.setItem(LS_RECENT, JSON.stringify(next)); } catch { /* 공유 상태에는 남는다 */ }
  setShared(RECENT, next);
}

// 실행: { cmd(최근 목록에 둘 명령 이름), name(보낼 명령), args }. 실패하면 알린다.
function execute(r) {
  try {
    if (r.args) run(r.name, r.args); else run(r.name);
  } catch (e) {
    notify({ title: "명령을 실행하지 못했습니다", body: `${r.name}: ${String(e?.message ?? e).slice(0, 160)}`, level: "error" });
    return;
  }
  remember(r.cmd);
}

// 확인 창(Confirm)은 따로 뜨는 복사본이라 함수를 넘길 수 없어, 모듈이 불릴 때 동작을 하나 등록한다(menu.js는 고치지 않는다).
ACTIONS["palette.run"] = (ctx) => execute(ctx);

// 확인 창에 보일 명령 한 줄. 이 앱이 넣은 confirmed는 빼고 보인다.
function shown(r) {
  const { [P.SELF_CONFIRM_ARG]: _c, ...rest } = r.args ?? {};
  return Object.keys(rest).length ? `${r.name} ${JSON.stringify(rest)}` : r.name;
}

export class PaletteApp {
  init(_p, cx) {
    this.query = "";
    this.sel = null;          // 고른 명령 이름
    this.inputs = [];         // 고른 명령의 인자 입력 칸 [{ arg, state }]
    this.msg = null;          // 오른쪽 칸의 짧은 안내(빠진 인자·JSON 오류)
    this.rowAt = new Map();   // 명령 이름 → 목록 칸의 몇 번째 자식(묶음 제목 포함, 스크롤용)
    this.scroll = ScrollHandle.new();
    this.fileKeys = null;     // keys()를 못 읽으면 keys.json을 읽어 둔 것
    this.load();
    this.search = InputState.new({ placeholder: "명령 이름·설명·단축키" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value().trim();
      this.load();
      this.pick(this.visible()[0] ?? null);
      this.scroll.scroll_to_item(0);
      cx.notify();
    });
    // Enter: 고른 명령 실행(런처 검색창과 같은 방식)
    this.search.on("submit", (_e, cx) => { this.activate(cx); cx.notify(); });
    this.pick(this.visible()[0] ?? null);
    if (!this.keysOk) {
      cx.spawn(async (cx) => {
        try { this.fileKeys = P.bindingList(JSON.parse(await readTextFile(`${appHome()}/keys.json`) ?? "{}")); } catch { this.fileKeys = []; }
        this.load();
        cx.notify();
      });
    }
  }

  dispose() {
    this.disposed = true;
    this.dropInputs();
    try { this.scroll?.release(); } catch { /* 이미 놓았으면 그만 */ }
    this.scroll = null;
  }

  // 명령 목록 + 단축키. 이벤트 때마다 다시 읽는다(키를 바꿔도 다음 검색에 반영).
  load() {
    let list = [];
    try { list = commands() ?? []; } catch { list = []; }
    const cmds = P.allCommands(list);
    let binds = this.fileKeys ?? [];
    try { binds = keys() ?? binds; this.keysOk = true; } catch { this.keysOk = false; }
    const idx = P.keyIndex(binds, cmds);
    this.items = cmds.map((c) => ({ ...c, keys: idx.get(c.name) ?? [] }));
    this.byName = new Map(this.items.map((c) => [c.name, c]));
  }

  groups() { return P.groups(this.items, this.query, recent()); }
  visible() { return this.groups().flatMap((g) => g.rows.map((c) => c.name)); }
  current() { return this.sel ? this.byName.get(this.sel) ?? null : null; }

  // 명령 고르기. 입력 상자는 렌더 중에 만들 수 없어 여기(이벤트 시점)에서 만든다.
  pick(name) {
    if (name === this.sel) return;
    this.sel = name;
    this.msg = null;
    this.dropInputs();
    const c = this.current();
    if (c && P.needsArgs(c)) {
      this.inputs = P.inputArgs(c).map((a) => {
        const state = InputState.new({ placeholder: a.required ? "필수" : "선택" });
        state.on("submit", (_e, cx) => { this.runSelected(cx); cx.notify(); });
        state.on("change", (_e, cx) => { if (this.msg) { this.msg = null; cx.notify(); } });
        return { arg: a, state };
      });
    }
  }

  dropInputs() {
    for (const i of this.inputs) { try { i.state.release(); } catch { /* 이미 놓음 */ } }
    this.inputs = [];
  }

  // 셸 계약: ↑↓ (왼쪽 칸 포커스). 검색창의 ↑↓도 여기로 온다.
  move(d, cx) {
    const list = this.visible();
    if (!list.length) return;
    const i = list.indexOf(this.sel);
    const j = i < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d));
    this.pick(list[j]);
    this.scroll?.scroll_to_item(this.rowAt.get(list[j]) ?? 0);
    cx?.notify?.();
  }

  // 셸 계약: Enter. 필수 인자가 있으면 첫 빈 필수 칸으로, 없으면 실행.
  activate(cx) {
    const c = this.current();
    if (!c) return;
    if (P.needsArgs(c)) {
      const empty = this.inputs.find((i) => i.arg.required && !i.state.value().trim());
      if (empty) { empty.state.focus(); return; }
    }
    this.runSelected(cx);
  }

  // 고른 명령을 입력 칸 값으로 실행. 위험하면 확인 창.
  runSelected(cx) {
    const c = this.current();
    if (!c) return;
    const values = Object.fromEntries(this.inputs.map((i) => [i.arg.name, i.state.value()]));
    const danger = P.isDanger(c.name);
    const r = P.buildRun(c, values, { confirmed: danger });
    if (r.error) { this.msg = r.error; return; }
    if (r.missing) {
      this.msg = `${r.missing.join(", ")}을(를) 채워 주세요`;
      this.inputs.find((i) => i.arg.name === r.missing[0])?.state.focus();
      return;
    }
    const ctx = { cmd: c.name, name: r.name, args: r.args };
    if (danger) {
      openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: {
        role: "confirm", action: "palette.run", ctx, title: `${c.name} 실행`, yes: "실행", danger: true,
        detail: (c.ko || c.about) ? `${c.ko || c.about} — ${shown(r)}` : shown(r),
      } });
      return;
    }
    execute(ctx);
    cx?.notify?.();
  }

  emptyState() {
    return this.query ? { text: "맞는 명령이 없습니다", sub: "이름·설명·단축키로 찾습니다" } : { text: "명령을 고르세요", sub: "" };
  }

  subtitle(t) {
    return div().truncate().text_size(12).text_color(t.muted).child(`명령 ${this.items.length}개`);
  }

  // 목록 줄: 사람 말 한 줄(인자·확인이 더 필요하면 "…") + 단축키 / 흐린 명령 이름(모노)
  row(c, t) {
    const k = c.keys[0];
    const more = P.needsArgs(c) || P.isDanger(c.name);
    return v_flex().id(`pl-${c.name}`).flex_none().px(8).py(5).gap(1).rounded(4).cursor_pointer()
      .when(this.sel === c.name, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.pick(c.name); this.activate(cx); cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(P.title(c) + (more ? "…" : "")))
        .when(Boolean(k), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(k.label))))
      .child(div().truncate().font_family(CODE_FONT).text_size(11).text_color(t.muted).child(c.name));
  }

  list(cx, t) {
    const gs = this.groups();
    const sel = this.visible();
    if (this.sel && !sel.includes(this.sel)) this.sel = null;   // 걸러져 사라진 것(입력 칸은 다음 고르기에서 정리)
    const kids = [], at = new Map();
    for (const g of gs) {
      if (g.title) kids.push(div().px(8).pt(kids.length ? 10 : 4).pb(2).text_size(12).text_color(t.muted).child(g.title));
      for (const c of g.rows) { at.set(c.name, kids.length); kids.push(this.row(c, t)); }
    }
    this.rowAt = at;
    return v_flex().flex_1().min_h(0)
      // 검색창의 ↑↓(입력 상자에서 올라온 키): 목록의 고른 줄을 옮긴다(런처 검색창과 같은 방식). ←→는 커서에 둔다.
      .on_key_down((e, cx) => {
        const m = e.modifiers;
        if (m.shift || m.alt || m.control || m.platform) return;
        if (e.key === "up") this.move(-1, cx);
        else if (e.key === "down") this.move(1, cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(40).flex_none().px(10).gap(8).items_center().border_b_1().border_color(t.border)
        .child(svg(`${ME}/search.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.search).h(28).text_size(13).text_color(t.foreground))))
      .child(v_flex().id("pl-list").flex_1().min_h(0).overflow_y_scrollbar().when(Boolean(this.scroll), (el) => el.track_scroll(this.scroll)).p(4).gap(1)
        .children(kids)
        .when(!kids.length, (el) => el.child(div().p(8).text_size(12).text_color(t.muted).child("맞는 명령이 없습니다"))));
  }

  detail(cx, t) {
    const c = this.current();
    if (!c) return null;
    const danger = P.isDanger(c.name);
    const needs = P.needsArgs(c);
    const args = P.inputArgs(c);
    const section = (title) => div().pt(12).pb(2).text_size(12).font_semibold().text_color(t.muted).child(title);
    const note = (text) => div().text_size(12).text_color(t.muted).child(text);
    const runBtn = h_flex().id("pl-run").h(28).px(12).flex_none().items_center().rounded(6).cursor_pointer().text_size(12.5)
      .border_1().border_color(danger ? t.input : t.solid).bg(danger ? t.raised : t.solid)
      .text_color(danger ? t.ansi1 : t.solid_foreground).when(danger, (el) => el.font_semibold())
      .hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => { this.runSelected(cx); cx.notify(); })
      .child(danger ? "실행…" : "실행");

    // 인자: 필수 인자가 있으면 입력 칸, 없으면 이름만(선택 인자는 이 앱에서 넣지 않는다)
    const argRows = needs
      ? this.inputs.map((i) => v_flex().gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().min_w(0).truncate().font_family(CODE_FONT).text_size(12).text_color(t.foreground).child(argLabel(i.arg.name)))
          .child(div().flex_none().text_size(11).text_color(t.muted).child(i.arg.required ? "필수" : "선택")))
        .child(Input.new(i.state).h(28).text_size(13).text_color(t.foreground)))
      : args.length
        ? [div().font_family(CODE_FONT).text_size(12).text_color(t.muted).child(args.map((a) => argLabel(a.name)).join(" · ")),
          note("모두 선택 인자입니다. 이 앱에서는 인자 없이 실행합니다")]
        : [note("없음")];

    const keyRows = c.keys.length
      ? c.keys.map((k) => h_flex().gap(10).items_center()
        .child(div().w(110).flex_none().text_color(t.foreground).child(k.label))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
          .child([k.arg && `인자 ${k.arg}`, k.section === "terminal" && "터미널에서"].filter(Boolean).join(" · "))))
      : [note("묶인 키가 없습니다")];

    return v_flex().id("pl-detail-root").size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(P.title(c)))
        .child(runBtn))
      .child(v_flex().id("pl-detail").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(12).gap(6)
        .child(div().font_family(CODE_FONT).text_size(12).text_color(t.muted).child(c.name))
        .child(div().text_color(t.foreground).child(c.ko || c.about || "설명이 없습니다"))
        .when(Boolean(c.ko && c.about), (el) => el.child(div().text_size(12).text_color(t.muted).child(c.about)))
        .when(danger, (el) => el.child(div().text_size(12).text_color(t.ansi1).child("위험할 수 있는 명령 · 실행 전에 한 번 더 묻습니다")))
        .child(section("인자"))
        .children(argRows)
        .when(Boolean(this.msg), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.msg)))
        .child(section("단축키"))
        .children(keyRows));
  }
}
