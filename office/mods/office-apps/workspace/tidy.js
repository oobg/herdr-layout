// 작업 공간 앱의 순수 함수: 트리 줄 만들기, 탭 상태 낱말, 정리 후보 고르기.
// herdr를 import하지 않는다(node로 실제 데이터를 넣어 시험한다). 값은 herdr.d.ts의 SpaceInfo·TabInfo·PaneInfo·AgentInfo 모양.

const HOUR = 3600000;
export const SHELL_AFTER = 1 * HOUR;   // a) 셸만 있는 탭: 이만큼 변화 없으면
export const AGENT_AFTER = 2 * HOUR;   // c) 끝난 에이전트: 이만큼 변화 없으면(접어 둔 탭은 바로)

// 탭 줄의 상태 낱말. 색만으로 가르지 않게 낱말을 늘 붙인다. idle은 낱말 없음.
export const WORD = { blocked: "답 필요", working: "작업 중", done: "완료" };
export const SETTLED = "접어 둠";

// git 동작으로 연 탭 이름: show <해시>, diff …, pull …, push …(push tag·push -u 포함)
export const GIT_TAB = /^(show [0-9a-f]{7,40}$|(diff|pull|push)(\s|$))/;
// git이 남긴 칸의 앞 프로그램: git 자신(pager를 띄운 채 기다림)과 pager 계열. 프로그램 표의 key로 맞추고, 표에 없는
//   프로그램(key "program")만 이름(프로세스 이름, 마지막 경로 조각)으로 맞춘다. 표시 이름으로 맞추면 lazygit("Git")도 걸린다.
export const PAGER = /^(git|less|more|most|pager|delta|bat|moar|ov)$/i;

// 지금 보고 있는 탭: 보이는 스페이스의 보이는 탭(tab.active는 스페이스마다 하나씩 true라 스페이스도 본다), 또는 포커스가 있는 탭.
export function viewedTabs(sps, focusedTab = null) {
  const out = new Set();
  for (const s of sps) if (s.active) for (const tb of s.tabs) if (tb.active) out.add(tb.id);
  if (focusedTab) out.add(focusedTab);
  return out;
}

export function panesOf(tabId, ps) {
  return ps.filter((p) => p.tab === tabId);
}

// 셸만 있는 탭: 모든 칸이 터미널이고 셸 프로그램이며 상태 보고가 없고 에이전트가 아니다.
//   모드 칸(terminal null)·에이전트(상태를 보고하지 않는 Codex 등 포함)·다른 프로그램(nvim, 개발 서버…)이 있으면 아니다.
const isShell = (p) => Boolean(p.terminal && p.program?.shell && !p.program?.agent && !p.status);
const base = (x) => String(x ?? "").split("/").pop();
const procIs = (p, re) => re.test(base(p.program?.key)) || (p.program?.key === "program" && re.test(base(p.program?.name)));
const isPager = (p) => Boolean(p.terminal && !p.program?.agent && !p.status && procIs(p, PAGER));
export function shellOnly(tabPanes) {
  return tabPanes.length > 0 && tabPanes.every(isShell);
}
// git 탭에 남은 칸: 셸이거나 git·pager뿐
export function gitLeftover(tabPanes) {
  return tabPanes.length > 0 && tabPanes.every((p) => isShell(p) || isPager(p));
}

// 탭 안에서 작업 중인 에이전트가 있는지(탭 상태가 가장 급한 것만 주므로 칸도 본다)
export function hasWorking(tab, tabPanes) {
  return tab.status === "working" || Boolean(tab.working_since) || tabPanes.some((p) => p.status === "working");
}

// 탭 줄 오른쪽 낱말과 색 이름(테마 토큰). [글자, 토큰] 또는 null.
export function tabWord(tab) {
  if (WORD[tab.status]) return [WORD[tab.status], tab.status];
  if (tab.settled) return [SETTLED, "dim"];
  return null;
}

function hours(ms) {
  const h = Math.floor(ms / HOUR);
  return h < 24 ? `${h}시간` : `${Math.floor(h / 24)}일`;
}

