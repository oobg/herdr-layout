// 파일트리 우클릭 메뉴와 확인 창. office-apps의 오버레이 역할이다.
//   menu     props { ctx }   ctx = { kind, path(루트 기준), abs, dir, root, on, mark, ignored, tools[], home, icon, scripts?, pm?, targets? }
//   confirm  props { ctx, action, title, detail }
//   ctx.kind "tools"는 정해 둔 항목 목록 메뉴(파일 앱 툴바 ⋯): ctx.items = [{ label, icon(이름), color, hint?, check?, cmd? | action? } | "-"]
//     cmd는 office-apps.<cmd> 명령으로 보내고(오버레이 복사본이라 앱 상태는 명령으로 바꾼다), action은 ACTIONS[action](ctx).
//     check가 true/false인 항목은 오른쪽에 체크 칸을 그린다. 머리줄 이름은 ctx.title.
// 파일을 바꾼 뒤에는 TICK을 바꿔 트리가 다시 읽게 한다. 삭제는 휴지통으로 보내 되돌릴 수 있게 한다.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, openOverlay, run, exec, theme, notify, setShared } from "herdr";

export const TICK = "office-apps.tick";

// 팝업 위치: 마우스 오른쪽 아래가 기본, 창에 공간이 모자라면 위·왼쪽으로 뒤집는다.
export function popupAt(w, h) {
  try {
    const W = globalThis.window, p = W.mouse_position(), v = W.viewport_size(), M = 6;
    let x = p.x, y = p.y;
    if (x + w > v.width - M) x = Math.max(M, p.x - w);
    if (y + h > v.height - M) y = Math.max(M, Math.min(p.y - h, v.height - h - M));
    return { x: Math.round(x), y: Math.round(y) };
  } catch { return "pointer"; }
}

const changed = () => setShared(TICK, Date.now());
const parent = (abs) => abs.slice(0, abs.lastIndexOf("/")) || "/";
const rel = (ctx) => ctx.path;

async function sh(ctx, script, ...args) {
  const r = await exec("sh", ["-c", script, "files", ...args], { on: ctx.on });
  if (r.code !== 0) notify({ title: "실패했습니다", body: (r.stderr || r.stdout).trim().slice(0, 300), level: "error" });
  changed();
  return r.code === 0;
}

async function git(ctx, args) {
  const r = await exec("git", args, { cwd: ctx.root, on: ctx.on });
  if (r.code !== 0) notify({ title: `git ${args[0]} 실패`, body: (r.stderr || r.stdout).trim().slice(0, 300), level: "error" });
  changed();
  return r.code === 0;
}

function inTab(ctx, name, argv, folder = ctx.root) {
  run("tab.new", { name, folder, argv });
  run("layout.show", { id: "office-term" });
}

async function copy(text, what) {
  await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]);
  notify({ title: `${what}를 복사했습니다`, body: text, level: "info" });
}

// 이 Mac의 앱(open·qlmanage·에디터·ditto)을 쓰는 동작은 원격 기기(ctx.on) 파일에는 쓰지 않는다. 메뉴에서도 뺀다.
const local = (ctx) => !ctx.on;

