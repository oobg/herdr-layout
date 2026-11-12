// Office: 프로젝트(레포)마다 구역, 워크트리(스페이스)마다 테이블, 에이전트마다 캐릭터.
// 레이아웃이 props { role }로 역할을 나눈다.
//   floor    위쪽 사무실 그림. 테이블을 누르면 그 워크트리의 터미널 칸(office-term)을 연다.
//   termbar  터미널 칸 위의 막대. 지금 워크트리 이름과 닫기 버튼.
// 그래픽은 tools/render-office.py가 렌더한 아이소메트릭 스프라이트(sprites/)를 겹쳐 그린다.

import { View, div, svg, image } from "gpui-kit";
import * as fs from "fs/promises";
import { readActivity, readSub } from "./activity.js";
import { v_flex, h_flex } from "gpui-base";
import {
  props, spaces, agents, panes, terminals, theme, run, exec,
  shared, setShared, nextCommand, readTextFile, appHome, home, pickFolder, openOverlay,
  closeOverlay, knownAgents, focused,
} from "herdr";

// 에이전트 활동의 파일 줄을 누르면 office-apps의 뷰어 창(떠 있는 창, 역할 viewer)으로 연다.
//   office-apps/files.js openViewer와 같은 값: 다른 모드라 import할 수 없어 여기서 같은 openOverlay를 부른다.
//   key가 같으면(같은 머신의 같은 파일) 열린 창을 그 자리에서 바꿔 띄워 같은 파일 창이 늘지 않는다.
//   on: 원격 터미널 주소("machine/t7")면 그 머신(뷰어는 글로만 읽는다), 아니면 이 기기.
function openViewer(file, address) {
  if (!file || !file.startsWith("/")) return;
  const on = String(address ?? "").includes("/") ? String(address).split("/")[0] : null;
  openOverlay({ mod: "office-apps", kind: "window", key: `office-apps.viewer:${on ?? ""}:${file}`,
    width: 760, height: 560, props: { role: "viewer", file, on } });
}

const TERM = "office-term";
const FOLD = "office.fold";           // 활동 구역의 접힘·펼침(localStorage)
const SUBS = "office.subs";           // 구독 감지 결과 캐시(localStorage, 1분)
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

// 브랜드 로고로 바꿔 보여 줄 프로그램: Claude Code → Claude(주황 별), Codex → OpenAI.
// Herdr 기본 아이콘(Claude Code의 게 모양, Codex 아이콘)은 작게 그리면 잘 안 보여서다.
const BRAND = [
  [/claude/i, "mods/office/icons/claude.svg", "#d97757"],
  [/codex|openai/i, "mods/office/icons/openai.svg", "#111111"],
];

// onLight: 흰 바탕(말풍선 안)에 그릴 때. OpenAI 로고는 바탕에 따라 검정/글자색.
// agents()는 상태를 보고(OSC 7501)하는 터미널만 준다. Codex처럼 보고 훅이 없는 에이전트는
// 실행 중이어도 빠지므로, 칸에서 에이전트 프로그램이 돌고 있으면 상태 없이(null) 덧붙인다.
const SILENT_AGENT = /claude|codex|grok|antigravity|gemini|cursor|opencode|\bamp\b|\bpi\b/i;
function withSilent(list, ps) {
  const have = new Set(list.map((a) => a.address));
  const spaceOf = new Map(spaces().flatMap((s) => s.tabs.map((x) => [x.id, s])));
  const extra = ps.filter((p) => p.terminal && !p.status && !have.has(p.terminal) && spaceOf.has(p.tab)
      && (p.program?.agent || SILENT_AGENT.test(p.program?.key ?? "")))
    .map((p) => {
      const s = spaceOf.get(p.tab), tab = s.tabs.find((x) => x.id === p.tab);
      return { address: p.terminal, pane: p.pane, space: s.id, space_name: s.name, tab: p.tab, tab_index: tab?.index ?? 0,
        tab_name: tab?.name ?? "", status: null, app: null, program: p.program, title: p.title ?? "", seq: 0, pinned: false, focused: p.focused };
    });
  return extra.length ? [...list, ...extra] : list;
}

function programIcon(p, size, t, onLight = false) {
  const id = `${p?.key ?? ""} ${p?.name ?? ""}`;
  const brand = BRAND.find(([re]) => re.test(id));
  if (brand) return svg(brand[1]).size(size).text_color(brand[2] === "#111111" && !onLight ? t.foreground : brand[2]);
  if (p?.icon) return p.tint ? svg(p.icon).size(size).text_color(p.color || t.foreground) : image(p.icon).size(size);
  return div().text_size(size - 2).text_color(t.foreground).child((p?.name || "?").slice(0, 1));
}

class Floor {
  init(_p, cx) {
    this.repo = {}; // "machine|cwd" -> { key, name } | null(레포 아님)
    this.pending = new Set();
    this.h = cx.focus_handle();
    // 오버뷰의 활동 기록은 렌더할 때 오래됐으면 다시 읽는다(activityFor). 렌더는 Herdr 상태가 바뀔 때만 오므로,
    //   부모가 쉬는 동안 서브에이전트만 도는 때에도 제때 읽게 오버뷰가 열려 있으면 다시 읽을 때가 된 순간 다시 그린다.
    cx.timer.every(2500, (cx) => {
      if (shared(OPEN) && Date.now() >= (this.due ?? Infinity)) { this.due = Infinity; cx.notify(); }
    });
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
    // 예전 형식(방·사장님방 정보가 없는) 매니페스트를 들고 있으면 다시 읽는다.
    if ((SPR && SPR.boss && SPR.room) || SPR_LOADING) return;
    SPR_LOADING = true;
    cx.spawn(async (cx) => {
      try { SPR = JSON.parse(await readTextFile(`${appHome()}/${SPRITES}/manifest.json`)); } catch { SPR = null; }
      SPR_LOADING = false;
      cx.notify();
    });
  }

  // 일을 마친 에이전트는 다음 일을 시작할 때까지 "완료"로 둔다.
  // Herdr는 완료를 한 번 보면 대기(idle)로 바꾸지만, 사무실에서는 끝났다는 표시가 남아 있는 편이 읽기 쉽다.
  // 끝난 시각도 기억해 "완료 n분 전"으로 보여 준다. 켜기 전에 이미 끝나 있었으면 탭이 마지막으로 바뀐 시각.
  withDone(list) {
    const fin = (this.finished ??= new Map()), seen = (this.lastStatus ??= {});
    const tabTime = (a) => spaces().flatMap((s) => s.tabs).find((x) => x.id === a.tab)?.changed_at;
    const out = list.map((a) => {
      const prev = seen[a.address];
      seen[a.address] = a.status;
      if (a.status === "working" || a.status === "blocked") { fin.delete(a.address); return a; }
      if (a.status === "done" || (a.status === "idle" && (prev === "working" || prev === "done" || fin.has(a.address)))) {
        if (!fin.has(a.address)) fin.set(a.address, prev === "working" || prev === "blocked" ? Date.now() : tabTime(a) ?? Date.now());
        return { ...a, status: "done", doneAt: fin.get(a.address) };
      }
      return a;
    });
    return out;
  }

