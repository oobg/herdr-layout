// office-apps의 배포 앱: 지금 고른 스페이스(포커스된 패인)의 저장소 GitHub Actions 실행을 gh CLI로 지켜본다.
//   왼쪽: 필터(전체 · 지금 브랜치 · 실패만 · 진행 중, 조용한 글자 탭) + 최근 30개 실행 목록.
//         줄 = 상태 기호·제목(커밋 메시지 첫 줄)·상대 시각 / 상태 낱말·워크플로·브랜치·걸린 시간.
//   오른쪽: 고른 실행 하나. 머리줄(상태 · 워크플로 · 브라우저), 제목·브랜치·이벤트·커밋, 동작(다시 실행 · 실행 멈추기 · 끝나면 알림 ·
//          에이전트에게 알리기), 잡 목록(도는·실패한 잡은 단계까지 펼침, 지금 도는 단계 강조), 실패 로그(끝 80줄), 배포 환경.
//          실패 잡이 여럿이면 실패 로그 위에 잡 이름을 골라 그 잡의 로그를 본다(잡마다 gh run view --job, 최대 JOB_LOGS개).
//          "에이전트에게 실패 알리기"는 고른 잡의 로그 20줄을 보내고, 여럿이면 "잡 n개 실패"와 잡마다 첫 오류 줄을 앞에 붙인다.
// 순수 함수(상태 매핑·걸린 시간·로그 자르기·필터·핀)는 actions/run.js(node로 시험할 수 있다).
// 다시 실행·실행 멈추기(gh run cancel)는 menu.js의 확인 창(confirm)을 거친다(창 닫기 "취소"와 헷갈리지 않게 "멈추기"로 쓴다). 확인 창은 ACTIONS[이름](ctx)만 부르므로
// 이 모듈이 불릴 때 actions.* 동작을 더한다(pr.js와 같은 방식). 동작이 끝나면 TICK을 바꿔 앱이 다시 읽게 한다.
// 에이전트에게 실패 알리기는 send.js(공용): 지금 스페이스의 에이전트 중 고른 하나에게, 상태 규칙·확인 창도 거기서.
// 갱신: 이 앱이 그려지는 동안만(에이전트 앱과 같은 방식: 알렸는데 그려지지 않았으면 멈추고, 다시 그려지면 깨운다).
//   도는 실행이 있으면 10초, 없으면 60초. 한 번에 목록 하나 + 고른 실행 하나만 gh로 읽는다.
//   로그는 끝난 실행에서 한 번만(실행 id·시도 번호로 기억), 배포는 1분(없으면 10분)에 한 번.
// 지켜보기 핀: 도는 실행에 "끝나면 알림"을 켜면 앱이 보이지 않아도 그 실행만 30초마다 확인하고, 끝나면 notify 후 핀을 푼다.
//   핀은 localStorage(최대 3개). 앱 인스턴스가 있어야 돌므로 Herdr를 다시 켠 뒤에는 앱을 한 번 열어야 이어서 지켜본다.
// 셸 계약: list · detail · subtitle · dispose · move(↑↓) · activate(Enter = 브라우저) · emptyState.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, openOverlay, notify, shared, setShared } from "herdr";
import { ACTIONS } from "./menu.js";
import { failHint } from "./pr/status.js";
import { candidates, chosen, recipients, sendToAgent, nextRecipient } from "./send.js";
import {
  FILTERS, state, active, elapsed, dur, ago, runTime, jobTime, filterRuns, tailLog, failSpot, failJobs, firstError, tellText, latestDeploys, addPin, dropPin, MAX_PINS,
} from "./actions/run.js";

const ME = "mods/office-apps";
const SPINNER = "mods/workspace-chrome/spinner.svg";
const TICK = "office-apps.actions.tick";
const LIMIT = 30;
const FAST = 10000, SLOW = 60000, PIN_EVERY = 30000;
const DEPLOY_EVERY = 60000, DEPLOY_NONE = 600000;
const LOG_LINES = 80, TELL_LINES = 20, JOB_LOGS = 6;
const CODE_FONT = "D2Coding";
const LIST_FIELDS = "databaseId,displayTitle,workflowName,headBranch,event,status,conclusion,createdAt,updatedAt,startedAt,url,headSha,attempt";
const VIEW_FIELDS = "databaseId,displayTitle,workflowName,headBranch,event,status,conclusion,createdAt,updatedAt,startedAt,url,headSha,attempt,jobs";
const PIN_FIELDS = "databaseId,displayTitle,workflowName,status,conclusion,createdAt,updatedAt,startedAt,url";
const DEPLOY_QUERY = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){deployments(last:5,orderBy:{field:CREATED_AT,direction:ASC})"
  + "{nodes{environment state createdAt updatedAt ref{name} commitOid latestStatus{state createdAt environmentUrl logUrl}}}}}";

// 상태 종류 → 테마 색 이름(낱말·기호와 함께 쓴다. 색만으로 구분하지 않는다)
const TONE = { working: "working", done: "done", fail: "ansi1", cancel: "muted", skip: "muted", wait: "muted", action: "blocked" };
const tone = (kind, t) => t[TONE[kind] ?? "muted"];

const firstLine = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 200);
function load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 */ } }

