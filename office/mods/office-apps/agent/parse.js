// Claude Code 대화 기록(jsonl) 끝부분을 읽어 "에이전트가 지금 하는 일"을 뽑는다.
// office/mods/office/activity.js의 파서를 옮겨 와 고쳤다(herdr를 부르지 않아 node로도 시험할 수 있다).
//   - 서브에이전트 기록(subagents/agent-<id>.jsonl)은 모든 줄이 isSidechain이라 sidechain 옵션으로 읽는다
//   - 파일 전체를 읽었으면(cut=false) 첫 줄을 버리지 않는다: 서브에이전트에게 준 요청이 첫 줄에 있다
//   - 이번 턴의 요청(ask)과 마지막 말(say, 그 시각 sayAt), 고친 파일, 서브에이전트의 agentId를 함께 낸다

// 도구 → [종류, 대상]. 종류는 흐름 줄에서 같은 것끼리 묶는 데 쓴다.
export function describe(name, input) {
  const s = (p) => (p ? String(p) : "");
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
    default: return [name.replace(/^mcp__/, "").replace(/__/g, " "), ""];
  }
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((it) => it.type === "text").map((it) => it.text).join("\n") : "");
const clip = (s, n) => { const x = s.replace(/\s+\n/g, "\n").trim(); return x.length > n ? `${x.slice(0, n).trimEnd()}…` : x; };

// text: 기록 끝부분. cut: 앞이 잘렸는지(잘렸으면 첫 줄은 깨진 줄). sidechain: 서브에이전트 기록인지.
export function parse(text, { cut = true, sidechain = false } = {}) {
  const lines = text.split("\n");
  if (cut) lines.shift();
  let calls = [], ask = "", lastPrompt = "", askAt = 0, say = "", sayAt = 0, lastAt = 0, model = "";
  const agentCalls = [];   // 서브에이전트 호출은 턴이 바뀌어도 남긴다(백그라운드는 다음 턴까지 돈다)
  const done = new Set(), launched = new Set(), finished = {}, ended = {}, names = {}, agentIds = {};
  for (const line of lines) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain && !sidechain) continue; // 옛 기록 형식: 서브에이전트 내부 줄이 섞여 있으면 건너뛴다
    const at = Date.parse(d.timestamp) || 0;
    if (at) lastAt = Math.max(lastAt, at);
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
        // task-id는 서브에이전트의 agentId: 띄운 줄이 기록 끝에서 잘려 나가도 끝난 것을 알 수 있다
        if (task) ended[task] = finished[id];
      }
    }
    // 마지막 사람 요청(기록 끝이 도구 결과로 가득해 요청 줄이 잘려 나가도 남는다)
    if (d.type === "last-prompt") { if (typeof d.lastPrompt === "string") lastPrompt = d.lastPrompt; continue; }
    // 일하는 중에 사람이 보낸 메시지는 queued_command 첨부로 들어온다: 이것도 새 턴
    const queued = d.type === "attachment" && d.attachment?.type === "queued_command" && d.attachment.commandMode === "prompt"
      ? textOf(d.attachment.prompt).trim() : "";
    // 대화 줄(user·assistant)만 본다. api-request-blob 같은 줄은 지난 메시지를 다시 담고 있어 겹친다.
    if (!queued && d.type !== "user" && d.type !== "assistant") continue;
    if (queued || (d.type === "user" && !(Array.isArray(content) && content.some((it) => it.type === "tool_result")))) {
      const t = queued || textOf(content).trim();
      // 사람이 보낸 메시지면 새 턴(자동 알림·시스템 메시지는 "<"로 시작해 제외): 그 앞 단계는 버린다
      if (!d.isMeta && t && !t.startsWith("<") && !t.startsWith("[Request interrupted")) {
        calls = []; ask = clip(t, 600); askAt = at; say = ""; sayAt = 0;
      }
      continue;
    }
    if (d.type === "assistant" && d.message?.model && d.message.model !== "<synthetic>") model = d.message.model;
    if (!Array.isArray(content)) continue;
    for (const it of content) {
      if (it.type === "text" && d.type === "assistant" && it.text?.trim()) { say = clip(it.text, 400); sayAt = at; }
      else if (it.type === "tool_use") {
        if (names[it.id]) continue; // 같은 호출이 두 번 적힌 줄
        const c = { id: it.id, name: it.name, input: it.input ?? {}, at };
        calls.push(c);
        names[it.id] = it.name;
        if (/^(Agent|Task)$/.test(it.name)) agentCalls.push(c);
      } else if (it.type === "tool_result") {
        const name = names[it.tool_use_id] ?? "";
        if (/^(Agent|Task)$/.test(name)) {
          const body = textOf(it.content);
          const aid = /agentId: ([A-Za-z0-9]+)/.exec(body)?.[1];
          if (aid) agentIds[it.tool_use_id] = aid;
          // 백그라운드로 띄운 서브에이전트는 "시작했다"는 결과가 바로 온다: 끝난 게 아니다
          if (/Async agent launched/.test(body)) { launched.add(it.tool_use_id); continue; }
        }
        done.add(it.tool_use_id);
      }
    }
  }
  const step = (c) => {
    const [kind, target] = describe(c.name, c.input);
    const end = finished[c.id];
    return { ...c, kind, target, running: !done.has(c.id) && !end, end };
  };
  const steps = calls.map(step);
  const running = steps.filter((x) => x.running && x.kind === "실행").slice(-2);
  // 서브에이전트: 아직 도는 것은 언제 띄웠든, 끝난 것은 이번 턴 것만
  const agents = agentCalls.map(step).filter((x) => x.running || x.at >= askAt).slice(-8)
    .map((x) => ({ id: x.id, agentId: agentIds[x.id] ?? null, type: x.input.subagent_type || "general-purpose", what: x.target,
      running: x.running, background: launched.has(x.id), at: x.at,
      failed: Boolean(x.end && x.end.status !== "completed"), tools: x.end?.tools, ms: x.end?.ms }));
  // 고친 파일(최근 것부터, 같은 파일은 한 번)
  const edited = [];
  for (const x of [...steps].reverse()) {
    if (!x.target) continue;
    if ((x.kind === "수정" || x.kind === "작성") && !edited.some((f) => f.path === x.target)) edited.push({ kind: x.kind, path: x.target });
  }
  // 흐름: 이번 턴의 단계를 연속된 같은 종류끼리 묶는다(길면 마지막 24묶음)
  const flow = [];
  for (const x of steps) {
    const last = flow[flow.length - 1];
    if (last && last.kind === x.kind) { last.n++; last.running ||= x.running; last.target = x.target; last.at = x.at; }
    else flow.push({ kind: x.kind, n: 1, running: x.running, target: x.target, at: x.at });
  }
  const hidden = Math.max(0, flow.length - 24);
  flow.splice(0, hidden);
  return { ask: ask || clip(lastPrompt, 600), askAt, say, sayAt, model, lastAt, tools: steps.length, running, agents, ended,
    edited: edited.slice(0, 15), moreEdited: Math.max(0, edited.length - 15),
    flow, hidden };
}

