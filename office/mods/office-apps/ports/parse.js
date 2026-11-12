// 포트 앱의 순수 함수: 기기에서 돌린 스크립트 출력(@@구역) → 리스닝 포트 목록, 리스닝 pid → 띄운 터미널.
// herdr를 import하지 않아 node로 실제 lsof·ps 출력에 돌려 볼 수 있다(ports.js가 exec 결과를 넘긴다).
//   macOS: lsof -nP -iTCP -sTCP:LISTEN -F pcnt   (sudo 없이는 내 프로세스만 보인다)
//   Linux: ss -ltnpH, 없으면 /proc/net/tcp(6) + /proc/*/fd 의 socket:[inode]
//   공통: ps -ww -A -o pid=,ppid=,user=,command=  (조상 체인·명령줄·소유자, -ww로 명령줄을 자르지 않는다)

// 기기에서 한 번 돌리는 스크립트. lsof는 찾은 게 없으면 1로 끝나므로 종료 코드가 아니라 구역 내용으로 판단한다.
export const SCRIPT = `echo @@os; uname -s
if [ "$(uname -s)" = Darwin ]; then
  echo @@lsof; lsof -nP -iTCP -sTCP:LISTEN -F pcnt 2>/dev/null
elif command -v ss >/dev/null 2>&1; then
  echo @@ss; ss -ltnpH 2>/dev/null || ss -ltnp 2>/dev/null | tail -n +2
else
  echo @@tcp; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null
  echo @@fd; ls -l /proc/[0-9]*/fd 2>/dev/null | grep -E '^/proc/|socket:'
fi
echo @@ps; ps -ww -A -o pid=,ppid=,user=,command=`;

// "@@이름" 줄로 나눈 구역 → { 이름: 본문 }
export function sections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text ?? "").split("\n")) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = ""; } else if (cur) out[cur] += line + "\n";
  }
  return out;
}

// "주소:포트" → { addr, port }. [::1]:3000, *:3000, 127.0.0.53%lo:53, [::ffff:127.0.0.1]:80 모두.
export function splitHostPort(s, family) {
  const str = String(s ?? "").trim();
  const cut = str.lastIndexOf(":");
  if (cut < 0) return null;
  const port = Number(str.slice(cut + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  let addr = str.slice(0, cut).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (addr.startsWith("::ffff:") && addr.includes(".")) addr = addr.slice(7);
  if (addr === "*") addr = family === "IPv6" ? "::" : "0.0.0.0";
  return { addr, port };
}

// lsof -F pcnt → [{ pid, name, addr, port }]. p로 프로세스가, f로 파일이 바뀌고, t(IPv4/IPv6)가 n 앞에 온다.
export function parseLsof(text) {
  const out = [];
  let pid = null, name = "", family = null;
  for (const line of String(text ?? "").split("\n")) {
    const k = line[0], v = line.slice(1);
    if (k === "p") { pid = Number(v); name = ""; family = null; }
    else if (k === "c") name = v;
    else if (k === "f") family = null;
    else if (k === "t") family = v;
    else if (k === "n") {
      const hp = splitHostPort(v.replace(/\s*\(LISTEN\)$/, ""), family);
      if (hp && Number.isFinite(pid)) out.push({ pid, name, ...hp });
    }
  }
  return out;
}

// ss -ltnp(H) → [{ pid|null, name, addr, port }]. 다른 사용자 소켓은 users:(…)가 없어 pid가 null이다.
export function parseSs(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== "LISTEN") continue;
    const local = f[3];
    const hp = splitHostPort(local, "IPv4");   // ss의 *는 두 계열 모두라 0.0.0.0으로 본다
    if (!hp) continue;
    // users:(("nginx",pid=10,fd=6),("nginx",pid=11,fd=6)) → 첫 프로세스(나머지는 같은 소켓을 나눠 쓴다)
    const users = /users:\(\("([^"]*)",pid=(\d+)/.exec(line);
    out.push({ pid: users ? Number(users[2]) : null, name: users ? users[1] : "", ...hp });
  }
  return out;
}

