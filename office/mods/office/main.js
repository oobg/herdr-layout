// Office: 프로젝트(레포)마다 구역, 워크트리(스페이스)마다 테이블, 에이전트마다 캐릭터.
// 레이아웃이 props { role }로 역할을 나눈다.
//   floor    위쪽 사무실 그림. 테이블을 누르면 그 워크트리의 터미널 칸(office-term)을 연다.
//   termbar  터미널 칸 위의 막대. 지금 워크트리 이름과 닫기 버튼.
// 지금은 도형 자리표시자다. Blender 렌더 이미지가 준비되면 도형을 image()로 바꾼다.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  props, spaces, agents, panes, terminals, theme, run, exec,
  shared, setShared, nextCommand,
} from "herdr";

const TERM = "office-term";
const OPEN = "office.open";
const SPINNER = "mods/workspace-chrome/spinner.svg";
const C = { working: "#e8b92e", blocked: "#e5484d", done: "#30a46c" };
const SEATS = 4;
// 셔츠·서브에이전트 색. gpui는 hsl()을 받지 않아 hex로 둔다.
const PALETTE = ["#7aa2d6", "#8cc0a0", "#d69a7a", "#b69ad6", "#d6c27a", "#7ac6c6", "#d67aa2", "#a2b07a"];

// 터미널 칸 열고 닫기: 모든 역할이 같은 함수를 쓴다.
function openSpace(id) {
  if (shared(OPEN) === id) return closeTerm();
  run("space.select", { id });
  run("layout.show", { id: TERM });
  setShared(OPEN, id);
}
function closeTerm() {
  run("layout.hide", { id: TERM });
  setShared(OPEN, null);
}