// 입력 창(이름)과 확인 창이 부르는 동작들.
export const ACTIONS = {
  preview: (ctx) => setShared("office-apps.preview", { path: ctx.path, root: ctx.root, at: Date.now() }),
  openDefault: (ctx) => local(ctx) && exec("open", [ctx.abs]),
  openWith: (ctx, app) => local(ctx) && exec(app, [ctx.abs]),
  reveal: (ctx) => local(ctx) && exec("open", ["-R", ctx.abs]),
  terminal: (ctx) => { run("tab.new", { folder: ctx.dir ? ctx.abs : parent(ctx.abs) }); run("layout.show", { id: "office-term" }); },
  file: (ctx, name) => sh(ctx, 'mkdir -p "$(dirname "$1/$2")" && { [ -e "$1/$2" ] && echo "이미 있습니다" >&2 && exit 1 || : > "$1/$2"; }', ctx.dir ? ctx.abs : parent(ctx.abs), name),
  folder: (ctx, name) => sh(ctx, 'mkdir -p "$1/$2"', ctx.dir ? ctx.abs : parent(ctx.abs), name),
  rename: (ctx, name) => sh(ctx, '[ -e "$2" ] && echo "이미 있습니다" >&2 && exit 1 || mv "$1" "$2"', ctx.abs, `${parent(ctx.abs)}/${name}`),
  duplicate: (ctx) => sh(ctx, 'n="$1 copy"; i=2; while [ -e "$n" ]; do n="$1 copy $i"; i=$((i+1)); done; cp -R "$1" "$n"', ctx.abs),
  trash: async (ctx) => {
    // macOS 15+의 trash 명령, 없으면 Finder로. 둘 다 휴지통으로 보낸다.
    const ok = await sh(ctx, 'if command -v trash >/dev/null 2>&1; then trash "$1"; else osascript -e "tell application \\"Finder\\" to delete POSIX file \\"$1\\"" >/dev/null; fi', ctx.abs);
    if (ok) notify({ title: "휴지통으로 옮겼습니다", body: ctx.path, level: "info" });
  },
  copyPath: (ctx) => copy(ctx.abs, "경로"),
  copyRel: (ctx) => copy(rel(ctx), "상대 경로"),
  copyName: (ctx) => copy(ctx.abs.split("/").pop(), "이름"),
  diff: (ctx) => inTab(ctx, `diff ${ctx.path}`, ["git", "diff", "HEAD", "--", ctx.path]),
  history: (ctx) => inTab(ctx, `기록 ${ctx.path}`, ["git", "log", "--follow", "-p", "--", ctx.path]),
  blame: (ctx) => inTab(ctx, `blame ${ctx.path}`, ["git", "blame", "--", ctx.path]),
  add: (ctx) => git(ctx, ["add", "--", ctx.path]),
  unstage: (ctx) => git(ctx, ["restore", "--staged", "--", ctx.path]),
  restore: (ctx) => git(ctx, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ctx.path]),
  diffStaged: (ctx) => inTab(ctx, `staged diff ${ctx.path}`, ["git", "diff", "--cached", "--", ctx.path]),
  lastCommit: (ctx) => inTab(ctx, `마지막 커밋 ${ctx.path}`, ["git", "log", "-1", "-p", "--", ctx.path]),
  whyIgnored: async (ctx) => {
    // 출력: "<규칙 파일>:<줄>:<패턴>\t<경로>"
    const r = await exec("git", ["check-ignore", "-v", "--", ctx.path], { cwd: ctx.root, on: ctx.on });
    const m = /^(.*):(\d+):(.*)\t/.exec(r.stdout);
    notify({ title: "무시되는 이유", body: m ? `${m[3]}  (${m[1]} ${m[2]}번째 줄)` : "무시 규칙을 찾지 못했습니다", level: "info" });
  },
  ours: (ctx) => sh(ctx, 'cd "$1" && git checkout --ours -- "$2" && git add -- "$2"', ctx.root, ctx.path),
  theirs: (ctx) => sh(ctx, 'cd "$1" && git checkout --theirs -- "$2" && git add -- "$2"', ctx.root, ctx.path),
  markResolved: (ctx) => git(ctx, ["add", "--", ctx.path]),
  run: (ctx, argv, name) => inTab(ctx, name ?? argv.join(" "), argv, ctx.dir ? ctx.abs : parent(ctx.abs)),
  quicklook: (ctx) => local(ctx) && exec("qlmanage", ["-p", ctx.abs]),
  chmodx: async (ctx) => { if (await sh(ctx, 'chmod +x "$1"', ctx.abs)) notify({ title: "실행 권한을 줬습니다", body: ctx.path, level: "info" }); },
  // .env → .env.example: 키만 남기고 값은 비운다(주석·빈 줄은 그대로).
  envExample: async (ctx) => {
    if (await sh(ctx, 'out="$(dirname "$1")/.env.example"; [ -e "$out" ] && echo ".env.example이 이미 있습니다" >&2 && exit 1; sed -E "s/^([[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*)=.*/\\1=/" "$1" > "$out"', ctx.abs))
      notify({ title: ".env.example을 만들었습니다", body: "값은 비우고 키만 남겼습니다", level: "info" });
  },
  unzip: (ctx) => sh(ctx, 'cd "$(dirname "$1")" && case "$1" in *.zip) ditto -x -k "$1" "${1%.zip}";; *) tar -xf "$1";; esac', ctx.abs),
  zip: (ctx) => sh(ctx, 'cd "$(dirname "$1")" && n="$(basename "$1")" && ditto -c -k --keepParent "$n" "$n.zip"', ctx.abs),
  ignore: (ctx) => sh(ctx, 'f="$1/.gitignore"; [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && echo >> "$f"; echo "$2" >> "$f"', ctx.root, `/${ctx.path}${ctx.dir ? "/" : ""}`),
};

