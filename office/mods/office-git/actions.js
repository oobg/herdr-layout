// 브랜치 우클릭 메뉴와, 메뉴가 여는 이름 입력·확인 창. 모두 office-git의 오버레이 역할이다.
//   menu     props { kind: "local" | "remote" | "tag", name, ref, head, top, on, upstream, space }
//   prompt   props { title, hint, value, action, ctx }
//   confirm  props { title, detail, action, ctx }
// 결과를 보여 줘야 하는 일(비교, diff, 리베이스, 병합, 푸시)은 새 탭 터미널에서 돌려
// 충돌이나 인증 질문을 사람이 직접 다룰 수 있게 한다. 짧은 일(브랜치 만들기·이름 변경·삭제)은 바로 실행한다.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, openOverlay, run, exec, theme, notify, shared, setShared, spaces, panes } from "herdr";

const TICK = "office-git.tick", FAV = "office-git.favorites";

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


function changed() { setShared(TICK, Date.now()); }

async function git(ctx, args) {
  const r = await exec("git", args, { cwd: ctx.top, on: ctx.on });
  if (r.code !== 0) notify({ title: `git ${args[0]} 실패`, body: (r.stderr || r.stdout).trim().slice(0, 400), level: "error" });
  changed();
  return r.code === 0;
}

// 결과를 사람이 봐야 하는 명령은 터미널 탭에서.
function inTab(ctx, name, argv) {
  run("tab.new", { name, folder: ctx.top, argv });
  run("layout.show", { id: "office-term" });
  changed();
}

const worktreeDir = (ctx, branch) => `${ctx.home}/.herdr/worktrees/${ctx.top.split("/").pop()}/${branch.replace(/\//g, "-")}`;

// 체크아웃 폴더를 스페이스로: 이미 열려 있으면 그 스페이스로, 아니면 새로.
function openFolder(folder) {
  const s = spaces().find((x) => x.folder === folder || panes().some((p) => x.tabs.some((t) => t.id === p.tab) && p.cwd === folder));
  if (s) run("space.select", { id: s.id });
  else run("space.new", { folder });
}

