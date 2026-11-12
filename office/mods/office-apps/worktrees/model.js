// 워크트리 앱의 순수 함수. herdr를 import하지 않아 node로 시험할 수 있다.
//   parseWorktrees  `git worktree list --porcelain` → [{ path, head, branch, detached, bare, locked, prunable, main }]
//   parseStatus     `git status --porcelain -z` → [{ code, path, from }]
//   validName       브랜치 이름 막을 것(branch.js BranchPrompt.bad와 같은 규칙) → 이유 글 또는 ""
//   slug            이슈 제목 → 영문·숫자만 이은 슬러그("" 가능)
//   issueBranch     이슈 → issue-<번호>-<슬러그>(슬러그가 없으면 issue-<번호>)
//   worktreePath    <레포>/../<레포 이름>-<브랜치 이름, '/'는 '-'로>
//   worktreeOf      폴더 → 그 폴더를 품은 워크트리 경로(가장 깊은 것), 없으면 null
//   parseCounts     `rev-list --left-right --count A...B` → { behind, ahead } | null
//   liveAgentsIn    워크트리 → 그 폴더에서 터미널이 열려 있는 에이전트 칸(지우기를 막는다)

// 빈 줄로 나뉜 덩어리마다 한 워크트리. 첫 덩어리가 메인 워크트리다.
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text ?? "").split(/\n\s*\n/)) {
    const w = { path: null, head: null, branch: null, detached: false, bare: false, locked: null, prunable: null, main: false };
    for (const line of block.split("\n")) {
      if (!line) continue;
      const sp = line.indexOf(" "), k = sp < 0 ? line : line.slice(0, sp), v = sp < 0 ? "" : line.slice(sp + 1);
      if (k === "worktree") w.path = v;
      else if (k === "HEAD") w.head = v;
      else if (k === "branch") w.branch = v.startsWith("refs/heads/") ? v.slice(11) : v;
      else if (k === "detached") w.detached = true;
      else if (k === "bare") w.bare = true;
      else if (k === "locked") w.locked = v || "잠김";
      else if (k === "prunable") w.prunable = v || "폴더 없음";
    }
    if (w.path) out.push(w);
  }
  if (out.length) out[0].main = true;
  return out;
}

// -z 형식: "XY 경로\0", 이름 바꾸기·복사(R·C)는 그 뒤에 "\0원래 경로"가 하나 더 온다.
export function parseStatus(text) {
  const parts = String(text ?? "").split("\0"), out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2), path = p.slice(3);
    let from = null;
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") from = parts[++i] ?? null;
    out.push({ code, path, from });
  }
  return out;
}

// 상태 글자 → 사람 말(색만으로 구분하지 않게 낱말로 붙인다).
export function statusWord(code) {
  if (code === "??") return "새 파일";
  if (code.includes("U") || code === "AA" || code === "DD") return "충돌";
  if (code.includes("D")) return "삭제";
  if (code.includes("R")) return "이름 바뀜";
  if (code.includes("A")) return "추가";
  return "수정";
}

export function validName(name) {
  if (!name) return "이름을 넣으세요";
  if (name.startsWith("-")) return "-로 시작할 수 없습니다";
  if (/\s/.test(name)) return "빈칸은 쓸 수 없습니다";
  return "";
}

export function slug(title, max = 40) {
  const s = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > max ? s.slice(0, max).replace(/-+[^-]*$/, "") || s.slice(0, max) : s;
}

export function issueBranch(number, title) {
  const s = slug(title);
  return s ? `issue-${number}-${s}` : `issue-${number}`;
}

const parent = (p) => { const t = p.replace(/\/+$/, ""); const i = t.lastIndexOf("/"); return i <= 0 ? "/" : t.slice(0, i); };
const base = (p) => { const t = p.replace(/\/+$/, ""); return t.slice(t.lastIndexOf("/") + 1); };

export function worktreePath(root, name) {
  const dir = parent(root), leaf = `${base(root)}-${String(name).replace(/\//g, "-")}`;
  return dir === "/" ? `/${leaf}` : `${dir}/${leaf}`;
}

// "/a/repo-x"가 "/a/repo"로 시작해도 같은 폴더가 아니다: 경로 경계("/")까지 맞아야 한다. 가장 깊은 것을 고른다.
export function worktreeOf(cwd, paths) {
  if (!cwd) return null;
  const c = cwd.replace(/\/+$/, "");
  let best = null;
  for (const p of paths) {
    const w = p.replace(/\/+$/, "");
    if ((c === w || c.startsWith(`${w}/`)) && (!best || w.length > best.length)) best = w;
  }
  return best;
}

// A...B 에서 왼쪽은 A에만(= B가 뒤처진 수), 오른쪽은 B에만(= B가 앞선 수).
export function parseCounts(text) {
  const m = /^(\d+)\s+(\d+)/.exec(String(text ?? "").trim());
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
}

export const counts = (ahead, behind) => [ahead && `${ahead}개 앞섬`, behind && `${behind}개 뒤처짐`].filter(Boolean).join(" · ");

// 그 워크트리 폴더(안쪽 폴더 포함)에서 살아 있는 에이전트 칸: 터미널이 열려 있고 상태를 보고하거나(작업 중·답 필요·완료·대기)
// 에이전트 프로그램(상태를 보고하지 않는 Codex 등)인 것. 같은 기기의 칸만. 더 깊은 다른 워크트리 안의 칸은 그 워크트리 것이다.
//   ps: panes() 모양, all: 워크트리 경로 전부, on: 워크트리 기기(null = 이 컴퓨터), machineOfTab: 탭 id → 기기
export function liveAgentsIn(path, all, ps, { on = null, machineOfTab = () => null } = {}) {
  const w = String(path).replace(/\/+$/, "");
  const paths = all.includes(path) ? all : [...all, path];
  // 에이전트가 끝나고 셸만 남은 칸은 마지막 상태 보고가 남아 있어도 뺀다(재우거나 끝내면 풀려야 한다). 작업 중·답 필요는 그대로 막는다.
  const ended = (p) => p.program?.shell && !p.program?.agent && p.status !== "working" && p.status !== "blocked";
  return ps.filter((p) => p.terminal && (p.status || p.program?.agent) && !ended(p)
    && (machineOfTab(p.tab) ?? null) === (on ?? null) && worktreeOf(p.cwd, paths) === w);
}
