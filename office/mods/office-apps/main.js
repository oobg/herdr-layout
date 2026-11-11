// office 아래 칸: 앱 런처. 기본 화면은 Spotlight처럼 검색창 + 앱 아이콘 격자, 앱을 누르면 들어간다.
//   앱 화면: 위 막대(‹ 앱 · 아이콘 · 이름 · 부제) / 왼쪽 좁은 칸(툴바 + 관리 목록) / 오른쪽 넓은 칸(고른 항목, 없으면 "선택 내용이 없습니다")
//   앱 관리(⚙): 앱마다 켜고 끄기. 끈 앱은 격자에서 숨기고 코드를 만들지 않아 타이머·git·네트워크가 돌지 않는다.
// 오버레이 역할(props.role): menu·prompt·confirm·tip — 파일 앱의 우클릭 메뉴와 입력·확인 창, 툴팁.
// 키·명령: office-apps.home(런처로), office-apps.open-<앱 id>(앱 열기), office-apps.show:<경로>(파일 열기)

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, theme, shared, setShared, nextCommand, run } from "herdr";
import { FilesApp, ROLES } from "./files.js";
import { BranchApp } from "./branch.js";
import { CommitApp } from "./commit.js";
import { PrApp } from "./pr.js";
import { AgentApp } from "./agent.js";
import { ServerApp } from "./server.js";

const ME = "mods/office-apps";
const DISABLED = "office-apps.disabled";   // { 앱 id: true } — 끈 앱
// 앱 목록. make가 없는 앱은 아직 준비 중(격자에는 보이되 들어가면 안내만). action이 있는 앱은 들어가지 않고 그 동작만 한다.
const APPS = [
  { id: "files", name: "파일", desc: "파일트리와 뷰어(코드·마크다운·이미지)", color: "#3d7de5", make: () => new FilesApp() },
  { id: "branch", name: "브랜치", desc: "로컬·원격 브랜치 관리", color: "#2f9e6f", make: () => new BranchApp() },
  { id: "commit", name: "커밋", desc: "커밋 기록과 변경 내용", color: "#e07b39", make: () => new CommitApp() },
  { id: "pr", name: "PR", desc: "풀 리퀘스트 목록과 리뷰", color: "#8b5cf6", make: () => new PrApp() },
  { id: "agent", name: "에이전트", desc: "에이전트와 서브에이전트가 하는 일", color: "#d97757", make: () => new AgentApp() },
  { id: "server", name: "서버", desc: "Herdr에 등록한 머신(서버) 관리", color: "#4f8fa8", make: () => new ServerApp() },
  { id: "settings", name: "설정", desc: "Herdr 설정 창 열기", color: "#6b7280", action: () => run("app.settings") },
];