  render(cx) {
    this.loadSprites(cx);
    this.due = Infinity;   // 이번 렌더에서 activityFor·subFor가 다음에 다시 읽을 때를 다시 정한다
    const t = theme(), ps = panes(), ags = this.withDone(withSilent(agents(), ps)), terms = terminals();
    const groups = new Map();
    // 홈 폴더(~) 스페이스는 늘 있는 "사장님방"(임원용 책상), 레포는 레포 이름 방, 나머지는 "기타".
    groups.set("~boss", { name: "사장님방", boss: true, spaces: [] });
    for (const s of spaces()) {
      const cwd = this.where(s, ps);
      if (cwd === home() || (!cwd && s.name === "~")) { groups.get("~boss").spaces.push(s); continue; }
      const r = cwd ? this.lookup(s, cwd, cx) : null;
      const key = r ? r.key : "~other";
      if (!groups.has(key)) groups.set(key, { name: r ? r.name : "기타", spaces: [] });
      groups.get(key).spaces.push(s);
    }
    // 사장님방은 맨 앞, 기타는 맨 뒤.
    const rank = (k) => (k === "~boss" ? -1 : k === "~other" ? 1 : 0);
    const zones = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
    const open = shared(OPEN);
    const box = this.box ?? { width: 0, height: 0 };
    // 터미널 칸이 열려 있으면 위는 장면, 아래는 고른 워크트리의 오버뷰.
    const sel = open ? spaces().find((x) => x.id === open) : null;
    const sceneH = sel ? Math.max(180, Math.round(box.height * 0.4)) : box.height;

    return div().id("office-floor").relative().size_full().bg(t.surface).text_size(12).overflow_hidden()
      .on_size_change((size, cx) => { this.box = size; cx.notify(); })
      .track_focus(this.h)
      .on_key_down((e) => { if (e.key === "escape") closeTerm(); })
      .on_click(() => { this.h.focus(); })
      .child(SPR ? this.scene(zones, ags, terms, open, { width: box.width, height: sceneH }, t, cx) : div().absolute().top(40).left(14).text_color(t.dim).child("사무실을 불러오는 중"))
      // 머리줄은 장면 위에: 확대했을 때 다른 구역이 덮지 않게 배경을 깐다.
      .child(h_flex().absolute().top(0).left(0).w(box.width).h(36).px(14).gap(8).items_center().bg(`${t.surface}e6`)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("OFFICE"))
        .child(div().text_color(t.dim).child(`${ags.length}명 근무 중`))
        .when(!open, (el) => el.child(div().flex_1()).child(div().id("office-add").px(8).py(2).rounded(5).border_1().border_color(t.border)
          .text_size(12).text_color(t.foreground).cursor_pointer().hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            // 폴더를 골라 그 폴더에서 새 스페이스를 연다 = 사무실 하나 추가
            cx.spawn(async () => { const folder = await pickFolder({ prompt: "사무실로 쓸 폴더" }); if (folder) run("space.new", { folder }); });
          })
          .child("+ 사무실 추가하기")))
        .when(Boolean(open), (el) => el.child(div().flex_1()).child(div().id("office-all").text_size(12).text_color(t.accent).cursor_pointer()
          .hover((st) => st.underline()).on_click((_e, cx) => { cx.stop_propagation(); closeTerm(); }).child("전체 보기"))))
      .when(Boolean(sel), (el) => el.child(div().absolute().left(0).top(sceneH).w(box.width).h(Math.max(0, box.height - sceneH))
        .child(this.overview(sel, groups, ags, terms, cx, t))));
  }

  // ── 오버뷰: 고른 워크트리 한눈에 ───────────────────────────
  // git 상태(브랜치, 앞섬·뒤처짐)는 열려 있는 동안 10초마다 읽는다.
  gitFor(s, cx) {
    const cwd = this.where(s, panes());
    const k = `${s.id}|${cwd}`, g = this.git?.[k];
    if (!cwd || this.gitBusy?.has(k) || (g && Date.now() - g.at < 10000)) return g;
    (this.gitBusy ??= new Set()).add(k);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "-b", "-uno"], { cwd, on: s.machine });
        const lines = r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
        const head = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : "";
        (this.git ??= {})[k] = { at: Date.now(), ok: r.code === 0,
          ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0), gone: /\[gone\]/.test(head),
          upstream: /\.\.\.(\S+)/.exec(head)?.[1] ?? null };
      } catch { (this.git ??= {})[k] = { at: Date.now(), ok: false }; }
      this.gitBusy.delete(k);
      cx.notify();
    });
    return g;
  }

  overview(s, groups, ags, terms, cx, t) {
    const mine = ags.filter((a) => a.space === s.id);
    const g = this.gitFor(s, cx) ?? { ahead: 0, behind: 0 };
    const repo = [...groups.values()].find((z) => z.spaces.some((x) => x.id === s.id))?.name ?? s.name;
    const blocked = mine.filter((a) => a.status === "blocked");
    const tabOf = (a) => s.tabs.find((x) => x.id === a.tab);
    const mins = (ms) => (ms ? Math.max(0, Math.round((Date.now() - ms) / 60000)) : null);
    const ago = (m) => (m == null ? "" : m < 1 ? "방금" : m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`);
    const name = (a) => a.program?.name ?? a.app ?? "에이전트";
    const goto = (a) => () => run("agent.focus", { terminal: a.address });
    const STATUS = { working: ["작업 중", C.working], blocked: ["입력 대기", C.blocked], done: ["완료", C.done], idle: ["대기", t.muted] };

    // "에이전트 N" 머리줄 + 오른쪽 "+": 구독이 있는 에이전트를 골라 이 스페이스에 새 탭으로 띄운다.
    const addHead = (text) => h_flex().pt(18).pb(6).items_center().gap(8)
      .child(div().flex_1().text_size(12).font_semibold().text_color(t.muted).child(text))
      .child(div().id("ov-add-agent").w(20).h(18).flex().items_center().justify_center().rounded(4).text_size(14).text_color(t.muted)
        .cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); openAddMenu(s, this.where(s, panes())); })
        .child("+"));
    // 에이전트 줄: 1행 상태·이름·경과, 2행 하는 일(창 제목). 상태 단어에만 색.
    const agentRow = (a, sub) => {
      const [label, color] = STATUS[a.status] ?? [a.status == null ? "상태 모름" : "", t.dim];
      const m = a.status === "working" ? mins(tabOf(a)?.working_since) : null;
      // 지금 보고 있는(포커스된) 에이전트 줄은 선택 표시. 누르면 그 터미널로 전환(탭 역할).
      const here = Boolean(a.focused) || focused()?.terminal === a.address;
      // 부모 에이전트 줄에만 hover 시 ✕(닫기). 서브에이전트는 부모가 관리하므로 두지 않는다.
      const closable = !sub && Boolean(a.pane) && this.hov === a.address;
      return v_flex().id(`ov-${a.address}`).py(7).px(8).ml(sub ? 16 : 0).rounded(6).gap(2).cursor_pointer()
        .when(here, (el) => el.bg(t.selected))
        .hover((st) => st.bg(here ? t.selected : t.hover)).on_click(goto(a))
        .when(!sub, (el) => el.on_hover((h, cx) => {
          const next = h ? a.address : this.hov === a.address ? null : this.hov;
          if (next !== this.hov) { this.hov = next; cx.notify(); }
        }))
        .child(h_flex().gap(8).items_center()
          // 부모 에이전트 줄: 맨 왼쪽 접기 화살표(아래 활동을 접고 편다). 줄 자체를 누르면 터미널로 간다.
          .when(!sub, (el) => {
            const k = `${a.address}|agent`, open = this.isOpen(k, true);
            // 접을 것(활동 기록 또는 하위 에이전트)이 없으면 자리만 둔다. 상태를 보고하지 않는 에이전트(Codex 등)는 기록이 없다.
            const has = a.status != null || terms.some((x) => x.parent === a.address && x.status);
            if (!has) return el.child(div().w(14).flex_none());
            return el.child(div().id(`ov-fold-${a.address}`).w(14).h(16).flex_none().flex().items_center().justify_center().rounded(3)
              .cursor_pointer().hover((st) => st.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(k, true, cx); })
              .child(svg(`mods/office/icons/chevron-${open ? "down" : "right"}.svg`).size(10).text_color(t.muted)));
          })
          .child(programIcon(a.program, 16, t))
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(name(a)))
          .child(div().flex_none().text_size(12).text_color(color).child(label))
          .when(m != null, (el) => el.child(div().flex_none().w(52).text_right().text_size(12).text_color(t.muted).child(ago(m))))
          .when(!sub, (el) => el.child(div().id(`ov-close-${a.address}`).w(16).h(16).flex_none().flex().items_center().justify_center()
            .rounded(4).text_size(11).text_color(closable ? t.muted : "#00000000")
            .when(closable, (x) => x.cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => { cx.stop_propagation(); openCloseConfirm(a, name(a)); }))
            .child("✕"))))
        .when(Boolean(a.title), (el) => el.child(div().pl(sub ? 24 : 46).truncate().text_size(12).text_color(t.muted).child(a.title)));
    };
    const sync = [g.ahead ? `↑${g.ahead}` : null, g.behind ? `↓${g.behind}` : null].filter(Boolean).join(" ");

    return v_flex().id("ov").size_full().border_t_1().border_color(t.border).bg(t.chrome).overflow_y_scrollbar().px(16).pb(16)
      // 제목: 레포 이름이 가장 크고, 브랜치·머신은 한 단계 낮게
      .child(h_flex().pt(16).gap(8).items_baseline()
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(repo))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(`${s.branch ?? "브랜치 없음"}${s.machine ? ` · ${s.machine}` : ""}`))
        .when(Boolean(sync), (el) => el.child(div().flex_none().text_size(13).text_color(t.foreground).child(sync))))
      // 목록이 이미 보여 주는 것은 다시 글로 쓰지 않는다. 비어 있을 때만 한 줄.
      .when(!mine.length, (el) => el.child(addHead("에이전트 0")).child(div().text_size(13).text_color(t.muted).child("에이전트가 없습니다")))
      // 답을 기다리는 에이전트가 있으면 바로 열 수 있게
      .when(blocked.length > 0, (el) => el.child(h_flex().mt(12).gap(10).items_center()
        .child(div().id("ov-open").px(12).py(5).rounded(6).bg(C.blocked).text_size(13).font_semibold().text_color("#ffffff").cursor_pointer()
          .hover((st) => st.opacity(0.9)).on_click(goto(blocked[0])).child(`${name(blocked[0])} 답하기`))
        .when(blocked.length > 1, (x) => x.child(div().text_size(12).text_color(t.muted).child(`외 ${blocked.length - 1}명`)))))
      .when(mine.length > 0, (el) => el
        .child(addHead(`에이전트 ${mine.length}`))
        .children(mine.flatMap((a) => [agentRow(a, false), this.activityView(a, cx, t),
          ...terms.filter((x) => x.parent === a.address && x.status && this.isOpen(`${a.address}|agent`, true))
            .map((k) => agentRow({ address: k.address, status: k.status, program: k.program, app: k.report?.app, title: k.name ?? "", tab: a.tab }, true))])));
  }

  // 아이소메트릭 장면. 구역(레포)마다 한 줄, 그 줄에 워크트리 테이블을 월드 x축으로 늘어놓는다.
  // 모든 스프라이트는 같은 카메라·캔버스로 렌더되어 있어, 월드 위치를 화면으로 옮긴 자리에 겹치면 맞는다.
  // 구역을 격자로 놓은 배치 하나를 만든다. zc = 격자 열 수. 좌표는 캔버스 단위(배율 적용 전).
  layout(zones, zc) {
    const M = SPR, [CX, CY] = M.cell, [ox, oy] = M.origin;
    const at = (wx, wy) => [wx * M.ex[0] + wy * M.ey[0] - ox, wx * M.ex[1] + wy * M.ey[1] - oy];
    // 빈 사장님방도 책상 하나짜리 방으로 그린다(누르면 홈 폴더에서 새 스페이스).
    const list = (z) => (z.spaces.length ? z.spaces : [null]);
    const dims = zones.map(([, z]) => ({ cols: Math.min(list(z).length, COLS), rows: Math.ceil(list(z).length / COLS) }));
    const SW = Math.max(...dims.map((d) => d.cols)) * CX + ZONE_GAP, SD = Math.max(...dims.map((d) => d.rows)) * CY + ZONE_GAP;
    const tables = [], props = [], edges = [], walls = [], plates = [];
    const ez = M.ez;
    zones.forEach(([key, z], j) => {
      const { cols, rows } = dims[j], n = list(z).length;
      const zx = (j % zc) * SW, zy = -Math.floor(j / zc) * SD;   // 구역 자리: 격자 칸
      const has = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows && r * COLS + c < n;
      list(z).forEach((s, i) => {
        const c = i % COLS, r = Math.floor(i / COLS), wx = zx + c * CX, wy = zy - r * CY;
        const [x, y] = at(wx, wy);
        // 칸 마름모의 맨 위·맨 아래 꼭짓점(이름표 자리)
        const top = at(wx - CX / 2, wy + CY / 2), bottom = at(wx + CX / 2, wy - CY / 2);
        const id = s ? s.id : `${key}-empty`;
        tables.push({ key, z, j, i, s, id, boss: Boolean(z.boss), x, y, top, bottom });
        // 방 벽: 구역의 왼쪽(xmin)·뒤(ymax) 가장자리 칸에만
        if (c === 0) walls.push({ key, j, side: "xmin", x, y });
        if (r === 0) walls.push({ key, j, side: "ymax", x, y });
        if (c === 0 && r === 0) walls.push({ key, j, side: "corner", x, y });
        for (const [side, cc, rr] of [["xmin", c - 1, r], ["xmax", c + 1, r], ["ymax", c, r - 1], ["ymin", c, r + 1]])
          if (!has(cc, rr)) edges.push({ j, side, x, y });
      });
      // 명패: 왼쪽 벽 윗부분
      // 화면에서 왼쪽 벽 앞쪽 윗부분은 가구 뒤에 겹치지 않는 빈 벽면이다(첫 줄 테이블 중심보다 0.9m 앞).
      // 벽 기준 좌상단: 왼쪽 벽의 앞쪽 끝(화면 왼쪽) 꼭대기. 명패 왼쪽 끝이 벽 모서리 가까이 오게.
      const [px0, py0] = at(zx - CX / 2, zy - (rows - 1) * CY - CY / 2 + 1.05);
      const zh = (M.wall ?? 1.2) - 0.3;   // 벽 꼭대기 바로 아래
      plates.push({ key, z, j, x: px0 + ez[0] * zh, y: py0 + ez[1] * zh });
      // 소품: 구역 이름을 시드로 무작위(다시 그려도 같은 자리). 앞쪽(화면 아래)은 비운다.
      const L = zx - CX / 2 + 0.35, R = zx + (cols - 1) * CX + CX / 2 - 0.35, B = zy + CY / 2 - 0.35, F = zy - (rows - 1) * CY - CY / 2 + 0.35;
      const rnd = seeded(key);
      const spots = [
        { at: [L, B], corner: true }, { at: [R, B], corner: true },
        ...Array.from({ length: cols }, (_, c) => ({ at: [zx + c * CX, B] })),
      ];
      const want = 2 + Math.floor(rnd() * Math.min(4, spots.length - 1));
      for (const sp of shuffle(spots, rnd).slice(0, want)) {
        const pool = sp.corner ? ["plant", "plant", "water", "bin", "cabinet"] : ["whiteboard", "bookcase", "cabinet", "plant"];
        const [x, y] = at(...sp.at);
        props.push({ key, name: pool[Math.floor(rnd() * pool.length)], x, y });
      }
    });
    return { tables, props, edges, walls, plates };
  }

  // 범위: 고른 것(구역 key 집합)만, 없으면 전부.
  bounds(L, keys) {
    const M = SPR, [fx, fy, fw, fh] = M.floor, [ox] = M.origin;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const use = (k) => !keys || keys.has(k);
    for (const tb of L.tables) if (use(tb.key)) {
      x0 = Math.min(x0, tb.x + fx); x1 = Math.max(x1, tb.x + fx + fw);
      y0 = Math.min(y0, tb.y + M.hit[1] - 50); y1 = Math.max(y1, tb.y + fy + fh, tb.bottom[1] + M.origin[1] + 70);
    }
    for (const w of L.walls) if (use(w.key)) { y0 = Math.min(y0, w.y + M.origin[1] + M.ez[1] * ((M.wall ?? 1.2) + 0.1) - 40); x0 = Math.min(x0, w.x + fx); }
    for (const pl of L.plates) if (use(pl.key)) y0 = Math.min(y0, pl.y + M.origin[1] - 40);
    for (const pr of L.props) if (use(pr.key)) {
      const m = M.props[pr.name];
      x0 = Math.min(x0, pr.x + ox - 70); x1 = Math.max(x1, pr.x + ox + 70);
      y0 = Math.min(y0, pr.y + m.top - 10); y1 = Math.max(y1, pr.y + m.bottom + 10);
    }
    return { x0, y0, x1, y1, W: x1 - x0, H: y1 - y0 };
  }

  // 아이소메트릭 장면.
  //  - 구역(레포)을 격자로 놓되, 칸 비율에서 가장 크게 보이는 열 수를 고른다.
  //  - 터미널을 연 동안에는 고른 워크트리의 구역으로 확대한다(다른 구역은 칸 밖으로).
  //  - 가리킨 테이블은 옅은, 고른 테이블은 진한 강조색 테두리. 이름표는 모든 그림 위에.
  scene(zones, ags, terms, open, box, t, cx) {
    const M = SPR;
    if (!zones.length || !box.width) return div();
    const fit = (b) => Math.max(0.12, Math.min(1.0, (box.width - 24) / b.W, (box.height - 52) / b.H));
    // 터미널을 연(칸이 좁아진) 동안에는 고른 워크트리의 사무실(구역)만 그린다.
    if (open) {
      const only = zones.filter(([, z]) => z.spaces.some((x) => x.id === open));
      if (only.length) zones = only;
    }
    let L = null, best = -1;
    for (let zc = 1; zc <= zones.length; zc++) {
      const cand = this.layout(zones, zc), k = fit(this.bounds(cand));
      if (k > best + 1e-6) { best = k; L = cand; }
    }
    const selKey = open ? L.tables.find((tb) => tb.id === open)?.key : null;
    const B = this.bounds(L, selKey ? new Set([selKey]) : null);
    const k = fit(B);
    const left = (box.width - B.W * k) / 2, top = 40 + (box.height - 40 - B.H * k) / 2;
    const [fx, fy, fw, fh] = M.floor, S = M.size * k;
    const P = (x, y) => [(x - B.x0) * k, (y - B.y0) * k];
    const tile = (name, x, y, color) => { const [l, tp] = P(x + fx, y + fy); return svg(`${SPRITES}/${name}.svg`).absolute().left(l).top(tp).w(fw * k).h(fh * k).text_color(color); };
    const els = [];

    // 1) 방: 바닥 판 → 벽 → 벽 위 구역 색 띠. 화면 뒤쪽부터.
    // 방 부품은 테이블보다 큰 캔버스(manifest.room)에 렌더되어 있어 원점 차이만큼 옮긴다.
    const RS = M.room.size * k, rdx = M.origin[0] - M.room.origin[0], rdy = M.origin[1] - M.room.origin[1];
    const room = (name, x, y) => { const [l, tp] = P(x + rdx, y + rdy); return image(`${SPRITES}/${name}.png`).absolute().left(l).top(tp).w(RS).h(RS); };
    for (const tb of [...L.tables].sort((a, b) => a.y - b.y)) els.push(room("room_floor", tb.x, tb.y));
    // 고른·가리킨 테이블: 바닥에 옅은 강조색만(선은 긋지 않는다)
    for (const tb of L.tables) {
      if (tb.id === open) els.push(tile("floor", tb.x, tb.y, `${t.accent}26`));
      else if (tb.id === this.hoverId) els.push(tile("floor", tb.x, tb.y, `${t.accent}14`));
    }
    for (const w of [...L.walls].sort((a, b) => a.y - b.y)) els.push(room(`room_wall_${w.side}`, w.x, w.y));
    // 2) 테이블·자리·소품: 화면 뒤쪽부터
    const seated = [];
    const things = [...L.tables.map((tb) => ({ tb, y: tb.y })), ...L.props.map((pr) => ({ pr, y: pr.y }))].sort((a, b) => a.y - b.y);
    for (const { tb, pr } of things) {
      if (pr) { const [l, tp] = P(pr.x, pr.y); els.push(image(`${SPRITES}/prop_${pr.name}.png`).absolute().left(l).top(tp).w(S).h(S)); continue; }
      const mine = tb.s ? ags.filter((a) => a.space === tb.s.id) : [];
      const [l, tp] = P(tb.x, tb.y);
      const sit = (who, head) => seated.push({ a: who.a, tab: tb.s.tabs.find((x) => x.id === who.a.tab), x: tb.x + head[0], y: tb.y + head[1] });
      if (tb.boss) {
        // 사장님방: 임원용 책상 하나, 자리 하나(나머지는 +n)
        const who = this.assign(mine.slice(0, 1))[FILL[0]];
        els.push(image(`${SPRITES}/boss_table.png`).absolute().left(l).top(tp).w(S).h(S));
        els.push(image(`${SPRITES}/boss_seat_${who ? who.ch : "empty"}.png`).absolute().left(l).top(tp).w(S).h(S));
        if (who) sit(who, M.boss.head);
      } else {
        const seats = this.assign(mine);
        els.push(image(`${SPRITES}/table.png`).absolute().left(l).top(tp).w(S).h(S));
        for (const i of M.order) {
          const who = seats[i];
          els.push(image(`${SPRITES}/seat${i}_${who ? who.ch : "empty"}.png`).absolute().left(l).top(tp).w(S).h(S));
          if (who) sit(who, M.seats[i].head);
        }
      }
      tb.n = mine.length;
    }
    // 명패: 왼쪽 벽 앞쪽 윗부분. 그 자리 앞엔 가구가 없지만 혹시 겹쳐도 읽히게 가구 다음에 그린다. 벽 기울기대로 비튼 SVG(이름이 바뀌어도 되게 실행 중에 만든다).
    for (const pl of L.plates) {
      const plate = this.plate(pl.z.name, EDGE[pl.j % EDGE.length], cx);
      if (!plate) continue;
      const [l, tp] = P(pl.x + M.origin[0], pl.y + M.origin[1]);
      els.push(image(plate.path).absolute().left(l - plate.w / 2).top(tp - plate.h / 2).w(plate.w).h(plate.h));
    }
    // 3) 말풍선
    const z = Math.round(Math.max(18, Math.min(28, 40 * k)));
    for (const w of seated) {
      const [l, tp] = P(w.x, w.y);
      // 상태 표시: 머리 위 가운데. 폭을 넉넉히 잡고 가운데 정렬해 글 길이가 달라도 머리 위에 온다.
      const tab = w.tab;
      els.push(h_flex().absolute().left(l - 90).top(tp - 32).w(180).justify_center()
        .child(this.bubble(w.a, terms, t, tab)));
    }
    // 4) 클릭 영역: 칸 가운데를 중심으로 이웃 칸과 겹치지 않게(그림의 투명한 곳도 사각형으로 눌리므로).
    for (const tb of L.tables) {
      const cx = tb.x + M.origin[0], cy = tb.y + M.origin[1];
      const [l, tp] = P(cx - fw * 0.28, cy - 170), w = fw * 0.56 * k, h = (170 + fh * 0.28) * k;
      els.push(div().id(`table-${tb.id}`).absolute().left(l).top(tp).w(w).h(h).cursor_pointer()
        .on_hover((hov, cx2) => { if (hov) this.hoverId = tb.id; else if (this.hoverId === tb.id) this.hoverId = null; cx2.notify(); })
        .on_click((_e, cx2) => {
          cx2.stop_propagation();
          if (tb.s) openSpace(tb.s.id);
          else { run("space.new", { folder: home() }); run("layout.show", { id: TERM }); }  // 빈 사장님방: 홈 폴더에서 새로
        }));
    }
    // 5) 이름표(맨 위): 구역 이름은 구역 맨 뒤 꼭짓점 위, 브랜치는 칸 맨 앞 꼭짓점 아래. 가운데 정렬.
    const pill = (x, y, w, child) => { const [l, tp] = P(x, y); return h_flex().absolute().left(l - w / 2).top(tp).w(w).justify_center().child(child); };
    for (const tb of L.tables) {
      const sel = tb.id === open, hov = tb.id === this.hoverId;
      els.push(pill(tb.bottom[0] + M.origin[0], tb.bottom[1] + M.origin[1] + 6 / k, 220,
        h_flex().gap(6).items_center().px(8).py(2).rounded(6)
          .bg(sel ? t.accent : `${t.chrome}e6`).border_1().border_color(sel || hov ? t.accent : t.border)
          .child(div().text_size(12).font_semibold().text_color(sel ? t.accent_foreground : t.foreground).whitespace_nowrap()
            .child(tb.s ? (tb.s.branch || tb.s.name) : "비어 있음 · 눌러서 열기"))
          .when(tb.n > 0, (el) => el.child(div().text_size(12).text_color(sel ? t.accent_foreground : t.muted).child(`${tb.n}명`)))));
    }
    return div().id("office-scene").absolute().left(left).top(top).w(B.W * k).h(B.H * k)
      .transition("left", { duration: 380, easing: "ease-out" })
      .transition("top", { duration: 380, easing: "ease-out" })
      .children(els);
  }

  // ── 에이전트가 지금 하는 일(Claude Code 기록) ───────────────
  // 작업 중이거나 서브에이전트가 도는 중이면 5초, 아니면 30초마다 다시 읽는다.
  //   부모가 쉬는(대기·완료) 동안에도 백그라운드 서브에이전트는 돌기 때문에 서브에이전트 상태로도 빨리 읽는다.
  // 기록이 아직 없으면(Claude 터미널이 아니거나 못 찾으면) null.
  activityFor(a, cx) {
    if (!/claude/i.test(`${a.program?.key ?? ""} ${a.app ?? ""}`)) return null;
    const cwd = panes().find((p) => p.pane === a.pane)?.cwd;
    if (!cwd) return null;
    const cache = (this.act ??= {}), c = cache[a.address];
    const live = a.status === "working" || Boolean(c?.agents?.some((g) => g.running));
    const age = live ? 5000 : 30000;
    this.due = Math.min(this.due ?? Infinity, (c?.at ?? 0) + age);
    if (!(this.actBusy ??= new Set()).has(a.address) && (!c || Date.now() - c.at > age)) {
      this.actBusy.add(a.address);
      cx.spawn(async (cx) => {
        try { cache[a.address] = (await readActivity(cwd, a.address, c?.empty ? null : c)) ?? { at: Date.now(), empty: true }; }
        catch { cache[a.address] = { at: Date.now(), empty: true }; }
        this.actBusy.delete(a.address);
        cx.notify();
      });
    }
    return c && !c.empty ? c : null;
  }

  // 서브에이전트 하나의 기록. 펼친 줄만 읽고, 목록(meta.json)에서 본 기록 크기가 바뀌었을 때만 다시 읽는다.
  subFor(a, main, g, cx) {
    const k = `${a.address}#${g.id}`, cache = (this.act ??= {}), c = cache[k];
    const stale = !c || (g.size != null && c.size !== g.size) || (g.running && Date.now() - c.at > 5000);
    if (g.running) this.due = Math.min(this.due ?? Infinity, (c?.at ?? 0) + 5000);
    if (stale && !(this.actBusy ??= new Set()).has(k) && (!c || Date.now() - c.at > 2000)) {
      this.actBusy.add(k);
      cx.spawn(async (cx) => {
        try { cache[k] = (await readSub(main, g.id, a.address, c?.empty ? null : c)) ?? { at: Date.now(), empty: true }; }
        catch { cache[k] = { at: Date.now(), empty: true }; }
        this.actBusy.delete(k);
        cx.notify();
      });
    }
    return c && !c.empty ? c : null;
  }

  // 접힘·펼침: 에이전트(터미널 주소)·구역마다 기억한다(localStorage). 없으면 기본값.
  isOpen(key, def) {
    this.fold ??= (() => { try { return JSON.parse(localStorage.getItem(FOLD) ?? "{}") ?? {}; } catch { return {}; } })();
    return key in this.fold ? this.fold[key] : def;
  }
  toggle(key, def, cx) {
    this.fold[key] = !this.isOpen(key, def);
    try { localStorage.setItem(FOLD, JSON.stringify(this.fold)); } catch { /* 이번 실행 동안만 */ }
    cx.notify();
  }

  // 에이전트 줄 아래의 활동: 이번 턴 · 서브에이전트 · 파일. 서브에이전트도 같은 세 구역을 들여 그린다.
  activityView(a, cx, t) {
    if (!this.isOpen(`${a.address}|agent`, true)) return div();   // 에이전트 줄을 접었으면 활동을 그리지 않는다
    const v = this.activityFor(a, cx);
    if (!v) return div();
    const body = this.sections(a, v, v, null, 0, cx, t);
    if (!body.length) return div();
    return v_flex().ml(46).mb(6).pl(10).py(2).gap(3).border_l_2().border_color(t.border).text_size(12).children(body);
  }

  // 세 구역을 줄 목록으로. main: 부모 에이전트의 기록(서브에이전트 목록은 세션 단위로 거기에 있다).
  // v: 이 단계의 기록(부모면 main, 서브에이전트면 그 기록). sub: 서브에이전트 id(부모면 null). depth: 0 부모, 1·2 서브에이전트.
  sections(a, main, v, sub, depth, cx, t) {
    const KIND = {
      읽음: ["read", "#7aa2f7"], 수정: ["edit", "#e69875"], 작성: ["write", "#a7c080"], 검색: ["search", "#7fbbb3"], 찾기: ["search", "#7fbbb3"],
      실행: ["run", C.working], 서브에이전트: ["agent", "#d699b6"], 웹: ["web", "#83c092"], 스킬: ["skill", "#dbbc7f"],
    };
    const kindOf = (k) => KIND[k] ?? ["other", t.muted];
    const icon = (k) => svg(`mods/office/icons/act_${kindOf(k)[0]}.svg`).size(13).flex_none().text_color(kindOf(k)[1]);
    const FILE = ["읽음", "수정", "작성"];
    // 파일 경로를 위치 칩 + 짧은 경로로
    const place = (p) => {
      const h = home();
      if (main.cwd && p.startsWith(main.cwd + "/")) return ["프로젝트", p.slice(main.cwd.length + 1)];
      const tmp = /^\/(private\/)?tmp\/claude-[^/]+\/[^/]+\/[^/]+\/(scratchpad\/)?(.*)$/.exec(p);
      if (tmp) return ["클로드 임시", tmp[3]];
      if (p.startsWith(`${h}/.claude/`)) return ["클로드", p.slice(h.length + 9)];
      if (p.startsWith(`${h}/.config/herdr-app/`)) return ["Herdr", p.slice(h.length + 20)];
      if (p.startsWith(h + "/")) return ["홈", `~/${p.slice(h.length + 1)}`];
      return [null, p];
    };
    // 위치 칩 색: 프로젝트는 초록, 클로드 쪽은 Claude 주황, Herdr는 파랑, 홈은 회색
    const PLACE = { 프로젝트: "#a7c080", "클로드 임시": "#d97757", 클로드: "#d97757", Herdr: "#7aa2f7", 홈: "#9da9a0" };
    const chip = (text) => { const c = PLACE[text] ?? t.muted; return div().flex_none().px(5).rounded(4).bg(`${c}26`).border_1().border_color(`${c}66`).text_size(11).text_color(c).child(text); };
    const short = (k, target) => (FILE.includes(k) && target ? place(target)[1].split("/").pop() : target);
    const id = `${a.address}-${sub ?? "top"}`;
    // 머리줄: 작은 chevron + 이름. 누르면 접고 펼친다.
    const head = (key, text, open, def) => h_flex().id(`ov-h-${id}-${key}`).pt(4).gap(4).items_center().cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(`${a.address}|${sub ?? ""}|${key}`, def, cx); })
      .child(svg(`mods/office/icons/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.muted))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(text));
    // 구역 하나: 펼치면 전부(길면 최근 cap개와 "이전 n개"), 접으면 마지막 한 줄.
    //   keep: 잘라 낼 때도 남길 항목(아직 도는 서브에이전트는 "이전 n개" 아래로 숨기지 않는다).
    const section = (key, text, items, def, row, cap, keep = () => false) => {
      if (!items.length) return [];
      const open = this.isOpen(`${a.address}|${sub ?? ""}|${key}`, def);
      const idx = items.map((_, i) => i);
      const pick = open ? idx.filter((i) => i >= items.length - cap || keep(items[i])) : [items.length - 1];
      const hidden = items.length - pick.length;
      return [head(key, text, open, def),
        ...(open && hidden > 0 ? [div().pl(14).text_size(11).text_color(t.dim).child(`이전 ${hidden}개`)] : []),
        ...pick.map((i) => row(items[i], i))];
    };
    const out = [];
    // 이번 턴의 흐름: 한 줄에 한 묶음, 종류 아이콘. 지금 하는 묶음은 굵게. 파일 대상도 누르면 뷰어 창.
    const flow = v.tail?.flow ?? [];
    out.push(...section("turn", `이번 턴 · 도구 ${v.tail?.tools ?? 0}번`, flow, false, (f, i) =>
      h_flex().id(`ov-flow-${id}-${i}`).gap(6).items_center().min_h(18)
        .when(FILE.includes(f.kind) && String(f.target ?? "").startsWith("/"),
          (x) => x.cursor_pointer().hover((s) => s.underline()).on_click(() => openViewer(f.target, a.address)))
        .child(f.running && f.kind === "실행" ? svg(SPINNER).size(13).flex_none().text_color(C.working).spin(900) : icon(f.kind))
        .child(div().flex_none().text_color(f.running ? t.foreground : kindOf(f.kind)[1]).when(f.running, (x) => x.font_semibold())
          .child(`${f.kind}${f.n > 1 ? ` ×${f.n}` : ""}`))
        .when(Boolean(f.target), (x) => x.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(short(f.kind, f.target)))), 24));
    // 서브에이전트: 지금 도는 것과 중단된 것만(완료되면 목록에서 사라진다). 띄운 순서라 마지막이 최근.
    //   줄을 누르면 그 서브에이전트의 세 구역을 펼친다(도는 것은 펼침, 끝난 것은 접힘이 기본). 3단부터는 한 줄만.
    // 서브에이전트가 띄운 서브에이전트의 완료 알림은 그 서브에이전트 기록에 온다: 이 단계 기록(v.ended)으로도 끝난 것을 안다
    const kids = (main.agents ?? []).filter((g) => (g.parent ?? null) === sub)
      .map((g) => (g.running && v.ended?.[g.id] ? { ...g, running: false, failed: v.ended[g.id] !== "completed" } : g))
      .filter((g) => g.running || g.failed);   // 완료된 서브에이전트는 목록에서 닫고, 중단된 것은 남긴다
    out.push(...section("agents", `서브에이전트 ${kids.length}`, kids, true, (g) => {
      const canOpen = depth < 2;
      const rowKey = `${a.address}|${g.id}|row`;
      const open = canOpen && this.isOpen(rowKey, g.running);
      const line = h_flex().id(`ov-sub-${id}-${g.id}`).gap(6).items_center().min_h(18)
        .when(canOpen, (x) => x.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.toggle(rowKey, g.running, cx); }))
        .child(canOpen ? svg(`mods/office/icons/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.muted) : div().w(10).flex_none())
        .child(g.running ? svg(SPINNER).size(13).flex_none().text_color(C.working).spin(900) : icon("서브에이전트"))
        .child(div().flex_none().px(5).rounded(4).bg("#d699b622").text_size(11).text_color("#d699b6").child(g.type))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(g.what))
        .child(div().flex_none().text_size(11).text_color(g.running ? C.working : g.failed ? C.blocked : t.muted)
          .child(g.running ? "작업 중" : g.failed ? "중단" : [
            "완료",
            Number.isFinite(g.tools) ? `도구 ${g.tools}번` : null,
            Number.isFinite(g.ms) ? (g.ms < 60000 ? `${Math.round(g.ms / 1000)}초` : `${Math.round(g.ms / 60000)}분`) : null,
          ].filter(Boolean).join(" · ")));
      if (!open) return line;
      const sv = this.subFor(a, main, g, cx);
      const inner = sv ? this.sections(a, main, sv, g.id, depth + 1, cx, t) : [];
      return v_flex().gap(3).child(line)
        .when(inner.length > 0, (x) => x.child(v_flex().ml(5).pl(10).gap(3).border_l_1().border_color(t.border).children(inner)));
    }, 10, (g) => g.running));
    // 파일: 이번 세션에 읽거나 고친 파일(지워진 것은 빠진다). 최근 것이 마지막. 절대 경로면 누르면 뷰어 창.
    const files = [...(v.files ?? new Map())].map(([path, kind]) => ({ path, kind }));
    out.push(...section("files", `파일 ${files.length}`, files, false, (f, i) => {
      const [where, path] = place(f.path);
      return h_flex().id(`ov-file-${id}-${i}`).gap(6).items_center().min_h(18)
        .cursor_pointer().hover((s) => s.underline()).on_click(() => openViewer(f.path, a.address))
        .child(icon(f.kind))
        .when(Boolean(where), (x) => x.child(chip(where)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(path));
    }, 30));
    return out;
  }

  // 벽에 붙일 명패 SVG를 만든다. 글자 크기는 화면 픽셀로 고정(읽히게), 모양만 왼쪽 벽(월드 y축) 기울기로 비튼다.
  // 모드 폴더에 쓰면 모드가 다시 불러와지므로 data/ 아래에 쓴다.
  plate(name, color, cx) {
    const key = hash(`${name}|${color}|v2`).toString(36), path = `data/office-plates/${key}.svg`;
    const slope = SPR.ey[1] / SPR.ey[0];   // 왼쪽 벽은 화면에서 오른쪽 위로 올라간다(음수)
    const w = Math.round([...name].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 13 : 7.8), 0) + 34), h = 24;
    const out = { path, w, h: Math.ceil(h + w * Math.abs(slope)) };
    if ((this.plates ??= {})[key] === true) return out;
    if (this.plates[key] === "busy") return null;
    this.plates[key] = "busy";
    const esc = name.replace(/[<&>"]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;", '"': "&quot;" })[c]);
    const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${out.h}" viewBox="0 0 ${w} ${out.h}">`
      + `<g transform="matrix(1,${slope.toFixed(4)},0,1,0,${slope < 0 ? (-slope * w).toFixed(1) : 0})">`
      + `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="#2b2e33" stroke="#c9a86a"/>`
      + `<rect x="7" y="6" width="3" height="${h - 12}" rx="1" fill="${color.slice(0, 7)}"/>`
      + `<text x="${(w + 10) / 2}" y="${h / 2 + 4.5}" text-anchor="middle" font-family="D2Coding, Apple SD Gothic Neo, sans-serif" font-size="13" font-weight="600" fill="#f1e6d0">${esc}</text>`
      + `</g></svg>`;
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(`${appHome()}/data/office-plates`, { recursive: true });
        await fs.writeFile(`${appHome()}/${path}`, svgText);
        this.plates[key] = true;
      } catch { this.plates[key] = false; }
      cx.notify();
    });
    return null;
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
  // 머리 위 상태 표시. 상태가 먼저 읽히도록 색 알약에 상태 낱말을 쓰고, 로고는 작게.
  //   입력 대기: 빨강 "답 필요", 깜빡이며 살짝 튄다(가장 먼저 봐야 하므로)
  //   작업 중: 노랑 "작업 중 4분"   완료: 초록 "완료"   대기: 회색 "대기"
  //   서브에이전트가 일하는 중이면 "+n"
  bubble(a, terms, t, tab) {
    const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`; };

    const m = a.status === "working" && tab?.working_since ? Math.max(0, Math.round((Date.now() - tab.working_since) / 60000)) : null;
    const [bg, fg, text] = {
      blocked: [C.blocked, "#ffffff", "답 필요"],
      working: [C.working, "#2a2100", m == null ? "작업 중" : m < 1 ? "작업 중" : `작업 중 ${m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간`}`],
      done: [C.done, "#ffffff", a.doneAt ? `완료 ${ago(a.doneAt)}` : "완료"],
      idle: ["#5f6670", "#ffffff", "대기"],
    }[a.status] ?? ["#5f6670", "#ffffff", ""];
    const kids = terms.filter((x) => x.parent === a.address && x.status === "working").length;
    const icon = a.status === "working" ? svg(SPINNER).size(12).text_color(fg).spin(900)
      : a.status === "done" ? div().text_size(12).font_semibold().text_color(fg).child("✓")
      : div().size(7).rounded_full().bg(fg);
    return h_flex().gap(5).items_center().h(24).pl(5).pr(9).rounded(12).bg(bg).border_1().border_color("#00000033").shadow_md()
      .when(a.status === "blocked", (el) => el.loop("opacity", { from: 0.65, to: 1, period: 900 }).loop("top", { from: 0, to: -3, period: 900 }))
      .child(div().size(18).flex_none().rounded_full().bg("#ffffff").flex().items_center().justify_center().child(programIcon(a.program, 12, t, true)))
      .child(icon)
      .child(div().text_size(12).font_semibold().text_color(fg).whitespace_nowrap().child(text))
      .when(kids > 0, (el) => el.child(div().px(5).rounded(8).bg("#00000026").text_size(11).font_semibold().text_color(fg).child(`+${kids}`)));
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
      .child(div().id("office-close").px(6).rounded(4).text_color(t.muted).cursor_pointer()
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeTerm())
        .child("✕"));
  }
}

