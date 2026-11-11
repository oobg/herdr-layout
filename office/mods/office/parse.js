// Claude Code 대화 기록(jsonl) 끝부분을 읽어 "에이전트가 지금 하는 일"을 뽑는다.
// office-apps/agent/parse.js(에이전트 앱)에서 고친 내용을 옮겨 왔다(다른 모드라 import로 나눠 쓸 수 없다).
//   - api-request-blob 같은 줄은 지난 메시지를 다시 담고 있어서 대화 줄(user·assistant)만 본다
//   - 같은 tool_use id가 두 번 적혀 있으면 한 번만 센다(서브에이전트가 두 줄씩 나오던 원인)
//   - 일하는 중에 보낸 메시지(queued_command)도 새 턴으로 본다
//   - 완료 알림의 task-id(=agentId)로도 끝난 서브에이전트를 맞춘다
// herdr를 부르지 않아 node로도 시험할 수 있다. 반환 모양은 main.js의 activityView가 쓰는 그대로다.

// 도구 → [종류, 대상]. 종류는 흐름 줄에서 같은 것끼리 묶는 데 쓴다.
export function describe(name, input) {
  const s = (p) => (p ? String(p) : "");   // 파일은 절대 경로 그대로(화면에서 위치 칩으로 줄인다)
  switch (name) {
    case "Read": return ["읽음", s(input.file_path)];
    case "Edit": case "MultiEdit": case "NotebookEdit": return ["수정", s(input.file_path ?? input.notebook_path)];
    case "Write": return ["작성", s(input.file_path)];
    case "Grep": return ["검색", s(input.pattern)];
    case "Glob": return ["찾기", s(input.pattern)];
    case "Bash": return ["실행", input.description || s(input.command).split("\n")[0]];
    case "Agent": case "Task": return ["서브에이전트", s(input.description)];
    case "WebFetch": return ["웹", s(input.url)];
    case "WebSearch": return ["웹", s(input.query)];
    case "Skill": return ["스킬", s(input.skill)];
    default: return [name, ""];
  }
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((it) => it.type === "text").map((it) => it.text).join("\n") : "");

// text: 기록 끝부분. cut: 앞이 잘렸는지(잘렸으면 첫 줄은 깨진 줄이라 버린다).
// 반환: { running, agents, files, flow }
export function parse(text, { cut = true } = {}) {
  const lines = text.split("\n");
  if (cut) lines.shift();
  let calls = [], askAt = 0;
  const agentCalls = [];   // 서브에이전트 호출은 턴이 바뀌어도 남긴다(백그라운드는 다음 턴까지 돈다)
  const done = new Set(), finished = {}, ended = {}, names = {}, agentIds = {};
  for (const line of lines) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue; // 서브에이전트 내부 기록은 묶어서 하나로 본다
    const at = Date.parse(d.timestamp) || 0;
    const content = d.message?.content;
    // 백그라운드 서브에이전트 완료 알림은 도구 결과와 같은 메시지에 섞여 오기도 한다: 줄 전체에서 찾는다
    if (line.includes("<task-notification>")) {
      const raw = line.replace(/\\n/g, "\n");
      for (const m of raw.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(m[0])?.[1];
        if (!id) continue;
        const task = /<task-id>([^<]+)<\/task-id>/.exec(m[0])?.[1];
        finished[id] = {
          status: /<status>([^<]+)<\/status>/.exec(m[0])?.[1] ?? "completed",
          tools: Number(/<tool_uses>(\d+)<\/tool_uses>/.exec(m[0])?.[1] ?? NaN),
          ms: Number(/<duration_ms>(\d+)<\/duration_ms>/.exec(m[0])?.[1] ?? NaN),
        };
        // task-id는 서브에이전트의 agentId: tool-use-id가 안 맞아도 이것으로 끝난 것을 안다
        if (task) ended[task] = finished[id];
      }
    }
    // 일하는 중에 사람이 보낸 메시지는 queued_command 첨부로 들어온다: 이것도 새 턴
    const queued = d.type === "attachment" && d.attachment?.type === "queued_command" && d.attachment.commandMode === "prompt"
      ? textOf(d.attachment.prompt).trim() : "";
    // 대화 줄(user·assistant)만 본다. api-request-blob 같은 줄은 지난 메시지를 다시 담고 있어 겹친다.
    if (!queued && d.type !== "user" && d.type !== "assistant") continue;
    if (queued || (d.type === "user" && !(Array.isArray(content) && content.some((it) => it.type === "tool_result")))) {
      const t = queued || textOf(content).trim();
      // 사람이 보낸 메시지면 새 턴(자동 알림·시스템 메시지는 "<"로 시작해 제외): 그 앞 단계는 버린다
      if (!d.isMeta && t && !t.startsWith("<") && !t.startsWith("[Request interrupted")) { calls = []; askAt = at; }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const it of content) {
      if (it.type === "tool_use") {
        if (names[it.id]) continue; // 같은 호출이 두 번 적힌 줄
        const c = { id: it.id, name: it.name, input: it.input ?? {}, at };
        calls.push(c);
        names[it.id] = it.name;
        if (/^(Agent|Task)$/.test(it.name)) agentCalls.push(c);
      } else if (it.type === "tool_result") {
        if (/^(Agent|Task)$/.test(names[it.tool_use_id] ?? "")) {
          const body = textOf(it.content);
          const aid = /agentId: ([A-Za-z0-9]+)/.exec(body)?.[1];
          if (aid) agentIds[it.tool_use_id] = aid;
          // 백그라운드로 띄운 서브에이전트는 "시작했다"는 결과가 바로 온다: 끝난 게 아니다
          if (/Async agent launched/.test(body)) continue;
        }
        done.add(it.tool_use_id);
      }
    }
  }
  const step = (c) => {
    const [kind, target] = describe(c.name, c.input);
    const end = finished[c.id] ?? (agentIds[c.id] ? ended[agentIds[c.id]] : undefined);
    return { ...c, kind, target, running: !done.has(c.id) && !end, end };
  };
  const steps = calls.map(step);
  // 실행 중인 스크립트
  const running = steps.filter((x) => x.running && x.kind === "실행").slice(-2);
  // 서브에이전트: 아직 도는 것은 언제 띄웠든, 끝난 것은 이번 턴 것만(최근 4개)
  const agents = agentCalls.map(step).filter((x) => x.running || x.at >= askAt).slice(-4)
    .map((x) => ({ type: x.input.subagent_type || "general-purpose", what: x.target, running: x.running, at: x.at,
      failed: Boolean(x.end && x.end.status !== "completed"), tools: x.end?.tools, ms: x.end?.ms }));
  // 최근 파일(겹치면 최근 것 하나)
  const files = [];
  for (const x of [...steps].reverse()) {
    if (!["읽음", "수정", "작성"].includes(x.kind) || !x.target) continue;
    if (files.some((f) => f.path === x.target)) continue;
    files.push({ kind: x.kind, path: x.target });
    if (files.length >= 6) break;
  }
  // 흐름: 이번 턴의 단계를 연속된 같은 종류끼리 묶는다(길면 마지막 10묶음)
  const flow = [];
  for (const x of steps) {
    const last = flow[flow.length - 1];
    if (last && last.kind === x.kind) { last.n++; last.running ||= x.running; last.target = x.target; }
    else flow.push({ kind: x.kind, n: 1, running: x.running, target: x.target });
  }
  flow.splice(0, Math.max(0, flow.length - 10));
  return { running, agents, files, flow };
}
