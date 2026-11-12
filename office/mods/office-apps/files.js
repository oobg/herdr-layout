// office 파일트리: Herdr 기본 files 모드를 바탕으로 WebStorm 같은 모양을 입혔다.
//   - 맨 위에 "프로젝트 ~/경로" 헤더
//   - Material Icon Theme 아이콘(폴더 이름·파일 이름·확장자별)
//   - git 상태로 파일 이름 색: 수정 파랑, 추가 초록, 추적 안 됨 빨강, 무시됨 갈색(흐리게)
// 지금 고른 스페이스(포커스된 패인)의 폴더를 보여 준다. 파일을 누르면 읽기 전용 미리보기.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, home, appHome, props, run, openOverlay, closeOverlay, notify, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { preview, mdRemoteImages } from "./viewers.js";
import { codeLang } from "./markdown.js";
import { DEFAULT_SIZE, ZOOM_MIN, ZOOM_MAX, clampSize, dragSize, nextPreset, stepZoom, pickSize, pickZoom } from "./viewers/size.js";
import { Menu, Confirm, ACTIONS, TICK, menuHeight, popupAt } from "./menu.js";
const PREVIEW = "office-apps.preview";

const ME = "mods/office-apps";
const PER_FOLDER = 500, TOTAL = 5000;
const CODE_FONT = "D2Coding";   // 코드·스크립트·마크다운 뷰어 글꼴(패널은 Pretendard GOV)
const MD_CODE_MAX = 30;         // 마크다운 코드 블록 중 색을 입힐(편집기를 만들) 최대 개수. 넘치면 TextView로
const MD_LINE = 19;             // 편집기 줄 높이(글자 12px): 화면 실측 19px(22줄 간격 418px)
// GitHub 알림 종류 → 이름·색(테마 ansi)
const ALERT = { note: ["참고", "ansi4"], tip: ["팁", "ansi2"], important: ["중요", "ansi5"], warning: ["주의", "ansi3"], caution: ["경고", "ansi1"] };
// 툴바 아이콘 색: 기능마다 하나.
const TOOL = { search: "#a7c080", hidden: "#7fbbb3", ignored: "#a07850", file: "#83c092", folder: "#dbbc7f",
  reveal: "#7aa2f7", terminal: "#83c092", copy: "#d699b6", collapse: "#9da9a0", refresh: "#7fbbb3", more: "#9da9a0" };
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// git 상태 색 (WebStorm 기본 다크 테마 톤)
// 충돌(U)은 새 파일(?)과 갈리게 테마의 빨강(t.ansi1)을 쓴다: gitColor 참고.
const GIT = { M: "#6897bb", A: "#629755", "?": "#d1675a", D: "#8c8c8c", I: "#a07850" };
const gitColor = (mark, t) => (mark === "U" ? t.ansi1 : GIT[mark]);
// 확장자 → VS Code 언어 id: Material Icon Theme는 흔한 언어를 확장자 대신 언어 id로 매핑한다.
const LANGUAGE = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  json: "json", jsonc: "jsonc", md: "markdown", yaml: "yaml", yml: "yaml", toml: "toml",
  css: "css", scss: "scss", sass: "sass", less: "less", html: "html", htm: "html", xml: "xml",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", sql: "sql", rb: "ruby", php: "php",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", dart: "dart", lua: "lua",
  vue: "vue", svelte: "svelte", graphql: "graphql", gql: "graphql", prisma: "prisma", txt: "plaintext",
};

let ICONS = null, ICONS_LOADING = false; // icons.json (한 번 읽어 모든 복사본이 같이 쓴다)

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());

function iconFor(name, dir, open) {
  const m = ICONS;
  if (!m) return null;
  const light = !settings().dark ? m.light : null;
  const look = (k, x) => (light?.[k]?.[x]) ?? m[k][x];
  const lower = name.toLowerCase();
  let id;
  if (dir) {
    id = open ? look("folderNamesExpanded", lower) : look("folderNames", lower);
    id ??= open ? m.folderExpanded : m.folder;
  } else {
    id = look("fileNames", lower);
    // "a.test.ts" → "test.ts", "ts" 순으로 긴 확장자부터 찾는다.
    const parts = lower.split(".");
    for (let i = 1; !id && i < parts.length; i++) id = look("fileExtensions", parts.slice(i).join("."));
    if (!id && parts.length > 1) { const lang = LANGUAGE[parts.at(-1)]; if (lang) id = look("languageIds", lang); }
    id ??= m.file;
  }
  return `${ME}/icons/${id}.svg`;
}

