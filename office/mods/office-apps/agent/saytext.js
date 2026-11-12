// 마지막 말을 요약 칸에 그릴 마크다운 블록으로(herdr·gpui를 import하지 않아 node로 시험한다). 그리기는 agent/say.js.
//   - 줄바꿈을 살린다: 마크다운은 한 줄 띄움을 이어 붙이므로, 이어지는 글 줄 끝에 강제 줄바꿈(두 칸)을 붙인다
//     (코드 블록·표·목록이 이어지는 줄·빈 줄 앞은 그대로)
//   - 큰 제목(# …)은 요약 칸에 맞게 굵은 한 줄로 낮춘다(렌더러에 작은 제목 모드가 없다)
//   - 접힌 모양은 앞 HEAD_N줄(빈 줄 빼고)까지, 넘치면 more: true
//   - 블록 나누기는 파일 앱 뷰어와 같은 parseMarkdown(markdown.js). 같은 글이면 다시 나누지 않는다(캐시).
import { parseMarkdown } from "../markdown.js";

export const HEAD_N = 6;
const HEAD_CHARS = 480;     // 줄이 적어도 글이 이만큼 넘으면 자른다
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE = /^\s*\|/;
const LIST = /^\s*([-*+]|\d+[.)])\s/;

// 글 → 그릴 글(제목 낮추기 + 줄바꿈 살리기). 코드 블록 안은 건드리지 않는다.
export function prepare(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; out.push(line); continue; }
    if (f) { fence = f[1]; out.push(line); continue; }
    const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) line = h[1] ? `**${h[1]}**` : "";
    const next = lines[i + 1];
    const soft = next !== undefined && next.trim() && line.trim() && !FENCE.test(next)
      && !TABLE.test(line) && !TABLE.test(next) && !LIST.test(next) && !/^\s*>/.test(next) && !/(\s{2}|\\)$/.test(line);
    out.push(soft ? `${line.trimEnd()}  ` : line);
  }
  return out.join("\n");
}

// 앞 HEAD_N줄(빈 줄 빼고, 코드 블록 안 줄도 센다) 또는 HEAD_CHARS자까지 자른 글과, 잘렸는지.
//   글자 수가 넘치면 그 줄 앞에서 자르고, 첫 줄부터 넘치면 그 줄 안(낱말 사이)에서 자른다.
export function head(src, n = HEAD_N) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  let count = 0, chars = 0, i = 0;
  for (; i < lines.length; i++) {
    if (lines[i].trim()) count++;
    if (count > n) break;
    if (chars + lines[i].length > HEAD_CHARS) {
      if (lines.slice(0, i).some((l) => l.trim())) break;
      const cut = lines[i].slice(0, HEAD_CHARS), sp = cut.lastIndexOf(" ");
      return { text: [...lines.slice(0, i), `${(sp > HEAD_CHARS / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`].join("\n").trim(), more: true };
    }
    chars += lines[i].length + 1;
  }
  if (i >= lines.length) return { text: lines.join("\n").trim(), more: false };
  // 코드 블록을 연 줄 바로 뒤나 블록 안 두 줄 안에서 잘리면 빈 상자만 남으므로 그 블록 앞에서 자른다
  let open = -1;
  for (let j = 0, fence = null; j < i; j++) {
    const f = FENCE.exec(lines[j]);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { fence = null; open = -1; } continue; }
    if (f) { fence = f[1]; open = j; }
  }
  if (open > 0 && i - open <= 2) i = open;
  return { text: lines.slice(0, i).join("\n").trimEnd(), more: true };
}

// 마지막 말 → { head: 블록[], full: 블록[], more }. 같은 글이면 지난 결과(파싱은 말이 바뀔 때만).
const CACHE = new Map();
export function sayBlocks(src) {
  const key = String(src ?? "");
  let v = CACHE.get(key);
  if (v) return v;
  const h = head(key);
  const full = parseMarkdown(prepare(key));
  v = { full, head: h.more ? parseMarkdown(prepare(h.text)) : full, more: h.more };
  if (CACHE.size >= 64) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, v);
  return v;
}
