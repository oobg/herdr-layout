// 메모 앱의 순수 함수: 파일 이름, 파일 머리줄, 할 일 파싱·토글·추가, 보낼 글.
//   herdr를 import하지 않아 node로 시험할 수 있다(notes/test.mjs).
//
// 파일: <appHome>/data/office-apps/notes/<해시>.md  (원격 스페이스는 notes/<기기>/<해시>.md, 둘 다 이 Mac에 둔다)
//   해시 = "<기기>|<레포 루트>"(이 컴퓨터는 기기 자리가 빈 글). 파일 이름만으로는 어느 작업 공간인지 알 수 없어서
//   첫 줄에 머리줄 주석을 둔다: <!-- herdr-notes {"root":..., "machine":..., "name":..., "updated":...} -->
//   보내기·복사에는 머리줄을 빼고 본문만 쓴다.
// 본문: 마크다운 그대로. 할 일은 "- [ ] …" / "- [x] …" 줄(코드 블록 안은 빼고, 들여쓴 줄·*·+ 글머리도).
//   화면에서는 할 일 줄을 위 체크 목록으로, 나머지를 아래 메모 편집기로 나눠 보이고, 저장할 때 할 일을 맨 앞에 모은다.

export const DIR = "data/office-apps/notes";
const HEAD = /^<!-- herdr-notes (\{.*\}) -->\r?\n?/;
const TODO = /^(\s*[-*+]\s+\[)([ xX])(\]\s?)(.*)$/;
const FENCE = /^\s*(```|~~~)/;

// viewers.js의 hash(31을 곱해 더하기)에 FNV-1a를 이어 붙인다: 같은 식을 씨앗만 바꿔 두 번 돌리면
//   길이가 같은 두 경로가 한쪽에서 겹칠 때 다른 쪽도 겹치므로, 다른 식이어야 64비트 구실을 한다.
function h31(s) { let h = 0; for (const ch of String(s)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0; return h; }
function fnv(s) { let h = 0x811c9dc5; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
export function hash(s) { return h31(s).toString(36) + fnv(s).toString(36); }

// 기기 이름을 폴더 이름으로: 경로를 깨는 글자만 바꾼다.
const safe = (m) => String(m).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";

export const noteId = ({ root, machine }) => `${machine ?? ""}|${root}`;

// appHome 기준 상대 경로
export function notePath({ root, machine }) {
  const name = `${hash(noteId({ root, machine }))}.md`;
  return machine ? `${DIR}/${safe(machine)}/${name}` : `${DIR}/${name}`;
}

// 레포 루트 경로 → 보이는 이름(마지막 폴더, 홈이면 "홈")
export function rootName(root, home) {
  if (!root || root === "~" || root === home || /^\/(Users|home)\/[^/]+\/?$/.test(root) || root === "/root") return "홈";
  return root.replace(/\/+$/, "").split("/").pop() || root;
}

// 파일 글 → { meta, body }. 머리줄이 없거나 깨졌으면 meta는 null.
export function parseFile(text) {
  const s = String(text ?? "");
  const m = HEAD.exec(s);
  if (!m) return { meta: null, body: s.replace(/\r\n/g, "\n") };
  let meta = null;
  try { meta = JSON.parse(m[1]); } catch { meta = null; }
  return { meta, body: s.slice(m[0].length).replace(/\r\n/g, "\n") };
}

export function serialize(meta, body) {
  // 주석이 끝나지 않게 "-->"를 막는다(이름·경로에 들어 있을 일은 거의 없다)
  const json = JSON.stringify(meta).replace(/-->/g, "--\\u003e");
  return `<!-- herdr-notes ${json} -->\n${body}`;
}

// 본문의 줄마다: 할 일이면 { line, done, text }. 코드 블록 안은 할 일로 보지 않는다.
export function parseTodos(body) {
  const out = [];
  let fence = false;
  String(body ?? "").replace(/\r\n/g, "\n").split("\n").forEach((l, i) => {
    if (FENCE.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = TODO.exec(l);
    if (m) out.push({ line: i, done: m[2] !== " ", text: m[4] });
  });
  return out;
}

export const openCount = (body) => parseTodos(body).filter((x) => !x.done).length;

// 본문 → { todos: 할 일 줄들(원문), memo: 나머지 }. 할 일 사이·앞뒤의 빈 줄은 메모에서 정리한다.
export function split(body) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const at = new Set(parseTodos(body).map((x) => x.line));
  const todos = lines.filter((_l, i) => at.has(i));
  const memo = lines.filter((_l, i) => !at.has(i)).join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return { todos, memo };
}

// 할 일 줄들 + 메모 → 본문. 할 일을 맨 앞에, 빈 줄 하나 띄우고 메모.
export function join(todos, memo) {
  const t = todos.join("\n"), m = String(memo ?? "").replace(/\s+$/, "");
  if (!t) return m ? `${m}\n` : "";
  return m ? `${t}\n\n${m}\n` : `${t}\n`;
}

// 할 일 줄 하나를 뒤집는다(줄 원문 → 새 줄). 할 일이 아니면 그대로.
export function toggleLine(line) {
  const m = TODO.exec(line);
  if (!m) return line;
  return `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}${m[4]}`;
}

// 본문의 i번째 줄을 뒤집는다
export function toggleTodo(body, line) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  if (line < 0 || line >= lines.length) return body;
  lines[line] = toggleLine(lines[line]);
  return lines.join("\n");
}

// 새 할 일 줄. 앞의 "- [ ]"·"[ ]"를 이미 적었으면 떼어 낸다. 빈 글이면 null.
export function todoLine(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim().replace(/^[-*+]\s+/, "").replace(/^\[[ xX]?\]\s*/, "");
  return s ? `- [ ] ${s}` : null;
}

// 본문에 할 일을 더한다: 마지막 할 일 줄 뒤에, 할 일이 없으면 맨 앞에.
export function addTodo(body, text) {
  const line = todoLine(text);
  if (!line) return body;
  const { todos, memo } = split(body);
  return join([...todos, line], memo);
}

// 끝낸 할 일 줄을 지운다
export function clearDone(body) {
  const { todos, memo } = split(body);
  return join(todos.filter((l) => !parseTodos(l)[0]?.done), memo);
}

// 에이전트에게 보낼 글. which: "all" | "todo". 첫 줄은 대시로 시작하지 않는 머리말
//   (hc send가 "- [ ]"를 옵션으로 읽지 않게, 받는 쪽이 무엇인지 알게).
export function payload(body, name, which) {
  const b = String(body ?? "").trim();
  if (which === "todo") {
    const open = parseTodos(b).filter((x) => !x.done).map((x) => `- [ ] ${x.text}`);
    return open.length ? `${name} 작업 공간의 남은 할 일:\n${open.join("\n")}` : null;
  }
  return b ? `${name} 작업 공간 메모:\n${b}` : null;
}

// "방금", "3분 전", "2시간 전", "어제", "5일 전", 오래됐으면 "11월 3일"
export function ago(at, now = Date.now()) {
  if (!at) return "";
  const m = Math.max(0, Math.floor((now - at) / 60000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  const d = Math.floor(m / 1440);
  if (d === 1) return "어제";
  if (d < 7) return `${d}일 전`;
  const t = new Date(at);
  return `${t.getMonth() + 1}월 ${t.getDate()}일`;
}

// 목록 순서: 지금 작업 공간이 맨 위, 나머지는 최근에 고친 순
export function order(notes, hereId) {
  return [...notes].sort((a, b) => (b.id === hereId) - (a.id === hereId) || (b.updated ?? 0) - (a.updated ?? 0));
}