// 메뉴·입력·확인이 공통으로 실행하는 동작들. value는 입력 창의 글자.
export const ACTIONS = {
  checkout: (ctx) => git(ctx, ["switch", ctx.name]),
  stash: async (ctx) => { if (await git(ctx, ["stash", "push", "-u"])) notify({ title: "변경 사항을 임시 저장했습니다", level: "info" }); },
  unstash: (ctx) => inTab(ctx, "stash pop", ["git", "stash", "pop"]),
  // 현재 브랜치에 이미 병합된 로컬 브랜치를 찾아, 확인을 받고 지운다. 기본 브랜치와 워크트리에 체크아웃된 것은 남긴다.
  pruneMerged: async (ctx) => {
    const r = await exec("git", ["branch", "--merged", "HEAD", "--format=%(refname:short)%00%(worktreepath)"], { cwd: ctx.top, on: ctx.on });
    const keep = new Set([ctx.head, "main", "master", "develop", "dev", "staging", "release"]);
    const list = r.stdout.split("\n").filter(Boolean).map((l) => l.split("\0")).filter(([n, wt]) => !keep.has(n) && !wt).map(([n]) => n);
    if (!list.length) return notify({ title: "정리할 병합된 브랜치가 없습니다", level: "info" });
    confirm({ ...ctx, list }, "pruneList", `병합된 브랜치 ${list.length}개 삭제`, `'${ctx.head}'에 이미 병합된 브랜치입니다: ${list.join(", ")}`);
  },
  pruneList: async (ctx) => {
    if (await git(ctx, ["branch", "-d", ...ctx.list])) notify({ title: `브랜치 ${ctx.list.length}개를 삭제했습니다`, level: "info" });
  },
  // stash 목록을 읽어 메뉴로 보여 준다. 고르면 그 stash를 꺼낸다(pop).
  stashMenu: async (ctx) => {
    const r = await exec("git", ["stash", "list", "--format=%gd%x00%cr%x00%gs"], { cwd: ctx.top, on: ctx.on });
    const stashes = r.stdout.split("\n").filter(Boolean).map((l) => { const [ref, ago, msg] = l.split("\0"); return { ref, ago, msg }; });
    if (!stashes.length) return notify({ title: "임시 저장된 것이 없습니다", level: "info" });
    const c = { ...ctx, kind: "stash", stashes };
    const h = menuHeight(c);
    openOverlay({ mod: "office-git", kind: "popup", at: popupAt(420, h), width: 420, height: h, props: { role: "menu", ctx: c } });
  },
  stashPop: (ctx, ref) => inTab(ctx, `stash pop ${ref}`, ["git", "stash", "pop", ref]),
  stashApply: (ctx, ref) => inTab(ctx, `stash apply ${ref}`, ["git", "stash", "apply", ref]),
  status: (ctx) => inTab(ctx, "git status", ["git", "status"]),
  // origin 주소를 웹 주소로 바꿔 브라우저로 연다 (git@host:o/r.git → https://host/o/r).
  web: async (ctx) => {
    const r = await exec("git", ["remote", "get-url", "origin"], { cwd: ctx.top, on: ctx.on });
    if (r.code !== 0) return notify({ title: "origin 원격이 없습니다", level: "error" });
    const url = r.stdout.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/").replace(/\.git$/, "");
    await exec("open", [`${url}/tree/${encodeURI(ctx.head)}`]);
  },
  pr: (ctx) => inTab(ctx, `PR ${ctx.head}`, ["gh", "pr", "create", "--web"]),
  newTag: async (ctx, value) => { if (await git(ctx, ["tag", value, ctx.ref])) notify({ title: `'${value}' 태그를 만들었습니다`, level: "info" }); },
  lazygit: (ctx) => inTab(ctx, "lazygit", ["lazygit"]),
  pullRebase: (ctx) => inTab(ctx, `pull --rebase ${ctx.name}`, ["git", "pull", "--rebase"]),
  pullMerge: (ctx) => inTab(ctx, `pull ${ctx.name}`, ["git", "pull", "--no-rebase"]),
  forcePush: (ctx) => inTab(ctx, `force push ${ctx.name}`, ["git", "push", "--force-with-lease", ctx.upstream.remote, `${ctx.name}:${ctx.upstream.branch}`]),
  publish: (ctx) => inTab(ctx, `push -u ${ctx.name}`, ["git", "push", "-u", "origin", ctx.name]),
  unsetUpstream: async (ctx) => { if (await git(ctx, ["branch", "--unset-upstream", ctx.name])) notify({ title: "추적 정보를 정리했습니다", body: ctx.name, level: "info" }); },
  forceRemove: (ctx) => git(ctx, ["branch", "-D", ctx.name]),
  // 변경 사항을 임시 저장하고 체크아웃한다(메시지에 어디서 어디로 갔는지 남긴다).
  stashCheckout: async (ctx) => {
    if (await git(ctx, ["stash", "push", "-u", "-m", `office: ${ctx.head}에서 ${ctx.name}(으)로 옮기기 전`])) await git(ctx, ["switch", ctx.name]);
  },
  checkoutLocal: (ctx) => git(ctx, ["switch", ctx.localOf]),
  fetch: async (ctx) => { if (await git(ctx, ["fetch", "--all", "--prune"])) notify({ title: "가져오기 완료", level: "info" }); },
  favorite: (ctx) => {
    const all = { ...(shared(FAV) ?? {}) }, list = new Set(all[ctx.top] ?? []);
    list.has(ctx.name) ? list.delete(ctx.name) : list.add(ctx.name);
    all[ctx.top] = [...list];
    setShared(FAV, all);
  },
  track: (ctx) => git(ctx, ["switch", "--track", ctx.ref.replace("refs/remotes/", "")]),
  openWorktree: (ctx) => openFolder(ctx.worktree),
  newBranch: async (ctx, value) => { if (await git(ctx, ["branch", value, ctx.ref])) notify({ title: `'${value}' 브랜치를 만들었습니다`, level: "info" }); },
  compare: (ctx) => inTab(ctx, `${ctx.head} ↔ ${ctx.name}`, ["git", "--no-pager", "log", "--oneline", "--graph", "--left-right", `${ctx.head}...${ctx.ref}`]),
  diff: (ctx) => inTab(ctx, `diff ${ctx.name}`, ["git", "diff", ctx.ref]),
  rebase: (ctx) => inTab(ctx, `rebase ${ctx.name}`, ["git", "rebase", ctx.ref]),
  merge: (ctx) => inTab(ctx, `merge ${ctx.name}`, ["git", "merge", ctx.ref]),
  newWorktree: async (ctx, value) => {
    const dir = worktreeDir(ctx, value);
    if (await git(ctx, ["worktree", "add", "-b", value, dir, ctx.ref])) run("space.new", { folder: dir });
  },
  update: (ctx) => (ctx.name === ctx.head
    ? inTab(ctx, `pull ${ctx.name}`, ["git", "pull", "--ff-only"])
    : git(ctx, ["fetch", ctx.upstream.remote, `${ctx.upstream.branch}:${ctx.name}`])),
  push: (ctx) => inTab(ctx, `push ${ctx.name}`, ctx.upstream
    ? ["git", "push", ctx.upstream.remote, `${ctx.name}:${ctx.upstream.branch}`]
    : ["git", "push", "-u", "origin", ctx.name]),
  rename: (ctx, value) => git(ctx, ["branch", "-m", ctx.name, value]),
  remove: (ctx) => git(ctx, ["branch", "-d", ctx.name]),
  removeRemote: (ctx) => {
    const [remote, ...rest] = ctx.name.split("/");
    inTab(ctx, `delete ${ctx.name}`, ["git", "push", remote, "--delete", rest.join("/")]);
  },
};

