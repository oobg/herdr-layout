// office-apps의 메모 앱: 작업 공간마다 남기는 메모와 할 일. 다른 작업 공간에 갔다 와서 맥락을 되찾고,
//   에이전트에게 넘길 인수인계를 적는 곳이다.
//   저장: 레포 안이 아니라 Herdr 데이터 폴더(notes/model.js 머리말). 레포를 더럽히지 않고 커밋에 섞이지 않게.
//         작업 공간 = 지금 칸 폴더의 git 루트(워크트리마다 따로), 레포가 아니면 스페이스 폴더. 원격 스페이스도 이 Mac에 둔다.
//   왼쪽: 메모가 있는 작업 공간(지금 작업 공간이 맨 위, 나머지는 최근에 고친 순). 줄 = 이름 · 남은 할 일 수 / "지금 · 3분 전".
//         지금 작업 공간에 메모가 없으면 맨 위에 "이 작업 공간 메모 시작".
//   오른쪽: 머리줄(이름 · 보낼 내용 전체|남은 할 일 · 에이전트에게 보내기 · 복사) → 할 일 체크 목록(누르면 토글하고 저장)
//         + 할 일 추가 입력(Enter) → 메모 편집기(멈추고 1초 뒤 자동 저장, "저장됨 · 방금").
//   보내기: send.js(공용). 지금 스페이스의 에이전트 중 머리줄 아래 "보낼 곳"에서 고른 하나에게. 상태 규칙(입력 대기면 보내지 않음,
//         작업 중·상태 모름은 확인 창)도 거기서. 보는 메모가 지금 작업 공간의 것이 아니면 늘 확인 창에서 두 이름을 밝힌다.
// 셸 계약: move(delta, cx) 작업 공간 이동 · activate(cx) 메모 편집기로 키보드 · emptyState() · dispose()(남은 저장을 마친다).
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, home, appHome, readTextFile, writeTextFile, notify } from "herdr";
import * as fs from "fs/promises";
import { candidates, chosen, recipients, sendToAgent } from "./send.js";
import {
  DIR, noteId, notePath, rootName, parseFile, serialize, parseTodos, split, join, toggleLine, todoLine,
  payload, ago, order,
} from "./notes/model.js";

const SAVE_MS = 1000;

function load(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 */ } }

// 파일 앱과 같은 규칙으로 지금 폴더와 기기: 포커스된 칸의 폴더, 없으면 스페이스 폴더, 다른 기기면 on(files.js location()을 옮겨 옴).
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, folder: space?.folder || null, on: on ?? null, space: space ?? null };
}

// 지금 작업 공간의 루트: git 루트(그 기기에서), 레포가 아니면 스페이스 폴더, 그것도 없으면 홈
async function resolveRoot({ cwd, folder, on }) {
  if (cwd) {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on, timeout: 5000 }).catch(() => null);
    const top = r?.code === 0 ? r.stdout.trim() : "";
    if (top) return top;
  }
  return folder || (on ? "~" : home());
}

const tilde = (p) => { const h = home(); return p === h ? "~" : p.startsWith(h + "/") ? `~${p.slice(h.length)}` : p; };

async function copyText(text) {
  const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(() => ({ code: 1 }));
  if (r.code === 0) notify({ title: "메모를 복사했습니다", body: text.split("\n")[0], level: "info" });
  else notify({ title: "복사하지 못했습니다", level: "error" });
}

