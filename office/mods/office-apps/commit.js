// 커밋 앱: 지금 스페이스(포커스된 패인)의 git 저장소에서 현재 브랜치의 커밋 기록을 본다.
//   왼쪽: 검색 + 커밋 목록(200개씩, 더 불러오기). 맨 위에 "커밋 안 된 변경"(있을 때만).
//   오른쪽: 고른 커밋의 제목·본문·작성자·시각·해시, 바뀐 파일, 고른 파일의 diff.
// git은 읽기만 한다(.git 아래에 아무것도 쓰지 않는 옵션). 파싱은 commit/git.js.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, theme, home, run, openOverlay, closeOverlay, notify } from "herdr";
import {
  PAGE, BIG, READ, LOG_FORMAT, SHOW_FORMAT, SEARCH, parseLog, parseShow, parseNameStatus, parseNumstat, mergeFiles,
  diffLines, addedLines, diffRows, columns, ago, stamp,
} from "./commit/git.js";

const ME = "mods/office-apps";
const CODE_FONT = "D2Coding";
const WT = "@worktree";       // "커밋 안 된 변경" 항목의 선택 키
const ROW = 44;               // 목록 한 줄 높이(제목 + 작은 글자 한 줄)
const LINE = 20;              // diff 한 줄 높이
const FILE_MAX = 1000000;     // 임시 파일로 받은 출력의 상한(readTextFile은 1MiB까지)
const STATUS = { A: "추가", M: "수정", D: "삭제", R: "이름 바뀜", C: "복사", T: "형식 바뀜", U: "충돌", "?": "새 파일" };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const firstLine = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 200);

