// office-apps의 PR 앱: 지금 고른 스페이스(포커스된 패인)의 저장소 PR을 gh CLI로 본다.
//   왼쪽: 상태 필터(열림·내 PR·리뷰 요청·닫힘) + 검색(제목·번호·작성자, 받아 둔 목록에서 거름) + PR 목록
//   오른쪽: 고른 PR 하나. 머리줄(상태 · #번호 · 제목 · ✕), 병합 가능 여부 한 줄과 주 동작(병합 또는 브라우저) · ⋯,
//          실패·대기 체크, 접힌 본문, 접힌 리뷰·코멘트, 바뀐 파일. 파일을 고르면 그 아래에 diff.
// diff는 gh pr diff 통 출력을 임시 파일로 받아(commit.js와 같은 방식) 파일별로 나눈다(pr/diff.js). 줄 파싱·번호는 commit/git.js,
// 줄 그리기·색·위아래/좌우 보기는 커밋 앱과 같은 commit/diffview.js.
// 병합·닫기·체크아웃은 menu.js의 확인 창(confirm 역할)을 거친다. 확인 창은 ACTIONS[이름](ctx)만 부르므로
// 이 모듈이 불릴 때 ACTIONS에 pr.* 동작을, files.js ROLES에 메뉴 역할(pr-menu)을 더한다(branch.js와 같은 방식).
// main.js가 이 파일을 늘 불러오므로 오버레이 복사본에서도 먼저 등록된다.
// 동작이 끝나면 PR_TICK을 바꿔 앱이 목록과 상세를 다시 읽게 한다.
// 셸 계약: list · detail · subtitle · dispose · move(↑↓) · activate(Enter) · emptyState(상세가 없을 때 안내).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, props, openOverlay, closeOverlay, notify, shared, setShared, settings } from "herdr";
import { Menu, ACTIONS, TICK, popupAt } from "./menu.js";
import { ROLES } from "./files.js";
import { BIG, diffLines, diffRows, columns } from "./commit/git.js";
import {
  DIFF_LINE, NARROW, inlineRow, splitRow, inlineWidth, splitWidth, diffPalette, wordSpans, splitRows, isDark, diffMode, modeToggle,
} from "./commit/diffview.js";
import { splitDiff } from "./pr/diff.js";

const ME = "mods/office-apps";
const PR_TICK = "office-apps.pr.tick";
const METHOD = "office-apps.pr.method";   // 마지막으로 고른 병합 방식(오버레이 복사본과 나누려고 공유 상태)
const LIMIT = 50;          // 목록에 가져올 PR 수
const POLL = 120000;       // 목록 자동 갱신 간격(네트워크 요청이라 느리게)
const BODY_LINES = 6;      // 접힌 본문에 보이는 줄 수
const CODE_FONT = "D2Coding";
const FILE_MAX = 1000000;  // 임시 파일로 받은 출력의 상한(readTextFile은 1MiB까지)

// 필터: 이름 · gh pr list 인자 · 비었을 때 안내
const FILTERS = [
  { id: "open", name: "열림", args: ["--state", "open"], empty: "열린 PR이 없습니다" },
  { id: "mine", name: "내 PR", args: ["--state", "open", "--author", "@me"], empty: "내가 연 PR이 없습니다" },
  { id: "review", name: "리뷰 요청", args: ["--state", "open", "--search", "review-requested:@me"], empty: "리뷰 요청이 없습니다" },
  { id: "closed", name: "닫힘", args: ["--state", "closed"], empty: "닫힌 PR이 없습니다" },
];
const LIST_FIELDS = "number,title,author,headRefName,baseRefName,headRefOid,url,state,isDraft,updatedAt";
const VIEW_FIELDS = "number,title,body,state,isDraft,author,headRefName,baseRefName,headRefOid,createdAt,updatedAt,mergedAt,closedAt,url,"
  + "mergeable,reviewDecision,additions,deletions,changedFiles,files,reviews,comments,statusCheckRollup";
// 병합 방식: gh 플래그 · 이름 · 메뉴 문구 · 저장소 설정 이름
const METHODS = [
  { flag: "--merge", name: "병합 커밋", by: "병합 커밋으로", allow: "mergeCommitAllowed" },
  { flag: "--squash", name: "스쿼시", by: "스쿼시로", allow: "squashMergeAllowed" },
  { flag: "--rebase", name: "리베이스", by: "리베이스로", allow: "rebaseMergeAllowed" },
];

// ── 확인 창이 부르는 동작. ctx는 값만: { number, root, on, flag?, head? }

async function gh(ctx, args, done) {
  let r;
  try { r = await exec("gh", args, { cwd: ctx.root, on: ctx.on, timeout: 120000 }); }
  catch (e) { r = { code: -1, stdout: "", stderr: String(e?.message ?? e) }; }
  if (r.code === 0) notify({ title: done, body: `#${ctx.number}`, level: "info" });
  else notify({ title: "실패했습니다", body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
  setShared(PR_TICK, Date.now());
  return r.code === 0;
}

// 병합은 확인 창을 띄운 때의 head 커밋에서만(--match-head-commit). head를 모르면 실행하지 않는다.
ACTIONS["pr.merge"] = (ctx) => {
  if (!ctx.head) { notify({ title: "병합하지 않았습니다", body: "PR의 head 커밋을 몰라 안전하게 병합할 수 없습니다. 다시 읽은 뒤 해 보세요.", level: "error" }); return false; }
  setShared(METHOD, ctx.flag);
  return gh(ctx, ["pr", "merge", String(ctx.number), ctx.flag, "--match-head-commit", ctx.head], "병합했습니다");
};
ACTIONS["pr.close"] = (ctx) => gh(ctx, ["pr", "close", String(ctx.number)], "PR을 닫았습니다");
ACTIONS["pr.checkout"] = async (ctx) => { await gh(ctx, ["pr", "checkout", String(ctx.number)], "체크아웃했습니다"); setShared(TICK, Date.now()); };

// opts: { yes: 실행 버튼 이름, danger: 되돌리기 어려우면 true } — menu.js Confirm 참고
const confirm = (action, title, detail, ctx, opts = {}) =>
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: { role: "confirm", action, title, detail, ctx, ...opts } });

