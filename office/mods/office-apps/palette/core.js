// 명령 앱의 순수 함수: 명령 목록 합치기, 단축키 붙이기, 사람 말 한 줄, 위험 판단, 인자 만들기, 검색·최근 순서.
//   herdr를 import하지 않는다 — node로 `herdr-app commands` 출력과 keys.json을 넣어 시험한다.

// 이 레이아웃의 앱 명령(office-apps의 nextCommand가 받는 것, main.js 머리 주석의 "키·명령").
//   main.js를 import할 수 없어(main.js가 이 앱을 import한다) 앱 id를 여기 손으로 적는다. 앱을 더하면 여기도 더한다.
//   run: 인자 값으로 실제 보낼 명령 문자열을 만든다(인자가 없으면 name 그대로).
export const APP_IDS = [
  ["files", "파일"], ["branch", "브랜치"], ["commit", "커밋"], ["pr", "PR"], ["agent", "에이전트"],
  ["actions", "배포"], ["worktrees", "워크트리"], ["review", "검토"], ["notes", "메모"],
  ["inbox", "알림함"], ["sessions", "세션"], ["workspace", "작업 공간"], ["watch", "출력"], ["ports", "포트"],
  ["server", "서버"], ["palette", "명령"], ["settings", "설정"], ["manage", "앱 관리"],
];
const arg = (name, required = true) => ({ name, required });
export const APP_COMMANDS = [
  { name: "office-apps.home", args: [], about: "앱 런처 첫 화면으로 돌아갑니다." },
  ...APP_IDS.map(([id, label]) => ({ name: `office-apps.open-${id}`, args: [], about: `${label} 앱을 엽니다.` })),
  { name: "office-apps.manage", args: [], about: "앱 관리 창을 엽니다. 앱마다 켜고 끌 수 있습니다." },
  { name: "office-apps.disable", args: [arg("id")], about: "앱을 끕니다. 앱 관리에서 다시 켤 수 있습니다(앱 관리 앱은 끌 수 없습니다).",
    send: (a) => `office-apps.disable-${a.id}` },
  { name: "office-apps.show", args: [arg("path")], about: "파일 앱에서 파일을 엽니다. 경로는 프로젝트 기준 상대 경로입니다.",
    send: (a) => `office-apps.show:${a.path}` },
  { name: "office-apps.commit", args: [arg("hash")], about: "커밋 앱에서 그 커밋을 엽니다. WORKTREE는 커밋 안 된 변경입니다.",
    send: (a) => `office-apps.commit:${a.hash}` },
  { name: "office-apps.range", args: [arg("from"), arg("to")], about: "커밋 앱에서 두 지점 사이를 비교합니다.",
    send: (a) => `office-apps.range:${a.from}...${a.to}` },
  { name: "office-apps.favorite", args: [arg("id")], about: "앱을 런처 즐겨찾기에 더하거나 뺍니다. 즐겨찾기는 격자 맨 위 줄에 모입니다.",
    send: (a) => `office-apps.favorite:${a.id}` },
  { name: "office-apps.files-toggle-hidden", args: [], about: "파일 앱에서 숨김 파일 보이기를 켜고 끕니다." },
  { name: "office-apps.files-toggle-ignored", args: [], about: "파일 앱에서 gitignore 항목 감추기를 켜고 끕니다." },
];

// Herdr 명령 + 앱 명령. 이름이 겹치면 Herdr 쪽을 둔다. app: 앱 명령인지
export function allCommands(herdr) {
  const seen = new Set();
  const out = [];
  for (const c of herdr ?? []) {
    if (!c?.name || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, args: (c.args ?? []).map((a) => ({ name: a.name, required: Boolean(a.required) })), about: c.about ?? "", app: false });
  }
  for (const c of APP_COMMANDS) if (!seen.has(c.name)) { seen.add(c.name); out.push({ ...c, app: true }); }
  return out;
}

// 위험해 보이는 명령: 이름에 이 낱말이 있으면 확인 창을 거친다(app.zoom_reset·overlay.close도 걸린다 — 규칙 그대로).
export const DANGER_WORDS = ["close", "kill", "reset", "remove", "quit"];
export const isDanger = (name) => DANGER_WORDS.some((w) => String(name).toLowerCase().includes(w));

