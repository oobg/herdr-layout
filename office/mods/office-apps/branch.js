// office-apps의 브랜치 앱. 지금 고른 스페이스(포커스된 패인)의 git 저장소를 보여 준다.
//   왼쪽: 툴바(검색·가져오기·끌어오기·푸시·새 브랜치·더보기) + 로컬/원격/태그 목록(비어 있는 섹션은 숨김)
//   오른쪽: 고른 브랜치의 추적 상태, 주 동작 하나 + ⋯(우클릭 메뉴와 같은 것), 받을 커밋, 최근 커밋(또는 커밋 비교)
// office-git(예전 독립 모드)의 기능을 앱 형태로 옮겼다. 짧은 일(체크아웃·만들기·이름 변경·삭제)은 바로 실행하고,
// 커밋·변경 내용 보기는 커밋 앱(office-apps.commit:/range:)으로 넘겨 앱 안에서 끝낸다.
// 인증이나 충돌 대화가 생길 수 있는 일(끌어오기·푸시·병합·리베이스·원격 삭제·태그 푸시·임시 저장 꺼내기)만
// 새 터미널 탭에서 돌린다. 위험한 동작은 menu.js의 확인 창(Confirm)을 거친다.
//
// 오버레이 연결: 확인 창(Confirm)은 menu.js의 ACTIONS 표에서 동작을 찾고, 오버레이 역할은 files.js의 ROLES에서
// 찾는다. 두 공용 파일을 고치지 않으려고 이 모듈이 불릴 때 "branch."로 시작하는 동작과 "branch-menu"·"branch-prompt"
// 역할을 그 표에 더해 둔다(register). main.js가 이 파일을 import하므로 모든 복사본(오버레이 포함)에서 먼저 돈다.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, home, props, run, openOverlay, closeOverlay, notify, shared, setShared } from "herdr";
import { Menu, ACTIONS, TICK, popupAt } from "./menu.js";
import { ROLES } from "./files.js";

const ME = "mods/office-apps";
const I = (n) => `${ME}/${n}.svg`;          // office-apps에 이미 있는 아이콘
const B = (n) => `${ME}/branch/${n}.svg`;   // office-git에서 가져온 아이콘
const PAGE = 100, CMP_N = 30;               // 커밋 그래프를 한 번에 몇 개씩, 비교 목록은 몇 개까지
// 커밋 그래프(예전 office-git과 같은 값): 줄 높이, 레인 폭, 레인 색 8개.
const GROW = 26, LANE = 14;
const LANES = ["#7aa2f7", "#a7c080", "#e69875", "#d699b6", "#83c092", "#dbbc7f", "#7fbbb3", "#e67e80"];
const CMP = "office-apps.branch.compare";   // 메뉴(오버레이)에서 앱에게 "이 브랜치를 비교해 보여 줘"를 넘기는 공유 키
const NOT_REPO = "git 저장소가 아닙니다";
const DANGER = "#e67e80";
// 툴바 아이콘 색: 기능마다 하나(files.js와 같은 톤).
const TOOL = { search: "#a7c080", fetch: "#7aa2f7", pull: "#a7c080", push: "#e69875", new: "#83c092", more: "#9da9a0" };
// 메뉴 아이콘 색
const C = { go: "#e5739d", new: "#83c092", cmp: "#7fbbb3", mix: "#d699b6", remote: "#e69875", edit: "#dbbc7f", view: "#7aa2f7", danger: DANGER };

// ── 위치·형식 ────────────────────────────────────────────────

// files.js와 같은 규칙: 포커스된 패인의 폴더, 없으면 스페이스 폴더. 다른 머신이면 on.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => { const l = location(); return JSON.stringify([l.on, l.cwd]); };

