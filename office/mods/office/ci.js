// 오버뷰 머리줄의 CI 낱말(herdr를 import하지 않아 node로 시험한다).
//   지금 브랜치의 마지막 GitHub Actions 실행 하나: gh run list --branch <b> --limit 1 --json status,conclusion,workflowName,url,databaseId
//   실패면 "CI 실패", 도는 중(completed가 아님)이면 "CI 진행 중", 성공·취소·건너뜀 등은 표시하지 않는다.
//   결과는 공유 상태 CI_KEY로 내보낸다: { repo, branch, status, conclusion, failed, workflow, url, id, at } 또는 null.
//     office-apps 알림함이 failed면 맨 위에 "CI 실패" 줄을 보인다.

export const CI_KEY = "office.ci";
export const CI_EVERY = 120000;   // 2분
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

// origin URL → "owner/name". GitHub가 아니면 null(조용히 생략).
export function githubRepo(url) {
  const m = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/\s]+@)?github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? "").trim());
  return m ? m[1] : null;
}

// gh run list --json 출력 → 내보낼 값. 실행이 없거나 읽지 못하면 null.
export function ciRun(stdout, repo, branch, now = Date.now()) {
  let list;
  try { list = JSON.parse(stdout || "[]"); } catch { return null; }
  const x = Array.isArray(list) ? list[0] : null;
  if (!x) return null;
  const conclusion = x.conclusion || null;
  return { repo, branch, status: x.status ?? null, conclusion, failed: x.status === "completed" && FAILED.has(conclusion),
    workflow: x.workflowName ?? "", url: x.url ?? "", id: x.databaseId ?? null, at: now };
}

// 머리줄 낱말: { word, fail } 또는 null(표시 안 함)
export function ciWord(run) {
  if (!run) return null;
  if (run.failed) return { word: "CI 실패", fail: true };
  if (run.status && run.status !== "completed") return { word: "CI 진행 중", fail: false };
  return null;
}

// 내보낼 값이 바뀌었는지(확인 시각 at은 빼고 비교: 2분마다 모든 모드를 다시 그리지 않게)
export function sameCi(a, b) {
  const k = (v) => (v ? JSON.stringify({ ...v, at: 0 }) : "null");
  return k(a) === k(b);
}
