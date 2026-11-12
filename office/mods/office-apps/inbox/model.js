// 알림함 앱의 목록 만들기(herdr를 import하지 않아 node로 시험할 수 있다).
//   묶음: 답 필요(blocked) · 완료(done: 안 본 사이 끝남) · 작업 중(working) · 상태 모름(상태를 보고하지 않는 에이전트).
//   낱말은 ../status.js 표. 완료는 사무실과 같은 때까지 유지: idle이어도 사무실이 완료로 붙잡은 것(공유 상태 office.finished)은 완료.
//   그 밖의 대기(idle)는 나를 기다리는 게 아니라서 넣지 않는다.
//   시각은 탭 단위(changed_at · working_since)만 쓴다: 줄을 고를 때 글자·순서가 바뀌지 않게.

import { STATUS_WORD, UNKNOWN_WORD, heldDone } from "../status.js";

export const GROUPS = [
  { id: "blocked", title: STATUS_WORD.blocked, fold: false },
  { id: "done", title: STATUS_WORD.done, fold: false },
  { id: "working", title: STATUS_WORD.working, fold: true },
  { id: "unknown", title: UNKNOWN_WORD, fold: true },
];

// agents()는 상태를 보고(OSC 7501)하는 터미널만 준다. Codex처럼 보고 훅이 없는 에이전트도 보이게,
//   칸에서 에이전트 프로그램이 돌고 있으면 상태 없이(null) 덧붙인다(agent.js withSilent를 옮겨 왔다. spaces는 인자로 받는다).
const SILENT_AGENT = /claude|codex|grok|antigravity|gemini|cursor|opencode|\bamp\b|\bpi\b/i;
export function withSilent(list, ps, sps) {
  const have = new Set(list.map((a) => a.address));
  const spaceOf = new Map(sps.flatMap((s) => s.tabs.map((x) => [x.id, s])));
  const extra = ps.filter((p) => p.terminal && !p.status && !have.has(p.terminal) && spaceOf.has(p.tab)
      && (p.program?.agent || SILENT_AGENT.test(p.program?.key ?? "")))
    .map((p) => {
      const s = spaceOf.get(p.tab), tab = s.tabs.find((x) => x.id === p.tab);
      return { address: p.terminal, pane: p.pane, space: s.id, space_name: s.name, tab: p.tab, tab_index: tab?.index ?? 0,
        tab_name: tab?.name ?? "", status: null, app: null, program: p.program, title: p.program?.name ?? p.title ?? "", seq: 0, pinned: false, focused: p.focused };
    });
  return extra.length ? [...list, ...extra] : list;
}

const groupOf = (status) => (status === "blocked" || status === "done" || status === "working" ? status : status ? null : "unknown");

// 에이전트 → 묶음별 줄. 답 필요는 오래 기다린 순, 완료는 최근에 끝난 순, 작업 중은 오래 일한 순.
//   시각이 없으면 뒤로, 같은 탭이라 시각이 같으면 seq(높을수록 최근에 바뀜)로 가른다.
//   finished: 공유 상태 office.finished({ 주소: 끝난 시각 }). 있으면 완료 시각도 그 값(사무실 알약의 "완료 n분 전"과 같게).
export function buildGroups(ags, sps, finished = null) {
  const tabs = new Map(sps.flatMap((s) => s.tabs.map((x) => [x.id, x])));
  const out = { blocked: [], done: [], working: [], unknown: [] };
  for (const a0 of ags) {
    const a = heldDone(a0, finished);
    const g = groupOf(a.status);
    if (!g) continue;
    const tb = tabs.get(a.tab);
    const since = g === "working" ? tb?.working_since ?? null : g === "unknown" ? null : g === "done" && a.doneAt ? a.doneAt : tb?.changed_at ?? null;
    out[g].push({ key: a.address, address: a.address, group: g, status: a.status, space: a.space,
      where: `${a.space_name} › ${a.tab_name}`, title: a.title || a.program?.name || a.address,
      program: a.program ?? null, app: a.app ?? null, since, seq: a.seq ?? 0 });
  }
  const older = (x, y) => (x.since == null) - (y.since == null) || (x.since ?? 0) - (y.since ?? 0) || x.seq - y.seq;
  const newer = (x, y) => (x.since == null) - (y.since == null) || (y.since ?? 0) - (x.since ?? 0) || y.seq - x.seq;
  out.blocked.sort(older);
  out.done.sort(newer);
  out.working.sort(older);
  return out;
}

// 보이는 줄(접힌 묶음은 뺀다): 키보드 이동·자동 선택이 이 순서를 쓴다
export function visibleRows(groups, open) {
  return GROUPS.flatMap((g) => (open[g.id] ? groups[g.id] : []));
}

// 접힘 상태: 저장된 값이 없으면 기본(답 필요·완료는 펼침, 작업 중·상태 모름은 접힘)
export function openState(saved) {
  return Object.fromEntries(GROUPS.map((g) => [g.id, typeof saved?.[g.id] === "boolean" ? saved[g.id] : !g.fold]));
}

// 고를 줄: 지금 고른 줄이 보이면 그대로, 아니면 보이는 첫 줄, 없으면 null
export function pick(rows, sel) {
  return rows.some((r) => r.key === sel) ? sel : rows[0]?.key ?? null;
}

const mins = (ms) => Math.max(0, Math.floor(ms / 60000));
export function dur(ms) {
  const m = mins(ms);
  return m < 60 ? `${m}분` : m < 1440 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 1440)}일`;
}
export function ago(ms) {
  const m = mins(ms);
  return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
}

// 경과 글자: "4분째 기다림", "12분 전"(완료 묶음 안이라 낱말은 붙이지 않는다), "8분째 작업 중". 시각을 모르면 빈 글자.
export function elapsed(r, now = Date.now()) {
  if (r.since == null) return "";
  const ms = now - r.since, fresh = mins(ms) < 1;
  if (r.group === "blocked") return fresh ? "방금부터 기다림" : `${dur(ms)}째 기다림`;
  if (r.group === "done") return ago(ms);
  if (r.group === "working") return fresh ? "방금 시작" : `${dur(ms)}째 작업 중`;
  return "";
}

// 여러 줄 글의 첫 줄(빈 줄은 건너뛴다)
export function firstLine(s) {
  return String(s ?? "").split("\n").map((x) => x.trim()).find(Boolean) ?? "";
}

export const isClaude = (p, app) => /claude/i.test(`${p?.key ?? ""} ${p?.name ?? ""} ${app ?? ""}`);
