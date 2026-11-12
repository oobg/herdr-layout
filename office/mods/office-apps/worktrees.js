// office-apps의 워크트리 앱. 지금 스페이스(포커스된 패인)의 git 레포에 딸린 워크트리를 보여 준다.
//   왼쪽: 툴바(새 워크트리·이슈에서 시작·다시 읽기) + 워크트리 목록(메인이 맨 위). 줄마다 브랜치, 기본 브랜치 대비 ↑↓,
//         변경 수, 그 폴더에서 도는 에이전트의 상태 낱말.
//   오른쪽: 경로·브랜치·기본 브랜치 대비·에이전트·변경 파일(누르면 뷰어 창), 동작(에이전트 띄우기·스페이스로 가기·지우기).
//         그 폴더에 터미널이 열린 에이전트(상태 무관)가 있으면 "지우기"를 잠그고 "먼저 끝내거나 재우세요"와 그 터미널로 가기. 실행 직전에도 다시 본다.
//         "이슈에서 시작"을 누르면 오른쪽이 이슈 목록이 된다: 고르면 브랜치 이름을 묻고 워크트리를 만든 뒤
//         그 폴더에서 Claude Code를 띄우고 이슈 본문을 첫 메시지(task)로 넘긴다.
// 에이전트 띄우기는 office 모드 AddAgent와 같은 명령: 그 폴더의 스페이스가 있으면 tab.new {name, space, folder, argv},
// 없으면 space.new {folder, argv}. argv는 knownAgents의 Claude 항목 run + AddAgent와 같은 권한 건너뛰기 플래그(이슈에서 시작할 때는 빼서 권한 확인을 남긴다).
// 확인 창·입력 창은 오버레이 복사본에서 돌므로 값만 넘기고, 만든 워크트리는 공유 값(MADE)으로 앱에게 알린다.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, focused, exec, theme, home, props, run, openOverlay, closeOverlay, notify, shared, setShared, knownAgents, layout } from "herdr";
import { ACTIONS, TICK } from "./menu.js";
import { ROLES, openViewer } from "./files.js";
import { parseWorktrees, parseStatus, statusWord, validName, issueBranch, worktreePath, worktreeOf, parseCounts, counts, liveAgentsIn } from "./worktrees/model.js";

const ME = "mods/office-apps";
const I = (n) => `${ME}/${n}.svg`;
const W = (n) => `${ME}/worktrees/${n}.svg`;
const MADE = "office-apps.worktrees.made";  // 입력 창(오버레이)이 만든 워크트리를 앱에게 알리는 공유 키
const NOT_REPO = "git 저장소가 아닙니다";
const STATUS = { working: "작업 중", blocked: "입력 대기", done: "끝남", idle: "대기 중" };
const RANK = { blocked: 3, working: 2, done: 1, idle: 0 };
const FILES_MAX = 300;
const FLAG = "--dangerously-skip-permissions"; // office/main.js YOLO.claude와 같다
const TERM = "office-term";

// ── 위치 ────────────────────────────────────────────────────

// branch.js와 같은 규칙: 포커스된 패인의 폴더, 없으면 스페이스 폴더. 다른 머신이면 on.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => { const l = location(); return JSON.stringify([l.on, l.cwd]); };
const tilde = (p) => (p ? p.replace(home(), "~") : "");
const leaf = (p) => p.replace(/\/+$/, "").split("/").pop();

// 그 워크트리 폴더(안쪽 폴더 포함)를 시작 폴더로 둔 스페이스. 없으면 그 폴더에 터미널이 있는 스페이스.
function spaceFor(path, all, on) {
  const mine = spaces().filter((s) => (s.machine ?? null) === (on ?? null));
  return mine.find((s) => worktreeOf(s.folder, all) === path)
    ?? mine.find((s) => panes().some((p) => s.tabs.some((tb) => tb.id === p.tab) && worktreeOf(p.cwd, all) === path)) ?? null;
}

// 스페이스를 보여 주고, office 레이아웃이면 터미널 칸을 그 스페이스로(agent.js goTo와 같게).
function showSpace(id) {
  run("space.select", { id });
  if (JSON.stringify(layout() ?? {}).includes(`"${TERM}"`)) {
    run("layout.show", { id: TERM });
    setShared("office.open", id);
  }
}

