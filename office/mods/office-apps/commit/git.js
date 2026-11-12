// 커밋 앱의 순수 함수: git 출력 파싱, diff 줄 번호 매기기, 시각 표시.
// herdr·gpui를 import하지 않는다(node로 따로 시험할 수 있게).

export const PAGE = 200;          // git log 한 번에 읽는 커밋 수
export const MAX_FILES = 1000;    // 한 커밋에서 보여 줄 파일 수
export const MAX_LINES = 1500;    // diff 줄 수 상한
export const MAX_COL = 4000;      // diff 한 줄 길이 상한
export const BIG = 20000;         // 추가+삭제가 이보다 많으면 diff를 읽지 않는다

// .git 아래에 아무것도 쓰지 않는 읽기 옵션(index lock·fsmonitor 없음).
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// git log --format 한 줄(필드 구분 \x1f): 전체 해시, 짧은 해시, 작성자, 작성 시각(초), 부모들, 제목
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%s";

export function parseLog(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [hash, short, author, at, parents, ...rest] = line.split("\x1f");
    return { hash, short, author, at: Number(at) || 0, parents: parents ? parents.split(" ") : [], subject: rest.join("\x1f") };
  }).filter((c) => c.hash);
}

// git show -s --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%s%x00%b
export const SHOW_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%s%x00%b";

export function parseShow(stdout) {
  const [hash, parents, author, email, at, committer, cat, subject, ...body] = stdout.split("\0");
  return {
    hash, parents: parents ? parents.split(" ").filter(Boolean) : [], author, email, at: Number(at) || 0,
    committer, cat: Number(cat) || 0, subject: subject ?? "", body: body.join("\0").replace(/\s+$/, ""),
  };
}

// --name-status -z -M: "M\0경로\0" 또는 "R100\0옛 경로\0새 경로\0"
export function parseNameStatus(stdout) {
  const f = stdout.split("\0"), out = [];
  for (let i = 0; i < f.length;) {
    const code = f[i];
    if (!code) { i++; continue; }
    const s = code[0];
    if (s === "R" || s === "C") { out.push({ status: s, old: f[i + 1], path: f[i + 2] }); i += 3; }
    else { out.push({ status: s, path: f[i + 1] }); i += 2; }
  }
  return out.filter((x) => x.path);
}

// --numstat -z -M: "추가\t삭제\t경로\0" 또는 "추가\t삭제\t\0옛 경로\0새 경로\0". 바이너리는 "-\t-".
export function parseNumstat(stdout) {
  const f = stdout.split("\0"), out = {};
  for (let i = 0; i < f.length;) {
    const entry = f[i];
    if (!entry) { i++; continue; }
    const [a, d, ...rest] = entry.split("\t");
    let path = rest.join("\t");
    if (!path) { path = f[i + 2]; i += 3; } else i += 1;
    if (path) out[path] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  return out;
}

// 이름·상태와 줄 수를 합친다. 넘치면 앞 MAX_FILES개만.
export function mergeFiles(nameStatus, numstat) {
  return nameStatus.slice(0, MAX_FILES).map((x) => ({ ...x, ...(numstat[x.path] ?? { add: 0, del: 0, binary: false }) }));
}

// 탭은 글자로 그려지지 않으니 4칸 단위 공백으로 바꾼다.
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// diff 출력 → 첫 @@부터 줄 목록(상한 적용).
export function diffLines(stdout) {
  const all = stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return null;
  const lines = all.slice(first);
  const out = lines.slice(0, MAX_LINES).map((l) => (l.length > MAX_COL ? l.slice(0, MAX_COL) + "… (줄 잘림)" : l));
  return { lines: out, cut: lines.length > MAX_LINES };
}

// 새 파일 내용 → 모두 추가된 diff 줄
export function addedLines(text) {
  const body = text.replace(/\n$/, "").split("\n");
  const lines = [`@@ -0,0 +1,${body.length} @@`, ...body.slice(0, MAX_LINES).map((l) => "+" + (l.length > MAX_COL ? l.slice(0, MAX_COL) + "… (줄 잘림)" : l))];
  return { lines, cut: body.length > MAX_LINES, count: body.length };
}

// diff 줄마다 한 번 번호를 매겨 둔다(그릴 때는 화면에 보이는 줄만).
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, old: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, next: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") return { kind, old: old++, next: next++, text: untab(line.slice(1)) || " " };
    return { kind: "", text: line };   // "\ No newline at end of file" 등
  });
}

