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
// 구역 이름으로 시드를 정한 난수(mulberry32)와 섞기.
function seeded(key) { let a = hash(key) || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(list, rnd) { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
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
    // 터미널 칸이 열려 있으면 위는 장면, 아래는 고른 워크트리의 오버뷰.
    const sel = open ? spaces().find((x) => x.id === open) : null;
    const sceneH = sel ? Math.max(180, Math.round(box.height * 0.4)) : box.height;

    return div().id("office-floor").relative().size_full().bg(t.surface).text_size(12).overflow_hidden()
      .on_size_change((size, cx) => { this.box = size; cx.notify(); })
      .track_focus(this.h)
      .on_key_down((e) => { if (e.key === "escape") closeTerm(); })
      .on_click(() => { this.h.focus(); if (open) closeTerm(); })
      .child(h_flex().absolute().top(12).left(14).gap(8).items_center()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("OFFICE"))
        .child(div().text_color(t.dim).child(`${ags.length}명 근무 중`)))
      .child(SPR ? this.scene(zones, ags, terms, open, { width: box.width, height: sceneH }, t) : div().absolute().top(40).left(14).text_color(t.dim).child("사무실을 불러오는 중"))
      .when(Boolean(sel), (el) => el.child(div().absolute().left(0).top(sceneH).w(box.width).h(Math.max(0, box.height - sceneH))
        .child(this.overview(sel, groups, ags, terms, cx, t))));
  }

  // ── 오버뷰: 고른 워크트리 한눈에 ───────────────────────────
  // git 상태(브랜치, 앞섬·뒤처짐, 바뀐 파일)는 열려 있는 동안 10초마다 읽는다.
  gitFor(s, cx) {
    const cwd = this.where(s, panes());
    const k = `${s.id}|${cwd}`, g = this.git?.[k];
    if (!cwd || this.gitBusy?.has(k) || (g && Date.now() - g.at < 10000)) return g;
    (this.gitBusy ??= new Set()).add(k);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "-b", "-uall"], { cwd, on: s.machine });
        const lines = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
        const head = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : "";
        const files = lines.map((l) => ({ xy: l.slice(0, 2), path: l.slice(3) }));
        (this.git ??= {})[k] = { at: Date.now(), ok: r.code === 0, files,
          ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0), gone: /\[gone\]/.test(head),
          upstream: /\.\.\.(\S+)/.exec(head)?.[1] ?? null };
      } catch { (this.git ??= {})[k] = { at: Date.now(), ok: false, files: [] }; }
      this.gitBusy.delete(k);
      cx.notify();
    });
    return g;
  }

  overview(s, groups, ags, terms, cx, t) {
    const mine = ags.filter((a) => a.space === s.id);
    const g = this.gitFor(s, cx) ?? { files: [], ahead: 0, behind: 0 };
    const repo = [...groups.values()].find((z) => z.spaces.some((x) => x.id === s.id))?.name ?? s.name;
    const blocked = mine.filter((a) => a.status === "blocked");
    const tabOf = (a) => s.tabs.find((x) => x.id === a.tab);
    const mins = (ms) => (ms ? Math.max(0, Math.round((Date.now() - ms) / 60000)) : null);
    const ago = (m) => (m == null ? "" : m < 1 ? "방금" : m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`);
    const name = (a) => a.program?.name ?? a.app ?? "에이전트";
    const goto = (a) => () => run("agent.focus", { terminal: a.address });
    const STATUS = { working: ["작업 중", C.working], blocked: ["입력 대기", C.blocked], done: ["완료", C.done], idle: ["대기", t.muted] };

    const H = (text, extra) => h_flex().pt(18).pb(6).items_baseline().gap(8)
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(text))
      .when(Boolean(extra), (el) => el.child(extra));
    // 에이전트 줄: 1행 상태·이름·경과, 2행 하는 일(창 제목). 상태 단어에만 색.
    const agentRow = (a, sub) => {
      const [label, color] = STATUS[a.status] ?? ["", t.muted];
      const m = a.status === "working" ? mins(tabOf(a)?.working_since) : null;
      return v_flex().id(`ov-${a.address}`).py(7).px(8).ml(sub ? 16 : 0).rounded(6).gap(2).cursor_pointer()
        .hover((st) => st.bg(t.hover)).on_click(goto(a))
        .child(h_flex().gap(8).items_center()
          .child(programIcon(a.program, 16, t))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(name(a)))
          .child(div().flex_none().text_size(12).text_color(color).child(label))
          .when(m != null, (el) => el.child(div().flex_none().w(52).text_right().text_size(12).text_color(t.muted).child(ago(m)))))
        .when(Boolean(a.title), (el) => el.child(div().pl(24).truncate().text_size(12).text_color(t.muted).child(a.title)));
    };
    const fileRow = (f) => {
      const mark = f.xy === "??" ? ["새", "#d1675a"] : f.xy.includes("D") ? ["삭제", t.muted] : f.xy.includes("A") ? ["추가", "#629755"] : ["수정", "#6897bb"];
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      return h_flex().py(4).px(8).gap(10).items_center()
        .child(div().flex_none().w(28).text_size(12).text_color(mark[1]).child(mark[0]))
        .child(div().flex_none().text_size(13).text_color(t.foreground).child(f.path.split("/").pop()))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(dir));
    };
    const link = (id, text, fn) => div().id(id).text_size(12).text_color(t.accent).cursor_pointer().hover((st) => st.underline()).on_click(fn).child(text);
    const sync = [g.ahead ? `↑${g.ahead}` : null, g.behind ? `↓${g.behind}` : null].filter(Boolean).join(" ");

    return v_flex().id("ov").size_full().border_t_1().border_color(t.border).bg(t.chrome).overflow_y_scrollbar().px(16).pb(16)
      // 제목: 레포 이름이 가장 크고, 브랜치·머신은 한 단계 낮게
      .child(h_flex().pt(16).gap(8).items_baseline()
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(repo))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(`${s.branch ?? "브랜치 없음"}${s.machine ? ` · ${s.machine}` : ""}`))
        .when(Boolean(sync), (el) => el.child(div().flex_none().text_size(13).text_color(t.foreground).child(sync))))
      // 목록이 이미 보여 주는 것은 다시 글로 쓰지 않는다. 비어 있을 때만 한 줄.
      .when(!mine.length && !g.files.length, (el) => el.child(div().pt(10).text_size(13).text_color(t.muted).child("에이전트도 변경도 없습니다")))
      // 답을 기다리는 에이전트가 있으면 바로 열 수 있게
      .when(blocked.length > 0, (el) => el.child(h_flex().mt(12).gap(10).items_center()
        .child(div().id("ov-open").px(12).py(5).rounded(6).bg(C.blocked).text_size(13).font_semibold().text_color("#ffffff").cursor_pointer()
          .hover((st) => st.opacity(0.9)).on_click(goto(blocked[0])).child(`${name(blocked[0])} 답하기`))
        .when(blocked.length > 1, (x) => x.child(div().text_size(12).text_color(t.muted).child(`외 ${blocked.length - 1}명`)))))
      .when(mine.length > 0, (el) => el
        .child(H(`에이전트 ${mine.length}`))
        .children(mine.flatMap((a) => [agentRow(a, false),
          ...terms.filter((x) => x.parent === a.address && x.status)
            .map((k) => agentRow({ address: k.address, status: k.status, program: k.program, app: k.report?.app, title: k.name ?? "", tab: a.tab }, true))])))
      .when(g.files.length > 0, (el) => el
        .child(H(`변경 파일 ${g.files.length}`, link("ov-log", "커밋 로그 보기", () => setShared("office-git.show", { name: s.branch, ref: "HEAD", top: this.where(s, panes()), at: Date.now() }))))
        .children(g.files.slice(0, 10).map(fileRow))
        .when(g.files.length > 10, (x) => x.child(div().px(8).pt(4).text_size(12).text_color(t.muted).child(`외 ${g.files.length - 10}개`))));
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
      // 소품: 구역마다 다르게, 구역 이름으로 시드를 정해 무작위로(새로 그려도 같은 자리).
      // 자리는 뒤·왼쪽·오른쪽 가장자리만 쓴다. 앞쪽(화면 아래)은 이름표와 의자를 가리지 않게 비운다.
      const L = -CX / 2 + 0.35, R = (cols - 1) * CX + CX / 2 - 0.35, B = -rowY + CY / 2 - 0.35, F = -(rowY + (rows - 1) * CY) - CY / 2 + 0.35;
      const put = (name, wx, wy) => { const [px, py] = at(wx, wy); props.push({ name, x: px - ox, y: py - oy }); };
      const rnd = seeded(key);
      const spots = [
        { at: [L, B], corner: true }, { at: [R, B], corner: true }, { at: [L, F], corner: true },
        ...Array.from({ length: rows }, (_, r) => ({ at: [L, -(rowY + r * CY)], edge: "left" })),
        ...Array.from({ length: cols }, (_, c) => ({ at: [c * CX, B], edge: "back" })),
      ];
      const want = 2 + Math.floor(rnd() * (Math.min(4, spots.length - 1)));
      for (const sp of shuffle(spots, rnd).slice(0, want)) {
        const pool = sp.corner ? ["plant", "plant", "water", "bin", "cabinet"] : ["whiteboard", "bookcase", "cabinet", "plant"];
        put(pool[Math.floor(rnd() * pool.length)], ...sp.at);
      }
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
      const z = Math.round(Math.max(18, Math.min(28, 40 * k)));   // 로고 크기: 장면 배율을 따르되 너무 작아지지 않게
      els.push(div().absolute().left(l - z / 2 - 9).top(tp - z - 30).child(this.bubble(w.a, terms, t, z)));
    }
    // 구역 이름: 그 구역 첫 칸의 왼쪽 모서리 위. 소품·사람에 가리지 않게 스프라이트 위에 그린다.
    for (const [key, z] of zones) {
      const tb = tables.find((x) => x.key === key);
      const [l, tp] = P(tb.x + fx, tb.y + fy + fh * 0.5);
      els.push(div().absolute().left(l).top(tp - 22).px(6).py(1).rounded(4).bg(`${t.chrome}cc`).text_size(12).font_semibold()
        .text_color(t.foreground).whitespace_nowrap().child(z.name));
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
  // 테두리 색이 곧 상태(작업 중 노랑·입력 대기 빨강·완료 초록·대기 회색)라, 뱃지가 작아도 멀리서 읽힌다.
  bubble(a, terms, t, z = 24) {
    const ring = { working: C.working, blocked: C.blocked, done: C.done }[a.status] ?? "#9aa0a6";
    return v_flex().items_center()
      .child(div().relative().p(Math.round(z * 0.28)).rounded(Math.round(z * 0.45)).bg("#ffffff").border_2().border_color(ring).shadow_md()
        .child(programIcon(a.program, z, t))
        .child(div().absolute().top(-8).right(-8).child(this.badge(a, terms, t, Math.round(z * 0.7)))))
      .child(div().w(3).h(10).bg(ring));
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
