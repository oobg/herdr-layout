// office-apps의 서버 앱: Herdr에 등록한 머신(이 컴퓨터 + `hc machine ls`)을 본다.
//   왼쪽: 툴바(머신 추가·다시 읽기) + 머신 목록(연결 상태 점·글자, 스페이스 수)
//   오른쪽: 고른 머신의 정보(주소·연결 방식·호스트·hc 버전), 그 머신의 스페이스·에이전트, 동작(새 스페이스·새 터미널·제거)
//   리소스(CPU·메모리·저장 용량·배터리·네트워크): 오른쪽 칸이 넓으면 오른쪽 열(260px), 좁으면 정보 줄 아래. server/resources.js가 읽는다.
// 머신 추가는 Herdr 기본 machine-add 창(`mod.open machine-add`)을 연다. 제거는 확인 창(menu.js Confirm)을 거쳐 `hc machine rm`.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { hc, exec, spaces, panes, machines, agents, home, run, notify, shared, setShared, openOverlay, closeOverlay } from "herdr";
import { ACTIONS } from "./menu.js";
import { sample, gb, pct, rate } from "./server/resources.js";

const ME = "mods/office-apps";
const LOCAL = "";                          // 이 컴퓨터의 키(머신 이름은 비어 있지 않다)
const TICK = "office-apps.server.tick";    // 제거 뒤 목록을 다시 읽으라는 신호
const TOOL = { add: "#83c092", refresh: "#7fbbb3" };
const DANGER = "#e67e80";
const RES_EVERY = 2000, RES_SLOW = 30000;   // 리소스 갱신: 2초, 무거운 명령(diskutil·ioreg 등)은 30초
const WIDE = 720;                           // 오른쪽 칸이 이보다 넓으면 리소스를 오른쪽 열로
const RES_W = 260;

// hc 상태 → 글자·색 이름(theme). 이 컴퓨터는 늘 "여기".
const STATE = {
  connected: ["연결됨", "ansi2"],
  connecting: ["연결 중", "ansi3"],
  needs_login: ["로그인 필요", "blocked"],
  unreachable: ["연결 안 됨", "dim"],
};
const LAYOUT = { ready: "준비됨", loading: "불러오는 중", unavailable: "쓸 수 없음" };
const AGENT = { working: ["작업 중", "working"], blocked: ["응답 필요", "blocked"], done: ["끝남", "done"], idle: ["쉬는 중", "idle"] };