// 탭 하나 판정: 정리 후보면 { rule: "git"|"shell"|"agent", reason, check(기본 선택) }, 아니면 { why: 뺀 이유 }.
//   절대 넣지 않는 것: 스페이스의 하나뿐인 탭(닫으면 스페이스째 사라진다), 지금 보고 있는 탭, 작업 중·답 필요 에이전트가 있는 탭,
//   잠든 에이전트가 있는 탭(깨울 곳이 사라진다). 규칙은 처음 맞는 하나만(git → shell → agent).
//   changed_at이 null(앱을 켠 뒤 변화 없음)이면 얼마나 지났는지 모르니 시간 조건을 채우지 않은 것으로 본다(닫는 쪽이라 보수적으로).
//   opts: { now, viewed: Set<탭 id>, asleep: Set|Map<탭 id> }
export function judge(tab, space, ps, { now = Date.now(), viewed = new Set(), asleep = new Set() } = {}) {
  if (space.tabs.length < 2) return { why: "스페이스의 하나뿐인 탭" };
  if (viewed.has(tab.id)) return { why: "지금 보는 탭" };
  const mine = panesOf(tab.id, ps);
  if (!mine.length) return { why: "칸 없음" };
  if (hasWorking(tab, mine)) return { why: "작업 중" };
  if (tab.status === "blocked" || mine.some((p) => p.status === "blocked")) return { why: "답 필요" };
  if (asleep.has(tab.id)) return { why: "잠든 에이전트가 있음" };
  const idle = tab.changed_at ? now - tab.changed_at : null;
  // b) git 동작으로 연 탭에 셸·git·pager만 남았다. pull·push인데 git이 아직 떠 있으면 도는 중일 수 있어 기본 해제.
  if (GIT_TAB.test(tab.name) && gitLeftover(mine)) {
    if (shellOnly(mine)) return { rule: "git", check: true, reason: "git 명령이 끝나고 셸만 남았습니다" };
    if (/^(pull|push)/.test(tab.name) && mine.some((p) => procIs(p, /^git$/i)))
      return { rule: "git", check: false, reason: "git이 아직 떠 있습니다 · 끝났는지 보고 고르세요" };
    return { rule: "git", check: true, reason: "git 결과 화면(pager)만 남았습니다" };
  }
  // a) 셸만 있고 오래 변화 없음
  if (shellOnly(mine)) {
    if (idle !== null && idle > SHELL_AFTER) return { rule: "shell", check: true, reason: `셸만 있고 ${hours(idle)}째 변화가 없습니다` };
    return { why: idle === null ? "셸만 있음 · 쉰 시간 모름" : "셸만 있음 · 1시간 안에 씀" };
  }
  // c) 에이전트 칸이 있고, 모두 완료·대기(상태를 모르는 칸이 섞이면 뺀다)
  const ag = mine.filter((p) => p.status);
  const others = mine.filter((p) => !p.status && !isShell(p));
  if (others.length) {
    const names = [...new Set(others.map((p) => (p.terminal ? p.program?.name || "프로그램" : p.mod || "앱 칸")))];
    return { why: `프로그램 실행 중 (${names.slice(0, 3).join(", ")})` };
  }
  if (ag.length && ag.every((p) => p.status === "done" || p.status === "idle")) {
    if (tab.settled) return { rule: "agent", check: false, reason: "에이전트가 끝났고 탭을 접어 두었습니다 · 대화를 잃을 수 있습니다" };
    if (idle !== null && idle > AGENT_AFTER)
      return { rule: "agent", check: false, reason: `에이전트가 끝나고 ${hours(idle)}째 변화가 없습니다 · 대화를 잃을 수 있습니다` };
    return { why: idle === null ? "끝난 에이전트 · 쉰 시간 모름" : "끝난 에이전트 · 2시간 안에 씀" };
  }
  return { why: "규칙에 맞지 않음" };
}

// 정리 화면 전체: { cands: [{ tab, space, rule, reason, check }], skipped: [{ tab, space, why }] }
export function review(sps, ps, opts = {}) {
  const viewed = opts.viewed ?? new Set();
  const cands = [], skipped = [];
  for (const s of sps) {
    for (const tab of [...s.tabs].sort((a, b) => a.index - b.index)) {
      const j = judge(tab, s, ps, opts);
      // 절대 규칙을 한 번 더(규칙을 고치다 빠뜨려도 지키게)
      if (j.rule && !viewed.has(tab.id) && !hasWorking(tab, panesOf(tab.id, ps))) cands.push({ tab, space: s, ...j });
      else skipped.push({ tab, space: s, why: j.why ?? "작업 중" });
    }
  }
  return { cands, skipped };
}

export const candidates = (sps, ps, opts = {}) => review(sps, ps, opts).cands;