async function directory(path, on) {
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "폴더를 읽지 못했습니다");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export class FilesApp {
  init(_props, cx) {
    this.tick = shared(TICK); this.preview = shared(PREVIEW);
    this.tools = [];
    cx.spawn(async () => {
      const r = await exec("sh", ["-lc", "for c in code cursor webstorm zed idea subl; do command -v $c >/dev/null 2>&1 && echo $c; done"]).catch(() => null);
      this.tools = (r?.stdout ?? "").split("\n").filter(Boolean);
    });
    const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
    this.showHidden = load("showHidden", true); this.hideIgnored = load("hideIgnored", false); this.sel = "";
    this.searching = false; this.query = ""; this.all = null;
    this.searchInput = InputState.new({ placeholder: "파일 이름" });
    this.searchInput.on("change", (_e, cx) => { this.query = this.searchInput.value().trim().toLowerCase(); cx.notify(); });
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set();
    this.marks = {}; this.ignored = new Set();
    this.refresh(cx);
    this.poll = cx.timer.every(10000, (cx) => { if (this.disposed) return; this.refresh(cx); });
  }

  // 앱을 끌 때(main.js toggle): 10초 타이머를 끊고 폴더 감시 사슬이 다음 차례에 멈추게 한다.
  // watchFolder는 해제 API가 없어 지금 기다리는 한 번은 끝까지 기다리고, 그 뒤 disposed를 보고 빠진다.
  dispose() {
    this.disposed = true;
    this.poll?.cancel(); this.poll = null;
    this.watchTask?.cancel(); this.watchTask = null;
  }

  watch(root, cx) {
    if (this.disposed || this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    this.watchTask = cx.spawn(async (cx) => {
      try { while (!this.disposed && this.context === context) { await watchFolder(root); if (!this.disposed && this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.ignored = new Set(); this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, ignored = new Set();
        if (top?.code === 0) {
          const base = top.stdout.trim();
          // .git 아래에 아무것도 쓰지 않는다(index lock 등): 폴더 감시가 다시 깨어나지 않게.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z",
            "--no-renames", "--untracked-files=normal", "--ignored=matching"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2), path = `${base}/${entry.slice(3)}`.replace(/\/$/, "");
            if (xy === "!!") { ignored.add(path); continue; }
            marks[path] = xy === "??" ? "?" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.ignored = ignored; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    this.sel = path; this.cur = path;
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // 오른쪽 뷰어에 파일을 연다. 형식별 미리보기는 viewers.js가 만든다.
  // 요청 번호(this.req): 같은 파일을 연달아 열면 비동기 작업 둘이 모두 `this.file === path`를 통과해
  // 먼저 만든 편집기 상태가 release 없이 덮였다. 마지막 요청만 결과를 반영한다.
  show(path, cx) {
    const req = this.req = (this.req ?? 0) + 1;
    this.releaseEditors(); this.file = path; this.view = null; this.sheet = 0;
    if (path) this.cur = path;   // 키보드 커서(move)도 연 파일로
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on, ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "", abs = `${root}/${path}`;
    const latest = () => this.req === req && this.file === path && this.current(context);
    cx.spawn(async (cx) => {
      let v;
      try { v = await preview(abs, ext, on); } catch (e) { v = { kind: "error", message: `미리보기를 만들지 못했습니다: ${String(e?.message ?? e).slice(0, 80)}` }; }
      if (!latest()) return;
      this.releaseEditors();   // 만일을 위해: 남아 있는 상태가 있으면 덮기 전에 놓아 준다
      makeEditors(this, v);
      this.view = v;
      cx.notify();
      // 글을 먼저 그린 뒤, 남은 원격 그림을 받아 채우고 다시 그린다(그동안 그 자리는 흐린 대체 글)
      if (v.kind === "md" && v.pendingRemote) {
        await mdRemoteImages(v.blocks, abs).catch(() => 0);
        v.pendingRemote = false;
        if (latest() && this.view === v) cx.notify();
      }
    });
  }

  releaseEditors() {
    releaseEditors(this);
  }

  // 무시됨: 자기 경로나 상위 폴더가 무시 목록에 있으면.
  isIgnored(abs) {
    for (let p = abs; p.length > (this.root?.length ?? 0); p = p.slice(0, p.lastIndexOf("/"))) if (this.ignored.has(p)) return true;
    return false;
  }

  // 트리에서 지금 보이는 줄(rows와 같은 순서·같은 거르기)의 { path, dir } 목록. 키보드 이동(move)이 쓴다.
  visible(prefix = "", depth = 0, out = []) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ((!this.showHidden && entry.name.startsWith(".")) || (this.hideIgnored && this.isIgnored(`${this.root}/${path}`))) continue;
      out.push({ path, dir: entry.dir });
      if (entry.dir && this.folders.has(path)) this.visible(path, depth + 1, out);
    }
    return out;
  }

  // 셸 계약: 왼쪽 칸에서 ↑(-1)/↓(+1). 커서(this.cur)를 보이는 줄로 옮긴다.
  //   폴더면 고른 폴더(this.sel, 새 파일·폴더를 만들 곳)도 그 폴더로, 파일이면 미리보기를 연다(클릭과 같게 sel은 그대로).
  //   검색 중이면 검색 결과를 오간다.
  move(d, cx) {
    const list = this.searching ? this.hits().map((path) => ({ path, dir: false })) : this.visible();
    if (!list.length) return;
    const i = list.findIndex((r) => r.path === this.cur);
    const next = list[i < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d))];
    if (next.dir) { this.sel = next.path; this.cur = next.path; }
    else if (next.path !== this.file) this.show(next.path, cx);
    else this.cur = next.path;
  }

  // 셸 계약: 왼쪽 칸에서 Enter. 폴더면 펼치기/접기, 파일이면 미리보기.
  activate(cx) {
    const p = this.cur;
    if (!p) return;
    // 검색 중이면 커서가 검색 결과에 있을 때만(트리에서 남은 폴더 경로를 파일로 열지 않게)
    const row = this.searching ? (this.hits().includes(p) ? { path: p, dir: false } : null) : this.visible().find((r) => r.path === p);
    if (!row) return;
    if (row.dir) this.toggle(p, cx); else this.show(p, cx);
  }

  // 셸 계약: 오른쪽이 비었을 때 문구
  emptyState() {
    return { text: "열린 파일이 없습니다", sub: "왼쪽 트리에서 파일을 고르세요 · ↑↓ 이동 · Enter 열기" };
  }

  // ⋯ 메뉴의 보기 전환(main.js가 files-toggle-hidden · files-toggle-ignored 명령으로 부른다)
  toggleView(k, cx) {
    if (k !== "showHidden" && k !== "hideIgnored") return;
    this[k] = !this[k];
    this.save(k, this[k]);
    cx?.notify();
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), abs = `${this.root}/${path}`;
      const ignored = this.isIgnored(abs), mark = this.marks[abs];
      if ((!this.showHidden && entry.name.startsWith(".")) || (this.hideIgnored && ignored)) continue;
      const color = mark ? gitColor(mark, t) : ignored ? GIT.I : t.foreground;
      const icon = iconFor(entry.name, entry.dir, open);
      out.push(h_flex().id(`file-${path}`).h(24).flex_none().pl(6 + depth * 16).pr(8).gap(5).items_center().rounded(4)
        .cursor_pointer().hover((s) => s.bg(t.hover)).when(this.file === path || (entry.dir && this.sel === path), (el) => el.bg(t.selected))
        .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.show(path, cx)))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(this.ctxFor(path, entry.dir, mark, ignored)); })
        .child(entry.dir ? svg(`${ME}/chevron-${open ? "down" : "right"}.svg`).size(14).flex_none().text_color(t.foreground) : div().w(14).flex_none())
        .child(icon ? image(icon).size(16).flex_none() : div().w(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(color).child(entry.name))
        // 색만으로 상태를 알리지 않게 오른쪽 끝에 git 상태 글자(M·A·D·U·?)를 흐리게. 충돌은 빨강.
        .when(Boolean(mark), (el) => el.child(div().flex_none().text_size(11).text_color(mark === "U" ? t.ansi1 : t.muted).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // 메뉴·입력 창으로 넘기는 정보(값만).
  ctxFor(path, dir, mark = null, ignored = false) {
    const name = path ? path.split("/").pop() : (this.root ?? "").split("/").pop();
    return { kind: !path ? "root" : dir ? "dir" : "file", path, abs: path ? `${this.root}/${path}` : this.root, dir, root: this.root, on: this.on,
      mark, ignored, tools: this.tools, home: home(), icon: iconFor(name, dir, false) };
  }

  // 메뉴를 열기 전에 파일 종류에 따라 필요한 정보를 읽어 둔다(스크립트, 패키지 매니저, make 대상).
  openMenu(ctx) {
    this.hideTip();
    const name = ctx.abs.split("/").pop().toLowerCase(), dirOf = ctx.kind === "file" ? ctx.abs.slice(0, ctx.abs.lastIndexOf("/")) : ctx.abs;
    const needsPm = ctx.kind === "file" && /^(package\.json|package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$|\.(test|spec)\.|\.[cm]?[jt]sx?$/.test(name);
    const open = () => { const h = menuHeight(ctx); openOverlay({ mod: "office-apps", kind: "popup", at: popupAt(320, h), width: 320, height: h, props: { role: "menu", ctx } }); };
    if (!needsPm && name !== "makefile" && name !== "gnumakefile") return open();
    exec("sh", ["-c", `
      d="$1"; while [ "$d" != "/" ] && [ -n "$d" ]; do
        for f in bun.lock bun.lockb pnpm-lock.yaml yarn.lock package-lock.json; do [ -e "$d/$f" ] && echo "$f" && exit 0; done
        [ "$d" = "$2" ] && break; d=$(dirname "$d"); done`, "pm", dirOf, this.root], { on: this.on }).catch(() => null)
      .then(async (r) => {
        const lock = (r?.stdout ?? "").trim();
        ctx.pm = lock.startsWith("bun") ? "bun" : lock.startsWith("pnpm") ? "pnpm" : lock.startsWith("yarn") ? "yarn" : "npm";
        if (name === "package.json") {
          try { ctx.scripts = JSON.parse(await readTextFile(ctx.abs, { on: this.on }))?.scripts ?? {}; } catch { ctx.scripts = {}; }
        }
        if (name === "makefile" || name === "gnumakefile") {
          const text = (await readTextFile(ctx.abs, { on: this.on }).catch(() => "")) ?? "";
          ctx.targets = [...new Set([...text.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)].map((x) => x[1]))].slice(0, 30);
        }
        open();
      });
  }

  // 툴바: 새 파일·폴더는 고른 폴더(마지막으로 누른 폴더, 없으면 맨 위)에 만든다.
  toolbar(t) {
    const dir = this.sel ? `${this.root}/${this.sel}` : this.root, where = this.sel || "맨 위";
    const btn = (id, icon, tip, on, fn) => div().id(`ft-${id}`).p(4).rounded(4).flex_none()
      .on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); })
      .when(on, (el) => el.bg(t.selected))
      .when(Boolean(fn), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.hideTip(); fn(cx); cx.notify(); }))
      .child(svg(`${ME}/${icon}.svg`).size(16).text_color(fn ? TOOL[id] : t.dim));
    const sep = () => div().w(1).h(16).mx(4).flex_none().bg(t.border);
    const ask = (action, title, hint) => openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 210,
      props: { role: "prompt", action, title, hint, ctx: this.ctxFor(this.sel, true) } });
    const ok = Boolean(this.root);
    return v_flex().flex_none()
      // 250px 칸에서 한 줄에 들어가게: 숨김 파일·gitignore 전환과 경로 복사는 ⋯ 메뉴(moreMenu)로 옮겼다
      .child(h_flex().h(32).flex_none().px(6).gap(2).items_center().overflow_hidden().border_b_1().border_color(t.border)
        // 켜고 끄는 버튼은 한 자리에서 아이콘으로 지금 상태를 보여 준다(걸러 내는 중이면 배경도 칠함).
        .child(btn("search", this.searching ? "close" : "search", this.searching ? "검색 중 · 누르면 닫기" : "파일 검색 (이름으로)", this.searching, ok && ((cx) => this.toggleSearch(cx))))
        .child(sep())
        .child(btn("file", "file-new", `새 파일 (${where}에)`, false, ok && (() => ask("file", "새 파일", `${where}에 만들 파일 이름 (하위 폴더는 a/b.ts처럼)`))))
        .child(btn("folder", "folder-new", `새 폴더 (${where}에)`, false, ok && (() => ask("folder", "새 폴더", `${where}에 만들 폴더 이름`))))
        .child(sep())
        .child(btn("terminal", "terminal", `여기서 터미널 열기 (${where})`, false, ok && (() => { run("tab.new", { folder: dir }); run("layout.show", { id: "office-term" }); })))
        .child(div().flex_1())
        // 펼치기/접기도 한 자리: 열린 폴더가 있으면 모두 접기, 없으면 맨 위 폴더들을 펼치기.
        .child(this.folders.size
          ? btn("collapse", "collapse", "모두 접기", false, ok && (() => { this.folders = new Set(); this.sel = ""; }))
          : btn("collapse", "expand", "맨 위 폴더 모두 펼치기", false, ok && ((cx) => { for (const e of this.entries.get("") ?? []) if (e.dir && !this.folders.has(e.name)) this.toggle(e.name, cx); this.sel = ""; })))
        .child(btn("refresh", "refresh", "다시 읽기", false, ok && ((cx) => { this.all = null; this.refresh(cx); })))
        // 걸러 내는 중이면(숨김 감춤 · gitignore 감춤) ⋯도 배경을 칠해 지금 상태를 알린다
        .child(btn("more", "more", "보기 · 복사", !this.showHidden || this.hideIgnored, ok && (() => this.moreMenu(dir)))))
      .when(this.searching, (el) => el.child(h_flex().h(34).px(8).gap(6).items_center().border_b_1().border_color(t.border)
        .child(svg(`${ME}/search.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.searchInput).h(26).text_size(12).text_color(t.foreground)))));
  }

  // ⋯ 메뉴: 보기 전환 두 개(체크 표시) + 경로 복사. 메뉴는 오버레이 복사본에서 그려지므로
  //   전환은 명령(office-apps.files-toggle-*)으로 런처에 돌려보내고, 복사는 menu.js ACTIONS가 바로 한다.
  moreMenu(dir) {
    this.hideTip();
    const target = this.file ? `${this.root}/${this.file}` : dir;
    const ctx = { ...this.ctxFor("", true), kind: "tools", title: "보기 · 복사", abs: target, items: [
      { label: "숨김 파일 보이기", icon: "eye", color: TOOL.hidden, check: this.showHidden, cmd: "files-toggle-hidden", hint: ".으로 시작" },
      { label: "gitignore 항목 감추기", icon: "ignored-off", color: TOOL.ignored, check: this.hideIgnored, cmd: "files-toggle-ignored" },
      "-",
      { label: "경로 복사", icon: "copy", color: TOOL.copy, action: "copyPath", hint: (this.file ?? (this.sel || "맨 위")) },
    ] };
    const h = menuHeight(ctx);
    openOverlay({ mod: "office-apps", kind: "popup", at: popupAt(280, h), width: 280, height: h, props: { role: "menu", ctx } });
  }

  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 */ } }

  async copy(text) {
    await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]);
    notify({ title: "경로를 복사했습니다", body: text.replace(home(), "~"), level: "info" });
  }

  // 검색: 처음 열 때 레포 파일 목록(추적 + 추적 안 된 것, gitignore 제외)을 한 번 읽어 이름으로 거른다.
  toggleSearch(cx) {
    this.searching = !this.searching;
    if (!this.searching) { this.query = ""; this.searchInput.set_value(""); return; }
    this.searchInput.focus();
    if (this.all) return;
    const context = this.context;
    cx.spawn(async (cx) => {
      let r = await exec("git", ["ls-files", "-co", "--exclude-standard"], { cwd: this.root, on: this.on }).catch(() => null);
      if (r?.code !== 0) r = await exec("sh", ["-c", 'cd "$1" && find . -type f -not -path "*/.git/*" | head -20000 | sed "s|^./||"', "find", this.root], { on: this.on }).catch(() => null);
      if (this.context === context) this.all = (r?.stdout ?? "").split("\n").filter(Boolean);
      cx.notify();
    });
  }

  // 검색 결과 경로(최대 300개). 그리기(results)와 키보드 이동(move)이 함께 쓴다.
  hits() {
    const q = this.query;
    if (!this.all || !q) return [];
    return this.all.filter((p) => p.split("/").pop().toLowerCase().includes(q)).slice(0, 300);
  }

  results(t) {
    const q = this.query;
    if (!this.all) return [div().p(8).text_size(12).text_color(t.dim).child("파일 목록을 읽는 중")];
    if (!q) return [div().p(8).text_size(12).text_color(t.dim).child(`파일 ${this.all.length.toLocaleString()}개에서 찾습니다`)];
    const hits = this.hits();
    if (!hits.length) return [div().p(8).text_size(12).text_color(t.dim).child("맞는 파일이 없습니다")];
    return hits.map((path) => {
      const name = path.split("/").pop(), icon = iconFor(name, false, false), mark = this.marks[`${this.root}/${path}`];
      return h_flex().id(`hit-${path}`).h(24).flex_none().px(6).gap(6).items_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover)).when(this.file === path, (el) => el.bg(t.selected)).on_click((_e, cx) => this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(this.ctxFor(path, false, mark, false)); })
        .child(icon ? image(icon).size(16).flex_none() : div().w(16).flex_none())
        .child(div().flex_none().text_color(mark ? gitColor(mark, t) : t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""));
    });
  }

  // 툴팁: 아이콘 바로 위, 아이콘 가운데에. 칸 밖까지 그리도록 창 오버레이로 띄운다.
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

  // 아이콘 표는 모듈에 한 번만 읽어 둔다. 코드를 다시 불러오면(핫 리로드) 모듈 값이 비고 init은 다시
  // 돌지 않으므로, 그릴 때 비어 있으면 읽는다.
  loadIcons(cx) {
    if (ICONS || ICONS_LOADING) return;
    ICONS_LOADING = true;
    cx.spawn(async (cx) => {
      try { ICONS = JSON.parse(await readTextFile(`${appHome()}/${ME}/icons.json`)); } catch { ICONS = null; }
      ICONS_LOADING = false;
      cx.notify();
    });
  }

  // 앱 셸이 그릴 때마다 부른다: 데이터 갱신 확인(이름이 this.tick 값과 겹치지 않게 sync)
  sync(cx) {
    this.loadIcons(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    if (shared(TICK) !== this.tick) { this.tick = shared(TICK); this.all = null; this.refresh(cx); }
    const pv = shared(PREVIEW);
    if (pv !== this.preview) { this.preview = pv; if (pv?.root === this.root) this.show(pv.path, cx); }
  }

  // 왼쪽: 툴바 + 트리(또는 검색 결과)
  list(cx, t) {
    this.sync(cx);
    return v_flex().flex_1().min_h(0)
      .child(this.toolbar(t))
      .when(this.searching, (el) => el.child(v_flex().id("files-hits").flex_1().min_h(0).overflow_y_scrollbar().p(4).children(this.results(t))))
      .when(!this.searching, (el) => el.child(v_flex().id("files-tree")
        .on_mouse_down("right", (_e, cx) => { if (this.root) { cx.stop_propagation(); this.openMenu(this.ctxFor("", true, null, false)); } }).flex_1().min_h(0).overflow_y_scrollbar().p(4).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim)
          .child(this.error || (this.loading ? "파일을 읽는 중" : this.root ? "파일이 없습니다" : "폴더가 없습니다"))))
        .when(this.limited, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("폴더당 500개, 전체 5,000개까지만 보여 줍니다")))));
  }

  // 타이틀 옆 부제: 프로젝트 경로(누르면 Finder)
  subtitle(t) {
    const where = this.root ? this.root.replace(home(), "~") : "";
    return div().id("files-path").truncate().text_size(12).text_color(t.dim)
      .when(Boolean(this.root) && !this.on, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", [this.root])))
      .child(where);
  }

  // 오른쪽: 고른 파일의 뷰어
  detail(cx, t) {
    if (!this.file) return null;
    const abs = `${this.root}/${this.file}`, name = this.file.split("/").pop(), v = this.view, local = !this.on;
    const icon = iconFor(name, false, false);
    const W = Math.max(200, (this.dw ?? 600) - 40);
    const btn = (id, text, fn) => div().id(id).px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn).child(text);
    const dir = this.file.includes("/") ? this.file.slice(0, this.file.lastIndexOf("/")) : "";
    const body = previewBody(this, t, W, (url, cx) => this.openLink(url, dir, cx));
    return v_flex().size_full().min_h(0)
      .on_size_change((size, cx) => { if (Math.abs((this.dw ?? 0) - size.width) > 4) { this.dw = size.width; cx.notify(); } })
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .when(Boolean(icon), (el) => el.child(image(icon).size(16).flex_none()))
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(name))
        // 경로 클릭(Finder에서 보기)과 "기본 앱으로 열기"는 이 Mac의 파일일 때만. 원격 기기 파일은 경로만 보인다.
        .child(div().id("files-detail-path").flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
          .when(local, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", ["-R", abs])))
          .child(v?.note ?? this.file))
        .when(local, (el) => el.child(btn("files-open-ext", "기본 앱으로 열기", () => exec("open", [abs]))))
        .child(div().id("files-close").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("✕")))
      .child(body);
  }

  // 마크다운 링크: http·mailto는 브라우저로, 상대 경로는 이 파일 앱에서 연다(#제목 링크는 무시).
  // 프로젝트 밖 절대 경로는 이 Mac이면 기본 앱으로, 원격 기기면 이 Mac에 없는 경로라 무시한다.
  openLink(url, dir, cx) {
    if (/^(https?|mailto):/i.test(url)) { exec("open", [url]); return; }
    let p = decodeURIComponent(url.replace(/^file:\/\//i, "").replace(/[?#].*$/, ""));
    if (!p) return;
    if (p.startsWith(this.root + "/")) p = p.slice(this.root.length + 1);
    else if (p.startsWith("/")) { if (!this.on) exec("open", [p]); return; }
    else {
      const out = dir ? dir.split("/") : [];
      for (const part of p.split("/")) { if (part === "..") out.pop(); else if (part && part !== ".") out.push(part); }
      p = out.join("/");
    }
    this.show(p, cx);
    cx.notify();
  }
}

// ── 형식별 미리보기 그리기: 파일 앱(오른쪽 칸)과 뷰어 창(오버레이 역할 viewer)이 함께 쓴다 ──
//   s = 미리보기를 가진 쪽(FilesApp 또는 ViewerWindow): { view, code, mdCode, sheet }
//   view는 viewers.js preview()의 결과, code·mdCode는 makeEditors가 만든 편집기 상태.

// 편집기 상태 만들기. 편집기는 렌더 중에 만들 수 없어 미리보기를 받은 직후(이벤트·비동기 시점)에 만든다.
//   z: 배율(뷰어 창만 바꾼다, 파일 앱은 1). 편집기는 글자 크기를 나중에 못 바꿔 배율이 바뀌면 다시 만든다.
export function makeEditors(s, v, z = 1) {
  const t = theme(), syntax = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
  if (v.kind === "code") s.code = EditorState.new({ language: v.lang, readonly: true, value: v.text, font_family: CODE_FONT, font_size: 12 * z, syntax });
  // 마크다운 코드 블록: 블록마다 읽기 전용 편집기(줄 번호·접기 없음)
  if (v.kind === "md") {
    let n = 0;
    s.mdCode = v.blocks.map((b) => (b.kind === "code" && n++ < MD_CODE_MAX
      ? EditorState.new({ language: codeLang(b.lang), readonly: true, value: b.text, font_family: CODE_FONT, font_size: 12 * z, line_numbers: false, folding: false, syntax })
      : null));
  }
}

// 편집기 상태 놓아 주기
export function releaseEditors(s) {
  s.code?.release(); s.code = null;
  for (const c of s.mdCode ?? []) c?.release();
  s.mdCode = [];
}

// 미리보기 본문. W: 그림·표를 맞출 폭. onLink(url, cx): 마크다운 링크·그림 링크를 눌렀을 때.
//   z: 배율(뷰어 창의 −/+). 글자 크기와 그림 표시 크기에 곱한다. 1보다 크면 그림이 W를 넘으니 가로로도 스크롤한다.
export function previewBody(s, t, W, onLink, z = 1) {
  const v = s.view;
  if (!v) return v_flex().flex_1().items_center().justify_center().text_color(t.muted).child("미리보기를 만드는 중");
  if (v.kind === "code") return s.code ? Editor.new(s.code).flex_1().min_h(0) : div();
  const wide = (el) => (z > 1 ? el.overflow_scrollbar().items_start() : el.overflow_y_scrollbar().items_center());
  if (v.kind === "md") return v_flex().id("files-md").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16).gap(12 * z).text_size(14 * z).font_family(CODE_FONT)
    .children(markdownView(s, v.blocks, W - 8, t, onLink, z));
  if (v.kind === "pages") return wide(v_flex().id("files-pages").flex_1().min_h(0).p(20).gap(16))
    .children(v.pages.map((p, i) => {
      const w = Math.round(Math.min(W, p.w) * z), h = Math.round((w * p.h) / Math.max(1, p.w));
      return v_flex().when(z > 1, (x) => x.flex_none()).gap(4).items_center()
        .child(image(p.path).w(w).h(h).rounded(4).shadow_md())
        .when(v.pages.length > 1, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${i + 1} / ${v.count}`)));
    }));
  if (v.kind === "table") return tableView(s, v, t, z);
  if (v.kind === "slides") return v_flex().id("files-slides").flex_1().min_h(0).p(20).gap(14).when(z > 1, (el) => el.overflow_scrollbar()).when(z <= 1, (el) => el.overflow_y_scrollbar())
    .when(Boolean(v.thumb), (el) => { const w = Math.round(Math.min(W, v.thumb.w) * z); return el.child(image(v.thumb.path).when(z > 1, (x) => x.flex_none()).w(w).h(Math.round(w * v.thumb.h / v.thumb.w)).rounded(4).shadow_md()); })
    .children(v.slides.map((sl) => v_flex().gap(3)
      .child(div().text_size(11 * z).font_semibold().text_color(t.muted).child(`슬라이드 ${sl.n}`))
      .children(sl.texts.map((tx, i) => div().text_size((i === 0 ? 14 : 13) * z).when(i === 0, (x) => x.font_semibold()).text_color(t.foreground).child(tx)))));
  return v_flex().flex_1().items_center().justify_center().gap(10).text_color(t.muted)
    .child(div().text_size(13 * z).child(v.message ?? "미리볼 수 없는 파일입니다"));
}