// ── 확인 창이 부르는 동작. ctx는 값만: { id, root, on, name }

async function gh(ctx, args, done, failed) {
  let r;
  try { r = await exec("gh", args, { cwd: ctx.root, on: ctx.on, timeout: 60000 }); }
  catch (e) { r = { code: -1, stdout: "", stderr: String(e?.message ?? e) }; }
  if (r.code === 0) notify({ title: done, body: ctx.name, level: "info" });
  else {
    const raw = (r.stderr || r.stdout || "").trim(), hint = failHint(raw);
    notify({ title: `${ctx.name} ${failed} 못했습니다`, body: (hint ? `${hint}\n${raw}` : raw).slice(0, 400), level: "error" });
  }
  setShared(TICK, Date.now());
  return r.code === 0;
}

ACTIONS["actions.rerun"] = (ctx) => gh(ctx, ["run", "rerun", String(ctx.id), "--failed"], "실패한 잡을 다시 실행합니다", "다시 실행하지");
ACTIONS["actions.cancel"] = (ctx) => gh(ctx, ["run", "cancel", String(ctx.id)], "실행을 멈췄습니다", "멈추지");
const confirm = (action, title, detail, ctx, opts = {}) =>
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: { role: "confirm", action, title, detail, ctx, ...opts } });

// ── 도우미

// 파일 앱과 같은 기준: 포커스된 패인의 폴더(없으면 스페이스 폴더)와 그 머신.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id ?? null };
}
const key = () => { const { cwd, on } = location(); return JSON.stringify({ cwd, on }); };

async function sh(cmd, args, where, timeout = 30000) {
  try { return await exec(cmd, args, { cwd: where.cwd, on: where.on, timeout }); }
  catch (e) { return { code: -1, stdout: "", stderr: String(e?.message ?? e), rejected: true }; }
}

// 오른쪽 빈 화면에 보일 안내 { text, sub }를 담은 오류
function fail(text, sub = "") { const e = new Error(text); e.sub = sub; return e; }

// gh 실패를 짧은 안내로. "설치 안 됨"은 code 127·"command not found"이거나, 실행이 거절됐을 때 command -v gh로 확인해 없을 때만.
//   (기기 연결 끊김·폴더 없음·시간 초과도 실행 거절로 오므로 거절만으로 설치 안 됨이라 하지 않는다.)
async function ghError(r, where) {
  const s = (r.stderr || r.stdout || "").trim();
  if (r.code === 127 || /command not found/i.test(s)) return fail("gh가 설치되어 있지 않습니다", "터미널에서 brew install gh");
  if (r.rejected) {
    const probe = await sh("sh", ["-c", "command -v gh"], where, 10000);
    if (!probe.rejected && probe.code !== 0) return fail("gh가 설치되어 있지 않습니다", "터미널에서 brew install gh");
    return fail("gh를 실행하지 못했습니다", firstLine(s));
  }
  if (/gh auth login|HTTP 401|not logged|authentication required/i.test(s)) return fail("gh 로그인이 필요합니다", "터미널에서 gh auth login");
  if (/no git remotes|none of the git remotes|not a git repository|unable to determine|could not determine|HTTP 404|Could not resolve to a Repository/i.test(s))
    return fail("GitHub 저장소가 아닙니다", "원격이 GitHub 저장소를 가리켜야 실행 기록을 볼 수 있습니다");
  return fail(firstLine(s).slice(0, 160) || "gh 명령이 실패했습니다");
}

// 실패 로그: 출력이 클 수 있어 그 기기에서 끝 1,500줄만 받는다(gh의 종료 코드는 그대로).
const LOG_SCRIPT = `f=$(mktemp "\${TMPDIR:-/tmp}/herdr-actions.XXXXXX") || exit 97
gh run view "$@" --log-failed >"$f" 2>"$f.err"; c=$?
if [ "$c" -eq 0 ]; then tail -n 1500 "$f"; else cat "$f.err" >&2; fi
rm -f "$f" "$f.err"; exit $c`;