const ask = (ctx, action, title, hint, value = "") =>
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 210, props: { role: "prompt", ctx, action, title, hint, value } });
// opts: { yes: 실행 버튼 이름, danger: 되돌리기 어려우면 true } — Confirm 참고
const confirm = (ctx, action, title, detail, opts = {}) =>
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: { role: "confirm", ctx, action, title, detail, ...opts } });

const EDITORS = { code: "VS Code", cursor: "Cursor", webstorm: "WebStorm", zed: "Zed", idea: "IntelliJ IDEA", subl: "Sublime Text" };

// 메뉴 구조. 자주 쓰는 것만 맨 위에 두고 나머지는 하위 메뉴(▸)로 묶는다. 쓸 수 없는 항목은 숨긴다.
// 항목: { label, icon, color, fn } | { label, icon, color, sub: [...] } | "-"
const C = { open: "#7aa2f7", new: "#83c092", copy: "#d699b6", edit: "#dbbc7f", git: "#e69875", danger: "#e67e80", view: "#7fbbb3", run: "#a7c080" };
const I = (n) => `mods/office-apps/${n}.svg`;

// 상황별 메뉴. ctx.kind: "root"(빈 영역) | "dir" | "file". 확장자·파일 이름·git 상태에 따라 항목이 달라진다.
// openMenu가 미리 읽어 둔 정보: ctx.scripts(package.json), ctx.pm(패키지 매니저), ctx.targets(Makefile)
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|heic|avif)$/i;
const ARCHIVE = /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/i;

export function status(ctx) {
  if (ctx.kind === "tools") return null;
  if (ctx.kind === "root") return { text: "프로젝트 폴더", color: "#7fbbb3" };
  if (ctx.ignored) return { text: "무시됨", color: "#a07850" };
  return {
    M: { text: "수정됨", color: "#6897bb" }, A: { text: "stage됨", color: "#629755" }, "?": { text: "새 파일", color: "#d1675a" },
    U: { text: "충돌", color: "#e67e80" }, D: { text: "삭제됨", color: "#8c8c8c" },
  }[ctx.mark] ?? (ctx.kind === "dir" ? null : { text: "커밋됨", color: "#8c8c8c" });
}