// ── 에이전트 추가·닫기(왼쪽 패널이 탭 목록 역할도 한다) ─────────
// 팝업 위치: 마우스 오른쪽 아래가 기본, 창에 공간이 모자라면 위·왼쪽으로 뒤집는다(office-apps/menu.js popupAt과 같다).
function popupAt(w, h) {
  try {
    const W = globalThis.window, p = W.mouse_position(), v = W.viewport_size(), M = 6;
    let x = p.x, y = p.y;
    if (x + w > v.width - M) x = Math.max(M, p.x - w);
    if (y + h > v.height - M) y = Math.max(M, Math.min(p.y - h, v.height - h - M));
    return { x: Math.round(x), y: Math.round(y) };
  } catch { return "pointer"; }
}

// "+" → 에이전트 고르기 팝업. s: 사무실에서 연 스페이스, folder: 그 스페이스가 지금 있는 폴더.
function openAddMenu(s, folder) {
  const w = 240, h = 220;
  openOverlay({ mod: "office", kind: "popup", width: w, height: h, at: popupAt(w, h),
    props: { role: "add-agent", space: s.id, machine: s.machine ?? null, folder: folder ?? s.folder ?? null } });
}

// ✕ → 확인 창. 작업 중이면 경고 문구.
function openCloseConfirm(a, name) {
  openOverlay({ mod: "office", kind: "dialog", width: 400, height: 170,
    props: { role: "close-agent", pane: a.pane, name, title: a.title ?? "", working: a.status === "working" } });
}

