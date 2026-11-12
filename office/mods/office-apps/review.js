// office-apps의 검토 앱: 에이전트가 일하는 작업 폴더별로 바뀐 것을 보고, 그 에이전트에게 피드백을 보낸다.
//   왼쪽: 지금 에이전트가 있는 작업 폴더(git 루트: 레포·워크트리, 같은 머신·루트는 한 줄).
//         줄 = 에이전트 아이콘 · 폴더 이름 · 변경 요약("파일 4 · +120 −30") / 상태 낱말 · 스페이스 › 탭.
//         변경이 없는 곳은 흐리게 맨 아래. 레포가 아닌 폴더는 뺀다.
//   오른쪽: 머리줄(폴더 · 브랜치 · 보기 전환 "커밋 안 된 변경 | 기본 브랜치 대비") / 바뀐 파일 / 고른 파일의 diff /
//         피드백(보낼 에이전트 · 고른 줄 · 여러 줄 입력 · "에이전트에게 보내기").
//   기본 브랜치 대비 = merge-base(기본 브랜치, HEAD)부터 지금 작업 트리까지 + 추적 안 된 파일(아직 커밋하지 않은 일도 보인다).
//   기본 브랜치는 origin/HEAD → origin/main → origin/master → main → master 중 처음 있는 것.
//   diff 줄 그리기·색·위아래/좌우는 commit/diffview.js(커밋·PR 앱과 같다). diff 줄을 누르면 "파일:줄"을 피드백에 붙인다
//   (가상 목록의 on_item_click; 다시 누르면 풀린다).
// 보내기: send.js(공용). 후보는 그 폴더에서 일하는 에이전트(스페이스가 달라도), 순서·표시·상태 규칙·확인 창·hc send는 거기서.
//   결과는 공유 상태(SENT)로 돌아오고(확인 창은 오버레이 복사본), 앱이 렌더 때 받아 입력칸을 비운다.
// 갱신: 이 앱이 그려지는 동안만 10초마다(에이전트 앱과 같은 방식: 알렸는데 그려지지 않았으면 멈추고, 다시 그려지면 이어 간다) + 수동.
// git은 읽기만 한다(commit/git.js READ). 순수 함수는 review/model.js(node로 시험).
// 셸 계약: list · detail · subtitle · move · activate · emptyState · dispose

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { agents, panes, spaces, exec, readTextFile, home, shared, settings } from "herdr";
import { candidates, recipients, sendToAgent, statusWord, nextRecipient } from "./send.js";
import { BIG, READ, parseNameStatus, parseNumstat, mergeFiles, diffLines, addedLines, diffRows } from "./commit/git.js";
import {
  DIFF_LINE, NARROW, inlineRow, splitRow, inlineWidth, splitWidth, diffPalette, wordSpans, splitRows, isDark, diffMode, modeToggle,
} from "./commit/diffview.js";
import {
  withSilent, workdirs, groupRoots, parseShortstat, summary, changed, sortGroups, pickLine, feedbackText, baseCandidates, pickBase,
} from "./review/model.js";

const APPS = "mods/office-apps";
const I = (n) => `${APPS}/${n}.svg`;
const CODE_FONT = "D2Coding";
const EVERY = 10000;
const FILE_ROW = 24, FILE_ROWS = 6;
const FILE_MAX = 1000000;
const SENT = "office-apps.review.sent";     // 확인 창 → 앱: { id, phase: "sending" | "done", ok }
const FILE_STATUS = { A: "추가", M: "수정", D: "삭제", R: "이름 바뀜", C: "복사", T: "형식 바뀜", U: "충돌", "?": "새 파일" };
const BRAND = [[/claude/i, `${APPS}/agent/icons/claude.svg`, "#d97757"], [/codex|openai/i, `${APPS}/agent/icons/openai.svg`, null]];

function load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 */ } }
const firstLine = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 300);
const baseName = (p) => String(p ?? "").replace(/\/+$/, "").split("/").pop() || p;

function programIcon(p, size, t) {
  const id = `${p?.key ?? ""} ${p?.name ?? ""}`;
  const b = BRAND.find(([re]) => re.test(id));
  if (b) return svg(b[1]).size(size).flex_none().text_color(b[2] ?? t.foreground);
  if (p?.icon) return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color || t.foreground) : image(p.icon).size(size).flex_none();
  return div().flex_none().text_size(size - 2).text_color(t.foreground).child((p?.name || "?").slice(0, 1));
}

const statusColor = (s, t) => ({ working: t.working, blocked: t.blocked, done: t.done, idle: t.idle })[s] ?? t.dim;