// "방금", "5분 전", "3시간 전", "어제", "4일 전", "25. 3. 9."
function ago(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000), s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  const day = Math.floor(s / 86400);
  if (day === 1) return "어제";
  if (day < 30) return `${day}일 전`;
  return `${String(d.getFullYear()).slice(2)}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

const q = (s) => `'${s}'`;

// 커밋마다 레인을 정한다(office-git에서 가져옴). lanes[i]는 i번째 줄이 다음에 만날 커밋 해시.
function graph(commits) {
  const lanes = [], out = [];
  for (const c of commits) {
    let at = lanes.indexOf(c.hash);
    if (at === -1) { at = lanes.indexOf(null); if (at === -1) at = lanes.length; lanes[at] = c.hash; }
    const before = lanes.map((h) => h !== null && h !== undefined);
    // 같은 커밋을 기다리던 다른 레인은 여기서 합쳐진다.
    for (let i = 0; i < lanes.length; i++) if (i !== at && lanes[i] === c.hash) lanes[i] = null;
    lanes[at] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) if (!lanes.includes(p)) { const free = lanes.indexOf(null); lanes[free === -1 ? lanes.length : free] = p; }
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    const after = lanes.map((h) => h !== null && h !== undefined);
    out.push({ ...c, lane: at, before, after, width: Math.max(before.length, after.length, at + 1) });
  }
  return out;
}

// git log 한 줄(%H %P %at %s, NUL로 구분)을 커밋으로.
const LOG_FMT = "--format=%H%x00%P%x00%at%x00%s";
const parseLog = (res) => (res?.code === 0 ? res.stdout.split("\n").filter(Boolean).map((l) => {
  const [hash, parents, at, subject] = l.split("\0");
  return { hash, parents: parents ? parents.split(" ") : [], at: Number(at), subject };
}) : []);
const counts = (ahead, behind) => [ahead && `${ahead}개 앞섬`, behind && `${behind}개 뒤처짐`].filter(Boolean).join(" · ");

// ── 동작(오버레이 복사본에서도 돈다: ctx는 값만) ────────────────
// ctx: { kind: "local"|"remote"|"tag"|"more"|"stash", name, ref, short, remote, head, top, on, home,
//        upstream: { ref, short, remote, branch } | null, ahead, behind, gone, merged, dirty, isDefault, localOf, worktree, gh }

const changed = () => setShared(TICK, Date.now());

async function git(ctx, args, timeout) {
  let r;
  try { r = await exec("git", args, { cwd: ctx.top, on: ctx.on, timeout }); }
  catch (e) { notify({ title: `git ${args[0]} 실패`, body: String(e?.message ?? e).slice(0, 300), level: "error" }); changed(); return false; }
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

async function copy(text, what) {
  await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(() => null);
  notify({ title: `${what}를 복사했습니다`, body: text, level: "info" });
}

// 체크아웃된 워크트리 폴더를 스페이스로: 이미 열려 있으면 그 스페이스로, 아니면 새로.
function openFolder(folder) {
  const s = spaces().find((x) => x.folder === folder || panes().some((p) => x.tabs.some((tb) => tb.id === p.tab) && p.cwd === folder));
  if (s) run("space.select", { id: s.id });
  else run("space.new", { folder });
}

const done = (title, body) => notify({ title, body, level: "info" });

// value는 입력 창의 글자. 확인 창은 (ctx)만 넘긴다.
const ACT = {
  checkout: (ctx) => git(ctx, ["switch", ctx.name]),
  stashCheckout: async (ctx) => {
    if (await git(ctx, ["stash", "push", "-u", "-m", `office: ${ctx.head ?? "HEAD"}에서 ${ctx.name}(으)로 옮기기 전`])) await git(ctx, ["switch", ctx.name]);
  },
  track: (ctx) => git(ctx, ["switch", "--track", ctx.name]),
  checkoutLocal: (ctx) => git(ctx, ["switch", ctx.localOf]),
  openWorktree: (ctx) => openFolder(ctx.worktree),
  newBranch: async (ctx, v) => { if (await git(ctx, ["switch", "-c", v, ctx.ref])) done(`'${v}' 브랜치를 만들고 옮겼습니다`, `${ctx.name}에서`); },
  rename: async (ctx, v) => { if (await git(ctx, ["branch", "-m", ctx.name, v])) done("이름을 바꿨습니다", `${ctx.name} → ${v}`); },
  remove: async (ctx) => { if (await git(ctx, ["branch", "-d", ctx.name])) done("브랜치를 삭제했습니다", ctx.name); },
  forceRemove: async (ctx) => { if (await git(ctx, ["branch", "-D", ctx.name])) done("브랜치를 삭제했습니다", ctx.name); },
  removeRemote: (ctx) => inTab(ctx, `delete ${ctx.name}`, ["git", "push", ctx.remote, "--delete", ctx.short]),
  newTag: async (ctx, v) => { if (await git(ctx, ["tag", v, ctx.ref])) done(`'${v}' 태그를 만들었습니다`, ctx.name); },
  removeTag: async (ctx) => { if (await git(ctx, ["tag", "-d", ctx.name])) done("태그를 삭제했습니다", ctx.name); },
  pushTag: (ctx) => inTab(ctx, `push tag ${ctx.name}`, ["git", "push", "origin", ctx.ref]),
  fetch: async (ctx) => { if (await git(ctx, ["fetch", "--all", "--prune"], 180000)) done("가져오기 완료", "git fetch --all --prune"); },
  pull: (ctx) => inTab(ctx, `pull ${ctx.name}`, ["git", "pull", "--ff-only"]),
  pullRebase: (ctx) => inTab(ctx, `pull --rebase ${ctx.name}`, ["git", "pull", "--rebase"]),
  // 현재 브랜치가 아닌 로컬 브랜치를 체크아웃 없이 원격까지 빨리 감기.
  fastForward: (ctx) => git(ctx, ["fetch", ctx.upstream.remote, `${ctx.upstream.branch}:${ctx.name}`], 180000),
  push: (ctx) => inTab(ctx, `push ${ctx.name}`, ["git", "push", ctx.upstream.remote, `${ctx.name}:${ctx.upstream.branch}`]),
  publish: (ctx) => inTab(ctx, `push -u ${ctx.name}`, ["git", "push", "-u", "origin", ctx.name]),
  // lease는 목록을 읽을 때 본 원격 추적 해시로 고정한다. 해시 없이 --force-with-lease만 주면 그사이 가져오기(fetch)가
  // 원격 추적 ref를 옮겨 보호가 사라진다. ref 이름은 원격 쪽 브랜치 이름이다.
  forcePush: (ctx) => {
    if (!ctx.upstream?.hash) return;
    inTab(ctx, `force push ${ctx.name}`, ["git", "push", `--force-with-lease=${ctx.upstream.branch}:${ctx.upstream.hash}`, ctx.upstream.remote, `${ctx.name}:${ctx.upstream.branch}`]);
  },
  unsetUpstream: async (ctx) => { if (await git(ctx, ["branch", "--unset-upstream", ctx.name])) done("추적 정보를 정리했습니다", ctx.name); },
  merge: (ctx) => inTab(ctx, `merge ${ctx.name}`, ["git", "merge", ctx.ref]),
  rebase: (ctx) => inTab(ctx, `rebase ${ctx.name}`, ["git", "rebase", ctx.ref]),
  // 커밋 비교는 앱 오른쪽 칸에서 보여 준다. 메뉴는 오버레이 복사본에서 돌므로 공유 값으로 앱에게 넘긴다(sync가 받음).
  compare: (ctx) => setShared(CMP, { top: ctx.top, ref: ctx.ref, at: Date.now() }),
  // 변경 내용·커밋은 커밋 앱에서 연다(터미널 탭을 쌓지 않는다).
  diff: (ctx) => run(`office-apps.range:HEAD...${ctx.name}`),
  copyName: (ctx) => copy(ctx.name, "이름"),
  copyHash: async (ctx) => {
    const r = await exec("git", ["rev-parse", `${ctx.ref}^{commit}`], { cwd: ctx.top, on: ctx.on }).catch(() => null);
    if (r?.code === 0) copy(r.stdout.trim(), "커밋 해시");
  },
  stash: async (ctx) => { if (await git(ctx, ["stash", "push", "-u"])) done("변경 사항을 임시 저장했습니다", "git stash push -u"); },
  // stash 목록을 읽어 메뉴로 보여 준다. 고르면 그 stash를 꺼낸다(pop).
  stashMenu: async (ctx) => {
    const r = await exec("git", ["stash", "list", "--format=%gd%x00%cr%x00%gs"], { cwd: ctx.top, on: ctx.on }).catch(() => null);
    const stashes = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => { const [ref, when, msg] = l.split("\0"); return { ref, when, msg }; });
    if (!stashes.length) return done("임시 저장된 것이 없습니다");
    openMenu({ ...ctx, kind: "stash", stashes }, 420);
  },
  stashPop: (ctx, ref) => inTab(ctx, `stash pop ${ref}`, ["git", "stash", "pop", ref]),
  stashApply: (ctx, ref) => inTab(ctx, `stash apply ${ref}`, ["git", "stash", "apply", ref]),
  status: () => run("office-apps.commit:WORKTREE"),
  refresh: () => changed(),
  // 현재 브랜치에 이미 병합된 로컬 브랜치를 찾아, 확인을 받고 지운다. 기본 브랜치와 워크트리에 체크아웃된 것은 남긴다.
  pruneMerged: async (ctx) => {
    const r = await exec("git", ["branch", "--merged", "HEAD", "--format=%(refname:short)%00%(worktreepath)"], { cwd: ctx.top, on: ctx.on }).catch(() => null);
    const keep = new Set([ctx.head, ctx.defaultName, "main", "master", "develop", "dev", "staging", "release"]);
    const list = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split("\0")).filter(([n, wt]) => !keep.has(n) && !wt).map(([n]) => n);
    if (!list.length) return done("정리할 병합된 브랜치가 없습니다");
    confirm({ ...ctx, list }, "pruneList", `병합된 브랜치 ${list.length}개 삭제`, `${q(ctx.head ?? "HEAD")}에 이미 병합된 브랜치입니다: ${list.join(", ")}`, { yes: `${list.length}개 삭제`, danger: true });
  },
  pruneList: async (ctx) => { if (await git(ctx, ["branch", "-d", ...ctx.list])) done(`브랜치 ${ctx.list.length}개를 삭제했습니다`); },
  // origin 주소를 웹 주소로 바꿔 브라우저로 연다 (git@host:o/r.git → https://host/o/r).
  web: async (ctx) => {
    const r = await exec("git", ["remote", "get-url", "origin"], { cwd: ctx.top, on: ctx.on }).catch(() => null);
    if (r?.code !== 0) return notify({ title: "origin 원격이 없습니다", level: "error" });
    const url = r.stdout.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/").replace(/\.git$/, "");
    await exec("open", [ctx.head ? `${url}/tree/${encodeURI(ctx.head)}` : url]);
  },
  // 브라우저에서 PR 만들기 화면만 연다. 탭 없이 바로 실행하고, 실패하면 알림으로.
  pr: async (ctx) => {
    const r = await exec("gh", ["pr", "create", "--web"], { cwd: ctx.top, on: ctx.on, timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code !== 0) notify({ title: "풀 리퀘스트 화면을 열지 못했습니다", body: (r.stderr || r.stdout || "").trim().slice(0, 400), level: "error" });
  },
};

// ── 오버레이 열기 ────────────────────────────────────────────

// opts: { yes: 실행 버튼 이름, danger: 되돌리기 어려우면 true } — menu.js Confirm 참고
const confirm = (ctx, action, title, detail, opts = {}) => {
  register();
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: { role: "confirm", ctx, action: `branch.${action}`, title, detail, ...opts } });
};
const ask = (ctx, action, title, hint, value = "") => {
  register();
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 210, props: { role: "branch-prompt", ctx, action, title, hint, value } });
};

// ── 메뉴 항목(우클릭 메뉴·⋯ 버튼, 오른쪽 주 동작이 같이 쓴다) ────────
// 항목: { label, icon, color, fn, hint, danger, primary } | "-"
// primary: 오른쪽 칸에 버튼으로 꺼내는 주 동작(브랜치마다 많아야 하나). Enter(activate)도 이것을 부른다.

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

function itemsFor(ctx) {
  const { kind, name, head } = ctx, me = kind === "local" && name === head;
  const item = (label, icon, color, fn, hint) => ({ label, icon, color, fn, hint });
  const danger = (label, fn, hint) => ({ ...item(label, I("trash"), C.danger, fn, hint), danger: true });
  const newBranch = item("새 브랜치...", B("branch-new"), C.new, () => ask(ctx, "newBranch", `${q(name)}에서 새 브랜치`, "만들고 바로 옮깁니다 (git switch -c)"), "git switch -c");
  const compare = !me && [
    item("커밋 비교", I("log"), C.cmp, () => ACT.compare(ctx), `HEAD...${name}`),
    item("변경 보기", B("status"), C.cmp, () => ACT.diff(ctx), "커밋 앱에서"),
  ];
  // 현재 브랜치가 있고, 아직 합쳐지지 않은 것만.
  const mix = !me && head && kind !== "tag" && !ctx.merged && [
    item("병합...", B("pr"), C.mix, () => confirm(ctx, "merge", "병합", `${q(name)}를 현재 브랜치 ${q(head)}에 병합합니다. 새 탭에서 실행합니다.`, { yes: "병합" }), "git merge"),
    item("리베이스...", I("branch"), C.mix, () => confirm(ctx, "rebase", "리베이스", `현재 브랜치 ${q(head)}를 ${q(name)} 위로 다시 쌓습니다. 새 탭에서 실행합니다.`, { yes: "리베이스", danger: true }), "git rebase"),
  ];
  const copies = [
    item("이름 복사", I("copy"), C.edit, () => ACT.copyName(ctx), name),
    item("커밋 해시 복사", I("copy"), C.edit, () => ACT.copyHash(ctx)),
  ];
  const primary = (it) => it && { ...it, primary: true };

  if (kind === "local") {
    const { ahead, behind, gone, upstream } = ctx, elsewhere = Boolean(ctx.worktree);
    const go = [];
    if (!me && elsewhere) go.push(item("워크트리 열기", B("folder"), C.go, () => ACT.openWorktree(ctx), ctx.worktree.replace(ctx.home ?? "", "~")));
    else if (!me && ctx.dirty) {
      go.push(item("임시 저장 후 체크아웃", B("stash"), C.go, () => ACT.stashCheckout(ctx), "stash → switch"));
      go.push(item("체크아웃", I("branch"), C.go, () => ACT.checkout(ctx), "변경이 겹치면 git이 거부"));
    } else if (!me) go.push(item("체크아웃", I("branch"), C.go, () => ACT.checkout(ctx), "git switch"));

    // 원격과의 관계에 따라 "할 일"이 달라진다.
    const sync = [];
    if (!upstream) sync.push(item("원격에 올리기", B("push"), C.remote, () => ACT.publish(ctx), "git push -u origin"));
    else if (gone) {
      sync.push(item("다시 올리기", B("push"), C.remote, () => ACT.publish(ctx), "원격 브랜치를 새로 만듦"));
      sync.push(item("추적 정보 정리", B("prune"), C.remote, () => ACT.unsetUpstream(ctx), "--unset-upstream"));
    } else if (ahead && behind) {
      if (me) sync.push(item("끌어와서 리베이스", B("pull"), C.remote, () => ACT.pullRebase(ctx), "git pull --rebase"));
      // 원격 추적 해시를 못 읽었으면 lease를 걸 수 없으므로 강제 푸시를 내놓지 않는다.
      if (upstream.hash) sync.push({ ...item("강제 푸시...", B("push"), C.danger, () => confirm(ctx, "forcePush", "강제 푸시",
        `원격 ${q(upstream.short)}의 커밋 ${behind}개를 덮어씁니다. 원격이 목록에서 본 상태(${upstream.hash.slice(0, 7)})와 다르면 git이 거부합니다.`, { yes: "강제 푸시", danger: true }), "--force-with-lease"), danger: true });
    } else if (behind) {
      sync.push(me ? item("끌어오기", B("pull"), C.remote, () => ACT.pull(ctx), "git pull --ff-only")
        : item("빨리 감기", B("pull"), C.remote, () => ACT.fastForward(ctx), "체크아웃 없이"));
    } else if (ahead) sync.push(item("푸시", B("push"), C.remote, () => ACT.push(ctx), `→ ${upstream.short}`));
    // 주 동작: 다른 브랜치면 체크아웃(또는 워크트리 열기), 현재 브랜치면 원격 상태에 맞춘 푸시/끌어오기.
    if (!me && go.length) go[go.length - 1] = primary(go[go.length - 1]);
    if (me && sync.length && !sync[0].danger) sync[0] = primary(sync[0]);

    const remove = me || elsewhere || ctx.isDefault ? null
      : ctx.merged ? danger("삭제...", () => confirm(ctx, "remove", "브랜치 삭제", `${q(name)}를 삭제합니다. ${q(head)}에 이미 병합되어 커밋은 남습니다.`, { yes: "삭제" }), "병합됨 · git branch -d")
      : danger("강제 삭제...", () => confirm(ctx, "forceRemove", "브랜치 강제 삭제", `${q(name)}는 ${q(head ?? "HEAD")}에 병합되지 않았습니다. 지우면 이 브랜치에만 있는 커밋을 잃을 수 있습니다.`, { yes: "강제 삭제", danger: true }), "병합 안 됨 · git branch -D");

    return tidy([
      ...go, ...sync, "-",
      newBranch, ...(compare || []), ...(mix || []), "-",
      ...copies, "-",
      item("이름 바꾸기...", I("rename"), C.edit, () => ask(ctx, "rename", "브랜치 이름 바꾸기", `${q(name)}의 새 이름`, name)),
      item("태그 만들기...", B("tag-new"), C.edit, () => ask(ctx, "newTag", `${q(name)}에 태그 만들기`, "태그 이름 (예: v1.2.0)")),
      remove,
    ]);
  }

  if (kind === "remote") return tidy([
    primary(ctx.localOf
      ? item(`${q(ctx.localOf)}로 체크아웃`, I("branch"), C.go, () => ACT.checkoutLocal(ctx), "이미 추적 중")
      : item("체크아웃", I("branch"), C.go, () => ACT.track(ctx), "추적 브랜치 만들기")),
    "-",
    newBranch, ...(compare || []), ...(mix || []), "-",
    ...copies, "-",
    !ctx.isDefault && danger("원격에서 삭제...", () => confirm(ctx, "removeRemote", "원격 브랜치 삭제", `원격의 ${q(name)}를 삭제합니다. 되돌리기 어렵습니다. 새 탭에서 실행합니다.`, { yes: "원격에서 삭제", danger: true }), "git push --delete"),
  ]);

  // 태그
  return tidy([
    newBranch, ...(compare || []), "-",
    ...copies, "-",
    item("원격에 올리기", B("push"), C.remote, () => ACT.pushTag(ctx), "git push origin"),
    danger("태그 삭제...", () => confirm(ctx, "removeTag", "태그 삭제", `로컬 태그 ${q(name)}를 삭제합니다. 원격에 올린 태그는 남습니다.`, { yes: "태그 삭제" }), "git tag -d"),
  ]);
}

const primaryOf = (ctx) => itemsFor(ctx).find((it) => it !== "-" && it.primary) ?? null;

// 툴바 ⋯: 덜 쓰는 것
function moreItems(ctx) {
  const item = (label, icon, color, fn, hint) => ({ label, icon, color, fn, hint });
  return tidy([
    ctx.dirty && item("변경 사항 임시 저장", B("stash"), C.edit, () => ACT.stash(ctx), "git stash push -u"),
    item("임시 저장 꺼내기...", B("unstash"), C.edit, () => ACT.stashMenu(ctx), "git stash pop"),
    ctx.head && item("현재 브랜치에 태그...", B("tag-new"), C.edit, () => ask(ctx, "newTag", `${q(ctx.head)}에 태그 만들기`, "태그 이름 (예: v1.2.0)"), ctx.head),
    "-",
    item("작업 트리 상태", B("status"), C.view, () => ACT.status(ctx), "커밋 앱에서"),
    ctx.head && { ...item("병합된 브랜치 정리...", B("prune"), C.danger, () => ACT.pruneMerged(ctx), `${ctx.head}에 병합된 것`), danger: true },
    "-",
    item("저장소 웹에서 열기", B("web"), C.cmp, () => ACT.web(ctx)),
    ctx.gh && ctx.head && item("풀 리퀘스트 만들기", B("pr"), C.mix, () => ACT.pr(ctx), "gh pr create --web"),
    "-",
    item("다시 읽기", I("refresh"), C.view, () => ACT.refresh(ctx)),
  ]);
}

function menuItems(ctx) {
  if (ctx.kind === "more") return moreItems(ctx);
  if (ctx.kind === "stash") return tidy([
    ...ctx.stashes.map((x) => ({ label: `${x.ref} ${x.msg}`, icon: B("unstash"), color: C.edit, fn: () => ACT.stashPop(ctx, x.ref), hint: x.when })),
    "-",
    { label: "맨 위 것 적용만 (남겨 둠)", icon: B("stash"), color: C.edit, fn: () => ACT.stashApply(ctx, ctx.stashes[0].ref), hint: "git stash apply" },
  ]);
  return itemsFor(ctx);
}

// menu.js Menu와 같은 줄 높이로 팝업 높이를 정한다(하위 메뉴 없음).
const ROW = 30, SEP = 9, HEAD = 34;
function openMenu(ctx, width = 320) {
  register();
  const h = menuItems(ctx).reduce((n, it) => n + (it === "-" ? SEP : ROW), 12 + HEAD);
  openOverlay({ mod: "office-apps", kind: "popup", at: popupAt(width, h), width, height: h, props: { role: "branch-menu", ctx } });
}

// 우클릭 메뉴: menu.js Menu의 그리기·키 처리를 그대로 쓰고 항목과 머리줄만 바꾼다. 항목이 평평해야 한다(sub 금지).
class BranchMenu extends Menu {
  list() { return menuItems(props().ctx); }

  title(t, ctx) {
    const label = ctx.kind === "more" ? "더보기" : ctx.kind === "stash" ? `임시 저장 ${ctx.stashes.length}개` : ctx.name;
    const icon = ctx.kind === "tag" ? B("tag") : ctx.kind === "stash" ? B("stash-list") : ctx.kind === "more" ? B("more") : I("branch");
    const note = ctx.kind === "local" && ctx.name === ctx.head ? "현재" : ctx.kind === "remote" ? "원격" : ctx.kind === "tag" ? "태그" : "";
    return h_flex().h(HEAD - 6).mb(4).px(6).gap(8).items_center().border_b_1().border_color(t.border)
      .child(svg(icon).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(label))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(note));
  }
}

// 브랜치·태그 이름 입력 창. 이름은 git이 한 번 더 검사한다(check-ref-format).
class BranchPrompt {
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

  // 막는 것: 빈 이름, 옵션처럼 보이는 이름(-로 시작), 빈칸. 나머지 규칙은 git이 알려 준다.
  bad(name) {
    return !name || name.startsWith("-") || /\s/.test(name);
  }

  submit() {
    const p = props(), name = this.text.trim();
    if (this.bad(name) || (p.action === "rename" && name === p.value)) return;
    closeOverlay(p.overlay);
    ACT[p.action](p.ctx, name);
  }

  render() {
    const t = theme(), p = props(), name = this.text.trim();
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).cursor_pointer().text_size(12.5)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const warn = name.startsWith("-") ? "-로 시작할 수 없습니다" : /\s/.test(name) ? "빈칸은 쓸 수 없습니다" : "";
    return v_flex().id("br-prompt").size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(p.title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(12).text_color(warn ? DANGER : t.dim).child(warn || (p.hint ?? "")))
      .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(13))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button("br-p-no", "취소", false, () => closeOverlay(p.overlay)))
        .child(button("br-p-yes", p.action === "rename" ? "바꾸기" : "만들기", true, () => this.submit())));
  }
}

// ── 앱 ──────────────────────────────────────────────────────

export class BranchApp {
  init(_p, cx) {
    register();
    this.tick = shared(TICK);
    this.ctx = null;        // { key, cwd, on, top }
    this.refs = null;       // { head, detached, local[], remote[], tags[], dirty, defaults, defaultName }
    this.loading = false; this.error = null;
    this.sel = null;        // 고른 ref 전체 이름(refs/heads/x). main과 origin/main이 겹치지 않게.
    this.closed = false;    // ✕로 상세를 닫았으면 다시 읽어도 현재 브랜치를 다시 고르지 않는다.
    this.info = null;       // 오른쪽 상세 { ref, vsHead, cmp: { mine[], theirs[] } | null }
    this.log = null;        // 커밋 그래프 { ref, raw[], rows[], more, loading }
    this.cmpRef = null;     // 커밋 비교를 보고 있는 ref(오른쪽 칸이 그래프 대신 비교 목록)
    this.cmpAt = shared(CMP)?.at ?? null;
    this.scroll = ScrollHandle.new();
    this.rowAt = new Map(); // 목록에 보이는 ref → br-list의 몇 번째 자식인지(키보드 이동·스크롤용, 보이는 순서)
    this.gh = false;
    this.searching = false; this.query = "";
    this.searchInput = InputState.new({ placeholder: "브랜치 이름" });
    this.searchInput.on("change", (_e, cx) => { this.query = this.searchInput.value().trim().toLowerCase(); cx.notify(); });
    try { this.open = JSON.parse(localStorage.getItem("branch.open") ?? "null") ?? { local: true, remote: true, tags: false }; }
    catch { this.open = { local: true, remote: true, tags: false }; }
    cx.spawn(async () => {
      const r = await exec("sh", ["-lc", "command -v gh"]).catch(() => null);
      this.gh = r?.code === 0;
    });
    this.reload(cx);
    this.poll = cx.timer.every(15000, (cx) => { if (this.disposed) return; this.reload(cx); });
  }

  // 앱을 끌 때(main.js toggle): 15초 타이머를 끊고 .git 감시 사슬이 다음 차례에 멈추게 한다.
  // watchFolder는 해제 API가 없어 지금 기다리는 한 번은 끝까지 기다리고, 그 뒤 disposed를 보고 빠진다.
  dispose() {
    this.disposed = true;
    this.poll?.cancel(); this.poll = null;
    this.watchTask?.cancel(); this.watchTask = null;
    try { this.scroll?.release(); } catch { /* 이미 해제됨 */ }
  }

  current(ctx) { return this.ctx === ctx && key() === ctx.key; }

  reload(cx) {
    const { cwd, on } = location(), k = key();
    if (k !== this.ctx?.key) {
      this.ctx = { key: k, cwd, on, top: null };
      this.refs = null; this.sel = null; this.info = null; this.log = null; this.cmpRef = null; this.closed = false;
      this.error = null; this.watching = null; this.loading = false;
    }
    if (!cwd || this.loading) return;
    const ctx = this.ctx;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) { if (this.ctx === ctx) { this.error = NOT_REPO; this.refs = null; } return; }
        ctx.top = top.stdout.trim();
        const refs = await this.loadRefs(ctx);
        if (!this.current(ctx)) return;
        this.refs = refs; this.error = null;
        // 고른 ref가 사라졌으면(삭제·이름 변경) 현재 브랜치로. ✕로 닫아 둔 동안은 비워 둔다.
        const all = [...refs.local, ...refs.remote, ...refs.tags];
        if (this.sel && !all.some((b) => b.ref === this.sel)) { this.sel = null; this.info = null; this.log = null; this.cmpRef = null; }
        if (!this.sel && !this.closed) this.sel = refs.head ? `refs/heads/${refs.head}` : null;
        this.watch(ctx, cx);
        this.loadDetail(cx);
      } catch (e) {
        if (this.ctx === ctx) this.error = String(e?.message || e).slice(0, 200);
      } finally {
        if (this.ctx === ctx) this.loading = false;
        cx.notify();
      }
    });
  }

  // HEAD나 ref가 바뀌면(커밋, 체크아웃, fetch) 다시 읽는다. 다른 머신은 타이머로만.
  watch(ctx, cx) {
    if (this.disposed || ctx.on || this.watching === ctx) return;
    this.watching = ctx;
    this.watchTask = cx.spawn(async (cx) => {
      const gd = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: ctx.top }).catch(() => null);
      if (gd?.code !== 0) return;
      try { while (!this.disposed && this.ctx === ctx) { await watchFolder(gd.stdout.trim()); if (!this.disposed && this.ctx === ctx) this.reload(cx); } }
      catch { if (this.watching === ctx) this.watching = null; }
    });
  }

  async loadRefs(ctx) {
    const o = { cwd: ctx.top, on: ctx.on };
    const fmt = ["%(refname)", "%(objectname:short)", "%(objectname)", "%(HEAD)", "%(symref)", "%(upstream)", "%(upstream:short)", "%(upstream:remotename)",
      "%(upstream:track,nobracket)", "%(worktreepath)", "%(committerdate:unix)", "%(creatordate:unix)", "%(contents:subject)"].join("%00");
    const r = await exec("git", ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes", "refs/tags"], o);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "브랜치를 읽지 못했습니다");
    const refs = { head: null, detached: null, local: [], remote: [], tags: [], defaults: new Set() };
    const fullOf = new Map(); // ref → 전체 해시. 로컬 브랜치의 upstream 해시(강제 푸시 lease)를 채울 때 쓴다.
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const [ref, hash, full, star, symref, up, upShort, upRemote, track, wt, cdate, tdate, subject] = line.split("\0");
      const at = Number(cdate) || Number(tdate) || 0;
      fullOf.set(ref, full);
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice(11);
        const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
        const upstream = up ? { ref: up, short: upShort, remote: upRemote, branch: up.startsWith(`refs/remotes/${upRemote}/`) ? up.slice(14 + upRemote.length) : upShort } : null;
        refs.local.push({ kind: "local", ref, name, hash, at, subject, upstream, ahead, behind, gone: track === "gone", wt: wt || null });
        if (star === "*") refs.head = name;
      } else if (ref.startsWith("refs/remotes/")) {
        const rest = ref.slice(13), slash = rest.indexOf("/"), remote = rest.slice(0, slash), short = rest.slice(slash + 1);
        if (short === "HEAD") { if (symref) refs.defaults.add(symref.replace("refs/remotes/", "")); continue; }
        refs.remote.push({ kind: "remote", ref, name: rest, remote, short, hash, at, subject });
      } else {
        refs.tags.push({ kind: "tag", ref, name: ref.slice(10), hash, at, subject });
      }
    }
    // 최근에 커밋한 것이 위로. 현재 브랜치는 맨 위.
    const byDate = (a, b) => b.at - a.at || a.name.localeCompare(b.name);
    refs.local.sort((a, b) => (b.name === refs.head) - (a.name === refs.head) || byDate(a, b));
    refs.remote.sort(byDate); refs.tags.sort(byDate);
    const [merged, dirty, detached] = await Promise.all([
      exec("git", ["branch", "--merged", "HEAD", "--format=%(refname:short)"], o).catch(() => null),
      exec("git", ["--no-optional-locks", "status", "--porcelain", "-uno"], o).catch(() => null),
      refs.head ? null : exec("git", ["rev-parse", "--short", "HEAD"], o).catch(() => null),
    ]);
    refs.merged = new Set((merged?.stdout ?? "").split("\n").filter(Boolean));
    refs.dirty = Boolean((dirty?.stdout ?? "").trim());
    refs.detached = detached?.code === 0 ? detached.stdout.trim() : null;
    refs.tracking = {};
    for (const b of refs.local) if (b.upstream) {
      refs.tracking[b.upstream.short] = b.name;
      b.upstream.hash = fullOf.get(b.upstream.ref) || null;
    }
    const def = [...refs.defaults][0];
    refs.defaultName = def ? def.slice(def.indexOf("/") + 1) : refs.local.some((b) => b.name === "main") ? "main" : refs.local.some((b) => b.name === "master") ? "master" : null;
    return refs;
  }

  find(ref) {
    const r = this.refs;
    return r ? [...r.local, ...r.remote, ...r.tags].find((b) => b.ref === ref) ?? null : null;
  }

  // 메뉴·동작이 쓰는 정보. 오버레이로 넘어가므로 값만 담는다.
  ctxFor(b) {
    const r = this.refs, c = this.ctx;
    return {
      kind: b.kind, name: b.name, ref: b.ref, short: b.short ?? b.name, remote: b.remote ?? null,
      head: r?.head ?? null, top: c.top, on: c.on, home: home(), gh: this.gh,
      upstream: b.upstream ?? null, ahead: b.ahead ?? 0, behind: b.behind ?? 0, gone: Boolean(b.gone),
      merged: b.kind === "local" && Boolean(r?.merged?.has(b.name)), dirty: Boolean(r?.dirty),
      isDefault: b.kind === "local" ? b.name === r?.defaultName : b.kind === "remote" ? Boolean(r?.defaults?.has(b.name)) : false,
      localOf: b.kind === "remote" ? r?.tracking?.[b.name] ?? null : null,
      worktree: b.wt && b.wt !== c.top ? b.wt : null, defaultName: r?.defaultName ?? null,
    };
  }

  // 툴바·⋯이 쓰는 현재 브랜치 정보(분리된 HEAD면 이름 없이).
  headCtx() {
    const r = this.refs, b = r?.head ? r.local.find((x) => x.name === r.head) : null;
    if (b) return this.ctxFor(b);
    return { kind: "local", name: "HEAD", ref: "HEAD", short: "HEAD", head: null, top: this.ctx.top, on: this.ctx.on, home: home(), gh: this.gh,
      upstream: null, ahead: 0, behind: 0, gone: false, dirty: Boolean(r?.dirty), defaultName: r?.defaultName ?? null };
  }

  select(ref, cx) {
    if (ref !== this.sel) { this.info = null; this.log = null; this.cmpRef = null; }
    this.sel = ref; this.closed = false;
    this.loadDetail(cx);
    cx.notify();
  }

  // 오른쪽 상세: 현재 브랜치 대비 개수, 커밋 그래프(처음 PAGE개), 비교 중이면 양쪽에만 있는 커밋.
  loadDetail(cx) {
    const b = this.find(this.sel), ctx = this.ctx;
    if (!b || !ctx?.top) return;
    const sel = this.sel, o = { cwd: ctx.top, on: ctx.on }, r = this.refs;
    const isHead = b.kind === "local" && b.name === r?.head;
    const cmp = this.cmpRef === sel && !isHead && r?.head;
    // 다시 읽을 때(15초마다·git 변경) 이미 더 불러온 만큼은 유지한다.
    const n = Math.max(PAGE, this.log?.ref === sel ? this.log.raw.length : 0);
    cx.spawn(async (cx) => {
      const [log, vs, mine, theirs] = await Promise.all([
        exec("git", ["log", `-n${n + 1}`, "--date-order", LOG_FMT, b.ref, "--"], o).catch(() => null),
        !isHead && r?.head ? exec("git", ["rev-list", "--left-right", "--count", `HEAD...${b.ref}`, "--"], o).catch(() => null) : null,
        cmp ? exec("git", ["log", `-n${CMP_N}`, LOG_FMT, `HEAD..${b.ref}`, "--"], o).catch(() => null) : null,
        cmp ? exec("git", ["log", `-n${CMP_N}`, LOG_FMT, `${b.ref}..HEAD`, "--"], o).catch(() => null) : null,
      ]);
      if (this.sel !== sel || this.ctx !== ctx) return;
      const [left, right] = vs?.code === 0 ? vs.stdout.trim().split(/\s+/).map(Number) : [null, null];
      this.info = {
        ref: sel,
        vsHead: left === null ? null : { behind: left, ahead: right },
        cmp: cmp ? { mine: parseLog(mine), theirs: parseLog(theirs) } : null,
      };
      if (!this.log?.loading || this.log.ref !== sel) {
        const raw = parseLog(log);
        // 실패하면 그 자리에 원인을 흐리게 보여 준다.
        const error = log?.code === 0 ? null : log ? (log.stderr || log.stdout || `종료 코드 ${log.code}`).trim().slice(0, 200) : "git을 실행하지 못했습니다";
        this.log = { ref: sel, raw: raw.slice(0, n), rows: graph(raw.slice(0, n)), more: raw.length > n, loading: false, error };
      }
      cx.notify();
    });
  }

  // 그래프 스크롤이 끝에 닿으면 다음 PAGE개를 더 읽는다. 레인은 처음부터 다시 계산한다(이어지는 선이 맞도록).
  loadMore(cx) {
    const lg = this.log, b = this.find(this.sel), ctx = this.ctx;
    if (!lg || !lg.more || lg.loading || !b || lg.ref !== b.ref || !ctx?.top) return;
    lg.loading = true;
    cx.spawn(async (cx) => {
      const res = await exec("git", ["log", `-n${PAGE + 1}`, `--skip=${lg.raw.length}`, "--date-order", LOG_FMT, b.ref, "--"], { cwd: ctx.top, on: ctx.on }).catch(() => null);
      lg.loading = false;
      if (this.log !== lg || this.ctx !== ctx) return;
      const got = parseLog(res), raw = [...lg.raw, ...got.slice(0, PAGE)];
      this.log = { ref: lg.ref, raw, rows: graph(raw), more: got.length > PAGE, loading: false };
      cx.notify();
    });
  }

  // 커밋 비교 켜기/끄기. 켜면 그래프 자리에 "이 브랜치에만 / 현재 브랜치에만 있는 커밋"을 보여 준다.
  showCompare(ref, on, cx) {
    if (ref !== this.sel) { this.sel = ref; this.info = null; this.log = null; }
    this.closed = false;
    this.cmpRef = on ? ref : null;
    this.loadDetail(cx);
    cx.notify();
  }

  // 앱 셸이 그릴 때마다 부른다: 스페이스가 바뀌었거나 다른 곳(메뉴·확인 창·파일 앱)이 git을 바꿨으면 다시 읽는다.
  sync(cx) {
    if (key() !== this.ctx?.key) this.reload(cx);
    if (shared(TICK) !== this.tick) { this.tick = shared(TICK); this.reload(cx); }
    // 메뉴의 "커밋 비교": 오버레이가 공유 값으로 알려 준다.
    const c = shared(CMP);
    if (c && c.at !== this.cmpAt) {
      this.cmpAt = c.at;
      if (c.top === this.ctx?.top && this.find(c.ref)) this.showCompare(c.ref, true, cx);
    }
  }

  // ── 셸 계약: 키보드·빈 상태 ──

  // ↑↓: 보이는 목록(접힌 섹션·검색에 걸러진 것은 빼고)에서 선택을 delta만큼 옮긴다.
  move(delta, cx) {
    const list = [...this.rowAt.keys()];
    if (!list.length) return;
    const i = list.indexOf(this.sel);
    const j = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + delta));
    if (list[j] !== this.sel || this.closed) this.select(list[j], cx);
    this.scroll.scroll_to_item(this.rowAt.get(list[j]) ?? 0);
    cx.notify();
  }

  // Enter: 고른 브랜치의 주 동작(체크아웃·푸시·끌어오기 등). 위험한 동작은 항목 쪽에서 확인 창을 띄운다.
  activate(cx) {
    const b = this.find(this.sel);
    if (!b || !this.ctx?.top) return;
    primaryOf(this.ctxFor(b))?.fn();
    cx.notify();
  }

  // 상세가 없을 때 셸이 보여 줄 문구.
  emptyState() {
    if (!this.ctx?.cwd) return { text: "폴더가 없습니다", sub: "스페이스나 패인을 고르면 그 폴더의 저장소를 보여 줍니다" };
    if (this.error === NOT_REPO) return { text: NOT_REPO, sub: this.ctx.cwd.replace(home(), "~") };
    if (this.error) return { text: "브랜치를 읽지 못했습니다", sub: this.error };
    if (!this.refs) return { text: "브랜치를 읽는 중" };
    return { text: "고른 브랜치가 없습니다", sub: "왼쪽에서 브랜치를 고르세요" };
  }

  // ── 툴팁(files.js와 같은 방식) ──
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

  // 250px 한 줄: 검색 | 가져오기·끌어오기·푸시 | 새 브랜치 … 더보기. 임시 저장·다시 읽기는 더보기 안에.
  toolbar(t) {
    const r = this.refs, ok = Boolean(r && this.ctx?.top), hc = ok ? this.headCtx() : null, h = r?.head;
    const btn = (id, icon, tip, on, fn) => div().id(`br-t-${id}`).p(4).rounded(4).flex_none()
      .on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((hv) => { if (!hv && this.tipFor === id) this.hideTip(); })
      .when(on, (el) => el.bg(t.selected))
      .when(Boolean(fn), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.hideTip(); fn(cx); cx.notify(); }))
      .child(svg(icon).size(16).text_color(fn ? TOOL[id] : t.dim));
    const sep = () => div().w(1).h(16).mx(4).flex_none().bg(t.border);
    // 끌어오기·푸시는 현재 브랜치 상태에 맞춰 동작을 고른다.
    const up = hc?.upstream && !hc.gone, ahead = hc?.ahead ?? 0, behind = hc?.behind ?? 0;
    const pullTip = !h ? "끌어오기 (현재 브랜치 없음)" : !up ? `끌어오기 (${h} · 추적하는 원격 없음)`
      : ahead && behind ? `끌어와서 리베이스 (${h} · ${counts(ahead, behind)})` : behind ? `끌어오기 (${h} · ${behind}개 뒤처짐)` : `끌어오기 (${h} · 최신)`;
    const pullFn = h && up && (() => (ahead && behind ? ACT.pullRebase(hc) : ACT.pull(hc)));
    const pushTip = !h ? "푸시 (현재 브랜치 없음)" : !up ? `원격에 올리기 (${h} · git push -u origin)`
      : ahead && behind ? `푸시 불가 (${h} · 먼저 끌어오세요)` : ahead ? `푸시 (${h} · ${ahead}개 앞섬)` : `푸시 (${h} · 올릴 것 없음)`;
    const pushFn = h && !(up && ahead && behind) && (() => (up ? ACT.push(hc) : ACT.publish(hc)));
    const base = this.find(this.sel) ?? (h ? r.local.find((x) => x.name === h) : null);
    return v_flex().flex_none()
      .child(h_flex().h(32).px(6).gap(2).items_center().border_b_1().border_color(t.border)
        .child(btn("search", I(this.searching ? "close" : "search"), this.searching ? "검색 중 · 누르면 닫기" : "브랜치 검색", this.searching, () => this.toggleSearch()))
        .child(sep())
        .child(btn("fetch", B("fetch"), "가져오기 (git fetch --all --prune)", false, ok && (() => ACT.fetch(hc))))
        .child(btn("pull", B("pull"), pullTip, false, pullFn))
        .child(btn("push", B("push"), pushTip, false, pushFn))
        .child(sep())
        .child(btn("new", B("branch-new"), base ? `새 브랜치 (${base.name}에서)` : "새 브랜치", false, ok && base && (() => {
          const c = this.ctxFor(base);
          ask(c, "newBranch", `${q(c.name)}에서 새 브랜치`, "만들고 바로 옮깁니다 (git switch -c)");
        })))
        .child(div().flex_1())
        .child(btn("more", B("more"), "더보기", false, ok && (() => { this.hideTip(); openMenu({ ...hc, kind: "more" }, 300); }))))
      .when(this.searching, (el) => el.child(h_flex().h(34).px(8).gap(6).items_center().border_b_1().border_color(t.border)
        .child(svg(I("search")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.searchInput).h(26).text_size(12).text_color(t.foreground)))));
  }

  toggleSearch() {
    this.searching = !this.searching;
    if (!this.searching) { this.query = ""; this.searchInput.set_value(""); }
    else this.searchInput.focus();
  }

  section(id, label, n, t) {
    const open = this.open[id] || Boolean(this.query);
    return h_flex().id(`br-sec-${id}`).h(26).mt(4).px(4).gap(4).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.open = { ...this.open, [id]: !this.open[id] };
        try { localStorage.setItem("branch.open", JSON.stringify(this.open)); } catch { /* 이번 실행 동안만 */ }
        cx.notify();
      })
      .child(svg(I(open ? "chevron-down" : "chevron-right")).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().text_size(12).font_semibold().text_color(t.muted).child(label))
      .child(div().text_size(11).text_color(t.dim).child(String(n)));
  }

  // 오른쪽 끝 작은 글자: 원격 대비 ↑앞섬 ↓뒤처짐, 원격 없음
  trackText(b, t) {
    if (b.kind !== "local") return null;
    if (b.gone) return div().flex_none().text_size(11).text_color(t.dim).child("원격 없음");
    const s = [b.ahead && `↑${b.ahead}`, b.behind && `↓${b.behind}`].filter(Boolean).join(" ");
    return s ? div().flex_none().text_size(11).text_color(t.muted).child(s) : null;
  }

  row(b, label, t) {
    const head = b.kind === "local" && b.name === this.refs.head, track = this.trackText(b, t);
    return h_flex().id(`br-row-${b.ref}`).h(24).flex_none().pl(8).pr(8).gap(6).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(this.sel === b.ref, (el) => el.bg(t.selected))
      .on_click((_e, cx) => this.select(b.ref, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.hideTip(); openMenu(this.ctxFor(b)); })
      .child(svg(b.kind === "tag" ? B("tag") : I("branch")).size(14).flex_none().text_color(head ? t.accent : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(head, (el) => el.font_semibold()).child(label))
      .when(Boolean(track), (el) => el.child(track));
  }

  // 목록 자식들. 브랜치 줄을 넣을 때 rowAt에 "보이는 순서·자식 번호"를 적어 둔다(move가 쓴다).
  rows(t) {
    const r = this.refs, f = this.query, out = [], at = new Map();
    const keep = (b) => !f || b.name.toLowerCase().includes(f);
    const local = r.local.filter(keep), remote = r.remote.filter(keep), tags = r.tags.filter(keep);
    const open = (id) => this.open[id] || Boolean(f);
    const add = (b, label) => { at.set(b.ref, out.length); out.push(this.row(b, label, t)); };
    if (!r.head && r.detached) out.push(div().px(8).pt(6).text_size(12).text_color(t.muted).child(`분리된 HEAD · ${r.detached}`));
    out.push(this.section("local", "로컬", local.length, t));
    if (open("local")) for (const b of local) add(b, b.name);
    // 원격·태그는 하나도 없으면 머리줄도 숨긴다.
    if (remote.length) {
      out.push(this.section("remote", "원격", remote.length, t));
      if (open("remote")) {
        // 원격이 여럿이면 원격 이름 아래에, 하나면 이름만.
        const names = [...new Set(remote.map((b) => b.remote))];
        for (const name of names) {
          if (names.length > 1) out.push(div().px(8).pt(4).pb(2).text_size(11).text_color(t.dim).child(name));
          for (const b of remote.filter((x) => x.remote === name)) add(b, names.length > 1 ? b.short : b.name);
        }
      }
    }
    if (tags.length) {
      out.push(this.section("tags", "태그", tags.length, t));
      if (open("tags")) for (const b of tags.slice(0, 300)) add(b, b.name);
    }
    if (f && !local.length && !remote.length && !tags.length) out.push(div().p(8).text_size(12).text_color(t.dim).child("맞는 브랜치가 없습니다"));
    this.rowAt = at;
    return out;
  }

  list(cx, t) {
    this.sync(cx);
    const r = this.refs;
    if (!r) this.rowAt = new Map();
    return v_flex().flex_1().min_h(0)
      .child(this.toolbar(t))
      .child(v_flex().id("br-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(4)
        .when(Boolean(r), (el) => el.children(this.rows(t)))
        .when(!r, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.emptyState().text))));
  }

  // 타이틀 옆 부제: 저장소 경로(누르면 Finder)
  subtitle(t) {
    const top = this.ctx?.top, where = top ? top.replace(home(), "~") : "";
    return div().id("br-path").truncate().text_size(12).text_color(t.dim)
      .when(Boolean(top) && !this.ctx?.on, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", [top])))
      .child(where);
  }

  // ── 오른쪽 ──

  // 그래프 칸: 레인마다 세로선, 이 커밋의 레인에 점. flat이면(비교 목록처럼 줄이 끊긴 목록) 점만.
  lanes(c, t, flat) {
    const w = (flat ? 1 : c.width) * LANE + 6;
    const lines = [];
    if (!flat) for (let i = 0; i < c.width; i++) {
      const color = LANES[i % LANES.length], x = 6 + i * LANE + LANE / 2 - 1;
      if (c.before[i]) lines.push(div().absolute().left(x).top(0).w(2).h(GROW / 2).bg(color));
      if (c.after[i]) lines.push(div().absolute().left(x).top(GROW / 2).w(2).h(GROW / 2).bg(color));
    }
    const x = 6 + (flat ? 0 : c.lane) * LANE + LANE / 2 - 5, color = LANES[(flat ? 0 : c.lane) % LANES.length];
    const merge = c.parents.length > 1;
    lines.push(div().absolute().left(x).top(GROW / 2 - 5).size(10).rounded_full()
      .bg(merge ? t.background : color).border_2().border_color(color));
    return div().relative().w(w).h(GROW).flex_none().children(lines);
  }

  // 커밋 한 줄: 레인 + 제목 + 짧은 시각. 누르면 커밋 앱에서 연다.
  // 가상 목록(그래프) 안에서는 on_click을 걸면 렌더러가 예외를 던져 목록이 통째로 비므로, click=false로 부르고
  // 목록의 on_item_click이 대신 받는다.
  commitRow(c, t, flat, mark, click = true) {
    return h_flex().id(`br-c-${mark}-${c.hash}`).w_full().h(GROW).pl(8).pr(14).gap(8).items_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(click, (el) => el.on_click(() => run(`office-apps.commit:${c.hash}`)))
      .child(this.lanes(c, t, flat))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(c.subject))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(ago(c.at)));
  }

  // 비교 목록: 이 브랜치에만 / 현재 브랜치에만 있는 커밋.
  compareView(b, info, t, cx) {
    const r = this.refs, v = info?.vsHead, cmp = info?.cmp;
    const heading = (text) => div().px(14).pt(10).pb(4).text_size(12).font_semibold().text_color(t.muted).child(text);
    const part = (label, n, list, mark) => [
      heading(`${label} · ${n ?? list.length}개`),
      ...list.map((c) => this.commitRow(c, t, true, mark)),
      ...(n > list.length ? [div().px(14).py(4).text_size(12).text_color(t.dim).child(`외 ${n - list.length}개`)] : []),
    ];
    const body = !cmp ? [div().px(14).py(10).text_size(12).text_color(t.dim).child("읽는 중")]
      : !cmp.mine.length && !cmp.theirs.length ? [div().px(14).py(10).text_size(12).text_color(t.dim).child(`${r.head}와 같습니다`)]
      : [...(cmp.mine.length ? part(`${b.name}에만 있는 커밋`, v?.ahead, cmp.mine, "mine") : []),
        ...(cmp.theirs.length ? part(`${r.head}에만 있는 커밋`, v?.behind, cmp.theirs, "theirs") : [])];
    return v_flex().id("br-cmp").flex_1().min_h(0).overflow_y_scrollbar().pb(10).children(body);
  }

  graphView(b, t) {
    const lg = this.log?.ref === b.ref ? this.log : null, rows = lg?.rows ?? [];
    const note = (text) => div().px(14).py(10).text_size(12).text_color(t.dim).child(text);
    if (lg?.error) return note(`커밋을 읽지 못했습니다 · ${lg.error}`);
    if (!rows.length) return note(lg ? "커밋이 없습니다" : "커밋을 읽는 중");
    // 렌더러는 레이아웃 중에 불려 핸들러·상태 변경·notify가 막혀 있다. 끝 가까이 보였다는 표시만 남기고,
    // 실제 더 읽기는 다음 스크롤(이벤트 핸들러)에서 한다.
    return div().flex_1().min_h(0).relative()
      .on_scroll_wheel((_e, cx) => { if (this.nearEnd) this.loadMore(cx); })
      .child(v_virtual_list("br-graph", rows.length, GROW, (i) => rows[i].hash, (range) => {
        this.nearEnd = range.end >= rows.length - 10;
        return rows.slice(range.start, range.end).map((c) => this.commitRow(c, t, false, "g", false));
      }).size_full().on_item_click((hash) => run(`office-apps.commit:${hash}`)))
      .child(Scrollbar.vertical("br-graph").viewport_from_layout().absolute().inset_0());
  }

  // 상세 = 머리줄(이름·종류·✕) + 추적 상태 한 줄 + 주 동작·⋯ + 커밋 그래프(또는 커밋 비교).
  detail(cx, t) {
    const b = this.find(this.sel);
    if (!b) return null;
    const r = this.refs, c = this.ctxFor(b), info = this.info?.ref === b.ref ? this.info : null;
    const head = b.kind === "local" && b.name === r.head;
    const kindText = head ? "현재 브랜치" : b.kind === "local" ? "로컬 브랜치" : b.kind === "remote" ? "원격 브랜치" : "태그";
    const comparing = this.cmpRef === b.ref && !head && Boolean(r.head);

    // 상태 한 줄: 원격 추적 · 현재 브랜치 대비(누르면 커밋 비교) · 워크트리 · 작업 트리.
    const bits = [];
    const text = (s, color) => div().flex_none().text_color(color ?? t.muted).child(s);
    if (b.kind === "local") {
      bits.push(text(!b.upstream ? "추적하는 원격 없음" : b.gone ? `${b.upstream.short} · 원격에서 지워짐`
        : `${b.upstream.short} · ${counts(b.ahead, b.behind) || "같음"}`));
    }
    if (b.kind === "remote" && c.localOf) bits.push(text(`${c.localOf}가 추적 중`));
    if (!head && r.head && info?.vsHead) {
      const v = info.vsHead, s = counts(v.ahead, v.behind) || "같음";
      bits.push(div().id("br-vs").flex_none().text_color(comparing ? t.foreground : t.muted).cursor_pointer().underline()
        .hover((st) => st.text_color(t.foreground))
        .on_click((_e, cx) => this.showCompare(b.ref, !comparing, cx))
        .child(`${r.head} 대비 ${c.merged && !v.ahead ? `${s} · 병합됨` : s}`));
    }
    if (c.worktree) bits.push(text(`워크트리 ${c.worktree.replace(home(), "~")}`, t.dim));
    if (head && r.dirty) bits.push(text("커밋하지 않은 변경 있음", t.dim));
    const line = [];
    bits.forEach((x, i) => { if (i) line.push(div().flex_none().text_color(t.dim).child("·")); line.push(x); });

    // 주 동작 하나 + ⋯(우클릭 메뉴와 같은 메뉴를 그 자리에).
    const p = primaryOf(c);
    const button = (id, child, fn) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(6).border_1().border_color(t.border)
      .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { fn(); cx.notify(); }).children(child);
    const actions = h_flex().gap(6).items_center()
      .when(Boolean(p), (el) => el.child(button("br-primary", [svg(p.icon).size(13).flex_none().text_color(t.muted), div().child(p.label)], () => p.fn())))
      .child(button("br-more", [svg(B("more")).size(13).flex_none().text_color(t.muted)], () => { this.hideTip(); openMenu(c); }));

    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(svg(b.kind === "tag" ? B("tag") : I("branch")).size(16).flex_none().text_color(head ? t.accent : t.muted))
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(b.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(kindText))
        .child(div().id("br-close").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.closed = true; this.sel = null; this.info = null; this.log = null; this.cmpRef = null; cx.notify(); }).child("✕")))
      .child(v_flex().flex_none().px(14).py(10).gap(10).border_b_1().border_color(t.border)
        .when(line.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).items_center().text_size(12).children(line)))
        .child(actions))
      .child(comparing ? this.compareView(b, info, t, cx) : this.graphView(b, t));
  }
}

// 확인 창(menu.js Confirm)과 오버레이 역할 표(files.js ROLES)에 이 앱의 것을 더한다. 키는 모두 branch로 시작한다.
function register() {
  for (const [k, f] of Object.entries(ACT)) ACTIONS[`branch.${k}`] = f;
  ROLES["branch-menu"] = BranchMenu;
  ROLES["branch-prompt"] = BranchPrompt;
}
register();