// Herdr가 스스로 묻는 명령: 이 앱의 확인 창을 거쳤으면 confirmed: true를 넣어 두 번 묻지 않는다. 입력 칸에서도 뺀다.
export const SELF_CONFIRM_ARG = "confirmed";

// about의 첫 문장(사람 말 한 줄). 괄호 안은 빼고 ". " ": " "; " 앞에서 자른다. 한국어가 아니어도 그대로 쓴다.
export function summary(about) {
  let s = String(about ?? "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4 && /\([^()]*\)/.test(s); i++) s = s.replace(/\s*\([^()]*\)/g, "");
  // 콜론 앞이 두 낱말 이하면("Ctrl+V: …") 머리말일 뿐이라 콜론 뒤까지 본다
  let from = 0;
  for (;;) {
    const m = /(\.|:|;)(\s|$)/.exec(s.slice(from));
    if (!m) break;
    const at = from + m.index;
    if (m[1] === ":" && s.slice(0, at).trim().split(" ").length <= 2) { from = at + 1; continue; }
    s = s.slice(0, at);
    break;
  }
  return s.replace(/[.\s,]+$/, "").trim();
}

// keys.json { section: { "cmd-shift-p": "app.palette" } } 또는 herdr keys() [{ section, keys, action }] → [{ section, keys, action }]
export function bindingList(src) {
  if (Array.isArray(src)) return src.filter((b) => b && typeof b.keys === "string" && typeof b.action === "string");
  const out = [];
  for (const [section, map] of Object.entries(src ?? {})) {
    if (!map || typeof map !== "object") continue;
    for (const [keys, action] of Object.entries(map)) if (typeof action === "string") out.push({ section, keys, action });
  }
  return out;
}

// 명령 이름 → 묶인 단축키 [{ keys, label, section, arg }]. "pane.split:right"처럼 콜론 뒤는 인자(arg)로 둔다.
//   앱 명령 "office-apps.disable-files"·"office-apps.show:x"는 앱 명령 이름(office-apps.disable·show)에 붙인다.
export function keyIndex(bindings, commands) {
  const names = new Set(commands.map((c) => c.name));
  const idx = new Map();
  for (const b of bindingList(bindings)) {
    let name = b.action, argText = "";
    if (!names.has(name)) {
      const i = name.indexOf(":");
      if (i > 0) { argText = name.slice(i + 1); name = name.slice(0, i); }
    }
    if (!names.has(name) && name.startsWith("office-apps.disable-")) { argText = name.slice(20); name = "office-apps.disable"; }
    if (!names.has(name)) continue;
    if (!idx.has(name)) idx.set(name, []);
    idx.get(name).push({ keys: b.keys, label: keyLabel(b.keys), section: b.section, arg: argText });
  }
  // 인자 없이 그 명령 자체에 묶인 키를 앞에
  for (const list of idx.values()) list.sort((a, b) => (a.arg ? 1 : 0) - (b.arg ? 1 : 0));
  return idx;
}

const MOD = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", fn: "fn" };
const KEY = {
  enter: "↩", escape: "Esc", tab: "⇥", space: "Space", backspace: "⌫", delete: "⌦",
  left: "←", right: "→", up: "↑", down: "↓", pageup: "PgUp", pagedown: "PgDn", home: "Home", end: "End",
};
// "cmd-shift-p" → "⌘⇧P", "cmd--" → "⌘-", "f2" → "F2". 순서: ⌃⌥⇧⌘(macOS 메뉴 순서)
export function keyLabel(keys) {
  return String(keys).split(" ").map((chord) => {
    let rest = chord;
    const mods = [];
    for (;;) {
      const m = Object.keys(MOD).find((k) => rest.startsWith(k + "-") && rest.length > k.length + 1);
      if (!m) break;
      mods.push(m); rest = rest.slice(m.length + 1);
    }
    const order = ["ctrl", "alt", "shift", "cmd", "fn"];
    mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const key = KEY[rest] ?? (rest.length === 1 ? rest.toUpperCase() : rest.replace(/^f(\d+)$/, "F$1"));
    return mods.map((m) => MOD[m]).join("") + key;
  }).join(" ");
}

// 입력 칸에 보일 인자: Herdr가 스스로 묻는 confirmed는 뺀다.
export const inputArgs = (cmd) => (cmd?.args ?? []).filter((a) => a.name !== SELF_CONFIRM_ARG);
export const needsArgs = (cmd) => inputArgs(cmd).some((a) => a.required);

// 숫자로 받는 인자(나머지는 숫자처럼 보여도 글자 — id·이름이 숫자뿐일 수 있다)
const NUMERIC = new Set(["index", "lines", "pages", "px", "weight"]);
// 글자 → 값. 숫자 인자의 숫자·true/false·JSON([…]·{…})은 풀어서, 나머지는 글자 그대로.
//   비면 undefined(인자에서 뺀다 — ""는 뜻이 있는 값이라 넣지 않는다).
export function parseValue(text, name = "") {
  const s = String(text ?? "").trim();
  if (!s) return undefined;
  if (NUMERIC.has(name) && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if (/^[[{]/.test(s)) { try { return JSON.parse(s); } catch { throw new Error("JSON 형식이 아닙니다"); } }
  return s;
}

// 실행할 것 { name, args } 만들기. values: { 인자 이름: 글자 }. 필수 인자가 비면 { missing: [이름…] }.
//   confirmed: 확인 창을 거쳤으면 Herdr가 스스로 묻는 명령에 confirmed: true. 앱 명령은 send로 문자열을 만들고 args는 없다.
export function buildRun(cmd, values = {}, { confirmed = false } = {}) {
  const args = {}, missing = [];
  for (const a of inputArgs(cmd)) {
    let v;
    try { v = parseValue(values[a.name], a.name); } catch (e) { return { error: `${a.name}: ${e.message}` }; }
    if (v === undefined) { if (a.required) missing.push(a.name); continue; }
    args[a.name] = v;
  }
  if (missing.length) return { missing };
  if (cmd.send) return { name: cmd.send(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v ?? "").trim()]))), args: null };
  if (confirmed && cmd.args.some((a) => a.name === SELF_CONFIRM_ARG)) args[SELF_CONFIRM_ARG] = true;
  return { name: cmd.name, args: Object.keys(args).length ? args : null };
}