class Launcher {
  init(_p, cx) {
    this.app = null;          // 들어가 있는 앱 id
    this.managing = false;    // 앱 관리 화면
    this.inst = {};           // 앱 id → 인스턴스(켜진 앱을 처음 열 때 만든다)
    this.query = "";
    this.search = InputState.new({ placeholder: "앱 검색" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    try { this.go(JSON.parse(localStorage.getItem("app") ?? "null"), cx); } catch { /* 런처부터 */ }
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "home") this.go(null, cx);
        else if (c.startsWith("open-")) this.go(c.slice(5), cx);
        // show:<경로>  파일 앱에서 그 파일을 연다(프로젝트 기준 상대 경로)
        else if (c.startsWith("show:")) { this.go("files", cx); this.inst.files?.show(c.slice(5), cx); }
        cx.notify();
      }
    });
  }

  disabled() { return shared(DISABLED) ?? {}; }

  // 앱 열기. 앱 인스턴스는 여기(이벤트·명령 처리 시점)에서 만든다: 렌더 중에는 입력 상자 등을 만들 수 없다.
  go(id, cx) {
    const act = APPS.find((a) => a.id === id)?.action;
    if (act && !this.disabled()[id]) { act(); return; }
    this.app = id && !this.disabled()[id] ? id : null;
    this.managing = false;
    const def = APPS.find((a) => a.id === this.app);
    if (def?.make && !this.inst[this.app]) { this.inst[this.app] = def.make(); this.inst[this.app].init({}, cx); }
    try { localStorage.setItem("app", JSON.stringify(this.app)); } catch { /* 이번 실행 동안만 */ }
  }

  // 켜진 앱만 열 때 만든다(go). 끈 앱은 만들지 않고, 끄면 있던 인스턴스도 버린다.
  instance(id) {
    return this.disabled()[id] ? null : this.inst[id] ?? null;
  }

  toggle(id) {
    const d = { ...this.disabled() };
    if (d[id]) delete d[id]; else { d[id] = true; delete this.inst[id]; if (this.app === id) this.app = null; }
    setShared(DISABLED, d);
  }

  render(cx) {
    const t = theme();
    if (this.app && this.disabled()[this.app]) this.app = null;
    return v_flex().id("office-apps").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(this.app ? this.appView(this.app, cx, t) : this.managing ? this.manageView(t) : this.home(t));
  }

  tile(a, size, t) {
    return div().size(size).flex_none().rounded(Math.round(size * 0.24)).bg(a.color).flex().items_center().justify_center()
      .border_1().border_color("#ffffff22").shadow_md()
      .child(svg(`${ME}/apps/${a.id}.svg`).size(Math.round(size * 0.52)).text_color("#ffffff"));
  }

  // 런처: 검색창 + 격자. 앱 이름·설명으로 거른다.
  home(t) {
    const q = this.query, off = this.disabled();
    const list = APPS.filter((a) => !off[a.id] && (!q || a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q) || a.id.includes(q)));
    return v_flex().size_full().min_h(0)
      .child(h_flex().h(48).flex_none().px(16).gap(10).items_center().border_b_1().border_color(t.border)
        .child(svg(`${ME}/search.svg`).size(16).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.search).h(30).text_size(15).text_color(t.foreground)))
        .child(div().id("apps-manage").p(5).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.managing = true; cx.notify(); })
          .child(svg(`${ME}/apps/gear.svg`).size(16).text_color(t.muted))))
      .child(div().id("apps-grid").flex_1().min_h(0).overflow_y_scrollbar().p(20)
        .child(h_flex().flex_wrap().gap(18).children(list.map((a) =>
          v_flex().id(`app-${a.id}`).w(92).py(8).gap(8).items_center().rounded(10).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.go(a.id, cx); cx.notify(); })
            .child(this.tile(a, 56, t))
            .child(div().text_size(13).text_color(t.foreground).child(a.name)))))
        .when(list.length === 0, (el) => el.child(div().pt(8).text_color(t.muted).child(q ? "맞는 앱이 없습니다" : "켜진 앱이 없습니다. ⚙에서 켜세요"))));
  }

  // 앱 관리: 켜고 끄기
  manageView(t) {
    const off = this.disabled();
    return v_flex().size_full().min_h(0)
      .child(h_flex().h(48).flex_none().px(10).gap(8).items_center().border_b_1().border_color(t.border)
        .child(this.back(t))
        .child(div().text_size(15).font_semibold().child("앱 관리")))
      .child(v_flex().id("apps-manage-list").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(10).gap(2)
        .child(div().pb(8).text_size(12).text_color(t.muted).child("끈 앱은 런처에서 숨기고, Herdr가 그 앱을 불러오지 않습니다(타이머·git·네트워크 요청 없음)."))
        .children(APPS.map((a) => {
          const on = !off[a.id];
          return h_flex().id(`apps-tg-${a.id}`).py(8).px(6).gap(12).items_center().rounded(8).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.toggle(a.id); cx.notify(); })
            .child(this.tile(a, 32, t))
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(13).font_semibold().text_color(on ? t.foreground : t.muted).child(a.name))
              .child(div().truncate().text_size(12).text_color(t.muted).child(a.desc + (a.make || a.action ? "" : " · 준비 중"))))
            // 스위치
            .child(div().w(36).h(20).flex_none().rounded(10).bg(on ? t.accent : t.border).p(2).flex().when(on, (el) => el.justify_end())
              .child(div().size(16).rounded_full().bg("#ffffff")));
        })));
  }

  back(t) {
    return h_flex().id("apps-back").px(6).py(3).gap(2).items_center().rounded(6).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.go(null, cx); cx.notify(); })
      .child(svg(`${ME}/apps/back.svg`).size(14).text_color(t.foreground)).child(div().text_size(13).child("앱"));
  }

  // 앱 화면: 위 막대 / 왼쪽 목록 / 오른쪽 내용
  appView(id, cx, t) {
    const a = APPS.find((x) => x.id === id), app = this.instance(id);
    const detail = app?.detail?.(cx, t) ?? null;
    return v_flex().size_full().min_h(0)
      .child(h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b_1().border_color(t.border)
        .child(this.back(t))
        .child(div().w(1).h(18).bg(t.border))
        .child(this.tile(a, 24, t))
        .child(div().flex_none().text_size(15).font_semibold().child(a.name))
        .child(div().flex_1().min_w(0).child(app?.subtitle?.(t) ?? div())))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        // 왼쪽: 관리 목록(좁게)
        .child(v_flex().w(LEFT).h_full().flex_none().min_h(0).border_r_1().border_color(t.border)
          .child(app ? app.list(cx, t) : v_flex().p(16).gap(6).child(div().text_color(t.muted).child("준비 중인 앱입니다"))
            .child(div().text_size(12).text_color(t.dim).child(a.desc))))
        // 오른쪽: 고른 항목(강조: 더 넓고 밝은 바탕)
        .child(v_flex().flex_1().h_full().min_w(0).min_h(0).bg(t.background)
          .child(detail ?? v_flex().size_full().items_center().justify_center().gap(10)
            .child(this.tile(a, 40, t).opacity(0.5))
            .child(div().text_size(14).text_color(t.muted).child("선택 내용이 없습니다"))
            .child(div().text_size(12).text_color(t.dim).child(app ? "왼쪽에서 항목을 고르세요" : a.desc)))));
  }
}

const LEFT = 250;   // 왼쪽 관리 칸 폭(가운데 내용 칸을 강조하려고 좁게)

export default class OfficeApps extends View {
  init(p, cx) {
    const R = ROLES[(props() ?? p ?? {}).role] ?? Launcher;
    this.role = new R();
    this.role.init(p, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }
}