const ask = (ctx, action, title, hint, value = "") =>
  openOverlay({ mod: "office-git", kind: "dialog", width: 420, height: 210, props: { role: "prompt", ctx, action, title, hint, value } });
const confirm = (ctx, action, title, detail) =>
  openOverlay({ mod: "office-git", kind: "dialog", width: 420, height: 180, props: { role: "confirm", ctx, action, title, detail } });

// 우클릭 메뉴 구조. 자주 쓰는 것을 위에 두고 나머지는 하위 메뉴(▸)로 묶는다. 쓸 수 없는 항목은 숨긴다.
// 항목: { label, icon, color, fn, hint, danger } | { label, icon, color, sub: [...] } | "-"
const C = { view: "#7aa2f7", go: "#e5739d", fav: "#e8b92e", new: "#83c092", cmp: "#7fbbb3", mix: "#d699b6", remote: "#e69875", edit: "#dbbc7f", danger: "#e67e80" };
const I = (n) => `mods/office-git/${n}.svg`;

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

// 상태 배지: 메뉴 머리줄에 무엇을 우클릭했고 어떤 상태인지 보여 준다.
export function badges(ctx) {
  const out = [], tr = ctx.track ?? "";
  const up = /ahead (\d+)/.exec(tr)?.[1], down = /behind (\d+)/.exec(tr)?.[1];
  if (ctx.kind === "more" || ctx.kind === "stash") return out;
  if (ctx.kind === "local" && ctx.name === ctx.head) out.push(["현재", "#e5739d"]);
  if (ctx.isDefault) out.push(["기본", "#e8b92e"]);
  if (ctx.kind === "remote") out.push(["원격", "#7fbbb3"]);
  if (ctx.kind === "tag") out.push(["태그", "#dbbc7f"]);
  if (tr === "gone") out.push(["원격 없음", "#e67e80"]);
  if (up) out.push([`↑${up}`, "#a7c080"]);
  if (down) out.push([`↓${down}`, "#7aa2f7"]);
  if (ctx.kind === "local" && ctx.name !== ctx.head && ctx.merged) out.push(["병합됨", "#83c092"]);
  if (ctx.worktree && ctx.worktree !== ctx.top) out.push(["워크트리", "#d699b6"]);
  return out;
}