// 마크다운 블록(markdown.js): 글은 TextView, 코드는 편집기, 알림은 왼쪽 선 + 이름, 그림은 image()
function markdownView(s, blocks, W, t, onLink, z = 1) {
  const md = (id, text) => TextView.markdown(id, text).on_link_click((url, cx) => onLink(url, cx));
  return blocks.map((b, i) => {
    const id = `files-md-${i}`;
    if (b.kind === "text") return b.notes ? div().text_size(12 * z).text_color(t.muted).child(md(id, b.text)) : md(id, b.text);
    if (b.kind === "code") {
      const st = s.mdCode?.[i];
      if (!st) return md(id, "```" + (b.lang ?? "") + "\n" + b.text + "\n```");
      const lines = b.text.split("\n").length;
      return v_flex().rounded(4).bg(t.surface).border_1().border_color(t.border).px(12).py(10).gap(4)
        .when(Boolean(b.lang), (el) => el.child(div().text_size(11 * z).text_color(t.dim).child(b.lang)))
        .child(Editor.new(st).w_full().h(Math.ceil(lines * MD_LINE * z) + 6));
    }
    if (b.kind === "alert") {
      const [label, color] = ALERT[b.type] ?? ALERT.note;
      return v_flex().pl(12).gap(4).border_l_2().border_color(t[color])
        .child(div().text_size(13 * z).font_semibold().text_color(t[color]).child(label))
        .child(md(id, b.text));
    }
    if (b.kind === "images") return h_flex().flex_wrap().gap(6).items_end().when(Boolean(b.center), (el) => el.justify_center()).children(b.items.map((it, j) => {
      // 받는 중(pending)인 원격 그림은 대체 글을 더 흐리게, 못 가져온 그림은 대체 글로
      if (!it.path) return div().text_size(12 * z).text_color(t.dim).when(Boolean(it.pending), (el) => el.opacity(0.45)).child(`[그림${it.alt ? `: ${it.alt}` : ""}]`);
      // 배율을 곱하되 본문 폭(W)은 넘지 않는다: 글은 W에서 줄바꿈하므로 마크다운은 가로 스크롤을 두지 않는다
      const w = Math.round(Math.min(W, (it.width ?? it.w) * z)), h = Math.round((w * it.h) / Math.max(1, it.w));
      const img = image(it.path).w(w).h(h);
      return it.link ? div().id(`${id}-${j}`).cursor_pointer().on_click((_e, cx) => onLink(it.link, cx)).child(img) : img;
    }));
    return null;
  }).filter(Boolean);
}

