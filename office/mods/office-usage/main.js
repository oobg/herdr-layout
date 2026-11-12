// LLM 구독 사용량. 설치된 CLI를 찾고, 그 CLI가 로그인해 둔 계정으로 사용량을 묻는다.
//   Claude       키체인 "Claude Code-credentials" → api.anthropic.com/api/oauth/usage
//   Codex        ~/.codex/auth.json              → chatgpt.com/backend-api/wham/usage
//   Antigravity  agy -p /usage (명령이라 할당량을 쓰지 않는다)
//   Grok         ~/.grok/auth.json               → cli-chat-proxy.grok.com/v1/billing
// 토큰은 요청 헤더에만 쓰고 저장하거나 출력하지 않는다.
// 보일 때만 읽는다: 앱 창이 앞이고 이 칸이 탭 묶음(office-side)에서 고른 탭일 때(office-resources visible()과 같은 판단).
//   안 보이는 동안 주기가 지나면 건너뛰고, 다시 보일 때 바로 읽는다. 새로 고침 버튼은 언제든 읽는다.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, home, appHome, readTextFile, run, props, window, layout, openOverlay, closeOverlay } from "herdr";

const ID = "office-usage";       // 레이아웃 블록 id이자 모드 이름
const STACK = "office-side";     // 사용량·리소스 탭 묶음 id
const AGY_OLD = "agy를 업데이트해 주세요";

// 레이아웃 트리에서 id로 노드 찾기
function findNode(n, id) {
  if (!n || typeof n !== "object") return null;
  if (n.id === id) return n;
  for (const c of n.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}

const PERIODS = [1, 5, 15, 30]; // 갱신 주기(분) 고르기
const WEB = { claude: "https://claude.ai/settings/usage", codex: "https://chatgpt.com/codex/settings/usage", grok: "https://grok.com" };
const TOOL = { fold: "#9da9a0", sort: "#7aa2f7", reset: "#e69875", period: "#dbbc7f", marquee: "#d699b6", refresh: "#7fbbb3" };
const LOGIN = { claude: ["claude", "/login"], codex: ["codex", "login"], antigravity: ["agy"], grok: ["grok", "login"] };
const LEVEL = { ok: "#a7c080", caution: "#e8b92e", warn: "#f76b15", out: "#e5484d" };
const PROVIDERS = [
  { id: "claude", name: "Claude", bin: "claude", icon: "mods/office-usage/icons/claude.svg", tint: "#d97757" },
  { id: "codex", name: "Codex", bin: "codex", icon: "mods/office-usage/icons/openai.svg", tint: true },
  { id: "antigravity", name: "Antigravity", bin: "agy", icon: "icons/antigravity.svg" },
  { id: "grok", name: "Grok", bin: "grok", icon: "icons/grok.svg", tint: true },
];

// 남은 시간: "2일 22시간", "1시간 40분", "12분".
function left(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m === 0) return "곧";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}일 ${h}시간`;
  if (h) return `${h}시간 ${mm}분`;
  return `${mm}분`;
}
const pct = (x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0)));
const ts = (x) => { const n = typeof x === "number" ? (x < 1e12 ? x * 1000 : x) : Date.parse(x); return Number.isFinite(n) && n > 0 ? n : null; };

async function claude() {
  const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  if (r.code !== 0) return { login: true };
  const token = JSON.parse(r.stdout).claudeAiOauth?.accessToken;
  if (!token) return { error: "Claude 토큰을 찾지 못했습니다" };
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" },
  });
  if (res.status === 401) return { login: true };
  if (!res.ok) return { error: `요청 실패 (HTTP ${res.status})` };
  const d = await res.json();
  const rows = [];
  if (d.five_hour) rows.push({ label: "5시간", used: pct(d.five_hour.utilization), reset: ts(d.five_hour.resets_at) });
  if (d.seven_day) rows.push({ label: "주간", used: pct(d.seven_day.utilization), reset: ts(d.seven_day.resets_at) });
  const fable = (d.limits || []).find((l) => l?.kind === "weekly_scoped" && /fable/i.test(l.scope?.model?.display_name || ""));
  const fw = fable ? { utilization: fable.percent, resets_at: fable.resets_at } : d.seven_day_fable || d.fable_weekly;
  if (fw) rows.push({ label: "Fable 주간", used: pct(fw.utilization), reset: ts(fw.resets_at) });
  return { rows, reset: rows[0]?.reset };
}

async function codex() {
  const text = await readTextFile(`${home()}/.codex/auth.json`);
  const t = text ? JSON.parse(text).tokens : null;
  if (!t?.access_token) return { login: true };
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${t.access_token}`, "ChatGPT-Account-Id": t.account_id || "", "User-Agent": "codex-cli" },
  });
  if (res.status === 401) return { login: true };
  if (!res.ok) return { error: `요청 실패 (HTTP ${res.status})` };
  const d = await res.json();
  const rows = [];
  for (const w of [d.rate_limit?.primary_window, d.rate_limit?.secondary_window]) {
    if (!w) continue;
    const label = w.limit_window_seconds && w.limit_window_seconds <= 6 * 3600 ? "5시간" : "주간";
    rows.push({ label, used: pct(w.used_percent), reset: ts(w.reset_at) });
  }
  rows.sort((a, b) => (a.label === "5시간" ? -1 : 1) - (b.label === "5시간" ? -1 : 1));
  return { rows, reset: rows[0]?.reset, plan: d.plan_type };
}