// /proc/net/tcp(6)의 주소 hex → 글자. IPv4는 리틀 엔디언 32비트, IPv6는 32비트 단어 넷이 각각 리틀 엔디언.
export function procAddr(hex) {
  const h = String(hex ?? "");
  const word = (w) => w.match(/../g).reverse().map((b) => parseInt(b, 16));
  if (h.length === 8) return word(h).join(".");
  if (h.length !== 32) return h;
  const bytes = [0, 8, 16, 24].flatMap((i) => word(h.slice(i, i + 8)));
  if (bytes.every((b) => b === 0)) return "::";
  // ::ffff:a.b.c.d
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12).join(".");
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // 가장 긴 0 묶음 하나를 ::로 줄인다
  let best = -1, len = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== "0") { i++; continue; }
    let j = i; while (j < 8 && groups[j] === "0") j++;
    if (j - i > len && j - i > 1) { best = i; len = j - i; }
    i = j;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + len).join(":")}`;
}

// /proc/net/tcp + `ls -l /proc/*/fd`(socket:[inode]) → [{ pid|null, name: "", addr, port }]
export function parseProcTcp(tcp, fd) {
  const owner = new Map();   // inode → pid
  let cur = null;
  for (const line of String(fd ?? "").split("\n")) {
    const head = /^\/proc\/(\d+)\/fd:/.exec(line);
    if (head) { cur = Number(head[1]); continue; }
    const s = /socket:\[(\d+)\]/.exec(line);
    if (s && cur != null && !owner.has(s[1])) owner.set(s[1], cur);
  }
  const out = [];
  for (const line of String(tcp ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;          // 0A = LISTEN
    const [a, p] = f[1].split(":");
    const port = parseInt(p, 16);
    if (!port) continue;
    out.push({ pid: owner.get(f[9]) ?? null, name: "", addr: procAddr(a), port });
  }
  return out;
}

// ps -A -o pid=,ppid=,user=,command= → Map(pid → { ppid, user, command })
export function parsePs(text) {
  const procs = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.set(Number(m[1]), { ppid: Number(m[2]), user: m[3], command: m[4].trim() });
  }
  return procs;
}

// pid의 조상(자기 포함)을 아래에서 위로. 순환·깊이를 막는다.
export function ancestors(pid, procs, max = 64) {
  const out = [], seen = new Set();
  let p = pid;
  while (p != null && p > 0 && !seen.has(p) && out.length < max) {
    seen.add(p); out.push(p);
    p = procs.get(p)?.ppid ?? null;
  }
  return out;
}

// 리스닝 pid → 가장 가까운 터미널 셸. roots: Map(셸 pid → 터미널 주소). 같은 기기의 roots만 넘긴다.
export function findRoot(pid, procs, roots) {
  if (pid == null) return null;
  for (const p of ancestors(pid, procs)) if (roots.has(p)) return roots.get(p);
  return null;
}

const ALL = new Set(["0.0.0.0", "::", "*"]);
// 모든 주소에 열려 있는가(같은 네트워크에서 접속 가능)
export const bindAll = (addrs) => addrs.some((a) => ALL.has(a));

// 시스템 서비스: 포트 < 1024, root 소유, 운영체제 경로의 실행 파일(ControlCenter·rapportd 등), 또는 주인을 모름(Linux 다른 사용자)
const SYS_PATH = /^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/usr\/lib\/systemd\/|\/lib\/systemd\/)/;
export function isSystem(port, proc, pid) {
  if (port < 1024) return true;
  if (pid == null) return true;
  if (!proc) return false;
  return proc.user === "root" || SYS_PATH.test(proc.command);
}

// 데스크톱 앱: 실행 파일이 .app 묶음 안에 있다(/Applications/Orca.app/Contents/MacOS/Orca, ~/Applications/…, /Library/…/x.app/Contents/…).
//   경로에 빈칸이 있을 수 있어(Visual Studio Code.app) 첫 낱말이 아니라 ".app/Contents/" 앞까지를 실행 파일 경로로 본다.
//   /Applications/·~/Applications/ 아래 앱도 이 규칙에 든다. 그 앞에 인자 경계(" -", " /")가 있으면 인자 속 경로라 실행 파일이 아니다(node /x/y.app/Contents/z.js).
export function isDesktop(command) {
  const c = String(command ?? "").trim();
  const cut = c.indexOf(".app/Contents/");
  if (cut < 0) return false;
  const exe = c.slice(0, cut);
  return /^[/~]/.test(exe) && !/ -| \//.test(exe);
}

// 기본으로 숨기는 포트: 시스템 서비스나 데스크톱 앱. 단 Herdr 터미널에서 띄운 것(term을 찾은 것)은 무엇이든 보인다.
export const isHidden = (p) => !p.term && (p.system || p.desktop);

// 구역 → 목록. (포트, pid)마다 한 줄로 주소를 모으고, 한 포트를 여러 pid가 나눠 쓰면(fork한 워커) 조상인 쪽 하나만 남긴다.
//   roots: Map(셸 pid → 터미널 주소). 결과는 포트순.
export function listen(sec, roots = new Map()) {
  const raw = sec.lsof !== undefined ? parseLsof(sec.lsof)
    : sec.ss !== undefined ? parseSs(sec.ss)
    : sec.tcp !== undefined ? parseProcTcp(sec.tcp, sec.fd) : [];
  const procs = parsePs(sec.ps);
  const byKey = new Map();
  for (const r of raw) {
    const k = `${r.port}|${r.pid ?? ""}`;
    const e = byKey.get(k) ?? { port: r.port, pid: r.pid, name: r.name, addrs: [] };
    if (!e.addrs.includes(r.addr)) e.addrs.push(r.addr);
    if (!e.name && r.name) e.name = r.name;
    byKey.set(k, e);
  }
  // 같은 포트에 pid가 여럿이면 다른 pid의 조상인 것만 남긴다(모두 남남이면 다 둔다)
  const byPort = new Map();
  for (const e of byKey.values()) { if (!byPort.has(e.port)) byPort.set(e.port, []); byPort.get(e.port).push(e); }
  const out = [];
  for (const group of byPort.values()) {
    let keep = group;
    if (group.length > 1) {
      const pids = new Set(group.map((e) => e.pid).filter((p) => p != null));
      keep = group.filter((e) => e.pid == null || !ancestors(procs.get(e.pid)?.ppid ?? null, procs).some((a) => pids.has(a)));
    }
    for (const e of keep) {
      const proc = e.pid != null ? procs.get(e.pid) : null;
      const name = e.name || baseName(proc?.command) || "알 수 없음";
      const system = isSystem(e.port, proc, e.pid);
      // 이름을 바꾼 앱 프로세스("Raycast Backend")는 경로가 없어 바로 위 부모가 앱 묶음인지도 본다
      const desktop = !system && Boolean(proc) && (isDesktop(proc.command) || isDesktop(procs.get(proc.ppid)?.command));
      out.push({ ...e, name, command: proc?.command ?? "", user: proc?.user ?? null,
        system, desktop, term: findRoot(e.pid, procs, roots), all: bindAll(e.addrs) });
    }
  }
  return out.sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

// 명령줄의 첫 낱말에서 파일 이름만
export function baseName(command) {
  const first = String(command ?? "").trim().split(/\s+/)[0] ?? "";
  return first.split("/").pop() ?? "";
}

// 한 기기의 출력 통째로 → { os, ports, ok, pids }
export function parseAll(text, roots) {
  const sec = sections(text);
  const pids = new Set(parsePs(sec.ps).keys());   // 살아 있는 pid(사라진 셸 pid를 지우는 데 쓴다)
  return { os: (sec.os ?? "").trim().toLowerCase(), ports: listen(sec, roots), ok: sec.ps !== undefined && pids.size > 0, pids };
}

// 왼쪽 목록 순서: 터미널에서 띄운 것 먼저, 그다음 포트순
export function order(ports) {
  return [...ports].sort((a, b) => (a.term ? 0 : 1) - (b.term ? 0 : 1) || a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

// 원격 기기 포트를 이 Mac에서 열 SSH 터널 명령(복사만 한다, 직접 열지 않는다).
//   m = hc machine ls의 항목 { name, target?, host?, via? }. ssh 대상(target "user@host:port")이 있으면 그것을, 없으면(명령 연결·못 찾음) 기기 이름을 쓴다.
//   → { command, guess } (guess: 기기 이름을 ssh 호스트로 짐작했다)
export function tunnelCommand(port, m) {
  const raw = m?.via ? "" : String(m?.target ?? m?.host ?? "").trim();
  let dest = raw, p = null;
  const hp = /^(.*?)(\[[^\]]+\]|[^:@[\]]+):(\d+)$/.exec(raw);   // [user@]host:port 또는 [user@][v6]:port
  if (hp) { dest = hp[1] + hp[2].replace(/^\[|\]$/g, ""); p = hp[3]; }
  else dest = dest.replace(/\[|\]/g, "");
  const guess = !dest;
  if (guess) dest = String(m?.name ?? "");
  const q = /^[\w.@:%+-]+$/.test(dest) ? dest : `'${dest.replace(/'/g, `'\\''`)}'`;
  return { command: `ssh -L ${port}:localhost:${port}${p && p !== "22" ? ` -p ${p}` : ""} ${q}`, guess };
}
