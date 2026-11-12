// 에이전트 상태 낱말 표와 '완료 유지' 읽기(herdr를 import하지 않아 node로 시험한다).
//   다른 모드의 같은 표와 맞출 것: office/mods/office/status.js (모드끼리는 import할 수 없어 같은 표를 따로 둔다).
//   완료 유지: Herdr는 완료(done)를 한 번 보면 대기(idle)로 바꾸지만, 다음 일을 시작할 때까지 "완료"로 둔다.
//     판단은 사무실(office 모드)이 하고 공유 상태 FINISHED({ 주소: 끝난 시각 })로 내보낸다. 여기서는 읽기만 한다.
//     사무실이 돌지 않으면 이 값이 없거나 오래됐을 수 있어, 지금 idle인 에이전트에만 쓴다(working·blocked는 그대로).

export const STATUS_WORD = { blocked: "답 필요", working: "작업 중", done: "완료", idle: "대기" };
export const UNKNOWN_WORD = "상태 모름";   // 상태를 보고하지 않는 에이전트(status null)
export const FINISHED = "office.finished";

// 상태 → 낱말. null(보고 없음)은 "상태 모름", 모르는 값은 그대로.
export function statusWord(s) {
  return s == null ? UNKNOWN_WORD : STATUS_WORD[s] ?? String(s);
}

// 공유 상태 FINISHED를 에이전트 하나에 적용: idle인데 사무실이 완료로 붙잡은 것은 done, doneAt은 끝난 시각.
export function heldDone(a, finished) {
  const at = finished && typeof finished === "object" ? finished[a.address] : undefined;
  if (typeof at !== "number") return a;
  if (a.status === "idle" || a.status === "done") return { ...a, status: "done", doneAt: at };
  return a;
}
