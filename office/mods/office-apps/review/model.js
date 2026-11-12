// 검토 앱의 순수 함수(herdr를 import하지 않는다: node로 시험한다).
//   workdirs(ags, ps, sps)          에이전트마다 작업 폴더·머신을 찾는다 → [{ key, on, cwd, agents[] }] (같은 머신·폴더는 하나)
//   groupRoots(dirs, roots)         git 루트(레포·워크트리)로 묶는다 → [{ key, on, root, agents[] }]
//   parseShortstat(text)            git diff --shortstat 한 줄 → { files, add, del }
//   summary(stat, untracked)        "파일 4 · +120 −30" (커밋 안 된 변경이 없고 앞선 커밋만 있으면 "커밋 2개 · 기본 브랜치 대비", 둘 다 없으면 "변경 없음")
//   dirty(st) · changed(st)         커밋 안 된 변경이 있는지 · 그것이나 기본 브랜치보다 앞선 커밋(st.ahead)이 있는지
//   autoMode(st)                    기본 보기: 커밋 안 된 변경 없이 앞선 커밋만 있으면 "base", 아니면 null(사람이 고른 보기)
//   sortGroups(groups, stats)       변경 있는 곳 먼저(그 안에서는 상태 급한 순), 변경 없는 곳은 그 아래, 에이전트 없는 곳은 맨 아래
//   keepDirs(live, recent, sleeping)  지금 에이전트가 있는 폴더 + 에이전트 없이 남길 폴더(최근 본 것·잠든 기록) → dirs(agents: [])
//   pickLine(rows, pairs, key)      diff 가상 목록 키(i<n> | s<n>) → { line, side } | null
//   feedbackText({ path, line, side, text })   에이전트에게 보낼 글
//   baseCandidates / pickBase       기본 브랜치 후보와 고르기

export const STATUS = { working: "작업 중", blocked: "입력 대기", done: "끝남", idle: "대기 중" };
const URGENT = { blocked: 0, working: 1, done: 2, idle: 3 };
export const rank = (s) => URGENT[s] ?? 4;

// agents()는 상태를 보고하는 터미널만 준다. 보고 훅이 없는 에이전트(Codex 등)도 보이게 칸에서 에이전트 프로그램이
//   도는 것을 상태 없이(null) 덧붙인다(agent.js withSilent와 같은 규칙).
const SILENT_AGENT = /claude|codex|grok|antigravity|gemini|cursor|opencode|\bamp\b|\bpi\b/i;
export function withSilent(list, ps, sps) {
  const have = new Set(list.map((a) => a.address));
  const spaceOf = new Map(sps.flatMap((s) => s.tabs.map((x) => [x.id, s])));
  const extra = ps.filter((p) => p.terminal && !p.status && !have.has(p.terminal) && spaceOf.has(p.tab)
      && (p.program?.agent || SILENT_AGENT.test(p.program?.key ?? "")))
    .map((p) => {
      const s = spaceOf.get(p.tab), tab = s.tabs.find((x) => x.id === p.tab);
      return { address: p.terminal, pane: p.pane, space: s.id, space_name: s.name, tab: p.tab, tab_index: tab?.index ?? 0,
        tab_name: tab?.name ?? "", status: null, app: null, program: p.program, title: p.program?.name ?? p.title ?? "" };
    });
  return extra.length ? [...list, ...extra] : list;
}

const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);

// 에이전트 → 작업 폴더(그 칸의 지금 폴더, 없으면 스페이스 폴더)와 머신. 폴더를 모르면 뺀다.
// 같은 (머신, 폴더)는 한 항목으로 모은다. key는 JSON [머신, 폴더].
export function workdirs(ags, ps, sps) {
  const paneOf = new Map(ps.map((p) => [p.pane, p])), termOf = new Map(ps.filter((p) => p.terminal).map((p) => [p.terminal, p]));
  const spaceOf = new Map(sps.map((s) => [s.id, s]));
  const out = new Map();
  for (const a of ags) {
    const p = paneOf.get(a.pane) ?? termOf.get(a.address), s = spaceOf.get(a.space);
    const cwd = (p?.cwd || s?.folder || "").replace(/\/+$/, "");
    if (!cwd) continue;
    const on = s?.machine ?? machineOf(a.address) ?? null;
    const key = JSON.stringify([on, cwd]);
    if (!out.has(key)) out.set(key, { key, on, cwd, agents: [] });
    out.get(key).agents.push(a);
  }
  return [...out.values()];
}

// roots: 작업 폴더 key → git 루트(레포가 아니면 null, 아직 모르면 undefined).
// 레포가 아닌 폴더는 뺀다. 아직 모르는 폴더는 폴더 자체를 임시 루트로 둔다(pending: true).
export function groupRoots(dirs, roots) {
  const out = new Map();
  for (const d of dirs) {
    const r = roots[d.key];
    if (r === null) continue;
    const root = r ?? d.cwd, key = JSON.stringify([d.on, root]);
    if (!out.has(key)) out.set(key, { key, on: d.on, root, pending: r === undefined, agents: [] });
    const g = out.get(key);
    if (r !== undefined) g.pending = false;
    for (const a of d.agents) if (!g.agents.some((x) => x.address === a.address)) g.agents.push(a);
    for (const n of d.slept ?? []) { g.slept ??= []; if (!g.slept.includes(n)) g.slept.push(n); }
  }
  // 줄 안의 에이전트는 상태 급한 순
  for (const g of out.values()) g.agents.sort((a, b) => rank(a.status) - rank(b.status));
  return [...out.values()];
}

