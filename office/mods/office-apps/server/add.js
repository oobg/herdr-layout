// 서버 앱의 "기기 추가" 화면(오른쪽 칸). `hc machine add`가 받는 것만 묻는다:
//   SSH: 사용자(선택) + 호스트(필수) + 포트(선택) → TARGET `user@host:port` + 기기 이름(선택, --name, 기본은 호스트)
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

// 사용자·호스트·포트 칸 → ssh 대상. 호스트 칸에 user@나 :포트가 있으면 쓰되, 따로 적은 칸이 우선한다(중복 없이).
export function sshTarget(user, hostField, port) {
  const m = /^(?:([^@]+)@)?(.*?)(?::(\d+))?$/.exec(hostField.trim());
  const host = m?.[2]?.trim();
  if (!host) return null;
  const u = user.trim() || m[1] || "", p = /^\d+$/.test(port.trim()) ? port.trim() : m[3] || "";
  return `${u ? `${u}@` : ""}${host}${p ? `:${p}` : ""}`;
}

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
    this.user = make("woong");
    this.target = make("192.168.0.10, example.com, ssh config의 Host");
    this.port = make("22");
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
    const target = args.at(-1);
    return target.replace(/^.*@/, "").replace(/:\d+$/, "");
  }

  submit(cx) {
    const args = this.args();
    if (!args || this.busy) return;
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
    const field = (label, state, hint) => v_flex().gap(4)
      .child(h_flex().gap(6).items_baseline()
        .child(div().text_size(12).text_color(t.muted).child(label))
        .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint))))
      .child(Input.new(state).w(Math.min(420, W)).h(30).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground));
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
          .child(field("사용자", this.user, "선택 · ssh로 접속할 계정"))
          .child(field("호스트", this.target, "필수 · IP, 도메인, ssh config의 Host"))
          .child(field("포트", this.port, "선택 · 비우면 22(또는 ssh config)"))
          .child(field("기기 이름", this.name, "Herdr 목록에 보일 이름 · 비우면 호스트")))
        .when(this.mode === "via", (el) => el
          .child(field("명령", this.via, "마지막 인자로 셸 한 줄을 받아 그쪽에서 돌리는 명령. 아무것도 묻지 않아야 합니다"))
          .child(field("기기 이름", this.viaName, "필수 · Herdr 목록에 보일 이름")))
        .child(div().pt(2).text_size(12).font_family(MONO).text_color(t.dim).child(preview))
        .child(h_flex().gap(10).items_center()
          .child(btn("sv-add-go", this.busy ? "추가하는 중" : "추가", args && !this.busy && ((_e, cx) => this.submit(cx)), true))
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
