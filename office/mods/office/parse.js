// Claude Code 대화 기록(jsonl)을 해석한다. herdr를 부르지 않아 node로도 시험할 수 있다.
// office-apps/agent/parse.js(에이전트 앱)에서 고친 내용을 옮겨 왔다(다른 모드라 import로 나눠 쓸 수 없다).
//   - api-request-blob 같은 줄은 지난 메시지를 다시 담고 있어서 대화 줄(user·assistant)만 본다
//   - 같은 tool_use id가 두 번 적혀 있으면 한 번만 센다
//   - 일하는 중에 보낸 메시지(queued_command)도 새 턴으로 본다
//   - 서브에이전트 기록(subagents/agent-<id>.jsonl)은 모든 줄이 isSidechain이라 sidechain 옵션으로 읽는다
// 두 가지를 낸다.
//   parse(text)      기록 끝부분 → 이번 턴의 도구 흐름, 완료 알림(task-id → 상태·도구 수·걸린 시간)
//   scanLines(lines) 셸의 grep 결과 → 세션 전체의 파일 도구와 완료 알림(끝부분만으로는 세션 앞쪽을 모른다)

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
    default: return [String(name).replace(/^mcp__/, "").replace(/__/g, " "), ""];
  }
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((it) => it.type === "text").map((it) => it.text).join("\n") : "");

// 셸이 기록 전체(또는 지난번 뒤로 새로 붙은 부분)에서 grep -o로 뽑는 두 모양. activity.js가 이 식을 셸에 넘긴다.
//   파일 도구: "name":"Read","input":{"file_path":"/절대/경로"
//   완료 알림: <task-id>id</task-id> … <status>completed   (백그라운드 서브에이전트·셸 작업)
export const SCAN = '"name":"(Read|Edit|MultiEdit|Write|NotebookEdit)","input":\\{"(file_path|notebook_path)":"[^"]*"'
  + '|<task-id>[A-Za-z0-9_-]+</task-id>[^<]*<tool-use-id>[^<]*</tool-use-id>[^<]*(<output-file>[^<]*</output-file>[^<]*)?<status>[a-z_]+';
const FILE_KIND = { Read: "읽음", Edit: "수정", MultiEdit: "수정", NotebookEdit: "수정", Write: "작성" };

// grep 결과 줄을 세션 누적 상태에 더한다. files: Map(경로 → 종류), 나중에 본 것이 뒤로 간다. ended: { task-id: 상태 }.
export function scanLines(lines, files, ended) {
  for (const l of lines) {
    if (l.startsWith('"name"')) {
      const m = /^"name":"(\w+)","input":\{"\w+":"(.*)"$/.exec(l);
      if (!m || !m[2].startsWith("/")) continue;
      const path = m[2].replace(/\\\\/g, "\\");
      files.delete(path);
      files.set(path, FILE_KIND[m[1]] ?? "읽음");
    } else if (l.startsWith("<task-id>")) {
      const id = /^<task-id>([^<]+)</.exec(l)?.[1], st = /<status>([a-z_]+)$/.exec(l)?.[1];
      if (id && st) ended[id] = st;
    }
  }
}

// text: 기록 끝부분. cut: 앞이 잘렸는지(잘렸으면 첫 줄은 깨진 줄). sidechain: 서브에이전트 기록인지.
// 반환: { flow, tools, running, ended, agents }
//   flow    이번 턴의 도구를 연속된 같은 종류끼리 묶은 것(길면 마지막 24묶음)
//   tools   이번 턴 도구 호출 수
//   ended   완료 알림에서 읽은 task-id → { status, tools, ms }
//   agents  끝부분에서 본 서브에이전트 호출(세션의 subagents 목록이 없을 때만 쓴다: 옛 기록 형식)
export function parse(text, { cut = true, sidechain = false } = {}) {
  const lines = text.split("\n");
  if (cut) lines.shift();
  let calls = [], askAt = 0;
  const agentCalls = [];
  const done = new Set(), finished = {}, ended = {}, names = {}, agentIds = {};
  for (const line of lines) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain && !sidechain) continue; // 옛 기록 형식: 서브에이전트 내부 줄이 섞여 있으면 건너뛴다
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
        // task-id는 서브에이전트의 agentId
        if (task) ended[task] = finished[id];
      }
    }
    const queued = d.type === "attachment" && d.attachment?.type === "queued_command" && d.attachment.commandMode === "prompt"
      ? textOf(d.attachment.prompt).trim() : "";
    if (!queued && d.type !== "user" && d.type !== "assistant") continue;
    if (queued || (d.type === "user" && !(Array.isArray(content) && content.some((it) => it.type === "tool_result")))) {
      const t = queued || textOf(content).trim();
      // 사람이 보낸 메시지면 새 턴(자동 알림·시스템 메시지는 "<"로 시작해 제외): 그 앞 단계는 버린다.
      // 서브에이전트 기록의 첫 줄(부모가 맡긴 일)도 같은 모양이라 그 서브에이전트의 턴이 된다.
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
  const running = steps.filter((x) => x.running && x.kind === "실행").slice(-2);
  const agents = agentCalls.map(step).map((x) => ({ id: agentIds[x.id] ?? x.id, toolUse: x.id, type: x.input.subagent_type || "general-purpose",
    what: x.target, running: x.running, start: x.at, status: x.end?.status ?? null }));
  const flow = [];
  for (const x of steps) {
    const last = flow[flow.length - 1];
    if (last && last.kind === x.kind) { last.n++; last.running ||= x.running; last.target = x.target; }
    else flow.push({ kind: x.kind, n: 1, running: x.running, target: x.target });
  }
  flow.splice(0, Math.max(0, flow.length - 24));
  return { flow, tools: steps.length, askAt, running, ended, agents };
}