// 좌측 패널에서 여는 에이전트는 권한 확인 없이(bypass/yolo) 띄운다. 구독 종류별 플래그, 이미 있으면 덧붙이지 않는다.
const YOLO = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  grok: "--always-approve",
  antigravity: "--dangerously-skip-permissions",
};
function yolo(a) {
  const argv = [...(a.run ?? [])], flag = YOLO[providerOf(a)];
  return flag && argv.length && !argv.includes(flag) ? [...argv, flag] : argv;
}

// knownAgents 항목 → 구독 종류. office-usage 모드가 사용량을 읽는 네 곳과 같다.
const PROVIDER = [[/claude/i, "claude"], [/codex|openai/i, "codex"], [/grok/i, "grok"], [/antigravity|\bagy\b/i, "antigravity"]];
const providerOf = (a) => PROVIDER.find(([re]) => re.test(`${a.key} ${a.name} ${a.run?.[0] ?? ""}`))?.[1] ?? null;

// 구독 감지: 로그인 정보가 "있는지"만 본다(값은 읽지 않는다). 1분 캐시(localStorage, 머신별).
//   Claude  키체인 "Claude Code-credentials" 항목(security, -w 없이 종료 코드만). 키체인이 없는 머신은 ~/.claude/.credentials.json
//   Codex   ~/.codex/auth.json      Grok  ~/.grok/auth.json      Antigravity  설치돼 있으면 구독 있음으로 본다
async function subscriptions(machine) {
  const k = machine ?? "";
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(SUBS) ?? "{}") ?? {}; } catch { /* 새로 */ }
  if (cache[k] && Date.now() - cache[k].at < 60000) return new Set(cache[k].list);
  const script = [
    'if command -v security >/dev/null 2>&1 && security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then echo claude',
    'elif [ -f "$HOME/.claude/.credentials.json" ]; then echo claude; fi',
    '[ -f "$HOME/.codex/auth.json" ] && echo codex',
    '[ -f "$HOME/.grok/auth.json" ] && echo grok',
    'exit 0',
  ].join("\n");
  const r = await exec("sh", ["-c", script], { on: machine });
  const list = [...r.stdout.split("\n").filter(Boolean), "antigravity"];
  cache[k] = { at: Date.now(), list };
  try { localStorage.setItem(SUBS, JSON.stringify(cache)); } catch { /* 다음에 다시 */ }
  return new Set(list);
}

