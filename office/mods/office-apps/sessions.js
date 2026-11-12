// office-apps의 세션 앱: 지금 스페이스 폴더의 지난 Claude Code 세션을 보고 이어 한다.
//   범위: 파일·브랜치 앱과 같은 규칙(포커스된 패인의 폴더, 없으면 스페이스 폴더, 다른 머신이면 on)의 폴더.
//         기록 = ~/.claude/projects/<폴더 경로의 영문·숫자 밖 글자를 '-'로>/*.jsonl (agent/activity.js sessionOf와 같은 규칙).
//   왼쪽: 날짜 묶음(오늘/어제/이번 주/그 전) 아래 줄 = 첫 요청 한 줄 · 흐린 시각. 지금 터미널에서 도는 세션은 "지금 열림".
//         최근 50개, 더 있으면 맨 아래 "더 보기"(50개씩).
//   오른쪽: 요청(첫 요청) · 마지막 말(마크다운 앞 6줄, agent/say.js) · 마지막 턴에서 고친 파일 · 게시한 아티팩트(누르면 브라우저.
//         제목은 title → .html의 <title> → description 첫 부분 → 파일 이름, 사무실 왼쪽 패널과 같다) · 길이(크기·기간).
//         동작 하나: "이어하기"(새 탭에서 claude --resume <id>, 폴더는 그 세션의 cwd). 지금 열려 있으면 대신 "그 터미널로 가기".
//         이어하기를 누르면 열린 터미널이 보일 때까지(최대 15초) "여는 중"이고, 클릭·Enter·더블클릭 모두 같은 세션을 다시 열지 않는다.
//         작업 공간 앱이 재운 세션(data/office-apps/sleeping.json, 칸이 셸이거나 닫힘)은 목록에 흐린 "잠듦", 동작은 "깨우기"
//         (workspace/sleeper.js wake: 원래 칸에서 이어 가고 기록 잠금으로 한 번만). 이어하기로 따로 열지 않는다.
// 읽는 양: 목록은 stat + 처음 보는 파일만 앞부분의 user 줄 몇 개(sessions/list.js LIST_SH).
//   마지막 말·고친 파일은 고른 세션만 끝 2MB(agent/activity.js readLog, 크기가 그대로면 다시 읽지 않는다),
//   아티팩트는 고른 세션 전체를 grep하되 지난번 크기 뒤에 붙은 부분만 이어 읽는다.
// 갱신: 이 앱이 그려지는 동안 30초마다. 알렸는데 그려지지 않았으면 멈추고 다시 그려질 때 이어 간다(에이전트 앱과 같은 방식).
// 셸 계약: move(delta, cx) 세션 줄만 오간다(날짜 머리줄은 건너뜀) · activate(cx) 이어하기/그 터미널로 가기 · emptyState · dispose.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, layout, run, setShared } from "herdr";
import { openViewer } from "./files.js";
import { termInfo, readLog, machineOf } from "./agent/activity.js";
import { sayView } from "./agent/say.js";
import { readSleeping, wake } from "./workspace/sleeper.js";
import { paneState, wakingNow, SLEPT } from "./workspace/sleep.js";
import { slug, parseListing, rowsOf, oneLine, whenLabel, stamp, span, bytes, collectArtifacts, artifactList,
  needsPageTitle, titleOfHtml, artifactTitle, LIST_SH, ARTS_SH, OPEN_SH, parseOpen } from "./sessions/list.js";

const PAGE = 50;            // 목록을 몇 개씩
const EVERY = 30000;        // 다시 읽는 간격
const TERM_TTL = 15000;     // 터미널 pid(hc get)를 다시 묻는 간격
const LAUNCH = 15000;       // 이어하기 잠금: 이만큼 지나도 열린 게 안 보이면 실패로 보고 다시 시도하게 한다
const LOOKS = [2000, 5000, 9000, 13000];     // 이어하기 뒤 열린 터미널을 찾아 다시 읽는 때(잠금이 풀리기 전에 끝나게)
// 아티팩트 .html의 <title>: 머신|URL|파일 → 제목(없으면 null). URL당 한 번만 앞 8KB를 읽는다.
const TITLES = new Map();

