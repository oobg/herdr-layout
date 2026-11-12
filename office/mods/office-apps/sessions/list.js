// 세션 앱의 순수 부분: herdr를 import하지 않아 node로 시험할 수 있다.
//   - slug: Claude Code가 프로젝트 기록 폴더 이름을 만드는 방식(agent/activity.js sessionOf와 같다)
//   - parseListing: 목록 셸 스크립트 출력 → 세션들(크기·수정 시각·첫 요청)
//   - firstAsk: 기록 앞부분에서 첫 사람 요청·폴더·시작 시각(parse.js와 같은 거르기, 단 마지막이 아니라 처음)
//   - rowsOf: 날짜 묶음(오늘/어제/이번 주/그 전) 머리줄 + 세션 줄
//   - collectArtifacts: 기록에서 이 세션이 게시한 아티팩트(Artifact 도구 호출과 그 결과의 첫 claude.ai/artifact 주소)

export const slug = (dir) => String(dir).replace(/[^A-Za-z0-9]/g, "-");

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((it) => it?.type === "text").map((it) => it.text).join("\n") : "");

// 슬래시 명령으로 시작한 세션: "<command-name>/foo</command-name> … <command-args>bar</command-args>" → "/foo bar"
function command(t) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(t)?.[1]?.trim();
  if (!name) return "";
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? "";
  return `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
}

// 기록 앞부분(줄들) → { ask, cwd, startAt }. 끝의 잘린 줄은 JSON이 깨져 건너뛴다.
export function firstAsk(text) {
  let ask = "", cmd = "", raw = "", cwd = null, startAt = 0;
  for (const line of String(text).split("\n")) {
    if (!line || !line.startsWith("{")) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!startAt && d.timestamp) startAt = Date.parse(d.timestamp) || 0;
    if (!cwd && typeof d.cwd === "string") cwd = d.cwd;
    if (d.type !== "user" || d.isSidechain) continue;
    const content = d.message?.content;
    if (Array.isArray(content) && content.some((it) => it?.type === "tool_result")) continue;
    const t = textOf(content).trim();
    if (!t) continue;
    if (!cmd) cmd = command(t);
    // 프로그램이 보낸 요청("<…>"로 감싼 글)만 있는 세션: 태그를 걷어 낸 첫 줄을 마지막 수단으로
    if (!raw && !d.isMeta) raw = t.replace(/<[^>]*>/g, "\n").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    // parse.js와 같은 거르기: 메타 줄, "<"로 시작하는 자동 메시지, 중단 알림은 사람 요청이 아니다
    if (d.isMeta || t.startsWith("<") || t.startsWith("[Request interrupted")) continue;
    ask = t;
    if (d.cwd) cwd = d.cwd;
    break;
  }
  return { ask: ask || cmd || raw, cwd, startAt };
}

// 첫 줄만, 공백을 하나로
export const oneLine = (s) => String(s ?? "").split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? "";

// 목록 셸 출력:
//   @@T <전체 개수>
//   @@F <id> <수정 시각 초> <크기> <만든 시각 초>   (뒤에 그 파일 앞부분의 user 줄들, 이미 아는 id면 없음)
export function parseListing(out) {
  let total = 0, cur = null;
  const files = [];
  const flush = () => { if (cur) { if (cur.lines.length) Object.assign(cur, firstAsk(cur.lines.join("\n")), { head: true }); delete cur.lines; files.push(cur); } };
  for (const line of String(out).split("\n")) {
    if (line.startsWith("@@T ")) { total = Number(line.slice(4)) || 0; continue; }
    if (line.startsWith("@@F ")) {
      flush();
      const [id, m, z, b] = line.slice(4).split(" ");
      const birth = Number(b) > 0 ? Number(b) * 1000 : 0;
      cur = { id, mtime: Number(m) * 1000 || 0, size: Number(z) || 0, birth, lines: [] };
      continue;
    }
    if (cur && line) cur.lines.push(line);
  }
  flush();
  return { total, files };
}

// ── 날짜 ────────────────────────────────────────────────

const DAY = 86400000;
const midnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

// 오늘 · 어제 · 이번 주(월요일부터) · 그 전
export function dayGroup(at, now = Date.now()) {
  const today = midnight(now);
  if (at >= today) return "오늘";
  if (at >= today - DAY) return "어제";
  const dow = (new Date(today).getDay() + 6) % 7;   // 월 0 … 일 6
  if (at >= today - dow * DAY) return "이번 주";
  return "그 전";
}

const pad = (n) => String(n).padStart(2, "0");
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

// 목록 오른쪽 흐린 시각: 오늘·어제는 "14:05", 이번 주는 "화 14:05", 그 전은 "11. 3."(해가 다르면 "25. 11. 3.")
export function whenLabel(at, now = Date.now()) {
  if (!at) return "";
  const d = new Date(at), g = dayGroup(at, now), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (g === "오늘" || g === "어제") return hm;
  if (g === "이번 주") return `${WEEK[d.getDay()]} ${hm}`;
  const y = d.getFullYear() !== new Date(now).getFullYear() ? `${String(d.getFullYear()).slice(2)}. ` : "";
  return `${y}${d.getMonth() + 1}. ${d.getDate()}.`;
}

// 상세의 날짜·시각: "11월 12일 14:05"
export function stamp(at) {
  if (!at) return "";
  const d = new Date(at);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 걸린 시간: "40분", "2시간 10분", "3일"
export function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "1분 안";
  if (m < 60) return `${m}분`;
  if (m < 1440) return `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}`;
  return `${Math.floor(m / 1440)}일`;
}

export function bytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

// 세션들(수정 시각 최신순) → 머리줄과 줄: [{ head: "오늘" } | { s }]
export function rowsOf(sessions, now = Date.now()) {
  const out = [];
  let last = null;
  for (const s of [...sessions].sort((a, b) => b.mtime - a.mtime)) {
    const g = dayGroup(s.mtime, now);
    if (g !== last) { out.push({ head: g }); last = g; }
    out.push({ s });
  }
  return out;
}

// ── 아티팩트 ────────────────────────────────────────────

const URL_RE = /https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/;
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const clip = (s, n) => { const x = String(s).replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n).trimEnd()}…` : x; };
// 게시한 파일 이름. index.html이면 그 폴더 이름이 더 잘 말해 준다.
function base(p) {
  const parts = String(p ?? "").split("/").filter(Boolean), last = parts.pop() ?? "";
  return /^index\.html?$/i.test(last) && parts.length ? parts.pop() : last;
}