// 에이전트 고르기 팝업(role "add-agent"). 구독이 확인된 것을 위에, 설치는 됐지만 확인 못 한 것은 흐리게 아래에.
// 띄우기: Herdr 기본 new-menu 모드와 같은 명령 tab.new {name, space, argv: 항목의 run}. 폴더는 그 스페이스가 있는 곳.
class AddAgent {
  init(_p, cx) {
    this.list = null; this.failed = false;
    this.h = cx.focus_handle();
    this.h.focus();
    const p = props();
    cx.spawn(async (cx) => {
      try {
        const [all, subs] = await Promise.all([knownAgents({ on: p.machine }), subscriptions(p.machine).catch(() => new Set(["antigravity"]))]);
        this.list = all.filter((a) => a.installed).map((a) => ({ ...a, ok: subs.has(providerOf(a)) }));
      } catch { this.failed = true; }
      cx.notify();
    });
  }

  start(a) {
    const p = props();
    closeOverlay(p.overlay);
    run("tab.new", { name: a.name, space: p.space, ...(p.folder ? { folder: p.folder } : {}), argv: yolo(a) });
    // 새 탭은 그 스페이스에서 선택된다: 사무실 터미널 칸을 그 스페이스로 열어 둔다
    run("space.select", { id: p.space });
    run("layout.show", { id: TERM });
    setShared(OPEN, p.space);
  }

