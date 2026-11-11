// office 파일트리: Herdr 기본 files 모드를 바탕으로 WebStorm 같은 모양을 입혔다.
//   - 맨 위에 "프로젝트 ~/경로" 헤더
//   - Material Icon Theme 아이콘(폴더 이름·파일 이름·확장자별)
//   - git 상태로 파일 이름 색: 수정 파랑, 추가 초록, 추적 안 됨 빨강, 무시됨 갈색(흐리게)
// 지금 고른 스페이스(포커스된 패인)의 폴더를 보여 준다. 파일을 누르면 읽기 전용 미리보기.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, home, appHome, props, run, openOverlay, closeOverlay, notify, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { preview } from "./viewers.js";
import { codeLang } from "./markdown.js";
import { Menu, Confirm, ACTIONS, TICK, menuHeight, popupAt } from "./menu.js";
const PREVIEW = "office-apps.preview";

const ME = "mods/office-apps";
const PER_FOLDER = 500, TOTAL = 5000;
const CODE_FONT = "D2Coding";   // 코드·스크립트·마크다운 뷰어 글꼴(패널은 Pretendard GOV)
const MD_CODE_MAX = 30;         // 마크다운 코드 블록 중 색을 입힐(편집기를 만들) 최대 개수. 넘치면 TextView로
const MD_LINE = 18;             // 편집기 줄 높이(글자 12px)
// GitHub 알림 종류 → 이름·색(테마 ansi)
const ALERT = { note: ["참고", "ansi4"], tip: ["팁", "ansi2"], important: ["중요", "ansi5"], warning: ["주의", "ansi3"], caution: ["경고", "ansi1"] };
// 툴바 아이콘 색: 기능마다 하나.
const TOOL = { search: "#a7c080", hidden: "#7fbbb3", ignored: "#a07850", file: "#83c092", folder: "#dbbc7f",
  reveal: "#7aa2f7", terminal: "#83c092", copy: "#d699b6", collapse: "#9da9a0", refresh: "#7fbbb3" };
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// git 상태 색 (WebStorm 기본 다크 테마 톤)
const GIT = { M: "#6897bb", A: "#629755", "?": "#d1675a", U: "#d1675a", D: "#8c8c8c", I: "#a07850" };
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
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
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
    this.sel = path;
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
  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.view = null; this.sheet = 0;
    for (const c of this.mdCode ?? []) c?.release();
    this.mdCode = [];
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on, ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
    cx.spawn(async (cx) => {
      let v;
      try { v = await preview(`${root}/${path}`, ext, on); } catch (e) { v = { kind: "error", message: `미리보기를 만들지 못했습니다: ${String(e?.message ?? e).slice(0, 80)}` }; }
      if (this.file !== path || !this.current(context)) return;
      const t = theme(), syntax = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
      if (v.kind === "code") this.code = EditorState.new({ language: v.lang, readonly: true, value: v.text, font_family: CODE_FONT, font_size: 12, syntax });
      // 마크다운 코드 블록: 블록마다 읽기 전용 편집기(줄 번호·접기 없음). 편집기는 렌더 중에 만들 수 없어 여기서 만든다.
      if (v.kind === "md") {
        let n = 0;
        this.mdCode = v.blocks.map((b) => (b.kind === "code" && n++ < MD_CODE_MAX
          ? EditorState.new({ language: codeLang(b.lang), readonly: true, value: b.text, font_family: CODE_FONT, font_size: 12, line_numbers: false, folding: false, syntax })
          : null));
      }
      this.view = v;
      cx.notify();
    });
  }

  // 무시됨: 자기 경로나 상위 폴더가 무시 목록에 있으면.
  isIgnored(abs) {
    for (let p = abs; p.length > (this.root?.length ?? 0); p = p.slice(0, p.lastIndexOf("/"))) if (this.ignored.has(p)) return true;
    return false;
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), abs = `${this.root}/${path}`;
      const ignored = this.isIgnored(abs), mark = this.marks[abs];
      if ((!this.showHidden && entry.name.startsWith(".")) || (this.hideIgnored && ignored)) continue;
      const color = mark ? GIT[mark] : ignored ? GIT.I : t.foreground;
      const icon = iconFor(entry.name, entry.dir, open);
      out.push(h_flex().id(`file-${path}`).h(24).flex_none().pl(6 + depth * 16).pr(8).gap(5).items_center().rounded(4)
        .cursor_pointer().hover((s) => s.bg(t.hover)).when(this.file === path || (entry.dir && this.sel === path), (el) => el.bg(t.selected))
        .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.show(path, cx)))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(this.ctxFor(path, entry.dir, mark, ignored)); })
        .child(entry.dir ? svg(`${ME}/chevron-${open ? "down" : "right"}.svg`).size(14).flex_none().text_color(t.foreground) : div().w(14).flex_none())
        .child(icon ? image(icon).size(16).flex_none() : div().w(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_color(color).child(entry.name)));
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
      .child(h_flex().min_h(32).py(2).px(6).gap(2).flex_wrap().items_center().border_b_1().border_color(t.border)
        // 켜고 끄는 버튼은 한 자리에서 아이콘으로 지금 상태를 보여 준다(걸러 내는 중이면 배경도 칠함).
        .child(btn("search", this.searching ? "close" : "search", this.searching ? "검색 중 · 누르면 닫기" : "파일 검색 (이름으로)", this.searching, ok && ((cx) => this.toggleSearch(cx))))
        .child(btn("hidden", this.showHidden ? "eye" : "eye-off", this.showHidden ? "숨김 파일(.으로 시작) 보이는 중 · 누르면 감추기" : "숨김 파일 감추는 중 · 누르면 보이기", !this.showHidden, () => { this.showHidden = !this.showHidden; this.save("showHidden", this.showHidden); }))
        .child(btn("ignored", this.hideIgnored ? "ignored-off" : "ignored", this.hideIgnored ? "gitignore 항목 감추는 중 · 누르면 보이기" : "gitignore 항목 보이는 중 · 누르면 감추기", this.hideIgnored, () => { this.hideIgnored = !this.hideIgnored; this.save("hideIgnored", this.hideIgnored); }))
        .child(sep())
        .child(btn("file", "file-new", `새 파일 (${where}에)`, false, ok && (() => ask("file", "새 파일", `${where}에 만들 파일 이름 (하위 폴더는 a/b.ts처럼)`))))
        .child(btn("folder", "folder-new", `새 폴더 (${where}에)`, false, ok && (() => ask("folder", "새 폴더", `${where}에 만들 폴더 이름`))))
        .child(sep())
        .child(btn("terminal", "terminal", `여기서 터미널 열기 (${where})`, false, ok && (() => { run("tab.new", { folder: dir }); run("layout.show", { id: "office-term" }); })))
        .child(btn("copy", "copy", this.file ? `경로 복사 (${this.file})` : `경로 복사 (${where})`, false, ok && (() => this.copy(this.file ? `${this.root}/${this.file}` : dir))))
        .child(div().flex_1())
        // 펼치기/접기도 한 자리: 열린 폴더가 있으면 모두 접기, 없으면 맨 위 폴더들을 펼치기.
        .child(this.folders.size
          ? btn("collapse", "collapse", "모두 접기", false, ok && (() => { this.folders = new Set(); this.sel = ""; }))
          : btn("collapse", "expand", "맨 위 폴더 모두 펼치기", false, ok && ((cx) => { for (const e of this.entries.get("") ?? []) if (e.dir && !this.folders.has(e.name)) this.toggle(e.name, cx); this.sel = ""; })))
        .child(btn("refresh", "refresh", "다시 읽기", false, ok && ((cx) => { this.all = null; this.refresh(cx); }))))
      .when(this.searching, (el) => el.child(h_flex().h(34).px(8).gap(6).items_center().border_b_1().border_color(t.border)
        .child(svg(`${ME}/search.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.searchInput).h(26).text_size(12).text_color(t.foreground)))));
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

  results(t) {
    const q = this.query;
    if (!this.all) return [div().p(8).text_size(12).text_color(t.dim).child("파일 목록을 읽는 중")];
    if (!q) return [div().p(8).text_size(12).text_color(t.dim).child(`파일 ${this.all.length.toLocaleString()}개에서 찾습니다`)];
    const hits = this.all.filter((p) => p.split("/").pop().toLowerCase().includes(q)).slice(0, 300);
    if (!hits.length) return [div().p(8).text_size(12).text_color(t.dim).child("맞는 파일이 없습니다")];
    return hits.map((path) => {
      const name = path.split("/").pop(), icon = iconFor(name, false, false), mark = this.marks[`${this.root}/${path}`];
      return h_flex().id(`hit-${path}`).h(24).flex_none().px(6).gap(6).items_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(this.ctxFor(path, false, mark, false)); })
        .child(icon ? image(icon).size(16).flex_none() : div().w(16).flex_none())
        .child(div().flex_none().text_color(mark ? GIT[mark] : t.foreground).child(name))
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
    const abs = `${this.root}/${this.file}`, name = this.file.split("/").pop(), v = this.view;
    const icon = iconFor(name, false, false);
    const W = Math.max(200, (this.dw ?? 600) - 40);
    const btn = (id, text, fn) => div().id(id).px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn).child(text);
    let body;
    if (!v) body = v_flex().flex_1().items_center().justify_center().text_color(t.muted).child("미리보기를 만드는 중");
    else if (v.kind === "code") body = this.code ? Editor.new(this.code).flex_1().min_h(0) : div();
    else if (v.kind === "md") body = v_flex().id("files-md").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16).gap(12).text_size(14).font_family(CODE_FONT)
      .children(this.markdown(v.blocks, W - 8, t, cx));
    else if (v.kind === "pages") body = v_flex().id("files-pages").flex_1().min_h(0).overflow_y_scrollbar().p(20).gap(16).items_center()
      .children(v.pages.map((p, i) => {
        const w = Math.min(W, p.w), h = Math.round((w * p.h) / Math.max(1, p.w));
        return v_flex().gap(4).items_center()
          .child(image(p.path).w(w).h(h).rounded(4).shadow_md())
          .when(v.pages.length > 1, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${i + 1} / ${v.count}`)));
      }));
    else if (v.kind === "table") body = this.table(v, t);
    else if (v.kind === "slides") body = v_flex().id("files-slides").flex_1().min_h(0).overflow_y_scrollbar().p(20).gap(14)
      .when(Boolean(v.thumb), (el) => el.child(image(v.thumb.path).w(Math.min(W, v.thumb.w)).h(Math.round(Math.min(W, v.thumb.w) * v.thumb.h / v.thumb.w)).rounded(4).shadow_md()))
      .children(v.slides.map((sl) => v_flex().gap(3)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(`슬라이드 ${sl.n}`))
        .children(sl.texts.map((tx, i) => div().text_size(i === 0 ? 14 : 13).when(i === 0, (x) => x.font_semibold()).text_color(t.foreground).child(tx)))));
    else body = v_flex().flex_1().items_center().justify_center().gap(10).text_color(t.muted)
      .child(div().text_size(13).child(v.message ?? "미리볼 수 없는 파일입니다"));
    return v_flex().size_full().min_h(0)
      .on_size_change((size, cx) => { if (Math.abs((this.dw ?? 0) - size.width) > 4) { this.dw = size.width; cx.notify(); } })
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .when(Boolean(icon), (el) => el.child(image(icon).size(16).flex_none()))
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(name))
        .child(div().id("files-detail-path").flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", ["-R", abs])).child(v?.note ?? this.file))
        .child(btn("files-open-ext", "기본 앱으로 열기", () => exec("open", [abs])))
        .child(div().id("files-close").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("✕")))
      .child(body);
  }

  // 마크다운 블록(markdown.js): 글은 TextView, 코드는 편집기, 알림은 왼쪽 선 + 이름, 그림은 image()
  markdown(blocks, W, t) {
    const dir = this.file.includes("/") ? this.file.slice(0, this.file.lastIndexOf("/")) : "";
    const md = (id, text) => TextView.markdown(id, text).on_link_click((url, cx) => this.openLink(url, dir, cx));
    return blocks.map((b, i) => {
      const id = `files-md-${i}`;
      if (b.kind === "text") return b.notes ? div().text_size(12).text_color(t.muted).child(md(id, b.text)) : md(id, b.text);
      if (b.kind === "code") {
        const st = this.mdCode?.[i];
        if (!st) return md(id, "```" + (b.lang ?? "") + "\n" + b.text + "\n```");
        const lines = b.text.split("\n").length;
        return v_flex().rounded(4).bg(t.surface).border_1().border_color(t.border).px(12).py(10).gap(4)
          .when(Boolean(b.lang), (el) => el.child(div().text_size(11).text_color(t.dim).child(b.lang)))
          .child(Editor.new(st).w_full().h(lines * MD_LINE + 4));
      }
      if (b.kind === "alert") {
        const [label, color] = ALERT[b.type] ?? ALERT.note;
        return v_flex().pl(12).gap(4).border_l_2().border_color(t[color])
          .child(div().text_size(13).font_semibold().text_color(t[color]).child(label))
          .child(md(id, b.text));
      }
      if (b.kind === "images") return h_flex().flex_wrap().gap(6).items_end().when(Boolean(b.center), (el) => el.justify_center()).children(b.items.map((it, j) => {
        if (!it.path) return div().text_size(12).text_color(t.dim).child(`[그림${it.alt ? `: ${it.alt}` : ""}]`);
        const w = Math.min(W, it.width ?? it.w), h = Math.round((w * it.h) / Math.max(1, it.w));
        const img = image(it.path).w(w).h(h);
        return it.link ? div().id(`${id}-${j}`).cursor_pointer().on_click((_e, cx) => this.openLink(it.link, dir, cx)).child(img) : img;
      }));
      return null;
    }).filter(Boolean);
  }

  // 마크다운 링크: http·mailto는 브라우저로, 상대 경로는 이 파일 앱에서 연다(#제목 링크는 무시)
  openLink(url, dir, cx) {
    if (/^(https?|mailto):/i.test(url)) { exec("open", [url]); return; }
    let p = decodeURIComponent(url.replace(/^file:\/\//i, "").replace(/[?#].*$/, ""));
    if (!p) return;
    if (p.startsWith(this.root + "/")) p = p.slice(this.root.length + 1);
    else if (p.startsWith("/")) { exec("open", [p]); return; }
    else {
      const out = dir ? dir.split("/") : [];
      for (const part of p.split("/")) { if (part === "..") out.pop(); else if (part && part !== ".") out.push(part); }
      p = out.join("/");
    }
    this.show(p, cx);
    cx.notify();
  }

  // 표(CSV·엑셀): 시트 탭 + 머리 행 고정 느낌의 격자. 칸은 같은 폭, 넘치면 가로로 스크롤.
  table(v, t) {
    const sh = v.sheets[Math.min(this.sheet ?? 0, v.sheets.length - 1)] ?? { rows: [] };
    const cols = Math.min(60, Math.max(0, ...sh.rows.map((r) => r.length)));
    const CW = 132, RW = 44;
    const cell = (text, head, i) => div().w(i === -1 ? RW : CW).h(26).flex_none().px(6).flex().items_center().border_r_1().border_b_1().border_color(t.border)
      .when(head, (x) => x.bg(t.raised).font_semibold()).when(i === -1, (x) => x.justify_end().text_color(t.dim).bg(t.raised))
      .text_size(12).child(div().truncate().child(String(text ?? "")));
    const colName = (i) => { let s = "", n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    return v_flex().flex_1().min_h(0)
      .when(v.sheets.length > 1, (el) => el.child(h_flex().id("files-sheets").flex_none().px(10).py(6).gap(4).overflow_x_scrollbar().border_b_1().border_color(t.border)
        .children(v.sheets.map((s, i) => div().id(`sheet-${i}`).px(10).py(3).rounded(5).text_size(12).cursor_pointer()
          .bg(i === (this.sheet ?? 0) ? t.selected : t.chrome).text_color(i === (this.sheet ?? 0) ? t.foreground : t.muted)
          .hover((x) => x.bg(t.hover)).on_click((_e, cx) => { this.sheet = i; cx.notify(); }).child(s.name)))))
      .child(div().id("files-grid").flex_1().min_h(0).overflow_scrollbar()
        .child(v_flex().w(RW + cols * CW)
          .child(h_flex().child(cell("", true, -1)).children(Array.from({ length: cols }, (_, i) => cell(colName(i), true, i))))
          .children(sh.rows.map((r, ri) => h_flex().child(cell(ri + 1, false, -1)).children(Array.from({ length: cols }, (_, i) => cell(r[i], false, i)))))
          .when(Boolean(sh.more), (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("앞부분만 보여 줍니다(최대 500행)")))));
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