// AddAgent와 같은 argv: knownAgents의 Claude 항목 run + 권한 건너뛰기 플래그. 못 찾으면 claude.
// yolo=false: 이슈 본문처럼 남이 쓴 글을 첫 메시지로 넘길 때는 권한 확인을 건너뛰지 않는다(프롬프트 주입 대비).
async function claudeAgent(on, yolo = true) {
  let a = null;
  try { a = (await knownAgents({ on })).find((x) => x.installed && /claude/i.test(`${x.key} ${x.name} ${x.run?.[0] ?? ""}`)) ?? null; }
  catch { /* 확인 실패: 기본값 */ }
  const argv = a?.run?.length ? [...a.run] : ["claude"];
  if (yolo && !argv.includes(FLAG)) argv.push(FLAG);
  if (!yolo) { const i = argv.indexOf(FLAG); if (i >= 0) argv.splice(i, 1); }
  return { name: a?.name ?? "Claude Code", argv };
}

// 그 워크트리에서 터미널이 열려 있는 에이전트 칸 → [{ address, space, pane }]. 있으면 지우지 않는다(돌던 에이전트가 폴더를 잃는다).
function liveIn(path, all, on) {
  const tabSpace = new Map(spaces().flatMap((s) => s.tabs.map((tb) => [tb.id, s])));
  return liveAgentsIn(path, all, panes() ?? [], { on, machineOfTab: (tab) => tabSpace.get(tab)?.machine ?? null })
    .map((p) => ({ address: p.terminal, space: tabSpace.get(p.tab)?.id ?? null, tab: p.tab, pane: p.pane }));
}

// ── 동작(오버레이 복사본에서도 돈다: ctx는 값만) ────────────────
// ctx: { root, on, base, path?, all?, branch?, dirty?, agents?, issue?: { number, title } }

const changed = () => setShared(TICK, Date.now());

const ACT = {
  // git worktree add -b <이름> <레포 옆 폴더> <기본 브랜치>. 만들면 앱이 그 워크트리를 고르게 MADE로 알린다.
  add: async (ctx, name) => {
    const path = worktreePath(ctx.root, name);
    const args = ["worktree", "add", "-b", name, path, ...(ctx.base ? [ctx.base] : [])];
    const r = await exec("git", args, { cwd: ctx.root, on: ctx.on, timeout: 120000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code !== 0) {
      notify({ title: "워크트리를 만들지 못했습니다", body: (r.stderr || r.stdout || "").trim().slice(0, 400), level: "error" });
      return changed();
    }
    notify({ title: `'${name}' 워크트리를 만들었습니다`, body: tilde(path), level: "info" });
    setShared(MADE, { root: ctx.root, path, at: Date.now(), issue: ctx.issue ?? null });
    changed();
  },
  // --force는 쓰지 않는다: 변경이 있거나 잠겨 있으면 git이 거부하고, 그 말을 그대로 알린다. 브랜치는 남긴다.
  // 실행 직전에 그 폴더의 에이전트를 다시 본다: 창을 연 사이 띄웠으면 지우지 않고 알린다(누르면 그 터미널로).
  remove: async (ctx) => {
    const live = liveIn(ctx.path, ctx.all ?? [ctx.path], ctx.on ?? null);
    if (live.length) {
      notify({ title: "워크트리를 지우지 않았습니다", body: `이 폴더에서 에이전트 ${live.length}개가 열려 있습니다. 먼저 끝내거나 재우세요.`,
        level: "warning", action: { name: "pane.focus", args: { terminal: live[0].address } } });
      return changed();
    }
    const r = await exec("git", ["worktree", "remove", ctx.path], { cwd: ctx.root, on: ctx.on, timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code !== 0) notify({ title: "워크트리를 지우지 못했습니다", body: (r.stderr || r.stdout || "").trim().slice(0, 400), level: "error" });
    else notify({ title: "워크트리를 지웠습니다", body: `${tilde(ctx.path)}${ctx.branch ? ` · 브랜치 ${ctx.branch}는 남아 있습니다` : ""}`, level: "info" });
    changed();
  },
};

const confirmRemove = (ctx) => {
  register();
  const warn = [];
  if (ctx.dirty) warn.push(`커밋하지 않은 변경이 ${ctx.dirty}개 있습니다. git이 지우기를 거부하고, 그 이유를 알림으로 보여 줍니다.`);
  if (ctx.agents) warn.push(`이 폴더에서 에이전트 ${ctx.agents}개가 돌고 있습니다.`);
  const detail = [`${tilde(ctx.path)} 폴더를 지웁니다 (git worktree remove).`, ...warn,
    ctx.branch ? `브랜치 ${ctx.branch}는 지우지 않습니다.` : "분리된 HEAD라 남는 브랜치가 없습니다. 이 워크트리에만 있는 커밋은 브랜치 앱에서 찾기 어려워집니다."].join(" ");
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190,
    props: { role: "confirm", action: "worktrees.remove", title: "워크트리 지우기", detail, ctx, yes: "워크트리 지우기", danger: true } });
};