// 표(CSV·엑셀): 시트 탭 + 머리 행 고정 느낌의 격자. 칸은 같은 폭, 넘치면 가로로 스크롤. 고른 시트는 s.sheet.
function tableView(s, v, t, z = 1) {
  const sh = v.sheets[Math.min(s.sheet ?? 0, v.sheets.length - 1)] ?? { rows: [] };
  const cols = Math.min(60, Math.max(0, ...sh.rows.map((r) => r.length)));
  const CW = Math.round(132 * z), RW = Math.round(44 * z);
  const cell = (text, head, i) => div().w(i === -1 ? RW : CW).h(Math.round(26 * z)).flex_none().px(6).flex().items_center().border_r_1().border_b_1().border_color(t.border)
    .when(head, (x) => x.bg(t.raised).font_semibold()).when(i === -1, (x) => x.justify_end().text_color(t.dim).bg(t.raised))
    .text_size(12 * z).child(div().truncate().child(String(text ?? "")));
  const colName = (i) => { let c = "", n = i + 1; while (n > 0) { const m = (n - 1) % 26; c = String.fromCharCode(65 + m) + c; n = Math.floor((n - 1) / 26); } return c; };
  return v_flex().flex_1().min_h(0)
    .when(v.sheets.length > 1, (el) => el.child(h_flex().id("files-sheets").flex_none().px(10).py(6).gap(4).overflow_x_scrollbar().border_b_1().border_color(t.border)
      .children(v.sheets.map((x, i) => div().id(`sheet-${i}`).px(10).py(3).rounded(5).text_size(12).cursor_pointer()
        .bg(i === (s.sheet ?? 0) ? t.selected : t.chrome).text_color(i === (s.sheet ?? 0) ? t.foreground : t.muted)
        .hover((y) => y.bg(t.hover)).on_click((_e, cx) => { s.sheet = i; cx.notify(); }).child(x.name)))))
    .child(div().id("files-grid").flex_1().min_h(0).overflow_scrollbar()
      .child(v_flex().w(RW + cols * CW)
        .child(h_flex().child(cell("", true, -1)).children(Array.from({ length: cols }, (_, i) => cell(colName(i), true, i))))
        .children(sh.rows.map((r, ri) => h_flex().child(cell(ri + 1, false, -1)).children(Array.from({ length: cols }, (_, i) => cell(r[i], false, i)))))
        .when(Boolean(sh.more), (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("앞부분만 보여 줍니다(최대 500행)")))));
}