// ── 메뉴(⋯ 버튼과 목록 우클릭이 같은 항목을 쓴다). 오버레이 복사본에서 그려지므로 ctx는 값만:
//   { number, title, url, root, on, open, draft, head, headRef, baseRef, methods: [{ flag, name, by }], method }

const I = (n) => `${ME}/${n}.svg`;
const C = { open: "#7aa2f7", copy: "#d699b6", go: "#e5739d", merge: "#a7c080" };

function askMerge(c, m) {
  confirm("pr.merge", `#${c.number} 병합 · ${m.name}`, `${c.headRef} → ${c.baseRef}, ${m.name} 방식으로 병합합니다.`,
    { number: c.number, root: c.root, on: c.on, flag: m.flag, head: c.head }, { yes: "병합" });
}
const askCheckout = (c) => confirm("pr.checkout", `#${c.number} 체크아웃`,
  `작업 폴더를 ${c.headRef} 브랜치로 바꿉니다. 커밋하지 않은 변경이 있으면 실패할 수 있습니다.`, { number: c.number, root: c.root, on: c.on }, { yes: "체크아웃" });
const askClose = (c) => confirm("pr.close", `#${c.number} 닫기`, "병합하지 않고 PR을 닫습니다. 나중에 다시 열 수 있습니다.",
  { number: c.number, root: c.root, on: c.on }, { yes: "PR 닫기" });

async function copyText(text, what) {
  await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(() => null);
  notify({ title: `${what}를 복사했습니다`, body: text, level: "info" });
}

function menuItems(c) {
  const items = [
    { label: "브라우저에서 열기", icon: I("open"), color: C.open, fn: () => exec("open", [c.url]) },
    { label: "링크 복사", icon: I("copy"), color: C.copy, fn: () => copyText(c.url, "링크") },
  ];
  if (!c.open) return items;
  items.push({ label: "체크아웃…", icon: I("branch"), color: C.go, hint: c.headRef, fn: () => askCheckout(c) });
  if (!c.draft && c.methods.length) {
    items.push("-");
    for (const m of c.methods) items.push({ label: `${m.by} 병합…`, icon: `${ME}/branch/pr.svg`, color: C.merge, hint: m.flag === c.method ? "기본" : "", fn: () => askMerge(c, m) });
  }
  items.push("-", { label: "PR 닫기…", icon: I("close"), color: "#e67e80", danger: true, fn: () => askClose(c) });
  return items;
}

// menu.js Menu와 같은 줄 높이로 팝업 높이를 정한다(하위 메뉴 없음).
const ROW = 30, SEP = 9, HEAD = 34, MENU_W = 280;
function openMenu(c) {
  const h = menuItems(c).reduce((n, it) => n + (it === "-" ? SEP : ROW), 12 + HEAD);
  openOverlay({ mod: "office-apps", kind: "popup", at: popupAt(MENU_W, h), width: MENU_W, height: h, props: { role: "pr-menu", ctx: c } });
}

// menu.js Menu의 그리기·키 처리를 그대로 쓰고 항목과 머리줄만 바꾼다(기본 머리줄은 파일 ctx를 읽으므로 꼭 바꾼다).
class PrMenu extends Menu {
  list() { return menuItems(props().ctx); }

  title(t, c) {
    return h_flex().h(HEAD - 6).mb(4).px(6).gap(8).items_center().border_b_1().border_color(t.border)
      .child(div().flex_none().text_size(12).text_color(t.dim).child(`#${c.number}`))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(c.title));
  }
}

// main.js가 ROLES를 펼쳐 복사하기 전에 들어가야 하므로 모듈을 읽을 때 바로 더한다.
ROLES["pr-menu"] = PrMenu;

// ── 도우미

// 파일 앱과 같은 기준: 포커스된 패인의 폴더(없으면 스페이스 폴더)와 그 머신.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const firstLine = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 200);

async function sh(cmd, args, where) {
  try { return await exec(cmd, args, { cwd: where.cwd, on: where.on }); }
  catch (e) { return { code: -1, stdout: "", stderr: String(e?.message ?? e), failed: true }; }
}

// 오른쪽 빈 화면에 보일 안내 { text, sub }를 담은 오류
function fail(text, sub = "") { const e = new Error(text); e.sub = sub; return e; }

// gh 실패를 짧은 안내로. 실행조차 못 했으면 설치 안 됨으로 본다.
function ghError(r) {
  const s = (r.stderr || r.stdout || "").trim();
  if (r.failed || r.code === 127 || /command not found|No such file/i.test(s)) return fail("gh가 설치되어 있지 않습니다", "터미널에서 brew install gh");
  if (/gh auth login|HTTP 401|not logged/i.test(s)) return fail("gh 로그인이 필요합니다", "터미널에서 gh auth login");
  if (/no git remotes|none of the git remotes/i.test(s)) return fail("GitHub 원격 저장소가 없습니다", "원격이 GitHub 저장소를 가리켜야 PR을 볼 수 있습니다");
  return fail(firstLine(s).slice(0, 160) || "gh 명령이 실패했습니다");
}

