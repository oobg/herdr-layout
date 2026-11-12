// 서버 앱의 "기기 추가" 화면(오른쪽 칸). `hc machine add`가 받는 것만 묻는다:
//   SSH: 사용자(선택) + 호스트(필수) + 포트(선택) → TARGET `user@host:port`(IPv6+포트는 `user@[주소]:port`) + 기기 이름(선택, --name, 기본은 호스트)
//   명령: --via <명령>(ssh처럼 마지막 인자로 셸 한 줄을 받는 명령) + 기기 이름(--name, 필수)
// 미리보기와 실제 실행은 같은 args()를 쓴다.
// 추가는 tty 없이 `hc machine add … --json`으로 돌린다. 비밀번호·새 호스트 키·herdr-core 설치처럼 물어보는 게 있으면
// 실패하므로, 그때는 이 컴퓨터의 터미널 탭에서 같은 명령을 돌리게 안내한다(hc가 거기서 묻는다).
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { hc, run, spaces } from "herdr";

const MONO = "D2Coding";
const shellArg = (s) => (/^[a-z0-9_@%+=:,./-]+$/i.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");
// machine-add 모드와 같은 기준: 이런 실패는 사람이 터미널에서 답해야 한다.
const INTERACTIVE = ["hc_missing", "incompatible", "login_needed", "auth_failed", "host_key"];

// 이 컴퓨터에서 명령을 터미널 탭으로 돌린다. tab.new는 고른 스페이스에 열리므로 이 컴퓨터의 스페이스를 집어 준다.
export function runHere(name, argv) {
  const local = spaces().find((s) => !s.machine && s.active) ?? spaces().find((s) => !s.machine);
  if (local) { run("space.select", { id: local.id }); run("tab.new", { name, space: local.id, argv }); }
  else run("space.new", { machine: "", argv });
  run("layout.show", { id: "office-term" });
}

// 사용자·호스트·포트 칸 → { target, host, problems }. 호스트 칸에 user@나 :포트가 있으면 쓰되, 따로 적은 칸이 우선한다(중복 없이).
//   IPv6: 호스트에 ':'가 둘 이상이면 주소 전체를 호스트로 보고 포트를 떼지 않는다. "[주소]"·"[주소]:포트" 표기도 받는다.
//   대상 문자열: hc가 받는 `user@host:port`. IPv6에 포트가 붙으면 `user@[주소]:포트`로 묶는다(포트가 없으면 주소 그대로).
//   problems: { user?, host?, port? } — 칸 아래 띄울 이유. 하나라도 있으면 target은 null(추가 못 함).
export function parseSsh(user, hostField, port) {
  const problems = {};
  let rest = hostField.trim(), u = user.trim(), hostUser = "", p = port.trim(), hostPort = null;
  const at = rest.lastIndexOf("@");
  if (at >= 0) { hostUser = rest.slice(0, at).trim(); rest = rest.slice(at + 1).trim(); }
  let host = rest;
  if (rest.startsWith("[")) {
    const m = /^\[([^\]]*)\](?::(.*))?$/.exec(rest);
    if (!m) problems.host = "'[주소]' 또는 '[주소]:포트' 모양이어야 합니다";
    else { host = m[1].trim(); if (m[2] !== undefined) hostPort = m[2].trim(); }
  } else if ((rest.match(/:/g) ?? []).length === 1) {
    host = rest.slice(0, rest.indexOf(":")).trim(); hostPort = rest.slice(rest.indexOf(":") + 1).trim();
  }
  // 포트: 포트 칸이 우선. 1~65535 정수가 아니면 그 값을 적은 칸에 이유를 띄운다(말없이 버리지 않음).
  const portBad = (v) => (!/^\d+$/.test(v) || +v < 1 || +v > 65535 ? `포트는 1~65535 숫자여야 합니다('${v}')` : null);
  if (p) { const why = portBad(p); if (why) problems.port = why; }
  else if (hostPort !== null) { const why = portBad(hostPort); if (why) problems.host ??= why; else p = hostPort; }
  // 사용자·호스트: 공백이 있거나 '-'로 시작하면 ssh가 옵션·여러 인자로 읽는다
  const wordBad = (v, what) => (/\s/.test(v) ? `${what}에 공백을 쓸 수 없습니다` : v.startsWith("-") ? `${what}는 '-'로 시작할 수 없습니다` : null);
  if (u) { const why = wordBad(u, "사용자"); if (why) problems.user = why; }
  else if (hostUser) { const why = wordBad(hostUser, "사용자"); if (why) problems.host ??= why; else u = hostUser; }
  if (host) { const why = wordBad(host, "호스트"); if (why) problems.host ??= why; }
  else if (hostField.trim() && !problems.host) problems.host = "호스트가 비어 있습니다";
  if (!host || Object.keys(problems).length) return { target: null, host: host || null, problems };
  const h = p && host.includes(":") ? `[${host}]` : host;
  return { target: `${u ? `${u}@` : ""}${h}${p ? `:${p}` : ""}`, host, problems };
}
// ssh 대상 문자열만(모자라거나 칸에 문제가 있으면 null)
export function sshTarget(user, hostField, port) {
  return parseSsh(user, hostField, port).target;
}