// ── 뷰어 창: 에이전트 활동의 파일 줄을 누르면 뜨는 떠 있는 창(오버레이 kind "window", 역할 viewer) ──
//   props { role: "viewer", file: 절대 경로, on?: 원격 머신 이름, w, h: 연 크기(px) }
//   머리줄(아이콘 · 이름 · 흐린 경로 · 배율 −/100%/+ · 크기 ⤢ · 기본 앱으로 열기 · Finder에서 보기 · ✕)의 빈 곳을 잡고 끌어 옮긴다.
//   버튼·본문·모서리 손잡이는 누름을 멈춰(stop_propagation) 글 고르기·스크롤·크기 끌기가 창 끌기가 되지 않게 한다.
//   원격 파일은 preview가 글로만 읽고, 기본 앱·Finder 버튼은 이 기기 파일일 때만 보인다.
//   위치: key가 하나(VIEWER_KEY)라 Herdr가 놓은 자리를 기억하고, 다른 파일을 열면 같은 창이 그 자리에서 내용만 바뀐다.
//   크기: Herdr 창에는 가장자리 끌기가 없어 ⤢(작게·보통·크게·화면 가득 순환)와 오른쪽 아래 손잡이로 고른 크기로
//     같은 key를 다시 연다(그 자리에서 크기만 바뀐다). 크기·배율은 공유 상태 + localStorage에 남기고,
//     사무실 오버뷰(office/main.js openViewer)는 공유 상태 VIEWER_SIZE를 읽어 같은 크기로 연다.
export const VIEWER_KEY = "office-apps.viewer", VIEWER_SIZE = "office-apps.viewer.size", VIEWER_ZOOM = "office-apps.viewer.scale";
export const VIEWER_W = DEFAULT_SIZE.w, VIEWER_H = DEFAULT_SIZE.h;   // 처음 크기(office/main.js openViewer도 같은 값)
const viewport = () => { try { return globalThis.window?.viewport_size?.() ?? null; } catch { return null; } };
const stored = (k) => { try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return null; } };
const remember = (k, v) => { setShared(k, v); try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 공유 상태에는 남았다 */ } };
export const viewerSize = () => clampSize(pickSize(shared(VIEWER_SIZE), stored(VIEWER_SIZE)), viewport());