// 출력이 클 수 있는 명령(gh pr diff): stdout을 파이프로 받지 않고 임시 파일에 쓴 뒤 readTextFile로 읽는다(commit.js와 같은 방식).
// 1MB가 넘으면 마지막 온전한 줄까지만 남기고 cut을 켠다. 돌려주는 값은 { code, stdout, stderr, cut }.
async function viaFile(argv, where, timeout = 60000) {
  const script = `f=$(mktemp "\${TMPDIR:-/tmp}/herdr-pr.XXXXXX") || exit 97
"$@" >"$f" 2>"$f.err"; c=$?; t=0
if [ "$(wc -c <"$f")" -gt ${FILE_MAX} ]; then head -c ${FILE_MAX} "$f" | sed '$d' >"$f.t"; mv "$f.t" "$f"; t=1; fi
printf '%s\\n%s\\n%s' "$c" "$f" "$t"`;
  const r = await exec("sh", ["-c", script, "pr", ...argv], { cwd: where.cwd, on: where.on, timeout });
  const [code, file, cut] = r.stdout.split("\n");
  if (r.code !== 0 || !file) return { code: r.code, stdout: "", stderr: r.stderr || "임시 파일을 만들지 못했습니다", cut: false };
  try {
    const [stdout, stderr] = await Promise.all([
      readTextFile(file, { on: where.on }),
      readTextFile(`${file}.err`, { on: where.on }).catch(() => ""),
    ]);
    if (stdout === null) return { code: -1, stdout: "", stderr: "출력 파일을 읽지 못했습니다(1MiB 초과이거나 UTF-8이 아님)", cut: false };
    return { code: Number(code), stdout, stderr: stderr ?? "", cut: cut === "1" };
  } finally {
    exec("rm", ["-f", file, `${file}.err`], { on: where.on }).catch(() => null);
  }
}

