// 에이전트가 지금 무엇을 하는지: Claude Code 대화 기록(jsonl)을 읽는다. 해석은 parse.js가 한다.
//   기록 위치: ~/.claude/projects/<에이전트 폴더 경로의 영문·숫자 외 글자를 '-'로>/<세션 id>.jsonl
//   세션 id는 터미널의 앞쪽 프로세스(claude) pid → ~/.claude/sessions/<pid>.json에서 찾는다.
//   못 찾을 때만 그 폴더의 가장 최근 jsonl로 물러선다.
//
// 한 번 갱신할 때 셸 하나로 세 가지를 읽는다.
//   1. 이번 턴: 기록 끝 2MB(크기가 지난번과 같으면 건너뛴다)
//   2. 서브에이전트: <세션 id>/subagents/agent-<id>.meta.json 목록. Claude Code가 띄울 때 만들고 끝나면 "finished":true를 쓴다.
//      띄운 줄이 기록 끝 2MB 밖으로 밀려나도, 지난 턴에 띄웠어도 빠지지 않는다(세션 단위 목록).
//      중단(killed)은 finished를 쓰지 않으므로 기록 전체의 완료 알림(task-id → status)으로 보충한다.
//      parentAgentId가 있으면 서브에이전트가 띄운 서브에이전트(2단)다.
//   3. 세션 전체의 파일 도구와 완료 알림: 기록에서 grep -o로 그 줄만 뽑는다. 처음엔 파일 전체(수십 MB도 수십 ms),
//      그다음부터는 지난번 크기 뒤로 새로 붙은 부분만(조금 겹치게) 읽어 메모리에 누적한다.
//   세션 동안 본 파일 중 지워진 것은 30초에 한 번 존재를 확인해 뺀다(이 기기·그 머신에서 [ -e ]).
//   4. 세션이 게시한 아티팩트: 3과 같은 범위(처음엔 전체, 그다음은 새로 붙은 부분)에서 Artifact 호출 줄과 결과 줄만 grep -E로 고른다.
//      제목에 쓸 .html의 <title>은 URL당 한 번만 읽는다(그 머신에서 head -c 8192).
// 서브에이전트의 활동은 readSub가 그 서브에이전트 기록(sidechain)을 같은 방식으로 읽는다.
import { exec, hc } from "herdr";
import { parse, scanLines, scanArtifacts, titleOfHtml, SCAN, ARTIFACT } from "./parse.js";

const TAIL = 2000000;    // 이미지를 읽은 결과는 기록에 수백 KB로 들어가서, 턴 하나를 담으려면 넉넉히 읽는다
const OVERLAP = 4096;    // 새로 붙은 부분을 읽을 때 앞으로 겹치는 양(쓰는 중이던 줄이 잘려 놓치지 않게).
//   읽기는 dd로 64KB 칸 단위라 실제로는 그보다 더 겹친다(macOS tail -c는 바이트마다 읽어 수십 MB에 1초가 넘게 걸린다).
const STAT_EVERY = 30000;
const TITLES = new Map();   // "머신|URL" → .html의 <title>(없으면 null). 세션 상태가 새로 시작돼도 다시 읽지 않는다

// 원격 터미널 주소는 "machine/t7": 앞부분이 머신
export const machineOf = (address) => (String(address ?? "").includes("/") ? String(address).split("/")[0] : null);

// hc get: 앞쪽 프로세스 pid, 안에서 도는 서브에이전트 기록(records). 못 얻으면 빈 값.
async function termInfo(address) {
  if (!address) return {};
  try {
    const r = await hc(["get", address, "--json"]);
    if (r.code !== 0) return {};
    const d = JSON.parse(r.stdout);
    return { pid: d.foreground?.pid ?? null, records: d.records ?? {} };
  } catch { return {}; }
}

// 셸 출력 "M\t…", "G\t…", "A "+아티팩트 줄, 그 밖의 grep 줄, "=" 줄 뒤는 기록 끝부분
function split(out) {
  const i = out.indexOf("\n=\n");
  const head = (i < 0 ? out : out.slice(0, i)).split("\n");
  return { head, tail: i < 0 ? "" : out.slice(i + 3) };
}