export class NotesApp {
  init(_p, cx) {
    this.notes = new Map();   // id → { id, root, machine, name, updated, open, path }
    this.scanned = false;
    this.here = null;         // 지금 작업 공간 { id, root, machine, name }
    this.hereKey = null;      // 다시 풀어야 하는지 가르는 값(기기·폴더)
    this.sel = null;          // 고른 작업 공간 id
    this.cur = null;          // 보고 있는 메모 { id, root, machine, name, path, disk(파일 글 또는 null), todos[], saved(저장된 본문) }
    this.loadingId = null;
    this.state = "saved";     // saved | dirty | saving | error
    this.savedAt = null;
    this.saveTask = null;
    this.to = null;           // 보낼 에이전트 주소(지금 스페이스 안에서)
    this.which = load("notes.which", "all");   // 보낼 내용: all | todo
    this.rows = [];

    this.memo = TextareaState.new({ placeholder: "메모 · 다른 작업 공간에 다녀와서 이어 볼 것, 에이전트에게 넘길 것", rows: 8 });
    this.memo.on("change", (_e, cx) => this.edited(cx));
    this.memo.on("blur", (_e, cx) => this.flush(cx));
    this.add = InputState.new({ placeholder: "할 일 추가 · Enter" });
    this.add.on("submit", (_e, cx) => {
      const line = todoLine(this.add.value());
      if (!line || !this.cur) return;
      this.cur.todos.push(line);
      this.add.set_value("");
      this.saveSoon(cx, 0);
      cx.notify();
    });

    cx.spawn(async (cx) => { await this.scan(); cx.notify(); });
  }