// files.js·branch.js와 같은 규칙: 포커스된 패인의 폴더, 없으면 스페이스 폴더. 다른 머신이면 on.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on: on ?? null };
}

const isClaude = (p) => /claude/i.test(`${p?.program?.key ?? ""} ${p?.program?.name ?? ""} ${p?.app ?? ""}`);

// 홈 아래 경로는 ~/…
function tilde(p) {
  const h = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(p ?? "")?.[1];
  return h ? `~${p.slice(h.length)}` : p ?? "";
}
function shortPath(p, cwd) {
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return tilde(p);
}
function ago(at) {
  if (!at) return "";
  const m = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
}

// 그 터미널로: 에이전트 앱 goTo와 같다(office 레이아웃이면 터미널 칸을 열고 사무실에 고른 워크트리를 알린다).
function goTo({ address, space }) {
  if (space) run("space.select", { id: space });
  run("agent.focus", { terminal: address });
  if (space && JSON.stringify(layout() ?? {}).includes('"office-term"')) {
    run("layout.show", { id: "office-term" });
    setShared("office.open", space);
  }
}

// 이어하기: 브랜치 앱 inTab과 같은 방식(새 탭 + 터미널 칸 열기).
function resume(s, cwd) {
  const name = oneLine(s.ask).slice(0, 24) || "이어하기";
  run("tab.new", { name, folder: s.cwd || cwd, argv: ["claude", "--resume", s.id] });
  run("layout.show", { id: "office-term" });
}

export class SessionsApp {
  init(_p, _cx) {
    this.where = null;          // 지금 보는 폴더 키 [on, cwd]
    this.loc = { cwd: null, on: null };
    this.sessions = [];         // 최신순 { id, mtime, size, birth, ask, cwd, startAt }
    this.total = 0;
    this.limit = PAGE;
    this.heads = new Map();     // id → { ask, cwd, startAt } (앞부분은 한 번만 읽는다)
    this.opened = new Map();    // 세션 id → { address, space } | { elsewhere: true }
    this.pids = new Map();      // 터미널 주소 → { pid, at }
    this.launching = new Map(); // 이어하기 잠금: 세션 id → 누른 시각. 폴더가 바뀌어도 지우지 않는다(새 탭으로 포커스가 옮겨 간다)
    this.det = {};              // 세션 id → { size, log, acc, artsAt }
    this.asleep = new Map();    // 세션 id → 잠든 기록(작업 공간 앱이 재운 것, data/office-apps/sleeping.json)
    this.wakeWhy = {};          // 세션 id → 깨우지 못한 이유
    this.sel = null;
    this.more = false;          // 첫 요청을 펼쳤는지
    this.loaded = false; this.failed = false;
    this.timer = null; this.busy = false; this.again = false;
    this.rendered = 0; this.notified = 0;
  }

  dispose() {
    this.disposed = true;
    this.timer?.cancel(); this.timer = null;
  }

  // ── 갱신 ───────────────────────────────────────────────
  // 렌더마다: 폴더가 바뀌었으면 비우고 바로 읽고, 타이머가 멈춰 있으면 다시 건다.
  ensure(cx) {
    this.rendered = Date.now();
    const loc = location(), k = JSON.stringify([loc.on, loc.cwd]);
    if (k !== this.where) {
      this.where = k; this.loc = loc;
      this.sessions = []; this.total = 0; this.limit = PAGE; this.heads = new Map(); this.opened = new Map();
      this.det = {}; this.sel = null; this.more = false; this.loaded = false; this.failed = false;
      this.kick(cx);
    } else if (!this.timer && !this.busy) this.loop(cx, 0);
  }

  kick(cx) {
    if (this.busy) { this.again = true; return; }
    this.timer?.cancel(); this.timer = null;
    this.loop(cx, 0);
  }

