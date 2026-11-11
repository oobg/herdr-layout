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