const ask = (ctx, title, value = "") => {
  register();
  openOverlay({ mod: "office-apps", kind: "dialog", width: 440, height: 210, props: { role: "worktrees-prompt", ctx, title, value } });
};

// 브랜치 이름 입력 창(branch.js BranchPrompt와 같은 모양). 아래 줄에 만들 폴더와 기준 브랜치를 보여 준다.
class WorktreePrompt {
  init(_p, cx) {
    const v = props()?.value ?? "";
    this.text = v;
    this.input = InputState.new({ value: v });
    if (v) this.input.set_selected_range({ start: 0, end: v.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  submit() {
    const p = props(), name = this.text.trim();
    if (validName(name) || this.done) return;
    this.done = true;
    closeOverlay(p.overlay);
    ACT.add(p.ctx, name);
  }

  render() {
    const t = theme(), p = props(), name = this.text.trim();
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).cursor_pointer().text_size(12.5)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const warn = name ? validName(name) : "";
    const hint = `${tilde(worktreePath(p.ctx.root, name || "<이름>"))} · ${p.ctx.base ?? "HEAD"}에서`;
    return v_flex().id("wt-prompt").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(p.title)).child(div().text_size(11).text_color(t.muted).child("Esc")))
      .child(div().truncate().text_size(12).text_color(warn ? t.ansi1 : t.muted).child(warn || hint))
      .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(13))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button("wt-p-no", "취소", false, () => closeOverlay(p.overlay)))
        .child(button("wt-p-yes", p.ctx.issue ? "만들고 에이전트 띄우기" : "만들기", true, () => this.submit())));
  }
}

// ── 앱 ──────────────────────────────────────────────────────

export class WorktreesApp {
  init(_p, cx) {
    register();
    this.tick = shared(TICK);
    this.madeAt = shared(MADE)?.at ?? null;
    this.ctx = null;        // { key, cwd, on }
    this.data = null;       // { root, base, github, items: [{ ...worktree, files[], vs, error }] }
    this.loading = false; this.error = null;
    this.sel = null;        // 고른 워크트리 경로
    this.mode = "list";     // "list" | "issues"(오른쪽이 이슈 목록)
    this.issues = null;     // { list[], error, loading }
    this.isel = null;       // 이슈 목록에서 고른 번호
    this.scroll = ScrollHandle.new();
    this.gh = null;
    cx.spawn(async () => {
      const r = await exec("sh", ["-lc", "command -v gh"]).catch(() => null);
      this.gh = r?.code === 0;
    });
    this.reload(cx);
    this.poll = cx.timer.every(15000, (cx) => { if (!this.disposed) this.reload(cx); });
  }

  dispose() {
    this.disposed = true;
    this.poll?.cancel(); this.poll = null;
    try { this.scroll?.release(); } catch { /* 이미 해제됨 */ }
  }