export function menuTree(ctx) {
  if (ctx.kind === "tools") return tidy((ctx.items ?? []).map((it) => it === "-" ? "-" : {
    ...it, icon: I(it.icon),
    fn: it.cmd ? () => run(`office-apps.${it.cmd}`) : it.action ? () => ACTIONS[it.action]?.(ctx) : () => {},
  }));
  const name = ctx.abs.split("/").pop(), lower = name.toLowerCase(), kind = ctx.kind;
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const isDir = kind !== "file", here = isDir ? `'${kind === "root" ? "맨 위" : name}'` : "같은 폴더";
  const m = ctx.mark, changed = m && m !== "?", tracked = m !== "?" && !ctx.ignored, clean = tracked && !m;
  const item = (label, icon, color, fn, hint) => ({ label, icon: I(icon), color, fn, hint });
  const sub = (label, icon, color, list) => { const l = tidy(list); return l.length ? { label, icon: I(icon), color, sub: l } : null; };
  const isLocal = local(ctx); // 이 Mac의 파일인가(원격이면 Finder·기본 앱·에디터·Quick Look·ditto를 숨긴다)
  const editors = (isLocal ? ctx.tools ?? [] : []).filter((c) => EDITORS[c]).map((c) => item(EDITORS[c], "open", C.open, () => ACTIONS.openWith(ctx, c)));
  const pm = ctx.pm ?? "npm";
  const runIt = (argv, hint) => () => ACTIONS.run(ctx, argv, hint);

  // 파일 종류별 "실행" 항목
  const special = [];
  if (kind === "file") {
    if (lower === "package.json") {
      const scripts = Object.keys(ctx.scripts ?? {});
      special.push(sub("스크립트 실행", "terminal", C.run, scripts.map((k) => item(k, "terminal", C.run, runIt([pm, "run", k], `${pm} run ${k}`), (ctx.scripts[k] ?? "").slice(0, 40)))));
      special.push(item("의존성 설치", "terminal", C.run, runIt([pm, "install"]), `${pm} install`));
    } else if (/^(package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/.test(lower)) {
      special.push(item("의존성 다시 설치", "terminal", C.run, runIt([pm, "install"]), `${pm} install`));
    } else if (lower === "makefile" || lower === "gnumakefile") {
      special.push(sub("make 실행", "terminal", C.run, (ctx.targets ?? []).map((tg) => item(tg, "terminal", C.run, runIt(["make", tg]), `make ${tg}`))));
    } else if (lower === "dockerfile") {
      special.push(item("이미지 빌드", "terminal", C.run, runIt(["docker", "build", "-t", ctx.root.split("/").pop().toLowerCase(), "-f", name, "."]), "docker build"));
    } else if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(lower)) {
      special.push(item("컨테이너 올리기", "terminal", C.run, runIt(["docker", "compose", "-f", name, "up"]), "docker compose up"));
      special.push(item("컨테이너 내리기", "terminal", C.run, runIt(["docker", "compose", "-f", name, "down"]), "docker compose down"));
    } else if (TEST.test(lower)) {
      special.push(item("이 테스트 실행", "terminal", C.run, runIt([pm === "bun" ? "bunx" : "npx", "vitest", "run", ctx.path], "vitest"), `vitest run ${name}`));
    } else if (/^(sh|bash|zsh)$/.test(ext)) {
      special.push(item("실행", "terminal", C.run, runIt([ext === "sh" ? "bash" : ext, name]), `${ext === "sh" ? "bash" : ext} ${name}`));
      special.push(item("실행 권한 주기", "terminal", C.run, () => ACTIONS.chmodx(ctx), "chmod +x"));
    } else if (ext === "py") {
      special.push(item("실행", "terminal", C.run, runIt(["python3", name]), `python3 ${name}`));
    } else if (/^[cm]?js$/.test(ext)) {
      special.push(item("실행", "terminal", C.run, runIt([pm === "bun" ? "bun" : "node", name]), `${pm === "bun" ? "bun" : "node"} ${name}`));
    } else if (/^[cm]?tsx?$/.test(ext) && !lower.endsWith(".d.ts")) {
      special.push(item("실행", "terminal", C.run, runIt(pm === "bun" ? ["bun", name] : ["npx", "tsx", name]), pm === "bun" ? `bun ${name}` : `tsx ${name}`));
    } else if (IMAGE.test(lower)) {
      if (isLocal) special.push(item("훑어보기 (Quick Look)", "eye", C.view, () => ACTIONS.quicklook(ctx), "Space"));
    } else if (ARCHIVE.test(lower)) {
      // .zip은 ditto(macOS)로 푼다. tar 계열은 원격에서도 된다.
      if (isLocal || ext !== "zip") special.push(item("압축 풀기", "folder-new", C.run, () => ACTIONS.unzip(ctx)));
    }
    if (/^\.env(\.|$)/.test(lower) && !lower.endsWith(".example")) {
      special.push(item(".env.example 만들기", "file-new", C.run, () => ACTIONS.envExample(ctx), "키만, 값은 비움"));
    }
  }

  // git: 상태마다 다르다
  const git = tidy(ctx.ignored ? [
    item("왜 무시되는지 보기", "ignored", C.git, () => ACTIONS.whyIgnored(ctx), "git check-ignore"),
  ] : m === "U" ? [
    item("내 쪽으로 해결", "branch", C.git, () => ACTIONS.ours(ctx), "--ours"),
    item("상대 쪽으로 해결", "branch", C.git, () => ACTIONS.theirs(ctx), "--theirs"),
    item("해결됨으로 표시", "file-new", C.git, () => ACTIONS.markResolved(ctx), "git add"),
  ] : [
    changed && m !== "A" && item("변경 내용 보기", "status", C.git, () => ACTIONS.diff(ctx), "git diff"),
    m === "A" && item("stage된 변경 보기", "status", C.git, () => ACTIONS.diffStaged(ctx), "git diff --cached"),
    kind === "file" && clean && item("마지막 커밋 보기", "log", C.git, () => ACTIONS.lastCommit(ctx), "git log -1 -p"),
    tracked && kind !== "root" && item(isDir ? "폴더 기록 보기" : "파일 기록 보기", "log", C.git, () => ACTIONS.history(ctx), "git log"),
    kind === "file" && tracked && m !== "A" && item("줄별 작성자 보기", "log", C.git, () => ACTIONS.blame(ctx), "git blame"),
    "-",
    (m === "?" || m === "M" || (isDir && kind !== "root")) && item(m === "?" ? "git에 추가" : "stage에 추가", "file-new", C.git, () => ACTIONS.add(ctx), "git add"),
    m === "A" && item("stage에서 빼기", "collapse", C.git, () => ACTIONS.unstage(ctx), "git restore --staged"),
    kind !== "root" && (m === "?" || isDir) && item(".gitignore에 추가", "ignored", C.git, () => ACTIONS.ignore(ctx)),
    "-",
    changed && m !== "D" && { ...item("변경 되돌리기...", "reset", C.danger, () => confirm(ctx, "restore", "변경 되돌리기", `'${ctx.path}'의 변경을 버리고 마지막 커밋 상태로 되돌립니다. 되돌린 변경은 복구할 수 없습니다.`, { yes: "되돌리기", danger: true })), danger: true },
  ]);

  const create = [
    item("새 파일...", "file-new", C.new, () => ask(ctx, "file", "새 파일", `${here}에 만들 파일 이름 (하위 폴더는 a/b.ts처럼)`), here),
    item("새 폴더...", "folder-new", C.new, () => ask(ctx, "folder", "새 폴더", `${here}에 만들 폴더 이름`), here),
  ];
  const copyMenu = sub("복사", "copy", C.copy, [
    item("경로", "copy", C.copy, () => ACTIONS.copyPath(ctx), ctx.abs.replace(ctx.home ?? "", "~")),
    kind !== "root" && item("상대 경로", "copy", C.copy, () => ACTIONS.copyRel(ctx), ctx.path),
    item("이름", "copy", C.copy, () => ACTIONS.copyName(ctx), name),
  ]);

  if (kind === "root") return tidy([
    ...create,
    "-",
    isLocal && item("Finder에서 열기", "reveal", C.open, () => exec("open", [ctx.abs])),
    item("여기서 터미널", "terminal", C.open, () => ACTIONS.terminal(ctx)),
    ...editors.map((e) => ({ ...e, label: `${e.label}에서 프로젝트 열기` })),
    "-",
    copyMenu,
    git.length ? sub("Git", "branch", C.git, git) : null,
  ]);

  return tidy([
    ...(m === "U" ? [...git, "-"] : []),
    kind === "file" && !IMAGE.test(lower) && !ARCHIVE.test(lower) && item("미리보기", "eye", C.view, () => ACTIONS.preview(ctx)),
    ...special,
    sub("다음으로 열기", "open", C.open, [
      isLocal && item("기본 앱", "open", C.open, () => ACTIONS.openDefault(ctx)),
      ...editors,
      "-",
      isLocal && item("Finder에서 보기", "reveal", C.open, () => ACTIONS.reveal(ctx)),
      item(isDir ? "여기서 터미널" : "폴더에서 터미널", "terminal", C.open, () => ACTIONS.terminal(ctx)),
    ]),
    "-",
    ...create,
    "-",
    copyMenu,
    item("이름 바꾸기...", "rename", C.edit, () => ask(ctx, "rename", "이름 바꾸기", `'${name}'의 새 이름`, name)),
    item("복제", "duplicate", C.edit, () => ACTIONS.duplicate(ctx), `${name} copy`),
    kind === "dir" && isLocal && item("압축하기", "duplicate", C.edit, () => ACTIONS.zip(ctx), `${name}.zip`),
    "-",
    // 충돌 파일은 해결 항목을 맨 위에 따로 둔다. git 항목이 한두 개면 하위 메뉴 없이 바로.
    m === "U" ? [] : git.length ? (git.length <= 2 ? git : [sub("Git", "branch", C.git, git)]) : [],
    "-",
    { ...item("휴지통으로 이동...", "trash", C.danger, () => confirm(ctx, "trash", "휴지통으로 이동", `'${ctx.path}'${isDir ? " 폴더와 그 안의 모든 것" : ""}을(를) 휴지통으로 옮깁니다. 휴지통에서 되돌릴 수 있습니다.`, { yes: "휴지통으로 이동" })), danger: true },
  ].flat());
}