  // ── 파일 ──────────────────────────────────────────────
  // 데이터 폴더의 메모를 모두 읽는다(notes/*.md, notes/<기기>/*.md). 머리줄이 없는 파일은 건너뛴다.
  async scan() {
    const base = `${appHome()}/${DIR}`, out = new Map();
    const read = async (rel) => {
      const text = await readTextFile(`${appHome()}/${rel}`).catch(() => null);
      const { meta, body } = parseFile(text);
      if (!meta?.root) return;
      const id = noteId(meta);
      out.set(id, { id, root: meta.root, machine: meta.machine ?? null, name: meta.name || rootName(meta.root, home()), updated: meta.updated ?? 0,
        open: parseTodos(body).filter((x) => !x.done).length, path: rel });
    };
    const ents = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (e.isDirectory()) {
        const sub = await fs.readdir(`${base}/${e.name}`).catch(() => []);
        for (const n of sub) if (n.endsWith(".md")) await read(`${DIR}/${e.name}/${n}`);
      } else if (e.name.endsWith(".md")) await read(`${DIR}/${e.name}`);
    }
    // 읽는 동안 저장한 것이 있으면 그쪽이 새것이다
    for (const [id, n] of this.notes) if (!out.has(id) || (n.updated ?? 0) > (out.get(id).updated ?? 0)) out.set(id, n);
    this.notes = out;
    this.scanned = true;
  }

  // 지금 작업 공간을 다시 푼다(기기·폴더가 바뀌었을 때만). 처음이면 그곳을 고른다.
  watchHere(cx) {
    const loc = location(), key = JSON.stringify([loc.on, loc.cwd, loc.folder]);
    if (key === this.hereKey) return;
    this.hereKey = key;
    cx.timer.after(0, (cx) => cx.spawn(async (cx) => {
      const root = await resolveRoot(loc);
      if (this.hereKey !== key || this.disposed) return;
      const prev = this.here?.id ?? null;
      this.here = { id: noteId({ root, machine: loc.on }), root, machine: loc.on, name: rootName(root, home()) };
      // 처음이거나, 보던 것이 지난 작업 공간이고 고치는 중이 아니면 새 작업 공간을 따라간다
      //   (그래야 "에이전트에게 보내기"가 엉뚱한 작업 공간의 메모를 지금 스페이스에 보내지 않는다)
      if (!this.sel || (this.sel === prev && prev !== this.here.id && this.state !== "dirty")) this.select(this.here.id, cx);
      cx.notify();
    }));
  }

  // 작업 공간을 고른다: 남은 저장을 먼저 마치고 그 메모를 읽는다.
  select(id, cx) {
    if (id === this.sel && this.cur?.id === id) return;
    this.flush(cx);
    this.sel = id;
    this.cur = null;
    this.clash = null;
    this.loadingId = id;
    const n = this.notes.get(id) ?? (this.here?.id === id ? this.here : null);
    if (!n) return;
    const path = notePath(n);
    cx.spawn(async (cx) => {
      const disk = await readTextFile(`${appHome()}/${path}`).catch(() => null);
      if (this.loadingId !== id || this.disposed) return;
      const { meta, body } = parseFile(disk);
      this.loadingId = null;
      // 해시가 겹쳐 다른 작업 공간의 파일이면 읽지도 덮어쓰지도 않는다
      if (disk != null && meta?.root && noteId(meta) !== id) {
        this.clash = id;
        notify({ title: "메모 파일 이름이 다른 작업 공간과 겹칩니다", body: `${path} · ${meta.root}`, level: "error" });
        cx.notify();
        return;
      }
      const { todos, memo } = split(body);
      this.cur = { id, root: n.root, machine: n.machine ?? null, name: n.name, path, disk, todos, saved: join(todos, memo) };
      this.state = "saved";
      this.savedAt = meta?.updated || null;
      this.memo.set_value(memo);
      cx.notify();
    });
  }

  body() { return this.cur ? join(this.cur.todos, this.memo.value()) : ""; }

  // 메모 편집기가 바뀌었다(set_value로 넣을 때도 불린다: 저장된 것과 같으면 무시)
  edited(cx) {
    if (!this.cur) return;
    if (this.body() === this.cur.saved) {
      // 고치다가 저장된 글로 돌아왔다: 걸어 둔 저장을 끊는다
      if (this.state === "dirty") { this.saveTask?.cancel(); this.saveTask = null; this.state = "saved"; cx.notify(); }
      return;
    }
    this.state = "dirty";
    this.saveSoon(cx, SAVE_MS);
    cx.notify();
  }

  saveSoon(cx, ms) {
    this.saveTask?.cancel();
    const c = this.cur;
    // 다른 작업 공간을 고르면 flush가 이 타이머를 끊고 먼저 쓴다. 그래도 남았으면(경합) 아무것도 하지 않는다.
    this.saveTask = cx.timer.after(ms, (cx) => { this.saveTask = null; if (this.cur === c) this.write(c, this.body(), cx); });
  }

  // 걸어 둔 저장을 바로 한다(다른 작업 공간을 고를 때·편집기를 떠날 때·앱을 끌 때). 지금 본문을 이 자리에서 잡아 둔다.
  flush(cx) {
    if (!this.saveTask && this.state !== "dirty") return;
    this.saveTask?.cancel(); this.saveTask = null;
    const c = this.cur;
    if (!c) return;
    const body = this.body();
    if (body === c.saved) return;
    this.write(c, body, cx);
  }

  // 파일에 쓴다. 본문이 비면 파일을 지운다(목록에서 빠진다). 다른 곳에서 바뀌었으면 지금 것으로 덮는다.
  write(c, body, cx) {
    if (!c || body == null || body === c.saved) { if (c && this.cur === c && this.state === "dirty") this.state = "saved"; return; }
    const job = async () => {
      if (body === c.saved) return true;   // 앞의 저장이 같은 글을 이미 썼다
      const abs = `${appHome()}/${c.path}`;
      if (!c.disk && !body.trim()) { c.saved = body; return true; }    // 아직 파일이 없고 쓸 것도 없다
      if (!body.trim()) {
        await fs.unlink(abs).catch(() => {});
        c.disk = null; c.saved = body;
        this.notes.delete(c.id);
        return true;
      }
      const updated = Date.now();
      const text = serialize({ root: c.root, machine: c.machine, name: c.name, updated }, body);
      await fs.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      try { await writeTextFile(abs, text, c.disk); }
      catch { await writeTextFile(abs, text, await readTextFile(abs).catch(() => null)); }
      c.disk = text; c.saved = body;
      this.notes.set(c.id, { id: c.id, root: c.root, machine: c.machine, name: c.name, updated, open: parseTodos(body).filter((x) => !x.done).length, path: c.path });
      if (this.cur === c) this.savedAt = updated;
      return true;
    };
    if (this.cur === c) this.state = "saving";
    const done = (ok) => { if (this.cur === c && body === this.body()) this.state = ok ? "saved" : "error"; };
    // 쓰기는 한 줄로 세운다(편집기를 떠나며 저장한 직후 체크를 누르면 두 번 쓴다: 순서가 바뀌면 옛 글이 남는다)
    const run = (this.queue ?? Promise.resolve()).then(job);
    this.queue = run.catch(() => {});
    if (!cx?.spawn) return;   // dispose: 기다리지 않는다
    cx.spawn(async (cx) => {
      let ok = false;
      try { ok = await run; } catch (e) { notify({ title: "메모를 저장하지 못했습니다", body: String(e).slice(0, 300), level: "error" }); }
      done(ok);
      cx.notify();
    });
  }

  // ── 셸 계약 ────────────────────────────────────────────
  move(delta, cx) {
    if (!this.rows.length) return;
    const i = this.rows.findIndex((r) => r.id === this.sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(this.rows.length - 1, i + delta));
    this.select(this.rows[j].id, cx);
  }

  // Enter: 메모 편집기로 키보드를 옮긴다
  activate(_cx) { if (this.cur) this.memo.focus(); }

  emptyState() {
    return { text: "작업 공간을 읽는 중", sub: "" };
  }

  dispose() {
    this.disposed = true;
    this.saveTask?.cancel(); this.saveTask = null;
    const c = this.cur;
    if (c) { const b = this.body(); if (b !== c.saved) this.write(c, b, null); }
  }

  // ── 그리기 ─────────────────────────────────────────────
  prepare(cx) {
    this.watchHere(cx);
    const hid = this.here?.id ?? null;
    const rows = order([...this.notes.values()], hid).map((n) => ({ ...n, start: false }));
    if (this.here && !this.notes.has(hid)) rows.unshift({ ...this.here, start: true, open: this.cur?.id === hid ? parseTodos(this.body()).filter((x) => !x.done).length : 0 });
    this.rows = rows;
  }

  list(cx, t) {
    this.prepare(cx);
    const hid = this.here?.id;
    return v_flex().id("notes-list").flex_1().min_h(0).overflow_y_scrollbar().p(4)
      .when(!this.rows.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.scanned ? "메모가 없습니다" : "읽는 중")))
      .children(this.rows.map((r) => {
        const on = r.id === this.sel, here = r.id === hid;
        const when = r.start ? "" : ago(r.updated);
        const sub = [here ? "지금" : null, r.machine, when].filter(Boolean).join(" · ");
        return v_flex().id(`nt-${r.id}`).h(40).flex_none().justify_center().px(8).rounded(4).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.select(r.id, cx); cx.notify(); })
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(r.start ? t.muted : t.foreground)
              .child(r.start ? "이 작업 공간 메모 시작" : r.name))
            .when(r.open > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`할 일 ${r.open}`))))
          .child(div().truncate().text_size(11).text_color(t.muted).child(r.start ? [r.name, r.machine].filter(Boolean).join(" · ") : sub));
      }));
  }

  subtitle(t) {
    const n = this.notes.size;
    return div().text_size(12).text_color(t.dim).truncate().child(n ? `작업 공간 ${n}곳` : "");
  }

  detail(cx, t) {
    this.prepare(cx);
    const c = this.cur;
    if (!c) {
      if (!this.sel) return null;
      return div().size_full().p(20).text_size(12).text_color(t.muted)
        .child(this.clash === this.sel ? "이 작업 공간의 메모 파일 이름이 다른 작업 공간과 겹쳐 열지 않았습니다" : "메모를 읽는 중");
    }
    const space = location().space;
    const btn = (id, text, fn, off) => div().id(id).flex_none().px(10).py(4).rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(off ? t.dim : t.foreground).when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn)).child(text);
    const seg = (k, text) => div().id(`nt-which-${k}`).px(8).py(3).rounded(5).text_size(12).cursor_pointer()
      .text_color(this.which === k ? t.foreground : t.muted).when(this.which === k, (el) => el.bg(t.selected))
      .on_click((_e, cx) => { this.which = k; save("notes.which", k); cx.notify(); }).child(text);
    const text = payload(this.body(), c.name, this.which);
    const where = [c.machine, tilde(c.root)].filter(Boolean).join(" · ");

    const head = h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
      .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child(c.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(where))
      .child(h_flex().flex_none().gap(2).child(seg("all", "전체")).child(seg("todo", "남은 할 일")))
      .child(btn("nt-send", "에이전트에게 보내기", () => this.send(text, space), !text || !space))
      .child(btn("nt-copy", "복사", () => copyText(text), !text));

    return v_flex().size_full().min_h(0)
      .child(head)
      .when(Boolean(space), (el) => el.child(div().flex_none().px(14).py(6).border_b_1().border_color(t.border)
        .child(recipients("nt", this.agentsHere(space), this.target(space)?.address, (address) => { this.to = address; }, t))))
      .child(v_flex().flex_1().min_h(0).px(20).py(14).gap(6)
        .child(this.todoView(c, cx, t))
        .child(h_flex().pt(10).items_center()
          .child(div().flex_1().text_size(12).font_semibold().text_color(t.muted).child("메모"))
          .child(div().flex_none().text_size(11).text_color(this.state === "error" ? t.ansi1 : t.dim).child(this.saveWord())))
        .child(Textarea.new(this.memo).flex_1().min_h(120).w_full().p(10).rounded(7).border_1().border_color(t.border)
          .bg(t.background).text_color(t.foreground).text_size(13)));
  }

  saveWord() {
    if (this.state === "dirty") return "고치는 중";
    if (this.state === "saving") return "저장 중";
    if (this.state === "error") return "저장하지 못했습니다";
    return this.savedAt ? `저장됨 · ${ago(this.savedAt)}` : "";
  }

  // 할 일: 머리(할 일 n · 끝낸 일 지우기) → 체크 줄(누르면 토글하고 바로 저장) → 추가 입력
  todoView(c, cx, t) {
    const items = c.todos.map((line, i) => ({ line, i, ...(parseTodos(line)[0] ?? { done: false, text: line }) }));
    const open = items.filter((x) => !x.done).length, done = items.length - open;
    const box = (on) => div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.muted : t.border)
      .flex().items_center().justify_center().text_size(10).text_color(t.muted).child(on ? "✓" : "");
    return v_flex().flex_none().gap(2)
      .child(h_flex().items_center().pb(2)
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.muted).child(items.length ? `할 일 ${open} 남음` : "할 일"))
        .when(done > 0, (el) => el.child(div().id("nt-clear").flex_none().text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { c.todos = c.todos.filter((l) => !parseTodos(l)[0]?.done); this.saveSoon(cx, 0); cx.notify(); })
          .child(`끝낸 일 ${done}개 지우기`))))
      .child(v_flex().id("nt-todos").max_h(200).overflow_y_scrollbar()
        .children(items.map((x) => h_flex().id(`nt-td-${x.i}`).min_h(24).px(4).gap(8).items_center().rounded(4).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { c.todos[x.i] = toggleLine(x.line); this.saveSoon(cx, 0); cx.notify(); })
          .child(box(x.done))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(x.done ? t.muted : t.foreground)
            .when(x.done, (el) => el.line_through()).child(x.text || " ")))))
      .child(Input.new(this.add).h(30).mt(4).px(8).rounded(6).border_1().border_color(t.border).bg(t.background)
        .text_size(12.5).text_color(t.foreground));
  }

  // ── 보내기(send.js) ───────────────────────────────────
  agentsHere(space) { return space ? candidates({ space: space.id }) : []; }
  target(space) { return chosen(this.agentsHere(space), this.to); }

  // 보는 메모가 지금 작업 공간의 것이 아니면 늘 확인 창에서 두 이름을 밝힌다.
  send(text, space) {
    const a = text ? this.target(space) : null;
    if (!a) { if (text) notify({ title: "이 스페이스에 에이전트가 없습니다", body: "에이전트를 띄운 뒤 다시 보내세요", level: "info" }); return; }
    const foreign = this.cur && this.here && this.cur.id !== this.here.id;
    sendToAgent(a, text, { note: foreign ? `'${this.cur.name}' 메모를 지금 스페이스 '${space?.name ?? ""}'의 에이전트에게 보냅니다.` : null });
  }
}
