// 작업 공간 앱의 순수 함수: 트리 줄 만들기, 탭 상태 낱말, 정리 후보 고르기.
// herdr를 import하지 않는다(node로 실제 데이터를 넣어 시험한다). 값은 herdr.d.ts의 SpaceInfo·TabInfo·PaneInfo·AgentInfo 모양.

const HOUR = 3600000;
export const SHELL_AFTER = 1 * HOUR;   // a) 셸만 있는 탭: 이만큼 변화 없으면
export const AGENT_AFTER = 2 * HOUR;   // c) 끝난 에이전트: 이만큼 변화 없으면(접어 둔 탭은 바로)

// 탭 줄의 상태 낱말. 색만으로 가르지 않게 낱말을 늘 붙인다. idle은 낱말 없음.
export const WORD = { blocked: "답 필요", working: "작업 중", done: "완료" };
export const SETTLED = "접어 둠";

// git 동작으로 연 탭 이름: show <해시>, diff …, pull …, push …
export const GIT_TAB = /^(show [0-9a-f]{7,40}$|(diff|pull|push)(\s|$))/;

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
export function shellOnly(tabPanes) {
  return tabPanes.length > 0 && tabPanes.every((p) => p.terminal && p.program?.shell && !p.program?.agent && !p.status);
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

// 정리 후보. 탭마다 처음 맞는 규칙 하나만(b → a → c).
//   { tab, space, rule: "git"|"shell"|"agent", reason, check(기본 선택) }
//   절대 넣지 않는 것: 지금 보고 있는 탭, 작업 중 에이전트가 있는 탭, 스페이스의 하나뿐인 탭(닫으면 스페이스째 사라진다).
//   changed_at이 null(앱을 켠 뒤 변화 없음)이면 얼마나 지났는지 모르니 시간 조건을 채우지 않은 것으로 본다(닫는 쪽이라 보수적으로).
export function candidates(sps, ps, { now = Date.now(), viewed = new Set() } = {}) {
  const out = [];
  for (const s of sps) {
    if (s.tabs.length < 2) continue;
    for (const tab of s.tabs) {
      if (viewed.has(tab.id)) continue;
      const mine = panesOf(tab.id, ps);
      if (!mine.length || hasWorking(tab, mine)) continue;
      const idle = tab.changed_at ? now - tab.changed_at : null;
      let c = null;
      if (shellOnly(mine) && GIT_TAB.test(tab.name)) {
        c = { rule: "git", reason: `git 명령이 끝나고 셸만 남았습니다`, check: true };
      } else if (shellOnly(mine)) {
        if (idle !== null && idle > SHELL_AFTER) c = { rule: "shell", reason: `셸만 있고 ${hours(idle)}째 변화가 없습니다`, check: true };
      } else {
        // 에이전트 칸이 있고, 모두 완료·대기(답 필요는 사람이 볼 일이라 빼고, 상태를 모르는 칸이 섞여도 뺀다)
        const ag = mine.filter((p) => p.status);
        const others = mine.filter((p) => !p.status && !(p.terminal && p.program?.shell && !p.program?.agent));
        const done = ag.length > 0 && others.length === 0 && ag.every((p) => p.status === "done" || p.status === "idle");
        if (done && (tab.settled || (idle !== null && idle > AGENT_AFTER))) {
          c = { rule: "agent", check: false,
            reason: tab.settled ? "에이전트가 끝났고 탭을 접어 두었습니다 · 대화를 잃을 수 있습니다"
              : `에이전트가 끝나고 ${hours(idle)}째 변화가 없습니다 · 대화를 잃을 수 있습니다` };
        }
      }
      if (c) out.push({ tab, space: s, ...c });
    }
  }
  // 절대 규칙을 한 번 더(규칙을 고치다 빠뜨려도 지키게)
  return out.filter((c) => !viewed.has(c.tab.id) && !hasWorking(c.tab, panesOf(c.tab.id, ps)));
}

// 닫기 직전에 다시 거르기: 확인 창을 연 뒤 보게 됐거나 작업을 시작한 탭은 빼고 남은 id만.
export function stillClosable(ids, sps, ps, viewed) {
  const tabs = new Map(sps.flatMap((s) => s.tabs.map((tb) => [tb.id, tb])));
  return ids.filter((id) => tabs.has(id) && !viewed.has(id) && !hasWorking(tabs.get(id), panesOf(id, ps)));
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