export class ActionsApp {
  init(_p, cx) {
    this.filter = FILTERS.some((f) => f.id === load("actions.filter", "")) ? load("actions.filter", "") : "all";
    this.pins = load("actions.pins", []);
    this.tick = shared(TICK);
    this.context = null;
    this.logs = new Map();     // "id:attempt:잡 id" → { loading } | { log, spot } | { error }
    this.deploys = null;       // { repo, at, list }
    this.timer = null; this.busy = false; this.again = false;
    this.rendered = 0; this.notified = 0;
    this.reset(location());
    // 핀 확인은 보이지 않아도 돈다(핀이 없으면 아무것도 하지 않는다).
    this.watch = cx.timer.every(PIN_EVERY, (cx) => { if (!this.disposed) this.checkPins(cx); });
    if (this.pins.length) this.checkPins(cx);
  }

  dispose() {
    this.disposed = true;
    this.timer?.cancel(); this.timer = null;
    this.watch?.cancel(); this.watch = null;
  }

  // 위치가 바뀌면 저장소부터 다시
  reset({ cwd, on }) {
    this.context = { key: JSON.stringify({ cwd, on }), cwd, on };
    this.root = null; this.on = on; this.repo = null; this.branch = null;
    this.runs = null; this.error = null; this.closed = false;
    this.pick(null);
  }

  current(context) { return this.context === context && key() === context.key; }

  // ── 갱신(보이는 동안만)

  interval() { return (this.runs ?? []).some(active) || active(this.view ?? { status: "completed" }) ? FAST : SLOW; }

