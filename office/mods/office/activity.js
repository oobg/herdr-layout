// 에이전트가 지금 무엇을 하는지: Claude Code 대화 기록(jsonl)의 끝부분에서 최근 도구 호출을 읽는다.
//   기록 위치: ~/.claude/projects/<에이전트 폴더 경로의 영문·숫자 외 글자를 '-'로>/<세션>.jsonl (가장 최근 것)
//   큰 기록(수십 MB)도 끝 300KB만 읽는다. 결과(tool_result)가 아직 없는 호출은 "지금 하는 중".
import { exec, home } from "herdr";

const TAIL = 300000;

// 도구 → [종류, 대상]. 종류는 흐름 줄에서 같은 것끼리 묶는 데 쓴다.
function describe(name, input, cwd) {
  const short = (p) => (p ? String(p).replace(cwd + "/", "").replace(home(), "~") : "");
  switch (name) {
    case "Read": return ["읽음", short(input.file_path)];
    case "Edit": case "MultiEdit": case "NotebookEdit": return ["수정", short(input.file_path ?? input.notebook_path)];
    case "Write": return ["작성", short(input.file_path)];
    case "Grep": return ["검색", input.pattern ?? ""];
    case "Glob": return ["찾기", input.pattern ?? ""];
    case "Bash": return ["실행", input.description || (input.command ?? "").split("\n")[0]];
    case "Agent": case "Task": return ["서브에이전트", input.description ?? ""];
    case "WebFetch": return ["웹", input.url ?? ""];
    case "WebSearch": return ["웹", input.query ?? ""];
    case "Skill": return ["스킬", input.skill ?? ""];
    default: return [name, ""];
  }
}

export async function readActivity(cwd, on) {
  const dir = `${home()}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;
  const ls = await exec("sh", ["-c", 'ls -t "$1"/*.jsonl 2>/dev/null | head -1', "ls", dir], { on });
  const file = ls.stdout.trim();
  if (!file) return null;
  const r = await exec("tail", ["-c", String(TAIL), file], { on });
  const lines = r.stdout.split("\n");
  lines.shift(); // 잘린 첫 줄
  const calls = [], done = new Set();
  for (const line of lines) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue; // 서브에이전트 내부 기록은 묶어서 하나로 본다
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const it of content) {
      if (it.type === "tool_use") calls.push({ id: it.id, name: it.name, input: it.input ?? {}, at: Date.parse(d.timestamp) || 0 });
      else if (it.type === "tool_result") done.add(it.tool_use_id);
    }
  }
  const steps = calls.map((c) => {
    const [kind, target] = describe(c.name, c.input, cwd);
    return { ...c, kind, target, running: !done.has(c.id) };
  });
  // 실행 중인 스크립트, 서브에이전트, 최근 파일, 흐름
  const running = steps.filter((x) => x.running && x.kind === "실행").slice(-2);
  const agents = steps.filter((x) => x.kind === "서브에이전트").slice(-4)
    .map((x) => ({ type: x.input.subagent_type || "general-purpose", what: x.target, running: x.running, at: x.at }));
  const files = [];
  for (const x of [...steps].reverse()) {
    if (!["읽음", "수정", "작성"].includes(x.kind) || !x.target) continue;
    if (files.some((f) => f.path === x.target)) continue;
    files.push({ kind: x.kind, path: x.target });
    if (files.length >= 6) break;
  }
  // 흐름: 최근 12단계를 연속된 같은 종류끼리 묶는다
  const flow = [];
  for (const x of steps.slice(-12)) {
    const last = flow[flow.length - 1];
    if (last && last.kind === x.kind) { last.n++; last.running ||= x.running; }
    else flow.push({ kind: x.kind, n: 1, running: x.running });
  }
  return { file, running, agents, files, flow, at: Date.now() };
}