// UTF-8 바이트 수(기록의 바이트 위치를 셈하는 데 쓴다)
export function utf8(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// 기록 끝 TAIL바이트를 줄 단위로 들고 있다가, 새로 붙은 부분만 받아 이어 붙인다.
//   buf: 지난번 { lines, offs, pos } (lines: 온전한 줄, offs: 각 줄의 시작 바이트, pos: 마지막 온전한 줄의 끝 = 다음에 읽을 곳).
//        null이면 chunk는 [st, z)인 끝부분이다(st > 0이면 첫 줄은 잘린 줄).
//   chunk: buf가 있으면 [buf.pos, z), 없으면 [st, z).
//   반환 text는 tail -c TAIL을 cut으로 읽은 것과 같은 줄들이다: 시작 바이트가 z - TAIL보다 뒤인 줄 + 끝의 쓰는 중인 줄.
//   쓰는 중인 줄(줄바꿈 전)은 text에만 넣고 들고 있지 않는다(다음에 pos부터 다시 읽는다).
//   바이트 위치를 확실히 모르면(깨진 글자) buf: null — 다음에는 끝부분을 통째로 다시 읽는다.
export function follow(buf, st, z, chunk, tail) {
  const k = chunk.lastIndexOf("\n");
  const done = k < 0 ? "" : chunk.slice(0, k), partial = chunk.slice(k + 1);
  let lines = [], offs = [], pos = null;
  if (buf) {
    lines = buf.lines.slice(); offs = buf.offs.slice(); pos = buf.pos;
    if (k >= 0) for (const l of done.split("\n")) { lines.push(l); offs.push(pos); pos += utf8(l) + 1; }
  } else if (k >= 0) {
    const got = done.split("\n");
    if (st > 0) got.shift();   // 잘린 첫 줄: z - TAIL 바이트가 든 줄이라 tail -c를 cut으로 읽어도 버려진다
    // 끝에서부터 바이트 위치를 셈한다(앞쪽 잘린 줄은 글자가 깨졌을 수 있다)
    if (!partial.includes("�")) {
      pos = z - utf8(partial);
      let at = pos;
      offs = new Array(got.length);
      for (let j = got.length - 1; j >= 0; j--) { at -= utf8(got[j]) + 1; offs[j] = at; }
    }
    lines = got;
  }
  // 끝 TAIL 밖으로 밀려난 줄을 버린다
  let drop = 0;
  if (pos !== null) while (drop < lines.length && offs[drop] <= z - tail) drop++;
  if (drop) { lines = lines.slice(drop); offs = offs.slice(drop); }
  const text = lines.length ? `${lines.join("\n")}\n${partial}` : partial;
  return { text, buf: pos === null ? null : { lines, offs, pos } };
}