// 확인 창(Confirm)은 menu.js의 ACTIONS[action](ctx)를 부른다. 확인 창은 따로 뜨는 복사본이라 함수를 넘길 수 없어,
// 이 모듈이 불릴 때 서버 앱 전용 동작을 하나 등록해 둔다(menu.js 파일은 고치지 않는다).
ACTIONS.serverRemove = async (ctx) => {
  const r = await hc(["machine", "rm", ctx.name, "--json"]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  if (r.code === 0) notify({ title: "머신을 지웠습니다", body: ctx.name, level: "info" });
  else notify({ title: "머신을 지우지 못했습니다", body: errorText(r), level: "error" });
  setShared(TICK, Date.now());
};

function errorText(r) {
  try { const m = JSON.parse(r.stdout || r.stderr).error?.message; if (m) return m; } catch { /* 글자 그대로 */ }
  return (r.stderr || r.stdout || "응답이 없습니다").trim().slice(0, 200);
}

// 스페이스가 지금 있는 곳: 첫 탭부터 찾은 첫 터미널 패인의 지금 폴더(AGENTS.md 규칙). 없으면 만든 폴더.
function whereOf(s, all) {
  for (const tab of [...s.tabs].sort((a, b) => a.index - b.index)) {
    const p = all.find((x) => x.tab === tab.id && x.terminal && x.cwd);
    if (p) return p.cwd;
  }
  return s.folder || "";
}
const short = (path) => { const h = home(); return path === h ? "~" : path.startsWith(h + "/") ? "~" + path.slice(h.length) : path; };

// "3분 전부터" 같은 짧은 경과 시간
function since(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "방금부터";
  if (s < 3600) return `${Math.floor(s / 60)}분 전부터`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전부터`;
  return `${Math.floor(s / 86400)}일 전부터`;
}

export class ServerApp {
  init(_p, cx) {
    this.list_ = [];          // hc machine ls (temporary 제외)
    this.loaded = false; this.loading = false; this.error = null;
    this.local = {};          // 이 컴퓨터: host, version
    this.tick = shared(TICK);
    this.copied = null;
    try { this.sel = JSON.parse(localStorage.getItem("server.sel") ?? "null") ?? LOCAL; } catch { this.sel = LOCAL; }
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // 리소스: 타이머는 숨겨져도 돌므로, 최근에 상세를 그린 적이 있을 때(보이는 중)만 읽는다.
    this.res = {}; this.seen = 0; this.resBusy = false;
    cx.timer.every(RES_EVERY, (cx) => this.readRes(cx));
    cx.spawn(async (cx) => {
      const [h, v] = await Promise.all([
        exec("hostname", []).catch(() => null),
        hc(["--version"]).catch(() => null),
      ]);
      this.local = { host: (h?.stdout ?? "").trim(), version: (v?.stdout ?? "").trim().replace(/^hc\s+/, "") };
      cx.notify();
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code !== 0) throw new Error(errorText(r));
        this.list_ = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
        this.error = null;
      } catch (e) { this.error = `머신 목록을 읽지 못했습니다: ${String(e?.message ?? e).slice(0, 120)}`; }
      finally { this.loading = false; this.loaded = true; cx.notify(); }
    });
  }

  pick(key, cx) {
    this.sel = key;
    if (cx) { this.seen = Date.now(); this.readRes(cx); }
    try { localStorage.setItem("server.sel", JSON.stringify(key)); } catch { /* 이번 실행 동안만 */ }
  }

  // 목록: 이 컴퓨터 + hc가 아는 머신 + 레이아웃·스페이스에만 보이는 머신(이름순)
  entries() {
    const layouts = machines(), sp = spaces();
    const names = new Set([...this.list_.map((m) => m.name), ...layouts.map((m) => m.name), ...sp.map((s) => s.machine)].filter(Boolean));
    const one = (name) => ({
      key: name ?? LOCAL, name,
      hc: name ? this.list_.find((m) => m.name === name) ?? null : null,
      layout: layouts.find((m) => m.name === name)?.layout ?? null,
      spaces: sp.filter((s) => (s.machine ?? null) === name),
    });
    return [one(null), ...[...names].sort((a, b) => a.localeCompare(b)).map(one)];
  }

  // 상태 글자와 색. hc 상태가 우선, 없으면 레이아웃 상태로 짐작.
  status(e, t) {
    if (!e.name) return ["여기", t.ansi2];
    const s = e.hc?.state;
    if (s && STATE[s]) return [STATE[s][0], t[STATE[s][1]]];
    if (e.layout === "ready") return ["연결됨", t.ansi2];
    if (e.layout === "loading") return ["연결 중", t.ansi3];
    return [e.hc ? s ?? "알 수 없음" : "등록 안 됨", t.dim];
  }

  sync(cx) {
    if (shared(TICK) !== this.tick) { this.tick = shared(TICK); this.refresh(cx); }
  }

  toolbar(t) {
    const btn = (id, icon, tip, fn) => div().id(`sv-${id}`).p(4).rounded(4).flex_none().cursor_pointer()
      .on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); })
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.hideTip(); fn(cx); cx.notify(); })
      .child(svg(icon).size(16).text_color(TOOL[id]));
    return h_flex().min_h(32).flex_none().py(2).px(6).gap(2).items_center().border_b_1().border_color(t.border)
      .child(btn("add", `${ME}/server/machine-add.svg`, "머신 추가 (ssh)", () => run("mod.open", { name: "machine-add" })))
      .child(div().flex_1())
      .child(btn("refresh", `${ME}/refresh.svg`, "다시 읽기", (cx) => this.refresh(cx)));
  }

  row(e, t) {
    const [label, color] = this.status(e, t);
    const n = e.spaces.length;
    return v_flex().id(`sv-row-${e.key || "local"}`).flex_none().px(8).py(5).gap(1).rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(this.sel === e.key, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.pick(e.key, cx); cx.notify(); })
      .child(h_flex().gap(7).items_center()
        .child(div().size(7).flex_none().rounded_full().bg(color))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(e.name ?? "이 컴퓨터")))
      .child(div().pl(14).truncate().text_size(11).text_color(t.dim)
        .child(`${label} · 스페이스 ${n}`));
  }

  list(cx, t) {
    this.sync(cx);
    const all = this.entries();
    return v_flex().flex_1().min_h(0)
      .child(this.toolbar(t))
      .child(v_flex().id("sv-list").flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1)
        .children(all.map((e) => this.row(e, t)))
        .when(Boolean(this.error), (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error)))
        .when(!this.error && this.loaded && all.length === 1, (el) => el.child(div().p(8).text_size(12).text_color(t.dim)
          .child("등록한 머신이 없습니다. 위의 + 로 ssh 머신을 추가합니다"))));
  }

  subtitle(t) {
    const n = this.entries().length - 1;
    return div().truncate().text_size(12).text_color(t.dim).child(n ? `머신 ${n}대` : "");
  }

  detail(cx, t) {
    if (this.sel === null || this.sel === undefined) return null;
    const e = this.entries().find((x) => x.key === this.sel);
    if (!e) return null;
    this.seen = Date.now();
    const wide = (this.dw ?? 0) >= WIDE;
    const m = e.hc, [label, color] = this.status(e, t);
    const ready = e.layout === "ready" || (!e.name && e.layout !== "unavailable");
    const first = e.spaces.find((s) => s.active) ?? e.spaces[0];
    const btn = (id, text, fn, danger = false) => div().id(id).px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12).flex_none()
      .when(Boolean(fn), (el) => el.text_color(danger ? DANGER : t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn))
      .when(!fn, (el) => el.text_color(t.dim))
      .child(text);

    // 정보: 이름표(흐리게) + 값
    const info = [];
    const line = (k, v) => v && info.push(h_flex().gap(12).items_start()
      .child(div().w(76).flex_none().text_color(t.muted).child(k))
      .child(div().flex_1().min_w(0).text_color(t.foreground).child(v)));
    if (e.name) {
      line("주소", m?.target);
      line("연결 방식", m ? (m.via ? "명령 (via)" : "ssh") : null);
      line("호스트", m?.host);
      line("hc 버전", m?.version);
      line("세션", m?.session);
      line("화면 배치", e.layout ? LAYOUT[e.layout] : null);
    } else {
      line("호스트", this.local.host);
      line("hc 버전", this.local.version);
      line("화면 배치", e.layout ? LAYOUT[e.layout] : null);
    }
    const login = m?.state === "needs_login" ? `hc machine login ${e.name}` : null;

    const section = (title) => div().pt(10).pb(2).text_size(12).font_semibold().text_color(t.muted).child(title);
    const allPanes = panes();
    const spaceRows = e.spaces.map((s) => h_flex().id(`sv-sp-${s.id}`).h(26).flex_none().px(6).gap(8).items_center().rounded(4)
      .cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => run("space.select", { id: s.id }))
      .child(div().flex_none().text_color(t.foreground).when(s.active, (x) => x.font_semibold()).child(s.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child([s.branch, short(whereOf(s, allPanes))].filter(Boolean).join(" · ")))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(`탭 ${s.tabs.length}`)));
    const ids = new Set(e.spaces.map((s) => s.id));
    const agentRows = agents().filter((a) => ids.has(a.space)).map((a) => {
      const [word, tone] = AGENT[a.status] ?? [a.status, "dim"];
      return h_flex().id(`sv-ag-${a.address}`).h(26).flex_none().px(6).gap(8).items_center().rounded(4)
        .cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => run("agent.focus", { terminal: a.address }))
        .child(div().flex_none().text_color(t.foreground).child(a.program?.name ?? a.app ?? "에이전트"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${a.space_name} · ${a.tab_name}`))
        .child(div().flex_none().text_size(12).text_color(t[tone] ?? t.dim).child(word));
    });

    return v_flex().id("sv-root").size_full().min_h(0)
      .on_size_change((size, cx) => { if (Math.abs((this.dw ?? 0) - size.width) > 4) { this.dw = size.width; cx.notify(); } })
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(e.name ?? "이 컴퓨터"))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().size(7).flex_none().rounded_full().bg(color))
          .child(div().truncate().text_size(12).text_color(t.dim)
            .child(e.name && m?.state !== "connected" && m?.since_ms ? `${label} · ${since(m.since_ms)}` : label)))
        // 구조 명령은 그 머신의 화면 배치가 준비됐을 때만 된다. 이 컴퓨터는 machine: ""로 꼭 지정한다.
        .child(btn("sv-new-space", "새 스페이스", ready && (() => { run("space.new", { machine: e.name ?? "" }); run("layout.show", { id: "office-term" }); })))
        // tab.new가 화면을 그 스페이스로 옮긴다는 보장이 없어 먼저 고른다.
        .child(btn("sv-new-term", "새 터미널", ready && first && (() => { run("space.select", { id: first.id }); run("tab.new", { space: first.id }); run("layout.show", { id: "office-term" }); })))
        .when(Boolean(e.name), (el) => el.child(btn("sv-remove", "제거…", m && (() => this.confirmRemove(e)), true))))
      .child(h_flex().flex_1().min_h(0).items_stretch()
      .child(v_flex().id("sv-detail").flex_1().min_w(0).min_h(0).overflow_y_scrollbar().px(18).py(12).gap(6)
        .children(info)
        .when(Boolean(m?.why), (el) => el.child(h_flex().gap(12).items_start()
          .child(div().w(76).flex_none().text_color(t.muted).child("이유"))
          .child(div().flex_1().min_w(0).text_color(t.foreground).child(m.why))))
        .when(Boolean(login), (el) => el.child(h_flex().gap(12).items_center()
          .child(div().w(76).flex_none().text_color(t.muted).child("로그인"))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(login))
          .child(div().id("sv-login-copy").flex_none().px(6).py(2).rounded(4).text_size(12).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.write_to_clipboard(login); this.copied = login; cx.notify(); })
            .child(this.copied === login ? "복사함" : "복사"))))
        .when(Boolean(e.name) && !m, (el) => el.child(div().text_size(12).text_color(t.dim).child("hc 목록에 없는 머신입니다. 이 머신의 스페이스만 남아 있습니다")))
        .when(!ready && Boolean(e.name), (el) => el.child(div().text_size(12).text_color(t.dim).child("연결되면 스페이스를 열 수 있습니다")))
        // 좁으면 리소스를 정보 줄 아래에
        .when(!wide, (el) => el.child(v_flex().pt(4).children(this.resources(e, t, Math.min(320, (this.dw ?? 400) - 80)))))
        .child(section(`스페이스 ${e.spaces.length}`))
        .children(spaceRows.length ? spaceRows : [div().px(6).text_size(12).text_color(t.dim).child("스페이스가 없습니다")])
        .child(section(`에이전트 ${agentRows.length}`))
        .children(agentRows.length ? agentRows : [div().px(6).text_size(12).text_color(t.dim).child("돌고 있는 에이전트가 없습니다")]))
      // 넓으면 리소스를 오른쪽 열에
      .when(wide, (el) => el.child(v_flex().id("sv-res").w(RES_W).flex_none().min_h(0).overflow_y_scrollbar().px(16).py(4).border_l_1().border_color(t.border)
        .children(this.resources(e, t, RES_W - 32 - 32)))));
  }

  // 고른 머신의 리소스 표본 하나. 보이지 않으면(상세를 4.5초 넘게 안 그렸으면) 건너뛴다.
  readRes(cx) {
    if (this.resBusy || Date.now() - this.seen > 4500 || this.sel === null || this.sel === undefined) return;
    const key = this.sel, e = this.entries().find((x) => x.key === key);
    if (!e) return;
    const prev = this.res[key];
    // 원격 머신은 연결돼 있을 때만
    if (e.name && e.hc?.state !== "connected" && e.layout !== "ready") { this.res[key] = { ...prev, error: "offline" }; return; }
    this.resBusy = true;
    const slow = !prev?.slowAt || Date.now() - prev.slowAt > RES_SLOW;
    cx.spawn(async (cx) => {
      try { this.res[key] = await sample(exec, e.name ?? null, prev?.error ? { ...prev, error: null } : prev, slow); }
      catch (err) { this.res[key] = { ...prev, error: String(err?.message ?? err).slice(0, 120) }; }
      finally { this.resBusy = false; cx.notify(); }
    });
  }

  // 리소스 구역들: 왼쪽 선 아이콘 + 굵은 값 한 줄 + 작은 이름표:값 줄, 구역 사이 얇은 선
  resources(e, t, W) {
    const r = this.res[e.key];
    const note = (text) => div().py(8).text_size(12).text_color(t.dim).child(text);
    if (r?.error) return [note("이 머신의 리소스는 읽을 수 없습니다")];
    if (!r?.cpu && !r?.mem) return [note("리소스를 읽는 중")];
    const mac = r.os === "darwin";
    const kv = (k, v) => v ? h_flex().gap(4).text_size(12).child(div().flex_none().text_color(t.muted).child(`${k}:`)).child(div().min_w(0).truncate().text_color(t.foreground).child(v)) : null;
    const block = (icon, title, rows, extra) => h_flex().py(12).gap(12).items_start()
      .child(svg(`${ME}/server/${icon}.svg`).size(20).flex_none().text_color(t.muted))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
        .children(rows.filter(Boolean))
        .when(Boolean(extra), (el) => el.child(extra)));
    const out = [];
    if (r.cpu) {
      const H = 22, bars = r.history ?? [];
      out.push(block("cpu", `CPU: ${pct(r.cpu.used, mac ? 0 : 1)}`, [
        kv("시스템", pct(r.cpu.system, mac ? 0 : 1)), kv("사용자", pct(r.cpu.user, mac ? 0 : 1)), kv("대기", pct(r.cpu.idle, mac ? 0 : 1)),
      ], bars.length > 1 ? h_flex().pt(4).h(H + 4).justify_end().items_end().gap(1)
        .children(bars.map((v) => div().w(2).h(Math.max(1, Math.round((v * H) / 100))).flex_none().bg(t.accent))) : null));
    }
    if (r.mem) {
      const m = r.mem;
      out.push(block("memory", `메모리: ${pct(m.pct)}`, mac
        ? [kv("압력", pct(m.pressure)), kv("앱 메모리", gb(m.app)), kv("와이어드 메모리", gb(m.wired)), kv("압축됨", gb(m.compressed))]
        : [kv("압력", m.pressure !== null ? pct(m.pressure) : null), kv("사용", `${gb(m.used)} / ${gb(m.total)}`), kv("캐시", gb(m.cache)), kv("스왑", gb(m.swap))]));
    }
    if (r.disk) {
      out.push(block("disk", `저장 용량: ${pct(r.disk.pct)} 사용됨`, [
        div().text_size(12).text_color(t.foreground).child(`${gb(r.disk.used)} / ${gb(r.disk.total)}`),
      ], div().mt(4).w(Math.max(60, W)).h(4).rounded(2).bg(t.border)
        .child(div().h(4).rounded(2).bg(t.accent).w(Math.round((Math.max(60, W) * Math.min(100, r.disk.pct)) / 100)))));
    }
    if (r.battery) {
      const b = r.battery;
      out.push(block("battery", `배터리: ${pct(b.pct)}`, [
        kv("전원 공급원", b.source), kv("성능 최대치", b.health ? pct(b.health) : null), kv("사이클 수", b.cycles ? String(b.cycles) : null), kv("온도", b.temp ? `${b.temp.toFixed(1)}°C` : null),
      ]));
    }
    out.push(block("globe", `네트워크: ${r.kind ?? r.iface ?? "없음"}`, [
      kv("로컬 IP", r.ip), kv("업로드", rate(r.up)), kv("다운로드", rate(r.down)),
    ]));
    // 구역 사이 얇은 선
    return out.flatMap((x, i) => (i ? [div().h(1).flex_none().bg(t.border), x] : [x]));
  }

  confirmRemove(e) {
    openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 210, props: {
      role: "confirm", action: "serverRemove", ctx: { name: e.name }, title: "머신 제거",
      detail: `'${e.name}'을(를) Herdr에서 지웁니다. 그 머신의 터미널은 계속 돌고, 다시 추가할 수 있습니다.`,
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