  loop(cx, delay) {
    if (this.disposed) return;
    this.timer = cx.timer.after(delay, (cx) => {
      this.timer = null;
      if (this.disposed || this.notified > this.rendered) return;   // 안 보이는 중: ensure가 다시 깨운다
      this.busy = true;
      const k = this.where;
      cx.spawn(async (cx) => {
        let changed = false;
        try { changed = await this.refresh(k); if (this.failed) { this.failed = false; changed = true; } }
        catch { if (!this.failed) { this.failed = true; changed = true; } }
        this.busy = false;
        if (k === this.where && !this.loaded) { this.loaded = true; changed = true; }
        const again = this.again; this.again = false;
        if (changed) { this.notified = Date.now(); cx.notify(); }
        this.loop(cx, again ? 0 : EVERY);
      });
    });
  }

  async refresh(k) {
    const loc = this.loc;
    if (!loc.cwd) return false;
    const proj = `$HOME/.claude/projects/${slug(loc.cwd)}`;
    const r = await exec("sh", ["-c", LIST_SH, "sessions", proj, String(this.limit), [...this.heads.keys()].join(",")], { on: loc.on });
    if (k !== this.where) return false;   // 그새 다른 폴더로 옮겼다
    if (r.code !== 0 && r.code !== 3) throw new Error(`list ${r.code}`);
    const { total, files } = r.code === 3 ? { total: 0, files: [] } : parseListing(r.stdout);
    for (const f of files) if (f.head) this.heads.set(f.id, { ask: f.ask, cwd: f.cwd, startAt: f.startAt });
    const next = files.map(({ id, mtime, size, birth }) => ({ id, mtime, size, birth, ...(this.heads.get(id) ?? {}) }));
    const sig = (list) => list.map((s) => `${s.id}:${s.size}:${s.mtime}`).join(",");
    let changed = sig(next) !== sig(this.sessions) || total !== this.total;
    this.sessions = next; this.total = total;
    if (!this.current() && next.length) { this.sel = next[0].id; this.more = false; changed = true; }
    if (await this.readOpen(loc, k)) changed = true;
    if (await this.readAsleep(loc, k)) changed = true;
    const s = this.current();
    if (s && this.det[s.id]?.size !== s.size && await this.readDetail(s, loc, k)) changed = true;
    return changed;
  }

  // 지금 도는 세션: 그 머신의 ~/.claude/sessions/<pid>.json(pid가 살아 있는 것) → 세션 id.
  //   Herdr의 Claude 터미널마다 앞쪽 프로세스 pid(hc get, 15초 캐시)를 맞춰 그 터미널을 찾는다. 못 찾으면 Herdr 밖에서 열린 것.
  async readOpen(loc, k) {
    const r = await exec("sh", ["-c", OPEN_SH, "open"], { on: loc.on });
    if (k !== this.where) return false;
    const live = r.code === 0 ? parseOpen(r.stdout) : new Map();
    const mine = this.sessions.filter((s) => live.has(s.id));
    const next = new Map();
    if (mine.length) {
      const tabSpace = new Map(spaces().flatMap((sp) => sp.tabs.map((tb) => [tb.id, sp.id])));
      const terms = (panes() ?? []).filter((p) => p.terminal && isClaude(p) && (machineOf(p.terminal) ?? null) === loc.on);
      const byPid = new Map();
      for (const p of terms) {
        let c = this.pids.get(p.terminal);
        if (!c || Date.now() - c.at > TERM_TTL) {
          const i = await termInfo(p.terminal).catch(() => null);
          c = { pid: i?.pid ?? null, at: Date.now() };
          this.pids.set(p.terminal, c);
        }
        if (c.pid) byPid.set(c.pid, { address: p.terminal, space: tabSpace.get(p.tab) ?? null });
      }
      for (const s of mine) next.set(s.id, byPid.get(live.get(s.id).pid) ?? { elsewhere: true });
    }
    const sig = (m) => JSON.stringify([...m]);
    const changed = sig(next) !== sig(this.opened);
    this.opened = next;
    // 잠금은 Herdr 터미널이 보일 때만 푼다(새 칸이 Claude로 잡히기 전에는 잠깐 "밖에서 열림"으로 읽힐 수 있다)
    for (const [id, o] of next) if (o.address) this.launching.delete(id);
    return changed;
  }