async function antigravity() {
  const r = await exec("env", ["AGY_CLI_DISABLE_AUTO_UPDATE=true", "agy", "-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], { timeout: 40000 });
  let d = null;
  for (const line of r.stdout.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try { d = JSON.parse(line); break; } catch { /* 다음 줄 */ }
  }
  if (!d) {
    if (/sign in|log in|authenticat/i.test(r.stdout + r.stderr)) return { login: true };
    return { error: "agy가 사용량을 알려 주지 않았습니다" };
  }
  // 명령이 아니라 프롬프트로 처리된 경우(오래된 agy): 할당량을 썼을 수 있으니 알린다.
  if (d.num_turns > 0) return { error: AGY_OLD };
  // 사용률과 초기화 시각이 같은 모델은 한 줄로 묶는다.
  const buckets = [];
  for (const g of d.command?.data?.groups || []) {
    for (const b of g.buckets || []) buckets.push({ name: b.name, used: pct((1 - (b.remaining_fraction ?? 1)) * 100), reset: ts(b.reset_time) });
  }
  if (!buckets.length) return { error: "이 계정에 할당량이 없습니다" };
  const same = new Map();
  for (const b of buckets) {
    const k = `${b.used}|${b.reset}`;
    if (!same.has(k)) same.set(k, { used: b.used, reset: b.reset, names: [] });
    same.get(k).names.push(b.name);
  }
  const rows = [...same.values()].sort((a, b) => b.used - a.used).map((g) => {
    // "Gemini 4 Carbon (High)" -> "Gemini 4 Carbon": 강도 차이만 있는 모델은 한 이름으로.
    const families = [...new Set(g.names.map((n) => n.replace(/\s*\([^)]*\)\s*$/, "")))];
    return {
      label: same.size === 1 ? `모든 모델 (${g.names.length}개)` : `${families[0]}${families.length > 1 ? ` 외 ${families.length - 1}종` : ""}`,
      detail: families.join(", "),
      used: g.used,
      reset: g.reset,
    };
  });
  const next = rows.map((x) => x.reset).filter((x) => x && x > Date.now()).sort()[0] ?? null;
  return { rows, reset: next };
}

async function grokEntry() {
  const text = await readTextFile(`${home()}/.grok/auth.json`);
  return text ? Object.values(JSON.parse(text))[0] : null;
}

// 만료된 토큰은 직접 갱신한다. 단 Grok CLI가 켜져 있으면 CLI가 갱신하도록 두어 둘이 겹치지 않게 한다.
async function grok() {
  let entry = await grokEntry();
  if (!entry?.key) return { login: true };
  if (!entry.expires_at || Date.parse(entry.expires_at) - 120000 < Date.now()) {
    const running = await exec("pgrep", ["-x", "grok"]).catch(() => null);
    if (running?.code === 0) return { error: "Grok 실행 중이라 Grok이 갱신할 때까지 기다립니다" };
    const r = await exec("python3", ["-I", `${appHome()}/mods/office-usage/grok_refresh.py`], { timeout: 30000 });
    let res = null;
    try { res = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* 아래에서 처리 */ }
    if (res?.error === "login" || res?.error === "missing") return { login: true };
    if (!res?.ok) return { error: "Grok 토큰을 갱신하지 못했습니다. 잠시 후 다시 시도합니다" };
    entry = await grokEntry();
  }
  const headers = { Authorization: `Bearer ${entry.key}`, "X-XAI-Token-Auth": "xai-grok-cli", Accept: "application/json" };
  if (entry.user_id) headers["x-userid"] = String(entry.user_id);
  const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers });
  if (res.status === 401 || res.status === 403) return { login: true };
  if (!res.ok) return { error: `요청 실패 (HTTP ${res.status})` };
  const raw = await res.json(), c = raw.config ?? raw;
  const end = ts(c.currentPeriod?.end ?? c.billingPeriodEnd);
  if (typeof c.creditUsagePercent === "number") return { rows: [{ label: "주간", used: pct(c.creditUsagePercent), reset: end }], reset: end };
  const limit = Number(c.monthlyLimit?.val), used = Number(c.used?.val);
  if (limit > 0 && Number.isFinite(used)) return { rows: [{ label: "월간", used: pct((used / limit) * 100), reset: end }], reset: end };
  // 이번 주 구간이 막 시작돼 아직 쓴 게 없으면 creditUsagePercent가 빠진다: 0%로 본다(Orca와 같은 판단).
  const p = c.currentPeriod, n = (x) => Number(x?.val ?? 0);
  const fresh = p?.type === "USAGE_PERIOD_TYPE_WEEKLY" && p.start === c.billingPeriodStart && p.end === c.billingPeriodEnd;
  if (fresh && n(c.onDemandUsed) === 0 && n(c.used) === 0) return { rows: [{ label: "주간", used: 0, reset: end }], reset: end };
  return { error: "Grok이 사용률을 알려 주지 않았습니다" };
}

