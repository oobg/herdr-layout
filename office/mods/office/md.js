// 오버뷰의 "마지막 말"을 그리는 작은 마크다운 파서. herdr·gpui를 import하지 않는 순수 함수라 node로 시험한다.
//   office-apps/markdown.js와 하는 일이 겹치지만, 모드는 자기 폴더 밖을 import할 수 없어(../office-apps/… 는
//   "resolves outside the application directory") 여기에 필요한 만큼만 따로 둔다. 저쪽은 TextView.markdown 전처리,
//   이쪽은 좁은 패널에 직접 그릴 블록·낱말 조각을 낸다.
//
// 블록(원문 줄마다 하나, 줄바꿈을 그대로 살린다)
//   { kind: "h",    level, words }            제목(작게: 굵게만)
//   { kind: "p",    words }                   문단 줄
//   { kind: "li",   depth, marker, words }    목록 항목(marker: "•" 또는 "1.")
//   { kind: "code", lang, lines }             코드 블록(안 닫힌 펜스도 끝까지 코드)
//   gap: true  앞에 빈 줄이 있었다(블록 사이를 조금 띄운다)
// 낱말 조각(words): { kind: "text" | "b" | "code" | "link", text, url?, space }  space: 뒤에 띄어쓰기가 있다
//   좁은 패널에서 굵게·코드·링크가 섞인 줄을 낱말 단위로 줄바꿈하려고 낱말마다 조각으로 나눈다.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

// 인라인: **굵게**/__굵게__, `코드`, [글](url), 맨 http(s) 주소. *기울임*은 별표만 걷어 낸다.
const INLINE = /(\*\*|__)(.+?)\1|`([^`]+)`|\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function spans(line) {
  const out = [];
  let last = 0, m;
  const text = (s) => { if (s) out.push({ kind: "text", text: s.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s).,!?:;])/g, "$1$2") }); };
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(line))) {
    text(line.slice(last, m.index));
    if (m[2] !== undefined) out.push({ kind: "b", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "code", text: m[3] });
    else if (m[4] !== undefined) out.push({ kind: "link", text: m[4].replace(/`/g, ""), url: m[5] });
    else out.push({ kind: "link", text: m[6], url: m[6] });
    last = m.index + m[0].length;
  }
  text(line.slice(last));
  return out;
}

// 조각을 낱말로. 코드 조각은 띄어쓰기가 있어도 한 덩어리로 둔다(짧은 인라인 코드가 대부분).
export function words(sp) {
  const out = [];
  for (const s of sp) {
    if (s.kind === "code") { out.push({ ...s, space: false }); continue; }
    for (const part of s.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { if (out.length) out[out.length - 1].space = true; continue; }
      out.push({ ...s, text: part, space: false });
    }
  }
  // 코드 조각 앞뒤의 띄어쓰기: 원문에서 앞 글 조각이 공백으로 끝났으면 위에서 이미 표시된다.
  return out;
}

export function parse(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let gap = false;
  const push = (b) => { blocks.push(gap && blocks.length ? { ...b, gap: true } : b); gap = false; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      const pad = /^ */.exec(line)[0].length, code = [];
      for (i++; i < lines.length; i++) {
        const c = FENCE.exec(lines[i]);
        if (c && c[1][0] === f[1][0] && c[1].length >= f[1].length && !c[2]) break;
        code.push(lines[i].slice(Math.min(pad, /^ */.exec(lines[i])[0].length)));
      }
      while (code.length && !code[code.length - 1].trim()) code.pop();
      push({ kind: "code", lang: f[2] || "", lines: code });
      continue;
    }
    if (!line.trim()) { gap = true; continue; }
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { gap = true; continue; }   // 구분선은 빈 줄로
    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { push({ kind: "h", level: h[1].length, words: words(spans(h[2])) }); continue; }
    const li = /^(\s*)([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (li) {
      const depth = Math.min(3, Math.floor(li[1].replace(/\t/g, "  ").length / 2));
      const marker = li[3] ? (/x/i.test(li[3]) ? "☑" : "☐") : /\d/.test(li[2]) ? li[2].replace(")", ".") : "•";
      push({ kind: "li", depth, marker, words: words(spans(li[4])) });
      continue;
    }
    const q = /^ {0,3}>\s?(.*)$/.exec(line);   // 인용은 문단으로(꺾쇠만 걷는다)
    push({ kind: "p", words: words(spans(q ? q[1] : line.trim())) });
  }
  return blocks;
}

// 글 너비 단위: 한글·CJK·이모지는 2, 나머지 1
const unit = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const lineUnits = (ws) => ws.reduce((n, w) => n + unit(w.text) + (w.space ? 1 : 0), 0);

// 낱말 조각을 앞에서 u 단위까지만 남기고 "…"를 붙인다.
function clipWords(ws, u) {
  const out = [];
  let left = u;
  for (const w of ws) {
    const n = unit(w.text) + (w.space ? 1 : 0);
    if (n <= left) { out.push(w); left -= n; continue; }
    let cut = "";
    for (const ch of w.text) { const c = unit(ch); if (c > left - 1) break; cut += ch; left -= c; }
    if (cut) out.push({ ...w, text: `${cut}…`, space: false });
    else if (out.length) out[out.length - 1] = { ...out[out.length - 1], text: `${out[out.length - 1].text}…`, space: false };
    return out;
  }
  return out;
}

// 앞 max줄만 남긴다. 줄 수는 원문 줄 기준이고, 긴 줄은 패널 한 줄을 width 단위로 어림해 여러 줄로 센다
// (화면 줄 수를 잴 방법이 없어 어림한다). 코드 줄은 줄바꿈 없이 그리므로 한 줄. 반환: { blocks, more }
export function cut(blocks, max = 4, width = 46) {
  const out = [];
  let left = max;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (left <= 0) return { blocks: out, more: true };
    if (b.kind === "code") {
      if (b.lines.length <= left) { out.push(b); left -= Math.max(1, b.lines.length); continue; }
      out.push({ ...b, lines: [...b.lines.slice(0, left - 1), `${b.lines[left - 1]} …`] });
      return { blocks: out, more: true };
    }
    const pad = b.kind === "li" ? 2 + b.depth * 2 : 0;
    const need = Math.max(1, Math.ceil(lineUnits(b.words) / (width - pad)));
    if (need <= left) { out.push(b); left -= need; continue; }
    out.push({ ...b, words: clipWords(b.words, left * (width - pad)) });
    return { blocks: out, more: true };
  }
  return { blocks: out, more: false };
}

// 링크는 http(s)만 연다.
export const safeUrl = (url) => (/^https?:\/\/\S+$/i.test(String(url ?? "")) ? String(url) : null);
