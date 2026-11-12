// 앱 화면 틀과 키 계약. 런처(아래 칸 앱 화면)와 앱 대화 창(오버레이 역할 app-modal)이 함께 쓴다.
//   틀: 위 막대(lead · 타일 · 이름 · 부제 · trail) / 왼쪽 목록(lh 포커스) / 오른쪽 상세(dh 포커스, 키보드 커서 kb).
//   키: 왼쪽 ↑↓ = app.move · Enter = app.activate · Tab/Shift+Tab = 상세 멈출 곳으로.
//     상세: Tab 차례 · Enter 버튼 · Space 체크 · ⌘Enter submitDetail · Esc 왼쪽 목록으로(커서가 있을 때).
//     그 밖의 Esc는 바깥(onEscape: 런처는 격자로, 대화 창은 닫기)으로 간다.
//   main.js를 import하지 않는다(main.js가 이 파일을 import한다): 앱 정의(a)·타일 그리기(tile)는 인자로 받는다.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { step, detailKey, inputKey, listKey } from "./ring.js";

export const LEFT = 250;   // 왼쪽 관리 칸 기본 폭(가운데 내용 칸을 강조하려고 좁게)

export class AppScreen {
  // cx가 없으면(코드를 다시 불러와 init 없이 남은 인스턴스) 포커스 핸들 없이 그리기만 한다.
  constructor(cx) {
    this.lh = cx?.focus_handle?.() ?? null;   // 왼쪽 목록의 키보드 포커스
    this.dh = cx?.focus_handle?.() ?? null;   // 오른쪽 상세의 키보드 포커스. 멈출 곳마다 핸들을 두지 않고 커서(kb.at)로 가린다
    // 상세 키보드 커서: at = 멈출 곳 id(null이면 왼쪽 목록), last = 그 순번(사라졌을 때 이어 갈 자리),
    //   key = 키보드로 옮긴 커서인지(마우스로 누르면 끈다), from = 입력칸 감싼 곳이 알린 id
    this.kb = { at: null, last: 0, key: false, from: null, on: (id) => this.kb.key && this.kb.at === id && Boolean(this.dh?.is_focused()) };
  }

  reset() { this.kb.at = null; this.kb.key = false; this.kb.from = null; }

  // 위에 뜬 창이 닫혀 돌아왔을 때: 있던 곳(상세 커서 또는 왼쪽 목록)
  refocus(app) {
    if (this.kb.key && this.kb.at) this.moveTo(app, this.kb.at);
    else this.lh?.focus();
  }

  stops(app) {
    try { return (app?.focusables?.() ?? []).filter((s) => s && s.id != null); } catch { return []; }
  }

  // 커서를 그 멈출 곳으로(null·없는 id면 왼쪽 목록). 입력칸은 그 입력에, 버튼·체크는 상세 칸 핸들에 포커스를 준다.
  moveTo(app, id) {
    const kb = this.kb, list = this.stops(app), i = id == null ? -1 : list.findIndex((s) => s.id === id);
    if (i < 0) { kb.at = null; kb.key = false; this.lh?.focus(); return; }
    kb.at = id; kb.last = i; kb.key = true;
    if (list[i].kind === "input") list[i].focus?.();
    else this.dh?.focus();
  }

  // Tab(dir 1)·Shift+Tab(dir -1): at(null이면 왼쪽 목록)에서 고리를 따라 옮긴다. 멈출 곳이 없으면 false.
  tabFrom(app, at, dir) {
    if (!this.dh) return false;
    const ids = this.stops(app).map((s) => s.id);
    if (!ids.length) return false;
    this.moveTo(app, step(ids, at, dir, this.kb.last));
    return true;
  }

  // 오른쪽 상세 칸의 키. 입력칸 안에서 올라온 키(kb.from)는 Tab·Esc만, 상세 칸 핸들이 가진 키는 계약대로.
  detailKeys(app, e, cx) {
    const kb = this.kb;
    if (!app) return;
    const from = kb.from;
    kb.from = null;
    if (from != null && !this.dh?.is_focused() && !this.lh?.is_focused()) {
      const k = inputKey(e);
      if (!k) return;
      if (k === "left") this.moveTo(app, null);
      else if (!this.tabFrom(app, from, k === "next" ? 1 : -1)) return;
      cx.stop_propagation(); cx.notify();
      return;
    }
    if (!this.dh?.is_focused()) return;
    const k = detailKey(e);
    if (!k) return;
    if (k === "up" || k === "down") { if (!app.move) return; app.move(k === "up" ? -1 : 1, cx); }
    else if (k === "next" || k === "prev") { if (!this.tabFrom(app, kb.key ? kb.at : null, k === "next" ? 1 : -1)) return; }
    // 마우스로 상세를 누른 뒤(커서 없음)의 Esc는 바깥 Esc 처리(onEscape)로 넘긴다
    else if (k === "left") { if (!kb.key) return; this.moveTo(app, null); }
    else if (k === "submit") { if (!app.submitDetail) return; app.submitDetail(cx); }
    else if (k === "press") {
      // 마우스로 상세를 누른 뒤(커서 없음)의 Enter는 왼쪽 목록의 Enter(주 동작)
      if (!kb.key) { if (e.key !== "enter" || !app.activate) return; app.activate(cx); }
      else {
        const s = this.stops(app).find((x) => x.id === kb.at);
        if (!s?.run) return;
        s.run(cx);
      }
    }
    cx.stop_propagation(); cx.notify();
  }