const FETCH = { claude, codex, antigravity, grok };

class Panel {
  init(_p, cx) {
    const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
    this.period = load("period", 5); // 분
    this.byUse = load("byUse", false); // 사용률 높은 순
    this.rolling = load("rolling", true); // 긴 모델 목록 흘리기
    this.installed = null; // 설치된 CLI 이름 집합
    this.data = {}; // id -> { rows, reset, error }
    this.busy = false;
    this.folded = {};
    try { this.folded = JSON.parse(localStorage.getItem("folded") || "{}"); } catch { /* 처음엔 모두 펼침 */ }
    this.order = [];
    try { this.order = JSON.parse(localStorage.getItem("order") || "[]"); } catch { /* 기본 순서 */ }
    this.heights = {}; // id -> 칸 높이 (드래그 위치 계산용)
    this.drag = null; // { id, at }
    this.agyOld = false; // 옛 agy 안내가 나왔다: 다음 성공(새로 고침 버튼으로 다시 물을 때)까지 자동으로는 부르지 않는다
    this.refresh(cx);
    // 30초마다: 보일 때만, 다음 갱신 시각이 지났으면 다시 읽고, 아니면 남은 시간 표시만 고친다.
    cx.timer.every(30000, (cx) => { if (!this.visible()) return; if (this.due()) this.refresh(cx); else cx.notify(); });
  }

  // 앱 창이 앞이고, 이 칸이 숨지 않았고, 탭 묶음 안이면 고른 탭일 때. Herdr는 숨은 칸의 타이머도 돌리므로 여기서 거른다.
  visible() {
    if (window()?.active === false) return false;
    if (this.height != null && this.height < 4) return false;
    const root = layout();
    if (findNode(root, ID)?.hidden) return false;
    const stack = findNode(root, STACK);
    return stack?.type !== "stack" || (stack.active ?? stack.children?.[0]?.id) === ID;
  }

  due() { return !this.busy && Date.now() >= (this.next ?? 0); }