// 여는 함수. office 모드는 다른 모드라 이 함수를 import할 수 없어 같은 openOverlay를 직접 부른다(office/main.js openViewer).
export function openViewer(file, on = null, size = viewerSize()) {
  if (!file || !file.startsWith("/")) return;
  openOverlay({ mod: "office-apps", kind: "window", key: VIEWER_KEY,
    width: size.w, height: size.h, props: { role: "viewer", file, on: on ?? null, w: size.w, h: size.h } });
}

export class ViewerWindow {
  init(_p, cx) {
    const p = props() ?? {};
    this.on = p.on ?? null;
    this.size = pickSize({ w: p.w, h: p.h }, shared(VIEWER_SIZE), stored(VIEWER_SIZE));
    this.zoom = pickZoom(shared(VIEWER_ZOOM), stored(VIEWER_ZOOM));
    this.drag = null;       // 모서리 끌기 중: { from, start, to }
    this.origin = null;     // 창 왼쪽 위(앱 창 좌표): 포인터가 창 위를 지날 때 잰다
    this.h = cx.focus_handle();
    this.h.focus();   // Esc·⌘−/⌘=/⌘0을 받을 수 있게(창은 처음에 키보드를 갖지 않는다)
    this.open(p.file, cx);
  }

  // 파일 불러오기. 마크다운의 상대 링크도 이 창 안에서 다시 부른다(마지막 요청만 반영).
  open(abs, cx) {
    const req = this.req = (this.req ?? 0) + 1;
    releaseEditors(this); this.abs = abs; this.view = null; this.sheet = 0;
    if (!abs) return;
    const name = abs.split("/").pop(), ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    const latest = () => this.req === req && this.abs === abs;
    cx.spawn(async (cx) => {
      let v;
      try { v = await preview(abs, ext, this.on); } catch (e) { v = { kind: "error", message: `미리보기를 만들지 못했습니다: ${String(e?.message ?? e).slice(0, 80)}` }; }
      if (!latest()) return;
      releaseEditors(this);
      makeEditors(this, v, this.zoom);
      this.view = v;
      cx.notify();
      if (v.kind === "md" && v.pendingRemote) {
        await mdRemoteImages(v.blocks, abs).catch(() => 0);
        v.pendingRemote = false;
        if (latest() && this.view === v) cx.notify();
      }
    });
  }

