// office-apps의 PR 앱: 지금 고른 스페이스(포커스된 패인)의 저장소 PR을 gh CLI로 본다.
//   왼쪽: 상태 필터(열림·내 PR·리뷰 요청·닫힘) + PR 목록
//   오른쪽: 고른 PR(상태, base ← head, 본문, 체크, 리뷰·코멘트, 바뀐 파일)과 동작
// 머지·닫기·체크아웃은 menu.js의 확인 창(confirm 역할)을 거친다. 확인 창은 ACTIONS[이름](ctx)만 부르므로
// 이 모듈이 불릴 때 ACTIONS에 pr.* 동작을 등록한다(main.js가 이 파일을 늘 불러오므로 오버레이 쪽에도 등록된다).
// 동작이 끝나면 PR_TICK을 바꿔 앱이 목록과 상세를 다시 읽게 한다.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, panes, focused, exec, run, openOverlay, closeOverlay, notify, shared, setShared } from "herdr";
import { ACTIONS, TICK } from "./menu.js";

const ME = "mods/office-apps";
const PR_TICK = "office-apps.pr.tick";
const LIMIT = 50;          // 목록에 가져올 PR 수
const FILES_MAX = 300;     // 바뀐 파일 목록 최대 줄 수
const POLL = 120000;       // 목록 자동 갱신 간격(네트워크 요청이라 느리게)

// 필터: 이름 · gh pr list 인자
const FILTERS = [
  { id: "open", name: "열림", args: ["--state", "open"] },
  { id: "mine", name: "내 PR", args: ["--state", "open", "--author", "@me"] },
  { id: "review", name: "리뷰 요청", args: ["--state", "open", "--search", "review-requested:@me"] },
  { id: "closed", name: "닫힘", args: ["--state", "closed"] },
];
const LIST_FIELDS = "number,title,author,headRefName,baseRefName,state,isDraft,updatedAt";
const VIEW_FIELDS = "number,title,body,state,isDraft,author,headRefName,baseRefName,headRefOid,createdAt,updatedAt,mergedAt,closedAt,url,"
  + "mergeable,reviewDecision,additions,deletions,changedFiles,files,reviews,comments,statusCheckRollup";