// 글자 폭 대략(한글 등은 두 칸)
export function columns(text) {
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return n;
}

// 상대 시각: 방금 / N분 전 / N시간 전 / 어제 / N일 전 / 날짜
export function ago(sec, now = Date.now() / 1000) {
  const d = Math.max(0, now - sec);
  if (d < 60) return "방금";
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  if (d < 172800) return "어제";
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}일 전`;
  return date(sec, new Date(now * 1000).getFullYear() !== new Date(sec * 1000).getFullYear());
}

export function date(sec, withYear = true) {
  const t = new Date(sec * 1000);
  return withYear ? `${t.getFullYear()}. ${t.getMonth() + 1}. ${t.getDate()}.` : `${t.getMonth() + 1}월 ${t.getDate()}일`;
}

export function stamp(sec) {
  const t = new Date(sec * 1000), p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

// 검색: 제목·작성자·해시에 q가 들어간 커밋을 skip 다음부터 PAGE+1개. 끝까지 훑지 않게 다 찾으면 멈춘다.
// sh -c SEARCH search <q> <skip> <n>
export const SEARCH = `Q="$1" S="$2" N="$3"; git ${READ.join(" ")} log --format='${LOG_FORMAT}' HEAD | Q="$Q" awk -F '\\037' -v s="$S" -v n="$N" '
  BEGIN { q = tolower(ENVIRON["Q"]) }
  index(tolower($1 " " $3 " " $6), q) { c++; if (c > s) print; if (c >= s + n) exit }'`;

// 목록 오른쪽에 붙이는 짧은 상대 시각: 방금 / 5분 / 3시간 / 어제 / 4일 / 11. 3. / 24. 11. 3.
export function agoShort(sec, now = Date.now() / 1000) {
  const d = Math.max(0, now - sec);
  if (d < 60) return "방금";
  if (d < 3600) return `${Math.floor(d / 60)}분`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간`;
  if (d < 172800) return "어제";
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}일`;
  const t = new Date(sec * 1000);
  return new Date(now * 1000).getFullYear() === t.getFullYear()
    ? `${t.getMonth() + 1}. ${t.getDate()}.`
    : `${String(t.getFullYear()).slice(2)}. ${t.getMonth() + 1}. ${t.getDate()}.`;
}

// 본문에서 트레일러를 뺀 문단 목록. 이름이 알려진 트레일러 줄(Co-Authored-By 등)은 어디에 있든 빼고,
// 마지막 문단이 "키: 값" 줄로만 되어 있으면(git 트레일러 관례) 그 문단도 뺀다.
const KNOWN_TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|cc|change-id)\s*:/i;
const TRAILER = /^[A-Za-z][\w-]*:\s*\S/;
export function bodyParagraphs(body) {
  const paras = String(body ?? "").replace(/\r/g, "").split(/\n\s*\n/)
    .map((p) => p.split("\n").filter((l) => !KNOWN_TRAILER.test(l.trim())).join("\n").trim())
    .filter(Boolean);
  const last = paras[paras.length - 1];
  if (last && last.split("\n").every((l) => TRAILER.test(l.trim()))) paras.pop();
  return paras;
}

// ── diff 보기 공용(커밋 앱·PR 앱): 색, 줄 안 바뀐 구간, 좌우 정렬. 그리기는 commit/diffview.js ──