export class ReviewApp {
  init(_p, _cx) {
    this.roots = {};          // 작업 폴더 key([머신, 폴더]) → git 루트 | null(레포 아님)
    this.stats = {};          // 묶음 key([머신, 루트]) → { files, add, del, untracked, branch }
    this.groups = [];
    this.sel = load("review.sel", null);
    this.mode = load("review.mode", "worktree") === "base" ? "base" : "worktree";
    this.to = {};             // 묶음 key → 보낼 에이전트 주소(묶음을 처음 볼 때 정하고, 그 뒤로는 사람이 고를 때만 바뀐다)
    this.drafts = {};         // 초안 key(draftKey) → 글. 폴더·받는 사람을 바꿔도 남는다
    this.dk = null;           // 입력칸에 보이는 초안의 key
    this.sentDraft = {};      // 보낸 id → 초안 key(보낸 뒤 그 초안만 비운다)
    this.seen = false;        // 이 앱에서 고른 폴더를 한 번이라도 봤는지(본 뒤 사라지면 다른 폴더를 저절로 고르지 않는다)
    this.last = null;         // 마지막으로 본 고른 폴더 { key, root, on }
    this.files = []; this.file = null; this.rows = []; this.pairs = [];
    this.filesOpen = true;
    this.pick = null;         // diff에서 고른 줄 { line, side, key }
    this.sending = null;      // 보내는 중인 id
    const s0 = shared(SENT);
    this.sentSeen = s0?.id ? `${s0.id}:${s0.phase}` : null;   // 앱을 열기 전에 보낸 결과는 무시
    this.input = TextareaState.new({ placeholder: "에이전트에게 보낼 피드백 (고른 파일·줄이 앞에 붙습니다)", rows: 3 });
    try { this.input.set_auto_grow(2, 6); } catch { /* 고정 3줄 */ }
    this.input.on("change", (_e, cx) => {
      const v = this.input.value();
      if (this.dk) { if (v) this.drafts[this.dk] = v; else delete this.drafts[this.dk]; }
      const empty = !v.trim();
      if (empty !== this.empty) { this.empty = empty; cx.notify(); }
    });
    // ⌘Enter(입력칸 안): 보내기. 입력의 submit(secondary)로만 받는다(런처는 입력칸 안의 ⌘Enter를 건드리지 않는다)
    this.input.on("submit", (e, cx) => { if (e?.secondary) this.send(cx); });
    this.empty = true;
    this.timer = null; this.busy = false; this.rendered = 0; this.notified = 0;
  }

  dispose() {
    this.disposed = true;
    this.timer?.cancel(); this.timer = null;
    try { this.input?.release(); } catch { /* 이미 놓았으면 그만 */ }
  }

  // ── 목록 만들기 ─────────────────────────────────────────
  dirs() {
    const ps = panes() ?? [], sps = spaces() ?? [];
    return workdirs(withSilent(agents() ?? [], ps, sps), ps, sps);
  }

  build() {
    const dirs = this.dirs();
    this.groups = sortGroups(groupRoots(dirs, this.roots), this.stats);
    return dirs;
  }

  current() { return this.groups.find((g) => g.key === this.sel) ?? null; }

  // 고른 폴더가 목록에서 사라졌다(아직 루트를 찾는 폴더가 있으면 판단을 미룬다)
  lost() { return Boolean(this.sel && this.seen && !this.current() && !this.unresolved); }

  // 초안 key = (기기, 폴더 루트, 받는 에이전트 주소). 폴더가 사라졌으면 마지막 것을 그대로 둔다.
  draftKey() {
    const g = this.current();
    if (!g) return this.dk;
    const to = this.to[g.key];
    return to ? JSON.stringify([g.on ?? null, g.root, to]) : null;
  }

  swap(dk) {
    if (dk === this.dk) return;
    this.dk = dk;
    const v = (dk && this.drafts[dk]) || "";
    if (this.input.value() !== v) this.input.set_value(v);
    this.empty = !v.trim();
  }

  // 렌더마다(detail·list 둘 다에서): 목록을 새로 만들고, 처음이면 첫 줄을 고르고, 초안을 맞추고, 타이머를 깨운다.
  //   고른 폴더를 본 뒤 그 폴더가 빠지면 다른 폴더를 고르지 않는다(초안이 다른 에이전트에게 가지 않게). 사람이 고를 때까지 lost.
  prepare(cx) {
    const dirs = this.build();
    this.syncSent();
    this.unresolved = dirs.some((d) => !(d.key in this.roots));
    if (this.unresolved && !this.busy) this.kick(cx);
    if (!this.current() && !this.seen && (!this.sel || !this.unresolved)) {
      const g = this.groups.find((x) => !x.pending) ?? null;
      if (g) this.choose(g.key, cx);
    }
    const cur = this.current();
    if (cur && !cur.pending) {
      this.seen = true; this.last = { key: cur.key, root: cur.root, on: cur.on };
      // 받는 사람은 처음 볼 때 정해 둔다: 그 뒤 그 에이전트가 빠져도 다음 사람으로 넘어가지 않는다.
      if (!this.to[cur.key]) { const a = this.agentsOf(cur)[0]; if (a) this.to[cur.key] = a.address; }
    }
    this.swap(this.draftKey());
    this.rendered = Date.now();
    if (!this.timer && !this.busy) this.loop(cx, 0);
  }