// 기록 줄들(Artifact 호출 줄과 claude.ai/artifact가 든 결과 줄) → [{ url, title, page, file, desc, at, last }] (처음 게시한 순서)
//   게시(publish: action이 없거나 "publish", 자산 올리기 제외)만. 결과의 첫 주소가 그 아티팩트다
//   (빠른 시작·타입 목록 결과에 든 타입 주소, 타입에서 만들 때 뒤에 붙는 타입 주소는 들어가지 않는다).
//   제목 재료(title·.html 파일·description·파일)는 그 URL의 모든 호출에서 모은다(만들 때만 title이 있고, 고칠 때는 데이터 파일만 보내기도 한다).
//   보일 제목은 artifactTitle(사무실 왼쪽 패널 office/parse.js와 같은 규칙).
//   acc: 지난번 결과. 기록에 새로 붙은 부분만 읽어 이어 셀 때 넘긴다(호출과 결과가 두 번에 나뉘어 와도 짝을 맞춘다).
export function collectArtifacts(text, acc = { uses: {}, urls: {} }) {
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("{")) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "user" && d.type !== "assistant") continue;   // api-request·첨부 같은 다시 담은 줄은 빼고
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    const at = Date.parse(d.timestamp) || 0;
    for (const it of content) {
      if (d.type === "assistant" && it?.type === "tool_use" && it.name === "Artifact") {
        const inp = it.input ?? {};
        if ((inp.action ?? "publish") !== "publish" || inp.asset) continue;
        if (!acc.uses[it.id]) acc.uses[it.id] = { title: str(inp.title), file: str(inp.file_path), desc: str(inp.description) };
      } else if (d.type === "user" && it?.type === "tool_result" && acc.uses[it.tool_use_id] && !it.is_error) {
        const url = URL_RE.exec(textOf(it.content))?.[0];
        if (!url) continue;
        const u = acc.uses[it.tool_use_id], e = acc.urls[url] ?? (acc.urls[url] = { url, title: null, desc: null, file: null, page: null, at, last: at });
        e.last = Math.max(e.last, at);
        // 처음 붙인 이름(타입에서 만들 때의 title)을 지키고, 나머지 재료는 최근 것으로
        e.title = e.title ?? u.title ?? null;
        e.desc = u.desc ?? e.desc;
        if (u.file) {
          e.file = u.file;
          // 다른 .html을 게시하면 그 <title>을 다시 읽는다
          if (/\.html?$/i.test(u.file) && e.page !== u.file) { e.page = u.file; delete e.htmlTitle; }
        }
      }
    }
  }
  return acc;
}

