// PR 상태 읽기(herdr를 import하지 않아 node로 시험할 수 있다).
//   check(c)        체크 한 개 → { state: pass|fail|pending|skip, name, link, group }
//   readiness(p)    gh pr view 결과 → { fail, pending, pass, total, decision, text, risky } (병합 확인 창의 요약 한 줄)
//   failHint(s)     gh 실패 stderr → 한국어 한 줄(모르는 오류면 null)

// 체크 한 개: CheckRun(name·status·conclusion) 또는 StatusContext(context·state)
export function check(c) {
  let s;
  if (c.__typename === "StatusContext" || (c.context && !c.name)) {
    s = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail" }[c.state] ?? "pending";
  } else if (c.status && c.status !== "COMPLETED") s = "pending";
  else s = { SUCCESS: "pass", NEUTRAL: "skip", SKIPPED: "skip" }[c.conclusion] ?? "fail";
  return { state: s, name: c.name ?? c.context ?? "", link: c.detailsUrl ?? c.targetUrl ?? "", group: c.workflowName ?? "" };
}

const DECISION_TEXT = { APPROVED: "리뷰 승인", CHANGES_REQUESTED: "변경 요청", REVIEW_REQUIRED: "리뷰 대기" };

// 체크·리뷰 상태 요약. risky: 체크 실패나 변경 요청이 있어 그래도 병합할지 다시 물어야 할 때.
export function readiness(p) {
  const list = (p?.statusCheckRollup ?? []).map(check);
  const n = (s) => list.filter((c) => c.state === s).length;
  const fail = n("fail"), pending = n("pending"), pass = n("pass"), decision = p?.reviewDecision ?? null;
  const parts = [];
  if (fail) parts.push(`체크 실패 ${fail}`);
  else if (pending) parts.push(`체크 대기 ${pending}`);
  else if (list.length) parts.push(`체크 통과 ${pass}`);
  if (DECISION_TEXT[decision]) parts.push(DECISION_TEXT[decision]);
  return { fail, pending, pass, total: list.length, decision, text: parts.join(" · "), risky: fail > 0 || decision === "CHANGES_REQUESTED" };
}

// 자주 나오는 gh 실패를 한국어 한 줄로. 앞에 있는 것이 먼저 맞는다.
const HINTS = [
  [/head branch was modified|expected head sha|head commit .*(does not match|mismatch)/i, "확인한 뒤 PR에 새 커밋이 올라왔습니다. 다시 읽고 확인하세요"],
  [/required status check|status checks? (are|is) (expected|failing|pending)|checks? (have|has) not passed/i, "필수 체크가 통과하지 않았습니다"],
  [/approving review|review(s)? (is|are) required|review required/i, "필수 리뷰 승인이 없습니다"],
  [/merge conflict|has conflicts|not mergeable|is not mergeable/i, "충돌이 있거나 지금은 병합할 수 없는 상태입니다"],
  [/protected branch|branch protection|base branch policy|repository rule/i, "브랜치 보호 규칙이 막았습니다"],
  [/already (been )?merged|was already merged/i, "이미 병합된 PR입니다"],
  [/already closed|is closed/i, "이미 닫힌 PR입니다"],
  [/would be overwritten|local changes|uncommitted changes|untracked working tree files/i, "커밋 안 된 변경과 겹쳐 진행하지 못했습니다"],
  [/gh auth login|HTTP 401|not logged/i, "gh 로그인이 필요합니다(터미널에서 gh auth login)"],
  [/HTTP 403|resource not accessible|permission/i, "권한이 없습니다"],
  [/could not resolve host|timed? ?out|network|connection (refused|reset)/i, "GitHub에 연결하지 못했습니다"],
];

export function failHint(s) {
  const text = String(s ?? "");
  for (const [re, hint] of HINTS) if (re.test(text)) return hint;
  return null;
}