  // 잠든 세션: 작업 공간 앱이 재운 기록 중 이 머신의 것이고, 그 칸이 아직 셸이거나 닫힌 것(깨울 수 있는 것).
  //   이어하기 대신 깨우기로 연다(같은 대화가 두 곳에서 돌지 않게, 깨우기는 원래 칸에서 이어 간다).
  async readAsleep(loc, k) {
    const rs = await readSleeping().catch(() => []);
    if (k !== this.where) return false;
    const ps = panes() ?? [], next = new Map();
    for (const r of rs) if ((r.machine ?? null) === (loc.on ?? null) && paneState(r, ps) !== "busy") next.set(r.session, r);
    const sig = (m) => JSON.stringify([...m]);
    const changed = sig(next) !== sig(this.asleep);
    this.asleep = next;
    return changed;
  }

  // 고른 세션의 상세: 마지막 말·고친 파일(readLog: 끝 2MB, 같은 크기면 건너뜀)과 아티팩트(지난번 크기 뒤만 이어 읽기).
  async readDetail(s, loc, k) {
    const proj = `$HOME/.claude/projects/${slug(loc.cwd)}`;
    const prev = this.det[s.id];
    const log = await readLog({ project: proj, session: s.id, cwd: s.cwd ?? loc.cwd }, null, prev?.log, loc.on).catch(() => prev?.log ?? null);
    const a = await exec("sh", ["-c", ARTS_SH, "arts", proj, s.id, String(prev?.artsAt ?? 0)], { on: loc.on }).catch(() => null);
    if (k !== this.where) return false;
    let acc = prev?.acc, artsAt = prev?.artsAt ?? 0;
    if (a?.code === 0) {
      const i = a.stdout.indexOf("\n");
      const z = Number(a.stdout.slice(0, i < 0 ? undefined : i)) || 0;
      // 파일이 줄었으면(다시 쓴 기록) 처음부터 센다
      acc = collectArtifacts(i < 0 ? "" : a.stdout.slice(i + 1), z < artsAt ? undefined : structuredCloneSafe(acc));
      artsAt = z;
      // 제목이 없는 .html 아티팩트는 그 파일의 <title>(사무실 왼쪽 패널과 같은 규칙, URL당 한 번)
      for (const e of needsPageTitle(acc)) {
        const tk = `${loc.on ?? ""}|${e.url}|${e.page}`;
        if (!TITLES.has(tk)) {
          let title = null;
          try { const r = await exec("head", ["-c", "8192", e.page], { on: loc.on }); if (r.code === 0) title = titleOfHtml(r.stdout); } catch { /* 못 읽으면 다른 재료로 */ }
          TITLES.set(tk, title);
        }
        e.htmlTitle = TITLES.get(tk);
      }
      if (k !== this.where) return false;
    }
    this.det[s.id] = { size: s.size, log: log?.same ? prev?.log ?? null : log, acc, artsAt };
    return true;
  }

  // ── 고르기·키 ──────────────────────────────────────────
  current() {
    return this.sessions.find((s) => s.id === this.sel) ?? null;
  }

  select(id, cx) {
    if (id !== this.sel) { this.more = false; this.sayMore = false; }
    this.sel = id;
    this.kick(cx);   // 상세를 읽는다(크기가 그대로면 readLog·grep이 거의 아무것도 하지 않는다)
    cx.notify();
  }