export function menuTree(ctx) {
  const { kind, name, head } = ctx, me = kind === "local" && name === head;
  const q = (s) => `'${s}'`, tr = ctx.track ?? "";
  const ahead = Number(/ahead (\d+)/.exec(tr)?.[1] ?? 0), behind = Number(/behind (\d+)/.exec(tr)?.[1] ?? 0), gone = tr === "gone";
  const elsewhere = ctx.worktree && ctx.worktree !== ctx.top; // 다른 워크트리에 체크아웃되어 있으면 여기서 체크아웃·삭제 불가
  const item = (label, icon, color, fn, hint) => ({ label, icon: I(icon), color, fn, hint });
  const danger = (label, fn, hint) => ({ ...item(label, "trash", C.danger, fn, hint), danger: true });
  const sub = (label, icon, color, list) => { const l = tidy(list); return l.length ? { label, icon: I(icon), color, sub: l } : null; };
  const log = item("커밋 로그 보기", "log", C.view, () => setShared("office-git.show", { name, ref: ctx.ref, top: ctx.top, at: Date.now() }));
  const fav = kind !== "tag" && item(ctx.fav ? "즐겨찾기 해제" : "즐겨찾기에 추가", "star-fill", C.fav, () => ACTIONS.favorite(ctx));
  const create = [
    item("여기서 새 브랜치...", "branch-new", C.new, () => ask(ctx, "newBranch", `${q(name)}에서 새 브랜치`, "새 브랜치 이름")),
    item("여기서 새 워크트리...", "folder", C.new, () => ask(ctx, "newWorktree", `${q(name)}(으)로부터 새 워크트리`, "새 브랜치 이름 (워크트리 폴더 이름도 됩니다)")),
  ];
  const compare = !me && sub(`${q(head)}와(과) 비교`, "status", C.cmp, [
    item("커밋 차이", "log", C.cmp, () => ACTIONS.compare(ctx), `${head}...${name}`),
    item("작업 트리와 파일 차이", "status", C.cmp, () => ACTIONS.diff(ctx), "git diff"),
  ]);
  // 이미 병합된 브랜치는 합칠 게 없으므로 숨긴다.
  const mix = !me && kind !== "tag" && !ctx.merged && sub(`${q(head)}에 합치기`, "pr", C.mix, [
    item(`${q(name)} 병합`, "pr", C.mix, () => confirm(ctx, "merge", "병합", `${q(name)}를 현재 브랜치 ${q(head)}에 병합합니다. 새 탭에서 실행합니다.`), "git merge"),
    item(`${q(name)} 위로 리베이스`, "branch", C.mix, () => confirm(ctx, "rebase", "리베이스", `현재 브랜치 ${q(head)}를 ${q(name)} 위로 다시 쌓습니다. 새 탭에서 실행합니다.`), "git rebase"),
  ]);
  const copyMenu = sub("복사", "copy", C.edit, [
    item("이름", "copy", C.edit, () => copy(name), name),
    item("커밋 해시", "copy", C.edit, () => copyHash(ctx), ctx.ref.replace(/^refs\/(heads|remotes|tags)\//, "")),
  ]);

  if (kind === "local") {
    // 원격과의 관계에 따라 맨 위에 올 "할 일"이 달라진다.
    const sync = [];
    if (!ctx.upstream) sync.push(item("원격에 올리기", "push", C.remote, () => ACTIONS.publish(ctx), "git push -u origin"));
    else if (gone) {
      sync.push(item("다시 올리기", "push", C.remote, () => ACTIONS.publish(ctx), "원격 브랜치를 새로 만듦"));
      sync.push(item("추적 정보 정리", "collapse", C.remote, () => ACTIONS.unsetUpstream(ctx), "--unset-upstream"));
    } else if (ahead && behind) {
      if (me) {
        sync.push(item("끌어와서 리베이스", "pull", C.remote, () => ACTIONS.pullRebase(ctx), "git pull --rebase"));
        sync.push(item("끌어와서 병합", "pull", C.remote, () => ACTIONS.pullMerge(ctx), "git pull --no-rebase"));
      }
      sync.push({ ...item(`강제 푸시... (↑${ahead} ↓${behind})`, "push", C.danger, () => confirm(ctx, "forcePush", "강제 푸시", `원격 ${q(`${ctx.upstream.remote}/${ctx.upstream.branch}`)}의 커밋 ${behind}개를 덮어씁니다. 다른 사람이 그사이 올린 게 있으면 git이 거부합니다(--force-with-lease).`), "--force-with-lease"), danger: true });
    } else if (behind) {
      sync.push(item(me ? `끌어오기 (↓${behind})` : `빨리 감기 (↓${behind})`, "pull", C.remote, () => ACTIONS.update(ctx), me ? "git pull --ff-only" : "체크아웃 없이"));
    } else if (ahead) {
      sync.push(item(`푸시 (↑${ahead})`, "push", C.remote, () => ACTIONS.push(ctx), `→ ${ctx.upstream.remote}/${ctx.upstream.branch}`));
    }

    const go = [];
    if (!me && elsewhere) go.push(item("워크트리 열기", "folder", C.go, () => ACTIONS.openWorktree(ctx), ctx.worktree.replace(ctx.home ?? "", "~")));
    else if (!me && ctx.dirty) {
      go.push(item("변경 사항 임시 저장 후 체크아웃", "stash", C.go, () => ACTIONS.stashCheckout(ctx), "stash → switch"));
      go.push(item("체크아웃", "branch", C.go, () => ACTIONS.checkout(ctx), "변경이 겹치면 git이 거부"));
    } else if (!me) go.push(item("체크아웃", "branch", C.go, () => ACTIONS.checkout(ctx), "git switch"));

    const remove = me || elsewhere || ctx.isDefault ? null
      : ctx.merged ? danger("삭제", () => ACTIONS.remove(ctx), "병합됨 · 안전")
      : danger("강제 삭제...", () => confirm(ctx, "forceRemove", "브랜치 강제 삭제", `${q(name)}는 ${q(head)}에 병합되지 않았습니다. 지우면 이 브랜치에만 있는 커밋을 잃을 수 있습니다.`), "병합 안 됨 · git branch -D");

    return tidy([
      ...go,
      ...sync,
      "-",
      log,
      fav,
      "-",
      ...create,
      "-",
      compare,
      mix,
      copyMenu,
      "-",
      !ctx.isDefault && item("이름 바꾸기...", "rename", C.edit, () => ask(ctx, "rename", "브랜치 이름 변경", `${q(name)}의 새 이름`, name)),
      // 병합된 브랜치는 정리 대상이라 삭제를 눈에 띄게, 아니면 맨 아래에
      remove,
    ]);
  }

  if (kind === "remote") return tidy([
    ctx.localOf
      ? item(`로컬 ${q(ctx.localOf)}로 체크아웃`, "branch", C.go, () => ACTIONS.checkoutLocal(ctx), "이미 추적 중")
      : item("체크아웃 (추적 브랜치 만들기)", "branch", C.go, () => ACTIONS.track(ctx), "git switch --track"),
    log,
    fav,
    "-",
    ...create,
    "-",
    compare,
    mix,
    copyMenu,
    "-",
    !ctx.isDefault && danger("원격에서 삭제...", () => confirm(ctx, "removeRemote", "원격 브랜치 삭제", `원격의 ${q(name)}를 삭제합니다. 되돌리기 어렵습니다. 새 탭에서 실행합니다.`), "git push --delete"),
  ]);

  if (kind === "more") return tidy([
    item("현재 브랜치 이름 변경...", "rename", C.edit, () => ask(ctx, "rename", "브랜치 이름 변경", `${q(name)}의 새 이름`, name), name),
    item("태그 만들기...", "tag-new", C.edit, () => ask(ctx, "newTag", `${q(name)}에 태그 만들기`, "태그 이름 (예: v1.2.0)"), `${name}에`),
    "-",
    item("작업 트리 상태", "status", C.view, () => ACTIONS.status(ctx), "git status"),
    item("병합된 브랜치 정리...", "prune", C.danger, () => ACTIONS.pruneMerged(ctx), `${name}에 병합된 것`),
    "-",
    item("원격 저장소 웹에서 열기", "web", C.cmp, () => ACTIONS.web(ctx)),
    ctx.lazygit && item("lazygit 열기", "terminal", C.cmp, () => ACTIONS.lazygit(ctx)),
  ]);
  if (kind === "stash") return tidy([
    ...ctx.stashes.map((x) => item(`${x.ref} ${x.msg}`, "unstash", C.edit, () => ACTIONS.stashPop(ctx, x.ref), x.ago)),
    "-",
    item("맨 위 stash 적용만 (남겨 둠)", "stash", C.edit, () => ACTIONS.stashApply(ctx, ctx.stashes[0].ref), "git stash apply"),
  ]);

  return tidy([
    log,
    item("여기서 새 브랜치...", "branch-new", C.new, () => ask(ctx, "newBranch", `${q(name)}에서 새 브랜치`, "새 브랜치 이름")),
    "-",
    compare,
    copyMenu,
  ]);
}

async function copy(text) {
  await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]);
  notify({ title: "복사했습니다", body: text, level: "info" });
}

