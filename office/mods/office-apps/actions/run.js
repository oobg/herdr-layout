// 배포 앱의 순수 함수(herdr를 import하지 않아 node로 시험할 수 있다).
//   state(x)              실행·잡·단계 하나 → { kind, word, sym } (kind: working|wait|done|fail|cancel|skip|action)
//   active(x)             끝나지 않았는가
//   elapsed(from, to, now) · dur(ms) · ago(iso, now)   걸린 시간·상대 시각
//   filterRuns(runs, f, branch)   목록 필터(all|branch|fail|active)
//   tailLog(raw, n, job)       gh run view --log-failed 출력 → { job, lines: [{ text, err, hard, group }], first }
//                         (마지막 ##[error] 줄이 있는 잡의, 그 줄에서 끝나는 n줄. first: 첫 진짜 오류 줄 위치)
//   failSpot(view)        실패한 첫 잡과 그 안의 실패 단계 { job, jobId, step, url, more }
//   tellText(view, log, n)  에이전트에게 보낼 글
//   latestDeploys(nodes)  GraphQL deployments → 환경마다 최신 하나 { env, state, kind, word, sym, ref, at, run }
//   addPin · dropPin      지켜보기 핀 목록(최대 MAX_PINS)

export const MAX_PINS = 3;
const LINE_MAX = 300;   // 에이전트에게 보내는 로그 한 줄의 최대 글자

// GitHub 시각의 빈 값("0001-01-01T00:00:00Z")은 없음으로
export function when(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) && t > 0 ? t : null;
}

// 실행(run)·잡(job)·단계(step) 공통. status: queued|in_progress|completed|waiting|requested|pending,
// conclusion: success|failure|cancelled|skipped|timed_out|action_required|neutral|stale|startup_failure
export function state(x) {
  const s = String(x?.status ?? "").toLowerCase(), c = String(x?.conclusion ?? "").toLowerCase();
  if (s === "in_progress") return { kind: "working", word: "진행 중", sym: "⟳" };
  if (s && s !== "completed") return { kind: "wait", word: "대기", sym: "○" };
  if (c === "success") return { kind: "done", word: "성공", sym: "✓" };
  if (c === "failure" || c === "startup_failure") return { kind: "fail", word: "실패", sym: "✕" };
  if (c === "timed_out") return { kind: "fail", word: "시간 초과", sym: "✕" };
  if (c === "cancelled") return { kind: "cancel", word: "취소", sym: "–" };
  if (c === "action_required") return { kind: "action", word: "승인 필요", sym: "!" };
  if (c === "skipped" || c === "neutral" || c === "stale") return { kind: "skip", word: "건너뜀", sym: "–" };
  return { kind: "wait", word: "대기", sym: "○" };
}

export const active = (x) => String(x?.status ?? "").toLowerCase() !== "completed";

// 걸린 시간(ms). 끝나지 않았으면 now까지. 시작을 모르면 null.
export function elapsed(from, to, now = Date.now()) {
  const a = when(from);
  if (a === null) return null;
  const b = when(to) ?? now;
  return Math.max(0, b - a);
}

