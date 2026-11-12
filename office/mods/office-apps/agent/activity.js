// 에이전트 앱이 읽는 기록: office/mods/office/activity.js를 옮겨 와 고쳤다(다른 모드라 import로 나눠 쓸 수 없다).
//   원본은 "그 폴더의 가장 최근 jsonl"을 읽어서, 같은 폴더에 에이전트가 둘이면 엉뚱한 기록을 읽었다.
//   여기서는 터미널의 앞쪽 프로세스(claude) pid → ~/.claude/sessions/<pid>.json의 sessionId로 정확한 기록을 찾고,
//   못 찾을 때만 가장 최근 jsonl로 물러선다(guessed: 다른 에이전트의 기록일 수 있다). 해석은 parse.js가 한다.
//   크기가 지난번과 같으면 tail을 건너뛴다(바뀐 게 없으면 다시 읽지도 그리지도 않는다).
import { exec, hc } from "herdr";
import { parse } from "./parse.js";

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
export async function sessionOf(pid, cwd, on) {
  let session = null, dir = cwd;
  if (pid) {
    const r = await exec("sh", ["-c", 'cat "$HOME/.claude/sessions/$1.json" 2>/dev/null', "sessions", String(pid)], { on }).catch(() => null);
    try { const j = JSON.parse(r?.stdout || "null"); if (j?.sessionId) { session = j.sessionId; dir = j.cwd || cwd; } } catch { /* 짐작으로 */ }
  }
  if (!dir) return null;
  // Claude Code가 프로젝트 폴더 이름을 만드는 방식: 영문·숫자 밖의 글자를 '-'로
  return { project: `$HOME/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, "-")}`, session, cwd: dir, guessed: !session };
}

// 기록 파일을 찾아 끝을 읽는다. sub: 서브에이전트 agentId(그 세션의 subagents/agent-<id>.jsonl).
// size: 지난번 크기. 같으면 { same: true }만 돌려준다.
// guessed: 세션 기록을 못 찾아 그 폴더의 가장 최근 기록을 읽었다(같은 폴더의 다른 에이전트 것일 수 있다).
export async function readLog(sess, sub, size, on) {
  const script = [
    'p=$(eval echo "$1"); s=$2; sub=$3; known=$4; n=$5; f=""; g=0',
    'if [ -n "$sub" ]; then f="$p/$s/subagents/agent-$sub.jsonl"; [ -f "$f" ] || exit 3',
    'else [ -n "$s" ] && [ -f "$p/$s.jsonl" ] && f="$p/$s.jsonl"; [ -n "$f" ] || { f=$(ls -t "$p"/*.jsonl 2>/dev/null | head -1); g=1; }; fi',
    '[ -n "$f" ] || exit 3',
    'z=$(wc -c < "$f" | tr -d " ")',
    'printf "%s\\n%s %s\\n" "$f" "$z" "$g"',
    '[ "$z" = "$known" ] && exit 0',
    // 서브에이전트 기록이 길면 첫 줄(맡은 일)을 따로 붙인다
    '[ -n "$sub" ] && [ "$z" -gt "$n" ] && head -n 1 "$f"',
    'tail -c "$n" "$f"',
  ].join("\n");
  const r = await exec("sh", ["-c", script, "log", sess.project, sess.session ?? "", sub ?? "", String(size ?? ""), String(TAIL)], { on });
  if (r.code !== 0) return null;
  const a = r.stdout.indexOf("\n"), b = r.stdout.indexOf("\n", a + 1);
  const file = r.stdout.slice(0, a), [z, g] = r.stdout.slice(a + 1, b).split(" "), bytes = Number(z), guessed = g === "1";
  if (String(bytes) === String(size)) return { file, size: bytes, same: true };
  let text = r.stdout.slice(b + 1), cut = bytes > TAIL;
  if (sub && cut) {
    // 첫 줄 + (잘린 줄을 버린) 끝부분
    const head = text.slice(0, text.indexOf("\n")), rest = text.slice(head.length + 1);
    text = `${head}\n${rest.slice(rest.indexOf("\n") + 1)}`;
    cut = false;
  }
  const v = parse(text, { cut, sidechain: Boolean(sub) });
  return { ...v, file, size: bytes, cwd: sess.cwd, guessed, at: Date.now() };
}