// 테마 바탕색이 어두운지(#rrggbb 밝기). 읽을 수 없으면 어둡다고 본다.
export function isDark(t) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(t?.background ?? ""));
  if (!m) return true;
  const [r, g, b] = m.slice(1, 4).map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

// diff 색. 추가는 초록, 삭제는 빨강. line: 줄 바탕, word: 줄 안에서 바뀐 글자, gutter: 줄 번호·기호 칸, sign: +/− 글자.
export function diffPalette(t, dark = isDark(t)) {
  return dark ? {
    addLine: "#2ea04333", addWord: "#2ea04380", addGutter: "#2ea04324", addSign: "#3fb950",
    delLine: "#f8514933", delWord: "#f8514980", delGutter: "#f8514924", delSign: "#f85149",
    hunkBg: "#388bfd1a", hunkFg: t?.dim ?? "#8b949e", emptyBg: "#8b949e0d",
  } : {
    addLine: "#e6ffec", addWord: "#abf2bc", addGutter: "#d5f7dd", addSign: "#1a7f37",
    delLine: "#ffebe9", delWord: "#ffc1bc", delGutter: "#ffdcd8", delSign: "#cf222e",
    hunkBg: "#ddf4ff", hunkFg: t?.dim ?? "#57606a", emptyBg: "#8c959f14",
  };
}

// 붙어 있는 삭제 줄 묶음과 바로 다음 추가 줄 묶음을 차례로 짝지어, 공통 앞뒤를 뺀 가운데를 row.hl = [시작, 끝](글자 위치)으로 단다.
// 거의 다 바뀐 줄(공통 부분이 짧은 줄)은 강조하지 않는다(줄 전체가 진해지면 오히려 안 보인다).
export function wordSpans(rows) {
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "-") { i++; continue; }
    let d = i; while (d < rows.length && rows[d].kind === "-") d++;
    let a = d; while (a < rows.length && rows[a].kind === "+") a++;
    for (let k = 0; k < Math.min(d - i, a - d); k++) mark(rows[i + k], rows[d + k]);
    i = a;
  }
  return rows;
}

function mark(del, add) {
  const x = Array.from(del.text), y = Array.from(add.text);
  let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const keep = p + s, longest = Math.max(x.length, y.length);
  if (!longest || keep < longest * 0.25) return;
  if (p < x.length - s) del.hl = [p, x.length - s];
  if (p < y.length - s) add.hl = [p, y.length - s];
}

// 좌우 보기용 줄: { hunk } 또는 { left, right }(없는 쪽은 null). 삭제 묶음과 추가 묶음을 같은 높이로 맞춘다.
export function splitRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.kind === "@") { out.push({ hunk: r.text }); i++; continue; }
    if (r.kind === "-" || r.kind === "+") {
      let d = i; while (d < rows.length && rows[d].kind === "-") d++;
      let a = d; while (a < rows.length && rows[a].kind === "+") a++;
      const dels = rows.slice(i, d), adds = rows.slice(d, a);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      i = a; continue;
    }
    out.push({ left: r, right: r });   // 맥락 줄, "\ No newline at end of file" 등은 양쪽에
    i++;
  }
  return out;
}

// 목록 줄용 제목 나누기: Conventional Commits 접두 "type(scope)!: 제목"이면 { tag, text }.
//   tag는 scope(없으면 type), 깨는 변경(!)이면 끝에 "!". 접두가 아니면(Merge …, Revert …, 그 밖) { tag: null, text: 원문 }.
export function splitSubject(s) {
  const src = String(s ?? "");
  const m = /^([a-z][a-z0-9-]*)(?:\(([^()\s][^()]*)\))?(!)?:\s+(\S.*)$/i.exec(src);
  if (!m) return { tag: null, text: src };
  return { tag: `${m[2] ?? m[1]}${m[3] ?? ""}`, text: m[4] };
}
