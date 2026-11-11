// office 브랜치·커밋 칸. 지금 고른 스페이스의 레포를 보여 준다.
//   브랜치 화면: HEAD, 로컬(이름의 "/"로 폴더), 원격(리모트별), 태그. 원격 기본 브랜치에 별.
//   커밋 화면: 브랜치를 누르면 그 브랜치의 커밋 그래프. 검색(제목·해시·작성자), ←로 돌아감.
// git을 읽기만 한다. 체크아웃·삭제 같은 쓰기 동작은 없다.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, props, openOverlay, closeOverlay, shared, setShared, home } from "herdr";
import { Menu, Prompt, Confirm, ACTIONS, menuHeight, popupAt } from "./actions.js";

const TICK = "office-git.tick", FAV = "office-git.favorites";
// 툴바 아이콘 색: 기능마다 하나. 쓸 수 없는 버튼은 흐리게.
const TOOL = { fav: "#e8b92e", fetch: "#7aa2f7", pull: "#a7c080", push: "#e69875", new: "#83c092", rename: "#d699b6", collapse: "#9da9a0", refresh: "#7fbbb3", search: "#a7c080", stash: "#dbbc7f", unstash: "#dbbc7f", log: "#7aa2f7",
  more: "#9da9a0", stashes: "#dbbc7f", prune: "#e67e80", status: "#9da9a0", web: "#7fbbb3", pr: "#a7c080", tag: "#dbbc7f", lazygit: "#83c092" };

const ME = "mods/office-git";
const LIMIT = 400;
const ROW = 26, LANE = 14;
const LANES = ["#7aa2f7", "#a7c080", "#e69875", "#d699b6", "#83c092", "#dbbc7f", "#7fbbb3", "#e67e80"];
const ICON = (n) => `${ME}/${n}.svg`;

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null };
}

