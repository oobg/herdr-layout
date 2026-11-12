// 에이전트 앱이 읽는 기록: office/mods/office/activity.js를 옮겨 와 고쳤다(다른 모드라 import로 나눠 쓸 수 없다).
//   원본은 "그 폴더의 가장 최근 jsonl"을 읽어서, 같은 폴더에 에이전트가 둘이면 엉뚱한 기록을 읽었다.
//   여기서는 터미널의 앞쪽 프로세스(claude) pid → ~/.claude/sessions/<pid>.json의 sessionId로 정확한 기록을 찾고,
//   못 찾을 때만 가장 최근 jsonl로 물러선다(guessed: 다른 에이전트의 기록일 수 있다). 해석은 parse.js가 한다.
//   크기가 지난번과 같으면 읽지 않고(바뀐 게 없으면 다시 그리지도 않는다), 커졌으면 새로 붙은 부분만 읽는다.
import { exec, hc } from "herdr";
import { parse, follow } from "./parse.js";

const TAIL = 2000000;   // 이미지를 읽은 결과는 기록에 수백 KB로 들어가서, 턴 하나를 담으려면 넉넉히 읽는다

// 원격 터미널 주소는 "machine/t7": 앞부분이 머신
export const machineOf = (address) => (String(address).includes("/") ? String(address).split("/")[0] : null);

// hc get: 앞쪽 프로세스 pid, 상태가 바뀐 시각, 안에서 도는 서브에이전트 기록(records)
export async function termInfo(address) {
  const r = await hc(["get", address, "--json"]);
  if (r.code !== 0) return null;
  const d = JSON.parse(r.stdout);
  return {
    pid: d.foreground?.pid ?? null,
    cwd: d.foreground?.cwd ?? d.cwd ?? null,
    statusAt: d.status_ms ?? null,
    records: d.records ?? {},
  };
}

// Claude 세션 기록 폴더와 세션 id. pid로 못 찾으면 터미널 폴더로 짐작한다(세션 id 없음).
// 셸을 못 돌렸으면(원격 머신 끊김 등) 던진다: 짐작으로 넘어가지 않고 부른 쪽이 읽기 실패로 센다.
export async function sessionOf(pid, cwd, on) {
  let session = null, dir = cwd;
  if (pid) {
    const r = await exec("sh", ["-c", 'cat "$HOME/.claude/sessions/$1.json" 2>/dev/null', "sessions", String(pid)], { on });
    try { const j = JSON.parse(r?.stdout || "null"); if (j?.sessionId) { session = j.sessionId; dir = j.cwd || cwd; } } catch { /* 짐작으로 */ }
  }
  if (!dir) return null;
  // Claude Code가 프로젝트 폴더 이름을 만드는 방식: 영문·숫자 밖의 글자를 '-'로
  return { project: `$HOME/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, "-")}`, session, cwd: dir, guessed: !session };
}

// 기록 파일을 찾아 끝을 읽는다. sub: 서브에이전트 agentId(그 세션의 subagents/agent-<id>.jsonl).
// prev: 지난번 결과. 같은 파일이고 크기가 같으면 { same: true }만 돌려준다.
//   지난번에 어디까지 읽었는지(buf.pos) 알면 그 뒤에 새로 붙은 부분만 dd로 읽어 이어 붙인다(parse.js follow가 줄 단위로 맞춘다).
//   처음이거나, 다른 파일이거나, 파일이 줄었거나, 새로 붙은 양이 TAIL보다 많으면 끝 TAIL만 읽는다.
//   tail -c 대신 dd(64KB 칸)로 읽고 앞뒤를 잘라 낸다: macOS tail -c는 바이트마다 읽어 느리다(office 모드와 같은 이유).
// guessed: 세션 기록을 못 찾아 그 폴더의 가장 최근 기록을 읽었다(같은 폴더의 다른 에이전트 것일 수 있다).
// 기록이 없으면 null, 셸이 실패했으면 던진다(부른 쪽이 지난 값을 두고 실패로 센다).
export async function readLog(sess, sub, prev, on) {
  const script = [
    'p=$(eval echo "$1"); s=$2; sub=$3; known=$4; n=$5; from=$6; kf=$7; f=""; g=0',
    'if [ -n "$sub" ]; then f="$p/$s/subagents/agent-$sub.jsonl"; [ -f "$f" ] || exit 3',
    'else [ -n "$s" ] && [ -f "$p/$s.jsonl" ] && f="$p/$s.jsonl"; [ -n "$f" ] || { f=$(ls -t "$p"/*.jsonl 2>/dev/null | head -1); g=1; }; fi',
    '[ -n "$f" ] || exit 3',
    'z=$(wc -c < "$f" | tr -d " ")',
    'printf "%s\\n%s %s\\n" "$f" "$z" "$g"',
    '[ "$z" = "$known" ] && [ "$f" = "$kf" ] && exit 0',
    // 이어 읽기(i): 같은 파일이고 지난번 위치가 지금 크기 안이며 새로 붙은 양이 n 이하일 때. 아니면 끝 n(w).
    'if [ -n "$from" ] && [ "$f" = "$kf" ] && [ "$from" -le "$z" ] && [ $((z - from)) -le "$n" ]; then m=i; st=$from',
    'else m=w; st=$(( z > n ? z - n : 0 )); fi',
    'printf "%s %s\\n" "$m" "$st"',
    // 서브에이전트 기록이 길면 첫 줄(맡은 일)을 따로 붙인다
    '[ -n "$sub" ] && [ "$z" -gt "$n" ] && head -n 1 "$f"',
    // [st, z)만: 64KB 칸으로 읽고 앞(칸 안의 자리)과 뒤(그새 붙은 부분)를 자른다
    'dd if="$f" bs=65536 skip=$((st / 65536)) 2>/dev/null | tail -c +$((st % 65536 + 1)) | head -c $((z - st))',
  ].join("\n");
  const r = await exec("sh", ["-c", script, "log", sess.project, sess.session ?? "", sub ?? "", String(prev?.size ?? ""), String(TAIL),
    String(prev?.buf?.pos ?? ""), prev?.file ?? ""], { on });
  if (r.code === 3) return null;
  if (r.code !== 0) throw new Error(`log ${r.code}`);
  const out = r.stdout;
  let i = 0;
  const line = () => { const j = out.indexOf("\n", i); const x = out.slice(i, j < 0 ? out.length : j); i = j < 0 ? out.length : j + 1; return x; };
  const file = line(), [z, g] = line().split(" "), bytes = Number(z), guessed = g === "1";
  if (bytes === prev?.size && file === prev?.file) return { file, size: bytes, same: true };
  const [mode, st] = line().split(" ");
  const head = sub && bytes > TAIL ? line() : null;
  const w = follow(mode === "i" ? prev?.buf : null, Number(st), bytes, out.slice(i), TAIL);
  // 서브에이전트: 첫 줄(맡은 일) + 끝부분
  const v = parse(head !== null ? `${head}\n${w.text}` : w.text, { cut: false, sidechain: Boolean(sub) });
  return { ...v, file, size: bytes, cwd: sess.cwd, guessed, buf: w.buf, at: Date.now() };
}