  // 마크다운 링크: http·mailto는 브라우저로, 상대·절대 경로는 이 창에서 연다(#제목 링크는 무시)
  link(url, cx) {
    if (/^(https?|mailto):/i.test(url)) { exec("open", [url]); return; }
    let p = decodeURIComponent(url.replace(/^file:\/\//i, "").replace(/[?#].*$/, ""));
    if (!p) return;
    if (!p.startsWith("/")) {
      const out = this.abs.slice(0, this.abs.lastIndexOf("/")).split("/");
      for (const part of p.split("/")) { if (part === "..") out.pop(); else if (part && part !== ".") out.push(part); }
      p = out.join("/");
    }
    this.open(p, cx);
    cx.notify();
  }

  // 배율: dir +1 키우기, -1 줄이기, 0 100%로. 편집기는 글자 크기를 못 바꿔 다시 만든다.
  setZoom(dir, cx) {
    const z = stepZoom(this.zoom, dir);
    if (z === this.zoom) return;
    this.zoom = z;
    remember(VIEWER_ZOOM, z);
    if (this.view) { releaseEditors(this); makeEditors(this, this.view, z); }
    cx.notify();
  }

  // 창 왼쪽 위에서 앱 창 오른쪽·아래 끝까지 남은 칸(키운 창이 앱 창 밖으로 나가지 않게)
  room() {
    const v = viewport();
    if (!v || !this.origin) return null;
    return { width: v.width - this.origin.x - 8, height: v.height - this.origin.y - 8 };
  }

  // 새 크기로 같은 key를 다시 연다: Herdr가 열린 창을 그 자리에서 바꾼다(이 뷰는 새로 만들어진다).
  //   지금 보는 파일(this.abs: 마크다운 링크로 옮겨 갔을 수 있다)을 넘긴다. openOverlay는 마지막에.
  resize(size, cx) {
    const s = clampSize(size, viewport(), this.room());
    if (s.w === this.size.w && s.h === this.size.h) { cx.notify(); return; }
    remember(VIEWER_SIZE, s);
    releaseEditors(this);
    openViewer(this.abs, this.on, s);
  }

  // 모서리 끌기. 포인터가 창 밖으로 나가면 이 뷰에 move·up이 오지 않으므로, 누른 동안 앱 창의 포인터 위치를
  //   타이머로 읽어 테두리 미리보기만 그린다. 창 안에서 놓으면(on_mouse_up) 확정. 창 밖에서는 놓은 것을 알 길이 없어
  //   포인터가 창 밖에서 0.3초 멈추면 놓은 것으로 보고 확정한다(그 전에 누름이 오면 그때 확정). Esc는 취소.
  startDrag(e, cx) {
    cx.stop_propagation();
    const W = globalThis.window;
    const from = W?.mouse_position?.() ?? e.position;
    this.drag = { from, start: { ...this.size }, to: { ...this.size } };
    this.dragTask?.cancel();
    this.dragTask = cx.timer.every(16, (acx) => {
      if (!this.drag) return;
      let p;
      try { p = W.mouse_position(); } catch { return; }
      const g = this.drag, to = dragSize(g.start, g.from, p, viewport(), this.room());
      if (to.w !== g.to.w || to.h !== g.to.h) { g.to = to; acx.notify(); }
      const o = this.origin, outside = o && (p.x < o.x || p.y < o.y || p.x > o.x + (this.dw ?? g.start.w) || p.y > o.y + (this.dh ?? g.start.h));
      g.still = outside && g.last && g.last.x === p.x && g.last.y === p.y ? (g.still ?? 0) + 1 : 0;
      g.last = p;
      if (g.still >= 18) this.endDrag(acx);
    });
    cx.notify();
  }

  endDrag(cx, commit = true) {
    if (!this.drag) return false;
    const to = this.drag.to;
    this.dragTask?.cancel(); this.dragTask = null; this.drag = null;
    if (commit) this.resize(to, cx); else cx.notify();
    return true;
  }

  dismiss() {
    this.dragTask?.cancel();
    releaseEditors(this);
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme(), abs = this.abs ?? "", name = abs.split("/").pop(), icon = iconFor(name, false, false), local = !this.on;
    const where = (this.on ? `${this.on}:` : "") + (abs.startsWith(home() + "/") ? `~${abs.slice(home().length)}` : abs);
    const W = Math.max(200, (this.dw ?? this.size.w) - 40);
    // 컨트롤·본문의 누름이 창 끌기로 가지 않게. 창 밖에서 놓은 모서리 끌기는 이 누름에서 확정한다.
    const stop = (_e, cx) => { cx.stop_propagation(); this.endDrag(cx); };
    const btn = (id, text, fn) => div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(fn).child(text);
    // 흐린 작은 버튼(배율·크기·닫기)
    const quiet = (id, text, fn, off = false) => div().id(id).flex_none().px(6).py(2).rounded(4).text_size(12)
      .text_color(off ? t.dim : t.muted).when(!off, (x) => x.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", stop).when(!off, (x) => x.on_click((_e, cx) => fn(cx))).child(text);
    const z = this.zoom, d = this.drag, dh = this.dh ?? this.size.h;
    // 본문을 누르면 창이 키보드를 갖게(배율 단축키). 편집기는 스스로 포커스를 가지므로 빼 둔다(글 고르기·복사).
    const editors = this.view?.kind === "code" || (this.mdCode ?? []).some(Boolean);
    return v_flex().id("viewer").track_focus(this.h).relative().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        if (Math.abs((this.dw ?? 0) - size.width) > 4 || Math.abs((this.dh ?? 0) - size.height) > 4) { this.dw = size.width; this.dh = size.height; cx.notify(); }
      })
      .on_mouse_move((e) => { this.origin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y }; })
      .on_mouse_up("left", (_e, cx) => { this.endDrag(cx); })
      .on_mouse_down("left", (_e, cx) => { if (this.endDrag(cx)) cx.stop_propagation(); })
      .on_mouse_down_out((_e, cx) => { this.endDrag(cx); })
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") { cx.stop_propagation(); if (!this.endDrag(cx, false)) this.dismiss(); return; }
        const dir = k === "cmd--" || k === "cmd-_" ? -1 : k === "cmd-=" || k === "cmd-+" || k === "cmd-shift-=" ? 1 : k === "cmd-0" ? 0 : null;
        if (dir !== null) { cx.stop_propagation(); this.setZoom(dir, cx); }
      })
      // 머리줄: 빈 곳을 잡고 끈다(누르면 창이 키보드도 갖는다)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().bg(t.chrome).border_b_1().border_color(t.border)
        .on_mouse_down("left", () => this.h.focus())
        .when(Boolean(icon), (el) => el.child(image(icon).size(16).flex_none()))
        .child(div().flex_none().max_w(260).truncate().text_size(14).font_semibold().text_color(t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(d ? `${d.to.w} × ${d.to.h}` : this.view?.note ?? where))
        .child(h_flex().flex_none().items_center()
          .child(quiet("viewer-zoom-out", "−", (cx) => this.setZoom(-1, cx), z <= ZOOM_MIN))
          .child(quiet("viewer-zoom", `${Math.round(z * 100)}%`, (cx) => this.setZoom(0, cx)))
          .child(quiet("viewer-zoom-in", "+", (cx) => this.setZoom(1, cx), z >= ZOOM_MAX))
          .child(quiet("viewer-size", "⤢", (cx) => this.resize(nextPreset(this.size, viewport(), this.room()), cx))))
        .when(local, (el) => el
          .child(btn("viewer-open-ext", "기본 앱으로 열기", () => exec("open", [abs])))
          .child(btn("viewer-reveal", "Finder에서 보기", () => exec("open", ["-R", abs]))))
        .child(quiet("viewer-close", "✕", () => this.dismiss())))
      .child(v_flex().id("viewer-body").flex_1().min_h(0)
        .on_mouse_down("left", (e, cx) => { stop(e, cx); if (!editors) this.h.focus(); })
        .child(previewBody(this, t, W, (url, cx) => this.link(url, cx), z)))
      // 오른쪽 아래 손잡이: 누르고 끌면 크기 미리보기, 놓으면 그 크기로 다시 연다
      .child(div().id("viewer-grip").absolute().right(0).bottom(0).size(14).cursor_nwse_resize()
        .border_r_2().border_b_2().border_color(t.dim).opacity(0.5).hover((s) => s.opacity(1))
        .on_mouse_down("left", (e, cx) => this.startDrag(e, cx)))
      // 끄는 동안 테두리 미리보기(창 안에만 그려진다: 키울 때는 머리줄 숫자로 크기를 본다)
      .when(Boolean(d), (el) => el.child(div().absolute().left(0).top(0)
        .w(Math.min(d.to.w, this.dw ?? d.to.w)).h(Math.min(d.to.h, dh)).border_2().border_color(t.accent)));
  }
}