// 이름에서 고정된 색 하나: 서브에이전트 색이 따로 없을 때 쓴다.
function hashColor(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function programIcon(p, size, t) {
  if (p?.icon) return p.tint ? svg(p.icon).size(size).text_color(p.color || t.foreground) : image(p.icon).size(size);
  return div().text_size(size - 2).text_color(t.foreground).child((p?.name || "?").slice(0, 1));
}

class Floor {
  init(_p, cx) {
    this.repo = {}; // "machine|cwd" -> { key, name } | null(레포 아님)
    this.pending = new Set();
    this.h = cx.focus_handle();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.h.focus();
        cx.notify();
      }
    });
  }

  // 스페이스가 지금 있는 폴더: 첫 터미널의 현재 폴더, 없으면 만든 폴더.
  where(s, ps) {
    const tabs = new Set(s.tabs.map((x) => x.id));
    const p = ps.find((x) => tabs.has(x.tab) && x.cwd);
    return p?.cwd || s.folder || null;
  }

  lookup(s, cwd, cx) {
    const k = `${s.machine ?? ""}|${cwd}`;
    if (k in this.repo || this.pending.has(k)) return this.repo[k];
    this.pending.add(k);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on: s.machine });
        const dir = r.code === 0 ? r.stdout.trim() : "";
        const base = (x) => x.replace(/\/+$/, "").split("/").pop();
        this.repo[k] = dir ? { key: `${s.machine ?? ""}|${dir}`, name: dir.endsWith("/.git") ? base(dir.slice(0, -5)) : base(dir).replace(/\.git$/, "") } : null;
      } catch {
        this.repo[k] = null;
      }
      this.pending.delete(k);
      cx.notify();
    });
    return undefined;
  }

  render(cx) {
    const t = theme(), ps = panes(), ags = agents(), terms = terminals();
    const groups = new Map();
    for (const s of spaces()) {
      const cwd = this.where(s, ps);
      const r = cwd ? this.lookup(s, cwd, cx) : null;
      const key = r ? r.key : "~other";
      if (!groups.has(key)) groups.set(key, { name: r ? r.name : "기타", spaces: [] });
      groups.get(key).spaces.push(s);
    }
    // 기타 구역은 맨 뒤.
    const zones = [...groups.entries()].sort(([a], [b]) => (a === "~other") - (b === "~other"));
    const open = shared(OPEN);

    // 장면을 칸 가운데에 둔다. 칸 너비가 바뀌면(터미널 칸 열기/닫기) left가 바뀌고,
    // transition이 그 변화를 미끄러지듯 보여 준다. 칸 크기 자체는 레이아웃이 한 번에 바꾼다.
    const box = this.box ?? { width: 0, height: 0 }, scene = this.scene ?? { width: 0, height: 0 };
    const left = Math.max(14, (box.width - scene.width) / 2);
    const top = Math.max(14, (box.height - scene.height) / 2);

    return div().id("office-floor").relative().size_full().bg(t.surface).text_size(12).overflow_hidden()
      .on_size_change((size, cx) => { this.box = size; cx.notify(); })
      .track_focus(this.h)
      .on_key_down((e) => { if (e.key === "escape") closeTerm(); })
      .on_click(() => { this.h.focus(); if (open) closeTerm(); })
      .child(h_flex().absolute().top(12).left(14).gap(8).items_center()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("OFFICE"))
        .child(div().text_color(t.dim).child(`${ags.length}명 근무 중`)))
      .child(h_flex().id("office-scene").absolute().left(left).top(top)
        .max_w(Math.max(200, box.width - 28)).flex_wrap().gap(12).items_start()
        .transition("left", { duration: 380, easing: "ease-out" })
        .transition("top", { duration: 380, easing: "ease-out" })
        .on_size_change((size, cx) => { this.scene = size; cx.notify(); })
        .children(zones.map(([key, z]) => this.zone(key, z, ags, terms, open, t))));
  }

  zone(key, z, ags, terms, open, t) {
    return v_flex().id(`zone-${key}`).gap(8).p(10).rounded(10).bg(t.raised).border_1().border_color(t.border)
      .child(div().text_color(t.muted).font_semibold().child(z.name))
      .child(h_flex().flex_wrap().gap(10).children(z.spaces.map((s) => this.table(s, ags, terms, open, t))));
  }

  table(s, ags, terms, open, t) {
    const mine = ags.filter((a) => a.space === s.id);
    const shown = mine.slice(0, SEATS), more = mine.length - shown.length;
    const sel = open === s.id;
    return v_flex().id(`table-${s.id}`).w(150).gap(6).p(8).rounded(8)
      .bg(sel ? t.selected : t.background).border_1().border_color(sel ? t.accent : t.border)
      .hover((st) => st.border_color(t.accent))
      .on_click((_e, cx) => { cx.stop_propagation(); openSpace(s.id); })
      .child(h_flex().h(64).gap(6).items_end().justify_center().children([
        ...shown.map((a) => this.worker(a, terms, t)),
        ...(more > 0 ? [div().text_color(t.dim).child(`+${more}`)] : []),
        ...(mine.length === 0 ? [div().text_color(t.dim).child("빈 책상")] : []),
      ]))
      .child(div().h(10).rounded(3).bg("#c9a27a"))
      .child(div().truncate().text_color(sel ? t.foreground : t.muted).child(s.branch || s.name));
  }

  // 캐릭터 한 명: 머리 위 말풍선(에이전트 로고) + 우상단 상태 뱃지.
  worker(a, terms, t) {
    return v_flex().items_center().gap(2)
      .child(div().relative().p(3).rounded(6).bg("#ffffff").border_1().border_color(t.border)
        .child(programIcon(a.program, 14, t))
        .child(div().absolute().top(-5).right(-5).child(this.badge(a, terms, t))))
      .child(div().size(12).rounded_full().bg("#e8c4a0"))
      .child(div().w(18).h(14).rounded(4).bg(hashColor(a.address)));
  }

  badge(a, terms, t) {
    // 서브에이전트: 이 에이전트가 부모인 터미널 중 일하는 것.
    const kid = terms.find((x) => x.parent === a.address && x.status === "working");
    if (kid) {
      const color = kid.program?.tile || hashColor(kid.address);
      return div().size(12).rounded_full().border_2().border_color(color).bg(t.background)
        .items_center().justify_center().flex().child(programIcon(kid.program, 6, t));
    }
    if (a.status === "working") return svg(SPINNER).size(11).text_color(C.working).spin(900);
    if (a.status === "blocked") return div().size(11).rounded_full().bg(C.blocked).flex().items_center().justify_center()
      .text_size(8).font_semibold().text_color("#ffffff").child("?");
    if (a.status === "done") return div().size(10).rounded_full().bg(C.done);
    return div();
  }
}

class Termbar {
  render() {
    const t = theme();
    const s = spaces().find((x) => x.active);
    return h_flex().size_full().px(10).gap(8).items_center().text_size(12)
      .child(div().flex_1().truncate().text_color(t.muted)
        .child(s ? `${s.name}${s.branch ? ` · ${s.branch}` : ""}` : ""))
      .child(div().id("office-close").px(6).rounded(4).text_color(t.muted)
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeTerm())
        .child("✕"));
  }
}

const ROLES = { floor: Floor, termbar: Termbar };

export default class Office extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    const R = ROLES[pr.role];
    this.role = R ? new R() : null;
    this.role?.init?.(pr, cx);
  }

  render(cx) {
    if (!this.role) return div().child(`office: 알 수 없는 role "${props()?.role}"`);
    return this.role.render(cx);
  }
}
