// PR 앱의 순수 함수: gh pr diff 통 출력을 파일별로 나눈다.
// herdr·gpui를 import하지 않는다(node로 따로 시험할 수 있게). 줄 파싱·번호 매기기는 commit/git.js를 쓴다.

// git이 따옴표로 감싼 경로("a/\355\225\234.md")를 푼다. 8진 이스케이프는 UTF-8 바이트로 모아 한 번에 디코딩한다.
export function unquote(s) {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1), ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", a: "\x07", '"': '"', "\\": "\\" };
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += encodeURIComponent(ch); continue; }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) { out += "%" + parseInt(oct[0], 8).toString(16).padStart(2, "0"); i += 3; continue; }
    const e = body[i + 1];
    out += encodeURIComponent(ESC[e] ?? e ?? "");
    i += 1;
  }
  try { return decodeURIComponent(out); } catch { return body; }
}

// "a/경로" · "b/경로" 앞머리를 떼고 따옴표를 푼다. /dev/null은 null.
function side(raw) {
  const s = unquote(raw.trim().replace(/\t.*$/, ""));
  if (s === "/dev/null") return null;
  return s.replace(/^[ab]\//, "");
}

// 통 diff → { 경로: 그 파일의 diff 글(머리줄 포함) }. 경로는 새 경로(삭제된 파일은 옛 경로).
// 머리줄의 "diff --git a/x b/y"는 빈칸이 든 경로에서 모호하므로 +++ / rename to / --- 순으로 고른다.
export function splitDiff(stdout) {
  const out = {}, lines = stdout.split("\n");
  let start = -1;
  const flush = (end) => {
    if (start < 0) return;
    const chunk = lines.slice(start, end);
    let plus, minus, renamed, header;
    for (const l of chunk) {
      if (l.startsWith("@@")) break;
      if (l.startsWith("+++ ")) plus = side(l.slice(4));
      else if (l.startsWith("--- ")) minus = side(l.slice(4));
      else if (l.startsWith("rename to ")) renamed = unquote(l.slice(10));
      else if (l.startsWith("copy to ")) renamed = unquote(l.slice(8));
    }
    // 내용 없는 파일(바이너리·모드만 바뀜): 머리줄에서. 따옴표가 없으면 " b/"로 나눈다.
    const h = chunk[0].slice("diff --git ".length);
    const q = /^"(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)"$/.exec(h) ?? /^.* ("(?:[^"\\]|\\.)*")$/.exec(h);
    if (q) header = side(q[1].startsWith('"') ? q[1] : `"${q[1]}"`);
    else { const i = h.indexOf(" b/"); header = i >= 0 ? h.slice(i + 3) : h; }
    const path = plus ?? renamed ?? minus ?? header;
    if (path) out[path] = chunk.join("\n");
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) { flush(i); start = i; }
  }
  flush(lines.length);
  return out;
}