  // 렌더마다: 위치 바뀜·동작 완료 확인, 멈춰 있던 타이머를 깨운다.
  ensure(cx) {
    this.rendered = Date.now();
    if (key() !== this.context?.key) { this.reset(location()); this.kick(cx); return; }
    if (shared(TICK) !== this.tick) { this.tick = shared(TICK); this.kick(cx); return; }
    if (!this.timer && !this.busy) this.loop(cx, 0);
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
      if (this.disposed) return;
      // 지난번 알렸는데 그려지지 않았다: 안 보이는 중이니 멈춘다(다시 그려지면 ensure가 깨운다)
      if (this.notified > this.rendered) return;
      this.busy = true;
      cx.spawn(async (cx) => {
        try { await this.refresh(cx); } catch { /* 다음 차례에 다시 */ }
        this.busy = false;
        const again = this.again; this.again = false;
        this.notified = Date.now(); cx.notify();
        this.loop(cx, again ? 0 : this.interval());
      });
    });
  }

  async refresh(cx) {
    const context = this.context, { cwd, on } = context;
    if (!cwd) { this.error = fail("폴더가 없습니다", "스페이스나 패인에 폴더를 정하면 그 저장소의 실행 기록을 봅니다"); return; }
    try {
      if (!this.root) {
        const top = await sh("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) throw top.rejected ? fail("폴더를 읽지 못했습니다", firstLine(top.stderr)) : fail("git 저장소가 아닙니다", "실행 기록은 GitHub 저장소 폴더에서 볼 수 있습니다");
        const root = top.stdout.trim();
        const remote = await sh("git", ["remote"], { cwd: root, on });
        if (!remote.stdout.trim()) throw fail("원격 저장소가 없습니다", "GitHub 원격을 추가하면 실행 기록을 볼 수 있습니다");
        const repo = await sh("gh", ["repo", "view", "--json", "nameWithOwner,url"], { cwd: root, on });
        if (repo.code !== 0) throw await ghError(repo, { cwd: root, on });
        if (!this.current(context)) return;
        this.root = root; this.repo = JSON.parse(repo.stdout);
      }
      const where = { cwd: this.root, on };
      const br = await sh("git", ["branch", "--show-current"], where);
      const r = await sh("gh", ["run", "list", "--limit", String(LIMIT), "--json", LIST_FIELDS], where);
      if (r.code !== 0) throw await ghError(r, where);
      if (!this.current(context)) return;
      this.branch = br.code === 0 ? br.stdout.trim() || null : null;
      this.runs = JSON.parse(r.stdout); this.error = null;
      // 보이는 동안 목록에서 끝난 것이 보이면 핀을 바로 푼다.
      for (const p of [...this.pins]) {
        const run = this.runs.find((x) => x.databaseId === p.id);
        if (run && !active(run)) this.finishPin(p, run);
      }
      // 처음 열 때(또는 필터를 바꾼 뒤) 맨 위 실행을 보여 준다.
      const first = this.shown()[0];
      if (!this.sel && !this.closed && first) this.pick(first.databaseId);
      if (this.sel) await this.loadDetail(this.sel, cx, false);
      await this.loadDeploys(context);
    } catch (e) {
      if (this.current(context)) { this.error = e?.sub !== undefined ? e : fail(String(e?.message ?? e).slice(0, 160)); this.runs = null; }
    }
  }

  // 고른 실행의 상세. 끝난 실행이고 목록의 갱신 시각이 그대로면 다시 읽지 않는다(force: 고른 직후).
  async loadDetail(id, cx, force = true) {
    if (!this.root) return;
    const context = this.context, row = this.rowFor(id);
    const v = this.view?.databaseId === id ? this.view : null;
    if (!force && v && !active(v) && row && row.updatedAt === v.updatedAt) { this.loadLog(v, cx); return; }
    const r = await sh("gh", ["run", "view", String(id), "--json", VIEW_FIELDS], { cwd: this.root, on: this.on });
    if (!this.current(context) || this.sel !== id) return;
    if (r.code !== 0) { this.viewError = (await ghError(r, { cwd: this.root, on: this.on })).message; }
    else {
      try { this.view = JSON.parse(r.stdout); this.viewError = null; } catch { this.viewError = "실행 정보를 읽지 못했습니다"; }
    }
    if (this.view?.databaseId === id) this.loadLog(this.view, cx);
  }

  // 실패 잡 목록(잡 id를 모르면 실행 하나로)과 고른 잡
  failed(v) { const js = failJobs(v); return js.some((j) => j.jobId) ? js.filter((j) => j.jobId).slice(0, JOB_LOGS) : js.slice(0, 1).map((j) => ({ ...j, jobId: null })); }
  spotOf(v) { const js = this.failed(v); return js.find((j) => j.jobId === this.failJob) ?? js[0] ?? null; }
  logKey(v, j) { return `${v.databaseId}:${v.attempt ?? 1}:${j?.jobId ?? "run"}`; }

  // 실패 로그: 끝난 실행의 실패 잡마다 한 번만(실행 id·시도 번호·잡 id로 기억). 도는 중이면 gh가 로그를 주지 않는다.
  //   잡이 여럿이면 다 읽어 둔다(에이전트에게 보낼 때 잡마다 첫 오류 줄을 붙인다).
  loadLog(v, cx) {
    if (active(v)) return;
    for (const spot of this.failed(v)) this.loadJobLog(v, spot, cx);
  }

  loadJobLog(v, spot, cx) {
    const k = this.logKey(v, spot);
    if (this.logs.has(k)) return;
    const entry = { loading: true, spot };
    this.logs.set(k, entry);
    const where = { cwd: this.root, on: this.on };
    const args = spot.jobId ? ["--job", String(spot.jobId)] : [String(v.databaseId)];
    cx.spawn(async (cx) => {
      const r = await sh("sh", ["-c", LOG_SCRIPT, "actions", ...args], where, 90000);
      entry.loading = false;
      if (r.code === 0) entry.log = tailLog(r.stdout, LOG_LINES, spot.job);
      else {
        entry.error = /log not found|expired|410/i.test(r.stderr) ? "로그가 없습니다(지났거나 지워졌습니다)" : `로그를 읽지 못했습니다 · ${firstLine(r.stderr)}`;
        // 잠깐의 실패(네트워크 등)는 기억하지 않아 다음에 다시 시도한다.
        if (r.rejected) this.logs.delete(k);
      }
      cx.notify();
    });
  }

  // 배포 환경: 저장소마다 GraphQL 한 번(REST는 상태를 얻으려면 배포마다 한 번 더 불러야 한다).
  async loadDeploys(context) {
    const repo = this.repo?.nameWithOwner;
    if (!repo) return;
    const d = this.deploys;
    if (d?.repo === repo && Date.now() - d.at < (d.list.length ? DEPLOY_EVERY : DEPLOY_NONE)) return;
    const [owner, name] = repo.split("/");
    const r = await sh("gh", ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${DEPLOY_QUERY}`], { cwd: this.root, on: this.on });
    if (!this.current(context)) return;
    let list = [];
    if (r.code === 0) { try { list = latestDeploys(JSON.parse(r.stdout)?.data?.repository?.deployments?.nodes); } catch { list = []; } }
    this.deploys = { repo, at: Date.now(), list };
  }

  // ── 핀(끝나면 알림)

  pinned(id) { return this.pins.some((p) => p.id === id); }

  togglePin(v) {
    if (this.pinned(v.databaseId)) { this.pins = dropPin(this.pins, v.databaseId); save("actions.pins", this.pins); return; }
    const { pins, full } = addPin(this.pins, { id: v.databaseId, root: this.root, on: this.on, repo: this.repo?.nameWithOwner ?? "",
      workflow: v.workflowName, title: v.displayTitle, at: Date.now() });
    if (full) { notify({ title: `끝나면 알림은 ${MAX_PINS}개까지입니다`, body: "다른 실행의 알림을 끄고 다시 켜세요", level: "warning" }); return; }
    this.pins = pins; save("actions.pins", pins);
  }

  finishPin(p, run) {
    if (!this.pinned(p.id)) return;
    this.pins = dropPin(this.pins, p.id); save("actions.pins", this.pins);
    const st = state(run), took = dur(elapsed(run.startedAt ?? run.createdAt, run.updatedAt));
    notify({
      title: `${run.workflowName ?? p.workflow} ${st.word}`,
      body: [run.displayTitle ?? p.title, took ? `걸린 시간 ${took}` : "", p.repo].filter(Boolean).join(" · "),
      level: st.kind === "done" ? "success" : st.kind === "fail" ? "error" : "info",
    });
  }

  // 핀마다 gh run view 한 번(잡은 읽지 않는다). 위치와 상관없이 핀을 건 저장소 폴더에서.
  checkPins(cx) {
    if (this.pinBusy || !this.pins.length) return;
    this.pinBusy = true;
    cx.spawn(async (cx) => {
      let changed = false;
      for (const p of [...this.pins]) {
        const r = await sh("gh", ["run", "view", String(p.id), "--json", PIN_FIELDS], { cwd: p.root, on: p.on });
        if (r.code === 0) {
          try { const run = JSON.parse(r.stdout); if (!active(run)) { this.finishPin(p, run); changed = true; } } catch { /* 다음 차례에 */ }
        } else if (/not found|Could not resolve/i.test(r.stderr) && !r.rejected) {
          this.pins = dropPin(this.pins, p.id); save("actions.pins", this.pins); changed = true;
        }
      }
      this.pinBusy = false;
      if (changed) cx.notify();
    });
  }

  // ── 목록·선택

  shown() { return filterRuns(this.runs, this.filter, this.branch); }
  rowFor(id) { return (this.runs ?? []).find((r) => r.databaseId === id) ?? null; }

  pick(id) {
    this.sel = id;
    if (this.view?.databaseId !== id) { this.view = null; this.viewError = null; }
    this.openJobs = {};
    this.failJob = null;       // 실패 로그를 볼 잡 id(null = 첫 실패 잡)
  }

  select(id, cx) {
    this.closed = false;
    if (this.sel === id) return;
    this.pick(id);
    const context = this.context;
    cx.spawn(async (cx) => { await this.loadDetail(id, cx, true); if (this.context === context) cx.notify(); });
  }

  setFilter(id, cx) {
    if (this.filter === id) return;
    this.filter = id; save("actions.filter", id);
    const list = this.shown();
    if (list.length && !list.some((r) => r.databaseId === this.sel)) this.select(list[0].databaseId, cx);
    cx.notify();
  }

  move(delta, cx) {
    const list = this.shown();
    if (!list.length) return;
    const i = list.findIndex((r) => r.databaseId === this.sel);
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + delta));
    this.select(list[next].databaseId, cx);
  }

  // Enter: 고른 실행을 브라우저로(PR 앱과 같게)
  activate(_cx) {
    const r = this.view?.databaseId === this.sel ? this.view : this.rowFor(this.sel);
    if (r?.url) exec("open", [r.url]);
  }

  emptyState() {
    if (this.error) return { text: this.error.message, sub: this.error.sub ?? "" };
    if (!this.runs) return { text: "실행 기록을 읽는 중", sub: this.repo?.nameWithOwner ?? "" };
    if (!this.runs.length) return { text: "GitHub Actions 실행 기록이 없습니다", sub: ".github/workflows에 워크플로를 두면 여기에 보입니다" };
    if (!this.shown().length) {
      const f = FILTERS.find((x) => x.id === this.filter);
      return { text: this.filter === "branch" && !this.branch ? "지금 브랜치를 알 수 없습니다" : f.empty, sub: `최근 ${LIMIT}개 실행 안에서 찾았습니다` };
    }
    return { text: "선택 내용이 없습니다", sub: "왼쪽에서 실행을 고르세요" };
  }

  subtitle(t) {
    if (!this.repo) return null;
    return div().id("act-repo").truncate().text_size(12).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", [`${this.repo.url}/actions`]))
      .child(this.repo.nameWithOwner);
  }

  // 상태 기호: 진행 중은 도는 스피너, 나머지는 글자 기호
  mark(kind, sym, t, size = 12) {
    if (kind === "working") return svg(SPINNER).size(size).flex_none().text_color(t.working).spin(900);
    return div().w(size).flex_none().text_size(size).text_color(tone(kind, t)).child(sym);
  }

  // ── 왼쪽

  toolbar(t) {
    const tab = (f) => div().id(`act-f-${f.id}`).px(5).py(3).flex_none().cursor_pointer().text_size(12)
      .text_color(this.filter === f.id ? t.foreground : t.muted).when(this.filter === f.id, (el) => el.font_semibold())
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.setFilter(f.id, cx))
      .child(f.name);
    return h_flex().flex_none().min_h(32).py(2).px(4).items_center().border_b_1().border_color(t.border)
      .children(FILTERS.map(tab))
      .child(div().flex_1())
      .child(div().id("act-refresh").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.deploys = null; this.kick(cx); cx.notify(); })
        .child(svg(`${ME}/refresh.svg`).size(14).text_color(this.busy ? t.dim : t.muted)));
  }

  row(r, t) {
    const st = state(r), on = this.sel === r.databaseId, took = dur(runTime(r));
    const meta = [r.workflowName, this.filter === "branch" ? null : r.headBranch, took].filter(Boolean).join(" · ");
    return v_flex().id(`act-row-${r.databaseId}`).flex_none().px(8).py(6).gap(2).rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(on, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.select(r.databaseId, cx); cx.notify(); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(this.mark(st.kind, st.sym, t))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(r.displayTitle || r.workflowName))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(r.createdAt))))
      .child(h_flex().gap(5).items_center().min_w(0).pl(18)
        .child(div().flex_none().text_size(11).text_color(tone(st.kind, t)).child(st.word))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta))
        .when(this.pinned(r.databaseId), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child("알림 켬"))));
  }

  list(cx, t) {
    this.ensure(cx);
    const note = (text) => div().p(8).text_size(12).text_color(t.dim).child(text);
    const shown = this.shown();
    let body;
    if (this.error) body = [note(this.error.message)];
    else if (!this.runs) body = [note("실행 기록을 읽는 중")];
    else if (!this.runs.length) body = [note("실행 기록이 없습니다")];
    else if (!shown.length) body = [note(this.filter === "branch" && !this.branch ? "지금 브랜치를 알 수 없습니다" : FILTERS.find((f) => f.id === this.filter).empty)];
    else body = shown.map((r) => this.row(r, t));
    const tail = this.runs?.length === LIMIT ? [div().p(8).text_size(11).text_color(t.dim).child(`최근 ${LIMIT}개 실행만 봅니다`)] : [];
    return v_flex().flex_1().min_h(0)
      .child(this.toolbar(t))
      .child(v_flex().id("act-list").flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1).children(body).children(tail));
  }

  // ── 오른쪽

  // 런처 키 계약: 지난 그리기에서 모은 멈출 곳(다시 실행·끝나면 알림·실행 멈추기·실패 알리기·보낼 곳).
  focusables() { return this.stops ?? []; }

  detail(cx, t) {
    this.stops = [];
    if (!this.sel || this.error || !this.runs) return null;
    const v = this.view?.databaseId === this.sel ? this.view : null, row = this.rowFor(this.sel);
    const base = v ?? row;
    if (!base) return null;
    const st = state(base);
    const head = h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
      .child(this.mark(st.kind, st.sym, t, 13))
      .child(div().flex_none().text_size(12).font_semibold().text_color(tone(st.kind, t)).child(st.word))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(base.workflowName ?? ""))
      .child(div().id("act-web").flex_none().p(4).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => exec("open", [base.url]))
        .child(svg(`${ME}/open.svg`).size(15).text_color(t.muted)));
    const root = v_flex().id("act-detail").size_full().min_h(0).child(head);
    const body = v_flex().id(`act-body-${this.sel}`).flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(16)
      .child(this.summary(base, v, t))
      .child(this.buttons(base, v, t));
    if (!v) return root.child(body.child(div().text_size(12).text_color(t.dim).child(this.viewError ?? "잡을 읽는 중")));
    return root.child(body
      .child(this.jobs(v, t))
      .children(this.logView(v, t))
      .children(this.deployView(v, t)));
  }

  // 제목(커밋 메시지 첫 줄) / 브랜치 · 이벤트 · 커밋 · 시작 · 걸린 시간
  summary(base, v, t) {
    const took = v ? jobTime(v.jobs) ?? runTime(v) : runTime(base);
    const going = active(base);
    const parts = [base.headBranch, base.event, (base.headSha ?? "").slice(0, 7), ago(base.startedAt ?? base.createdAt),
      took !== null ? (going ? `${dur(took)}째` : `걸린 시간 ${dur(took)}`) : null,
      (base.attempt ?? 1) > 1 ? `${base.attempt}번째 시도` : null].filter(Boolean);
    return v_flex().gap(4)
      .child(div().text_size(14).text_color(t.foreground).child(firstLine(base.displayTitle)))
      .child(div().text_size(12).text_color(t.muted).child(parts.join(" · ")));
  }

  // 동작: 쓸 일이 없는 것은 숨긴다.
  buttons(base, v, t) {
    const ctx = { id: base.databaseId, root: this.root, on: this.on, name: `${base.workflowName} · ${firstLine(base.displayTitle).slice(0, 60)}` };
    const going = active(base), spot = v ? failSpot(v) : null, failed = state(base).kind === "fail";
    // 그리면서 런처 키 계약의 멈출 곳으로 모은다(run = on_click과 같은 함수). 키보드 커서가 있으면 테두리 t.accent.
    const btn = (id, text, color, fn, on = false) => {
      const press = (cx) => { fn(cx); cx.notify(); };
      this.stops.push({ id, kind: "button", run: press });
      return div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(this.kb?.on?.(id) ? t.accent : t.border)
        .text_size(12).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover)).when(on, (el) => el.bg(t.selected))
        .on_click((_e, cx) => press(cx)).child(text);
    };
    const out = [];
    if (!going && (failed || spot)) out.push(btn("act-rerun", "다시 실행", t.foreground, () => confirm("actions.rerun", "실패한 잡 다시 실행",
      `${ctx.name}\n실패한 잡${spot ? `(${spot.job}${spot.more ? ` 외 ${spot.more}개` : ""})` : ""}만 다시 실행합니다.`, ctx, { yes: "실패한 잡 다시 실행" })));
    if (going) {
      out.push(btn("act-pin", this.pinned(base.databaseId) ? "✓ 끝나면 알림" : "끝나면 알림", this.pinned(base.databaseId) ? t.foreground : t.muted,
        () => this.togglePin(v ?? base), this.pinned(base.databaseId)));
      out.push(btn("act-cancel", "실행 멈추기", t.ansi1, () => confirm("actions.cancel", "CI 실행 멈출까요?",
        `${ctx.name}\n도는 잡을 멈춥니다. 다시 돌리려면 처음부터 다시 실행해야 합니다.`, ctx, { yes: "실행 멈추기", no: "닫기", danger: true })));
    }
    let pick = null;
    if (!going && spot) {
      const list = candidates({ space: location().space }), to = chosen(list, this.tellTo);
      if (to) out.push(btn("act-tell", "에이전트에게 실패 알리기", t.foreground, () => this.tell(v, to)));
      const nx = nextRecipient(list, to?.address);
      if (nx) this.stops.push({ id: "act-to", kind: "button", run: () => { this.tellTo = nx.address; } });
      pick = recipients("act", list, to?.address, (address) => { this.tellTo = address; }, t, undefined, nx ? Boolean(this.kb?.on?.("act-to")) : undefined);
    }
    const row = h_flex().flex_wrap().gap(8).items_center().children(out);
    return pick ? v_flex().gap(8).child(row).child(pick) : row;
  }

  // 고른 잡의 로그 n줄. 실패 잡이 여럿이면 잡마다 첫 오류 줄(읽은 것만)을 앞에 붙인다.
  tell(v, a) {
    const spot = this.spotOf(v), entry = this.logs.get(this.logKey(v, spot));
    const all = failJobs(v);
    const jobs = all.length > 1 ? all.map((j) => ({ ...j, line: firstError(this.logs.get(this.logKey(v, j))?.log) })) : [];
    sendToAgent(a, tellText(v, entry?.log ?? null, TELL_LINES, { spot, jobs }));
  }

  // 잡 목록: 도는·실패한 잡은 단계까지 펼친다(누르면 접고 편다).
  jobs(v, t) {
    const list = v.jobs ?? [];
    if (!list.length) return div().text_size(12).text_color(t.dim).child(state(v).kind === "fail" ? "잡이 시작되기 전에 실패했습니다(워크플로 파일을 확인하세요)" : "잡 정보가 없습니다");
    return v_flex().gap(2).children(list.flatMap((j) => {
      const st = state(j), open = this.openJobs[j.databaseId] ?? (st.kind === "working" || st.kind === "fail");
      const took = elapsed(j.startedAt, active(j) ? null : j.completedAt);
      const right = st.kind === "done" ? dur(took) : st.kind === "working" ? `${st.word} ${dur(took)}째` : [st.word, dur(took)].filter(Boolean).join(" · ");
      const head = h_flex().id(`act-job-${j.databaseId}`).h(26).flex_none().px(4).gap(8).items_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.openJobs[j.databaseId] = !open; cx.notify(); })
        .child(svg(`${ME}/${open ? "chevron-down" : "chevron-right"}.svg`).size(12).flex_none().text_color(t.muted))
        .child(this.mark(st.kind, st.sym, t))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(j.name))
        .child(div().flex_none().text_size(11).text_color(st.kind === "done" ? t.dim : tone(st.kind, t)).child(right));
      return open ? [head, ...(j.steps ?? []).map((s) => this.step(j, s, t))] : [head];
    }));
  }

  step(j, s, t) {
    const st = state(s), now = st.kind === "working";
    const took = elapsed(s.startedAt, active(s) ? null : s.completedAt);
    const right = st.kind === "done" ? dur(took) : now ? `${st.word} ${dur(took)}째` : [st.word, st.kind === "fail" ? dur(took) : ""].filter(Boolean).join(" · ");
    return h_flex().h(22).flex_none().pl(28).pr(4).gap(8).items_center().rounded(4)
      .when(now, (el) => el.bg(t.selected))
      .child(this.mark(st.kind, st.sym, t, 11))
      .child(div().flex_1().min_w(0).truncate().text_size(12)
        .text_color(now || st.kind === "fail" ? t.foreground : st.kind === "done" ? t.muted : t.dim)
        .when(now || st.kind === "fail", (el) => el.font_semibold()).child(s.name))
      .child(div().flex_none().text_size(11).text_color(st.kind === "done" ? t.dim : tone(st.kind, t)).child(right));
  }

  // 실패 로그(끝 80줄, 오류 줄만 강조)
  logView(v, t) {
    const spot = this.spotOf(v), all = failJobs(v);
    if (!spot) return [];
    const head = (text) => div().text_size(12).font_semibold().text_color(t.muted).child(text);
    const title = all.length > 1 ? `실패 로그 · 잡 ${all.length}개 실패` : `실패 로그 · ${spot.job}`;
    if (active(v)) return [v_flex().gap(6).child(head(title)).child(div().text_size(12).text_color(t.dim).child("실행이 끝나면 로그를 읽습니다"))];
    // 실패 잡이 여럿이면 잡 이름을 골라 그 잡의 로그를 본다(키보드 멈출 곳)
    const js = this.failed(v);
    const pick = js.length > 1 ? h_flex().flex_wrap().gap(4).items_center().children(js.map((j) => {
      const id = `act-fj-${j.jobId}`, on = j.jobId === spot.jobId;
      const press = (cx) => { this.failJob = j.jobId; this.loadJobLog(v, j, cx); cx.notify(); };
      this.stops.push({ id, kind: "button", run: press });
      return div().id(id).flex_none().max_w(240).truncate().px(8).py(2).rounded(4).text_size(12).cursor_pointer()
        .border_1().border_color(this.kb?.on?.(id) ? t.accent : "#00000000")
        .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => press(cx)).child(j.job);
    })).when(all.length > js.length, (el) => el.child(div().text_size(11).text_color(t.dim).child(`외 ${all.length - js.length}개`))) : null;
    const e = this.logs.get(this.logKey(v, spot));
    let inner;
    if (!e || e.loading) inner = div().text_size(12).text_color(t.dim).child("로그를 읽는 중");
    else if (e.error) inner = div().text_size(12).text_color(t.dim).child(e.error);
    else if (!e.log?.lines.length) inner = div().text_size(12).text_color(t.dim).child("로그가 비어 있습니다");
    else inner = v_flex().px(10).py(8).rounded(6).border_1().border_color(t.border).font_family(CODE_FONT).text_size(11.5)
      .children(e.log.lines.map((l) => div().min_h(16).text_color(l.err ? t.ansi1 : l.group ? t.muted : t.foreground)
        .when(Boolean(l.hard), (el) => el.font_semibold()).child(l.text || " ")));
    const scope = all.length > 1 ? `보낼 때: 잡 ${all.length}개의 첫 오류 줄 + ${spot.job} 로그 ${TELL_LINES}줄` : `보낼 때: 오류 줄 근처 ${TELL_LINES}줄`;
    return [v_flex().gap(6).child(head(title)).when(Boolean(pick), (el) => el.child(pick)).child(inner)
      .child(div().text_size(11).text_color(t.dim).child(scope))];
  }

  // 배포 환경: 환경마다 최신 하나(없으면 그리지 않는다). 이 실행이 만든 배포면 "이 실행".
  deployView(v, t) {
    const list = this.deploys?.repo === this.repo?.nameWithOwner ? this.deploys.list : [];
    if (!list.length) return [];
    return [v_flex().gap(2)
      .child(div().pb(2).text_size(12).font_semibold().text_color(t.muted).child("배포"))
      .children(list.map((d, i) => h_flex().id(`act-dep-${i}`).h(24).flex_none().px(4).gap(8).items_center().rounded(4)
        .when(Boolean(d.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => exec("open", [d.url])))
        .child(this.mark(d.kind, d.sym, t))
        .child(div().flex_none().text_size(13).text_color(t.foreground).child(d.env))
        .child(div().flex_none().text_size(11).text_color(tone(d.kind, t)).child(d.word))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child([d.ref, ago(d.at)].filter(Boolean).join(" · ")))
        .when(d.run === String(v.databaseId), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child("이 실행")))))];
  }
}