  reload(cx) {
    const { cwd, on } = location(), k = key();
    if (k !== this.ctx?.key) {
      this.ctx = { key: k, cwd, on };
      this.data = null; this.sel = null; this.error = null; this.loading = false;
      this.mode = "list"; this.issues = null; this.isel = null;
    }
    if (!cwd) return;
    // 읽는 중에 또 바뀌면(입력 창이 워크트리를 만든 직후 등) 끝난 뒤 한 번 더 읽는다.
    if (this.loading) { this.again = true; return; }
    const ctx = this.ctx;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const data = await this.load(ctx);
        if (this.ctx !== ctx) return;
        this.data = data; this.error = data ? null : NOT_REPO;
        if (data && this.want && data.items.some((w) => w.path === this.want)) { this.sel = this.want; this.want = null; }
        if (data && (!this.sel || !data.items.some((w) => w.path === this.sel))) {
          // 처음엔 지금 폴더가 든 워크트리를 고른다.
          this.sel = worktreeOf(ctx.cwd, data.items.map((w) => w.path)) ?? data.items[0]?.path ?? null;
        }
      } catch (e) {
        if (this.ctx === ctx) this.error = String(e?.message || e).slice(0, 200);
      } finally {
        if (this.ctx === ctx) this.loading = false;
        if (this.again && !this.disposed) { this.again = false; this.reload(cx); }
        cx.notify();
      }
    });
  }

  async load(ctx) {
    const o = { cwd: ctx.cwd, on: ctx.on };
    const r = await exec("git", ["worktree", "list", "--porcelain"], o);
    if (r.code !== 0) return null;
    const list = parseWorktrees(r.stdout);
    if (!list.length) return null;
    // 레포는 첫 항목(메인 워크트리). 링크된 워크트리 안에서 열어도 메인 옆에 만든다.
    const root = list[0].path, ro = { cwd: root, on: ctx.on };
    const [head, url] = await Promise.all([
      exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], ro).catch(() => null),
      exec("git", ["remote", "get-url", "origin"], ro).catch(() => null),
    ]);
    // 기본 브랜치: origin/HEAD가 가리키는 이름. 로컬에 있으면 로컬, 없으면 origin/이름. origin/HEAD가 없으면 main·master.
    let name = head?.code === 0 ? head.stdout.trim().replace(/^[^/]+\//, "") : null;
    const has = async (ref) => (await exec("git", ["rev-parse", "--verify", "--quiet", ref], ro).catch(() => null))?.code === 0;
    let base = null;
    if (name) base = (await has(`refs/heads/${name}`)) ? name : `origin/${name}`;
    else for (const n of ["main", "master"]) if (await has(`refs/heads/${n}`)) { base = n; break; }
    const items = await Promise.all(list.map(async (w) => {
      if (w.bare || w.prunable) return { ...w, files: [], vs: null, error: null };
      const g = (args) => exec("git", ["-C", w.path, "--no-optional-locks", ...args], ro).catch(() => null);
      const [st, vs] = await Promise.all([
        g(["status", "--porcelain", "-z", "--untracked-files=all"]),
        base ? g(["rev-list", "--left-right", "--count", `${base}...HEAD`, "--"]) : null,
      ]);
      return { ...w, files: st?.code === 0 ? parseStatus(st.stdout) : [], vs: vs?.code === 0 ? parseCounts(vs.stdout) : null,
        error: st && st.code !== 0 ? (st.stderr || "").trim().slice(0, 200) : null };
    }));
    return { root, base, github: /github\.com[:/]/.test(url?.stdout ?? ""), items };
  }

  // 그릴 때마다: 스페이스가 바뀌었거나 다른 곳이 git을 바꿨으면 다시 읽고, 입력 창이 만든 워크트리를 고른다.
  sync(cx) {
    if (key() !== this.ctx?.key) this.reload(cx);
    if (shared(TICK) !== this.tick) { this.tick = shared(TICK); this.reload(cx); }
    const m = shared(MADE);
    if (m && m.at !== this.madeAt) {
      this.madeAt = m.at;
      if (m.root === this.data?.root) {
        this.sel = m.path; this.want = m.path; this.mode = "list";
        if (m.issue) this.launchIssue(m.path, m.issue, cx);
      }
    }
  }

  find(path = this.sel) { return this.data?.items.find((w) => w.path === path) ?? null; }
  paths() { return this.data?.items.map((w) => w.path) ?? []; }

  // 워크트리 경로 → 그 안에서 도는 에이전트(agents()의 패인 cwd로 맞춘다). 같은 머신의 스페이스만.
  agentsByWt() {
    const out = new Map(), all = this.paths(), on = this.ctx?.on ?? null;
    if (!all.length) return out;
    const ps = new Map(panes().map((p) => [p.pane, p])), sp = new Map(spaces().map((s) => [s.id, s]));
    for (const a of agents()) {
      if ((sp.get(a.space)?.machine ?? null) !== on) continue;
      const wt = worktreeOf(ps.get(a.pane)?.cwd, all);
      if (!wt) continue;
      if (!out.has(wt)) out.set(wt, []);
      out.get(wt).push(a);
    }
    return out;
  }

  // ── 동작(앱 쪽) ──

  async launch(path, task, cx) {
    const on = this.ctx?.on ?? null, all = this.paths();
    const { name, argv } = await claudeAgent(on, !task);  // 이슈에서 시작(task 있음)은 권한 확인을 남긴다
    const s = spaceFor(path, all, on), extra = task ? { task } : {};
    if (s) {
      run("tab.new", { name, space: s.id, folder: path, argv, ...extra });
      showSpace(s.id);
      return;
    }
    run("space.new", { folder: path, argv, ...extra, ...(on ? { machine: on } : {}) });
    // 새 스페이스 id는 바로 알 수 없다: 조금 뒤 그 폴더의 스페이스를 찾아 터미널 칸을 맞춘다.
    cx.timer.after(800, () => { const n = spaceFor(path, all.includes(path) ? all : [...all, path], on); if (n) showSpace(n.id); });
  }

  launchIssue(path, issue, cx) {
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["issue", "view", String(issue.number), "--json", "body", "-q", ".body"], { cwd: this.data?.root, on: this.ctx?.on, timeout: 30000 }).catch(() => null);
      const body = r?.code === 0 ? r.stdout.trim() : "";
      // "이슈 #N"으로 시작해 첫 메시지가 옵션으로 읽힐 일이 없다.
      await this.launch(path, `이슈 #${issue.number}: ${issue.title}${body ? `\n\n${body}` : ""}`, cx);
      cx.notify();
    });
  }

  goSpace(path) {
    const s = spaceFor(path, this.paths(), this.ctx?.on ?? null);
    if (s) showSpace(s.id);
  }

  removeCtx(w) {
    const n = this.agentsByWt().get(w.path)?.length ?? 0;
    return { root: this.data.root, on: this.ctx.on, path: w.path, all: this.paths(), branch: w.branch, dirty: w.files.length, agents: n };
  }

  newWorktree() {
    if (!this.data) return;
    ask({ root: this.data.root, on: this.ctx.on, base: this.data.base }, "새 워크트리");
  }

  showIssues(cx) {
    if (this.mode === "issues") { this.mode = "list"; return; }
    this.mode = "issues";
    this.loadIssues(cx);
  }

  loadIssues(cx) {
    if (!this.data || this.issues?.loading) return;
    const root = this.data.root, on = this.ctx.on;
    this.issues = { list: this.issues?.list ?? null, error: null, loading: true };
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["issue", "list", "--limit", "30", "--json", "number,title,labels"], { cwd: root, on, timeout: 30000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (this.data?.root !== root) return;
      let list = null, error = null;
      if (r.code === 0) { try { list = JSON.parse(r.stdout || "[]"); } catch { error = "이슈 목록을 읽지 못했습니다"; } }
      else error = (r.stderr || r.stdout || "").trim().slice(0, 300) || "gh issue list 실패";
      this.issues = { list, error, loading: false };
      if (list && !list.some((i) => i.number === this.isel)) this.isel = list[0]?.number ?? null;
      cx.notify();
    });
  }

  pickIssue(i) {
    if (!this.data) return;
    ask({ root: this.data.root, on: this.ctx.on, base: this.data.base, issue: { number: i.number, title: i.title } },
      `이슈 #${i.number}에서 워크트리`, issueBranch(i.number, i.title));
  }

  // ── 셸 계약 ──

  // ↑↓: 이슈 목록을 보고 있으면 이슈를, 아니면 워크트리를 옮긴다.
  move(delta, cx) {
    if (this.mode === "issues") {
      const list = this.issues?.list ?? [];
      if (!list.length) return;
      const i = list.findIndex((x) => x.number === this.isel);
      this.isel = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta))].number;
      return;
    }
    const list = this.paths();
    if (!list.length) return;
    const i = list.indexOf(this.sel), j = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta));
    this.sel = list[j];
    this.scroll.scroll_to_item(j);
  }

  // Enter: 이슈 목록이면 그 이슈로 만들기(입력 창), 워크트리면 그 스페이스로 가기. 탭을 열거나 지우지는 않는다.
  activate() {
    if (this.mode === "issues") {
      const i = this.issues?.list?.find((x) => x.number === this.isel);
      if (i) this.pickIssue(i);
      return;
    }
    if (this.sel) this.goSpace(this.sel);
  }

  emptyState() {
    if (!this.ctx?.cwd) return { text: "폴더가 없습니다", sub: "스페이스나 패인을 고르면 그 폴더의 저장소를 보여 줍니다" };
    if (this.error === NOT_REPO) return { text: NOT_REPO, sub: tilde(this.ctx.cwd) };
    if (this.error) return { text: "워크트리를 읽지 못했습니다", sub: this.error };
    if (!this.data) return { text: "워크트리를 읽는 중" };
    return { text: "고른 워크트리가 없습니다", sub: "왼쪽에서 워크트리를 고르세요" };
  }

  subtitle(t) {
    const root = this.data?.root;
    return div().id("wt-path").truncate().text_size(12).text_color(t.muted)
      .when(Boolean(root) && !this.ctx?.on, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", [root])))
      .child(tilde(root));
  }

  // ── 툴팁(branch.js와 같은 방식) ──
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

  // ── 왼쪽 ──

  toolbar(t) {
    const ok = Boolean(this.data), issues = ok && this.gh && this.data.github;
    const btn = (id, icon, tip, on, fn) => div().id(`wt-t-${id}`).p(4).rounded(4).flex_none()
      .on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((hv) => { if (!hv && this.tipFor === id) this.hideTip(); })
      .when(on, (el) => el.bg(t.selected))
      .when(Boolean(fn), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.hideTip(); fn(cx); cx.notify(); }))
      .child(svg(icon).size(16).text_color(fn ? t.foreground : t.muted));
    const base = this.data?.base ?? "HEAD";
    return h_flex().h(32).flex_none().px(6).gap(2).items_center().border_b_1().border_color(t.border)
      .child(btn("new", I("folder-new"), `새 워크트리 (${base}에서 새 브랜치)`, false, ok && (() => this.newWorktree())))
      // gh가 없거나 GitHub 레포가 아니면 숨긴다.
      .when(Boolean(issues), (el) => el.child(btn("issue", W("issue"), this.mode === "issues" ? "이슈 목록 보는 중 · 누르면 닫기" : "이슈에서 시작", this.mode === "issues", (cx) => this.showIssues(cx))))
      .child(div().flex_1())
      .child(btn("refresh", I("refresh"), "다시 읽기", false, ok && ((cx) => { this.reload(cx); if (this.mode === "issues") this.loadIssues(cx); })));
  }

  // 목록 오른쪽 상태 낱말: 가장 급한 에이전트 상태(여럿이면 수도).
  agentWord(list, t) {
    if (!list?.length) return null;
    const top = list.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
    const st = STATUS[top.status] ? top.status : "idle";
    return div().flex_none().text_size(11).text_color(t[st] ?? t.muted).child(list.length > 1 ? `${STATUS[st]} · ${list.length}` : STATUS[st]);
  }

  row(w, byWt, t) {
    const name = w.branch ?? (w.bare ? "bare" : `분리된 HEAD ${w.head?.slice(0, 7) ?? ""}`);
    const bits = [w.main ? "메인" : leaf(w.path)];
    if (w.prunable) bits.push("폴더 없음");
    if (w.locked) bits.push("잠김");
    const v = w.vs && !(w.branch && w.branch === this.data.base) ? [w.vs.ahead && `↑${w.vs.ahead}`, w.vs.behind && `↓${w.vs.behind}`].filter(Boolean).join(" ") : "";
    if (v) bits.push(v);
    if (w.files.length) bits.push(`변경 ${w.files.length}`);
    return v_flex().id(`wt-row-${w.path}`).h(42).flex_none().px(8).justify_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(this.sel === w.path, (el) => el.bg(t.selected))
      .on_click((e, cx) => { this.sel = w.path; this.mode = "list"; if (e.click_count >= 2) this.goSpace(w.path); cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .child(svg(w.main ? I("branch") : W("worktree")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).when(w.main, (el) => el.font_semibold()).child(name))
        .child(this.agentWord(byWt.get(w.path), t)))
      .child(div().pl(20).truncate().text_size(11).text_color(t.muted).child(bits.join(" · ")));
  }

  list(cx, t) {
    this.sync(cx);
    const d = this.data, byWt = d ? this.agentsByWt() : new Map();
    return v_flex().flex_1().min_h(0)
      .child(this.toolbar(t))
      .child(v_flex().id("wt-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(4).gap(1)
        .when(Boolean(d), (el) => el.children(d.items.map((w) => this.row(w, byWt, t))))
        .when(!d, (el) => el.child(div().p(8).text_size(12).text_color(t.muted).child(this.emptyState().text))));
  }

  // ── 오른쪽 ──

  button(id, label, t, fn, danger = false) {
    return h_flex().id(id).h(26).px(10).items_center().rounded(6).border_1().border_color(t.border)
      .text_size(12).text_color(danger ? t.ansi1 : t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { fn(cx); cx.notify(); }).child(label);
  }

  heading(text, t) { return div().px(14).pt(12).pb(4).text_size(12).font_semibold().text_color(t.muted).child(text); }

  issuesView(t) {
    const is = this.issues, list = is?.list ?? [];
    const note = (s) => div().px(14).py(10).text_size(12).text_color(t.muted).child(s);
    const body = is?.error ? [note(`이슈를 읽지 못했습니다 · ${is.error}`)]
      : !is?.list ? [note("이슈를 읽는 중")]
      : !list.length ? [note("열린 이슈가 없습니다")]
      : list.map((i) => h_flex().id(`wt-issue-${i.number}`).min_h(30).px(14).py(5).gap(8).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover)).when(this.isel === i.number, (el) => el.bg(t.selected))
        .on_click((_e, cx) => { this.isel = i.number; this.pickIssue(i); cx.notify(); })
        .child(div().flex_none().w(44).text_size(12).text_color(t.muted).child(`#${i.number}`))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(i.title))
        .when((i.labels ?? []).length > 0, (el) => el.child(div().flex_none().max_w(160).truncate().text_size(11).text_color(t.muted)
          .child(i.labels.map((l) => l.name).join(", ")))));
    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(svg(W("issue")).size(16).flex_none().text_color(t.muted))
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child("이슈에서 시작"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child("고르면 브랜치 이름을 묻고 워크트리를 만든 뒤 Claude Code에 이슈를 넘깁니다"))
        .child(div().id("wt-issues-close").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.mode = "list"; cx.notify(); }).child("✕")))
      .child(v_flex().id("wt-issues").flex_1().min_h(0).overflow_y_scrollbar().py(4).children(body));
  }

  detail(cx, t) {
    if (this.mode === "issues" && this.data) return this.issuesView(t);
    const w = this.find();
    if (!w) return null;
    const d = this.data, on = this.ctx.on, mine = this.agentsByWt().get(w.path) ?? [];
    const space = spaceFor(w.path, this.paths(), on);
    const name = w.branch ?? (w.bare ? "bare" : `분리된 HEAD ${w.head?.slice(0, 7) ?? ""}`);
    const isBase = w.branch && w.branch === d.base;

    // 정보 줄: 이름표 + 값
    const info = (label, value, el) => h_flex().gap(10).items_start().text_size(12)
      .child(div().w(64).flex_none().text_color(t.muted).child(label))
      .child(el ?? div().flex_1().min_w(0).text_color(t.foreground).child(value));
    const vsText = isBase ? "기본 브랜치" : !d.base ? "기본 브랜치를 모릅니다" : !w.vs ? "—" : `${d.base} 대비 ${counts(w.vs.ahead, w.vs.behind) || "같음"}`;
    const state = [w.locked && `잠김 (${w.locked})`, w.prunable && `폴더 없음 (${w.prunable})`, w.error].filter(Boolean).join(" · ");

    // 터미널이 열린 에이전트가 있으면 "지우기"를 잠그고 먼저 끝내거나 재우게 한다(그 터미널로 가기).
    const live = !w.main && !w.bare ? liveIn(w.path, this.paths(), on) : [];
    const actions = h_flex().flex_wrap().gap(6).items_center()
      .when(!w.bare && !w.prunable, (el) => el.child(this.button("wt-launch", "여기서 에이전트 띄우기", t, (cx) => this.launch(w.path, null, cx))))
      .when(Boolean(space), (el) => el.child(this.button("wt-go", `${space.name} 스페이스로 가기`, t, () => showSpace(space.id))))
      .when(!w.main && !w.bare && !live.length, (el) => el.child(this.button("wt-remove", "지우기...", t, () => confirmRemove(this.removeCtx(w)), true)))
      .when(live.length > 0, (el) => el.child(h_flex().h(26).px(10).items_center().rounded(6).border_1().border_color(t.border)
        .text_size(12).text_color(t.dim).child("지우기")));
    const blocked = live.length > 0 && h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
        .child(`먼저 이 에이전트를 끝내거나 재우세요${live.length > 1 ? ` (${live.length}개)` : ""}`))
      .child(this.button("wt-live-go", "그 터미널로 가기", t, () => showPane(live[0])));

    const agentRows = mine.map((a) => {
      const st = STATUS[a.status] ? a.status : "idle";
      return h_flex().id(`wt-a-${a.address}`).h(26).px(14).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => showAgent(a))
        .child(div().flex_none().w(64).text_size(12).text_color(t[st] ?? t.muted).child(STATUS[st]))
        .child(div().flex_none().text_size(12).text_color(t.foreground).child(a.program?.name ?? a.app ?? "에이전트"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(a.title ?? ""));
    });

    const files = w.files.slice(0, FILES_MAX).map((f, i) => {
      const gone = f.code.includes("D"), word = statusWord(f.code);
      return h_flex().id(`wt-f-${i}`).h(24).px(14).gap(8).items_center()
        .when(!gone, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => openViewer(`${w.path}/${f.path}`, on)))
        .child(div().flex_none().w(64).text_size(11).text_color(f.code.includes("U") ? t.ansi1 : t.muted).child(word))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(gone ? t.muted : t.foreground)
          .child(f.from ? `${f.from} → ${f.path}` : f.path));
    });

    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(svg(w.main ? I("branch") : W("worktree")).size(16).flex_none().text_color(t.muted))
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(w.main ? "메인 워크트리" : "워크트리")))
      .child(v_flex().flex_none().px(14).py(10).gap(6).border_b_1().border_color(t.border)
        .child(info("경로", null, div().id("wt-d-path").flex_1().min_w(0).truncate().text_color(t.foreground)
          .when(!on && !w.prunable, (el) => el.cursor_pointer().hover((s) => s.underline()).on_click(() => exec("open", [w.path])))
          .child(tilde(w.path))))
        .child(info("브랜치", w.branch ?? (w.detached ? "없음 (분리된 HEAD)" : "—")))
        .child(info("비교", vsText))
        .when(Boolean(state), (el) => el.child(info("상태", state)))
        .child(div().pt(4).child(actions))
        .when(Boolean(blocked), (el) => el.child(blocked)))
      .child(v_flex().id("wt-d-body").flex_1().min_h(0).overflow_y_scrollbar().pb(10)
        .child(this.heading(mine.length ? `에이전트 ${mine.length}` : "에이전트 없음", t))
        .children(agentRows)
        .child(this.heading(w.files.length ? `변경 ${w.files.length}` : "변경 없음", t))
        .children(files)
        .when(w.files.length > FILES_MAX, (el) => el.child(div().px(14).py(4).text_size(12).text_color(t.muted).child(`외 ${w.files.length - FILES_MAX}개`))));
  }
}

// 상태를 보고하지 않는 에이전트(agents()에 없음)도 갈 수 있게 칸으로 간다.
function showPane(x) {
  if (x.space) showSpace(x.space);
  if (x.tab) run("tab.select", { id: x.tab });
  run("pane.focus", { pane: x.pane });
}

// 에이전트 줄을 누르면 그 터미널로(agent.js goTo와 같게).
function showAgent(a) {
  if (a.space) showSpace(a.space);
  run("agent.focus", { terminal: a.address });
}

// 확인 창(menu.js Confirm)과 오버레이 역할 표(files.js ROLES)에 이 앱의 것을 더한다. 키는 모두 worktrees로 시작한다.
function register() {
  for (const [k, f] of Object.entries(ACT)) ACTIONS[`worktrees.${k}`] = f;
  ROLES["worktrees-prompt"] = WorktreePrompt;
}
register();