async function copyHash(ctx) {
  const r = await exec("git", ["rev-parse", ctx.ref], { cwd: ctx.top, on: ctx.on });
  if (r.code === 0) copy(r.stdout.trim());
}

const ROW = 30, SEP = 9, HEAD = 34;
const height = (list) => list.reduce((h, it) => h + (it === "-" ? SEP : ROW), 12 + HEAD);

// 팝업 높이는 열 때 정해지므로 가장 긴 화면(맨 위 또는 하위 메뉴)에 맞춘다.
export function menuHeight(ctx) {
  const top = menuTree(ctx);
  return Math.max(height(top), ...top.filter((it) => Array.isArray(it?.sub)).map((it) => height(it.sub)));
}

// 하위 메뉴(▸)는 같은 팝업 안에서 화면을 바꿔 보여 주고, ← 또는 ←키로 돌아온다.
//   ↑↓ 고르기 · Enter/→ 실행 또는 열기 · ←/Backspace 뒤로 · Esc 닫기
export class Menu {
  init(_p, cx) {
    this.stack = []; // 열린 하위 메뉴들
    this.at = -1;
    this.h = cx.focus_handle();
    this.h.focus();
  }

  path() {
    let list = menuTree(props().ctx), parent = null;
    for (const i of this.stack) { parent = list[i]; list = parent.sub; }
    return { list, parent };
  }