// <title> 글: 앞 8KB에서 찾는다. 흔한 엔티티만 푼다(office/parse.js titleOfHtml과 같다).
export function titleOfHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""));
  if (!m) return null;
  const t = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  return t || null;
}

// 아직 <title>을 읽지 않은 아티팩트(title이 없고 .html을 게시한 것)
export const needsPageTitle = (acc) => Object.values(acc?.urls ?? {}).filter((e) => !e.title && e.page && !("htmlTitle" in e));

// 보일 제목: title → .html 파일의 <title>(htmlTitle) → description 첫 부분 → 파일 이름 → 주소 끝
export function artifactTitle(e) {
  const first = e.desc ? clip(e.desc.split(/(?<=[.!?。])\s|\n/)[0], 80) : null;
  return e.title || e.htmlTitle || first || base(e.page ?? e.file) || e.url.split("/").pop();
}

export const artifactList = (acc) => Object.values(acc?.urls ?? {}).sort((a, b) => a.at - b.at);
export const artifacts = (text) => artifactList(collectArtifacts(text));

// ── 셸 스크립트(sh -c, 인자로 값을 넘긴다. node로도 그대로 돌려 볼 수 있게 여기 둔다) ──

// 목록: $1 기록 폴더($HOME 그대로, eval로 편다) $2 몇 개 $3 앞부분을 이미 읽은 id들(쉼표로).
//   최근 수정 순 n개의 크기·수정 시각·만든 시각(stat: macOS -f, 리눅스 -c)과, 처음 보는 파일만 앞 2MB 안의 앞 user 줄 3개
//   (시작 훅·첨부가 앞에 수백 KB 붙기도 한다. grep -m이 거기서 멈춰 그 뒤는 읽지 않는다).
//   폴더가 없으면 exit 3.
export const LIST_SH = [
  'p=$(eval echo "$1"); n=$2; known=",$3,"',
  '[ -d "$p" ] || exit 3',
  'cd "$p" || exit 3',
  'echo "@@T $(ls *.jsonl 2>/dev/null | wc -l | tr -d " ")"',
  'ls -t *.jsonl 2>/dev/null | head -n "$n" | while IFS= read -r f; do',
  '  id=${f%.jsonl}',
  '  s=$(stat -f "%m %z %B" "$f" 2>/dev/null || stat -c "%Y %s %W" "$f" 2>/dev/null)',
  '  echo "@@F $id $s"',
  '  case "$known" in *",$id,"*) ;; *) head -c 2097152 "$f" | LC_ALL=C grep -m 3 -F \'"type":"user"\' ;; esac',
  'done',
].join("\n");

// 아티팩트: $1 기록 폴더 $2 세션 id $3 지난번에 읽은 크기(없으면 0).
//   첫 줄에 지금 크기, 이어서 Artifact 호출 줄과 아티팩트 주소가 든 줄만(다시 담은 api-request·첨부 줄은 뺀다).
//   $3이 있으면 그 앞 64KB 칸 경계부터만 읽는다(걸친 줄은 다시 읽혀도 주소로 겹침을 없앤다). 60MB 기록 전체는 1초 남짓.
export const ARTS_SH = [
  'f="$(eval echo "$1")/$2.jsonl"; [ -f "$f" ] || exit 3; from=${3:-0}',
  'z=$(wc -c < "$f" | tr -d " "); echo "$z"',
  '[ "$from" -gt "$z" ] && from=0',
  'dd if="$f" bs=65536 skip=$((from / 65536)) 2>/dev/null | LC_ALL=C grep -F -e \'"name":"Artifact"\' -e "claude.ai/artifact/"' +
    ' | LC_ALL=C grep -v -F -e \'"type":"api-request\' -e \'"type":"attachment"\' | cut -b1-200000',
  'exit 0',
].join("\n");

// 지금 도는 Claude Code 세션: ~/.claude/sessions/<pid>.json 중 그 pid가 살아 있는 것(한 줄에 하나).
export const OPEN_SH = [
  'for f in "$HOME"/.claude/sessions/*.json; do [ -f "$f" ] || continue; pid=$(basename "$f" .json)',
  '  kill -0 "$pid" 2>/dev/null && { tr -d "\\n" < "$f"; echo; }',
  'done; exit 0',
].join("\n");

// OPEN_SH 출력 → Map(sessionId → { pid, cwd })
export function parseOpen(out) {
  const m = new Map();
  for (const line of String(out).split("\n")) {
    try { const j = JSON.parse(line); if (j?.sessionId) m.set(j.sessionId, { pid: Number(j.pid) || null, cwd: j.cwd ?? null }); } catch { /* 깨진 줄 */ }
  }
  return m;
}