// 기기 이름 규칙(hc 오류 문구): 1~32자, a-z 0-9 - _ ., 영문·숫자로 시작, 터미널 주소(t7, t1b) 모양 금지
const ID_SHAPE = /^t\d+[a-z]*$/;
export function nameProblem(n) {
  if (!n) return "기기 이름이 필요합니다";
  if (n.length > 32) return "32자를 넘습니다";
  if (/[^a-z0-9._-]/.test(n)) return /^[A-Za-z0-9._-]+$/.test(n) ? "대문자는 쓸 수 없습니다" : "영문 소문자·숫자·- _ . 만 쓸 수 있습니다";
  if (!/^[a-z0-9]/.test(n)) return "영문이나 숫자로 시작해야 합니다";
  if (ID_SHAPE.test(n)) return "t7 같은 터미널 주소 모양은 쓸 수 없습니다";
  return null;
}
// 규칙에 맞게 고친 이름(호스트 등에서)
export function suggestName(src) {
  let n = String(src ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/[-_.]+$/, "").slice(0, 32);
  if (!n) return null;
  if (ID_SHAPE.test(n)) n = `${n}-m`;
  return nameProblem(n) ? null : n;
}
// 대상 문자열의 호스트: user@를 떼고, "[주소]:포트"는 괄호 안, ':'가 하나면 :포트를 뗀다(IPv6 주소는 그대로).
const hostOf = (target) => {
  const r = (target ?? "").replace(/^.*@/, "");
  const b = /^\[([^\]]*)\]/.exec(r);
  if (b) return b[1];
  return (r.match(/:/g) ?? []).length === 1 ? r.replace(/:\d+$/, "") : r;
};

export class AddForm {
  // 입력 상자는 렌더 중에 만들 수 없어 여기(서버 앱 init)에서 만든다.
  init(onChange) {
    this.mode = "ssh";
    this.busy = false; this.result = null; this.copied = false;
    const make = (placeholder) => {
      const s = InputState.new({ placeholder });
      s.on("change", (_e, cx) => { this.result = null; cx.notify(); });
      s.on("submit", (_e, cx) => this.submit(cx));
      return s;
    };
    // 예시 값을 placeholder로 두면 채워진 것처럼 보여 비워 둔다(설치본에서 woong이 입력된 줄 안 혼동).
    this.user = make("비우면 ssh 기본 계정");
    this.target = make("IP, 도메인 또는 ssh config의 Host");
    this.port = make("비우면 22");
    this.name = make("비우면 호스트");
    this.via = make("ssh -p 2222 -i ~/.ssh/key user@ip");
    this.viaName = make("Herdr 목록에 보일 이름");
    this.onAdded = onChange;
  }

  focus() { (this.mode === "ssh" ? this.user : this.via).focus(); }

