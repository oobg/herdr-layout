// 에이전트가 지금 무엇을 하는지: Claude Code 대화 기록(jsonl)의 끝부분에서 최근 도구 호출을 읽는다.
//   기록 위치: ~/.claude/projects/<에이전트 폴더 경로의 영문·숫자 외 글자를 '-'로>/<세션 id>.jsonl
//   세션 id는 터미널의 앞쪽 프로세스(claude) pid → ~/.claude/sessions/<pid>.json에서 찾는다.
//   같은 폴더에 에이전트가 여럿이어도 제 기록을 읽는다. 못 찾을 때만 그 폴더의 가장 최근 jsonl로 물러선다.
//   큰 기록(수십 MB)도 끝 2MB만 읽는다. 해석은 parse.js가 한다.
import { exec, hc } from "herdr";
import { parse } from "./parse.js";

const TAIL = 2000000;   // 이미지를 읽은 결과는 기록에 수백 KB로 들어가서, 턴 하나를 담으려면 넉넉히 읽는다

// 터미널의 앞쪽 프로세스 pid(hc get). 못 얻으면 null.
async function foregroundPid(address) {
  if (!address) return null;
  try {
    const r = await hc(["get", address, "--json"]);
    if (r.code !== 0) return null;
    return JSON.parse(r.stdout).foreground?.pid ?? null;
  } catch { return null; }
}

// cwd: 터미널 폴더. address: 터미널 주소(세션을 정확히 찾는 데 쓴다, 없으면 최근 파일로 짐작).
export async function readActivity(cwd, on, address) {
  const pid = await foregroundPid(address);
  // 세션 파일이 있으면 그 sessionId와 cwd를 쓰고, 없으면 터미널 폴더의 가장 최근 jsonl
  const script = [
    'pid=$1; cwd=$2; n=$3; s=""; f=""',
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
    'printf "%s\\n%s\\n%s\\n" "$f" "$cwd" "$(wc -c < "$f" | tr -d " ")"',
    'tail -c "$n" "$f"',
  ].join("\n");
  const r = await exec("sh", ["-c", script, "activity", pid ? String(pid) : "", cwd, String(TAIL)], { on });
  if (r.code !== 0) return null;
  const out = r.stdout;
  const a = out.indexOf("\n"), b = out.indexOf("\n", a + 1), c = out.indexOf("\n", b + 1);
  if (a < 0 || b < 0 || c < 0) return null;
  const file = out.slice(0, a), dir = out.slice(a + 1, b), bytes = Number(out.slice(b + 1, c));
  // 파일 전체를 읽었으면 첫 줄도 온전하다
  const v = parse(out.slice(c + 1), { cut: bytes > TAIL });
  return { file, cwd: dir || cwd, ...v, at: Date.now() };
}