export function dur(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export function ago(iso, now = Date.now()) {
  const t = when(iso);
  if (t === null) return "";
  const s = (now - t) / 1000;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  const d = new Date(t);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

// 목록 한 줄의 걸린 시간: 끝났으면 만든 시각 → 마지막 갱신, 도는 중이면 지금까지
//   대기·승인 필요·건너뜀은 돌지 않았으니 null. 끝난 실행의 updatedAt은 늦게 바뀔 때가 있어 상세에서는 jobTime을 쓴다.
export function runTime(r, now = Date.now()) {
  if (["wait", "action", "skip"].includes(state(r).kind)) return null;
  return elapsed(r.startedAt ?? r.createdAt, active(r) ? null : r.updatedAt, now);
}

// 잡들의 첫 시작 → 마지막 끝(도는 잡이 있으면 지금까지). 잡이 없으면 null.
export function jobTime(jobs, now = Date.now()) {
  const starts = (jobs ?? []).map((j) => when(j.startedAt)).filter((x) => x !== null);
  if (!starts.length) return null;
  const going = (jobs ?? []).some((j) => active(j) && when(j.startedAt) !== null);
  const ends = (jobs ?? []).map((j) => when(j.completedAt)).filter((x) => x !== null);
  const end = going || !ends.length ? now : Math.max(...ends);
  return Math.max(0, end - Math.min(...starts));
}

export const FILTERS = [
  { id: "all", name: "전체", empty: "실행 기록이 없습니다" },
  { id: "branch", name: "지금 브랜치", empty: "이 브랜치의 실행이 없습니다" },
  { id: "fail", name: "실패만", empty: "실패한 실행이 없습니다" },
  { id: "active", name: "진행 중", empty: "도는 실행이 없습니다" },
];

export function filterRuns(runs, f, branch) {
  const list = runs ?? [];
  if (f === "branch") return branch ? list.filter((r) => r.headBranch === branch) : [];
  if (f === "fail") return list.filter((r) => state(r).kind === "fail");
  if (f === "active") return list.filter(active);
  return list;
}

// ── 실패 로그
// gh run view --log-failed 한 줄: "<잡>\t<단계>\t<시각> <내용>". 시각·색 코드를 떼고 ##[error]·##[group]을 알아본다.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const ERRISH = /^\s*(error|fatal)\b|\berror(\[|:)|\bFAIL(ED)?\b|✖|✗|^\s*npm ERR!/i;

export function logLine(raw) {
  const cols = raw.split("\t");
  const job = cols.length >= 3 ? cols[0] : "";
  let text = (cols.length >= 3 ? cols.slice(2).join("\t") : raw).replace(ANSI, "").replace(STAMP, "").replace(/\r$/, "");
  let err = false, hard = false, group = false, skip = false;
  if (text.startsWith("##[error]")) { text = text.slice(9); err = true; hard = true; }
  else if (text.startsWith("##[group]")) { text = `▸ ${text.slice(9)}`; group = true; }
  else if (text.startsWith("##[endgroup]")) skip = true;
  else if (/^##\[(warning|notice|debug)\]/.test(text)) text = text.replace(/^##\[(\w+)\]/, "$1: ");
  else if (ERRISH.test(text)) err = true;
  return { job, text, err, hard, group, skip };
}

// 마지막 ##[error] 줄이 있는 잡의 줄만, 그 오류 줄에서 끝나는 n줄. 오류 줄이 없으면 끝 n줄.
// job: 그 잡의 줄만(failSpot과 같은 잡을 보이려고). 그 이름의 줄이 없으면 모든 줄에서.
export function tailLog(raw, n = 80, job = null) {
  let all = String(raw ?? "").split("\n").filter((l) => l.length).map(logLine).filter((l) => !l.skip);
  if (job && all.some((l) => l.job === job)) all = all.filter((l) => l.job === job);
  if (!all.length) return { job: "", lines: [], first: -1 };
  let end = -1;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].hard) { end = i; break; }
  const name = (end >= 0 ? all[end] : all[all.length - 1]).job;
  const mine = all.slice(0, end >= 0 ? end + 1 : all.length).filter((l) => l.job === name);
  const lines = mine.slice(-n).map(({ text, err, hard, group }) => ({ text, err, hard, group }));
  // 에이전트에게 보낼 때 시작점: 창 안의 첫 진짜 오류 줄("Process completed with exit code n"은 뺀다)
  const first = lines.findIndex((l) => l.hard && !EXIT.test(l.text));
  return { job: name, lines, first };
}
const EXIT = /^Process completed with exit code/;

// 실패한 첫 잡과 그 실패 단계
export function failSpot(view) {
  const job = (view?.jobs ?? []).find((j) => state(j).kind === "fail");
  if (!job) return null;
  const step = (job.steps ?? []).find((s) => state(s).kind === "fail");
  const failed = (view?.jobs ?? []).filter((j) => state(j).kind === "fail").length;
  return { job: job.name, jobId: job.databaseId ?? null, step: step?.name ?? null, url: job.url ?? null, more: failed - 1 };
}

export function tellText(view, log, n = 20) {
  const spot = failSpot(view);
  const where = spot ? (spot.step ? `${spot.job} / ${spot.step}` : spot.job) : "잡을 알 수 없음";
  // 첫 진짜 오류 줄 앞 3줄부터 n줄. 그런 줄이 없으면 끝 n줄.
  const lines = log?.lines ?? [], at = log?.first ?? -1;
  const start = at >= 0 ? Math.max(0, at - 3) : Math.max(0, lines.length - n);
  const tail = lines.slice(start, start + n).map((l) => (l.text.length > LINE_MAX ? `${l.text.slice(0, LINE_MAX)}…` : l.text)).join("\n").trim();
  return [`${view?.workflowName ?? "워크플로"} 실패: ${where}`, view?.url ?? "", tail].filter(Boolean).join("\n");
}

// ── 배포(GraphQL repository.deployments nodes)
const DEPLOY = {
  SUCCESS: ["done", "성공", "✓"], ACTIVE: ["done", "활성", "✓"], INACTIVE: ["skip", "비활성", "–"],
  IN_PROGRESS: ["working", "진행 중", "⟳"], QUEUED: ["wait", "대기", "○"], PENDING: ["wait", "대기", "○"], WAITING: ["wait", "승인 대기", "○"],
  FAILURE: ["fail", "실패", "✕"], ERROR: ["fail", "오류", "✕"], DESTROYED: ["cancel", "삭제됨", "–"], ABANDONED: ["cancel", "중단", "–"],
};
export function latestDeploys(nodes) {
  const seen = new Map();
  for (const d of [...(nodes ?? [])].sort((a, b) => (when(b.createdAt) ?? 0) - (when(a.createdAt) ?? 0))) {
    if (!d?.environment || seen.has(d.environment)) continue;
    const st = d.latestStatus?.state ?? d.state ?? "";
    const [kind, word, sym] = DEPLOY[st] ?? ["wait", String(st).toLowerCase() || "모름", "○"];
    const run = /\/actions\/runs\/(\d+)/.exec(d.latestStatus?.logUrl ?? "")?.[1] ?? null;
    seen.set(d.environment, { env: d.environment, state: st, kind, word, sym, ref: d.ref?.name ?? (d.commitOid ?? "").slice(0, 7),
      at: d.latestStatus?.createdAt ?? d.updatedAt ?? d.createdAt, url: d.latestStatus?.environmentUrl ?? null, run });
  }
  return [...seen.values()];
}

// ── 지켜보기 핀: [{ id, root, on, repo, workflow, title, at }]
export function addPin(pins, pin) {
  const list = (pins ?? []).filter((p) => p.id !== pin.id);
  if (list.length >= MAX_PINS) return { pins: pins ?? [], full: true };
  return { pins: [...list, pin], full: false };
}
export const dropPin = (pins, id) => (pins ?? []).filter((p) => p.id !== id);