// 누적 상태(files·ended·크기)를 이어받아 셸 결과를 반영한다. prev: 지난번 상태(파일이 바뀌었으면 버린다).
function absorb(prev, file, size, lines) {
  const same = prev && prev.file === file && prev.size <= size;
  const st = { file, size, files: same ? prev.files : new Map(), ended: same ? prev.ended : {},
    statAt: same ? prev.statAt : 0, tail: same ? prev.tail : null,
    arts: same && prev.arts ? prev.arts : { uses: {}, seen: new Set(), list: new Map() } };
  const gone = [], hits = [], arts = [];
  for (const l of lines) {
    if (l.startsWith("G\t")) gone.push(l.slice(2));
    else if (l.startsWith("A ")) arts.push(l.slice(2));
    else if (l.startsWith('"name"') || l.startsWith("<task-id>")) hits.push(l);
  }
  scanLines(hits, st.files, st.ended);
  scanArtifacts(arts, st.arts);
  for (const p of gone) st.files.delete(p);
  return st;
}

// 존재 확인할 경로(30초에 한 번만)
function toStat(prev, file) {
  if (!prev || prev.file !== file || Date.now() - (prev.statAt ?? 0) < STAT_EVERY) return [];
  return [...prev.files.keys()];
}

// 서브에이전트 목록: meta.json + 완료 알림 + hc records
function agentsOf(metas, st, records, tail) {
  const list = metas.map((m) => {
    const e = st.ended[m.id], d = tail?.ended?.[m.id];
    // 앞에서 띄운(foreground) 서브에이전트는 완료 알림이 없다: 끝부분에 그 호출의 결과가 왔으면 끝난 것(중간에 멈춘 경우 포함)
    const call = tail?.agents?.find((x) => x.toolUse === m.meta.toolUseId || x.id === m.id);
    const status = e ?? d?.status ?? (m.meta.finished ? "completed" : null) ?? (call && !call.running ? call.status ?? "completed" : null);
    return { id: m.id, parent: m.meta.parentAgentId ?? null, type: m.meta.agentType || "general-purpose", what: m.meta.description ?? "",
      size: m.size, start: m.start, running: !status, failed: Boolean(status && status !== "completed"),
      tools: d?.tools, ms: d?.ms };
  });
  // meta.json이 아직 없는(혹은 옛 Claude Code) 서브에이전트: records로 보충한다. records는 끝난 뒤에도 working으로 남기도 해서
  //   목록에 이미 있는 것은 meta.json·완료 알림을 믿는다.
  for (const [id, r] of Object.entries(records ?? {})) {
    if (list.some((x) => x.id === id)) continue;
    list.push({ id, parent: null, type: "general-purpose", what: r?.title ?? "", size: null, start: Date.now(),
      running: r?.state === "working" && !st.ended[id], failed: false });
  }
  // 둘 다 없으면(아주 옛 기록 형식) 끝부분에서 본 서브에이전트 호출
  if (!list.length && tail?.agents?.length)
    for (const g of tail.agents) list.push({ ...g, parent: null, size: null, running: g.running && !st.ended[g.id], failed: Boolean(g.status && g.status !== "completed") });
  return list.sort((a, b) => (a.start || 0) - (b.start || 0));
}

// 아티팩트 제목에 쓸 .html <title>: title이 없는 URL만, URL당 한 번(앞 8KB). 그 머신에서 읽는다(경로는 에이전트가 쓴 곳).
async function pageTitles(arts, on) {
  for (const e of arts.list.values()) {
    if (e.title || !e.page || "htmlTitle" in e) continue;
    const k = `${on ?? ""}|${e.url}`;
    if (!TITLES.has(k)) {
      let title = null;
      try { const r = await exec("head", ["-c", "8192", e.page], { on }); if (r.code === 0) title = titleOfHtml(r.stdout); } catch { /* 못 읽으면 다른 재료로 */ }
      TITLES.set(k, title);
    }
    e.htmlTitle = TITLES.get(k);
  }
}

