// 커밋 앱: 지금 스페이스(포커스된 패인)의 git 저장소에서 현재 브랜치의 커밋 기록을 본다.
//   왼쪽: 검색 + 커밋 목록(한 줄: 제목 · 짧은 상대 시각, 200개씩 더 불러오기). 맨 위에 "커밋 안 된 변경"(있을 때만).
//   오른쪽: 머리줄(제목 · 해시 복사 · 시각 · ✕) / 본문 첫 문단(있을 때만, 누르면 펼침) / 바뀐 파일(접기 · 위아래|좌우) / diff.
//   diff 줄 그리기와 색·좌우 정렬은 commit/diffview.js(PR 앱도 같이 쓴다).
// git은 읽기만 한다(.git 아래에 아무것도 쓰지 않는 옵션). 파싱은 commit/git.js.
//
// 우클릭 메뉴(commit-menu 역할)와 확인 창(menu.js Confirm)은 오버레이라 이 모드의 새 복사본에서 돈다.
// 공용 파일을 고치지 않으려고 모듈이 불릴 때 "commit."으로 시작하는 동작은 menu.js ACTIONS에, 메뉴 역할은
// files.js ROLES에 더해 둔다(branch.js와 같은 방식). 메뉴 항목은 ctx 값만으로 만든다(앱 인스턴스를 못 본다).
// 메뉴에서 앱 상태를 바꿔야 하는 일("이 파일의 diff만 보기")은 공유 상태(ONLY)로 넘기고 앱이 렌더 때 받는다.
//
// 셸(main.js)이 부르는 것: list · detail · subtitle · dispose · move(delta) · activate · emptyState
//   · openCommit(해시|"WORKTREE") · openRange(base, head)

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, home, props, run, openOverlay, closeOverlay, notify, shared, setShared, settings } from "herdr";
import { Menu, ACTIONS, TICK, popupAt } from "./menu.js";
import { ROLES } from "./files.js";
import {
  PAGE, BIG, READ, LOG_FORMAT, SHOW_FORMAT, SEARCH, parseLog, parseShow, parseNameStatus, parseNumstat, mergeFiles,
  diffLines, addedLines, diffRows, columns, ago, stamp, agoShort, bodyParagraphs, splitSubject,
} from "./commit/git.js";
import {
  DIFF_LINE, NARROW, inlineRow, splitRow, inlineWidth, splitWidth, diffPalette, wordSpans, splitRows, isDark, diffMode, modeToggle,
} from "./commit/diffview.js";

const ME = "mods/office-apps";
const I = (n) => `${ME}/${n}.svg`;
const CODE_FONT = "D2Coding";
const WT = "@worktree";       // "커밋 안 된 변경"의 선택 키
const RANGE = "@range";       // "base...head 비교"의 선택 키
const FOOT_KEY = "@foot";     // 목록 끝 안내·"더 불러오기" 줄의 가상 목록 키
const ROW = 26;               // 목록 한 줄 높이(파일 앱과 같은 한 줄)
const FOOT = 40;              // 목록 아래 안내·"더 불러오기" 줄 높이
const FILE_ROW = 24;          // 바뀐 파일 한 줄 높이
const FILE_ROWS = 8;          // 바뀐 파일 목록은 이 줄 수까지 보이고 넘치면 스크롤
const BODY_LINE = 18;         // 펼친 본문 한 줄 높이
const BODY_ROWS = 10;         // 펼친 본문은 이 줄 수까지 보이고 넘치면 스크롤
const FILE_MAX = 1000000;     // 임시 파일로 받은 출력의 상한(readTextFile은 1MiB까지)
const ONLY = "office-apps.commit.only";   // 메뉴 "이 파일의 diff만 보기" → 앱 { sel, path, at }
const STATUS = { A: "추가", M: "수정", D: "삭제", R: "이름 바뀜", C: "복사", T: "형식 바뀜", U: "충돌", "?": "새 파일" };
// 메뉴 아이콘 색(branch.js·menu.js와 같은 톤)
const C = { copy: "#d699b6", go: "#e5739d", edit: "#dbbc7f", mix: "#83c092", view: "#7aa2f7", open: "#7aa2f7" };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const firstLine = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 200);

// origin 주소가 GitHub면 웹 주소로(git@github.com:o/r.git → https://github.com/o/r). 아니면 null.
function githubUrl(remote) {
  const url = String(remote ?? "").trim()
    .replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/").replace(/\.git$/, "");
  return /^https:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/.test(url) ? url : null;
}

// ── 메뉴·확인 창 동작(오버레이 복사본에서도 돈다: ctx는 값만) ────────────────
// 커밋 줄 ctx: { kind: "commit", hash, short, subject, merge, root, on, web }
// 파일 줄 ctx: { kind: "file", path, status, show(파일 앱 기준 경로 | null), sel }

function inTab(ctx, name, argv) {
  run("tab.new", { name, folder: ctx.root, argv });
  run("layout.show", { id: "office-term" });
}

async function copyText(text, what) {
  await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(() => null);
  notify({ title: `${what}를 복사했습니다`, body: text, level: "info" });
}

// 병합 커밋은 첫 부모 기준으로 되돌리거나 가져온다(상세 화면도 첫 부모와 비교한다).
const mainline = (ctx) => (ctx.merge ? ["-m", "1"] : []);

