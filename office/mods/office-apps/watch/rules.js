// 출력 감시 앱의 규칙(순수 함수, herdr를 import하지 않아 node로 시험할 수 있다).
//   lines(text)            hc read 글 → 줄 배열(ANSI 색 코드·줄 끝 공백 제거, 끝의 빈 줄 제거)
//   isHit(line)            오류 줄인가(예외 문구를 지운 뒤 규칙을 본다)
//   fresh(prev, cur, how)  지난번 줄과 비교해 새로 생긴 줄 { start, lines, overlap }
//   scan(cur, start)       새 줄에서 걸린 줄과 앞뒤 2줄 문맥 [{ line, before, after, key, at }]
//   merge(items, ...)      걸린 줄을 목록에 더한다(같은 터미널·같은 줄은 ×n으로 묶는다)

export const CONTEXT = 2;   // 앞뒤 문맥 줄 수
export const MAX_ITEMS = 200;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => String(s).replace(ANSI, "");

export function lines(text) {
  const out = stripAnsi(text ?? "").replace(/\r(?!\n)/g, "\n").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

// 걸리는 줄. raw: 예외 문구를 지우기 전 줄에서 본다(경로·HTTP 버전이 들어간 규칙).
export const RULES = [
  { name: "error", re: /\berror\b/i },
  { name: "Error:", re: /Error:/ },
  { name: "ERR!", re: /\bERR!/ },
  { name: "FAIL", re: /\bFAIL(ED|URE)?\b/ },
  { name: "failed", re: /\bfail(ed|ing|ure)\b/i },
  { name: "panic", re: /\bpanic(ked)?\b/i },
  { name: "Traceback", re: /\bTraceback\b/ },
  { name: "Exception", re: /Exception\b/ },
  { name: "✗", re: /[✗✘]/ },
  { name: "exit code", re: /\bexit(ed)?( with)? (code|status) [1-9]\d*/i },
  { name: "TS", re: /\bTS\d{4}\b/ },
  { name: "Cannot find module", re: /Cannot find module/ },
  { name: "HTTP 5xx", raw: true, re: /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b.*\s5\d\d\b|HTTP\/[\d.]+"?\s+5\d\d\b|\b(status|code)[:= ]+5\d\d\b/i },
];

// 오탐을 줄이는 예외: 이 문구는 지운 뒤 규칙을 본다.
const EXCEPT = [
  /\b(0|no|zero|without|none)\s+(errors?|failures?|failed|failing|problems?|exceptions?)\b/gi,  // 0 errors, no errors
  /\b(errors?|failures?|failed|failing)[:=]?\s*0\b(?![.\d])/gi,                               // errors: 0, failed=0
  /\berrors?[\s-](handling|handler|handlers|boundary|boundaries|page|pages|message|messages|codes?|types?|states?|free|prone|reporting|tracking|budget)\b/gi, // error handling
  /\b(on|if|handle|log|ignore|catch|throw|report|returns?|any)[\s_]?errors?\b/gi,              // onError, if error, log error
  /\b(fail|failing)[\s-](fast|safe|over|soft)\b/gi,                                          // fail-fast
  /\bno[\s-]?fail\b/gi,
  /\bnew \w*Error\(|\berrors?\s*[:=]\s*(null|undefined|false|nil|None|nullptr)\b/gi,          // 코드: new Error(, error: null
  /--?[\w-]*(error|fail|exit)[\w-]*/gi,                                                       // --no-error-on-..., --bail
  /\S*[/\\]\S*(error|fail|exception)\S*|\S*(error|fail|exception)\S*\.(js|ts|tsx|jsx|py|rs|go|md|log|json|css|html)\b/gi, // src/error.ts, error.log
];
// 줄 전체를 보지 않는 경우: 프롬프트 테두리(╭─ ╰─), diff 머리, 빈 줄
const SKIP_LINE = /^\s*[╭╰│]─|^(diff --git|index [0-9a-f]+\.\.|@@ )/;

export function isHit(line) {
  const raw = stripAnsi(line);
  if (!raw.trim() || SKIP_LINE.test(raw)) return null;
  let s = raw;
  for (const re of EXCEPT) s = s.replace(re, " ");
  for (const r of RULES) if (r.re.test(r.raw ? raw : s)) return r.name;
  return null;
}

// 같은 줄을 묶는 키: 숫자·시각·주소처럼 매번 바뀌는 부분을 지운다
export function keyOf(line) {
  return stripAnsi(line).replace(/0x[0-9a-f]+/gi, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

// 지난 줄과 비교해 새로 생긴 줄. 마지막 줄은 아직 쓰이는 중(프롬프트 입력 등)일 수 있어 기준에서 빼고,
//   그 앞 최대 3줄을 기준으로 새 글에서 가장 뒤의 같은 자리를 찾는다. 그 뒤가 새 줄(마지막 줄은 다시 본다).
//   full: 전체 화면 앱(how "screen"·"stitched"). 제자리에서 다시 그리므로 지난 화면에 없던 줄만(개수까지 센다).
export function fresh(prev, cur, how) {
  if (!prev) return { start: 0, lines: cur, overlap: false };
  if (how && how !== "history") {
    const seen = new Map();
    for (const l of prev) seen.set(l, (seen.get(l) ?? 0) + 1);
    const idx = [];
    cur.forEach((l, i) => { const n = seen.get(l) ?? 0; if (n > 0) seen.set(l, n - 1); else idx.push(i); });
    return { idx, overlap: true, screen: true };
  }
  const body = prev.slice(0, -1);
  const tail = prev[prev.length - 1];
  const anchor = [];
  for (let i = body.length - 1; i >= 0 && anchor.length < 3; i--) if (body[i].trim()) anchor.unshift(body[i]);
  if (!anchor.length) return { start: 0, overlap: false };
  for (let j = cur.length - 1; j >= anchor.length - 1; j--) {
    // anchor의 줄들이 cur[j]에서 끝나는 빈 줄 아닌 줄들과 같은가
    let k = anchor.length - 1, p = j;
    while (k >= 0 && p >= 0) {
      if (!cur[p].trim()) { p--; continue; }
      if (cur[p] !== anchor[k]) break;
      k--; p--;
    }
    if (k < 0) {
      let start = j + 1;
      // 지난번 마지막 줄이 그대로면 이미 본 줄이다
      while (start < cur.length && !cur[start].trim()) start++;
      if (start < cur.length && cur[start] === tail) start++;
      return { start, overlap: true };
    }
  }
  return { start: 0, overlap: false };
}

// cur의 줄 번호들(idx) 또는 start부터 끝까지에서 걸린 줄과 문맥
export function scan(cur, from) {
  const idx = Array.isArray(from) ? from : Array.from({ length: Math.max(0, cur.length - from) }, (_, i) => from + i);
  const out = [];
  for (const i of idx) {
    const rule = isHit(cur[i]);
    if (!rule) continue;
    out.push({ line: cur[i], rule, key: keyOf(cur[i]), at: i,
      before: cur.slice(Math.max(0, i - CONTEXT), i), after: cur.slice(i + 1, i + 1 + CONTEXT) });
  }
  return out;
}

// 걸린 줄을 목록에 더한다. items: [{ id, terminal, key, line, rule, before, after, count, first, last }]
//   count: 기준 줄을 찾았을 때(overlap)만 같은 줄을 ×n으로 센다. 못 찾았으면(화면을 지움·창 크기 바뀜·전체 화면 앱)
//   이미 있는 줄은 세지 않고 새 줄만 더한다. 지운 줄(gone)도 같은 규칙으로 되살아난다.
export function merge(items, terminal, hits, now, count) {
  const out = items.slice();
  for (const h of hits) {
    const i = out.findIndex((x) => x.terminal === terminal && x.key === h.key);
    if (i >= 0) {
      if (!count) continue;
      const x = out[i];
      out[i] = { ...x, line: h.line, before: h.before, after: h.after, count: x.count + 1, last: now };
    } else {
      out.push({ id: `${terminal}|${h.key}|${now}`, terminal, key: h.key, line: h.line, rule: h.rule,
        before: h.before, after: h.after, count: 1, first: now, last: now });
    }
  }
  out.sort((a, b) => b.last - a.last);
  return out.slice(0, MAX_ITEMS);
}

// 지난번 끝에서 걸려 뒤 문맥이 모자란 줄을, 이번 새 줄의 앞부분으로 채운다
export function fillAfter(items, terminal, newLines) {
  if (!newLines.length) return items;
  return items.map((x) => x.terminal === terminal && x.after.length < CONTEXT
    ? { ...x, after: [...x.after, ...newLines.slice(0, CONTEXT - x.after.length)] } : x);
}

// 에이전트에게 보낼 글
export function message(name, item) {
  const ctx = [...item.before, item.line, ...item.after].join("\n");
  return `${name}에서 이런 오류가 났어요:\n${ctx}`;
}