// cwd: 터미널 폴더. address: 터미널 주소. prev: 지난번 결과(누적 상태를 이어받는다).
// 반환: { file, cwd, size, files: Map, ended, tail: parse 결과, agents, project, session, at }
export async function readActivity(cwd, address, prev) {
  const on = machineOf(address);
  const { pid, records } = await termInfo(address);
  const script = [
    'pid=$1; cwd=$2; n=$3; kf=$4; from=$5; ksz=$6; scan=$7; known=$8; art=$9; shift 9; s=""; f=""',
    'if [ -n "$pid" ] && [ -f "$HOME/.claude/sessions/$pid.json" ]; then',
    // sessions/<pid>.json은 한 줄 JSON이다: sessionId와 cwd만 뽑는다
    '  j=$(cat "$HOME/.claude/sessions/$pid.json")',
    '  s=$(printf "%s" "$j" | sed -n \'s/.*"sessionId":"\\([^"]*\\)".*/\\1/p\')',
    '  c=$(printf "%s" "$j" | sed -n \'s/.*"cwd":"\\([^"]*\\)".*/\\1/p\')',
    '  [ -n "$c" ] && cwd=$c',
    'fi',
    'p="$HOME/.claude/projects/$(printf "%s" "$cwd" | sed "s/[^A-Za-z0-9]/-/g")"',
    '[ -n "$s" ] && [ -f "$p/$s.jsonl" ] && f="$p/$s.jsonl"',
    '[ -n "$f" ] || f=$(ls -t "$p"/*.jsonl 2>/dev/null | head -1)',
    '[ -n "$f" ] || exit 3',
    'z=$(wc -c < "$f" | tr -d " ")',
    // 다른 세션이거나 기록이 줄었으면(새로 쓰였으면) 처음부터
    '[ "$f" = "$kf" ] && [ "$from" -le "$z" ] 2>/dev/null || { from=0; ksz=""; }',
    'printf "%s\\n%s\\n%s\\n%s\\n" "$f" "$cwd" "$z" "$from"',
    // 서브에이전트 목록: id, 기록 크기, 시작 시각(기록 첫 줄의 timestamp), meta.json
    'd="${f%.jsonl}/subagents"',
    'for m in "$d"/agent-*.meta.json; do',
    '  [ -f "$m" ] || continue',
    '  id=${m##*/agent-}; id=${id%.meta.json}; l="$d/agent-$id.jsonl"',
    '  zz=$(wc -c < "$l" 2>/dev/null | tr -d " "); ts=""',
    // 시작 시각은 바뀌지 않으니 지난번에 읽은 것은 건너뛴다
    '  case " $known " in *" $id "*) ;; *) ts=$(head -n 1 "$l" 2>/dev/null | grep -o \'"timestamp":"[^"]*"\' | tail -1) ;; esac',
    '  printf "M\\t%s\\t%s\\t%s\\t%s\\n" "$id" "$zz" "${ts#*:}" "$(tr -d "\\n" < "$m")"',
    'done',
    // 세션 동안 본 파일 중 지워진 것
    'for x in "$@"; do [ -e "$x" ] || printf "G\\t%s\\n" "$x"; done',
    // 새로 붙은 부분의 파일 도구·완료 알림. api-request 줄은 지난 메시지를 다시 담고 있어 뺀다.
    'dd if="$f" bs=65536 skip=$((from / 65536)) 2>/dev/null | LC_ALL=C grep -v \'^{"type":"api-request\' | LC_ALL=C grep -o -E "$scan"',
    // 같은 범위의 아티팩트 호출·결과 줄(줄 전체, 앞에 "A ")
    'dd if="$f" bs=65536 skip=$((from / 65536)) 2>/dev/null | LC_ALL=C grep -v \'^{"type":"api-request\' | LC_ALL=C grep -E "$art" | sed \'s/^/A /\'',
    'printf "=\\n"',
    '[ "$z" = "$ksz" ] || dd if="$f" bs=65536 skip=$(( z > n ? (z - n) / 65536 : 0 )) 2>/dev/null',
  ].join("\n");
  const kf = prev?.file ?? "", from = prev?.file ? Math.max(0, prev.size - OVERLAP) : 0;
  const stat = toStat(prev, prev?.file);
  const r = await exec("sh", ["-c", script, "activity", pid ? String(pid) : "", cwd, String(TAIL), kf, String(from),
    from ? String(prev?.size ?? "") : "", SCAN, (prev?.agents ?? []).filter((g) => g.start).map((g) => g.id).join(" "), ARTIFACT, ...stat], { on });
  if (r.code !== 0) return null;
  const { head, tail } = split(r.stdout);
  const [file, dir, sz, fromUsed] = head;
  const size = Number(sz);
  const st = absorb(Number(fromUsed) === 0 ? null : prev, file, size, head.slice(4));
  if (stat.length) st.statAt = Date.now();
  await pageTitles(st.arts, on);
  if (String(size) !== String(prev?.size) || prev?.file !== file || !st.tail)
    st.tail = parse(tail, { cut: size > TAIL });
  const metas = [];
  for (const l of head) {
    if (!l.startsWith("M\t")) continue;
    const [, id, z, ts, json] = l.split("\t");
    let meta = {};
    try { meta = JSON.parse(json); } catch { /* 쓰는 중: 다음 갱신에 */ }
    const start = Date.parse(ts.replace(/"/g, "")) || prev?.agents?.find((g) => g.id === id)?.start || 0;
    metas.push({ id, size: Number(z) || 0, start, meta });
  }
  return { ...st, cwd: dir || cwd, agents: agentsOf(metas, st, records, st.tail), at: Date.now() };
}

// 서브에이전트 하나의 기록(<세션>/subagents/agent-<id>.jsonl)을 읽는다. main: readActivity 결과. prev: 지난번 결과.
// 기록이 2MB보다 길면 첫 줄(맡은 일 = 그 서브에이전트의 턴 시작)을 따로 붙인다.
export async function readSub(main, id, address, prev) {
  const file = `${main.file.slice(0, -".jsonl".length)}/subagents/agent-${id}.jsonl`;
  const script = [
    'f=$1; n=$2; from=$3; ksz=$4; scan=$5; shift 5',
    '[ -f "$f" ] || exit 3',
    'z=$(wc -c < "$f" | tr -d " ")',
    '[ "$from" -le "$z" ] 2>/dev/null || { from=0; ksz=""; }',
    'printf "%s\\n%s\\n" "$z" "$from"',
    'for x in "$@"; do [ -e "$x" ] || printf "G\\t%s\\n" "$x"; done',
    'dd if="$f" bs=65536 skip=$((from / 65536)) 2>/dev/null | LC_ALL=C grep -o -E "$scan"',
    'printf "=\\n"',
    'if [ "$z" != "$ksz" ]; then [ "$z" -gt "$n" ] && head -n 1 "$f"; dd if="$f" bs=65536 skip=$(( z > n ? (z - n) / 65536 : 0 )) 2>/dev/null; fi',
  ].join("\n");
  const from = prev?.file === file ? Math.max(0, prev.size - OVERLAP) : 0;
  const stat = toStat(prev, file);
  const r = await exec("sh", ["-c", script, "activity-sub", file, String(TAIL), String(from), from ? String(prev?.size ?? "") : "", SCAN, ...stat],
    { on: machineOf(address) });
  if (r.code !== 0) return null;
  const { head, tail } = split(r.stdout);
  const size = Number(head[0]);
  const st = absorb(Number(head[1]) === 0 ? null : prev, file, size, head.slice(2));
  if (stat.length) st.statAt = Date.now();
  if (String(size) !== String(prev?.size) || !st.tail) {
    let text = tail, cut = size > TAIL;
    if (cut) {
      // 첫 줄 + (잘린 줄을 버린) 끝부분
      const first = text.slice(0, text.indexOf("\n")), rest = text.slice(first.length + 1);
      text = `${first}\n${rest.slice(rest.indexOf("\n") + 1)}`;
      cut = false;
    }
    st.tail = parse(text, { cut, sidechain: true });
  }
  return { ...st, at: Date.now() };
}