// 뺀 탭을 이유별로 셈(머리줄에 쓴다): [[이유 첫 낱말, 수]] 많은 순
export function skipSummary(skipped) {
  const m = new Map();
  for (const x of skipped) { const k = x.why.split(" (")[0].split(" · ")[0]; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
}

// ── 닫기 직전 다시 보기(확인 창은 몇 초~몇 분 열려 있을 수 있다) ──
// 창을 열 때와 실행할 때 탭의 위험도: 지금 보는지, 작업 중·답 필요·에이전트·셸 아닌 프로그램·칸 수, 잠듦.
export function riskOf(tabIds, sps, ps, { viewed = new Set(), asleep = new Set() } = {}) {
  const tabs = new Map(sps.flatMap((s) => s.tabs.map((tb) => [tb.id, tb])));
  const out = {};
  for (const id of tabIds) {
    const tab = tabs.get(id);
    if (!tab) continue;
    const mine = panesOf(id, ps);
    out[id] = {
      name: tab.name,
      viewed: viewed.has(id),
      working: mine.filter((p) => p.status === "working").length + (hasWorking(tab, []) ? 1 : 0),
      blocked: mine.filter((p) => p.status === "blocked").length,
      agents: mine.filter((p) => p.status || p.program?.agent).length,
      programs: mine.filter((p) => !p.status && !p.program?.agent && !isShell(p) && !isPager(p)).length,
      panes: mine.length,
      asleep: asleep.has(id),
    };
  }
  return out;
}

// 더 위험해졌으면 그 이유, 아니면 null. 없어진 탭은 "이미 닫힘".
export function worse(was, now) {
  if (!now) return "이미 닫혔습니다";
  if (!was) return "창을 연 뒤 생긴 탭입니다";
  if (now.working > was.working) return "작업 중인 에이전트가 생겼습니다";
  if (now.blocked > was.blocked) return "답을 기다리는 에이전트가 생겼습니다";
  if (now.agents > was.agents) return "에이전트가 새로 떴습니다";
  if (now.programs > was.programs) return "다른 프로그램이 실행됐습니다";
  if (now.panes > was.panes) return "칸이 늘었습니다";
  if (now.asleep && !was.asleep) return "잠든 에이전트가 생겼습니다";
  if (now.viewed && !was.viewed) return "지금 보는 탭이 됐습니다";
  return null;
}

// 일괄 정리 실행 직전: 고른 id 중 지금도 후보이고 창을 연 때보다 위험해지지 않은 것만 닫는다.
//   snap[id].check: 창을 열 때의 기본 선택(있으면 true→false로 바뀐 것도 뺀다).
//   { keep: [id], dropped: [{ id, name, why }] }
export function recheckTidy(ids, snap, sps, ps, opts = {}) {
  const { cands, skipped } = review(sps, ps, opts);
  const ok = new Set(cands.map((c) => c.tab.id));
  const whyOf = new Map(skipped.map((x) => [x.tab.id, x.why]));
  const names = new Map(sps.flatMap((s) => s.tabs.map((tb) => [tb.id, tb.name])));
  const now = riskOf(ids, sps, ps, opts);
  const check = new Map(cands.map((c) => [c.tab.id, c]));
  const keep = [], dropped = [];
  for (const id of ids) {
    // 창을 열 때 기본 선택이던 후보가 지금은 기본 해제(pull·push 탭에서 git이 다시 돈다 등)면 뺀다
    const off = snap?.[id]?.check === true && check.get(id)?.check === false ? check.get(id).reason : null;
    const w = worse(snap?.[id], now[id]) ?? (ok.has(id) ? off : whyOf.get(id) ?? "후보에서 빠졌습니다");
    if (w) dropped.push({ id, name: names.get(id) ?? snap?.[id]?.name ?? id, why: w });
    else keep.push(id);
  }
  return { keep, dropped };
}

// 탭·스페이스 하나 닫기 직전: 창을 연 때보다 위험해진 탭이 있으면 [{ id, name, why }], 없으면 [].
//   스페이스 닫기는 그 스페이스의 지금 탭 전부를 넘긴다(새로 생긴 탭도 걸린다).
export function recheckClose(ids, snap, sps, ps, opts = {}) {
  const names = new Map(sps.flatMap((s) => s.tabs.map((tb) => [tb.id, tb.name])));
  const now = riskOf(ids, sps, ps, opts);
  return ids.map((id) => ({ id, name: names.get(id) ?? id, why: worse(snap?.[id], now[id]) })).filter((x) => x.why);
}

// 왼쪽 트리 줄: 맨 위 "정리", 스페이스, (펼친 스페이스면) 그 탭들.
//   { key, kind: "tidy"|"space"|"tab", space, tab? }
export function treeRows(sps, fold = {}) {
  const rows = [{ key: "tidy", kind: "tidy" }];
  for (const s of sps) {
    rows.push({ key: `s:${s.id}`, kind: "space", space: s });
    if (!fold[s.id]) for (const tab of [...s.tabs].sort((a, b) => a.index - b.index)) rows.push({ key: `t:${tab.id}`, kind: "tab", space: s, tab });
  }
  return rows;
}

// 스페이스 안 에이전트 수: { all, working }
export function agentCount(spaceId, ags) {
  const mine = ags.filter((a) => a.space === spaceId);
  return { all: mine.length, working: mine.filter((a) => a.status === "working").length };
}

// 경로를 짧게: 홈 아래면 ~/…
export function tilde(p, home) {
  if (!p) return "";
  if (home && (p === home || p.startsWith(home + "/"))) return `~${p.slice(home.length)}`;
  const h = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(p)?.[1];
  return h ? `~${p.slice(h.length)}` : p;
}