// 머지 방식: gh 플래그 · 이름 · 저장소 설정 이름
const METHODS = [
  { flag: "--merge", name: "머지 커밋", allow: "mergeCommitAllowed" },
  { flag: "--squash", name: "스쿼시", allow: "squashMergeAllowed" },
  { flag: "--rebase", name: "리베이스", allow: "rebaseMergeAllowed" },
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

ACTIONS["pr.merge"] = (ctx) => gh(ctx, ["pr", "merge", String(ctx.number), ctx.flag, ...(ctx.head ? ["--match-head-commit", ctx.head] : [])], "머지했습니다");
ACTIONS["pr.close"] = (ctx) => gh(ctx, ["pr", "close", String(ctx.number)], "PR을 닫았습니다");
ACTIONS["pr.checkout"] = async (ctx) => { await gh(ctx, ["pr", "checkout", String(ctx.number)], "체크아웃했습니다"); setShared(TICK, Date.now()); };

// ── 도우미

// 파일 앱과 같은 기준: 포커스된 패인의 폴더(없으면 스페이스 폴더)와 그 머신.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

async function sh(cmd, args, where) {
  try { return await exec(cmd, args, { cwd: where.cwd, on: where.on }); }
  catch (e) { return { code: -1, stdout: "", stderr: String(e?.message ?? e), failed: true }; }
}

// gh 실패를 짧은 안내로. 실행조차 못 했으면 설치 안 됨으로 본다.
function ghError(r) {
  const s = (r.stderr || r.stdout || "").trim();
  if (r.failed || r.code === 127 || /command not found|No such file/i.test(s)) return "gh가 설치되어 있지 않습니다";
  if (/gh auth login|HTTP 401|not logged/i.test(s)) return "gh 로그인이 필요합니다 · 터미널에서 gh auth login";
  if (/no git remotes|none of the git remotes/i.test(s)) return "GitHub 원격 저장소가 없습니다";
  return s.split("\n")[0].slice(0, 160) || "gh 명령이 실패했습니다";
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
  if (p.state === "MERGED") return { text: "머지됨", color: "ansi5" };
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
const CHECK = { pass: ["통과", "ansi2"], fail: ["실패", "ansi1"], pending: ["진행 중", "ansi3"], skip: ["건너뜀", "dim"] };
const REVIEW = { APPROVED: ["승인", "ansi2"], CHANGES_REQUESTED: ["변경 요청", "ansi1"], COMMENTED: ["코멘트", "dim"], DISMISSED: ["취소됨", "dim"] };
const DECISION = { APPROVED: ["승인됨", "ansi2"], CHANGES_REQUESTED: ["변경 요청", "ansi1"], REVIEW_REQUIRED: ["리뷰 대기", "ansi3"] };
const CHANGE = { ADDED: "추가", DELETED: "삭제", RENAMED: "이름 바꿈", COPIED: "복사" };

const confirm = (action, title, detail, ctx) =>
  openOverlay({ mod: "office-apps", kind: "dialog", width: 420, height: 190, props: { role: "confirm", action, title, detail, ctx } });

export class PrApp {
  init(_p, cx) {
    const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
    this.filter = FILTERS.some((f) => f.id === load("pr.filter", "")) ? load("pr.filter", "") : "open";
    this.method = load("pr.method", null);
    this.tick = shared(PR_TICK);
    this.context = null;
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
      this.root = null; this.on = on; this.repo = null; this.prs = null; this.error = null;
      this.sel = null; this.pr = null; this.prError = null; this.loading = false;
    }
    if (!cwd) { this.error = "폴더가 없습니다"; return; }
    if (this.sel) this.loadDetail(this.sel, cx);
    if (this.loading) return;
    const context = this.context, filter = this.filter;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const top = await sh("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (top.code !== 0) throw new Error("git 저장소가 아닙니다");
          const root = top.stdout.trim();
          const remote = await sh("git", ["remote"], { cwd: root, on });
          if (!remote.stdout.trim()) throw new Error("원격 저장소가 없습니다");
          const repo = await sh("gh", ["repo", "view", "--json", "nameWithOwner,url,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed"], { cwd: root, on });
          if (repo.code !== 0) throw new Error(ghError(repo));
          if (!this.current(context)) return;
          this.root = root; this.repo = JSON.parse(repo.stdout);
        }
        const r = await sh("gh", ["pr", "list", ...FILTERS.find((f) => f.id === filter).args, "--limit", String(LIMIT), "--json", LIST_FIELDS], { cwd: this.root, on });
        if (r.code !== 0) throw new Error(ghError(r));
        if (!this.current(context) || this.filter !== filter) return;
        this.prs = JSON.parse(r.stdout); this.error = null;
      } catch (e) { if (this.current(context)) { this.error = String(e?.message ?? e); this.prs = null; } }
      finally {
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
    this.refresh(cx);
  }

  select(n, cx) {
    if (this.sel !== n) { this.sel = n; this.pr = null; this.prError = null; }
    this.loadDetail(n, cx);
  }

  // 고른 PR 상세. 다시 읽는 동안에는 이전 내용을 그대로 보여 준다.
  loadDetail(n, cx) {
    if (!this.root) return;
    const context = this.context;
    cx.spawn(async (cx) => {
      const r = await sh("gh", ["pr", "view", String(n), "--json", VIEW_FIELDS], { cwd: this.root, on: this.on });
      if (!this.current(context) || this.sel !== n) return;
      if (r.code !== 0) { this.prError = ghError(r); this.pr = null; }
      else { try { this.pr = JSON.parse(r.stdout); this.prError = null; } catch { this.prError = "PR 정보를 읽지 못했습니다"; } }
      cx.notify();
    });
  }

  // 저장소가 허용하는 머지 방식들과 지금 고른 방식
  methods() { return METHODS.filter((m) => this.repo?.[m.allow] !== false); }
  mergeMethod() { const list = this.methods(); return list.find((m) => m.flag === this.method) ?? list[0] ?? METHODS[0]; }

  // 앱 셸이 그릴 때마다 부른다: 위치 바뀜·동작 완료 확인
  sync(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    if (shared(PR_TICK) !== this.tick) { this.tick = shared(PR_TICK); this.refresh(cx); }
  }

  // ── 툴팁(파일 앱과 같은 방식: 아이콘 위에 창 오버레이)
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

  // ── 왼쪽: 필터 + 목록
  toolbar(t) {
    const tab = (f) => div().id(`pr-f-${f.id}`).px(7).py(3).rounded(4).flex_none().cursor_pointer().text_size(12)
      .text_color(this.filter === f.id ? t.foreground : t.muted).when(this.filter === f.id, (el) => el.bg(t.selected).font_semibold())
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.setFilter(f.id, cx); cx.notify(); })
      .child(f.name);
    return h_flex().min_h(32).flex_none().py(2).px(6).gap(1).items_center().border_b_1().border_color(t.border)
      .children(FILTERS.map(tab))
      .child(div().flex_1())
      .child(div().id("pr-refresh").p(4).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_move((e) => { if (this.tipFor !== "refresh") this.showTip("refresh", "다시 읽기", e.bounds); })
        .on_hover((h) => { if (!h && this.tipFor === "refresh") this.hideTip(); })
        .on_click((_e, cx) => { this.hideTip(); this.refresh(cx); cx.notify(); })
        .child(svg(`${ME}/refresh.svg`).size(15).text_color(this.loading ? t.dim : t.muted)));
  }

  row(p, t) {
    const st = prState(p), on = this.sel === p.number;
    const meta = [`#${p.number}`, p.author?.login, ago(p.updatedAt), p.headRefName].filter(Boolean).join(" · ");
    return v_flex().id(`pr-row-${p.number}`).flex_none().px(8).py(6).gap(2).rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover)).when(on, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.select(p.number, cx); cx.notify(); })
      .child(div().truncate().text_size(13).text_color(p.isDraft && p.state === "OPEN" ? t.muted : t.foreground).child(p.title))
      .child(h_flex().gap(5).items_center().min_w(0)
        // 열림 목록에서는 초안만, 닫힘 목록에서는 머지됨/닫힘을 작은 색 글자로
        .when(p.state !== "OPEN" || p.isDraft, (el) => el.child(div().flex_none().text_size(11).text_color(t[st.color]).child(st.text)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta)));
  }

  list(cx, t) {
    this.sync(cx);
    const note = (text) => div().p(8).text_size(12).text_color(t.dim).child(text);
    let body;
    if (this.error) body = [note(this.error)];
    else if (!this.prs) body = [note("PR을 읽는 중")];
    else if (!this.prs.length) body = [note({ open: "열린 PR이 없습니다", mine: "내가 연 PR이 없습니다", review: "리뷰 요청이 없습니다", closed: "닫힌 PR이 없습니다" }[this.filter])];
    else body = this.prs.map((p) => this.row(p, t));
    return v_flex().flex_1().min_h(0)
      .child(this.toolbar(t))
      .child(v_flex().id("pr-list").flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1).children(body)
        .when(this.prs?.length === LIMIT, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child(`최근 ${LIMIT}개까지만 보여 줍니다`))));
  }

  subtitle(t) {
    if (!this.repo) return null;
    return div().id("pr-repo").truncate().text_size(12).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground).underline()).on_click(() => exec("open", [this.repo.url]))
      .child(this.repo.nameWithOwner);
  }

  // ── 오른쪽: 고른 PR
  detail(cx, t) {
    if (!this.sel) return null;
    const p = this.pr, n = this.sel;
    const head = h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border);
    const closeBtn = div().id("pr-close-detail").px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.sel = null; this.pr = null; cx.notify(); }).child("✕");
    if (!p) {
      return v_flex().size_full().min_h(0)
        .child(head.child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child(`#${n}`)).child(closeBtn))
        .child(v_flex().flex_1().items_center().justify_center().text_color(t.muted).child(this.prError ?? "PR을 읽는 중"));
    }
    const st = prState(p);
    return v_flex().size_full().min_h(0)
      .child(head
        .child(div().flex_none().text_size(12).font_semibold().text_color(t[st.color]).child(st.text))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(`#${p.number}`))
        .child(h_flex().flex_1().min_w(0).gap(4).items_center().text_size(12).text_color(t.muted)
          .child(svg(`${ME}/branch.svg`).size(13).flex_none().text_color(t.dim))
          .child(div().flex_none().child(p.baseRefName))
          .child(div().flex_none().text_color(t.dim).child("←"))
          .child(div().min_w(0).truncate().child(p.headRefName)))
        .child(closeBtn))
      .child(v_flex().id(`pr-detail-${p.number}`).flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16).gap(18)
        .child(this.summary(p, t))
        .child(this.checks(p, t))
        .child(this.section("본문", t, p.body?.trim()
          ? this.md(`pr-body-${p.number}`, p.body.replace(/<!--[\s\S]*?-->/g, ""), t)
          : div().text_size(13).text_color(t.dim).child("본문이 없습니다")))
        .child(this.talk(p, t))
        .child(this.files(p, t)));
  }

  md(id, text, t) {
    return div().text_size(13).text_color(t.foreground)
      .child(TextView.markdown(id, text).selectable(true).on_link_click((url) => { if (/^(https?|mailto):/i.test(url)) exec("open", [url]); }));
  }

  section(title, t, ...kids) {
    return v_flex().gap(8)
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(title))
      .children(kids);
  }

  // 제목, 한 줄 정보, 동작 버튼
  summary(p, t) {
    const dec = DECISION[p.reviewDecision];
    const meta = [p.author?.login, `${ago(p.createdAt)} 열림`,
      p.state === "MERGED" ? `${ago(p.mergedAt)} 머지` : p.state === "CLOSED" ? `${ago(p.closedAt)} 닫힘` : null,
      `파일 ${p.changedFiles ?? 0}개`].filter(Boolean).join(" · ");
    const btn = (id, text, fn, color) => div().id(id).px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(color ?? t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn).child(text);
    const open = p.state === "OPEN", m = this.mergeMethod(), methods = this.methods();
    const ctx = { number: p.number, root: this.root, on: this.on };
    return v_flex().gap(8)
      .child(div().text_size(18).font_semibold().text_color(t.foreground).child(p.title))
      .child(h_flex().flex_wrap().gap(6).items_center().text_size(12).text_color(t.muted)
        .child(div().child(meta))
        .child(div().text_color(t.ansi2).child(`+${p.additions ?? 0}`))
        .child(div().text_color(t.ansi1).child(`−${p.deletions ?? 0}`))
        .when(Boolean(dec), (el) => el.child(div().text_color(t.dim).child("·")).child(div().text_color(t[dec[1]]).child(dec[0]))))
      .child(h_flex().pt(2).flex_wrap().gap(6).items_center()
        .child(btn("pr-web", "브라우저로 열기", () => exec("open", [p.url])))
        .child(btn("pr-diff", "변경 내용", () => {
          run("tab.new", { name: `PR #${p.number} diff`, folder: this.root, argv: ["gh", "pr", "diff", String(p.number)] });
          run("layout.show", { id: "office-term" });
        }))
        .when(open, (el) => el
          .child(btn("pr-checkout", "체크아웃", () => confirm("pr.checkout", `#${p.number} 체크아웃`,
            `작업 폴더를 ${p.headRefName} 브랜치로 바꿉니다. 커밋하지 않은 변경이 있으면 실패할 수 있습니다.`, ctx)))
          .child(btn("pr-merge", "머지", () => confirm("pr.merge", `#${p.number} 머지`,
            `${p.headRefName} → ${p.baseRefName}, ${m.name} 방식으로 머지합니다.`, { ...ctx, flag: m.flag, head: p.headRefOid }), t.ansi2))
          // 방식이 여럿이면 누를 때마다 다음 방식으로
          .when(methods.length > 1, (el) => el.child(div().id("pr-method").px(4).py(4).text_size(12).text_color(t.dim).cursor_pointer()
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { const i = methods.indexOf(m); this.method = methods[(i + 1) % methods.length].flag; this.save("pr.method", this.method); cx.notify(); })
            .child(`${m.name} ▾`)))
          .child(btn("pr-close", "닫기", () => confirm("pr.close", `#${p.number} 닫기`, "머지하지 않고 PR을 닫습니다. 나중에 다시 열 수 있습니다.", ctx), t.ansi1))))
      .when(open && p.mergeable === "CONFLICTING", (el) => el.child(div().text_size(12).text_color(t.ansi1).child("base 브랜치와 충돌이 있어 머지할 수 없습니다")))
      .when(open && p.isDraft, (el) => el.child(div().text_size(12).text_color(t.dim).child("초안 PR입니다")));
  }

  // 체크: 요약 한 줄 + 하나씩(점 · 이름 · 워크플로). 누르면 결과 페이지.
  checks(p, t) {
    const list = (p.statusCheckRollup ?? []).map(check);
    if (!list.length) return this.section("체크", t, div().text_size(13).text_color(t.dim).child("체크가 없습니다"));
    const count = (s) => list.filter((c) => c.state === s).length;
    const fail = count("fail"), pending = count("pending");
    const sum = fail ? [`${fail}개 실패`, "ansi1"] : pending ? [`${pending}개 진행 중`, "ansi3"] : [`${list.length}개 모두 통과`, "ansi2"];
    return this.section("체크", t,
      div().text_size(12).text_color(t[sum[1]]).child(sum[0]),
      v_flex().gap(1).children(list.map((c, i) => h_flex().id(`pr-check-${i}`).h(24).px(4).gap(8).items_center().rounded(4)
        .when(Boolean(c.link), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => exec("open", [c.link])))
        .child(div().size(7).flex_none().rounded_full().bg(t[CHECK[c.state][1]]))
        .child(div().flex_none().text_size(13).text_color(t.foreground).child(c.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(c.group))
        .child(div().flex_none().text_size(11).text_color(t[CHECK[c.state][1]]).child(CHECK[c.state][0])))));
  }

  // 리뷰와 코멘트를 시간 순으로. 내용 없는 코멘트 리뷰(줄 코멘트만 단 것)는 뺀다.
  talk(p, t) {
    const items = [
      ...(p.reviews ?? []).filter((r) => r.state !== "PENDING" && (r.body?.trim() || r.state !== "COMMENTED"))
        .map((r) => ({ who: r.author?.login, at: r.submittedAt, body: r.body ?? "", review: REVIEW[r.state] })),
      ...(p.comments ?? []).map((c) => ({ who: c.author?.login, at: c.createdAt, body: c.body ?? "" })),
    ].sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0));
    if (!items.length) return this.section("리뷰·코멘트", t, div().text_size(13).text_color(t.dim).child("아직 없습니다"));
    return this.section(`리뷰·코멘트 ${items.length}`, t, ...items.map((it, i) => v_flex().pl(12).gap(4).border_l_2().border_color(t.border)
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(div().font_semibold().text_color(t.foreground).child(it.who ?? "알 수 없음"))
        .when(Boolean(it.review), (el) => el.child(div().text_color(t[it.review[1]]).child(it.review[0])))
        .child(div().text_color(t.dim).child(ago(it.at))))
      .when(Boolean(it.body.trim()), (el) => el.child(this.md(`pr-talk-${p.number}-${i}`, it.body.replace(/<!--[\s\S]*?-->/g, ""), t)))));
  }

  files(p, t) {
    const list = (p.files ?? []).slice(0, FILES_MAX), total = p.changedFiles ?? list.length;
    return this.section(`바뀐 파일 ${total}`, t,
      v_flex().children(list.map((f) => h_flex().h(22).gap(8).items_center().text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(f.changeType === "DELETED" ? t.dim : t.foreground).child(f.path))
        .when(Boolean(CHANGE[f.changeType]), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(CHANGE[f.changeType])))
        .child(div().w(44).flex_none().text_right().text_color(t.ansi2).child(f.additions ? `+${f.additions}` : ""))
        .child(div().w(44).flex_none().text_right().text_color(t.ansi1).child(f.deletions ? `−${f.deletions}` : "")))),
      ...(list.length < total ? [div().text_size(11).text_color(t.dim).child(`앞 ${list.length}개만 보여 줍니다 · 전체는 '변경 내용'에서`)] : []));
  }
}