// " 4 files changed, 120 insertions(+), 30 deletions(-)" · " 1 file changed, 2 insertions(+)" · "" → 숫자
export function parseShortstat(text) {
  const s = String(text ?? "");
  const n = (re) => Number(re.exec(s)?.[1] ?? 0);
  return { files: n(/(\d+)\s+files?\s+changed/), add: n(/(\d+)\s+insertions?\(\+\)/), del: n(/(\d+)\s+deletions?\(-\)/) };
}

// 추적 안 된 파일 수를 파일 수에 더한다(줄 수는 세지 않는다).
// 커밋 안 된 변경이 없어도 기본 브랜치보다 앞선 커밋(stat.ahead)이 있으면 그것을 쓴다(커밋까지 끝낸 에이전트의 일).
export function summary(stat, untracked = 0) {
  if (!stat) return "";
  const files = (stat.files ?? 0) + untracked;
  if (!files) return stat.ahead > 0 ? `커밋 ${stat.ahead}개 · 기본 브랜치 대비` : "변경 없음";
  const parts = [`파일 ${files}`];
  if (stat.add || stat.del) parts.push(`+${stat.add} −${stat.del}`);
  return parts.join(" · ");
}

export const dirty = (st) => Boolean(st && ((st.files ?? 0) + (st.untracked ?? 0)) > 0);
export const changed = (st) => dirty(st) || Boolean(st?.ahead > 0);
export const autoMode = (st) => (st && !dirty(st) && st.ahead > 0 ? "base" : null);

// 변경 있는 곳 먼저(상태 급한 순, 같으면 원래 순서), 변경이 없거나 아직 모르는 곳은 그 아래.
// 에이전트가 없는 곳(최근 본 폴더·잠든 에이전트 폴더)은 따로 맨 아래 묶음.
export function sortGroups(groups, stats) {
  const score = (g) => (g.agents.length ? 0 : 100) + (changed(stats[g.key]) ? 0 : 1) * 10 + rank(g.agents[0]?.status);
  return groups.map((g, i) => [g, i]).sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1]).map(([g]) => g);
}

// diff 가상 목록의 키 → 고른 줄. 위아래 보기(i<n>)는 rows[n], 좌우(s<n>)는 pairs[n](오른쪽 새 줄 먼저).
// 새 파일 쪽 번호가 있으면 그 번호(side "new"), 지운 줄이면 옛 번호(side "old"). 구간 머리(@@)는 null.
export function pickLine(rows, pairs, key) {
  const m = /^([is])(\d+)$/.exec(String(key ?? ""));
  if (!m) return null;
  const i = Number(m[2]);
  let row = null;
  if (m[1] === "i") row = rows?.[i] ?? null;
  else { const p = pairs?.[i]; if (!p || p.hunk !== undefined) return null; row = p.right ?? p.left ?? null; }
  if (!row || row.kind === "@") return null;
  if (row.next !== undefined && row.next !== null) return { line: row.next, side: "new", key: String(key) };
  if (row.old !== undefined && row.old !== null) return { line: row.old, side: "old", key: String(key) };
  return null;
}

// 보낼 글: "[파일:줄] 글" — 지운 줄이면 "(지운 줄)". 파일이 없으면 글만. 글이 비면 "".
export function feedbackText({ path, line, side, text }) {
  const body = String(text ?? "").replace(/\s+$/, "").replace(/^\s*\n/, "");
  if (!body.trim()) return "";
  if (!path) return body;
  const where = line ? `${path}:${line}${side === "old" ? " (지운 줄)" : ""}` : path;
  return `[${where}] ${body}`;
}

// 기본 브랜치 후보: origin/HEAD가 가리키는 것 → origin/main → origin/master → main → master.
// originHead: `git symbolic-ref -q --short refs/remotes/origin/HEAD` 출력(없으면 "").
export function baseCandidates(originHead) {
  const h = String(originHead ?? "").trim();
  return [...new Set([h, "origin/main", "origin/master", "main", "master"].filter(Boolean))];
}

// ok: 후보 → rev-parse --verify 성공 여부. 처음 성공한 후보, 없으면 null.
export function pickBase(cands, ok) {
  return cands.find((c) => ok[c]) ?? null;
}

// 에이전트가 없어도 남길 폴더: 이번 실행에서 본 폴더(recent: [{ key, on, cwd }])와 잠든 기록(sleeping.json: [{ cwd, machine, tabName }]).
//   지금 에이전트가 있는 폴더(live)와 같은 key는 빼고, 남긴 폴더는 agents: []. slept: 그 폴더에서 잠든 탭 이름들.
export function keepDirs(live, recent, sleeping) {
  const out = new Map(live.map((d) => [d.key, d]));
  const add = (on, cwd) => {
    const c = String(cwd ?? "").replace(/\/+$/, "");
    if (!c) return null;
    const key = JSON.stringify([on ?? null, c]);
    if (!out.has(key)) out.set(key, { key, on: on ?? null, cwd: c, agents: [], slept: [] });
    return out.get(key);
  };
  for (const r of sleeping ?? []) { const d = add(r.machine, r.cwd); if (d?.slept && r.tabName && !d.slept.includes(r.tabName)) d.slept.push(r.tabName); }
  for (const r of recent ?? []) add(r.on, r.cwd);
  return [...out.values()];
}