// 숨긴 항목(false) 빼고, 구분선이 겹치거나 양 끝에 오지 않게 정리한다.
function tidy(list) {
  const out = [];
  for (const it of list) {
    if (!it) continue;
    if (it === "-" && (!out.length || out[out.length - 1] === "-")) continue;
    out.push(it);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

const ROW = 30, SEP = 9, HEAD = 34;
const height = (list) => list.reduce((h, it) => h + (it === "-" ? SEP : ROW), 12 + HEAD);

// 팝업 높이는 열 때 정해지므로, 가장 긴 화면(맨 위 또는 하위 메뉴)에 맞춘다.
export function menuHeight(ctx) {
  const top = menuTree(ctx);
  return Math.max(height(top), ...top.filter((it) => Array.isArray(it?.sub)).map((it) => height(it.sub)));
}

// 우클릭 메뉴. 하위 메뉴(▸)는 같은 팝업 안에서 화면을 바꿔 보여 주고, ← 또는 ←키로 돌아온다.
//   ↑↓ 고르기 · Enter/→ 실행 또는 열기 · ←/Backspace 뒤로 · Esc 닫기
export class Menu {
  init(_p, cx) {
    this.stack = []; // 열린 하위 메뉴들
    this.at = -1;
    this.h = cx.focus_handle();
    this.h.focus();
  }

  list() {
    let list = menuTree(props().ctx);
    for (const i of this.stack) list = list[i].sub;
    return list;
  }

  enter(i, cx) {
    const it = this.list()[i];
    if (Array.isArray(it.sub)) { this.stack.push(i); this.at = -1; cx?.notify(); return; }
    closeOverlay(props().overlay);
    it.fn();
  }

  // 맨 위 머리줄: 무엇을 우클릭했는지(아이콘, 이름, git 상태).
  title(t, ctx) {
    const st = status(ctx), name = ctx.title ?? ctx.abs.split("/").pop();
    return h_flex().h(HEAD - 6).mb(4).px(6).gap(8).items_center().border_b_1().border_color(t.border)
      .child(ctx.icon ? image(ctx.icon).size(16).flex_none() : div().w(16))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(name))
      .when(Boolean(st), (el) => el.child(div().flex_none().px(6).py(1).rounded(4).text_size(11).text_color(st.color).border_1().border_color(st.color).child(st.text)));
  }

  back(cx) {
    if (!this.stack.length) return;
    this.at = this.stack.pop();
    cx?.notify();
  }

  render() {
    const t = theme(), p = props(), list = this.list();
    const parent = this.stack.length ? (() => { let l = menuTree(p.ctx), it; for (const i of this.stack) { it = l[i]; l = it.sub; } return it; })() : null;
    const usable = list.map((it, i) => (it === "-" ? -1 : i)).filter((i) => i >= 0);
    return v_flex().id("files-menu").track_focus(this.h).size_full().p(6).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = usable.indexOf(this.at);
        if (e.key === "escape") closeOverlay(p.overlay);
        else if (e.key === "down") this.at = usable[(k + 1) % usable.length];
        else if (e.key === "up") this.at = usable[(k - 1 + usable.length) % usable.length];
        else if ((e.key === "enter" || e.key === "right") && this.at >= 0) return this.enter(this.at, cx);
        else if (e.key === "left" || e.key === "backspace") return this.back(cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .when(!parent, (el) => el.child(this.title(t, p.ctx)))
      .when(Boolean(parent), (el) => el.child(h_flex().id("fm-back").h(HEAD - 6).mb(4).px(6).gap(8).items_center().rounded(5).cursor_pointer()
        .border_b_1().border_color(t.border).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.back(cx))
        .child(svg("mods/office-apps/chevron-left.svg").size(14).text_color(t.foreground))
        .child(svg(parent.icon).size(14).text_color(parent.color))
        .child(div().font_semibold().text_color(t.foreground).child(parent.label))))
      .children(list.map((it, i) => it === "-"
        ? div().h(1).my(4).mx(6).bg(t.border)
        : h_flex().id(`fm-${this.stack.join("-")}-${i}`).h(ROW).px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .when(this.at === i, (el) => el.bg(t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.enter(i, cx))
          .child(svg(it.icon).size(15).flex_none().text_color(it.color))
          .child(div().flex_none().text_color(it.danger ? C.danger : t.foreground).child(it.label))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(it.hint ?? ""))
          // 켜고 끄는 항목: 켜져 있으면 체크
          .when(typeof it.check === "boolean", (el) => el.child(div().w(14).flex_none().text_size(13).text_color(t.accent).child(it.check ? "✓" : "")))
          .when(Array.isArray(it.sub), (el) => el.child(svg("mods/office-apps/chevron-right.svg").size(14).flex_none().text_color(t.foreground)))));
  }
}

// 확인 창(role "confirm"). props: { action, title, detail, ctx, yes?, danger? }
// yes: 실행 버튼 이름(동사, 없으면 "확인"). danger: 되돌리기 어려운 동작 — 실행 버튼을 빨간 글씨로,
// 처음 포커스를 "취소"에 둔다. Enter는 포커스된 버튼을 누른다(버튼에 포커스가 없으면 보통은 실행,
// danger면 "취소"로 포커스만). Tab·Shift+Tab·←→로 두 버튼 사이를 옮긴다. Esc는 닫기.
export class Confirm {
  init(_p, cx) {
    this.h = cx.focus_handle();
    this.no = cx.focus_handle();
    this.ok = cx.focus_handle();
    (props().danger ? this.no : this.h).focus();
  }

  yes() {
    if (this.done) return;
    this.done = true;
    const p = props();
    closeOverlay(p.overlay);
    ACTIONS[p.action](p.ctx);
  }

  cancel() {
    if (this.done) return;
    this.done = true;
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme(), p = props(), danger = Boolean(p.danger);
    const button = (id, text, handle, primary, action) => {
      const focused = handle.is_focused();
      return h_flex().id(id).track_focus(handle).h(32).px(14).items_center().rounded(8).cursor_pointer().text_size(12.5)
        .border_1().border_color(focused ? t.accent : primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : danger && handle === this.ok ? t.ansi1 : t.foreground)
        .when(danger && handle === this.ok, (el) => el.font_semibold())
        .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    };
    return v_flex().id("files-confirm").track_focus(this.h).size_full().p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        // 버튼에 포커스가 없을 때(창 빈 곳을 눌렀을 때 등): 보통은 실행, 위험하면 실행하지 않고 "취소"로 포커스만.
        if (e.key === "enter") this.ok.is_focused() ? this.yes() : this.no.is_focused() ? this.cancel() : danger ? (this.no.focus(), cx.notify()) : this.yes();
        else if (e.key === "escape") this.cancel();
        else if (e.key === "tab" || e.key === "left" || e.key === "right") { (this.ok.is_focused() ? this.no : this.ok).focus(); cx.notify(); }
        else return;
        cx.stop_propagation();
      })
      .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child(p.title))
      .child(div().id("fc-detail").flex_1().min_h(0).overflow_y_scrollbar().text_color(t.muted).child(p.detail))
      .child(h_flex().flex_none().gap(8).justify_end()
        .child(button("fc-no", "취소", this.no, false, () => this.cancel()))
        // 위험한 동작은 채운 버튼 대신 일반 버튼 모양에 빨간 글씨: Enter 한 번에 눌리는 기본 버튼처럼 보이지 않게.
        .child(button("fc-yes", p.yes || "확인", this.ok, !danger, () => this.yes())));
  }
}