  // 앱 화면. a = 앱 정의({ name, desc }), app = 인스턴스(없으면 준비 중), tile(a, size) = 타일 그림,
  //   lead·trail = 위 막대 앞(런처: ‹ 앱)·뒤(대화 창: ✕) 요소 배열, onEscape(cx) = 안쪽에서 멈추지 않은 Esc.
  view({ a, app, cx, t, tile, lead = [], trail = [], onEscape, left = LEFT }) {
    if (app) app.kb = this.kb;   // 앱이 멈출 곳 테두리를 그릴 때 본다(kb.on(id))
    const detail = app?.detail?.(cx, t) ?? null;
    // 빈 화면 문구: 앱이 emptyState()로 정하면 그것, 아니면 기본. 준비 중인 앱(인스턴스 없음)은 앱 설명
    const empty = (!detail && app?.emptyState?.()) || null;
    return v_flex().size_full().min_h(0)
      // Esc: 안쪽에서 Esc를 쓰는 곳(입력 상자 지우기, 상세 커서 → 목록)이 먼저 멈추면 오지 않는다.
      .on_key_down((e, cx) => {
        const m = e.modifiers;
        if (e.key !== "escape" || m.shift || m.alt || m.control || m.platform || !onEscape) return;
        onEscape(cx);
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b_1().border_color(t.border)
        .children(lead)
        .child(tile(a, 24))
        .child(div().flex_none().text_size(15).font_semibold().child(a.name))
        .child(div().flex_1().min_w(0).child(app?.subtitle?.(t) ?? div()))
        .children(trail))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        // 왼쪽: 관리 목록(좁게). 이 칸 자체가 포커스를 가졌을 때만 키를 받는다(입력 상자에 포커스가 있으면 그냥 둔다).
        .child(v_flex().id("apps-left").when(Boolean(this.lh), (el) => el.track_focus(this.lh)).w(left).h_full().flex_none().min_h(0).border_r_1().border_color(t.border)
          .on_key_down((e, cx) => {
            if (!app || !this.lh?.is_focused()) return;
            // Tab·Shift+Tab: 오른쪽 상세의 첫(마지막) 멈출 곳으로
            const lk = listKey(e);
            if (lk) { if (!this.tabFrom(app, null, lk === "next" ? 1 : -1)) return; cx.stop_propagation(); cx.notify(); return; }
            const m = e.modifiers;
            if (m.shift || m.alt || m.control || m.platform) return;
            if (e.key === "up" || e.key === "down") { if (!app.move) return; app.move(e.key === "up" ? -1 : 1, cx); }
            else if (e.key === "enter") { if (!app.activate) return; app.activate(cx); }
            else return;
            cx.stop_propagation(); cx.notify();
          })
          .child(app ? app.list(cx, t) : v_flex().p(16).gap(6).child(div().text_color(t.muted).child("준비 중인 앱입니다"))
            .child(div().text_size(12).text_color(t.dim).child(a.desc))))
        // 오른쪽: 고른 항목. 마우스로 누르면 키보드 커서 테두리를 끈다.
        .child(v_flex().id("apps-right").when(Boolean(this.dh), (el) => el.track_focus(this.dh)).flex_1().h_full().min_w(0).min_h(0).bg(t.background)
          .on_mouse_down("left", () => { this.kb.key = false; })
          .on_key_down((e, cx) => this.detailKeys(app, e, cx))
          .child(detail ?? v_flex().size_full().items_center().justify_center().gap(10)
            .child(tile(a, 40).opacity(0.5))
            .child(div().text_size(14).text_color(t.muted).child(empty?.text ?? "선택 내용이 없습니다"))
            .child(div().text_size(12).text_color(t.dim).child(app ? (empty ? empty.sub ?? "" : "왼쪽에서 항목을 고르세요") : a.desc)))));
  }
}