  render() {
    const t = theme(), p = props();
    const row = (a, i) => h_flex().id(`aa-${a.key}-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .text_color(a.ok ? t.foreground : t.dim).hover((st) => st.bg(t.hover))
      .on_click(() => this.start(a))
      .child(div().w(16).flex_none().flex().justify_center().child(programIcon(a, 14, t)))
      .child(div().flex_1().min_w(0).truncate().child(a.name));
    const ok = (this.list ?? []).filter((a) => a.ok), rest = (this.list ?? []).filter((a) => !a.ok);
    const note = (text) => div().px(8).py(6).text_color(t.dim).child(text);
    return v_flex().id("office-add-agent").track_focus(this.h).size_full().p(5).gap(1).bg(t.popover).text_size(12.5).overflow_y_scrollbar()
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(div().px(8).pt(4).pb(4).text_size(11).text_color(t.dim).child("에이전트 띄우기"))
      .when(this.list == null && !this.failed, (el) => el.child(note("확인하는 중")))
      .when(this.failed, (el) => el.child(note("설치된 에이전트를 확인하지 못했습니다")))
      .when(this.list != null && !this.list.length, (el) => el.child(note("설치된 에이전트가 없습니다")))
      .children(ok.map(row))
      .when(rest.length > 0, (el) => el.child(div().px(8).pt(8).pb(2).text_size(11).text_color(t.dim).child("구독 확인 안 됨")).children(rest.map(row)));
  }
}

// 닫기 확인 창(role "close-agent"). 확인하면 그 터미널의 칸을 닫는다(pane.close: 칸을 닫고 터미널을 끝낸다).
class CloseAgent {
  init(_p, cx) {
    this.h = cx.focus_handle();
    this.h.focus();
  }

  yes() {
    const p = props();
    closeOverlay(p.overlay);
    if (p.pane) run("pane.close", { pane: p.pane });
  }

  render() {
    const t = theme(), p = props();
    const button = (id, text, primary, action) => h_flex().id(id).h(30).px(14).items_center().rounded(7).cursor_pointer().text_size(12.5)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).hover((st) => st.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("office-close-agent").track_focus(this.h).size_full().p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.yes();
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(p.working ? "작업 중인 에이전트를 닫을까요?" : "에이전트를 닫을까요?"))
      .child(div().flex_1().text_color(t.muted).child(`${p.name}${p.title ? ` · ${p.title}` : ""}의 터미널을 닫습니다.${p.working ? " 하던 일은 멈춥니다." : ""}`))
      .child(h_flex().gap(8).justify_end()
        .child(button("oc-no", "취소", false, () => closeOverlay(p.overlay)))
        .child(button("oc-yes", "닫기", true, () => this.yes())));
  }
}

const ROLES = { floor: Floor, termbar: Termbar, "add-agent": AddAgent, "close-agent": CloseAgent };

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