// "어제 오후 3:06", "오늘 오전 9:01", "26. 11. 9. 오후 1:02"
function when(sec) {
  const d = new Date(sec * 1000), now = new Date();
  const h = d.getHours(), ampm = h < 12 ? "오전" : "오후", hh = h % 12 || 12, mm = String(d.getMinutes()).padStart(2, "0");
  const time = `${ampm} ${hh}:${mm}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `오늘 ${time}`;
  if (diff === 1) return `어제 ${time}`;
  return `${String(d.getFullYear()).slice(2)}. ${d.getMonth() + 1}. ${d.getDate()}. ${time}`;
}

// 커밋마다 레인을 정한다. lanes[i]는 i번째 줄이 다음에 만날 커밋 해시.
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

class Panel {
  init(_p, cx) {
    this.tick = shared(TICK); this.lastShow = shared("office-git.show");
    this.onlyFav = false;
    this.searching = false; this.branchFilter = "";
    this.branchInput = InputState.new({ placeholder: "브랜치 이름" });
    this.branchInput.on("change", (_e, cx) => { this.branchFilter = this.branchInput.value().trim().toLowerCase(); cx.notify(); });
    this.ctx = null; // { key, cwd, on, top }
    this.refs = null; // { head, local, remote, tags, defaults }
    this.open = new Set(["local", "remote"]); // 펼친 그룹·폴더
    this.view = null; // 커밋 화면에서 보는 ref ({ name, ref })
    this.commits = []; this.loading = false; this.error = null;
    this.filter = "";
    this.input = InputState.new({ placeholder: "텍스트 또는 해시" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.reload(cx);
    cx.timer.every(15000, (cx) => this.reload(cx));
  }

  key() { const l = location(); return JSON.stringify([l.on, l.cwd]); }

  reload(cx) {
    const { cwd, on } = location(), key = this.key();
    if (key !== this.ctx?.key) { this.ctx = { key, cwd, on, top: null }; this.refs = null; this.view = null; this.commits = []; this.watching = null; }
    if (!cwd || this.loading) return;
    const ctx = this.ctx;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) { this.error = "git 레포가 아닙니다"; this.refs = null; return; }
        ctx.top = top.stdout.trim();
        await this.loadRefs(ctx);
        if (!this.tools) {
          const w = await exec("sh", ["-lc", "for c in gh lazygit; do command -v $c >/dev/null 2>&1 && echo $c; done"]).catch(() => null);
          this.tools = new Set((w?.stdout ?? "").split("\n").filter(Boolean));
        }
        if (this.view) await this.loadLog(ctx);
        this.error = null;
        this.watch(ctx, cx);
      } catch (e) {
        if (this.ctx === ctx) this.error = String(e?.message || e);
      } finally {
        if (this.ctx === ctx) this.loading = false;
        cx.notify();
      }
    });
  }

  // HEAD나 ref가 바뀌면(커밋, 체크아웃, fetch) 다시 읽는다.
  watch(ctx, cx) {
    if (ctx.on || this.watching === ctx) return;
    this.watching = ctx;
    cx.spawn(async (cx) => {
      const git = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: ctx.top }).catch(() => null);
      if (git?.code !== 0) return;
      try {
        while (this.ctx === ctx) {
          await watchFolder(git.stdout.trim());
          if (this.ctx === ctx) this.reload(cx);
        }
      } catch { /* 다음 주기 타이머가 대신한다 */ }
    });
  }

  async loadRefs(ctx) {
    const fmt = "%(refname)%00%(objectname:short)%00%(HEAD)%00%(symref)%00%(upstream:remotename)%00%(upstream:lstrip=3)%00%(upstream:track,nobracket)";
    const r = await exec("git", ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes", "refs/tags"], { cwd: ctx.top, on: ctx.on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "브랜치를 읽지 못했습니다");
    const refs = { head: null, local: [], remote: {}, tags: [], defaults: new Set() };
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const [ref, hash, star, symref, upRemote, upBranch, track] = line.split("\0");
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice(11);
        refs.local.push({ name, ref, hash, track, upstream: upRemote && upBranch ? { remote: upRemote, branch: upBranch } : null });
        if (star === "*") refs.head = name;
      } else if (ref.startsWith("refs/remotes/")) {
        const rest = ref.slice(13), slash = rest.indexOf("/"), remote = rest.slice(0, slash), name = rest.slice(slash + 1);
        if (name === "HEAD") { if (symref) refs.defaults.add(symref.replace("refs/remotes/", "")); continue; }
        (refs.remote[remote] ??= []).push({ name, ref, hash, full: rest });
      } else if (ref.startsWith("refs/tags/")) {
        refs.tags.push({ name: ref.slice(10), ref, hash });
      }
    }
    refs.tags.reverse();
    // 브랜치 → 체크아웃된 워크트리 폴더 ("워크트리 열기"에 쓴다).
    refs.worktrees = {};
    const wt = await exec("git", ["worktree", "list", "--porcelain"], { cwd: ctx.top, on: ctx.on }).catch(() => null);
    let path = null;
    for (const line of (wt?.stdout ?? "").split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch refs/heads/") && path) refs.worktrees[line.slice(18)] = path;
    }
    // 메뉴를 상황별로 만들 정보: 현재 브랜치에 병합된 브랜치, 작업 트리 변경 여부, 원격 → 로컬 추적 관계.
    const [merged, dirty] = await Promise.all([
      exec("git", ["branch", "--merged", "HEAD", "--format=%(refname:short)"], { cwd: ctx.top, on: ctx.on }).catch(() => null),
      exec("git", ["--no-optional-locks", "status", "--porcelain", "-uno"], { cwd: ctx.top, on: ctx.on }).catch(() => null),
    ]);
    refs.merged = new Set((merged?.stdout ?? "").split("\n").filter(Boolean));
    refs.dirty = Boolean((dirty?.stdout ?? "").trim());
    refs.tracking = {};
    for (const b of refs.local) if (b.upstream) refs.tracking[`${b.upstream.remote}/${b.upstream.branch}`] = b.name;
    refs.default = [...refs.defaults][0]?.split("/").slice(1).join("/") || (refs.local.some((b) => b.name === "main") ? "main" : refs.local.some((b) => b.name === "master") ? "master" : null);
    if (this.ctx === ctx) this.refs = refs;
  }

  async loadLog(ctx) {
    const v = this.view;
    const r = await exec("git", ["log", v.ref, `-n${LIMIT}`, "--date-order", "--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s"], { cwd: ctx.top, on: ctx.on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "커밋을 읽지 못했습니다");
    const commits = r.stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, parents, author, at, deco, subject] = line.split("\0");
      return { hash, parents: parents ? parents.split(" ") : [], author, at: Number(at), deco, subject };
    });
    if (this.ctx === ctx && this.view === v) this.commits = graph(commits);
  }

  showLog(name, ref, cx) {
    this.view = { name, ref };
    this.commits = [];
    const ctx = this.ctx;
    cx.spawn(async (cx) => {
      try { await this.loadLog(ctx); this.error = null; } catch (e) { this.error = String(e?.message || e); }
      cx.notify();
    });
    cx.notify();
  }

  render(cx) {
    if (this.key() !== this.ctx?.key) this.reload(cx);
    // 메뉴·툴바가 git을 바꾸면 TICK이 바뀐다: 다시 읽는다.
    if (shared(TICK) !== this.tick) { this.tick = shared(TICK); this.reload(cx); }
    // 메뉴의 "커밋 로그 보기": 오버레이가 공유 상태로 알려 준다.
    const show = shared("office-git.show");
    if (show !== this.lastShow) { this.lastShow = show; if (show && show.top === this.ctx?.top && Date.now() - show.at < 5000) this.showLog(show.name, show.ref, cx); }
    const t = theme();
    return v_flex().id("office-git").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(this.view ? this.logView(t) : this.branchView(t));
  }

  // ── 브랜치 화면 ─────────────────────────────────────────────

  branchView(t) {
    const r = this.refs, rows = [];
    if (r) {
      rows.push(this.item("head", 0, `HEAD(현재 브랜치)${r.head ? `: ${r.head}` : ""}`, null, t, (cx) => r.head && this.showLog(r.head, `refs/heads/${r.head}`, cx)));
      rows.push(this.group("local", "로컬", t));
      const fav = this.favorites();
      const q = this.branchFilter;
      const keep = (b) => (!this.onlyFav || fav.has(b.full ?? b.name) || b.name === r.head) && (!q || (b.full ?? b.name).toLowerCase().includes(q));
      if (this.open.has("local")) this.tree(r.local.filter(keep), "local", 1, rows, t, (b) => ({
        icon: b.name === r.head ? "tag" : fav.has(b.name) ? "star-fill" : "branch", accent: b.name === r.head, fav: fav.has(b.name),
        menu: this.menuCtx("local", b.name, b.ref, { upstream: b.upstream, worktree: r.worktrees?.[b.name] }), track: b.track,
      }));
      rows.push(this.group("remote", "원격", t));
      if (this.open.has("remote")) for (const [remote, list] of Object.entries(r.remote)) {
        rows.push(this.folder(`remote/${remote}`, remote, 1, t));
        if (this.open.has(`remote/${remote}`) || this.allOpen || q) this.tree(list.filter(keep), `remote/${remote}`, 2, rows, t, (b) => ({
          icon: fav.has(b.full) ? "star-fill" : r.defaults.has(b.full) ? "star" : "branch", label: b.name, star: r.defaults.has(b.full), fav: fav.has(b.full),
          menu: this.menuCtx("remote", b.full, b.ref),
        }));
      }
      rows.push(this.group("tags", "태그", t));
      if (this.open.has("tags")) for (const tag of r.tags.filter((x) => !q || x.name.toLowerCase().includes(q))) rows.push(this.item(`tag-${tag.name}`, 1, tag.name, "tag", t, (cx) => this.showLog(tag.name, tag.ref, cx), { menu: this.menuCtx("tag", tag.name, tag.ref) }));
    }
    return v_flex().flex_1().min_h(0)
      .child(this.header(t, div().font_semibold().child("브랜치"), this.ctx?.top?.split("/").pop() ?? ""))
      .when(Boolean(r), (el) => el.child(this.toolbar(t, r)))
      .child(v_flex().id("git-branches").flex_1().min_h(0).overflow_y_scrollbar().p(4).children(rows)
        .when(!r, (el) => el.child(div().p(10).text_color(t.dim).child(this.error || (this.loading ? "브랜치를 읽는 중" : "레포를 고르세요")))));
  }

  header(t, left, right) {
    return h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b_1().border_color(t.border)
      .child(left).child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(right));
  }

  chevron(open, t) {
    return svg(ICON(open ? "chevron-down" : "chevron-right")).size(14).flex_none().text_color(t.foreground);
  }

  group(id, label, t) {
    const open = this.open.has(id);
    return h_flex().id(`git-group-${id}`).h(26).px(4).gap(4).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
      .child(this.chevron(open, t)).child(div().text_color(t.foreground).child(label));
  }

  folder(id, label, depth, t) {
    const open = this.open.has(id) || this.allOpen || Boolean(this.branchFilter);
    return h_flex().id(`git-folder-${id}`).h(26).pl(4 + depth * 16).gap(5).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
      .child(this.chevron(open, t)).child(svg(ICON("folder")).size(14).flex_none().text_color(t.muted)).child(div().child(label));
  }

  toggle(id) {
    if (this.allOpen) { this.allOpen = false; this.open = new Set([...this.open, ...this.folderIds()]); }
    this.open.has(id) ? this.open.delete(id) : this.open.add(id);
  }

  // 모두 펼친 상태에서 하나를 접을 때, 나머지는 펼친 채로 남기려고 모든 폴더 id를 모은다.
  folderIds() {
    const r = this.refs, ids = [];
    const walk = (list, base) => {
      const seen = new Set();
      for (const b of list) {
        const n = b.label ?? b.name, i = n.indexOf("/");
        if (i === -1) continue;
        const f = n.slice(0, i), id = `${base}/${f}`;
        if (!seen.has(f)) { seen.add(f); ids.push(id); }
        walk([{ ...b, label: n.slice(i + 1) }], id);
      }
    };
    if (!r) return ids;
    walk(r.local, "local");
    for (const [remote, list] of Object.entries(r.remote)) { ids.push(`remote/${remote}`); walk(list.map((b) => ({ ...b, label: b.name })), `remote/${remote}`); }
    return ids;
  }

  openMore(ctx) {
    const c = { ...ctx, kind: "more", gh: this.tools?.has("gh"), lazygit: this.tools?.has("lazygit") };
    const h = menuHeight(c);
    openOverlay({ mod: "office-git", kind: "popup", at: popupAt(300, h), width: 300, height: h, props: { role: "menu", ctx: c } });
  }

  // "feat/x", "feat/y" → feat 폴더 아래에. 폴더는 위, 브랜치는 아래.
  tree(list, base, depth, rows, t, look) {
    const folders = new Map(), leaves = [];
    for (const b of list) {
      const name = b.label ?? b.name, slash = name.indexOf("/");
      if (slash === -1) leaves.push({ ...b, label: name });
      else { const f = name.slice(0, slash); (folders.get(f) ?? folders.set(f, []).get(f)).push({ ...b, label: name.slice(slash + 1) }); }
    }
    for (const [f, items] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const id = `${base}/${f}`;
      rows.push(this.folder(id, f, depth, t));
      if (this.open.has(id) || this.branchFilter || this.allOpen) this.tree(items, id, depth + 1, rows, t, look);
    }
    for (const b of leaves.sort((a, b) => a.label.localeCompare(b.label))) {
      const l = look(b);
      rows.push(this.item(`${base}/${b.label}`, depth, b.label, l.icon, t, (cx) => this.showLog(b.full ?? b.name, b.ref, cx), l));
    }
  }

  favorites() {
    return new Set((shared(FAV) ?? {})[this.ctx?.top] ?? []);
  }

  // 메뉴와 동작이 쓰는 정보. 오버레이로 넘어가므로 값만 담는다.
  menuCtx(kind, name, ref, extra = {}) {
    const r = this.refs;
    const local = kind === "local" ? r?.local.find((b) => b.name === name) : null;
    return { kind, name, ref, head: r?.head ?? "HEAD", top: this.ctx.top, on: this.ctx.on, home: home(),
      fav: this.favorites().has(name), upstream: null, worktree: null,
      track: local?.track ?? "", merged: kind === "local" && Boolean(r?.merged?.has(name)), dirty: Boolean(r?.dirty),
      isDefault: kind === "local" ? name === r?.default : kind === "remote" ? Boolean(r?.defaults?.has(name)) : false,
      localOf: kind === "remote" ? r?.tracking?.[name] ?? null : null, ...extra };
  }

  openMenu(ctx) {
    this.hideTip(); const h = menuHeight(ctx); openOverlay({ mod: "office-git", kind: "popup", at: popupAt(330, h), width: 330, height: h, props: { role: "menu", ctx } });
  }

  // 브랜치 목록 위 아이콘 막대. 현재 브랜치(HEAD) 기준으로 동작한다.
  toolbar(t, r) {
    const head = r.local.find((b) => b.name === r.head);
    const ctx = head ? this.menuCtx("local", head.name, head.ref, { upstream: head.upstream }) : null;
    const btn = (id, icon, tip, on, fn, badge) => h_flex().id(`gt-${id}`).p(4).gap(3).items_center().rounded(4).flex_none()
      .on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); })
      .when(on, (el) => el.bg(t.selected))
      .when(Boolean(fn), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.hideTip(); fn(cx); cx.notify(); }))
      .child(svg(ICON(icon)).size(16).text_color(fn ? TOOL[id] ?? t.foreground : t.dim))
      .when(Boolean(badge), (el) => el.child(div().text_size(11).font_semibold().text_color(fn ? TOOL[id] ?? t.foreground : t.dim).child(badge)));
    const sep = () => div().w(1).h(16).mx(4).flex_none().bg(t.border);
    const ask = (action, title, hint, value) => openOverlay({ mod: "office-git", kind: "dialog", width: 420, height: 210,
      props: { role: "prompt", ctx, action, title, hint, value } });
    const h = r.head ?? "";
    const tr = head?.track ?? "", gone = tr === "gone";
    const ahead = Number(/ahead (\d+)/.exec(tr)?.[1] ?? 0), behind = Number(/behind (\d+)/.exec(tr)?.[1] ?? 0);
    return v_flex().flex_none()
      .child(h_flex().h(32).px(6).gap(2).items_center().border_b_1().border_color(t.border)
        // 켜고 끄는 버튼은 한 자리에서 아이콘으로 상태를 보여 준다.
        .child(btn("fav", this.onlyFav ? "star-fill" : "star", this.onlyFav ? "즐겨찾기만 보는 중 · 누르면 전체" : "즐겨찾기 브랜치만 보기", this.onlyFav, () => { this.onlyFav = !this.onlyFav; }))
        .child(btn("search", this.searching ? "close" : "search", this.searching ? "검색 중 · 누르면 닫기" : "브랜치 검색", this.searching, () => this.toggleSearch()))
        .child(sep())
        .child(btn("fetch", "fetch", "가져오기 (git fetch --all --prune)", false, ctx && (() => ACTIONS.fetch(ctx))))
        // 끌어오기·푸시는 현재 브랜치 상태에 맞춰 동작과 개수를 바꾼다.
        .when(Boolean(ctx?.upstream) && !gone, (el) => el.child(btn("pull", "pull",
          ahead && behind ? `끌어와서 리베이스 (${h} · ↑${ahead} ↓${behind} 갈라짐)` : behind ? `끌어오기 (${h} · ${behind}개 뒤처짐)` : `끌어오기 (${h} · 최신)`,
          false, () => (ahead && behind ? ACTIONS.pullRebase(ctx) : ACTIONS.update(ctx)), behind ? `${behind}` : null)))
        .child(btn("push", "push",
          !ctx?.upstream || gone ? `원격에 올리기 (${h} · git push -u origin)` : ahead && behind ? `푸시 불가 (${h} · 먼저 끌어오세요)` : ahead ? `푸시 (${h} · ${ahead}개 앞섬)` : `푸시 (${h} · 올릴 것 없음)`,
          false, ctx && !(ahead && behind) && (() => (!ctx.upstream || gone ? ACTIONS.publish(ctx) : ACTIONS.push(ctx))), ahead && !behind ? `${ahead}` : null))
        .child(sep())
        .child(btn("new", "branch-new", `새 브랜치 (${h}에서)`, false, ctx && (() => ask("newBranch", `'${h}'에서 새 브랜치`, "새 브랜치 이름", ""))))
        .child(btn("stash", "stash", r.dirty ? "변경 사항 임시 저장 (git stash push -u)" : "임시 저장 (저장할 변경 없음)", false, ctx && r.dirty && (() => ACTIONS.stash(ctx))))
        .child(btn("stashes", "stash-list", "임시 저장 목록 · 골라서 꺼내기", false, ctx && (() => ACTIONS.stashMenu(ctx))))
        .child(sep())
        .child(btn("log", "log", `커밋 로그 (${h})`, false, head && ((cx) => this.showLog(h, head.ref, cx))))
        .when(Boolean(this.tools?.has("gh")), (el) => el.child(btn("pr", "pr", `풀 리퀘스트 만들기 (${h} · gh pr create --web)`, false, ctx && (() => ACTIONS.pr(ctx)))))
        // 덜 쓰는 것은 더보기로: 이름 변경, 태그, 상태, 병합된 브랜치 정리, 웹, lazygit
        .child(btn("more", "more", "더보기", false, ctx && (() => this.openMore(ctx))))
        .child(div().flex_1())
        // 펼치기/접기도 한 자리.
        .child(this.open.size
          ? btn("collapse", "collapse", "모두 접기", false, () => { this.open = new Set(); this.allOpen = false; })
          : btn("collapse", "expand", "모두 펼치기", false, () => { this.open = new Set(["local", "remote", "tags"]); this.allOpen = true; }))
        .child(btn("refresh", "refresh", "다시 읽기", false, (cx) => this.reload(cx))))
      .when(this.searching, (el) => el.child(h_flex().h(34).px(8).gap(6).items_center().border_b_1().border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(svg(ICON("search")).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).child(Input.new(this.branchInput).h(26).text_size(12).text_color(t.foreground)))));
  }

  toggleSearch() {
    this.searching = !this.searching;
    if (!this.searching) { this.branchFilter = ""; this.branchInput.set_value?.(""); }
    else this.branchInput.focus();
  }

  // 툴팁: 기본 툴팁은 커서 오른쪽 아래에 떠서 커서를 가린다. 칸 밖까지 그릴 수 있는 창 오버레이로
  // 아이콘 바로 위, 아이콘 가운데에 띄운다.
  showTip(id, text, b) {
    this.hideTip();
    if (!b) return;
    // 말풍선 너비를 글자로 어림한다(D2Coding @12px: 반각 7px, 전각 12px).
    const w = Math.round([...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 12 : 7), 0) + 20);
    this.tipFor = id;
    this.tipId = openOverlay({ mod: "office-git", kind: "window", key: "office-git-tip", frame: "none", width: w, height: 26,
      at: { x: Math.max(4, Math.round(b.x + b.width / 2 - w / 2)), y: Math.max(4, Math.round(b.y - 30)) },
      props: { role: "tip", text } });
  }

  hideTip() {
    if (this.tipId) closeOverlay(this.tipId);
    this.tipId = null; this.tipFor = null;
  }

  item(id, depth, label, icon, t, onPick, look = {}) {
    const color = look.accent ? "#e5739d" : look.star || look.fav ? "#e8b92e" : "#6ca0dc";
    return h_flex().id(`git-item-${id}`).h(26).pl(4 + depth * 16 + 18).pr(8).gap(6).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(Boolean(look.accent), (el) => el.bg(t.selected))
      .on_click((_e, cx) => onPick(cx))
      .when(Boolean(look.menu), (el) => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(look.menu); }))
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(14).flex_none().text_color(color)))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(look.track), (el) => el.child(this.track(look.track, t)));
  }

  // "ahead 2, behind 1" → ↑2 ↓1, "gone" → 원격 없음
  track(s, t) {
    if (s === "gone") return div().flex_none().text_size(11).text_color("#e67e80").child("원격 없음");
    const up = /ahead (\d+)/.exec(s)?.[1], down = /behind (\d+)/.exec(s)?.[1];
    return h_flex().flex_none().gap(6).text_size(11)
      .when(Boolean(up), (el) => el.child(div().text_color("#a7c080").child(`↑${up}`)))
      .when(Boolean(down), (el) => el.child(div().text_color("#7aa2f7").child(`↓${down}`)));
  }

  // ── 커밋 화면 ───────────────────────────────────────────────

  logView(t) {
    const f = this.filter;
    const rows = f ? this.commits.filter((c) => c.hash.startsWith(f) || c.subject.toLowerCase().includes(f) || c.author.toLowerCase().includes(f)) : this.commits;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(40).flex_none().px(8).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().id("git-back").px(6).py(2).rounded(4).cursor_pointer().text_color(t.foreground).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.view = null; this.commits = []; cx.notify(); }).child("←"))
        .child(h_flex().w(220).h(28).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(svg(ICON("search")).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))))
        .child(h_flex().gap(4).items_center().text_size(12)
          .child(div().text_color(t.dim).child("브랜치:"))
          .child(div().font_semibold().child(this.view.name)))
        .child(div().flex_1())
        .child(div().text_size(12).text_color(t.dim).child(`${rows.length}개${this.commits.length >= LIMIT ? `(최근 ${LIMIT})` : ""}`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("git-log", rows.length, ROW, (i) => rows[i].hash,
          (range) => rows.slice(range.start, range.end).map((c) => this.commit(c, t, !!f))).size_full())
        .child(Scrollbar.vertical("git-log").viewport_from_layout().absolute().inset_0())
        .when(rows.length === 0, (el) => el.child(div().absolute().top(8).left(12).text_color(t.dim)
          .child(this.error || (this.commits.length ? "맞는 커밋이 없습니다" : "커밋을 읽는 중")))));
  }

  // 그래프 칸: 레인마다 세로선, 이 커밋의 레인에 점. 검색 중에는 줄이 끊기므로 점만.
  lanes(c, t, flat) {
    const w = (flat ? 1 : c.width) * LANE + 6;
    const lines = [];
    if (!flat) for (let i = 0; i < c.width; i++) {
      const color = LANES[i % LANES.length], x = 6 + i * LANE + LANE / 2 - 1;
      if (c.before[i]) lines.push(div().absolute().left(x).top(0).w(2).h(ROW / 2).bg(color));
      if (c.after[i]) lines.push(div().absolute().left(x).top(ROW / 2).w(2).h(ROW / 2).bg(color));
    }
    const x = 6 + (flat ? 0 : c.lane) * LANE + LANE / 2 - 5, color = LANES[(flat ? 0 : c.lane) % LANES.length];
    const merge = c.parents.length > 1;
    lines.push(div().absolute().left(x).top(ROW / 2 - 5).size(10).rounded_full()
      .bg(merge ? t.chrome : color).border_2().border_color(color));
    return div().relative().w(w).h(ROW).flex_none().children(lines);
  }

  chips(deco, t) {
    if (!deco) return [];
    return deco.split(", ").filter(Boolean).slice(0, 4).map((d) => {
      const tag = d.startsWith("tag: "), head = d.startsWith("HEAD -> ");
      const name = tag ? d.slice(5) : head ? d.slice(8) : d;
      return h_flex().flex_none().gap(3).px(5).h(18).items_center().rounded(4).border_1()
        .border_color(tag ? "#dbbc7f" : head ? "#e5739d" : "#6ca0dc").text_size(11)
        .text_color(tag ? "#dbbc7f" : head ? "#e5739d" : "#6ca0dc")
        .child(svg(ICON(tag ? "tag" : "branch")).size(11).flex_none().text_color(tag ? "#dbbc7f" : head ? "#e5739d" : "#6ca0dc"))
        .child(name);
    });
  }

  commit(c, t, flat) {
    return h_flex().id(`c-${c.hash}`).w_full().h(ROW).pr(10).gap(8).items_center().hover((s) => s.bg(t.hover))
      .child(this.lanes(c, t, flat))
      .child(div().flex_1().min_w(0).truncate().child(c.subject))
      .children(this.chips(c.deco, t))
      .child(div().w(110).flex_none().truncate().text_color(t.muted).child(c.author))
      .child(div().w(150).flex_none().truncate().text_color(t.muted).child(when(c.at)))
      .child(div().w(64).flex_none().text_size(11).text_color(t.dim).child(c.hash.slice(0, 7)));
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

const ROLES = { menu: Menu, prompt: Prompt, confirm: Confirm, tip: Tip };

export default class OfficeGit extends View {
  init(p, cx) {
    const R = ROLES[(props() ?? p ?? {}).role] ?? Panel;
    this.role = new R();
    this.role.init(p, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }
}