  // 확인 창이 보낸 결과를 받는다.
  syncSent() {
    const s = shared(SENT);
    if (!s || !s.id) return;
    const key = `${s.id}:${s.phase}`;
    if (key === this.sentSeen) return;
    this.sentSeen = key;
    if (s.phase === "sending") { this.sending = s.id; return; }
    if (this.sending === s.id || this.waiting === s.id) {
      this.sending = null; this.waiting = null;
      const dk = this.sentDraft[s.id];
      delete this.sentDraft[s.id];
      // 보낸 초안만 비운다(2분까지 걸리므로 그 사이 다른 폴더·받는 사람으로 옮겼을 수 있다)
      if (s.ok && dk) {
        delete this.drafts[dk];
        if (this.dk === dk) { this.empty = true; this.pick = null; this.input.set_value(""); }
      }
    }
  }

  // ── 갱신 ───────────────────────────────────────────────
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
      // 지난번 알렸는데 그려지지 않았다: 안 보이는 중이니 멈춘다(다시 그려지면 prepare가 깨운다)
      if (this.notified > this.rendered) return;
      this.busy = true;
      cx.spawn(async (cx) => {
        try { await this.refresh(cx); } catch (e) { console.log(`[review] 갱신 실패: ${firstLine(e?.message ?? e)}`); }
        this.busy = false;
        const again = this.again; this.again = false;
        this.notified = Date.now(); cx.notify();
        this.loop(cx, again ? 0 : EVERY);
      });
    });
  }

  // 모르는 작업 폴더의 git 루트를 찾고, 묶음마다 변경 요약을 읽고, 고른 묶음의 파일 목록을 다시 읽는다.
  async refresh(cx) {
    const dirs = this.dirs();
    await Promise.all(dirs.filter((d) => !(d.key in this.roots)).map(async (d) => {
      try {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: d.cwd, on: d.on, timeout: 15000 });
        this.roots[d.key] = r.code === 0 ? r.stdout.trim() || null : null;
      } catch { this.roots[d.key] = null; }   // 폴더가 없거나 머신이 끊겼다: 다음에 폴더가 바뀌면 다시
    }));
    this.groups = sortGroups(groupRoots(dirs, this.roots), this.stats);
    await Promise.all(this.groups.filter((g) => !g.pending).map(async (g) => {
      const git = (args) => exec("git", [...READ, ...args], { cwd: g.root, on: g.on, timeout: 20000 });
      const [ss, un, br] = await Promise.all([
        git(["diff", "--no-ext-diff", "--shortstat", "HEAD"]).catch(() => null),
        git(["ls-files", "-o", "--exclude-standard", "-z"]).catch(() => null),
        git(["branch", "--show-current"]).catch(() => null),
      ]);
      const st = parseShortstat(ss?.code === 0 ? ss.stdout : "");
      this.stats[g.key] = { ...st, untracked: un?.code === 0 ? un.stdout.split("\0").filter(Boolean).length : 0, branch: br?.stdout?.trim() ?? "" };
    }));
    this.groups = sortGroups(this.groups, this.stats);
    if (this.current()) await this.loadFiles(cx, true);
  }

  // ── 고르기와 파일 목록 ─────────────────────────────────
  choose(key, cx) {
    if (key === this.sel && this.info) return;
    this.sel = key; save("review.sel", key);
    this.files = []; this.info = null; this.filesError = null; this.filesOpen = true;
    this.openFile(null);
    this.loadGen = (this.loadGen ?? 0) + 1;
    if (cx) cx.spawn(async (cx) => { await this.loadFiles(cx, false); cx.notify(); });
  }

  setMode(mode, cx) {
    if (mode === this.mode) return;
    this.mode = mode; save("review.mode", mode);
    this.files = []; this.info = null; this.filesError = null;
    this.openFile(null);
    this.loadGen = (this.loadGen ?? 0) + 1;
    cx.spawn(async (cx) => { await this.loadFiles(cx, false); cx.notify(); });
  }

  git(g, args, timeout = 30000) {
    return exec("git", [...READ, ...args], { cwd: g.root, on: g.on, timeout });
  }

  // 기본 브랜치와 merge-base. 없으면 { ref: null }.
  async baseOf(g) {
    const oh = await this.git(g, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).catch(() => null);
    const cands = baseCandidates(oh?.code === 0 ? oh.stdout : "");
    const ok = {};
    await Promise.all(cands.map(async (c) => {
      const r = await this.git(g, ["rev-parse", "--verify", "-q", `${c}^{commit}`]).catch(() => null);
      ok[c] = r?.code === 0;
    }));
    const ref = pickBase(cands, ok);
    if (!ref) return { ref: null };
    const mb = await this.git(g, ["merge-base", ref, "HEAD"]).catch(() => null);
    return mb?.code === 0 ? { ref, mb: mb.stdout.trim() } : { ref, mb: null };
  }

  // 지금 보기(커밋 안 된 변경 | 기본 브랜치 대비)의 바뀐 파일. again이면 새로 읽은 것과 비교해 보던 파일의 diff를 필요할 때만 다시 읽는다.
  async loadFiles(cx, again) {
    const g = this.current();
    if (!g || g.pending) return;
    const gen = this.loadGen, mode = this.mode;
    let info = null, files = [], error = null;
    try {
      if (mode === "base") {
        const b = await this.baseOf(g);
        if (!b.ref) error = "기본 브랜치를 찾지 못했습니다(origin/HEAD · main · master 없음)";
        else if (!b.mb) error = `${b.ref}와 공통 조상이 없습니다`;
        else info = { range: b.mb, base: b.ref };
      } else {
        const h = await this.git(g, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => null);
        info = h?.code === 0 ? { range: "HEAD" } : { range: null };   // 커밋이 없으면 추적 안 된 파일만
      }
      if (info) {
        const [ns, nm, un] = await Promise.all([
          info.range ? this.git(g, ["diff", "--no-ext-diff", "--name-status", "-z", "-M", info.range]) : null,
          info.range ? this.git(g, ["diff", "--no-ext-diff", "--numstat", "-z", "-M", info.range]) : null,
          this.git(g, ["ls-files", "-o", "--exclude-standard", "-z"]),
        ]);
        if (ns && ns.code !== 0) throw new Error(firstLine(ns.stderr) || "변경을 읽지 못했습니다");
        const names = [...(ns ? parseNameStatus(ns.stdout) : []), ...un.stdout.split("\0").filter(Boolean).map((path) => ({ status: "?", path }))];
        files = mergeFiles(names, nm ? parseNumstat(nm.stdout) : {});
        info.cut = names.length > files.length;
      }
    } catch (e) { error = firstLine(e?.message ?? e); }
    if (gen !== this.loadGen || this.current()?.key !== g.key || mode !== this.mode) return;
    const was = this.file ? this.files.find((f) => f.path === this.file) : null;
    this.info = info; this.files = files; this.filesError = error;
    if (!this.file || !files.some((f) => f.path === this.file)) {
      if (files[0]) this.openFile(files[0].path, cx); else this.openFile(null);
    } else if (again) {
      const now = files.find((f) => f.path === this.file);
      // 보던 파일이 바뀌었으면 다시 읽는다(고른 줄은 그대로 둔다). 새 파일(?)은 줄 수를 모르니 늘 다시 읽는다.
      if (!was || now.status === "?" || was.add !== now.add || was.del !== now.del || was.status !== now.status) this.openFile(this.file, cx, true);
    }
  }

  // ── diff ──────────────────────────────────────────────
  openFile(path, cx, keepPick = false) {
    if (!keepPick || path !== this.file) this.pick = null;
    if (!keepPick) { this.rows = []; this.pairs = []; this.diffW = 300; this.splitW = 300; }
    this.file = path; this.diffNote = null; this.diffWhy = null; this.diffCut = false;
    this.fileGen = (this.fileGen ?? 0) + 1;
    if (!path || !cx) return;
    const gen = this.fileGen, f = this.files.find((x) => x.path === path), info = this.info, g = this.current();
    if (!f || !info || !g) return;
    if (f.binary) { this.diffNote = "바이너리 파일입니다"; return; }
    if (f.add + f.del > BIG) { this.diffNote = "diff가 너무 커서 열지 않았습니다"; return; }
    this.diffLoading = !keepPick || !this.rows.length;
    cx.spawn(async (cx) => {
      let out = null, note = null, why = null, rows = null;
      try {
        if (f.status === "?") {
          const text = await readTextFile(`${g.root}/${path}`, { on: g.on });
          if (text === null) note = "읽을 수 없는 파일입니다(바이너리이거나 1MiB 초과)";
          else if (text.includes("\0")) note = "바이너리 파일입니다";
          else out = addedLines(String(text));
        } else {
          const paths = f.old ? [f.old, path] : [path];
          const x = await this.viaFile(g, ["git", ...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", info.range, "--", ...paths]);
          const stdout = String(x?.stdout ?? "");
          if (x?.code === 0 || stdout.includes("\n@@ ") || stdout.startsWith("@@ ")) {
            out = diffLines(stdout);
            if (!out) note = f.status === "R" ? "내용은 그대로이고 이름만 바뀌었습니다" : "보여 줄 텍스트 차이가 없습니다";
          } else { note = "diff를 읽지 못했습니다"; why = `git 종료 코드 ${x?.code}: ${firstLine(x?.stderr) || "stderr 없음"}`; }
        }
        if (out) rows = wordSpans(diffRows(out.lines));
      } catch (e) { note = "diff를 읽지 못했습니다"; why = firstLine(e?.message ?? e); rows = null; }
      if (gen !== this.fileGen) return;
      this.diffLoading = false;
      if (rows) {
        const pairs = splitRows(rows);
        this.rows = rows; this.pairs = pairs; this.diffCut = out.cut; this.diffW = inlineWidth(rows); this.splitW = splitWidth(pairs);
      } else { this.rows = []; this.pairs = []; }
      this.diffNote = note; this.diffWhy = why;
      cx.notify();
    });
  }

  // 커밋 앱 viaFile과 같은 방식: 큰 diff를 파이프 대신 임시 파일로 받고 1MB에서 자른다.
  async viaFile(g, argv, timeout = 60000) {
    const script = `f=$(mktemp "\${TMPDIR:-/tmp}/herdr-review.XXXXXX") || exit 97
"$@" >"$f" 2>"$f.err"; c=$?
if [ "$(wc -c <"$f")" -gt ${FILE_MAX} ]; then head -c ${FILE_MAX} "$f" | sed '$d' >"$f.t"; mv "$f.t" "$f"; fi
printf '%s\n%s' "$c" "$f"`;
    const r = await exec("sh", ["-c", script, "review", ...argv], { cwd: g.root, on: g.on, timeout });
    const [code, file] = r.stdout.split("\n");
    if (r.code !== 0 || !file) return { code: r.code, stdout: "", stderr: r.stderr || "임시 파일을 만들지 못했습니다" };
    try {
      const [stdout, stderr] = await Promise.all([
        readTextFile(file, { on: g.on }),
        readTextFile(`${file}.err`, { on: g.on }).catch(() => ""),
      ]);
      if (stdout === null) return { code: -1, stdout: "", stderr: "출력 파일을 읽지 못했습니다(1MiB 초과이거나 UTF-8이 아님)" };
      return { code: Number(code), stdout, stderr: stderr ?? "" };
    } finally {
      exec("rm", ["-f", file, `${file}.err`], { on: g.on }).catch(() => null);
    }
  }

  narrow() { return (this.dw ?? 1000) < NARROW; }
  split() { return diffMode() === "split" && !this.narrow(); }

  // ── 보내기(send.js) ─────────────────────────────────────
  // 그 폴더의 에이전트(지금 상태, 공용 순서)
  agentsOf(g) { return g ? candidates({ list: g.agents }) : []; }

  // 정해 둔 받는 사람. 목록에서 빠졌으면 null(다른 사람으로 넘어가지 않는다).
  target(g = this.current()) {
    if (!g) return null;
    return this.agentsOf(g).find((a) => a.address === this.to[g.key]) ?? null;
  }

  // 사람이 받는 사람을 바꾼다. 앞 사람이 목록에서 빠져 있었고 새 사람의 초안이 없으면, 보이던 글을 새 사람 초안으로 옮긴다
  //   (칩을 눌러 받는 사람을 직접 고른 것이라 옮겨도 엉뚱한 곳으로 가지 않는다).
  pickTo(g, address) {
    const was = this.target(g), from = this.dk, text = from ? this.drafts[from] : null;
    this.to[g.key] = address;
    const dk = this.draftKey();
    if (!was && text && dk && !this.drafts[dk]) { this.drafts[dk] = text; delete this.drafts[from]; }
    this.swap(dk);
  }

  send(cx) {
    const g = this.current(), a = this.target(g), dk = this.draftKey();
    if (!g || !a || this.sending || !dk || dk !== this.dk) return;
    const text = feedbackText({ path: this.file, line: this.pick?.line, side: this.pick?.side, text: this.input.value() });
    if (!text) return;
    const r = sendToAgent(a, text, { reply: SENT });
    if (r.state === "confirm" || r.state === "sending") this.sentDraft[r.id] = dk;
    if (r.state === "confirm") this.waiting = r.id;
    if (r.state !== "sending") return;
    this.sending = r.id; this.waiting = r.id;
    cx.spawn(async (cx) => { await r.done; this.syncSent(); cx.notify(); });
    cx.notify();
  }

  // ── 셸 계약 ────────────────────────────────────────────
  move(delta, cx) {
    const gs = this.groups.filter((g) => !g.pending);
    if (!gs.length) return;
    const i = gs.findIndex((g) => g.key === this.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(gs.length - 1, i + delta));
    this.choose(gs[j].key, cx);
  }

  // 런처 키 계약: 지난 그리기에서 모은 멈출 곳(보낼 곳 · 입력칸 · 보내기). ⌘Enter(상세 어디서나) = 보내기.
  focusables() { return this.stops ?? []; }
  submitDetail(cx) { this.send(cx); }

  // Enter: 피드백 입력칸으로
  activate(_cx) {
    if (this.current()) this.input.focus();
  }

  emptyState() {
    if (!this.groups.length) return { text: "에이전트가 일하는 git 폴더가 없습니다", sub: "에이전트를 띄우면 그 작업 폴더의 변경이 여기에 보입니다" };
    return { text: "읽는 중", sub: "" };
  }

  subtitle(t) {
    const real = this.groups.filter((g) => !g.pending), n = real.filter((g) => changed(this.stats[g.key])).length;
    return h_flex().gap(10).items_center().text_size(12).text_color(t.dim).truncate()
      .child(div().flex_none().child(`작업 폴더 ${real.length}`))
      .when(n > 0, (el) => el.child(div().flex_none().child(`변경 있음 ${n}`)));
  }

  // ── 왼쪽 ──────────────────────────────────────────────
  list(cx, t) {
    this.prepare(cx);
    const gs = this.groups.filter((g) => !g.pending);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(34).flex_none().pl(12).pr(4).gap(6).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child("작업 폴더"))
        .child(div().id("review-refresh").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            // 레포가 아니라고 기억한 폴더(끊긴 머신·시간 초과·나중에 git init)만 다시 확인한다. 찾은 루트는 둬서 선택이 유지된다.
            for (const k of Object.keys(this.roots)) if (this.roots[k] === null) delete this.roots[k];
            this.kick(cx); cx.notify();
          })
          .child(svg(I("refresh")).size(16).text_color(this.busy ? t.dim : "#7fbbb3"))))
      .child(v_flex().id("review-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
        .when(!gs.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim)
          .child(this.groups.length ? "읽는 중" : "에이전트가 일하는 git 폴더가 없습니다")))
        .children(gs.map((g) => this.groupRow(g, t))));
  }

  groupRow(g, t) {
    const st = this.stats[g.key], on = g.key === this.sel, has = changed(st), a = g.agents[0];
    const where = [...new Set(g.agents.map((x) => `${x.space_name} › ${x.tab_name}`))];
    const word = statusWord(a?.status);
    return v_flex().id(`review-g-${g.key}`).h(42).flex_none().justify_center().gap(2).pl(8).pr(8).rounded(4).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(!has && !on, (el) => el.opacity(0.55))
      .on_click((_e, cx) => { this.choose(g.key, cx); cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .children(g.agents.slice(0, 3).map((x) => programIcon(x.program, 14, t)))
        .when(g.agents.length > 3, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${g.agents.length - 3}`)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(baseName(g.root)))
        .child(div().flex_none().text_size(11).text_color(has ? t.muted : t.dim).child(st ? summary(st, st.untracked) : "")))
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().flex_none().text_color(statusColor(a?.status, t)).child(word))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(where.join(", "))));
  }

  // ── 오른쪽 ────────────────────────────────────────────
  detail(cx, t) {
    this.stops = [];
    this.prepare(cx);
    const g = this.current();
    if (!g && this.sel && this.seen) return this.lostView(t);
    if (!g || g.pending) return null;
    const st = this.stats[g.key];
    const tab = (mode, label) => div().id(`review-view-${mode}`).px(8).py(3).rounded(4).text_size(12).cursor_pointer()
      .text_color(this.mode === mode ? t.foreground : t.dim).when(this.mode === mode, (el) => el.bg(t.hover))
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.setMode(mode, cx); cx.notify(); }).child(label);
    const baseLabel = this.mode === "base" && this.info?.base ? `${this.info.base} 대비` : "기본 브랜치 대비";
    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_none().max_w(220).truncate().text_size(14).font_semibold().text_color(t.foreground).child(baseName(g.root)))
        .when(Boolean(st?.branch), (el) => el.child(h_flex().flex_none().gap(4).items_center()
          .child(svg(I("branch")).size(13).text_color(t.muted))
          .child(div().max_w(200).truncate().text_size(12).text_color(t.muted).child(st.branch))))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(g.root.replace(home(), "~") + (g.on ? ` · ${g.on}` : "")))
        .child(h_flex().flex_none().gap(2).items_center()
          .child(tab("worktree", "커밋 안 된 변경"))
          .child(div().text_size(11).text_color(t.dim).child("|"))
          .child(tab("base", baseLabel))))
      .child(this.fileSection(t))
      .child(v_flex().flex_1().min_h(0).child(this.diffView(t)))
      .child(this.feedback(g, t));
  }

  fileSection(t) {
    const line = (text, color) => div().flex_none().px(14).py(10).border_b_1().border_color(t.border).text_size(12).text_color(color).child(text);
    if (this.filesError) return line(this.filesError, this.mode === "base" ? t.muted : t.ansi1);
    if (!this.info) return line("읽는 중", t.dim);
    const files = this.files, n = files.length;
    if (!n) return line(this.mode === "base" ? "기본 브랜치와 다른 파일이 없습니다" : "커밋 안 된 변경이 없습니다", t.dim);
    const add = files.reduce((s, f) => s + f.add, 0), del = files.reduce((s, f) => s + f.del, 0), open = this.filesOpen;
    const head = h_flex().h(30).flex_none().pr(10).gap(6).items_center()
      .child(h_flex().id("review-files-head").flex_1().min_w(0).h_full().pl(10).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.filesOpen = !this.filesOpen; cx.notify(); })
        .child(svg(I(open ? "chevron-down" : "chevron-right")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(`파일 ${n}${this.info.cut ? "+" : ""}개`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(!open && this.file ? this.file : "")))
      .when(add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(modeToggle(t, "review", this.narrow()));
    return v_flex().flex_none().border_b_1().border_color(t.border)
      .child(head)
      .when(open, (el) => el.child(v_flex().id("review-files").h(Math.min(n, FILE_ROWS) * FILE_ROW + 4).flex_none().overflow_y_scrollbar().px(4).pb(4)
        .children(files.map((f) => this.fileRow(f, t)))));
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const color = f.status === "A" || f.status === "?" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "R" ? t.ansi5 : t.ansi4;
    return h_flex().id(`review-file-${f.path}`).h(FILE_ROW).flex_none().px(8).gap(6).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(this.file === f.path, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.openFile(f.path, cx); cx.notify(); })
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(f.status === "?" ? "A" : f.status))
      .child(div().flex_none().max_w(260).truncate().text_size(12).text_color(f.status === "D" ? t.muted : t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(
        [parts.join("/"), f.status === "?" ? FILE_STATUS["?"] : ""].filter(Boolean).join(" · ")))
      .when(f.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  diffView(t) {
    if (!this.file) return v_flex().flex_1();
    const rows = this.rows ?? [];
    let body;
    if (this.diffNote || (!rows.length && !this.diffLoading)) {
      body = v_flex().flex_1().items_center().justify_center().gap(10)
        .child(div().text_size(12).text_color(t.dim).child(this.diffNote ?? ""))
        .when(Boolean(this.diffWhy), (el) => el.child(div().max_w(560).px(16).text_size(11).text_color(t.dim).child(this.diffWhy)));
    } else if (!rows.length) {
      body = v_flex().flex_1().items_center().justify_center().text_size(12).text_color(t.dim).child("읽는 중");
    } else {
      const s = settings()?.dark, pal = diffPalette(t, typeof s === "boolean" ? s : isDark(t));
      const split = this.split(), pairs = this.pairs ?? [], pk = this.pick;
      const n = split ? pairs.length : rows.length, p = split ? "s" : "i";
      // 고른 줄은 diff 색을 덮지 않게 테두리만 두른다. 렌더러 안에는 핸들러를 두지 않는다(누르기는 on_item_click).
      // 줄 번호·쪽으로 맞춘다(다시 읽거나 위아래/좌우를 바꿔도 따라간다).
      const mark = (el, k) => {
        const got = pk ? pickLine(rows, pairs, k) : null;
        return got && got.line === pk.line && got.side === pk.side
          ? div().relative().w_full().h(DIFF_LINE).flex_none().child(el).child(div().absolute().inset_0().border_1().border_color(t.accent))
          : el;
      };
      body = div().flex_1().min_h(0).relative().font_family(CODE_FONT).text_size(12)
        .child(div().id("review-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w((split ? this.splitW : this.diffW) ?? 300).h_full()
            .child(v_virtual_list("review-diff", n, DIFF_LINE, (i) => `${p}${i}`,
              (range) => split
                ? pairs.slice(range.start, range.end).map((x, j) => mark(splitRow(x, t, pal), `s${range.start + j}`))
                : rows.slice(range.start, range.end).map((row, j) => mark(inlineRow(row, t, pal), `i${range.start + j}`))).size_full()
              .on_item_click((k, cx) => {
                const got = pickLine(this.rows, this.pairs, k);
                this.pick = got && this.pick?.line === got.line && this.pick?.side === got.side ? null : got;
                cx.notify();
              }))))
        .child(Scrollbar.vertical("review-diff").viewport_from_layout().absolute().inset_0());
    }
    return v_flex().id("review-diff-area").flex_1().min_h(0).child(body)
      .on_size_change((size, cx) => { if (Math.abs((this.dw ?? 0) - size.width) > 4) { this.dw = size.width; cx.notify(); } })
      .when(Boolean(this.diffCut), (el) => el.child(div().flex_none().px(12).py(4).border_t_1().border_color(t.border)
        .text_size(11).text_color(t.dim).child("앞 1,500줄만 보여 줍니다")));
  }

  // 고른 폴더가 목록에서 빠졌을 때: 다른 폴더를 저절로 고르지 않고 한 줄로 알린다. 보내기는 없다(초안은 남는다).
  lostView(t) {
    const name = this.last ? baseName(this.last.root) : "";
    const line = !this.lost() ? "읽는 중"
      : this.empty ? "이 폴더가 목록에서 사라졌습니다" : "이 폴더가 목록에서 사라졌습니다 · 초안 보관됨";
    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_none().max_w(220).truncate().text_size(14).font_semibold().text_color(t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(this.last ? this.last.root.replace(home(), "~") + (this.last.on ? ` · ${this.last.on}` : "") : "")))
      .child(div().flex_none().px(14).py(10).border_b_1().border_color(t.border).text_size(12).text_color(t.foreground).child(line))
      .child(div().flex_1())
      .when(!this.empty, (el) => el.child(v_flex().flex_none().px(12).py(8).gap(6).border_t_1().border_color(t.border)
        .child(Textarea.new(this.input).w_full().text_size(13).text_color(t.foreground))
        .child(div().text_size(11).text_color(t.dim).child("왼쪽에서 폴더를 고르면 그 폴더의 초안으로 바뀝니다. 이 폴더가 돌아오면 초안도 돌아옵니다."))));
  }

  // 피드백: 보낼 곳(여럿이면 골라 누름) · 붙을 위치 / 입력칸 / 보내기
  feedback(g, t) {
    const a = this.target(g), gone = !a && Boolean(this.to[g.key]);
    const st = a?.status ?? null;
    const blocked = st === "blocked", sending = Boolean(this.sending);
    const can = Boolean(a) && !blocked && !sending && !this.empty;
    const where = this.file ? (this.pick ? `${this.file}:${this.pick.line}${this.pick.side === "old" ? " (지운 줄)" : ""}` : this.file) : null;
    const note = gone ? (this.empty ? "받는 에이전트가 목록에서 사라졌습니다" : "받는 에이전트가 목록에서 사라졌습니다 · 초안 보관됨")
      : blocked ? "입력을 기다리는 중이라 보낼 수 없습니다. 터미널에서 먼저 답하세요."
      : sending ? "보내는 중" : st === "working" ? "작업 중: 보낸 글은 다음 차례에 처리됩니다" : "";
    // 런처 키 계약의 멈출 곳(화면 순서): 보낼 곳(후보가 둘 이상이면, Enter·Space = 다음 후보) → 입력칸 → 보내기(보낼 수 있을 때)
    const list = this.agentsOf(g), nx = nextRecipient(list, a?.address), on = (id) => Boolean(this.kb?.on?.(id));
    if (nx) this.stops.push({ id: "review-to", kind: "button", run: () => this.pickTo(g, nx.address) });
    this.stops.push({ id: "review-input", kind: "input", focus: () => this.input.focus() });
    if (can) this.stops.push({ id: "review-send", kind: "button", run: (cx) => this.send(cx) });
    return v_flex().flex_none().px(12).py(8).gap(6).border_t_1().border_color(t.border)
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().flex_1().min_w(0).child(recipients("review", list, a?.address, (address) => this.pickTo(g, address), t, undefined, nx ? on("review-to") : undefined)))
        .when(Boolean(where), (el) => el.child(h_flex().flex_none().max_w(320).gap(4).items_center()
          .child(div().truncate().text_size(11).font_family(CODE_FONT).text_color(t.muted).child(where))
          .when(Boolean(this.pick), (e2) => e2.child(div().id("review-unpick").px(4).rounded(4).text_size(11).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.pick = null; cx.notify(); }).child("✕"))))))
      // 입력칸 안에서 올라온 Tab·Esc를 런처가 이 자리에서 이어 가게 알린다
      .child(div().w_full().on_key_down(() => { if (this.kb) this.kb.from = "review-input"; })
        .child(Textarea.new(this.input).w_full().text_size(13).text_color(t.foreground)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(blocked ? t.blocked : gone ? t.foreground : t.dim)
          .child(note || (this.pick ? "diff 줄을 다시 누르면 줄 고르기를 풉니다" : "diff 줄을 누르면 그 줄에 대해 보냅니다")))
        .child(div().id("review-send").flex_none().px(12).py(5).rounded(6).text_size(12).border_1().border_color(on("review-send") ? t.accent : t.border)
          .text_color(can ? t.foreground : t.dim)
          .when(can, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.send(cx)))
          .child(sending ? "보내는 중" : "에이전트에게 보내기")));
  }
}
