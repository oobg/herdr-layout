// 에이전트 상태 낱말 표와 '완료 유지' 규칙(herdr를 import하지 않아 node로 시험한다).
//   다른 모드의 같은 표와 맞출 것: office/mods/office-apps/status.js (모드끼리는 import할 수 없어 같은 표를 따로 둔다).
//   완료 유지: Herdr는 완료(done)를 한 번 보면 대기(idle)로 바꾸지만, 다음 일을 시작할 때까지(working·blocked) "완료"로 둔다.
//     사무실(office)이 판단해 공유 상태 FINISHED({ 주소: 끝난 시각 })로 내보내고, office-apps(알림함)는 그 값을 읽는다.

export const STATUS_WORD = { blocked: "답 필요", working: "작업 중", done: "완료", idle: "대기" };
export const UNKNOWN_WORD = "상태 모름";   // 상태를 보고하지 않는 에이전트(status null)
export const FINISHED = "office.finished";

// 상태 → 낱말. null(보고 없음)은 "상태 모름", 모르는 값은 그대로.
export function statusWord(s) {
  return s == null ? UNKNOWN_WORD : STATUS_WORD[s] ?? String(s);
}

// 완료 유지. fin: 주소 → 끝난 시각(Map, 고쳐 쓴다), seen: 주소 → 지난 상태(고쳐 쓴다).
//   tabTime(a): 켜기 전에 이미 끝나 있었을 때 쓰는 탭의 마지막 변화 시각.
//   돌려주는 목록에서 붙잡은 에이전트는 status "done", doneAt = 끝난 시각.
export function holdDone(list, fin, seen, tabTime, now = Date.now()) {
  return list.map((a) => {
    const prev = seen[a.address];
    seen[a.address] = a.status;
    if (a.status === "working" || a.status === "blocked") { fin.delete(a.address); return a; }
    if (a.status === "done" || (a.status === "idle" && (prev === "working" || prev === "done" || fin.has(a.address)))) {
      if (!fin.has(a.address)) fin.set(a.address, prev === "working" || prev === "blocked" ? now : tabTime(a) ?? now);
      return { ...a, status: "done", doneAt: fin.get(a.address) };
    }
    return a;
  });
}
