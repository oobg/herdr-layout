// 리소스 계산: ps 출력 한 번으로 터미널별 프로세스 트리의 CPU·메모리 합을 낸다.
// herdr에 기대지 않아 node로 실제 출력에 돌려 볼 수 있다(main.js가 exec 결과를 넘긴다).
//   ps -A -o pid=,ppid=,pcpu=,rss=  는 macOS와 Linux 둘 다 같은 모양(머리줄 없음, rss는 KB).
//   pcpu는 코어 하나 기준 %라서, 기기 전체 대비로 보이게 코어 수로 나눈다.

// 기기에서 한 번 돌리는 스크립트. 구역은 "@@이름" 줄로 나눈다.
export const SCRIPT = `echo @@ps; ps -A -o pid=,ppid=,pcpu=,rss=
echo @@sys; sysctl -n hw.ncpu hw.memsize 2>/dev/null || { nproc; awk '/MemTotal/{print $2*1024}' /proc/meminfo; }
echo @@vm; vm_stat 2>/dev/null || cat /proc/meminfo`;

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

// ps 본문 → { procs: Map(pid → {ppid, cpu, rss}), kids: Map(ppid → [pid]) }. rss는 바이트로 바꾼다.
export function parsePs(text) {
  const procs = new Map(), kids = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const pid = Number(f[0]), ppid = Number(f[1]), cpu = Number(f[2]), rss = Number(f[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    procs.set(pid, { ppid, cpu: Number.isFinite(cpu) ? cpu : 0, rss: Number.isFinite(rss) ? rss * 1024 : 0 });
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return { procs, kids };
}

// pid와 그 자손 전부의 합. 순환(pid 재사용 등)은 본 pid를 다시 세지 않아 막는다.
// pid가 ps에 없으면 null(터미널이 끝났거나 pid가 바뀜: 부르는 쪽이 다시 묻는다).
export function treeSum(tree, root) {
  if (!tree.procs.has(root)) return null;
  const seen = new Set(), stack = [root];
  let cpu = 0, mem = 0, n = 0;
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = tree.procs.get(pid);
    if (!p) continue;
    cpu += p.cpu; mem += p.rss; n++;
    for (const k of tree.kids.get(pid) ?? []) if (k !== pid) stack.push(k);
  }
  return { cpu, mem, n };
}

// 기기 전체: 코어 수, 실제 메모리, 사용 중 메모리, 모든 프로세스 CPU 합(코어 하나 기준 %).
//   macOS 사용 중 = 전체 - (free + inactive + speculative) 페이지 (활성 모니터의 "사용된 메모리"에 가깝다)
//   Linux 사용 중 = MemTotal - MemAvailable
export function parseSys(sec, tree) {
  const nums = String(sec.sys ?? "").trim().split(/\s+/).map(Number);
  const ncpu = nums[0] > 0 ? nums[0] : 1;
  const total = nums[1] > 0 ? nums[1] : null;
  const vm = String(sec.vm ?? "");
  let used = null;
  if (/page size of/.test(vm)) {
    const page = Number(/page size of (\d+)/.exec(vm)?.[1]) || 4096;
    const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vm)?.[1]) || 0;
    if (total) used = Math.max(0, total - (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * page);
  } else {
    const kb = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(vm)?.[1]);
    const t = kb("MemTotal"), a = kb("MemAvailable");
    if (Number.isFinite(t) && Number.isFinite(a)) used = (t - a) * 1024;
  }
  let cpu = 0;
  for (const p of tree.procs.values()) cpu += p.cpu;
  return { ncpu, total, used, cpu: Math.min(100, cpu / ncpu) };
}

// exec 출력 하나를 통째로 푼다: { tree, sys }
export function parseAll(text) {
  const sec = sections(text);
  const tree = parsePs(sec.ps);
  return { tree, sys: parseSys(sec, tree) };
}

// 표시: "1.40 GB", "512 MB", "0 MB". 숫자 칸 폭을 맞추려고 GB는 소수 둘째, MB는 정수.
export function fmtMem(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// "8.5%", 10% 이상은 정수. 기기 전체 대비(코어 수로 나눈 값)를 받는다.
export function fmtCpu(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}