  // 입력 → hc 인자. 모자라면 null.
  args() {
    const v = (s) => s.value().trim();
    if (this.mode === "ssh") {
      const target = sshTarget(v(this.user), v(this.target), v(this.port));
      if (!target) return null;
      return ["machine", "add", ...(v(this.name) ? ["--name", v(this.name)] : []), target];
    }
    if (!v(this.via) || !v(this.viaName)) return null;
    return ["machine", "add", "--via", v(this.via), "--name", v(this.viaName)];
  }

  // 새 기기의 이름(선택하려고): --name, 아니면 주소의 호스트
  expectedName(args) {
    const i = args.indexOf("--name");
    if (i >= 0) return args[i + 1];
    return hostOf(args.at(-1));
  }

  // 기기 이름 문제: { text, suggest } 또는 null. SSH에서 비우면 hc가 호스트를 이름으로 쓰므로 그것을 검사한다.
  problem() {
    const v = (s) => s.value().trim();
    if (this.mode === "ssh") {
      const target = sshTarget(v(this.user), v(this.target), v(this.port));
      if (!target) return null;
      const typed = v(this.name), host = hostOf(target);
      const text = nameProblem(typed || host);
      if (!text) return null;
      return { text: typed ? text : `호스트 '${host}'를 이름으로 쓸 수 없습니다: ${text}`, suggest: suggestName(host) ?? suggestName(typed) };
    }
    const typed = v(this.viaName);
    if (!typed) return null;   // 비었을 때는 버튼만 꺼진다(args가 null)
    const text = nameProblem(typed);
    return text ? { text, suggest: suggestName(typed) } : null;
  }

