// Claude Code 대화 기록(jsonl)을 해석한다. herdr를 부르지 않아 node로도 시험할 수 있다.
// office-apps/agent/parse.js(에이전트 앱)에서 고친 내용을 옮겨 왔다(다른 모드라 import로 나눠 쓸 수 없다).
//   - api-request-blob 같은 줄은 지난 메시지를 다시 담고 있어서 대화 줄(user·assistant)만 본다
//   - 같은 tool_use id가 두 번 적혀 있으면 한 번만 센다
//   - 일하는 중에 보낸 메시지(queued_command)도 새 턴으로 본다
//   - 서브에이전트 기록(subagents/agent-<id>.jsonl)은 모든 줄이 isSidechain이라 sidechain 옵션으로 읽는다
// 두 가지를 낸다.
//   parse(text)      기록 끝부분 → 이번 턴의 도구 흐름, 마지막 말, 완료 알림(task-id → 상태·도구 수·걸린 시간)
//   scanLines(lines) 셸의 grep 결과 → 세션 전체의 파일 도구와 완료 알림(끝부분만으로는 세션 앞쪽을 모른다)
//   scanArtifacts(lines) 셸이 ARTIFACT로 고른 줄 → 세션이 게시한 Claude 아티팩트(URL별 하나)

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

const clip = (s, n) => { const x = String(s).replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n).trimEnd()}…` : x; };
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

// 아티팩트: Artifact 도구 호출 줄과 그 결과 줄만 셸이 고른다(grep -E, 줄 전체). 줄은 JSON이라 글 속 따옴표는 \"로 적혀
//   대화 글이나 다른 도구 입력에 같은 글자가 있어도 이 모양으로는 걸리지 않는다.
//   결과 글: "Published <파일> at <URL> (Version n …)", "Created a new Artifact at <URL> …", "Updated the Artifact at <URL> …"
export const ARTIFACT = '"type":"tool_use","id":"[^"]+","name":"Artifact","input"'
  + '|"type":"tool_result","content":("|\\[\\{"type":"text","text":")(Published |Created a new Artifact at |Updated the Artifact at )';
const ART_URL = /^(?:Published |Created a new Artifact at |Updated the Artifact at )[^\n]*?(https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+)/;

// 셸이 고른 줄을 세션 누적 상태에 더한다. arts: { uses: { tool_use id → 입력 일부 }, seen: Set(결과 id), list: Map(URL → 항목) }
//   항목: { url, at(마지막 게시 시각), title, page(.html 파일), file, desc }. 같은 URL을 다시 게시하면 뒤로 간다(최근 것이 마지막).
//   제목 재료는 그 URL의 모든 호출에서 모은다(만들 때만 title이 있고, 고칠 때는 데이터 파일만 보내기도 한다).
//   호출 줄과 결과 줄이 서로 다른 증분에 올 수 있어 uses를 남겨 둔다. 겹쳐 읽은 결과는 seen으로 한 번만.
export function scanArtifacts(lines, arts) {
  for (const l of lines) {
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    if (d.isSidechain || (d.type !== "user" && d.type !== "assistant")) continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const it of content) {
      if (it.type === "tool_use" && it.name === "Artifact") {
        const x = it.input ?? {};
        arts.uses[it.id] = { title: x.title, file: x.file_path, desc: x.description };
      } else if (it.type === "tool_result" && arts.uses[it.tool_use_id] && !arts.seen.has(it.tool_use_id)) {
        const url = ART_URL.exec(textOf(it.content).trimStart())?.[1];
        if (!url) continue;
        arts.seen.add(it.tool_use_id);
        const u = arts.uses[it.tool_use_id], e = arts.list.get(url) ?? { url };
        arts.list.delete(url);
        const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
        e.at = Date.parse(d.timestamp) || e.at || 0;
        e.title = str(u.title) ?? e.title ?? null;
        e.desc = str(u.desc) ?? e.desc ?? null;
        if (str(u.file)) { e.file = u.file; if (/\.html?$/i.test(u.file)) e.page = u.file; }
        arts.list.set(url, e);
      }
    }
  }
}

// 보일 제목: title → .html 파일의 <title>(htmlTitle, activity.js가 URL당 한 번 읽는다) → description 첫 부분 → 파일 이름
export function artifactTitle(e) {
  const first = e.desc ? clip(e.desc.split(/(?<=[.!?。])\s|\n/)[0], 80) : null;
  const name = (e.page ?? e.file ?? "").split("/").pop();
  return e.title || e.htmlTitle || first || name || e.url.split("/").pop();
}

// <title> 글: 앞 8KB에서 찾는다. 흔한 엔티티만 푼다.
export function titleOfHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""));
  if (!m) return null;
  const t = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  return t || null;
}

// text: 기록 끝부분. cut: 앞이 잘렸는지(잘렸으면 첫 줄은 깨진 줄). sidechain: 서브에이전트 기록인지.
// 반환: { flow, tools, running, ended, agents, say, sayAt, lastAt }
//   flow    이번 턴의 도구를 연속된 같은 종류끼리 묶은 것(길면 마지막 24묶음).
//           at: 묶음의 첫 호출 시각, end: 묶음 안 호출의 결과가 온 마지막 시각(아직 없으면 at)
//   say     이번 턴에 에이전트가 마지막으로 한 말(한 줄로 편 것), sayAt 그 시각. lastAt: 기록의 마지막 시각
//   tools   이번 턴 도구 호출 수
//   ended   완료 알림에서 읽은 task-id → { status, tools, ms }
//   agents  끝부분에서 본 서브에이전트 호출(세션의 subagents 목록이 없을 때만 쓴다: 옛 기록 형식)
export function parse(text, { cut = true, sidechain = false } = {}) {
  const lines = text.split("\n");
  if (cut) lines.shift();
  let calls = [], askAt = 0, say = "", sayAt = 0, lastAt = 0;
  const agentCalls = [];
  const done = new Set(), doneAt = {}, finished = {}, ended = {}, names = {}, agentIds = {};
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
      if (!d.isMeta && t && !t.startsWith("<") && !t.startsWith("[Request interrupted")) { calls = []; askAt = at; say = ""; sayAt = 0; }
      continue;
    }
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
        if (/^(Agent|Task)$/.test(names[it.tool_use_id] ?? "")) {
          const body = textOf(it.content);
          const aid = /agentId: ([A-Za-z0-9]+)/.exec(body)?.[1];
          if (aid) agentIds[it.tool_use_id] = aid;
          // 백그라운드로 띄운 서브에이전트는 "시작했다"는 결과가 바로 온다: 끝난 게 아니다
          if (/Async agent launched/.test(body)) continue;
        }
        done.add(it.tool_use_id);
        doneAt[it.tool_use_id] = at;
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
    const end = Math.max(x.at, doneAt[x.id] ?? 0);
    if (last && last.kind === x.kind) { last.n++; last.running ||= x.running; last.target = x.target; last.end = Math.max(last.end, end); }
    else flow.push({ kind: x.kind, n: 1, running: x.running, target: x.target, at: x.at, end });
  }
  flow.splice(0, Math.max(0, flow.length - 24));
  return { flow, tools: steps.length, askAt, running, ended, agents, say, sayAt, lastAt };
}

// ── 요약 줄과 시간 띠(오버뷰 에이전트 줄). 에이전트 앱(office-apps/agent/timeline.js)과 같은 규칙 ──
//   종류 → 단계: 읽음·검색·찾기·웹·스킬 → 살펴보기, 수정·작성 → 고치기, 실행 → 실행, 서브에이전트 → 맡기기, 그 밖 → 기타.
//   같은 단계가 이어지면 하나. 지금 단계 = 마지막 단계.
export const REST_MS = 180000;   // 다음 항목까지 이만큼 비면 사이에 쉼 칸
const PHASE = { 읽음: "살펴보기", 검색: "살펴보기", 찾기: "살펴보기", 웹: "살펴보기", 스킬: "살펴보기",
  수정: "고치기", 작성: "고치기", 실행: "실행", 서브에이전트: "맡기기" };
export const phaseOf = (kind) => PHASE[kind] ?? "기타";

// 단계 이름 목록(같은 단계가 이어지면 하나)
export function phases(flow) {
  const out = [];
  for (const f of flow) { const p = phaseOf(f.kind); if (out[out.length - 1] !== p) out.push(p); }
  return out;
}

// 시간 띠의 칸: 흐름 항목마다 한 칸, ms = 걸린 시간(화면은 이 비율로 너비를 나눈다).
//   끝 = 다음 항목의 at. 마지막 항목은 작업 중이면 now, 아니면 lastAt.
//   다음 항목까지 비는 시간(이 항목의 마지막 결과 end → 다음 at)이 3분 이상이면 끝을 end로 당기고 그 뒤에 쉼 칸.
//     (at끼리만 재면 5분 걸린 실행 하나도 쉼이 된다)
//   current: 작업 중일 때 마지막 칸(지금 도는 칸).
export function band(flow, { working = false, now = Date.now(), lastAt = 0 } = {}) {
  const cells = [];
  flow.forEach((f, i) => {
    const next = flow[i + 1], end = Math.max(f.at ?? 0, f.end ?? 0);
    let stop = next ? next.at : working ? now : Math.max(lastAt, end);
    const rest = next && next.at - end >= REST_MS ? next.at - end : 0;
    if (rest) stop = end;
    cells.push({ kind: f.kind, ms: Math.max(0, stop - (f.at ?? 0)), current: working && i === flow.length - 1 });
    if (rest) cells.push({ rest: true, ms: rest });
  });
  return cells;
}

// 요약: { now: 지금 도는 도구 설명(작업 중일 때만, 없으면 null), phase: 지금 단계, cells: 띠 칸 }
//   지금 도구 = 이번 턴에서 아직 도는 마지막 묶음, 없으면(결과를 받고 생각하는 중) 마지막 묶음.
//   실행이면 Bash description, 아니면 "<종류> <대상 짧게>"(파일은 파일 이름만).
export function summary(flow, { working = false, now = Date.now(), lastAt = 0 } = {}) {
  const cur = working ? [...flow].reverse().find((f) => f.running) ?? flow[flow.length - 1] : null;
  const short = (k, t) => (["읽음", "수정", "작성"].includes(k) && t ? String(t).split("/").pop() : t);
  const text = !cur ? null : cur.kind === "실행" ? cur.target || "실행" : [cur.kind, short(cur.kind, cur.target)].filter(Boolean).join(" ");
  const ph = phases(flow);
  return { now: working ? text ?? "생각 중" : null, phase: ph[ph.length - 1] ?? null, cells: band(flow, { working, now, lastAt }) };
}

// 파일 경로 → [위치 칩, 짧은 경로]. h: 홈 폴더, cwd: 에이전트가 일하는 폴더. 잘라 낼 앞부분은 문자열 길이로 센다.
export function placeOf(p, h, cwd) {
  if (cwd && p.startsWith(cwd + "/")) return ["프로젝트", p.slice(cwd.length + 1)];
  const tmp = /^\/(private\/)?tmp\/claude-[^/]+\/[^/]+\/[^/]+\/(scratchpad\/)?(.*)$/.exec(p);
  if (tmp) return ["클로드 임시", tmp[3]];
  for (const [chip, dir] of [["클로드", "/.claude/"], ["Herdr", "/.config/herdr-app/"]])
    if (p.startsWith(h + dir)) return [chip, p.slice((h + dir).length)];
  if (p.startsWith(h + "/")) return ["홈", `~/${p.slice(h.length + 1)}`];
  return [null, p];
}
