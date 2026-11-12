// 작업 공간 앱의 재우기·깨우기 순수 함수: 후보 고르기, 백그라운드 작업 셈, 잠든 기록 정리, 프로세스 트리 메모리.
// herdr를 import하지 않는다(node로 실제 데이터를 넣어 시험한다). 값은 herdr.d.ts의 SpaceInfo·TabInfo·PaneInfo 모양.
import { panesOf, hasWorking } from "./tidy.js";

export const SLEEP_AFTER = 20 * 60000;   // 탭이 이만큼 변화 없으면 재울 수 있다
export const GRACE = 60000;              // 재운 직후 이만큼은 칸이 아직 Claude여도 기록을 지우지 않는다(/exit가 도는 중)
export const SLEPT = "잠듦";

// Claude Code인지(agent.js isClaude와 같은 규칙: 프로그램 key·이름이나 보고한 app에 claude)
export const isClaude = (p, app) => /claude/i.test(`${p?.key ?? ""} ${p?.name ?? ""} ${app ?? ""}`);

// 셸만 남은 칸: 터미널이고 앞쪽 프로그램이 셸이다. 상태(status)는 보지 않는다: Claude가 끝난 뒤 마지막 보고가 남아 있을 수 있다.
export const isShellPane = (p) => Boolean(p?.terminal && p.program?.shell && !p.program?.agent);

// 세션 id는 명령 줄에 들어가므로 UUID 모양만 받는다
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 셸에 넣을 작은따옴표 감싸기
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 깨우는 명령: 기록 폴더(projects/<cwd>)를 찾도록 재운 때의 폴더로 옮긴 뒤 이어 간다. yolo 플래그는 몰라서 붙이지 않는다.
export const resumeLine = (r) => `cd ${shq(r.cwd)} && claude --resume ${r.session}`;