  submit(cx) {
    const args = this.args();
    if (!args || this.busy || this.problem()) return;
    this.busy = true; this.result = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc([...args, "--json"]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      let err = null, name = this.expectedName(args);
      if (r.code === 0) {
        try { const j = JSON.parse(r.stdout); name = j.name ?? j.machine?.name ?? name; } catch { /* 짐작한 이름 */ }
      } else {
        try { err = JSON.parse(r.stdout || r.stderr).error ?? null; } catch { /* 글자 그대로 */ }
        err ??= { message: (r.stderr || r.stdout || "응답이 없습니다").trim() };
      }
      this.busy = false;
      if (!err) {
        this.result = { ok: true, text: `'${name}'을(를) 추가했습니다` };
        for (const s of [this.user, this.target, this.port, this.name, this.via, this.viaName]) s.set_value("");
        this.onAdded?.(name, cx);
      } else {
        const ask = INTERACTIVE.includes(err.kind) || /password|passphrase|host key|permission denied|login|install/i.test(err.message ?? "");
        this.result = { ok: false, ask, text: String(err.message ?? "").split("\n")[0].slice(0, 200) || "추가하지 못했습니다", args };
      }
      cx.notify();
    });
  }

  view(t, W) {
    const args = this.args();
    const preview = args ? ["hc", ...args].map(shellArg).join(" ") : "hc machine add …";
    const bad = this.problem();
    const nameState = this.mode === "ssh" ? this.name : this.viaName;
    // 사용자·호스트·포트 칸 아래: 이름 칸과 같은 빨간 이유 한 줄(이유가 있으면 args가 null이라 추가 버튼도 꺼진다)
    const fp = this.mode === "ssh" ? parseSsh(this.user.value(), this.target.value(), this.port.value()).problems : {};
    const note = (text) => (text ? div().text_size(11).text_color(t.ansi1).child(text) : null);
    // 이름 칸 아래: 빨간 이유 + 누르면 채우는 제안
    const nameNote = bad ? v_flex().gap(2)
      .child(div().text_size(11).text_color(t.ansi1).child(bad.text))
      .when(Boolean(bad.suggest), (el) => el.child(div().id("sv-add-suggest").text_size(11).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground).underline())
        .on_click((_e, cx) => { nameState.set_value(bad.suggest); this.result = null; cx.notify(); })
        .child(`'${bad.suggest}'(으)로 쓰기`))) : null;
    const field = (label, state, hint, note = null) => v_flex().gap(4)
      .child(h_flex().gap(6).items_baseline()
        .child(div().text_size(12).text_color(t.muted).child(label))
        .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint))))
      .child(Input.new(state).w(Math.min(420, W)).h(30).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground))
      .when(Boolean(note), (el) => el.child(note));
    const tab = (id, text) => div().id(`sv-add-${id}`).px(10).py(3).rounded(5).text_size(12).cursor_pointer()
      .text_color(this.mode === id ? t.foreground : t.muted).when(this.mode === id, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.mode = id; this.result = null; this.focus(); cx.notify(); }).child(text);
    const btn = (id, text, fn, primary = false) => div().id(id).px(12).py(5).rounded(6).text_size(12).flex_none()
      .border_1().border_color(primary ? t.solid : t.border).when(primary, (el) => el.bg(t.solid))
      .text_color(primary ? t.solid_foreground : t.foreground)
      .when(Boolean(fn), (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(fn))
      .when(!fn, (el) => el.opacity(0.4)).child(text);
    const res = this.result;
    const cmd = res?.args ? ["hc", ...res.args].map(shellArg).join(" ") : null;

    return v_flex().size_full().min_h(0)
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().flex_none().text_size(14).font_semibold().text_color(t.foreground).child("기기 추가"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child("ssh로 닿는 기기를 Herdr에 등록합니다")))
      .child(v_flex().id("sv-add").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).gap(12)
        .child(v_flex().gap(4)
          .child(div().text_size(12).text_color(t.muted).child("연결 방식"))
          .child(h_flex().gap(4).child(tab("ssh", "SSH")).child(tab("via", "명령"))))
        .when(this.mode === "ssh", (el) => el
          .child(field("사용자", this.user, "선택 · ssh로 접속할 계정", note(fp.user)))
          .child(field("호스트", this.target, "필수 · IP(IPv6는 [주소]:포트도), 도메인, ssh config의 Host", note(fp.host)))
          .child(field("포트", this.port, "선택 · 비우면 22(또는 ssh config)", note(fp.port)))
          .child(field("기기 이름", this.name, "영문 소문자·숫자·-_. 1~32자 · 비우면 호스트", nameNote)))
        .when(this.mode === "via", (el) => el
          .child(field("명령", this.via, "마지막 인자로 셸 한 줄을 받아 그쪽에서 돌리는 명령. 아무것도 묻지 않아야 합니다"))
          .child(field("기기 이름", this.viaName, "필수 · 영문 소문자·숫자·-_. 1~32자", nameNote)))
        .child(div().pt(2).text_size(12).font_family(MONO).text_color(t.dim).child(preview))
        .child(h_flex().gap(10).items_center()
          .child(btn("sv-add-go", this.busy ? "추가하는 중" : "추가", args && !bad && !this.busy && ((_e, cx) => this.submit(cx)), true))
          .child(div().id("sv-add-builtin").text_size(12).text_color(t.dim).cursor_pointer()
            .hover((s) => s.text_color(t.foreground).underline())
            .on_click(() => run("mod.open", { name: "machine-add" })).child("Herdr 기본 추가 창 열기")))
        .when(Boolean(res), (el) => el.child(v_flex().gap(6).pt(4)
          .child(div().text_size(13).text_color(res.ok ? t.ansi2 : t.blocked).child(res.text))
          .when(Boolean(res.ask), (x) => x
            .child(div().text_size(12).text_color(t.muted).child("비밀번호·새 호스트 키·herdr-core 설치처럼 직접 답할 게 있습니다. 터미널에서 같은 명령을 돌리세요. 끝나면 목록에 나타납니다."))
            .child(h_flex().gap(8)
              .child(btn("sv-add-term", "터미널에서 실행", () => runHere("기기 추가", ["hc", ...res.args])))
              .child(btn("sv-add-copy", this.copied === cmd ? "복사함" : "명령 복사", (_e, cx) => { cx.write_to_clipboard(cmd); this.copied = cmd; cx.notify(); }))))
          .when(!res.ok && !res.ask, (x) => x.child(div().text_size(12).text_color(t.dim)
            .child("주소·이름을 확인하거나 터미널에서 직접 돌려 보세요.")).child(h_flex()
              .child(btn("sv-add-term2", "터미널에서 실행", () => runHere("기기 추가", ["hc", ...res.args]))))))));
  }
}