function ago(iso) {
  const t = Date.parse(iso ?? ""), s = (Date.now() - t) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  const d = new Date(t);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

// PR 상태 → 글자·색 이름
function prState(p) {
  if (p.state === "MERGED") return { text: "병합됨", color: "ansi5" };
  if (p.state === "CLOSED") return { text: "닫힘", color: "ansi1" };
  if (p.isDraft) return { text: "초안", color: "dim" };
  return { text: "열림", color: "ansi2" };
}

// 체크 한 개: CheckRun(name·status·conclusion) 또는 StatusContext(context·state)
function check(c) {
  let s;
  if (c.__typename === "StatusContext" || (c.context && !c.name)) {
    s = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail" }[c.state] ?? "pending";
  } else if (c.status && c.status !== "COMPLETED") s = "pending";
  else s = { SUCCESS: "pass", NEUTRAL: "skip", SKIPPED: "skip" }[c.conclusion] ?? "fail";
  return { state: s, name: c.name ?? c.context ?? "", link: c.detailsUrl ?? c.targetUrl ?? "", group: c.workflowName ?? "" };
}
const CHECK = { fail: ["실패", "ansi1"], pending: ["대기", "ansi3"] };
const REVIEW = { APPROVED: ["승인", "ansi2"], CHANGES_REQUESTED: ["변경 요청", "ansi1"], COMMENTED: ["코멘트", "dim"], DISMISSED: ["취소됨", "dim"] };
const DECISION = { APPROVED: ["리뷰 승인", "ansi2"], CHANGES_REQUESTED: ["리뷰 변경 요청", "ansi1"], REVIEW_REQUIRED: ["리뷰 대기", "ansi3"] };
const CHANGE = { ADDED: ["A", "ansi2", "추가"], DELETED: ["D", "ansi1", "삭제"], RENAMED: ["R", "ansi5", "이름 바뀜"], COPIED: ["C", "ansi5", "복사"] };
const noComments = (s) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();

export class PrApp {
  init(_p, cx) {
    const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
    this.filter = FILTERS.some((f) => f.id === load("pr.filter", "")) ? load("pr.filter", "") : "open";
    this.method = shared(METHOD) ?? load("pr.method", null);
    this.tick = shared(PR_TICK);
    this.context = null;
    this.query = "";
    this.search = InputState.new({ placeholder: "제목·번호·작성자" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.refresh(cx);
    this.poll = cx.timer.every(POLL, (cx) => { if (this.disposed) return; this.refresh(cx); });
  }

  // 앱을 끌 때(main.js toggle): gh 목록 폴링 타이머를 끊는다.
  dispose() {
    this.disposed = true;
    this.poll?.cancel(); this.poll = null;
  }

  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 */ } }

  current(context) { return this.context === context && key() === context.key; }

  // 목록 다시 읽기. 위치가 바뀌었으면 저장소부터 다시 확인한다.
  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      this.context = { key: next, cwd, on };
      this.root = null; this.on = on; this.repo = null; this.me = null; this.prs = null; this.error = null;
      this.closed = false; this.loading = false; this.diffCache = null;
      this.pick(null);
    }
    if (!cwd) { this.error = fail("폴더가 없습니다", "스페이스나 패인에 폴더를 정하면 그 저장소의 PR을 봅니다"); return; }
    if (this.sel) this.loadDetail(this.sel, cx);
    if (this.loading) return;
    const context = this.context, filter = this.filter;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const top = await sh("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (top.code !== 0) throw fail("git 저장소가 아닙니다", "PR은 GitHub 저장소 폴더에서 볼 수 있습니다");
          const root = top.stdout.trim();
          const remote = await sh("git", ["remote"], { cwd: root, on });
          if (!remote.stdout.trim()) throw fail("원격 저장소가 없습니다", "GitHub 원격을 추가하면 PR을 볼 수 있습니다");
          const repo = await sh("gh", ["repo", "view", "--json", "nameWithOwner,url,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed"], { cwd: root, on });
          if (repo.code !== 0) throw ghError(repo);
          const me = await sh("gh", ["api", "user", "--jq", ".login"], { cwd: root, on });
          if (!this.current(context)) return;
          this.root = root; this.repo = JSON.parse(repo.stdout); this.me = me.code === 0 ? me.stdout.trim() : null;
        }
        const r = await sh("gh", ["pr", "list", ...FILTERS.find((f) => f.id === filter).args, "--limit", String(LIMIT), "--json", LIST_FIELDS], { cwd: this.root, on });
        if (r.code !== 0) throw ghError(r);
        if (!this.current(context) || this.filter !== filter) return;
        this.prs = JSON.parse(r.stdout); this.error = null;
        // 처음 열 때(또는 필터를 바꾼 뒤)는 맨 위 PR을 보여 준다. ✕로 닫았으면 그대로 둔다.
        const first = this.shown()[0];
        if (!this.sel && !this.closed && first) this.select(first.number, cx);
      } catch (e) {
        if (this.current(context)) { this.error = e?.sub !== undefined ? e : fail(String(e?.message ?? e).slice(0, 160)); this.prs = null; }
      } finally {
        if (this.context === context) this.loading = false;
        // 필터를 바꾸는 동안 읽기가 끝났으면 바뀐 필터로 한 번 더
        if (this.current(context) && this.filter !== filter) this.refresh(cx);
        cx.notify();
      }
    });
  }

  setFilter(id, cx) {
    if (this.filter === id) return;
    this.filter = id; this.prs = null; this.error = null; this.save("pr.filter", id);
    this.closed = false; this.pick(null);
    this.refresh(cx);
  }

  // 검색어로 거른 목록(받아 둔 목록 안에서만)
  shown() {
    const q = this.query, list = this.prs ?? [];
    if (!q) return list;
    const n = q.replace(/^#/, "");
    return list.filter((p) => p.title.toLowerCase().includes(q) || String(p.number).startsWith(n) || (p.author?.login ?? "").toLowerCase().includes(q));
  }

  // 고른 PR을 바꾸고 그 PR에 딸린 화면 상태(펼침·고른 파일)를 비운다.
  pick(n) {
    this.sel = n; this.pr = null; this.prError = null;
    this.bodyOpen = false; this.talkOpen = false;
    this.openFile(null);
  }

  select(n, cx) {
    this.hideTip();
    if (this.sel !== n) this.pick(n);
    this.loadDetail(n, cx);
  }

  // 고른 PR 상세. 다시 읽는 동안에는 이전 내용을 그대로 보여 준다(펼침·고른 파일도 그대로).
  loadDetail(n, cx) {
    if (!this.root) return;
    const context = this.context;
    cx.spawn(async (cx) => {
      const r = await sh("gh", ["pr", "view", String(n), "--json", VIEW_FIELDS], { cwd: this.root, on: this.on });
      if (!this.current(context) || this.sel !== n) return;
      if (r.code !== 0) { this.prError = ghError(r).message; this.pr = null; }
      else {
        try {
          const was = this.pr?.headRefOid;
          this.pr = JSON.parse(r.stdout); this.prError = null;
          // 새 커밋이 올라왔으면 보던 파일의 diff를 다시 읽는다.
          if (this.file && was && was !== this.pr.headRefOid) this.openFile(this.file, cx);
        } catch { this.prError = "PR 정보를 읽지 못했습니다"; }
      }
      cx.notify();
    });
  }

  // 저장소가 허용하는 병합 방식들과 기본 방식(마지막으로 쓴 방식, 없으면 첫 방식)
  methods() { return METHODS.filter((m) => this.repo?.[m.allow] !== false); }
  mergeMethod() { const list = this.methods(); return list.find((m) => m.flag === this.method) ?? list[0] ?? METHODS[0]; }

  // 메뉴·확인 창에 넘길 값(목록 줄이나 상세 어느 쪽이든)
  ctxFor(p) {
    return {
      number: p.number, title: p.title, url: p.url, root: this.root, on: this.on,
      open: p.state === "OPEN", draft: Boolean(p.isDraft), head: p.headRefOid, headRef: p.headRefName, baseRef: p.baseRefName,
      methods: this.methods().map(({ flag, name, by }) => ({ flag, name, by })), method: this.mergeMethod().flag,
    };
  }

  // 앱 셸이 그릴 때마다 부른다: 위치 바뀜·동작 완료·병합 방식 바뀜 확인
  sync(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    if (shared(PR_TICK) !== this.tick) { this.tick = shared(PR_TICK); this.refresh(cx); }
    const m = shared(METHOD);
    if (m && m !== this.method) { this.method = m; this.save("pr.method", m); }
  }

  // ── 셸 계약: 키보드·빈 상태

  // ↑↓: 거른 목록에서 위아래 PR로
  move(delta, cx) {
    const list = this.shown();
    if (!list.length) return;
    const i = list.findIndex((p) => p.number === this.sel);
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + delta));
    this.closed = false;
    if (list[next].number !== this.sel) this.select(list[next].number, cx);
    cx.notify();
  }

  // Enter: 고른 PR을 브라우저로
  activate(_cx) {
    const p = this.pr?.number === this.sel ? this.pr : (this.prs ?? []).find((x) => x.number === this.sel);
    if (p?.url) exec("open", [p.url]);
  }

  emptyState() {
    if (this.error) return { text: this.error.message, sub: this.error.sub ?? "" };
    if (!this.prs) return { text: "PR을 읽는 중", sub: this.repo?.nameWithOwner ?? "" };
    if (!this.prs.length) return { text: FILTERS.find((f) => f.id === this.filter).empty, sub: "다른 필터를 골라 보세요" };
    if (!this.shown().length) return { text: "맞는 PR이 없습니다", sub: "제목·번호·작성자로 찾습니다" };
    return { text: "선택 내용이 없습니다", sub: "왼쪽에서 PR을 고르세요" };
  }

  // ── 툴팁(파일 앱과 같은 방식: 아이콘 위에 창 오버레이)
  showTip(id, text, b) {
    this.hideTip();
    if (!b) return;
    const w = Math.round(columns(text) * 6.5 + 20);
    this.tipFor = id;
    this.tipId = openOverlay({ mod: "office-apps", kind: "window", key: "office-apps-tip", frame: "none", width: w, height: 26,
      at: { x: Math.max(4, Math.round(b.x + b.width / 2 - w / 2)), y: Math.max(4, Math.round(b.y - 30)) },
      props: { role: "tip", text } });
  }

  hideTip() {
    if (this.tipId) closeOverlay(this.tipId);
    this.tipId = null; this.tipFor = null;
  }

  tipped(el, id, tip) {
    return el.on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); });
  }

  // ── 왼쪽: 필터 · 검색 · 목록
  toolbar(t) {
    const tab = (f) => div().id(`pr-f-${f.id}`).px(7).py(3).rounded(4).flex_none().cursor_pointer().text_size(12)
      .text_color(this.filter === f.id ? t.foreground : t.muted).when(this.filter === f.id, (el) => el.bg(t.selected).font_semibold())
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.setFilter(f.id, cx); cx.notify(); })
      .child(f.name);
    return v_flex().flex_none().border_b_1().border_color(t.border)
      .child(h_flex().min_h(32).py(2).px(6).gap(1).items_center()
        .children(FILTERS.map(tab))
        .child(div().flex_1())
        .child(this.tipped(div().id("pr-refresh").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover)), "refresh", "다시 읽기")
          .on_click((_e, cx) => { this.hideTip(); this.diffCache = null; this.refresh(cx); cx.notify(); })
          .child(svg(`${ME}/refresh.svg`).size(15).text_color(this.loading ? t.dim : t.muted))))
      .child(h_flex().h(32).pl(10).pr(4).gap(6).items_center()
        .child(svg(`${ME}/search.svg`).size(14).flex_none().text_color(this.query ? t.foreground : t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.search).h(26).text_size(12).text_color(t.foreground)))
        .when(Boolean(this.query), (el) => el.child(div().id("pr-clear").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.search.set_value(""); this.query = ""; cx.notify(); })
          .child(svg(`${ME}/close.svg`).size(14).text_color(t.muted)))));
  }

  // 목록 한 줄: 제목 · 상대 시각 / (초안·병합됨·닫힘) #번호 · 작성자(작성자가 나 혼자면 생략)
  row(p, t, hideAuthor) {
    const st = prState(p), on = this.sel === p.number;
    const meta = [`#${p.number}`, hideAuthor ? null : p.author?.login].filter(Boolean).join(" · ");
    return v_flex().id(`pr-row-${p.number}`).flex_none().px(8).py(6).gap(2).rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(on, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.closed = false; this.select(p.number, cx); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.hideTip(); openMenu(this.ctxFor(p)); })
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(p.isDraft && p.state === "OPEN" ? t.muted : t.foreground).child(p.title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(p.updatedAt))))
      .child(h_flex().gap(5).items_center().min_w(0)
        .when(p.state !== "OPEN" || p.isDraft, (el) => el.child(div().flex_none().text_size(11).text_color(t[st.color]).child(st.text)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta)));
  }

  list(cx, t) {
    this.sync(cx);
    const note = (text) => div().p(8).text_size(12).text_color(t.dim).child(text);
    const all = this.prs ?? [], shown = this.shown();
    // 작성자 숨김은 거르기 전 목록으로 정한다(입력하는 동안 깜빡이지 않게).
    const hideAuthor = this.filter === "mine" || (Boolean(this.me) && all.length > 0 && all.every((p) => p.author?.login === this.me));
    let body;
    if (this.error) body = [note(this.error.message)];
    else if (!this.prs) body = [note("PR을 읽는 중")];
    else if (!all.length) body = [note(FILTERS.find((f) => f.id === this.filter).empty)];
    else if (!shown.length) body = [note("맞는 PR이 없습니다")];
    else body = shown.map((p) => this.row(p, t, hideAuthor));
    return v_flex().flex_1().min_h(0)
      .child(this.toolbar(t))
      .child(v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1).children(body)
        .when(all.length === LIMIT && !this.query, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child(`최근 ${LIMIT}개까지만 보여 줍니다`))));
  }

  subtitle(t) {
    if (!this.repo) return null;
    return div().id("pr-repo").truncate().text_size(12).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", [this.repo.url]))
      .child(this.repo.nameWithOwner);
  }

  // ── 오른쪽: 고른 PR 하나. 오류·읽는 중·빈 목록이면 null을 돌려 셸이 emptyState()를 보이게 한다.
  detail(cx, t) {
    if (!this.sel || this.error || !this.prs) return null;
    const p = this.pr?.number === this.sel ? this.pr : null, row = this.prs.find((x) => x.number === this.sel);
    const base = p ?? row;
    const st = base ? prState(base) : null;
    const head = h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
      .when(Boolean(st), (el) => el.child(div().flex_none().text_size(12).font_semibold().text_color(t[st.color]).child(st.text)))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(`#${this.sel}`))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(base?.title ?? ""))
      .child(div().id("pr-close-detail").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.closed = true; this.pick(null); cx.notify(); }).child("✕"));
    const root = v_flex().id("pr-detail").size_full().min_h(0)
      .on_size_change((size, cx) => { if (Math.abs((this.dh ?? 0) - size.height) > 4) { this.dh = size.height; cx.notify(); } })
      .child(head);
    if (!p) return root.child(v_flex().flex_1().items_center().justify_center().text_size(12).text_color(t.dim).child(this.prError ?? "PR을 읽는 중"));
    // 파일을 고르면 위(요약·파일 목록)는 높이를 줄여 스크롤하고, 아래에 diff를 붙인다.
    const upper = v_flex().id(`pr-info-${p.number}`).min_h(0).overflow_y_scrollbar().px(20).py(14).gap(14)
      .child(this.status(p, t))
      .children(this.checks(p, t))
      .children(this.bodyView(p, t))
      .children(this.talk(p, t))
      .child(this.files(p, t));
    if (!this.file) return root.child(upper.flex_1());
    return root
      .child(upper.flex_none().max_h(Math.max(140, Math.round((this.dh ?? 600) * 0.4))).border_b_1().border_color(t.border))
      .child(this.diffView(p, t));
  }

  // 병합 가능 여부 한 줄(체크 · 리뷰 · 충돌, 닫힌 PR은 언제 닫혔는지) + 주 동작 하나 + ⋯
  status(p, t) {
    const open = p.state === "OPEN", parts = [];
    const word = (text, color) => parts.push(div().flex_none().text_color(color).child(text));
    if (open) {
      if (p.isDraft) word("초안", t.muted);
      const list = (p.statusCheckRollup ?? []).map(check);
      const n = (s) => list.filter((c) => c.state === s).length;
      if (n("fail")) word(`체크 실패 ${n("fail")}`, t.ansi1);
      else if (n("pending")) word(`체크 대기 ${n("pending")}`, t.ansi3);
      else if (list.length) word(`체크 통과 ${n("pass")}`, t.ansi2);
      const dec = DECISION[p.reviewDecision];
      if (dec) word(dec[0], t[dec[1]]);
      if (p.mergeable === "CONFLICTING") word("충돌 있어 병합할 수 없음", t.ansi1);
      else if (p.mergeable === "MERGEABLE") word("충돌 없음", t.muted);
    } else {
      word(p.state === "MERGED" ? `${ago(p.mergedAt)} 병합됨` : `${ago(p.closedAt)} 닫힘`, t.muted);
    }
    if (p.author?.login && p.author.login !== this.me) word(p.author.login, t.dim);
    const line = h_flex().flex_1().min_w(0).flex_wrap().gap(6).items_center().text_size(12)
      .children(parts.flatMap((el, i) => (i ? [div().flex_none().text_color(t.dim).child("·"), el] : [el])));

    const c = this.ctxFor(p);
    const blocked = open && (p.isDraft || p.mergeable === "CONFLICTING");
    const m = this.mergeMethod();
    const primary = div().id("pr-primary").flex_none().px(12).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .when(!blocked, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .text_color(blocked ? t.dim : open ? t.ansi2 : t.foreground)
      .on_click(() => { if (blocked) return; if (open) askMerge(c, m); else exec("open", [p.url]); })
      .child(open ? "병합" : "브라우저");
    const more = this.tipped(div().id("pr-more").flex_none().p(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)), "more", "더 보기")
      .on_click(() => { this.hideTip(); openMenu(c); })
      .child(svg(`${ME}/branch/more.svg`).size(15).text_color(t.muted));
    return h_flex().gap(10).items_center().child(line).child(primary).child(more);
  }

  // 체크: 실패·대기만 한 줄씩(누르면 결과 페이지), 통과는 "통과 N" 한 낱말. 모두 통과면 아무것도 그리지 않는다.
  checks(p, t) {
    if (p.state !== "OPEN") return [];
    const list = (p.statusCheckRollup ?? []).map(check), bad = list.filter((c) => CHECK[c.state]);
    if (!bad.length) return [];
    const pass = list.filter((c) => c.state === "pass").length;
    return [v_flex().gap(1)
      .children(bad.map((c, i) => h_flex().id(`pr-check-${i}`).h(24).px(4).gap(8).items_center().rounded(4)
        .when(Boolean(c.link), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => exec("open", [c.link])))
        .child(div().size(7).flex_none().rounded_full().bg(t[CHECK[c.state][1]]))
        .child(div().flex_none().text_size(13).text_color(t.foreground).child(c.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(c.group))
        .child(div().flex_none().text_size(11).text_color(t[CHECK[c.state][1]]).child(CHECK[c.state][0]))))
      .when(pass > 0, (el) => el.child(div().px(4).pt(2).text_size(11).text_color(t.dim).child(`통과 ${pass}`)))];
  }

  md(id, text, t) {
    return div().text_size(13).text_color(t.foreground)
      .child(TextView.markdown(id, text).selectable(true).on_link_click((url) => { if (/^(https?|mailto):/i.test(url)) exec("open", [url]); }));
  }

  // 펼치고 접는 작은 글자 줄(리뷰·코멘트 머리줄, 본문 "더 보기")
  toggle(id, label, open, t, fn) {
    return h_flex().id(id).flex_none().gap(4).items_center().cursor_pointer().text_size(12).text_color(t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { fn(); cx.notify(); })
      .child(svg(`${ME}/${open ? "chevron-down" : "chevron-right"}.svg`).size(13).flex_none().text_color(t.muted))
      .child(label);
  }

  // 본문: 처음 몇 줄만, 누르면 펼침. 본문이 없으면 그리지 않는다.
  bodyView(p, t) {
    const text = noComments(p.body);
    if (!text) return [];
    const lines = text.split("\n"), long = lines.length > BODY_LINES;
    const shown = long && !this.bodyOpen ? lines.slice(0, BODY_LINES).join("\n") : text;
    return [v_flex().gap(6)
      .child(this.md(`pr-body-${p.number}-${this.bodyOpen ? "all" : "head"}`, shown, t))
      .when(long, (el) => el.child(this.toggle("pr-body-more", this.bodyOpen ? "접기" : `더 보기 · ${lines.length - BODY_LINES}줄`, this.bodyOpen, t,
        () => { this.bodyOpen = !this.bodyOpen; })))];
  }

  // 리뷰와 코멘트: 접힌 한 줄(개수), 펼치면 시간 순. 내용 없는 코멘트 리뷰(줄 코멘트만 단 것)는 뺀다.
  talk(p, t) {
    const items = [
      ...(p.reviews ?? []).filter((r) => r.state !== "PENDING" && (r.body?.trim() || r.state !== "COMMENTED"))
        .map((r) => ({ who: r.author?.login, at: r.submittedAt, body: r.body ?? "", review: REVIEW[r.state] })),
      ...(p.comments ?? []).map((c) => ({ who: c.author?.login, at: c.createdAt, body: c.body ?? "" })),
    ].sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0));
    if (!items.length) return [];
    const head = this.toggle("pr-talk-toggle", `리뷰·코멘트 ${items.length}`, this.talkOpen, t, () => { this.talkOpen = !this.talkOpen; });
    if (!this.talkOpen) return [head];
    return [v_flex().gap(10).child(head).children(items.map((it, i) => v_flex().pl(12).gap(4).border_l_2().border_color(t.border)
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(div().font_semibold().text_color(t.foreground).child(it.who ?? "알 수 없음"))
        .when(Boolean(it.review), (el) => el.child(div().text_color(t[it.review[1]]).child(it.review[0])))
        .child(div().text_color(t.dim).child(ago(it.at))))
      .when(Boolean(noComments(it.body)), (el) => el.child(this.md(`pr-talk-${p.number}-${i}`, noComments(it.body), t)))))];
  }

  // 바뀐 파일: 누르면 아래에 그 파일의 diff(다시 누르면 닫음)
  files(p, t) {
    const list = p.files ?? [], total = p.changedFiles ?? list.length;
    return v_flex().gap(4)
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(div().font_semibold().text_color(t.muted).child(`바뀐 파일 ${total}`))
        .child(div().flex_1())
        .when(Boolean(p.additions), (el) => el.child(div().text_size(11).text_color(t.ansi2).child(`+${p.additions}`)))
        .when(Boolean(p.deletions), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(`−${p.deletions}`))))
      .child(v_flex().children(list.map((f) => this.fileRow(f, t))))
      .when(list.length < total, (el) => el.child(div().id("pr-files-web").pt(2).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", [`${p.url}/files`]))
        .child(`앞 ${list.length}개만 보여 줍니다 · 전체는 브라우저에서`)));
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), ch = CHANGE[f.changeType];
    return h_flex().id(`pr-file-${f.path}`).h(24).flex_none().px(6).gap(6).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(this.file === f.path, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.openFile(this.file === f.path ? null : f.path, cx); cx.notify(); })
      .child(div().w(12).flex_none().text_size(11).text_color(ch ? t[ch[1]] : t.ansi4).child(ch ? ch[0] : "M"))
      .child(div().flex_none().max_w(220).truncate().text_size(12).text_color(f.changeType === "DELETED" ? t.muted : t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
      .when(f.additions > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.additions}`)))
      .when(f.deletions > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.deletions}`)));
  }

  // ── diff

  // PR 하나의 통 diff를 한 번만 받아 파일별로 나눠 둔다(PR 번호 + head 커밋 기준, 새 커밋이면 다시).
  // 돌려주는 값: { map, cut, last } 또는 { error, why?, web }
  prDiff(p) {
    const k = `${p.number}:${p.headRefOid}`;
    if (this.diffCache?.key === k) return this.diffCache.promise;
    const where = { cwd: this.root, on: this.on };
    const promise = (async () => {
      const r = await viaFile(["gh", "pr", "diff", String(p.number), "--color=never"], where);
      if (r.code === 0) {
        const map = splitDiff(r.stdout), keys = Object.keys(map);
        return { map, cut: r.cut, last: keys[keys.length - 1] };
      }
      const s = String(r.stderr ?? "");
      if (/too_large|HTTP 406|exceeded the maximum/i.test(s)) return { error: "PR이 너무 커서 GitHub가 diff를 주지 않습니다", web: true, keep: true };
      return { error: "diff를 읽지 못했습니다", why: firstLine(s), web: true };
    })().catch((e) => ({ error: "diff를 읽지 못했습니다", why: firstLine(e?.message ?? e), web: true }));
    const entry = { key: k, promise };
    this.diffCache = entry;
    // 잠깐의 실패(네트워크 등)는 기억하지 않아 다음에 다시 시도한다.
    promise.then((d) => { if (d.error && !d.keep && this.diffCache === entry) this.diffCache = null; });
    return promise;
  }

  // 고른 파일의 diff를 그릴 줄로 만든다.
  openFile(path, cx) {
    this.file = path; this.rows = []; this.pairs = []; this.diffW = 300; this.splitW = 300; this.diffNote = null; this.diffWhy = null;
    this.diffCut = false; this.diffTrunc = false; this.diffWeb = false; this.diffLoading = false;
    this.fileGen = (this.fileGen ?? 0) + 1;
    const p = this.pr;
    if (!path || !cx || !p) return;
    const f = (p.files ?? []).find((x) => x.path === path), gen = this.fileGen;
    if (f && f.additions + f.deletions > BIG) { this.diffNote = "diff가 너무 커서 열지 않았습니다"; this.diffWeb = true; return; }
    this.diffLoading = true;
    cx.spawn(async (cx) => {
      let note = null, why = null, rows = null, out = null, web = false, trunc = false;
      try {
        const d = await this.prDiff(p);
        if (d.error) { note = d.error; why = d.why ?? null; web = true; }
        else if (d.map[path] === undefined) {
          note = d.cut ? "출력이 커서 이 파일의 diff는 읽지 못했습니다" : "이 파일의 diff가 없습니다"; web = true;
        } else {
          const text = d.map[path];
          out = diffLines(text);
          if (!out) note = /^Binary files|^GIT binary patch/m.test(text) ? "바이너리 파일입니다"
            : f?.changeType === "RENAMED" ? "내용은 그대로이고 이름만 바뀌었습니다" : "보여 줄 텍스트 차이가 없습니다";
          // 1MB에서 잘린 출력의 마지막 파일은 뒷부분이 없을 수 있다.
          trunc = d.cut && d.last === path;
        }
        // 줄 번호 → 줄 안 바뀐 구간(wordSpans). 좌우 보기용 짝은 그릴 때 만든다.
        if (out) rows = wordSpans(diffRows(out.lines));
      } catch (e) { note = "diff를 그리지 못했습니다"; why = firstLine(e?.message ?? e); rows = null; }
      if (gen !== this.fileGen) return;
      this.diffLoading = false;
      if (rows) { const pairs = splitRows(rows); this.rows = rows; this.pairs = pairs; this.diffCut = out.cut; this.diffW = inlineWidth(rows); this.splitW = splitWidth(pairs); }
      this.diffNote = note; this.diffWhy = why; this.diffWeb = web; this.diffTrunc = trunc;
      cx.notify();
    });
  }

  // 고른 파일의 diff(commit.js와 같은 모양: 옛 줄 번호 · 새 줄 번호 · 내용)
  diffView(p, t) {
    const f = (p.files ?? []).find((x) => x.path === this.file);
    const rows = this.rows ?? [];
    const head = h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b_1().border_color(t.border).text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(this.file))
      .when(Boolean(f?.additions), (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.additions}`)))
      .when(Boolean(f?.deletions), (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.deletions}`)))
      .child(modeToggle(t, "pr", this.narrow()))
      .child(div().id("pr-diff-close").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.openFile(null); cx.notify(); }).child("✕"));
    let body;
    if (this.diffNote || (!rows.length && !this.diffLoading)) {
      body = v_flex().flex_1().items_center().justify_center().gap(10)
        .child(div().text_size(12).text_color(t.dim).child(this.diffNote ?? ""))
        .when(Boolean(this.diffWhy), (el) => el.child(div().max_w(560).px(16).text_size(11).text_color(t.dim).opacity(0.75).child(this.diffWhy)))
        .when(Boolean(this.diffWeb), (el) => el.child(div().id("pr-diff-web").px(10).py(4).rounded(6).border_1().border_color(t.border)
          .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => exec("open", [`${p.url}/files`])).child("브라우저에서 보기")));
    } else if (!rows.length) {
      body = v_flex().flex_1().items_center().justify_center().text_size(12).text_color(t.dim).child("읽는 중");
    } else {
      body = this.drawDiff(rows, t);
    }
    const foot = this.diffCut ? "앞 1,500줄만 보여 줍니다" : this.diffTrunc ? "출력이 커서 뒷부분이 잘렸습니다" : null;
    return v_flex().id("pr-diff-area").flex_1().min_h(0).child(head).child(body)
      .on_size_change((size, cx) => { if (Math.abs((this.dw ?? 0) - size.width) > 4) { this.dw = size.width; cx.notify(); } })
      .when(Boolean(foot), (el) => el.child(div().flex_none().px(12).py(4).border_t_1().border_color(t.border)
        .text_size(11).text_color(t.dim).child(foot)));
  }

  // 보기 모드는 commit/diffview.js가 그릴 때마다 읽는다(커밋 앱과 같은 값).
  narrow() { return (this.dw ?? 1000) < NARROW; }
  split() { return diffMode() === "split" && !this.narrow(); }

  // diff 줄 그리기: commit/diffview.js(커밋 앱과 같은 색·바뀐 글자 강조·위아래/좌우).
  drawDiff(rows, t) {
    const s = settings()?.dark, pal = diffPalette(t, typeof s === "boolean" ? s : isDark(t));
    const split = this.split(), pairs = this.pairs ?? [];
    const n = split ? pairs.length : rows.length;
    return div().flex_1().min_h(0).relative().font_family(CODE_FONT).text_size(12)
      .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w((split ? this.splitW : this.diffW) ?? 300).h_full()
          .child(v_virtual_list("pr-diff", n, DIFF_LINE, (i) => `${split ? "s" : "i"}${i}`,
            (range) => split
              ? pairs.slice(range.start, range.end).map((p) => splitRow(p, t, pal))
              : rows.slice(range.start, range.end).map((row) => inlineRow(row, t, pal))).size_full())))
      .child(Scrollbar.vertical("pr-diff").viewport_from_layout().absolute().inset_0());
  }
}