  // force: 새로 고침 버튼. 안 보여도 읽고, 옛 agy도 다시 물어본다.
  refresh(cx, force = false) {
    if (this.busy || (!force && !this.visible())) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const bins = PROVIDERS.map((p) => p.bin).join(" ");
        const r = await exec("sh", ["-lc", `for c in ${bins}; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done`]);
        this.installed = new Set(r.stdout.split("\n").map((x) => x.trim()).filter(Boolean));
        cx.notify();
        await Promise.all(PROVIDERS.filter((p) => this.installed.has(p.bin)).map(async (p) => {
          if (p.id === "antigravity" && this.agyOld && !force) return;   // 안내를 그대로 두고 부르지 않는다
          try {
            this.data[p.id] = await FETCH[p.id]();
            if (p.id === "antigravity") this.agyOld = this.data[p.id]?.error === AGY_OLD;
          } catch (e) {
            this.data[p.id] = { error: `읽지 못했습니다: ${String(e?.message || e).slice(0, 80)}` };
          }
          cx.notify();
        }));
      } finally {
        this.busy = false;
        this.last = Date.now();
        this.next = this.last + this.period * 60000;
        cx.notify();
      }
    });
  }

  // 저장된 순서를 먼저, 새로 생긴 프로바이더는 뒤에.
  sorted(list) {
    const rank = (id) => { const i = this.order.indexOf(id); return i === -1 ? 1e3 + PROVIDERS.findIndex((p) => p.id === id) : i; };
    return [...list].sort((a, b) => rank(a.id) - rank(b.id));
  }

  // 포인터 y로 끼워 넣을 자리(0..n)를 찾는다.
  slot(y, list) {
    let top = 0;
    for (let i = 0; i < list.length; i++) {
      const h = this.heights[list[i].id] ?? 0;
      if (y < top + h / 2) return i;
      top += h;
    }
    return list.length;
  }

  drop(list) {
    const { id, at } = this.drag;
    this.drag = null;
    if (at == null) return;
    const ids = list.map((p) => p.id), from = ids.indexOf(id);
    ids.splice(from, 1);
    ids.splice(at > from ? at - 1 : at, 0, id);
    this.order = ids;
    try { localStorage.setItem("order", JSON.stringify(ids)); } catch { /* 저장 못 해도 이번 순서는 유지 */ }
  }

  // "10:42 갱신 · 4분 후 다시", short(툴바 안): "10:42 · 4분 후"
  status(short = false) {
    if (!this.last) return "";
    const d = new Date(this.last), hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
    const m = Math.max(0, Math.ceil(((this.next ?? 0) - Date.now()) / 60000));
    return short ? `${hh}:${mm} · ${m ? `${m}분 후` : "곧"}` : `${hh}:${mm} 갱신 · ${m ? `${m}분 후` : "곧"} 다시`;
  }

  toggle(id) {
    this.folded = { ...this.folded, [id]: !this.folded[id] };
    try { localStorage.setItem("folded", JSON.stringify(this.folded)); } catch { /* 저장 못 해도 동작은 한다 */ }
  }

  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 이번 실행 동안만 유지 */ } }

  toolbar(t, shown, inTabs) {
    const btn = (id, icon, tip, on, fn, spin, badge) => h_flex().id(`ut-${id}`).p(4).gap(3).items_center().rounded(4).flex_none()
      .on_mouse_move((e) => { if (this.tipFor !== id) this.showTip(id, tip, e.bounds); })
      .on_hover((h) => { if (!h && this.tipFor === id) this.hideTip(); })
      .when(on, (el) => el.bg(t.selected))
      .when(Boolean(fn), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.hideTip(); fn(cx); cx.notify(); }))
      .child(svg(`mods/office-usage/${icon}.svg`).size(16).text_color(fn ? TOOL[id] : t.dim).when(Boolean(spin), (el) => el.spin(900)))
      .when(Boolean(badge), (el) => el.child(div().text_size(11).font_semibold().text_color(TOOL[id]).child(badge)));
    const sep = () => div().w(1).h(16).mx(4).flex_none().bg(t.border);
    const next = PERIODS[(PERIODS.indexOf(this.period) + 1) % PERIODS.length];
    return h_flex().h(32).flex_none().px(6).gap(2).items_center().border_b_1().border_color(t.border)
      // 펼치기/접기는 한 자리: 하나라도 펼쳐져 있으면 모두 접기, 다 접혀 있으면 모두 펼치기.
      .child(shown.some((p) => !this.folded[p.id])
        ? btn("fold", "collapse", "모두 접기", false, () => { this.folded = Object.fromEntries(shown.map((p) => [p.id, true])); this.save("folded", this.folded); })
        : btn("fold", "expand", "모두 펼치기", false, () => { this.folded = {}; this.save("folded", this.folded); }))
      .child(sep())
      // 정렬도 한 자리: 아이콘이 지금 기준을 보여 준다.
      .child(btn("sort", this.byUse ? "sort" : "order", this.byUse ? "사용률 높은 순 · 누르면 내 순서" : "내 순서(끌어서 바꾼 순서) · 누르면 사용률 높은 순", this.byUse, () => { this.byUse = !this.byUse; this.save("byUse", this.byUse); }))
      // 순서 초기화는 내 순서를 바꿨을 때만 보인다.
      .when(!this.byUse && this.order.length > 0, (el) => el.child(btn("reset", "reset", "끌어서 바꾼 순서 처음대로", false, () => { this.order = []; this.save("order", []); })))
      .child(sep())
      // 주기는 버튼에 글자로 보인다. 누를 때마다 다음 값.
      .child(btn("period", "clock", `${this.period}분마다 자동 갱신 · 누르면 ${next}분`, false, () => {
        this.period = next; this.save("period", next); if (this.last) this.next = this.last + next * 60000;
      }, false, `${this.period}분`))
      .child(btn("marquee", this.rolling ? "marquee" : "marquee-off", this.rolling ? "긴 모델 목록 흘리는 중 · 누르면 끄기" : "긴 모델 목록 흘리기 꺼짐 · 누르면 켜기", false, () => { this.rolling = !this.rolling; this.save("rolling", this.rolling); }))
      .child(div().flex_1())
      // 탭 안에서는 머리줄이 없어 갱신 시각을 여기에 둔다
      .when(inTabs, (el) => el.child(div().min_w(0).truncate().mr(4).text_size(12).text_color(t.dim).child(this.busy ? "읽는 중" : this.status(true))))
      .child(btn("refresh", "refresh", this.busy ? "읽는 중" : "지금 새로 고침", false, !this.busy && ((cx) => this.refresh(cx, true)), this.busy));
  }

  // 툴팁: 아이콘 바로 위, 아이콘 가운데에. 칸 밖까지 그리도록 창 오버레이로 띄운다.
  showTip(id, text, b) {
    this.hideTip();
    if (!b) return;
    const w = Math.round([...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 12 : 7), 0) + 20);
    this.tipFor = id;
    this.tipId = openOverlay({ mod: "office-usage", kind: "window", key: "office-usage-tip", frame: "none", width: w, height: 26,
      at: { x: Math.max(4, Math.round(b.x + b.width / 2 - w / 2)), y: Math.max(4, Math.round(b.y - 30)) },
      props: { role: "tip", text } });
  }

  hideTip() {
    if (this.tipId) closeOverlay(this.tipId);
    this.tipId = null; this.tipFor = null;
  }

  render(cx) {
    const t = theme();
    // 다시 보이게 됐는데 주기가 지났으면 바로 읽는다(렌더 안에서 읽기를 시작하지 않고 다음 틱으로 미룬다)
    if (!this.waking && this.due() && this.visible()) {
      this.waking = true;
      cx.timer.after(0, (cx) => { this.waking = false; if (this.due()) this.refresh(cx); });
    }
    const inTabs = findNode(layout(), STACK)?.type === "stack";   // 탭 이름이 제목을 대신한다
    let shown = this.sorted(PROVIDERS.filter((p) => this.installed?.has(p.bin)));
    if (this.byUse) {
      const top = (p) => Math.max(-1, ...(this.data[p.id]?.rows ?? []).map((r) => r.used));
      shown = [...shown].sort((a, b) => top(b) - top(a));
    }
    return v_flex().id("usage-root").size_full().bg(t.chrome).text_size(13)
      .on_size_change((size, cx) => { this.width = size.width; this.height = size.height; cx.notify(); })
      .when(!inTabs, (el) => el.child(h_flex().h(40).px(14).flex_none().items_center().justify_between().border_b_1().border_color(t.border)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("사용량"))
        .child(div().text_size(12).text_color(t.dim).child(this.busy ? "읽는 중" : this.status()))))
      .child(this.toolbar(t, shown, inTabs))
      .child(v_flex().id("usage-list").flex_1().min_h(0).overflow_y_scrollbar()
        .on_mouse_move((e, cx) => {
          if (!this.drag) return;
          const at = this.slot(e.local_position.y, shown);
          if (at !== this.drag.at) { this.drag.at = at; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drop(shown); cx.notify(); } })
        .children(
        this.installed == null
          ? [div().p(14).text_color(t.dim).child("설치된 CLI를 찾는 중")]
          : shown.length === 0
            ? [div().p(14).text_color(t.dim).child("사용량을 읽을 수 있는 CLI가 없습니다")]
            : shown.flatMap((p, i) => [
              ...(this.drag?.at === i && this.drag.id !== p.id ? [this.marker(t)] : []),
              this.provider(p, t),
              ...(i === shown.length - 1 && this.drag?.at === shown.length ? [this.marker(t)] : []),
            ])));
  }

  marker(t) {
    return div().h(2).mx(10).flex_none().rounded(1).bg(t.accent);
  }

  provider(p, t) {
    const d = this.data[p.id], folded = !!this.folded[p.id];
    // 접었을 때도 가장 많이 쓴 비율은 보이게 한다.
    const top = d?.rows?.length ? Math.max(...d.rows.map((r) => r.used)) : null;
    const dragging = this.drag?.id === p.id;
    return v_flex().id(`usage-${p.id}`).border_b_1().border_color(t.border)
      .when(dragging, (el) => el.opacity(0.4))
      .on_size_change((size) => { this.heights[p.id] = size.height; })
      .child(h_flex().pl(4).items_center().hover((s) => s.bg(t.hover))
        // 손잡이: 눌러서 끌면 순서를 바꾼다. 클릭(접기)과 겹치지 않게 따로 둔다.
        .child(div().id(`usage-grip-${p.id}`).px(4).py(8).flex_none().text_size(16).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.text_color(t.accent))
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.drag = { id: p.id, at: null }; cx.notify(); })
          .child("⠿"))
        .child(h_flex().id(`usage-head-${p.id}`).flex_1().min_w(0).pr(14).py(10).gap(8).items_center()
        .on_click((_e, cx) => { this.toggle(p.id); cx.notify(); })
        .child(svg(`mods/office-usage/chevron-${folded ? "right" : "down"}.svg`).size(14).flex_none().text_color(t.foreground))
        .child(p.tint ? svg(p.icon).size(18).flex_none().text_color(typeof p.tint === "string" ? p.tint : t.foreground) : image(p.icon).size(18).flex_none())
        .child(div().flex_1().min_w(0).text_size(14).font_semibold().text_color(t.foreground).child(p.name))
        .when(Boolean(WEB[p.id]), (el) => el.child(div().id(`usage-web-${p.id}`).p(2).rounded(4).flex_none().cursor_pointer()
          .hover((s) => s.bg(t.raised))
          .on_mouse_move((e) => { if (this.tipFor !== `web-${p.id}`) this.showTip(`web-${p.id}`, `${p.name} 사용량 웹페이지 열기`, e.bounds); })
          .on_hover((h) => { if (!h && this.tipFor === `web-${p.id}`) this.hideTip(); })
          .on_click((_e, cx) => { cx.stop_propagation(); this.hideTip(); exec("open", [WEB[p.id]]); })
          .child(svg("mods/office-usage/web.svg").size(14).text_color("#7fbbb3"))))
        .when(top != null, (el) => el.child(div().flex_none().text_color(this.color(top, t)).font_semibold().child(`${top}%`)))))
      .when(!folded, (el) => el.child(v_flex().px(14).pb(12).gap(12).children(
        !d ? [div().text_color(t.dim).child("읽는 중")]
          : d.login ? [this.login(p, t)]
          : d.error ? [div().text_color(t.muted).child(d.error)]
            : d.rows.map((r) => this.row(r, t)))));
  }

  // 일반 < 70% ≤ 주의 < 90% ≤ 경고 < 100% = 다 씀
  // 로그인이 풀린 프로바이더: 새 탭에서 로그인 명령을 연다.
  login(p, t) {
    const cmd = LOGIN[p.id];
    return h_flex().gap(8).items_center()
      .child(div().text_color(t.muted).child("로그인이 필요해요"))
      .when(Boolean(cmd), (el) => el.child(div().id(`usage-login-${p.id}`).text_color(t.accent).cursor_pointer()
        .hover((s) => s.underline())
        .on_click((_e, cx) => { cx.stop_propagation(); run("tab.new", { name: `${p.name} 로그인`, argv: cmd }); })
        .child(`${cmd.join(" ")} 실행 →`)));
  }

  color(used) {
    return used >= 100 ? LEVEL.out : used >= 90 ? LEVEL.warn : used >= 70 ? LEVEL.caution : LEVEL.ok;
  }

  row(r, t) {
    const bar = Math.max(60, (this.width ?? 300) - 28);
    const reset = r.reset && r.reset > Date.now() ? `${left(r.reset)} 후 초기화` : null;
    return v_flex().gap(5)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.label))
        .child(div().flex_none().font_semibold().text_color(this.color(r.used, t)).child(`${r.used}%`)))
      .child(div().w(bar).h(6).rounded(3).bg(t.border)
        .child(div().h_full().rounded(3).bg(this.color(r.used, t)).w(Math.max(3, (bar * r.used) / 100))))
      .when(Boolean(reset), (el) => el.child(h_flex().justify_end().text_size(12).text_color(t.dim).child(reset)))
      .when(Boolean(r.detail), (el) => el.child(this.rolling
        ? this.marquee(`usage-detail-${r.label}`, r.detail, bar, t)
        : div().w(bar).truncate().text_size(12).text_color(t.dim).child(r.detail)));
  }

  // 칸보다 긴 글(묶인 모델 이름들)은 전광판처럼 흘린다: 처음에 잠시 멈췄다가 한 방향으로 끝까지 밀고,
  // 끝에서 잠시 멈춘 뒤 처음 위치로 바로 돌아간다. loop는 왕복만 되므로, 한 글자씩 민 문자열을
  // frames로 차례로 보여 준다(네이티브라 스크립트 타이머가 없고, 안 보이면 멈춘다).
  marquee(id, text, width, t) {
    const chars = [...text];
    const cw = (ch) => (ch.charCodeAt(0) > 0x2e80 ? 12 : 7);
    const box = div().id(id).w(width).h(16).overflow_hidden().whitespace_nowrap().text_size(12).text_color(t.dim);
    if (chars.reduce((n, ch) => n + cw(ch), 0) <= width) return box.child(text);
    // 칸에 들어가는 글자 수(시작 위치마다 다를 수 있어 앞에서부터 채운다)
    const fit = (i) => { let w = 0, j = i; while (j < chars.length && w + cw(chars[j]) <= width) w += cw(chars[j++]); return j; };
    let last = 0;
    while (fit(last) < chars.length) last++;
    const STEP = 140, HOLD = 12; // 140ms마다 한 글자, 양 끝에서 12칸(약 1.7초) 멈춤
    const frame = (i) => chars.slice(i, fit(i)).join("");
    const frames = [
      ...Array(HOLD).fill(frame(0)),
      ...Array.from({ length: last }, (_, k) => frame(k + 1)),
      ...Array(HOLD).fill(frame(last)),
    ];
    return box.child(div().frames(frames, STEP));
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

export default class Usage extends View {
  init(p, cx) {
    this.role = (props() ?? p ?? {}).role === "tip" ? new Tip() : new Panel();
    this.role.init(p, cx);
  }

  render(cx) {
    return this.role.render(cx);
  }
}