// 최근 실행: 이름 배열(최근 것이 앞), 10개까지
export const RECENT_MAX = 10;
export function pushRecent(list, name) {
  return [name, ...(list ?? []).filter((n) => n !== name)].slice(0, RECENT_MAX);
}

// 검색 + 묶음. items: allCommands 결과에 keys(단축키 배열)를 붙인 것. 결과 [{ title, rows: [cmd…] }]
//   최근 실행한 명령은 맨 위 "최근" 묶음에만 둔다(아래에 다시 나오지 않게 — 한 줄은 한 번만 고를 수 있다).
//   검색: 이름·사람 말·설명 전체·단축키(기호와 원래 글자)에서 부분 일치. 이름·사람 말 일치를 앞에.
// 단축키 글자 비교: 수정 키 기호의 순서를 맞춘다(⌘⇧P와 ⇧⌘P를 같게)
const MOD_ORDER = "⌃⌥⇧⌘";
const normKey = (s) => [...s].filter((ch) => MOD_ORDER.includes(ch)).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b)).join("")
  + [...s].filter((ch) => !MOD_ORDER.includes(ch)).join("");

export function groups(items, query, recent) {
  const q = String(query ?? "").trim().toLowerCase(), qk = normKey(q);
  const score = (c) => {
    if (!q) return 0;
    if (c.name.toLowerCase().includes(q) || summary(c.about).toLowerCase().includes(q)) return 1;
    if ((c.keys ?? []).some((k) => normKey(k.label.toLowerCase()).includes(qk) || k.keys.toLowerCase().includes(q))) return 2;
    if (c.about.toLowerCase().includes(q)) return 3;
    return 0;
  };
  const hit = items.map((c) => [c, score(c)]).filter(([, s]) => !q || s > 0);
  const byName = new Map(hit.map(([c]) => [c.name, c]));
  const rec = (recent ?? []).map((n) => byName.get(n)).filter(Boolean);
  const recSet = new Set(rec.map((c) => c.name));
  const rest = hit.filter(([c]) => !recSet.has(c.name)).sort((a, b) => a[1] - b[1]).map(([c]) => c);
  const out = [];
  if (rec.length) out.push({ title: "최근", rows: rec });
  if (rest.length) out.push({ title: rec.length ? "모든 명령" : "", rows: rest });
  return out;
}