  enter(i, cx) {
    const it = this.path().list[i];
    if (Array.isArray(it.sub)) { this.stack.push(i); this.at = -1; cx?.notify(); return; }
    closeOverlay(props().overlay);
    it.fn();
  }

  // 맨 위 머리줄: 우클릭한 브랜치와 그 상태.
  title(t, ctx) {
    const icon = ctx.kind === "tag" ? "tag" : ctx.kind === "stash" ? "stash-list" : ctx.kind === "local" && ctx.name === ctx.head ? "tag" : "branch";
    const title = ctx.kind === "stash" ? `임시 저장 ${ctx.stashes.length}개` : ctx.kind === "more" ? "더보기" : ctx.name;
    return h_flex().h(HEAD - 6).mb(4).px(6).gap(6).items_center().border_b_1().border_color(t.border)
      .child(svg(I(icon)).size(15).flex_none().text_color(ctx.kind === "local" && ctx.name === ctx.head ? "#e5739d" : "#6ca0dc"))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(title))
      .children(badges(ctx).map(([text, color]) => div().flex_none().px(5).py(1).rounded(4).text_size(11).text_color(color).border_1().border_color(color).child(text)));
  }

  back(cx) {
    if (!this.stack.length) return;
    this.at = this.stack.pop();
    cx?.notify();
  }

  render() {
    const t = theme(), p = props(), { list, parent } = this.path();
    const usable = list.map((it, i) => (it === "-" ? -1 : i)).filter((i) => i >= 0);
    return v_flex().id("git-menu").track_focus(this.h).size_full().p(6).bg(t.popover).text_size(13)
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
      .when(Boolean(parent), (el) => el.child(h_flex().id("gm-back").h(HEAD - 6).mb(4).px(6).gap(8).items_center().rounded(5).cursor_pointer()
        .border_b_1().border_color(t.border).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.back(cx))
        .child(svg(I("chevron-left")).size(14).text_color(t.foreground))
        .child(svg(parent.icon).size(14).text_color(parent.color))
        .child(div().font_semibold().text_color(t.foreground).child(parent.label))))
      .children(list.map((it, i) => it === "-"
        ? div().h(1).my(4).mx(6).bg(t.border)
        : h_flex().id(`gm-${this.stack.join("-")}-${i}`).h(ROW).px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .when(this.at === i, (el) => el.bg(t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.enter(i, cx))
          .child(svg(it.icon).size(15).flex_none().text_color(it.color))
          .child(div().flex_none().text_color(it.danger ? C.danger : t.foreground).child(it.label))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(it.hint ?? ""))
          .when(Array.isArray(it.sub), (el) => el.child(svg(I("chevron-right")).size(14).flex_none().text_color(t.foreground)))));
  }
}

