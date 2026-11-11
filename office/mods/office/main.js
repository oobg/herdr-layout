// Office: 프로젝트(레포)마다 구역, 워크트리(스페이스)마다 테이블, 에이전트마다 캐릭터.
// 레이아웃이 props { role }로 역할을 나눈다.
//   floor    위쪽 사무실 그림. 테이블을 누르면 그 워크트리의 터미널 칸(office-term)을 연다.
//   termbar  터미널 칸 위의 막대. 지금 워크트리 이름과 닫기 버튼.
// 그래픽은 tools/render-office.py가 렌더한 아이소메트릭 스프라이트(sprites/)를 겹쳐 그린다.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  props, spaces, agents, panes, terminals, theme, run, exec,
  shared, setShared, nextCommand, readTextFile, appHome,
} from "herdr";

const TERM = "office-term";
const OPEN = "office.open";
const SPINNER = "mods/workspace-chrome/spinner.svg";
const C = { working: "#e8b92e", blocked: "#e5484d", done: "#30a46c" };
const SEATS = 4;
const SPRITES = "mods/office/sprites";
const ZONE_GAP = 1.2;                 // 구역 사이 통로(m)
const FILL = [2, 3, 0, 1];            // 자리를 채우는 순서: 얼굴이 보이는 안쪽 자리부터
const COLS = 3;                       // 구역 한 줄에 놓는 테이블 수
const EDGE = ["#7aa2d6aa", "#8cc0a0aa", "#d69a7aaa", "#b69ad6aa", "#d6c27aaa", "#7ac6c6aa"]; // 구역 테두리
const ZONE = ["#7aa2d633", "#8cc0a033", "#d69a7a33", "#b69ad633", "#d6c27a33", "#7ac6c633"]; // 구역 바닥 색
let SPR = null, SPR_LOADING = false;  // sprites/manifest.json
function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
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

  // 스프라이트 매니페스트(tools/render-office.py가 만든다). 모듈에 한 번 읽어 두고, 핫 리로드로 비면 다시 읽는다.
  loadSprites(cx) {
    if (SPR || SPR_LOADING) return;
    SPR_LOADING = true;
    cx.spawn(async (cx) => {
      try { SPR = JSON.parse(await readTextFile(`${appHome()}/${SPRITES}/manifest.json`)); } catch { SPR = null; }
      SPR_LOADING = false;
      cx.notify();
    });
  }

  render(cx) {
    this.loadSprites(cx);
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
    const box = this.box ?? { width: 0, height: 0 };

    return div().id("office-floor").relative().size_full().bg(t.surface).text_size(12).overflow_hidden()
      .on_size_change((size, cx) => { this.box = size; cx.notify(); })
      .track_focus(this.h)
      .on_key_down((e) => { if (e.key === "escape") closeTerm(); })
      .on_click(() => { this.h.focus(); if (open) closeTerm(); })
      .child(h_flex().absolute().top(12).left(14).gap(8).items_center()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("OFFICE"))
        .child(div().text_color(t.dim).child(`${ags.length}명 근무 중`)))
      .child(SPR ? this.scene(zones, ags, terms, open, box, t) : div().absolute().top(40).left(14).text_color(t.dim).child("사무실을 불러오는 중"));
  }

  // 아이소메트릭 장면. 구역(레포)마다 한 줄, 그 줄에 워크트리 테이블을 월드 x축으로 늘어놓는다.
  // 모든 스프라이트는 같은 카메라·캔버스로 렌더되어 있어, 월드 위치를 화면으로 옮긴 자리에 겹치면 맞는다.
  scene(zones, ags, terms, open, box, t) {
    const M = SPR, [CX, CY] = M.cell, [ox, oy] = M.origin;
    const at = (wx, wy) => [wx * M.ex[0] + wy * M.ey[0], wx * M.ex[1] + wy * M.ey[1]];
    // 구역 안 테이블은 한 줄에 COLS개, 넘치면 다음 줄. 구역은 그 아래(월드 -y)로 쌓는다.
    const tables = [], props = [], edges = [];
    let rowY = 0;
    zones.forEach(([key, z], j) => {
      const n = z.spaces.length, cols = Math.min(n, COLS), rows = Math.ceil(n / COLS);
      const cell = (c, r) => [c * CX, -(rowY + r * CY)];
      z.spaces.forEach((s, i) => {
        const c = i % COLS, r = Math.floor(i / COLS), [wx, wy] = cell(c, r), [px, py] = at(wx, wy);
        const has = (cc, rr) => cc >= 0 && rr >= 0 && rr < rows && cc < cols && rr * COLS + cc < n;
        tables.push({ key, z, j, i, s, x: px - ox, y: py - oy });
        // 구역 바깥 테두리: 이웃 칸이 없는 쪽 변만
        for (const [side, cc, rr] of [["xmin", c - 1, r], ["xmax", c + 1, r], ["ymax", c, r - 1], ["ymin", c, r + 1]])
          if (!has(cc, rr)) edges.push({ j, side, x: px - ox, y: py - oy });
      });
      // 소품: 뒤 모서리(화면 위) 화분, 오른쪽 모서리 정수기, 왼쪽 위 변 가운데 화이트보드.
      // 앞쪽(화면 아래)은 브랜치 이름표와 의자를 가리지 않게 비워 둔다.
      const L = -CX / 2 + 0.35, R = (cols - 1) * CX + CX / 2 - 0.35, B = -rowY + CY / 2 - 0.35, F = -(rowY + (rows - 1) * CY) - CY / 2 + 0.35;
      const put = (name, wx, wy) => { const [px, py] = at(wx, wy); props.push({ name, x: px - ox, y: py - oy }); };
      put("plant", L, B);
      put("water", R, B);
      put("whiteboard", L, (B + F) / 2);
      rowY += rows * CY + ZONE_GAP;
    });
    if (!tables.length) return div();
    // 장면 범위: 바닥 타일과 클릭 영역을 모두 감싼다.
    const [fx, fy, fw, fh] = M.floor, [hx0, hy0, hx1, hy1] = M.hit;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const tb of tables) {
      x0 = Math.min(x0, tb.x + fx, tb.x + hx0); y0 = Math.min(y0, tb.y + fy, tb.y + hy0 - 40);
      x1 = Math.max(x1, tb.x + fx + fw, tb.x + hx1); y1 = Math.max(y1, tb.y + fy + fh, tb.y + hy1 + 20);
    }
    for (const pr of props) {
      const m = M.props[pr.name];
      x0 = Math.min(x0, pr.x + ox - 70); x1 = Math.max(x1, pr.x + ox + 70);
      y0 = Math.min(y0, pr.y + m.top - 10); y1 = Math.max(y1, pr.y + m.bottom + 10);
    }
    // 칸에 맞게 한 배율로 줄이고, 칸 가운데에 둔다(터미널 칸을 열고 닫으면 미끄러지듯 옮겨 간다).
    const W = x1 - x0, H = y1 - y0;
    const k = Math.max(0.12, Math.min(1.0, (box.width - 28) / W, (box.height - 56) / H));
    const left = Math.max(8, (box.width - W * k) / 2), top = Math.max(40, (box.height - H * k) / 2 + 12);
    const P = (x, y) => [(x - x0) * k, (y - y0) * k];
    const els = [];

    // 1) 바닥: 구역 색 타일. 고른 테이블의 칸은 강조색으로 한 겹 더.
    for (const tb of tables) {
      const [l, tp] = P(tb.x + fx, tb.y + fy);
      els.push(svg(`${SPRITES}/floor.svg`).absolute().left(l).top(tp).w(fw * k).h(fh * k).text_color(ZONE[tb.j % ZONE.length]));
      if (open === tb.s.id) els.push(svg(`${SPRITES}/floor.svg`).absolute().left(l).top(tp).w(fw * k).h(fh * k).text_color(`${t.accent}55`));
    }
    for (const e of edges) {
      const [l, tp] = P(e.x + fx, e.y + fy);
      els.push(svg(`${SPRITES}/edge_${e.side}.svg`).absolute().left(l).top(tp).w(fw * k).h(fh * k).text_color(EDGE[e.j % EDGE.length]));
    }
    // 2) 구역 이름: 그 구역 첫 칸의 왼쪽 모서리 위.
    for (const [key, z] of zones) {
      const tb = tables.find((x) => x.key === key);
      const [l, tp] = P(tb.x + fx, tb.y + fy + fh * 0.5);
      els.push(div().absolute().left(l).top(tp - 22).px(6).py(1).rounded(4).bg(`${t.chrome}cc`).text_size(12).font_semibold()
        .text_color(t.foreground).whitespace_nowrap().child(z.name));
    }
    // 3) 테이블과 자리: 화면 뒤쪽(위)부터. 자리 층은 테이블에 가려지는 부분이 이미 지워져 있어 테이블 뒤에 그려도 맞다.
    const seated = [], S = M.size * k;
    const things = [...tables.map((tb) => ({ tb, y: tb.y })), ...props.map((pr) => ({ pr, y: pr.y }))].sort((a, b) => a.y - b.y);
    for (const { tb, pr } of things) {
      if (pr) {
        const [l, tp] = P(pr.x, pr.y);
        els.push(image(`${SPRITES}/prop_${pr.name}.png`).absolute().left(l).top(tp).w(S).h(S));
        continue;
      }
      const mine = ags.filter((a) => a.space === tb.s.id);
      const seats = this.assign(mine);
      const [l, tp] = P(tb.x, tb.y);
      els.push(image(`${SPRITES}/table.png`).absolute().left(l).top(tp).w(S).h(S));
      for (const i of M.order) {
        const who = seats[i];
        els.push(image(`${SPRITES}/seat${i}_${who ? who.ch : "empty"}.png`).absolute().left(l).top(tp).w(S).h(S));
        if (who) seated.push({ a: who.a, x: tb.x + M.seats[i].head[0], y: tb.y + M.seats[i].head[1] });
      }
      tb.more = mine.length - Math.min(mine.length, 4);
    }
    // 4) 말풍선: 머리 위. 모든 스프라이트 위에 그린다.
    for (const w of seated) {
      const [l, tp] = P(w.x, w.y);
      els.push(div().absolute().left(l - 21).top(tp - 54).child(this.bubble(w.a, terms, t)));
    }
    // 5) 테이블 이름과 클릭 영역(이미지는 투명한 곳도 사각형으로 눌리므로 매니페스트의 영역을 따로 둔다).
    for (const tb of tables) {
      const [l, tp] = P(tb.x + hx0, tb.y + hy0), w = (hx1 - hx0) * k, h = (hy1 - hy0) * k, sel = open === tb.s.id;
      els.push(div().id(`table-${tb.s.id}`).absolute().left(l).top(tp).w(w).h(h).rounded(8).cursor_pointer()
        .hover((st) => st.bg("#ffffff0c"))
        .on_click((_e, cx) => { cx.stop_propagation(); openSpace(tb.s.id); }));
      els.push(h_flex().absolute().left(l).top(tp + h - 4).w(w).justify_center().gap(6)
        .child(div().px(6).py(1).rounded(4).text_size(11).bg(sel ? t.accent : `${t.chrome}cc`)
          .text_color(sel ? t.accent_foreground : t.muted).whitespace_nowrap().child(tb.s.branch || tb.s.name))
        .when(tb.more > 0, (el) => el.child(div().px(5).py(1).rounded(4).text_size(11).bg(`${t.chrome}cc`).text_color(t.foreground).child(`+${tb.more}`))));
    }
    return div().id("office-scene").absolute().left(left).top(top).w(W * k).h(H * k)
      .transition("left", { duration: 380, easing: "ease-out" })
      .transition("top", { duration: 380, easing: "ease-out" })
      .children(els);
  }

  // 에이전트를 자리에 앉힌다. 얼굴이 보이는 안쪽 자리부터, 캐릭터는 주소로 고정하되 한 테이블에서 겹치지 않게.
  assign(mine) {
    const seats = {}, used = new Set(), chars = SPR.characters;
    mine.slice(0, 4).forEach((a, n) => {
      let c = hash(a.address) % chars.length;
      while (used.has(c) && used.size < chars.length) c = (c + 1) % chars.length;
      used.add(c);
      seats[FILL[n]] = { a, ch: chars[c] };
    });
    return seats;
  }

  // 말풍선: 흰 바탕에 에이전트 로고, 우상단에 상태 뱃지. 아래 꼬리로 머리를 가리킨다.
  bubble(a, terms, t) {
    return v_flex().items_center()
      .child(div().relative().p(7).rounded(10).bg("#ffffff").border_1().border_color("#00000022")
        .child(programIcon(a.program, 24, t))
        .child(div().absolute().top(-7).right(-7).child(this.badge(a, terms, t, 16))))
      .child(div().w(3).h(9).bg("#ffffff"));
  }

  badge(a, terms, t, z = 11) {
    // 서브에이전트: 이 에이전트가 부모인 터미널 중 일하는 것.
    const kid = terms.find((x) => x.parent === a.address && x.status === "working");
    if (kid) {
      const color = kid.program?.tile || hashColor(kid.address);
      return div().size(z + 2).rounded_full().border_2().border_color(color).bg("#ffffff")
        .items_center().justify_center().flex().child(programIcon(kid.program, Math.round(z * 0.55), t));
    }
    if (a.status === "working") return div().size(z).rounded_full().bg("#ffffff").child(svg(SPINNER).size(z).text_color(C.working).spin(900));
    if (a.status === "blocked") return div().size(z).rounded_full().bg(C.blocked).flex().items_center().justify_center()
      .text_size(Math.round(z * 0.7)).font_semibold().text_color("#ffffff").child("?");
    if (a.status === "done") return div().size(z - 2).rounded_full().bg(C.done).border_2().border_color("#ffffff");
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