export class CommitApp {
  init(_props, cx) {
    this.commits = []; this.files = []; this.rows = [];
    this.query = "";
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

  // 앱을 끌 때(main.js toggle): 10초 갱신 타이머와 검색 지연 타이머를 끊는다.
  dispose() {
    this.disposed = true;
    this.poll?.cancel(); this.poll = null;
    this.qTask?.cancel(); this.qTask = null;
  }

  // 위치가 바뀌면 처음부터, 같으면 HEAD·작업 트리 변화만 확인한다.
  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) this.reset({ key: next, cwd, on });
    if (!cwd || this.checking) return;
    const context = this.context;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (!this.current(context)) return;
          if (top.code !== 0) { this.error = "git 저장소가 아닙니다"; return; }
          this.root = top.stdout.trim(); this.on = on;
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
        // "커밋 안 된 변경"을 보고 있으면: 다 커밋됐으면 닫고, 파일 수가 바뀌면 다시 읽는다.
        if (this.sel === WT && dirty !== was) this.choose(dirty ? WT : null, cx);
        this.error = h ? null : "커밋이 없습니다";
        if (h !== this.head) { this.head = h; if (h) this.reload(cx); else this.commits = []; }
      } catch (e) { if (this.current(context)) this.error = String(e?.message ?? e).slice(0, 200); }
      finally { if (this.context === context) this.checking = false; cx.notify(); }
    });
  }

  reset(context) {
    this.context = context; this.root = null; this.on = context.on; this.head = undefined; this.branch = "";
    this.commits = []; this.more = false; this.logGen = (this.logGen ?? 0) + 1; this.loading = false; this.error = null; this.dirty = 0;
    this.checking = false; this.empty = null;
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
      // 처음 열 때는 맨 위 커밋을 보여 준다.
      if (!this.sel && !this.closed && !q && this.commits[0]) this.choose(this.commits[0].hash, cx);
      cx.notify();
    });
    cx.notify();
  }

  // 커밋(또는 WT)을 고른다. 상세·파일 목록을 읽고 첫 파일의 diff를 띄운다.
  choose(hash, cx) {
    this.hideTip();
    this.sel = hash; this.info = null; this.files = []; this.filesCut = false; this.detailError = null;
    this.selGen = (this.selGen ?? 0) + 1;
    this.openFile(null);
    if (!hash || !cx || !this.root) return;
    const gen = this.selGen;
    cx.spawn(async (cx) => {
      try {
        const d = hash === WT ? await this.worktree() : await this.commit(hash);
        if (gen !== this.selGen) return;
        this.info = d.info; this.files = d.files; this.filesCut = d.cut;
        if (this.files[0]) this.openFile(this.files[0].path, cx);
      } catch (e) { if (gen === this.selGen) this.detailError = String(e?.message ?? e).slice(0, 200); }
      cx.notify();
    });
  }

  // 커밋 상세: 머지 커밋은 첫 부모 기준, 처음 커밋은 빈 트리 기준.
  async commit(hash) {
    const show = await this.git(["show", "-s", `--format=${SHOW_FORMAT}`, hash]);
    if (show.code !== 0) throw new Error(show.stderr.trim() || "커밋을 읽지 못했습니다");
    const info = parseShow(show.stdout);
    info.base = info.parents[0] ?? await this.emptyTree();
    const [ns, nm] = await Promise.all([
      this.git(["diff", "--no-ext-diff", "--name-status", "-z", "-M", info.base, hash]),
      this.git(["diff", "--no-ext-diff", "--numstat", "-z", "-M", info.base, hash]),
    ]);
    if (ns.code !== 0) throw new Error(ns.stderr.trim() || "바뀐 파일을 읽지 못했습니다");
    const names = parseNameStatus(ns.stdout);
    return { info, files: mergeFiles(names, parseNumstat(nm.stdout)), cut: names.length > 1000 };
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
    if (ns.code !== 0) throw new Error(ns.stderr.trim() || "변경을 읽지 못했습니다");
    const names = [...parseNameStatus(ns.stdout), ...un.stdout.split("\0").filter(Boolean).map((path) => ({ status: "?", path }))];
    return { info: { worktree: true }, files: mergeFiles(names, parseNumstat(nm.stdout)), cut: names.length > 1000 };
  }

  // 오른쪽 diff에 파일 하나를 띄운다.
  openFile(path, cx) {
    this.file = path; this.rows = []; this.diffW = 300; this.diffNote = null; this.diffWhy = null; this.diffCut = false; this.diffBig = false; this.diffLoading = false;
    this.fileGen = (this.fileGen ?? 0) + 1;
    if (!path || !cx) return;
    const gen = this.fileGen, f = this.files.find((x) => x.path === path), info = this.info, sel = this.sel;
    if (!f || !info) return;
    if (f.binary) { this.diffNote = "바이너리 파일입니다"; return; }
    if (f.add + f.del > BIG) { this.diffNote = "diff가 너무 커서 열지 않았습니다"; this.diffBig = true; return; }
    this.diffLoading = true;
    cx.spawn(async (cx) => {
      // why: 실패했을 때 실제 원인(exec 거부 메시지, git 종료 코드·stderr 첫 줄, 처리 중 예외). 흐린 글자로 보여 준다.
      let out = null, note = null, why = null, rows = null, width = 300;
      try {
        if (f.status === "?") {
          const text = await readTextFile(`${this.root}/${path}`, { on: this.on });
          if (text === null) note = "읽을 수 없는 파일입니다(바이너리이거나 1MiB 초과)";
          else if (text.includes("\0")) note = "바이너리 파일입니다";
          else { out = addedLines(String(text)); f.add = out.count; }
        } else {
          const paths = f.old ? [f.old, path] : [path];
          const range = sel === WT ? ["HEAD"] : [info.base, info.hash];
          const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", ...range, "--", ...paths];
          // 한 번 실패하면(다른 앱의 git·gh와 겹쳐 시간 초과 등) 한 번만 다시 시도한다.
          let r = null, fail = null;
          for (let i = 0; i < 2 && !r; i++) {
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
        if (out) {
          rows = diffRows(out.lines);
          for (const row of rows) width = Math.max(width, columns(row.text) * 7 + 100);
        }
      } catch (e) { note = "diff를 그리지 못했습니다"; why = `처리 중 오류: ${firstLine(e?.message ?? e)}`; rows = null; }
      if (why) console.log(`[commit] ${path}: ${why}`);
      if (gen !== this.fileGen) return;
      this.diffLoading = false;
      if (rows) { this.rows = rows; this.diffCut = out.cut; this.diffW = width; }
      this.diffNote = note; this.diffWhy = why;
      cx.notify();
    });
  }

  async copy(text, what) {
    await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(() => null);
    notify({ title: `${what}를 복사했습니다`, body: text, level: "info" });
  }

  // 터미널 탭에서 git show/diff로 보기(diff가 너무 클 때)
  inTerminal(path) {
    const argv = this.sel === WT ? ["git", "diff", "HEAD", "--", path] : ["git", "show", this.info.hash, "--", path];
    run("tab.new", { name: `diff ${path.split("/").pop()}`, folder: this.root, argv });
    run("layout.show", { id: "office-term" });
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

  // 툴팁이 붙는 작은 버튼
  tipped(el, id, tip) {
    return el.on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); });
  }

  // ── 왼쪽 ──────────────────────────────────────────────

  list(cx, t) {
    if (key() !== this.context?.key) this.refresh(cx);
    const commits = this.commits ?? [], wt = Boolean(this.dirty) && !this.query;
    const footer = this.more || this.loading || this.logError || (!commits.length && !wt);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(34).flex_none().pl(10).pr(4).gap(6).items_center().border_b_1().border_color(t.border)
        .child(svg(`${ME}/search.svg`).size(14).flex_none().text_color(this.query ? "#a7c080" : t.muted))
        .child(div().flex_1().min_w(0).child(this.search ? Input.new(this.search).h(26).text_size(12).text_color(t.foreground) : div()))
        .when(Boolean(this.query), (el) => el.child(div().id("commit-clear").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.search.set_value(""); this.query = ""; this.reload(cx); })
          .child(svg(`${ME}/close.svg`).size(14).text_color(t.muted))))
        .child(this.tipped(div().id("commit-refresh").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover)), "refresh", "다시 읽기")
          .on_click((_e, cx) => { this.hideTip(); this.head = undefined; this.refresh(cx); })
          .child(svg(`${ME}/refresh.svg`).size(16).text_color("#7fbbb3"))))
      // 행마다 클릭·hover가 있어 가상 목록(렌더러 안 핸들러 금지) 대신 files.js처럼 그냥 스크롤 목록으로 그린다.
      .child(v_flex().id("commit-log").flex_1().min_h(0).overflow_y_scrollbar().py(4)
        .when(wt, (el) => el.child(this.wtRow(t)))
        .children(commits.map((c) => this.commitRow(c, t)))
        .when(Boolean(footer), (el) => el.child(this.footer(t))));
  }

  commitRow(c, t) {
    return v_flex().id(`commit-row-${c.hash}`).h(ROW).flex_none().px(10).justify_center().gap(2).rounded(4).mx(4)
      .cursor_pointer().hover((s) => s.bg(t.hover)).when(this.sel === c.hash, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.closed = false; this.choose(c.hash, cx); cx.notify(); })
      .child(div().truncate().text_size(13).text_color(t.foreground).child(c.subject || "(제목 없음)"))
      .child(div().truncate().text_size(11).text_color(t.dim)
        .child(`${c.author} · ${ago(c.at)} · ${c.short}${c.parents.length > 1 ? " · 병합" : ""}`));
  }

  wtRow(t) {
    return v_flex().id("commit-row-worktree").h(ROW).flex_none().px(10).justify_center().gap(2).rounded(4).mx(4)
      .cursor_pointer().hover((s) => s.bg(t.hover)).when(this.sel === WT, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.closed = false; this.choose(WT, cx); cx.notify(); })
      .child(div().truncate().text_size(13).text_color(t.foreground).child("커밋 안 된 변경"))
      .child(div().truncate().text_size(11).text_color(t.dim).child(`파일 ${this.dirty}개`));
  }

  footer(t) {
    const text = this.logError ?? (this.loading ? "읽는 중" : this.error ?? (!this.commits?.length
      ? (this.query ? "맞는 커밋이 없습니다" : this.root ? "커밋이 없습니다" : "폴더가 없습니다") : null));
    if (text || !this.more) return h_flex().h(ROW).flex_none().px(14).items_center().text_size(12).text_color(t.dim).child(text ?? "");
    return h_flex().h(ROW).flex_none().px(10).items_center()
      .child(div().id("commit-more").px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.foreground)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.loadMore(cx))
        .child(`${PAGE}개 더 불러오기`));
  }

  // 위 막대 부제: 브랜치 · 저장소 경로
  subtitle(t) {
    const where = (this.root ?? this.context?.cwd ?? "").replace(home(), "~");
    return h_flex().gap(8).items_center().min_w(0)
      .when(Boolean(this.branch), (el) => el.child(h_flex().flex_none().gap(4).items_center()
        .child(svg(`${ME}/branch.svg`).size(13).text_color(t.muted))
        .child(div().text_size(12).text_color(t.foreground).child(this.branch))))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(where));
  }

  // ── 오른쪽 ────────────────────────────────────────────

  detail(cx, t) {
    if (!this.sel) return null;
    const info = this.info, wt = this.sel === WT;
    const c = wt ? null : (this.commits ?? []).find((x) => x.hash === this.sel);
    const subject = wt ? "커밋 안 된 변경" : info?.subject ?? c?.subject ?? "";
    const short = wt ? null : (c?.short ?? this.sel.slice(0, 7));
    const side = (this.dw ?? 800) < 640 ? 220 : 280;
    return v_flex().id("commit-detail").size_full().min_h(0)
      .on_size_change((size, cx) => { if (Math.abs((this.dw ?? 0) - size.width) > 4) { this.dw = size.width; cx.notify(); } })
      .child(h_flex().h(40).flex_none().px(14).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(subject))
        .when(Boolean(short), (el) => el.child(this.tipped(h_flex().id("commit-hash").flex_none().px(8).py(3).gap(5).items_center().rounded(6)
          .border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover)), "hash", "전체 해시 복사")
          .on_click(() => { this.hideTip(); this.copy(info?.hash ?? this.sel, "해시"); })
          .child(div().text_size(12).font_family(CODE_FONT).text_color(t.muted).child(short))
          .child(svg(`${ME}/copy.svg`).size(13).text_color(t.muted))))
        .child(div().id("commit-close").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.closed = true; this.choose(null); cx.notify(); }).child("✕")))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(v_flex().w(side).flex_none().h_full().min_h(0).border_r_1().border_color(t.border)
          .child(v_flex().id("commit-side").flex_1().min_h(0).overflow_y_scrollbar().children(this.side(info, t))))
        .child(v_flex().flex_1().min_w(0).h_full().min_h(0).child(this.diffView(t))));
  }

  // 상세 왼쪽: 본문 · 정보 · 바뀐 파일
  side(info, t) {
    const out = [];
    if (this.detailError) return [div().p(12).text_size(12).text_color(t.ansi1).child(this.detailError)];
    if (!info) return [div().p(12).text_size(12).text_color(t.dim).child("읽는 중")];
    if (!info.worktree) {
      if (info.body) out.push(v_flex().px(12).pt(12).gap(2).text_size(12).text_color(t.foreground)
        .children(info.body.split("\n").slice(0, 200).map((l) => div().min_h(16).child(l))));
      const meta = (label, value, extra) => h_flex().gap(8).items_start().text_size(12)
        .child(div().w(40).flex_none().text_color(t.dim).child(label))
        .child(div().flex_1().min_w(0).text_color(t.foreground).child(value))
        .when(Boolean(extra), (el) => el.child(extra));
      const parents = info.parents.map((p) => div().id(`commit-parent-${p}`).flex_none().text_size(12).font_family(CODE_FONT)
        .text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground).underline())
        .on_click((_e, cx) => { this.choose(p, cx); cx.notify(); }).child(p.slice(0, 7)));
      out.push(v_flex().px(12).pt(12).gap(5)
        .child(meta("작성자", `${info.author}${info.email ? ` <${info.email}>` : ""}`))
        .child(meta("시각", `${stamp(info.at)} · ${ago(info.at)}`))
        .when(info.committer !== info.author || Math.abs(info.cat - info.at) > 60,
          (el) => el.child(meta("커밋", `${info.committer} · ${stamp(info.cat)}`)))
        .when(parents.length > 0, (el) => el.child(h_flex().gap(8).items_start().text_size(12)
          .child(div().w(40).flex_none().text_color(t.dim).child("부모"))
          .child(h_flex().flex_1().gap(8).flex_wrap().children(parents))))
        .when(info.parents.length > 1, (el) => el.child(div().text_size(11).text_color(t.dim).child("병합 커밋: 첫 부모와 비교합니다"))));
    }
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    out.push(h_flex().px(12).pt(14).pb(4).gap(6).items_center().text_size(12)
      .child(div().text_color(t.muted).child(`파일 ${this.files.length}${this.filesCut ? "+" : ""}개`))
      .child(div().flex_1())
      .when(add > 0, (el) => el.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (el) => el.child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))));
    out.push(v_flex().px(4).pb(8).children(this.files.map((f) => this.fileRow(f, t))));
    if (!this.files.length) out.push(div().px(12).text_size(12).text_color(t.dim).child("바뀐 파일이 없습니다"));
    if (this.filesCut) out.push(div().px(12).pb(10).text_size(11).text_color(t.dim).child("앞 1,000개만 보여 줍니다"));
    return out;
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const color = f.status === "A" || f.status === "?" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "R" ? t.ansi5 : t.ansi4;
    return h_flex().id(`commit-file-${f.path}`).h(24).flex_none().px(8).gap(6).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(this.file === f.path, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.openFile(f.path, cx); cx.notify(); })
      .child(this.tipped(div().id(`commit-st-${f.path}`).w(12).flex_none().text_size(11).text_color(color), `st-${f.path}`,
        f.old ? `${STATUS[f.status]}: ${f.old}` : STATUS[f.status] ?? f.status).child(f.status === "?" ? "A" : f.status))
      .child(div().flex_none().max_w(180).truncate().text_size(12).text_color(f.status === "D" ? t.muted : t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
      .when(f.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // 상세 오른쪽: 고른 파일의 diff
  diffView(t) {
    if (!this.file) return v_flex().flex_1().items_center().justify_center().text_size(12).text_color(t.dim)
      .child(this.info && !this.files.length ? "" : this.info ? "파일을 고르세요" : "");
    const f = this.files.find((x) => x.path === this.file);
    const rows = this.rows ?? [];
    const head = h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b_1().border_color(t.border).text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(f?.old ? `${f.old} → ${this.file}` : this.file))
      .when(Boolean(f?.add), (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(Boolean(f?.del), (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
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
      body = div().flex_1().min_h(0).relative().font_family(CODE_FONT).text_size(12)
        .child(div().id("commit-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffW ?? 300).h_full()
            .child(v_virtual_list("commit-diff", rows.length, LINE, (i) => String(i),
              (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("commit-diff").viewport_from_layout().absolute().inset_0());
    }
    return v_flex().flex_1().min_h(0).child(head).child(body)
      .when(Boolean(this.diffCut), (el) => el.child(div().flex_none().px(12).py(4).border_t_1().border_color(t.border)
        .text_size(11).text_color(t.dim).child("앞 1,500줄만 보여 줍니다")));
  }

  // diff 한 줄: 옛 줄 번호 · 새 줄 번호 · 내용. 추가·삭제 줄만 옅은 배경.
  diffRow(row, t) {
    if (row.kind === "@") return div().w_full().h(LINE).flex_none().px(12).flex().items_center().truncate().text_color(t.dim).bg(t.raised).child(row.text);
    const num = (n) => div().w(36).flex_none().pr(6).text_right().text_size(11).text_color(t.dim).child(n === undefined ? "" : String(n));
    return h_flex().w_full().h(LINE).flex_none().items_center()
      .when(row.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(row.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(num(row.old)).child(num(row.next))
      .child(div().w(14).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind === "+" || row.kind === "-" ? row.kind : ""))
      .child(div().flex_1().min_w(0).whitespace_nowrap().text_color(row.kind === "" ? t.dim : t.foreground).child(row.text));
  }
}