function button(t, id, text, primary, action) {
  return h_flex().id(id).h(32).px(14).items_center().rounded(8).cursor_pointer().text_size(12.5)
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88)).on_click(action).child(text);
}

export class Prompt {
  init(_p, cx) {
    const p = props();
    this.text = p.value ?? "";
    this.input = InputState.new({ value: this.text });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  submit() {
    const p = props(), v = this.text.trim();
    if (!v) return;
    closeOverlay(p.overlay);
    ACTIONS[p.action](p.ctx, v);
  }

  render() {
    const t = theme(), p = props();
    return v_flex().id("git-prompt").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().child(div().flex_1().text_size(15).font_semibold().child(p.title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(12).text_color(t.dim).child(p.hint ?? ""))
      .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(13))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button(t, "gp-no", "취소", false, () => closeOverlay(p.overlay)))
        .child(button(t, "gp-yes", "확인", true, () => this.submit())));
  }
}

export class Confirm {
  init(_p, cx) {
    this.h = cx.focus_handle();
    this.h.focus();
  }

  yes() {
    const p = props();
    closeOverlay(p.overlay);
    ACTIONS[p.action](p.ctx);
  }

  render() {
    const t = theme(), p = props();
    return v_flex().id("git-confirm").track_focus(this.h).size_full().p(18).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.yes();
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(p.title))
      .child(div().flex_1().text_color(t.muted).child(p.detail))
      .child(h_flex().gap(8).justify_end()
        .child(button(t, "gc-no", "취소", false, () => closeOverlay(p.overlay)))
        .child(button(t, "gc-yes", "확인", true, () => this.yes())));
  }
}