function span(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}분` : m < 1440 ? `${Math.floor(m / 60)}시간` : `${Math.floor(m / 1440)}일`;
}

// 1단계(살아 있는 값만으로): 재울 수 있어 보이는 Claude 칸. 기록을 확인하기 전이라 아직 후보가 아니다.
//   조건: Claude Code, 칸 상태 완료·대기, 탭 changed_at이 SLEEP_AFTER보다 오래, 지금 보는 탭 아님, 탭에 작업 중 없음, 이미 잠든 칸 아님.
//   changed_at이 null(앱을 켠 뒤 변화 없음)이면 얼마나 쉬었는지 몰라 뺀다.
//   { address, pane, tab, space, idle, status, reason }
export function sleepable(sps, ps, { now = Date.now(), viewed = new Set(), sleeping = [] } = {}) {
  const asleep = new Set(sleeping.map((r) => r.address));
  const out = [];
  for (const s of sps) {
    for (const tab of s.tabs) {
      if (viewed.has(tab.id) || !tab.changed_at) continue;
      const idle = now - tab.changed_at;
      if (idle <= SLEEP_AFTER) continue;
      const mine = panesOf(tab.id, ps);
      if (hasWorking(tab, mine)) continue;
      for (const p of mine) {
        if (!p.terminal || asleep.has(p.terminal) || !isClaude(p.program, p.app)) continue;
        if (p.status !== "done" && p.status !== "idle") continue;
        out.push({ address: p.terminal, pane: p.pane, tab, space: s, idle, status: p.status,
          reason: `${p.status === "done" ? "완료" : "대기"} · ${span(idle)} 변화 없음` });
      }
    }
  }
  return out;
}

// 2단계: 기록을 확인한 것만 후보로. probes: { 주소: probe 결과 } (probe가 없거나 실패면 뺀다 — 판단 못 하면 재우지 않는다)
//   probe = { ok, why?, session, guessed, cwd, state, open: [백그라운드 id], agentsRunning, recordsWorking }
export function confirmed(pre, probes) {
  return pre.filter((c) => probeWhy(probes[c.address]) === null);
}

// 기록 확인 결과가 후보가 아닌 이유(후보면 null). "확인 실패"로 시작하면 판단을 못 한 것, 나머지는 안전 조건 미충족.
export function probeWhy(p) {
  if (!p) return "기록 확인 중";
  if (!p.ok) return `확인 실패 · ${p.why ?? "기록을 읽지 못함"}`;
  if (!p.session || p.guessed || !UUID.test(p.session) || !p.cwd) return "확인 실패 · 세션을 특정하지 못함";
  if (p.state !== "idle" && p.state !== "done") return "그새 상태가 바뀜";
  if (p.open.length) return `백그라운드 작업이 돎 · ${p.open.length}개`;
  if (p.agentsRunning || p.recordsWorking) return "서브에이전트가 아직 돎";
  return null;
}

// 재울 후보에서 뺀 에이전트와 이유: 정리 화면의 '후보에서 뺀 탭'과 같은 모양 [{ tab, space, address, why }].
//   대상은 에이전트 칸(Claude Code 또는 상태를 보고하는 에이전트) 중 이미 잠든 것을 뺀 것. 1단계(살아 있는 값)에서 빠졌으면 그 이유,
//   1단계를 지났으면 기록 확인 결과(probeWhy). 같은 칸은 첫 이유 하나만.
export function sleepSkips(sps, ps, probes = {}, { now = Date.now(), viewed = new Set(), sleeping = [] } = {}) {
  const asleep = new Set(sleeping.map((r) => r.address));
  const out = [];
  for (const s of sps) {
    for (const tab of [...s.tabs].sort((a, b) => a.index - b.index)) {
      const mine = panesOf(tab.id, ps);
      for (const p of mine) {
        if (!p.terminal || asleep.has(p.terminal)) continue;
        const claude = isClaude(p.program, p.app);
        if (!claude && !p.program?.agent) continue;
        const idle = tab.changed_at ? now - tab.changed_at : null;
        const why = !claude ? `Claude Code만 재울 수 있음 (${p.program?.name ?? "에이전트"})`
          : viewed.has(tab.id) ? "지금 보는 탭"
          : p.status === "working" || p.status === "blocked" ? (p.status === "working" ? "작업 중" : "답 필요")
          : hasWorking(tab, mine) ? "같은 탭에 작업 중인 칸"
          : p.status !== "done" && p.status !== "idle" ? "상태를 모름"
          : idle === null ? "쉰 시간 모름 · 앱을 켠 뒤 변화 없음"
          : idle <= SLEEP_AFTER ? `20분 안에 씀 · ${span(idle)} 변화 없음`
          : probeWhy(probes[p.terminal]);
        if (why) out.push({ tab, space: s, address: p.terminal, why });
      }
    }
  }
  return out;
}

// 백그라운드로 띄운 것 중 아직 안 끝난 tool_use id.
//   launched: 기록 전체에서 grep으로 뽑은 '"tool_use_id":"X","type":"tool_result","content":…"(Command running in background|Async agent launched|Monitor started)' 줄들
//   notes: '<tool-use-id>X</tool-use-id>…<status>S</status>' 줄들(완료 알림). 둘 다 줄바꿈으로 나뉜 글자.
//   끝났다는 상태(DONE)가 붙은 알림만 닫힌 것으로 센다: 상태가 없거나 모르는 낱말이면 아직 도는 것으로(재우지 않는 쪽).
export const DONE = new Set(["completed", "failed", "killed", "stopped", "cancelled", "canceled", "error", "timeout", "expired"]);
export function openBackground(launched, notes) {
  const closed = new Set([...String(notes).matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([a-z_]+)<\/status>/g)]
    .filter((m) => DONE.has(m[2])).map((m) => m[1]));
  const ids = [...String(launched).matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(ids)].filter((id) => !closed.has(id));
}

// hc get records(안에서 도는 서브에이전트) 중 작업 중인 것이 있는지
export const recordsWorking = (records) => Object.values(records ?? {}).some((r) => r?.state === "working" || r?.state === "blocked");

// ps -A -o pid=,ppid=,rss= 출력에서 pid와 그 자손의 RSS 합(KB)
export function treeRss(text, pid) {
  const kids = new Map(), rss = new Map();
  for (const line of String(text).split("\n")) {
    const [a, b, c] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    rss.set(a, Number.isFinite(c) ? c : 0);
    if (!kids.has(b)) kids.set(b, []);
    kids.get(b).push(a);
  }
  if (!rss.has(Number(pid))) return 0;
  let sum = 0;
  const seen = new Set(), stack = [Number(pid)];
  while (stack.length) {
    const x = stack.pop();
    if (seen.has(x)) continue;
    seen.add(x);
    sum += rss.get(x) ?? 0;
    for (const k of kids.get(x) ?? []) stack.push(k);
  }
  return sum;
}

// 잠든 기록 정리: 칸이 살아 있는데 셸이 아니면(사람이 claude를 다시 띄웠거나 다른 프로그램) 지운다.
//   재운 지 GRACE가 안 됐으면 둔다(/exit가 아직 도는 중). 칸이 없어진 기록은 둔다(깨우면 새 탭에서 이어 간다).
//   { keep, drop }
export function pruneSleeping(records, ps, now = Date.now()) {
  const byTerm = new Map(ps.filter((p) => p.terminal).map((p) => [p.terminal, p]));
  const keep = [], drop = [];
  for (const r of records) {
    const p = byTerm.get(r.address);
    if (p && p.pane === r.pane && !isShellPane(p) && now - (r.at ?? 0) > GRACE) drop.push(r);
    else keep.push(r);
  }
  return { keep, drop };
}

// 기록이 가리키는 칸의 지금 모습: "shell"(깨울 수 있다) · "busy"(셸이 아님) · "gone"(칸이 없다)
export function paneState(r, ps) {
  const p = ps.find((x) => x.terminal === r.address && x.pane === r.pane);
  if (!p) return "gone";
  return isShellPane(p) ? "shell" : "busy";
}

// 트리에서 "잠듦"을 붙일 탭 id들: 칸이 살아 있고 셸인 기록의 탭
export function sleepingTabs(records, ps) {
  const out = new Map();
  for (const r of records) {
    if (paneState(r, ps) !== "shell") continue;
    const p = ps.find((x) => x.terminal === r.address);
    if (!out.has(p.tab)) out.set(p.tab, []);
    out.get(p.tab).push(r);
  }
  return out;
}

// 머리 줄: "잠든 에이전트 n · 약 n MB 절약"(재울 때 잰 RSS 합)
export function savedLine(records) {
  if (!records.length) return "";
  const mb = Math.round(records.reduce((s, r) => s + (r.kb ?? 0), 0) / 1024);
  return `잠든 에이전트 ${records.length}${mb ? ` · 약 ${mb} MB 절약` : ""}`;
}

// 기록 하나 바꾸기(같은 주소는 새 것으로) · 지우기
export const upsert = (records, r) => [...records.filter((x) => x.address !== r.address), r];
export const without = (records, address) => records.filter((x) => x.address !== address);