const ACT = {
  copyHash: (ctx) => copyText(ctx.hash, "해시"),
  checkout: async (ctx) => {
    let r;
    try { r = await exec("git", ["switch", "--detach", ctx.hash], { cwd: ctx.root, on: ctx.on, timeout: 60000 }); }
    catch (e) { r = { code: -1, stdout: "", stderr: String(e?.message ?? e) }; }
    if (r.code === 0) notify({ title: "체크아웃했습니다", body: `${ctx.short} (분리된 HEAD)`, level: "info" });
    else notify({ title: "체크아웃하지 못했습니다", body: (r.stderr || r.stdout || "").trim().slice(0, 400), level: "error" });
    setShared(TICK, Date.now());
  },
  revert: (ctx) => inTab(ctx, `revert ${ctx.short}`, ["git", "revert", ...mainline(ctx), ctx.hash]),
  cherryPick: (ctx) => inTab(ctx, `cherry-pick ${ctx.short}`, ["git", "cherry-pick", ...mainline(ctx), ctx.hash]),
  web: (ctx) => exec("open", [`${ctx.web}/commit/${ctx.hash}`]).catch(() => null),
  showFile: (ctx) => run(`office-apps.show:${ctx.show}`),
  only: (ctx) => setShared(ONLY, { sel: ctx.sel, path: ctx.path, at: Date.now() }),
};

// opts: { yes: 실행 버튼 이름, danger: 되돌리기 어려우면 true } — menu.js Confirm 참고
function confirm(ctx, action, title, detail, opts = {}) {
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: { role: "confirm", ctx, action: `commit.${action}`, title, detail, ...opts } });
}

