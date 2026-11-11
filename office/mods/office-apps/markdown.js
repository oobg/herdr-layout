// 마크다운을 GitHub처럼 보이게 하는 전처리. TextView.markdown이 이미 그리는 것(표·체크박스·취소선·자동 링크·인용)은 그대로 넘기고,
// 못 그리는 것만 블록으로 떼어 낸다.
//   text   { text }                 TextView.markdown에 넘길 일반 구간
//   code   { lang, text }           코드 블록(파일 앱이 읽기 전용 편집기로 색을 입힌다)
//   alert  { type, text }           > [!NOTE] 같은 알림
//   images { items: [{src, alt, link, width}], center }   그림만 있는 줄(배지 여러 개면 한 줄에 나란히)
// 각주([^1])는 본문에 위첨자 번호로 바꾸고, 내용은 문서 끝에 모은다.

const ALERTS = new Set(["note", "tip", "important", "warning", "caution"]);
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`{]*)/;
const LINK_DEF = /^ {0,3}\[([^\]^][^\]]*)\]:\s*<?(\S+?)>?(?:\s+["'(].*["')])?\s*$/;
const FOOT_DEF = /^ {0,3}\[\^([^\]]+)\]:\s?(.*)$/;
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n) => String(n).split("").map((d) => SUP[d]).join("");

// 코드 블록 언어 이름 → 편집기 언어 id
const LANG = { javascript: "js", jsx: "js", ts: "js", typescript: "js", tsx: "js", mjs: "js", cjs: "js", node: "js",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", shellscript: "bash", py: "python", python3: "python",
  yml: "yaml", toml: "yaml", jsonc: "json", json5: "json", rs: "rust", rb: "ruby", kt: "kotlin", htm: "html",
  xml: "html", svelte: "html", vue: "html", md: "markdown", golang: "go", "c++": "cpp", cs: "csharp" };
export const codeLang = (l) => { const k = String(l || "").toLowerCase(); return LANG[k] ?? (k || "text"); };

// 줄 하나가 그림만으로 되어 있으면 그림 목록, 아니면 null
function imageLine(line, refs) {
  const items = [];
  let rest = line
    // [![alt](src)](link)  링크로 감싼 그림(배지)
    .replace(/\[!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt, src, link) => { items.push({ alt, src, link }); return ""; })
    .replace(/\[!\[([^\]]*)\]\[([^\]]*)\]\]\(\s*<?([^)\s>]+)>?\s*\)/g, (_m, alt, ref, link) => { items.push({ alt, src: refs.get((ref || alt).toLowerCase()), link }); return ""; })
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt, src) => { items.push({ alt, src }); return ""; })
    .replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (_m, alt, ref) => { items.push({ alt, src: refs.get((ref || alt).toLowerCase()) }); return ""; })
    // <a href><img></a>, <img> (속성 순서 무관)
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>\s*(<img\s[^>]*>)\s*<\/a>/gi, (_m, link, img) => { const it = imgTag(img); if (it) items.push({ ...it, link }); return ""; })
    .replace(/<img\s[^>]*>/gi, (img) => { const it = imgTag(img); if (it) items.push(it); return ""; })
    // 그림을 감싸는 태그(<p align=center>, <picture>, <source> 등)는 무시
    .replace(/<\/?(p|div|a|picture|source|br|center)\b[^>]*>/gi, "");
  if (!items.length || rest.trim()) return null;
  return { items: items.filter((i) => i.src), center: /\balign\s*=\s*["']?center|<center\b/i.test(line) };
}

function imgTag(tag) {
  const attr = (n) => new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const src = attr("src");
  if (!src) return null;
  const width = Number(attr("width")) || null;
  return { src, alt: attr("alt") ?? "", width };
}

// 인라인 코드(`...`)를 건드리지 않고 바꾸기
function outsideCode(line, fn) {
  return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : fn(part))).join("");
}

export function parseMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");

  // 1) 코드 밖의 각주 정의·링크 참조 정의를 모은다
  const notes = new Map(), refs = new Map(), defLines = [], body = [];
  for (let i = 0, fence = null; i < lines.length; i++) {
    const line = lines[i], f = FENCE.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2]) fence = null; body.push(line); continue; }
    if (f) { fence = f[1]; body.push(line); continue; }
    const fd = FOOT_DEF.exec(line);
    if (fd) {
      let text = fd[2];
      while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1])) text += " " + lines[++i].trim();
      notes.set(fd[1].toLowerCase(), text);
      continue;
    }
    const ld = LINK_DEF.exec(line);
    if (ld) { refs.set(ld[1].toLowerCase(), ld[2]); defLines.push(line); continue; }
    body.push(line);
  }

  // 2) 블록으로 나누기 + 각주 참조를 번호로
  const order = new Map(), blocks = [];
  let text = [];
  const ref = (s) => s.replace(/\[\^([^\]]+)\]/g, (m, id) => {
    const k = id.toLowerCase();
    if (!notes.has(k)) return m;
    if (!order.has(k)) order.set(k, order.size + 1);
    return sup(order.get(k));
  });
  const flush = () => {
    const t = text.join("\n");
    if (t.trim()) blocks.push({ kind: "text", text: t });
    text = [];
  };
  for (let i = 0; i < body.length; i++) {
    const line = body[i], f = FENCE.exec(line);
    if (f) {
      const code = [];
      for (i++; i < body.length; i++) {
        const c = FENCE.exec(body[i]);
        if (c && c[1][0] === f[1][0] && c[1].length >= f[1].length && !c[2]) break;
        code.push(body[i]);
      }
      // 들여쓰기된 펜스(목록 안)는 그 들여쓰기만큼 걷어 낸다
      const pad = /^ */.exec(line)[0].length;
      flush();
      blocks.push({ kind: "code", lang: f[2], text: code.map((c) => c.slice(Math.min(pad, /^ */.exec(c)[0].length))).join("\n") });
      continue;
    }
    const a = /^ {0,3}>\s*\[!(\w+)\]\s*$/.exec(line);
    if (a && ALERTS.has(a[1].toLowerCase())) {
      const inner = [];
      while (i + 1 < body.length && /^ {0,3}>/.test(body[i + 1])) inner.push(body[++i].replace(/^ {0,3}> ?/, ""));
      flush();
      blocks.push({ kind: "alert", type: a[1].toLowerCase(), text: ref(inner.join("\n")) });
      continue;
    }
    const imgs = line.trim() ? imageLine(line, refs) : null;
    if (imgs?.items.length) { flush(); blocks.push({ kind: "images", ...imgs }); continue; }
    text.push(outsideCode(line, ref));
  }
  flush();

  // 3) 각주 모음
  if (order.size) {
    const list = [...order].map(([k, n]) => `${n}. ${notes.get(k)}`).join("\n");
    blocks.push({ kind: "text", text: `---\n\n${list}`, notes: true });
  }

  // 구간을 나누면 참조형 링크([글][id])의 정의가 다른 구간에 남으므로, 정의를 모든 글 구간에 붙인다
  if (defLines.length) {
    const defs = "\n\n" + defLines.join("\n");
    for (const b of blocks) if (b.kind === "text" || b.kind === "alert") b.text += defs;
  }
  return blocks;
}