  move(delta, cx) {
    if (!this.sessions.length) return;
    const list = rowsOf(this.sessions).filter((r) => r.s).map((r) => r.s);
    const i = list.findIndex((s) => s.id === this.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta));
    this.select(list[j].id, cx);
  }

  activate(cx) {
    const s = this.current();
    if (s) this.act(s, cx);
  }

  // 이어하기를 누른 지 LAUNCH가 안 됐고 아직 열린 터미널이 안 보이는지
  launchingNow(id) {
    const at = this.launching.get(id);
    if (at && Date.now() - at < LAUNCH) return true;
    if (at) this.launching.delete(id);
    return false;
  }

  // 주 동작: 열려 있으면 그 터미널로, 아니면 새 탭에서 이어하기. Herdr 밖에서 열려 있으면 하지 않는다(두 곳에서 같은 세션을 쓰게 된다).
  // 클릭·Enter·더블클릭 모두 여기로 온다. 이어하기를 누른 뒤 열린 터미널이 보일 때까지(최대 LAUNCH) 같은 세션은 다시 열지 않는다.
  act(s, cx) {
    const o = this.opened.get(s.id);
    if (o?.address) { this.launching.delete(s.id); return goTo(o); }
    if (this.launchingNow(s.id) || o?.elsewhere) return;
    const z = this.asleep.get(s.id);
    if (z) return this.wakeIt(s, z, cx);
    this.launching.set(s.id, Date.now());
    try { resume(s, this.loc.cwd); } catch { this.launching.delete(s.id); cx.notify(); return; }
    cx.notify();
    // 몇 번 다시 읽어 "지금 열림"으로 바꾼다. LAUNCH까지 안 보이면 잠금이 풀려 다시 시도할 수 있다(그때 다시 그린다).
    for (const ms of LOOKS) cx.timer.after(ms, (cx) => { this.pids.clear(); this.kick(cx); });
    cx.timer.after(LAUNCH + 50, (cx) => cx.notify());
  }

  // 잠든 세션 깨우기(작업 공간 앱과 같은 workspace/sleeper.js wake: 기록 잠금 · Claude Code가 뜬 것을 본 뒤 기록 삭제).
  //   여는 동안은 이어하기와 같은 잠금(launching)으로 막는다. 실패면 잠든 채로 두고 이유를 상세에 보인다.
  wakeIt(s, rec, cx) {
    if (wakingNow(rec)) return;
    this.launching.set(s.id, Date.now());
    delete this.wakeWhy[s.id];
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await wake(rec).catch(() => ({ ok: false, why: "깨우지 못했습니다" }));
      this.launching.delete(s.id);
      if (r.ok || r.removed) this.asleep.delete(s.id);
      if (r.why) this.wakeWhy[s.id] = r.why;
      if (r.to?.terminal) goTo({ address: r.to.terminal, space: r.to.space });
      this.pids.clear(); this.kick(cx);
      cx.notify();
    });
  }

  emptyState() {
    if (!this.loc.cwd) return { text: "폴더를 알 수 없습니다", sub: "터미널이 있는 스페이스를 고르세요" };
    if (!this.loaded) return { text: "세션을 읽는 중", sub: tilde(this.loc.cwd) };
    if (this.failed) return { text: "기록을 읽지 못했습니다", sub: tilde(this.loc.cwd) };
    return { text: "이 폴더의 Claude Code 세션이 없습니다", sub: `${tilde(this.loc.cwd)} · 하위 폴더에서 시작한 세션은 그 폴더에서 보입니다` };
  }

  subtitle(t) {
    const where = tilde(this.loc.cwd);
    return h_flex().gap(10).items_center().text_size(12).text_color(t.dim).truncate()
      .child(div().flex_1().min_w(0).truncate().child(where))
      .when(this.total > 0, (el) => el.child(div().flex_none().child(`세션 ${this.total}`)));
  }

  // ── 그리기 ─────────────────────────────────────────────
  // 목록 오른쪽 낱말: 열린 것은 "지금 열림"(Herdr 밖이면 "다른 곳에서 열림"), 아니면 흐린 시각
  right(s, t) {
    const o = this.opened.get(s.id), z = this.asleep.get(s.id);
    if (o?.address) return ["지금 열림", t.working];
    if (this.launchingNow(s.id)) return [z ? "깨우는 중" : "여는 중", t.muted];   // 다른 곳에서 열림보다 먼저
    if (z) return [wakingNow(z) ? "깨우는 중" : SLEPT, t.muted];
    if (o?.elsewhere) return ["다른 곳에서 열림", t.muted];
    return [whenLabel(s.mtime), t.dim];
  }

  list(cx, t) {
    this.ensure(cx);
    const rows = rowsOf(this.sessions);
    const left = this.total - this.sessions.length;
    return v_flex().id("sessions-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
      .when(!rows.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim)
        .child(!this.loc.cwd ? "폴더 없음" : this.loaded ? "세션 없음" : "읽는 중")))
      .children(rows.map((r, i) => {
        if (r.head) return div().id(`ss-h-${i}`).flex_none().px(6).pt(i ? 10 : 4).pb(2).text_size(11).text_color(t.dim).child(r.head);
        const s = r.s, on = s.id === this.sel, [right, rc] = this.right(s, t);
        const ask = oneLine(s.ask);
        return h_flex().id(`ss-${s.id}`).h(26).flex_none().px(6).gap(8).items_center().rounded(4).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((x) => x.bg(t.hover)))
          .on_click((e, cx) => { this.select(s.id, cx); if (e.click_count >= 2) this.act(s, cx); })
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(ask ? t.foreground : t.muted).child(ask || "요청 없음"))
          .child(div().flex_none().text_size(11).text_color(rc).child(right));
      }))
      .when(left > 0, (el) => el.child(h_flex().id("sessions-more").flex_none().mt(6).px(6).h(26).items_center().rounded(4)
        .text_size(12).text_color(t.muted).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.limit += PAGE; this.kick(cx); })
        .child(`더 보기 · ${Math.min(PAGE, left)}개`)));
  }

  detail(cx, t) {
    this.ensure(cx);
    const s = this.current();
    if (!s) return null;
    const d = this.det[s.id], log = d?.log, o = this.opened.get(s.id);
    const btn = (id, text, fn) => div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.foreground).cursor_pointer().hover((x) => x.bg(t.hover)).on_click(fn).child(text);
    const head = (text) => div().pt(16).pb(4).text_size(12).font_semibold().text_color(t.muted).child(text);

    const items = [];
    // 요청: 첫 요청. 길면 몇 줄만, 누르면 펼친다.
    if (s.ask) {
      const long = s.ask.length > 280 || s.ask.split("\n").length > 4;
      const shown = long && !this.more ? `${s.ask.split("\n").slice(0, 4).join("\n").slice(0, 280).trimEnd()}…` : s.ask;
      items.push(div().text_size(11).text_color(t.dim).child("요청"));
      items.push(div().id("sessions-ask").pt(2).text_size(13).text_color(t.foreground).child(shown)
        .when(long, (el) => el.cursor_pointer().on_click((_e, cx) => { this.more = !this.more; cx.notify(); })));
    }
    if (!d) items.push(div().pt(14).text_size(12).text_color(t.dim).child("기록을 읽는 중"));
    else {
      // 마지막 말: 언제 한 말인지 흐리게
      if (log?.say) {
        const at = ago(log.sayAt || log.lastAt);
        items.push(div().pt(14).text_size(11).text_color(t.dim).child(at ? `마지막 말 · ${at}` : "마지막 말"));
        // 줄바꿈을 살린 마크다운 앞 6줄(넘치면 "더 보기", 에이전트 앱과 같은 agent/say.js)
        items.push(div().pt(2).child(sayView(`sessions-say-${s.id}`, log.say, { open: this.sayMore, size: 12, color: t.muted, t,
          onToggle: (_e, cx) => { this.sayMore = !this.sayMore; cx.notify(); } })));
      }
      // 고친 파일: 마지막 턴(기록 끝 2MB 안)만. 누르면 뷰어 창.
      if (log?.edited?.length) {
        items.push(head(`마지막 턴에서 고친 파일 ${log.edited.length + (log.moreEdited ?? 0)}`));
        items.push(...log.edited.map((f, i) => h_flex().id(`sessions-file-${i}`).h(24).px(6).items_center().rounded(4)
          .when(f.path.startsWith("/"), (el) => el.cursor_pointer().hover((x) => x.bg(t.hover).underline())
            .on_click(() => openViewer(f.path, this.loc.on)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(shortPath(f.path, s.cwd ?? this.loc.cwd)))));
        if (log.moreEdited) items.push(div().pl(6).text_size(11).text_color(t.dim).child(`외 ${log.moreEdited}개`));
      }
      // 게시한 아티팩트: 누르면 브라우저(이 Mac에서)
      const arts = artifactList(d.acc);
      if (arts.length) {
        items.push(head(`게시한 아티팩트 ${arts.length}`));
        items.push(...arts.map((a, i) => h_flex().id(`sessions-art-${i}`).h(24).px(6).gap(8).items_center().rounded(4).cursor_pointer()
          .hover((x) => x.bg(t.hover)).on_click(() => { exec("open", [a.url]).catch(() => null); })
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(artifactTitle(a)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(whenLabel(a.last)))));
      }
    }
    // 길이: 크기 · 기간(시작 ~ 마지막 기록)
    const start = s.startAt || s.birth;
    items.push(head("길이"));
    items.push(div().text_size(12).text_color(t.muted)
      .child([bytes(s.size), start ? span(s.mtime - start) : "", start ? `${stamp(start)} ~ ${stamp(s.mtime)}` : stamp(s.mtime)].filter(Boolean).join(" · ")));
    if (s.cwd && s.cwd !== this.loc.cwd) items.push(div().pt(2).text_size(12).text_color(t.dim).child(`폴더 ${tilde(s.cwd)}`));
    const z = !o ? this.asleep.get(s.id) : null, waking = Boolean(z) && (this.launchingNow(s.id) || wakingNow(z));
    if (z) items.push(div().pt(14).text_size(12).text_color(t.muted).child(paneState(z, panes() ?? []) === "gone"
      ? `${SLEPT} · 작업 공간 앱이 재웠습니다. 칸이 닫혀 깨우면 새 탭에서 이어 갑니다`
      : `${SLEPT} · 작업 공간 앱이 재웠습니다. 깨우면 '${z.tabName || "원래"}' 탭의 그 칸에서 이어 갑니다`));
    if (z && this.wakeWhy[s.id]) items.push(div().pt(2).text_size(12).text_color(t.muted).child(this.wakeWhy[s.id]));
    if (o?.elsewhere && !this.launchingNow(s.id)) items.push(div().pt(14).text_size(12).text_color(t.muted).child("Herdr 밖의 터미널에서 열려 있어 여기서 이어 하지 않습니다"));

    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(oneLine(s.ask) || "요청 없음"))
        .when(Boolean(o?.address), (el) => el.child(btn("sessions-go", "그 터미널로 가기", (_e, cx) => this.act(s, cx))))
        .when(!o?.address && this.launchingNow(s.id), (el) => el.child(div().flex_none().px(10).py(4).text_size(12).text_color(t.dim).child("여는 중")))
        .when(Boolean(z) && waking, (el) => el.child(div().flex_none().px(10).py(4).text_size(12).text_color(t.dim).child("깨우는 중")))
        .when(Boolean(z) && !waking, (el) => el.child(btn("sessions-wake", "깨우기", (_e, cx) => this.act(s, cx))))
        .when(!o && !z && !this.launchingNow(s.id), (el) => el.child(btn("sessions-resume", "이어하기", (_e, cx) => this.act(s, cx)))))
      .child(v_flex().id("sessions-detail").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(2).children(items));
  }
}

// 아티팩트 누적값 복사(이어 읽기 중 실패해도 지난 값이 망가지지 않게)
function structuredCloneSafe(acc) {
  return acc ? JSON.parse(JSON.stringify(acc)) : undefined;
}