// 숨긴 항목(false) 빼고, 구분선이 겹치거나 양 끝에 오지 않게 정리한다.
function tidy(list) {
  const out = [];
  for (const it of list) {
    if (!it || (it === "-" && (!out.length || out[out.length - 1] === "-"))) continue;
    out.push(it);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

function menuItems(ctx) {
  const item = (label, icon, color, fn, hint) => ({ label, icon, color, fn, hint });
  if (ctx.kind === "file") return tidy([
    ctx.show && item("파일 앱으로 열기", I("open"), C.open, () => ACT.showFile(ctx)),
    item("이 파일의 diff만 보기", I("eye"), C.view, () => ACT.only(ctx)),
  ]);
  const s = `'${ctx.short}'`;
  return tidy([
    item("해시 복사", I("copy"), C.copy, () => ACT.copyHash(ctx), ctx.short),
    "-",
    item("이 커밋으로 체크아웃...", I("branch"), C.go, () => confirm(ctx, "checkout", `${s} 체크아웃`,
      `HEAD를 이 커밋으로 옮깁니다(분리된 HEAD). 브랜치는 그대로 남습니다. 커밋 안 된 변경과 겹치면 git이 멈춥니다.`, { yes: "체크아웃" }), "git switch --detach"),
    item("이 커밋 되돌리기...", I("reset"), C.edit, () => confirm(ctx, "revert", `${s} 되돌리기`,
      `이 커밋의 변경을 거꾸로 적용하는 새 커밋을 만듭니다. 충돌을 직접 다룰 수 있게 새 터미널 탭에서 실행합니다.`, { yes: "되돌리기" }), "git revert"),
    item("현재 브랜치로 가져오기...", I("duplicate"), C.mix, () => confirm(ctx, "cherryPick", `${s} 가져오기`,
      `이 커밋의 변경을 현재 브랜치에 새 커밋으로 적용합니다. 새 터미널 탭에서 실행합니다.`, { yes: "가져오기" }), "git cherry-pick"),
    "-",
    ctx.web && item("브라우저로 열기", `${ME}/branch/web.svg`, C.view, () => ACT.web(ctx), "GitHub"),
  ]);
}

// menu.js Menu와 같은 줄 높이로 팝업 높이를 정한다(하위 메뉴 없음).
const M_ROW = 30, M_SEP = 9, M_HEAD = 34, M_W = 300;
function openMenu(ctx) {
  register();
  const h = menuItems(ctx).reduce((n, it) => n + (it === "-" ? M_SEP : M_ROW), 12 + M_HEAD);
  openOverlay({ mod: "office-apps", kind: "popup", at: popupAt(M_W, h), width: M_W, height: h, props: { role: "commit-menu", ctx } });
}

// 우클릭 메뉴: menu.js Menu의 그리기·키 처리를 그대로 쓰고 항목과 머리줄만 바꾼다. 항목이 평평해야 한다(sub 금지).
class CommitMenu extends Menu {
  list() { return menuItems(props().ctx); }

  title(t, ctx) {
    const file = ctx.kind === "file";
    const label = file ? ctx.path.split("/").pop() : ctx.subject || "(제목 없음)";
    const note = file ? STATUS[ctx.status] ?? "" : ctx.short;
    return h_flex().h(M_HEAD - 6).mb(4).px(6).gap(8).items_center().border_b_1().border_color(t.border)
      .child(svg(file ? I("file-new") : I("log")).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(label))
      .child(div().flex_none().text_size(11).text_color(t.dim).when(!file, (el) => el.font_family(CODE_FONT)).child(note));
  }
}

// ── 앱 ──────────────────────────────────────────────────────

export class CommitApp {
  init(_props, cx) {
    register();
    this.commits = []; this.files = []; this.rows = [];
    this.query = "";
    this.state = "loading";          // loading | nofolder | norepo | nocommit | ok | error — 빈 상태 안내용
    this.filesOpen = true;           // 바뀐 파일 목록 펼침
    this.tick = shared(TICK); this.onlyAt = shared(ONLY)?.at ?? 0;
    this.scroll = VirtualListScrollHandle.new();
    this.search = InputState.new({ placeholder: "제목·작성자·해시" });
    this.search.on("change", (_e, cx) => {
      const q = this.search.value().trim();
      if (q === this.query) return;
      this.query = q;
      // 글자마다 git을 돌리지 않게 잠깐 기다렸다가 찾는다.
      this.qTask?.cancel();
      this.qTask = cx.timer.after(250, (cx) => { if (!this.disposed) this.reload(cx); });
    });
    this.search.on("submit", (_e, cx) => { this.qTask?.cancel(); this.reload(cx); });
    this.refresh(cx);
    this.poll = cx.timer.every(10000, (cx) => { if (this.disposed) return; this.refresh(cx); });
  }

  // 앱을 끌 때(main.js): 10초 갱신 타이머와 검색 지연 타이머를 끊고 스크롤 핸들을 놓는다.
  dispose() {
    this.disposed = true;
    this.poll?.cancel(); this.poll = null;
    this.qTask?.cancel(); this.qTask = null;
    try { this.scroll?.release(); } catch { /* 이미 놓았으면 그만 */ }
    this.scroll = null;
    this.hideTip();
  }

  // 위치가 바뀌면 처음부터, 같으면 HEAD·작업 트리 변화만 확인한다. 끝나면 밖에서 부탁한 열기(pending)를 처리한다.
  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) this.reset({ key: next, cwd, on });
    if (!cwd) { this.state = "nofolder"; this.pending = null; return; }
    if (this.checking) return;
    const context = this.context;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (!this.current(context)) return;
          if (top.code !== 0) { this.state = "norepo"; this.error = "git 저장소가 아닙니다"; this.pending = null; return; }
          this.root = top.stdout.trim(); this.on = on;
          // 메뉴 "브라우저로 열기"용: origin이 GitHub면 웹 주소를 기억해 둔다(기다리지 않는다).
          this.git(["remote", "get-url", "origin"]).then((r) => {
            if (this.current(context)) this.web = r.code === 0 ? githubUrl(r.stdout) : null;
          }).catch(() => null);
        }
        const [head, branch, status] = await Promise.all([
          this.git(["rev-parse", "--verify", "-q", "HEAD"]),
          this.git(["branch", "--show-current"]),
          this.git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"]),
        ]);
        if (!this.current(context)) return;
        const h = head.code === 0 ? head.stdout.trim() : null;
        this.branch = branch.stdout.trim() || (h ? `${h.slice(0, 7)} (분리됨)` : "");
        const dirty = status.code === 0 ? status.stdout.split("\0").filter(Boolean).length : 0, was = this.dirty;
        this.dirty = dirty;
        // "커밋 안 된 변경"을 보고 있으면: 다 커밋됐으면 닫고(새 맨 위 커밋이 자동으로 선택된다), 파일 수가 바뀌면 다시 읽는다.
        if (this.sel === WT && dirty !== was) this.choose(dirty ? WT : null, cx);
        this.state = h ? "ok" : "nocommit";
        this.error = h ? null : "커밋이 없습니다";
        if (h !== this.head) { this.head = h; if (h) this.reload(cx); else this.commits = []; }
      } catch (e) {
        if (this.current(context)) { this.state = "error"; this.error = String(e?.message ?? e).slice(0, 200); }
      } finally {
        if (this.context === context) { this.checking = false; this.flush(cx); }
        cx.notify();
      }
    });
  }

  reset(context) {
    this.context = context; this.root = null; this.on = context.on; this.head = undefined; this.branch = ""; this.web = null;
    this.commits = []; this.more = false; this.logGen = (this.logGen ?? 0) + 1; this.loading = false; this.error = null; this.dirty = 0;
    this.checking = false; this.empty = null; this.state = "loading"; this.range = null;
    this.choose(null);
  }

  current(context) { return this.context === context && key() === context.key; }

  git(args, timeout = 30000) {
    return exec("git", [...READ, ...args], { cwd: this.root, on: this.on, timeout });
  }

  // 출력이 클 수 있는 명령(diff·log): stdout을 파이프로 받지 않고 임시 파일에 쓴 뒤 readTextFile로 읽는다.
  // exec의 큰 stdout 처리에 기대지 않고, 1MB가 넘으면 마지막 온전한 줄까지만 남긴다.
  // 돌려주는 값은 exec와 같은 모양 { code, stdout, stderr }.
  async viaFile(argv, timeout = 60000) {
    const script = `f=$(mktemp "\${TMPDIR:-/tmp}/herdr-commit.XXXXXX") || exit 97
"$@" >"$f" 2>"$f.err"; c=$?
if [ "$(wc -c <"$f")" -gt ${FILE_MAX} ]; then head -c ${FILE_MAX} "$f" | sed '$d' >"$f.t"; mv "$f.t" "$f"; fi
printf '%s\n%s' "$c" "$f"`;
    const r = await exec("sh", ["-c", script, "commit", ...argv], { cwd: this.root, on: this.on, timeout });
    const [code, file] = r.stdout.split("\n");
    if (r.code !== 0 || !file) return { code: r.code, stdout: "", stderr: r.stderr || "임시 파일을 만들지 못했습니다" };
    try {
      const [stdout, stderr] = await Promise.all([
        readTextFile(file, { on: this.on }),
        readTextFile(`${file}.err`, { on: this.on }).catch(() => ""),
      ]);
      if (stdout === null) return { code: -1, stdout: "", stderr: "출력 파일을 읽지 못했습니다(1MiB 초과이거나 UTF-8이 아님)" };
      return { code: Number(code), stdout, stderr: stderr ?? "" };
    } finally {
      exec("rm", ["-f", file, `${file}.err`], { on: this.on }).catch(() => null);
    }
  }

  // 목록 첫 쪽부터 다시(검색어가 바뀌었거나 HEAD가 움직였을 때)
  reload(cx) {
    if (!this.root || !this.head) return;
    this.logGen = (this.logGen ?? 0) + 1;
    this.page(0, cx);
  }

  loadMore(cx) {
    if (this.loading || !this.more) return;
    this.page(this.commits.length, cx);
  }

  // skip 다음부터 PAGE개. PAGE+1개를 받아 하나가 더 있으면 "더 불러오기"를 보인다.
  page(skip, cx) {
    const gen = this.logGen, context = this.context, q = this.query;
    this.loading = true;
    cx.spawn(async (cx) => {
      let list = null, err = null;
      try {
        const r = q
          ? await this.viaFile(["sh", "-c", SEARCH, "search", q, String(skip), String(PAGE + 1)])
          : await this.viaFile(["git", ...READ, "log", `-n${PAGE + 1}`, `--skip=${skip}`, `--format=${LOG_FORMAT}`, "HEAD"]);
        if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || "기록을 읽지 못했습니다");
        list = parseLog(r.stdout);
      } catch (e) { err = String(e?.message ?? e).slice(0, 200); }
      if (gen !== this.logGen || !this.current(context)) return;
      this.loading = false;
      if (err) { this.logError = err; cx.notify(); return; }
      this.logError = null;
      this.more = list.length > PAGE;
      const got = list.slice(0, PAGE);
      this.commits = skip ? [...this.commits, ...got] : got;
      // 처음 열 때는 맨 위 커밋을 보여 준다(밖에서 연 것이 기다리는 중이면 그쪽이 먼저).
      if (!this.sel && !this.pending && !this.closed && !q && this.commits[0]) this.choose(this.commits[0].hash, cx);
      cx.notify();
    });
    cx.notify();
  }

  // ── 밖에서 여는 진입점(셸이 office-apps.commit:· office-apps.range: 명령으로 부른다) ──
  // 앱이 막 만들어져 저장소 위치가 아직 없으면 pending에 두고, refresh가 위치를 정한 뒤 처리한다(flush).

  // hash: 커밋 해시(짧아도 됨) 또는 "WORKTREE"(커밋 안 된 변경). 목록에 없는 커밋도 상세로 연다.
  openCommit(hash, cx) {
    const h = String(hash ?? "").trim();
    if (!h) return;
    this.request({ kind: "commit", hash: h === "WORKTREE" ? WT : h }, cx);
  }

  // "base...head" 범위(merge-base부터 head까지)의 바뀐 파일과 diff.
  openRange(base, head, cx) {
    if (!base || !head) return;
    this.request({ kind: "range", base: String(base).trim(), head: String(head).trim() }, cx);
  }

  request(p, cx) {
    this.pending = p;
    if (this.root && this.context && this.current(this.context)) this.flush(cx);
    else this.refresh(cx);
    cx?.notify();
  }

  flush(cx) {
    const p = this.pending;
    if (!p || !this.root || !cx) return;
    this.pending = null; this.closed = false;
    if (p.kind === "range") { this.range = { base: p.base, head: p.head }; this.choose(RANGE, cx); }
    else this.choose(p.hash, cx);
  }

  // ── 셸 계약: 키보드(왼쪽 칸 ↑↓ · Enter)와 빈 상태 ──

  // 목록에 보이는 순서: "커밋 안 된 변경"(보일 때) + 커밋들. 가상 목록의 인덱스도 이 순서다(끝에 안내 줄이 붙을 수 있다).
  keys() {
    const wt = Boolean(this.dirty) && !this.query;
    return [...(wt ? [WT] : []), ...(this.commits ?? []).map((c) => c.hash)];
  }

  move(delta, cx) {
    const keys = this.keys();
    if (!keys.length) return;
    const at = keys.indexOf(this.sel);
    const i = at < 0 ? (delta > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, at + delta));
    if (i >= keys.length - 1) this.loadMore(cx);
    this.closed = false;
    if (keys[i] !== this.sel) this.choose(keys[i], cx);
    this.scroll?.scroll_to_item(i);
    cx?.notify();
  }

  // Enter: 바뀐 파일 첫 개의 diff를 띄운다(이미 파일을 보고 있으면 그대로).
  activate(cx) {
    if (!this.files.length || this.file) return;
    this.openFile(this.files[0].path, cx);
    cx?.notify();
  }

  emptyState() {
    const where = (this.root ?? this.context?.cwd ?? "").replace(home(), "~");
    if (this.state === "nofolder") return { text: "폴더가 없습니다", sub: "스페이스나 패인에 폴더를 여세요" };
    if (this.state === "norepo") return { text: "git 저장소가 아닙니다", sub: where };
    if (this.state === "nocommit") return { text: "커밋이 없습니다", sub: where };
    if (this.state === "error") return { text: "기록을 읽지 못했습니다", sub: this.error ?? "" };
    if (this.state === "loading" || (this.loading && !this.commits.length)) return { text: "읽는 중", sub: where };
    return { text: "선택 내용이 없습니다", sub: "왼쪽에서 커밋을 고르세요" };
  }

  // ── 상세 읽기 ──

  // 커밋(또는 WT·RANGE)을 고른다. 상세·파일 목록을 읽고 첫 파일의 diff를 띄운다.
  choose(hash, cx) {
    this.hideTip();
    this.sel = hash; this.info = null; this.files = []; this.filesCut = false; this.detailError = null; this.bodyOpen = false; this.filesOpen = true;
    this.selGen = (this.selGen ?? 0) + 1;
    this.openFile(null);
    if (!hash || !cx || !this.root) return;
    const gen = this.selGen, range = this.range;
    cx.spawn(async (cx) => {
      try {
        const d = hash === WT ? await this.worktree() : hash === RANGE ? await this.rangeDetail(range) : await this.commit(hash);
        if (gen !== this.selGen) return;
        // 짧은 해시나 이름으로 열었으면 전체 해시로 맞춰 목록 선택 표시가 붙게 한다.
        if (hash !== WT && hash !== RANGE && d.info.hash) {
          this.sel = d.info.hash;
          const i = this.keys().indexOf(this.sel);
          if (i >= 0) this.scroll?.scroll_to_item(i);
        }
        this.info = d.info; this.files = d.files; this.filesCut = d.cut;
        if (this.files[0]) this.openFile(this.files[0].path, cx);
      } catch (e) { if (gen === this.selGen) this.detailError = String(e?.message ?? e).slice(0, 200); }
      cx.notify();
    });
  }

  // 커밋 상세: 머지 커밋은 첫 부모 기준, 처음 커밋은 빈 트리 기준.
  async commit(hash) {
    const show = await this.git(["show", "-s", `--format=${SHOW_FORMAT}`, hash, "--"]);
    if (show.code !== 0) throw new Error(firstLine(show.stderr) || "커밋을 읽지 못했습니다");
    const info = parseShow(show.stdout);
    info.base = info.parents[0] ?? await this.emptyTree();
    const [ns, nm] = await Promise.all([
      this.git(["diff", "--no-ext-diff", "--name-status", "-z", "-M", info.base, info.hash]),
      this.git(["diff", "--no-ext-diff", "--numstat", "-z", "-M", info.base, info.hash]),
    ]);
    if (ns.code !== 0) throw new Error(firstLine(ns.stderr) || "바뀐 파일을 읽지 못했습니다");
    const names = parseNameStatus(ns.stdout);
    return { info, files: mergeFiles(names, parseNumstat(nm.stdout)), cut: names.length > 1000 };
  }

  // 범위 비교: git diff base...head (base와 head의 merge-base부터 head까지)
  async rangeDetail(range) {
    if (!range) throw new Error("비교할 범위가 없습니다");
    const spec = `${range.base}...${range.head}`;
    const [ns, nm] = await Promise.all([
      this.git(["diff", "--no-ext-diff", "--name-status", "-z", "-M", spec, "--"]),
      this.git(["diff", "--no-ext-diff", "--numstat", "-z", "-M", spec, "--"]),
    ]);
    if (ns.code !== 0) throw new Error(firstLine(ns.stderr) || "범위를 비교하지 못했습니다");
    const names = parseNameStatus(ns.stdout);
    return { info: { range: spec }, files: mergeFiles(names, parseNumstat(nm.stdout)), cut: names.length > 1000 };
  }

  async emptyTree() {
    if (this.empty) return this.empty;
    const r = await this.git(["hash-object", "-t", "tree", "/dev/null"]);
    this.empty = r.stdout.trim();
    return this.empty;
  }

  // 커밋 안 된 변경: HEAD와 작업 트리의 차이 + 추적 안 된 파일
  async worktree() {
    const [ns, nm, un] = await Promise.all([
      this.git(["diff", "--no-ext-diff", "--name-status", "-z", "-M", "HEAD"]),
      this.git(["diff", "--no-ext-diff", "--numstat", "-z", "-M", "HEAD"]),
      this.git(["ls-files", "-o", "--exclude-standard", "-z"]),
    ]);
    if (ns.code !== 0) throw new Error(firstLine(ns.stderr) || "변경을 읽지 못했습니다");
    const names = [...parseNameStatus(ns.stdout), ...un.stdout.split("\0").filter(Boolean).map((path) => ({ status: "?", path }))];
    return { info: { worktree: true }, files: mergeFiles(names, parseNumstat(nm.stdout)), cut: names.length > 1000 };
  }

  // diff에 쓸 범위 인자
  diffRange(info) {
    return info.worktree ? ["HEAD"] : info.range ? [info.range] : [info.base, info.hash];
  }

  // 오른쪽 diff에 파일 하나를 띄운다.
  openFile(path, cx) {
    this.file = path; this.rows = []; this.pairs = []; this.diffW = 300; this.splitW = 300; this.diffNote = null; this.diffWhy = null; this.diffCut = false; this.diffBig = false; this.diffLoading = false;
    this.fileGen = (this.fileGen ?? 0) + 1;
    if (!path || !cx) return;
    const gen = this.fileGen, f = this.files.find((x) => x.path === path), info = this.info;
    if (!f || !info) return;
    if (f.binary) { this.diffNote = "바이너리 파일입니다"; return; }
    if (f.add + f.del > BIG) { this.diffNote = "diff가 너무 커서 열지 않았습니다"; this.diffBig = true; return; }
    this.diffLoading = true;
    cx.spawn(async (cx) => {
      // why: 실패했을 때 실제 원인(exec 거부 메시지, git 종료 코드·stderr 첫 줄, 처리 중 예외). 흐린 글자로 보여 준다.
      let out = null, note = null, why = null, rows = null;
      try {
        if (f.status === "?") {
          const text = await readTextFile(`${this.root}/${path}`, { on: this.on });
          if (text === null) note = "읽을 수 없는 파일입니다(바이너리이거나 1MiB 초과)";
          else if (text.includes("\0")) note = "바이너리 파일입니다";
          else { out = addedLines(String(text)); f.add = out.count; }
        } else {
          const paths = f.old ? [f.old, path] : [path];
          const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", ...this.diffRange(info), "--", ...paths];
          // 한 번 실패하면(다른 앱의 git·gh와 겹쳐 시간 초과 등) 한 번만 다시 시도한다.
          let r = null, fail = null;
          for (let i = 0; i < 2 && r === null; i++) {
            try {
              const x = await this.viaFile(["git", ...READ, ...args]);
              const stdout = typeof x?.stdout === "string" ? x.stdout : String(x?.stdout ?? "");
              // 종료 코드가 0이 아니어도 diff가 나왔으면 쓴다.
              if (x?.code === 0 || stdout.includes("\n@@ ") || stdout.startsWith("@@ ")) r = stdout;
              else fail = `git 종료 코드 ${x?.code}: ${firstLine(x?.stderr) || "stderr 없음"} (stdout ${stdout.length}자)`;
            } catch (e) { fail = `exec 실패: ${firstLine(e?.message ?? e)}`; }
          }
          if (r === null) { note = "diff를 읽지 못했습니다"; why = fail; }
          else {
            out = diffLines(r);
            if (!out) note = f.status === "R" ? "내용은 그대로이고 이름만 바뀌었습니다" : "보여 줄 텍스트 차이가 없습니다";
          }
        }
        // 줄 번호 → 줄 안 바뀐 구간(wordSpans). 좌우 보기용 짝은 미리 만들어 둔다.
        if (out) rows = wordSpans(diffRows(out.lines));
      } catch (e) { note = "diff를 그리지 못했습니다"; why = `처리 중 오류: ${firstLine(e?.message ?? e)}`; rows = null; }
      if (why) console.log(`[commit] ${path}: ${why}`);
      if (gen !== this.fileGen) return;
      this.diffLoading = false;
      if (rows) {
        const pairs = splitRows(rows);
        this.rows = rows; this.pairs = pairs; this.diffCut = out.cut; this.diffW = inlineWidth(rows); this.splitW = splitWidth(pairs);
      }
      this.diffNote = note; this.diffWhy = why;
      cx.notify();
    });
  }

  async copy(text, what) { await copyText(text, what); }

  // 터미널 탭에서 git show/diff로 보기(diff가 너무 클 때)
  inTerminal(path) {
    const info = this.info;
    if (!info) return;
    const argv = info.worktree ? ["git", "diff", "HEAD", "--", path]
      : info.range ? ["git", "diff", info.range, "--", path]
        : ["git", "show", info.hash, "--", path];
    run("tab.new", { name: `diff ${path.split("/").pop()}`, folder: this.root, argv });
    run("layout.show", { id: "office-term" });
  }

  // 메뉴 ctx(값만): 커밋 줄
  commitCtx(c) {
    return { kind: "commit", hash: c.hash, short: c.short, subject: c.subject, merge: c.parents.length > 1, root: this.root, on: this.on, web: this.web };
  }

  // 메뉴 ctx(값만): 바뀐 파일 줄. 파일 앱은 포커스된 폴더(cwd) 기준 경로를 쓰므로, 저장소 기준 경로를 바꿔 넘긴다.
  // 지운 파일이거나 cwd 밖의 파일이면 "파일 앱으로 열기"를 숨긴다(show: null).
  fileCtx(f) {
    const cwd = (this.context?.cwd ?? "").replace(/\/+$/, ""), root = this.root ?? "";
    let show = null;
    if (f.status !== "D" && root) {
      if (cwd === root) show = f.path;
      else if (cwd.startsWith(`${root}/`)) {
        const pre = `${cwd.slice(root.length + 1)}/`;
        if (f.path.startsWith(pre)) show = f.path.slice(pre.length);
      }
    }
    return { kind: "file", path: f.path, status: f.status, show, sel: this.sel };
  }

  // 툴팁: files.js와 같은 창 오버레이(역할 tip)
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

  // 툴팁이 붙는 작은 요소
  tipped(el, id, tip) {
    return el.on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); });
  }

  // 렌더 때 공유 상태 변화를 받는다: 다른 곳에서 git을 바꿨으면(TICK) 다시 읽고,
  // 메뉴의 "이 파일의 diff만 보기"(ONLY)면 그 파일을 띄우고 파일 목록을 접는다.
  sync(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const tick = shared(TICK);
    if (tick !== this.tick) { this.tick = tick; this.refresh(cx); }
    const only = shared(ONLY);
    if ((only?.at ?? 0) !== this.onlyAt) {
      this.onlyAt = only?.at ?? 0;
      if (only?.path && only.sel === this.sel && this.files.some((f) => f.path === only.path)) {
        this.filesOpen = false;
        if (this.file !== only.path) this.openFile(only.path, cx);
      }
    }
  }

  // ── 왼쪽 ──────────────────────────────────────────────

  list(cx, t) {
    this.sync(cx);
    const commits = this.commits ?? [], wt = Boolean(this.dirty) && !this.query;
    const footer = this.more || this.loading || this.logError || (!commits.length && !wt);
    // 작성자는 최근 커밋의 작성자가 여럿일 때만 흐리게 붙인다(혼자 쓰는 저장소에선 늘 같은 이름이라 뺀다).
    const authors = new Set(commits.slice(0, 50).map((c) => c.author)).size > 1;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(34).flex_none().pl(10).pr(4).gap(6).items_center().border_b_1().border_color(t.border)
        .child(svg(I("search")).size(14).flex_none().text_color(this.query ? "#a7c080" : t.muted))
        .child(div().flex_1().min_w(0).child(this.search ? Input.new(this.search).h(26).text_size(12).text_color(t.foreground) : div()))
        .when(Boolean(this.query), (el) => el.child(div().id("commit-clear").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.search.set_value(""); this.query = ""; this.reload(cx); })
          .child(svg(I("close")).size(14).text_color(t.muted))))
        .child(this.tipped(div().id("commit-refresh").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover)), "refresh", "다시 읽기")
          .on_click((_e, cx) => { this.hideTip(); this.head = undefined; this.refresh(cx); })
          .child(svg(I("refresh")).size(16).text_color("#7fbbb3"))))
      .child(this.logList(t, wt, commits, footer, authors));
  }

  // 커밋 목록(가상 목록): "커밋 안 된 변경"(wt) + 커밋들 + 끝 안내 줄(footer). 인덱스가 keys()와 같아
  // 키보드 이동 때 scroll_to_item(i)이 맞는 줄을 보인다. 렌더러 안에는 핸들러를 둘 수 없어
  // 클릭·우클릭은 목록의 on_item_click / on_item_secondary_click이 키(해시 · WT · FOOT_KEY)로 받는다.
  logList(t, wt, commits, footer, authors) {
    const keys = [...(wt ? [WT] : []), ...commits.map((c) => c.hash), ...(footer ? [FOOT_KEY] : [])];
    const sizes = keys.map((k) => (k === FOOT_KEY ? FOOT : ROW));
    const off = wt ? 1 : 0;
    const render = (range) => keys.slice(range.start, range.end).map((k, j) => k === WT ? this.wtRow(t)
      : k === FOOT_KEY ? this.footer(t) : this.commitRow(commits[range.start + j - off], t, authors));
    return div().flex_1().min_h(0).relative()
      .child(v_virtual_list("commit-log", keys.length, sizes, (i) => keys[i], render).size_full()
        .when(Boolean(this.scroll), (el) => el.track_scroll(this.scroll))
        .on_item_click((k, cx) => {
          if (k === FOOT_KEY) { this.loadMore(cx); cx.notify(); return; }
          this.closed = false; this.choose(k, cx); cx.notify();
        })
        .on_item_secondary_click((k, _e, cx) => {
          const c = commits.find((x) => x.hash === k);
          if (!c) return;
          cx.stop_propagation(); this.hideTip(); openMenu(this.commitCtx(c));
        }))
      .child(Scrollbar.vertical("commit-log").viewport_from_layout().absolute().inset_0());
  }

  // 한 줄: 제목 · (작성자) · 짧은 상대 시각
  // 가상 목록 렌더러 안에서 그리므로 핸들러를 달지 않는다(logList가 받는다). 바깥 줄이 목록 폭·높이를 채우고 안쪽이 둥근 칸.
  commitRow(c, t, authors) {
    const sub = splitSubject(c.subject);
    return div().w_full().h(ROW).px(4).child(h_flex().id(`commit-row-${c.hash}`).size_full().px(10).gap(8).items_center().rounded(4)
      .cursor_pointer().hover((s) => s.bg(t.hover)).when(this.sel === c.hash, (el) => el.bg(t.selected))
      // 접두(type(scope):)는 앞에 흐린 작은 scope만 남겨 본문 제목이 먼저 보이게. 원문은 상세 머리에 그대로.
      .when(Boolean(sub.tag), (el) => el.child(div().flex_none().max_w(96).truncate().text_size(11).text_color(t.dim).child(sub.tag)))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(sub.text || "(제목 없음)"))
      .when(authors, (el) => el.child(div().flex_none().max_w(72).truncate().text_size(11).text_color(t.dim).child(c.author)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(agoShort(c.at))));
  }

  wtRow(t) {
    return div().w_full().h(ROW).px(4).child(h_flex().id("commit-row-worktree").size_full().px(10).gap(8).items_center().rounded(4)
      .cursor_pointer().hover((s) => s.bg(t.hover)).when(this.sel === WT, (el) => el.bg(t.selected))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child("커밋 안 된 변경"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${this.dirty}개`)));
  }

  footer(t) {
    const text = this.logError ?? (this.loading ? "읽는 중" : this.error ?? (!this.commits?.length
      ? (this.query ? "맞는 커밋이 없습니다" : this.root ? "커밋이 없습니다" : this.context?.cwd ? "읽는 중" : "폴더가 없습니다") : null));
    if (text || !this.more) return h_flex().w_full().h(FOOT).px(14).items_center().text_size(12).text_color(t.dim).child(text ?? "");
    // 누르는 일은 logList의 on_item_click(FOOT_KEY)이 받는다(렌더러 안 핸들러 금지).
    return h_flex().w_full().h(FOOT).px(10).items_center()
      .child(div().id("commit-more").px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.foreground)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .child(`${PAGE}개 더 불러오기`));
  }

  // 위 막대 부제: 브랜치 · 저장소 경로
  subtitle(t) {
    const where = (this.root ?? this.context?.cwd ?? "").replace(home(), "~");
    return h_flex().gap(8).items_center().min_w(0)
      .when(Boolean(this.branch), (el) => el.child(h_flex().flex_none().gap(4).items_center()
        .child(svg(I("branch")).size(13).text_color(t.muted))
        .child(div().text_size(12).text_color(t.foreground).child(this.branch))))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where));
  }

  // ── 오른쪽: 머리줄 / 본문 첫 문단 / 바뀐 파일 / diff ──────────────

  detail(cx, t) {
    if (!this.sel) return null;
    const info = this.info, wt = this.sel === WT, range = this.sel === RANGE;
    const c = wt || range ? null : (this.commits ?? []).find((x) => x.hash === this.sel);
    const subject = wt ? "커밋 안 된 변경"
      : range ? `${this.range?.base ?? ""}...${this.range?.head ?? ""} 비교`
        : info?.subject ?? c?.subject ?? "";
    const hash = wt || range ? null : info?.hash ?? c?.hash ?? null;
    const at = wt || range ? null : info?.at ?? c?.at ?? null;
    const paras = wt || range ? [] : bodyParagraphs(info?.body);
    return v_flex().id("commit-detail").size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(subject))
        .when(Boolean(hash), (el) => el.child(this.tipped(h_flex().id("commit-hash").flex_none().px(8).py(3).gap(5).items_center().rounded(6)
          .border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover)), "hash", "전체 해시 복사")
          .on_click(() => { this.hideTip(); this.copy(hash, "해시"); })
          .child(div().text_size(12).font_family(CODE_FONT).text_color(t.muted).child(c?.short ?? hash.slice(0, 7)))
          .child(svg(I("copy")).size(13).text_color(t.muted))))
        .when(Boolean(at), (el) => el.child(this.tipped(div().id("commit-at").flex_none().text_size(12).text_color(t.dim), "at", stamp(at))
          .child(ago(at))))
        .child(div().id("commit-close").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.closed = true; this.choose(null); cx.notify(); }).child("✕")))
      .when(paras.length > 0, (el) => el.child(this.body(paras, t)))
      .child(this.fileSection(t))
      .child(v_flex().flex_1().min_h(0).child(this.diffView(t)));
  }

  // 본문: 접혀 있으면 첫 문단을 한 줄로, 누르면 트레일러를 뺀 본문 전체.
  body(paras, t) {
    const el = div().id("commit-body").flex_none().px(14).py(6).border_b_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.bodyOpen = !this.bodyOpen; cx.notify(); });
    if (!this.bodyOpen) return el.child(div().truncate().text_size(12).text_color(t.muted).child(paras[0].replace(/\s*\n\s*/g, " ")));
    const lines = paras.join("\n\n").split("\n").slice(0, 200);
    // 긴 줄은 줄바꿈한다. 높이는 대략 줄 수로 잡고 넘치면 스크롤.
    return el.child(v_flex().id("commit-body-text").h(Math.min(lines.length, BODY_ROWS) * BODY_LINE).overflow_y_scrollbar()
      .text_size(12).text_color(t.foreground).children(lines.map((l) => div().min_h(BODY_LINE).flex_none().child(l || " "))));
  }

  // 바뀐 파일: 접기 머리줄(파일 수 · 접혔을 때는 보고 있는 파일 · +/−) + 목록(FILE_ROWS줄 넘으면 스크롤)
  fileSection(t) {
    if (this.detailError) return div().flex_none().px(14).py(10).border_b_1().border_color(t.border).text_size(12).text_color(t.ansi1).child(this.detailError);
    if (!this.info) return div().flex_none().px(14).py(10).border_b_1().border_color(t.border).text_size(12).text_color(t.dim).child("읽는 중");
    const files = this.files, n = files.length;
    if (!n) return div().flex_none().px(14).py(10).border_b_1().border_color(t.border).text_size(12).text_color(t.dim).child("바뀐 파일이 없습니다");
    const add = files.reduce((s, f) => s + f.add, 0), del = files.reduce((s, f) => s + f.del, 0), open = this.filesOpen;
    // 머리줄: 왼쪽(누르면 접기) · +/− · 오른쪽 끝에 diff 보기 전환(위아래 | 좌우)
    const head = h_flex().h(30).flex_none().pr(10).gap(6).items_center()
      .child(h_flex().id("commit-files-head").flex_1().min_w(0).h_full().pl(10).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.filesOpen = !this.filesOpen; cx.notify(); })
        .child(svg(I(open ? "chevron-down" : "chevron-right")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(`파일 ${n}${this.filesCut ? "+" : ""}개`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(!open && this.file ? this.file : "")))
      .when(add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(modeToggle(t, "commit", this.narrow()));
    return v_flex().flex_none().border_b_1().border_color(t.border)
      .child(head)
      .when(open, (el) => el.child(v_flex().id("commit-files").h(Math.min(n, FILE_ROWS) * FILE_ROW + 4).flex_none().overflow_y_scrollbar().px(4).pb(4)
        .children(files.map((f) => this.fileRow(f, t)))
        .when(this.filesCut, (el) => el.child(div().h(FILE_ROW).flex_none().px(8).flex().items_center().text_size(11).text_color(t.dim).child("앞 1,000개만 보여 줍니다")))));
  }

  // 좌우 모드를 골랐어도 diff 칸이 좁으면 위아래로 그린다. 모드는 그릴 때마다 읽는다(PR 앱에서 바꾼 것도 따른다).
  narrow() { return (this.dw ?? 1000) < NARROW; }
  split() { return diffMode() === "split" && !this.narrow(); }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const color = f.status === "A" || f.status === "?" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "R" ? t.ansi5 : t.ansi4;
    return h_flex().id(`commit-file-${f.path}`).h(FILE_ROW).flex_none().px(8).gap(6).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(this.file === f.path, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.openFile(f.path, cx); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.hideTip(); openMenu(this.fileCtx(f)); })
      .child(this.tipped(div().id(`commit-st-${f.path}`).w(12).flex_none().text_size(11).text_color(color), `st-${f.path}`,
        f.old ? `${STATUS[f.status]}: ${f.old}` : STATUS[f.status] ?? f.status).child(f.status === "?" ? "A" : f.status))
      .child(div().flex_none().max_w(260).truncate().text_size(12).text_color(f.status === "D" ? t.muted : t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
      .when(f.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // 고른 파일의 diff. 파일 이름은 위 파일 목록(선택 표시)이나 접힌 머리줄에 이미 있으니 따로 머리줄을 두지 않는다.
  diffView(t) {
    if (!this.file) return v_flex().flex_1();
    const rows = this.rows ?? [];
    let body;
    if (this.diffNote || (!rows.length && !this.diffLoading)) {
      body = v_flex().flex_1().items_center().justify_center().gap(10)
        .child(div().text_size(12).text_color(t.dim).child(this.diffNote ?? ""))
        .when(Boolean(this.diffWhy), (el) => el.child(div().max_w(560).px(16).text_size(11).text_color(t.dim).opacity(0.75).child(this.diffWhy)))
        .when(Boolean(this.diffBig), (el) => el.child(div().id("commit-in-term").px(10).py(4).rounded(6).border_1().border_color(t.border)
          .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => this.inTerminal(this.file)).child("터미널에서 보기")));
    } else if (!rows.length) {
      body = v_flex().flex_1().items_center().justify_center().text_size(12).text_color(t.dim).child("읽는 중");
    } else {
      const s = settings()?.dark, pal = diffPalette(t, typeof s === "boolean" ? s : isDark(t));
      const split = this.split(), pairs = this.pairs ?? [];
      const n = split ? pairs.length : rows.length;
      body = div().flex_1().min_h(0).relative().font_family(CODE_FONT).text_size(12)
        .child(div().id("commit-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w((split ? this.splitW : this.diffW) ?? 300).h_full()
            .child(v_virtual_list("commit-diff", n, DIFF_LINE, (i) => `${split ? "s" : "i"}${i}`,
              (range) => split
                ? pairs.slice(range.start, range.end).map((p) => splitRow(p, t, pal))
                : rows.slice(range.start, range.end).map((row) => inlineRow(row, t, pal))).size_full())))
        .child(Scrollbar.vertical("commit-diff").viewport_from_layout().absolute().inset_0());
    }
    return v_flex().id("commit-diff-area").flex_1().min_h(0).child(body)
      .on_size_change((size, cx) => { if (Math.abs((this.dw ?? 0) - size.width) > 4) { this.dw = size.width; cx.notify(); } })
      .when(Boolean(this.diffCut), (el) => el.child(div().flex_none().px(12).py(4).border_t_1().border_color(t.border)
        .text_size(11).text_color(t.dim).child("앞 1,500줄만 보여 줍니다")));
  }
}

// 확인 창(menu.js Confirm)과 오버레이 역할 표(files.js ROLES)에 이 앱의 것을 더한다. 키는 모두 commit으로 시작한다.
// main.js가 ROLES를 모듈을 읽을 때 복사하므로 최상위에서 한 번 부른다(오버레이 복사본에도 들어간다).
function register() {
  for (const [k, f] of Object.entries(ACT)) ACTIONS[`commit.${k}`] = f;
  ROLES["commit-menu"] = CommitMenu;
}
register();