// 새 파일·새 폴더 이름을 받는 창. 만든 뒤 TICK으로 트리에 다시 읽으라고 알린다.
class Prompt {
  init(_p, cx) {
    const v = props()?.value ?? "";
    this.text = v;
    this.input = InputState.new({ value: v });
    // 이름 바꾸기: 확장자 앞까지만 골라 둔다.
    if (v) this.input.set_selected_range({ start: 0, end: v.lastIndexOf(".") > 0 ? v.lastIndexOf(".") : v.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  submit() {
    const p = props(), name = this.text.trim();
    if (!name || name.split("/").includes("..") || (p.action === "rename" && name.includes("/"))) return;
    closeOverlay(p.overlay);
    ACTIONS[p.action](p.ctx, name);
  }

  render() {
    const t = theme(), p = props();
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).cursor_pointer().text_size(12.5)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("files-prompt").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().child(div().flex_1().text_size(15).font_semibold().child(p.title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(12).text_color(t.dim).child(p.hint ?? ""))
      .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(13))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button("fp-no", "취소", false, () => closeOverlay(p.overlay)))
        .child(button("fp-yes", p.action === "rename" ? "바꾸기" : "만들기", true, () => this.submit())));
  }
}

class Tip {
  init() {}
  render() {
    const t = theme();
    return div().size_full().flex().items_center().justify_center().rounded(6).bg(t.popover).border_1().border_color(t.border)
      .text_size(12).text_color(t.foreground).whitespace_nowrap().child(props()?.text ?? "");
  }
}

export const ROLES = { prompt: Prompt, tip: Tip, menu: Menu, confirm: Confirm };
