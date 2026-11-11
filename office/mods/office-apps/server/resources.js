// 서버 앱의 시스템 리소스: 기기에서 셸 스크립트 하나를 돌려 구역별(@@이름) 출력을 받고, 여기서 숫자로 푼다.
// 파싱 함수는 herdr에 기대지 않아 node로 실제 출력에 돌려 볼 수 있다. exec는 부르는 쪽이 넘긴다.
//   빠른 묶음(2초): CPU·메모리·네트워크 바이트   느린 묶음(30초): 저장 용량·배터리·네트워크 종류와 IP
// CPU는 macOS에서 top 대신 iostat을 쓴다: top -l 2는 한 번에 CPU 1.4초를 먹어 2초 주기로는 너무 무겁다(iostat은 정수 %).

export const SCRIPTS = {
  darwin: {
    fast: `echo @@cpu; iostat -n 0 -c 2 -w 1 | tail -1
echo @@vm; vm_stat
echo @@sys; sysctl -n hw.memsize kern.memorystatus_level
echo @@net; netstat -ibn`,
    slow: `IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
echo @@disk; diskutil info -plist / 2>/dev/null | grep -A1 -E '<key>(APFSContainerSize|APFSContainerFree|TotalSize|FreeSpace)</key>'
echo @@df; df -k / | tail -1
echo @@batt; pmset -g batt 2>/dev/null
echo @@ioreg; ioreg -rn AppleSmartBattery 2>/dev/null | grep -E '"(CycleCount|MaxCapacity|Temperature|ExternalConnected|BatteryData)" ='
echo @@if; echo "$IF"
echo @@ports; networksetup -listallhardwareports 2>/dev/null
echo @@ip; [ -n "$IF" ] && ipconfig getifaddr "$IF"`,
  },
  linux: {
    fast: `echo @@stat; head -1 /proc/stat
echo @@mem; cat /proc/meminfo
echo @@psi; cat /proc/pressure/memory 2>/dev/null
echo @@dev; cat /proc/net/dev`,
    slow: `IF=$(awk '$2=="00000000"{print $1; exit}' /proc/net/route 2>/dev/null)
echo @@df; df -kP / | tail -1
echo @@batt; for b in /sys/class/power_supply/BAT*; do [ -d "$b" ] || continue
  for k in capacity status cycle_count energy_full energy_full_design charge_full charge_full_design temp; do [ -r "$b/$k" ] && echo "$k=$(cat "$b/$k")"; done; break; done
  for a in /sys/class/power_supply/A*; do [ -r "$a/online" ] && echo "ac=$(cat "$a/online")"; done
echo @@if; echo "$IF"
echo @@wifi; [ -n "$IF" ] && [ -d "/sys/class/net/$IF/wireless" ] && echo yes
echo @@ip; [ -n "$IF" ] && ip -4 -o addr show dev "$IF" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1`,
  },
};

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

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };

// ── macOS ──
// iostat 마지막 줄: " us sy id 1m 5m 15m"
export function macCpu(s) {
  const f = (s ?? "").trim().split(/\s+/).map(Number);
  if (f.length < 3 || f.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
  return { user: f[0], system: f[1], idle: f[2], used: Math.max(0, 100 - f[2]) };
}

// vm_stat + hw.memsize: Activity Monitor식(사용 = 앱 + 와이어드 + 압축, 앱 = 익명 - 퍼지 가능)
export function macMem(vm, sys) {
  const page = num(/page size of (\d+)/.exec(vm ?? "")?.[1]) ?? 4096;
  const get = (k) => num(new RegExp(`^"?${k}"?:\\s+(\\d+)`, "m").exec(vm ?? "")?.[1]) ?? 0;
  const [total, level] = (sys ?? "").trim().split(/\s+/).map(Number);
  if (!total) return null;
  const wired = get("Pages wired down") * page, compressed = get("Pages occupied by compressor") * page;
  const used = (get("Pages active") + get("Pages inactive") + get("Pages speculative") - get("Pages purgeable") - get("File-backed pages")) * page + wired + compressed;
  const app = Math.max(0, used - wired - compressed);
  return { total, used, pct: (used / total) * 100, pressure: Number.isFinite(level) ? 100 - level : null, app, wired, compressed };
}

// netstat -ibn: 인터페이스의 <Link#> 줄에서 받은·보낸 바이트(주소 칸이 비는 줄이 있어 끝에서 센다)
export function macNet(s, iface) {
  for (const line of (s ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] === iface && f[2]?.startsWith("<Link#")) {
      const n = f.length;
      return { rx: num(f[n - 5]), tx: num(f[n - 2]) };
    }
  }
  return null;
}

// diskutil info -plist (APFS면 컨테이너 기준), 없으면 df -k
export function macDisk(plist, df) {
  const key = (k) => num(new RegExp(`<key>${k}</key>\\s*<integer>(\\d+)</integer>`).exec(plist ?? "")?.[1]);
  const size = key("APFSContainerSize") ?? key("TotalSize"), free = key("APFSContainerFree") ?? key("FreeSpace");
  if (size && free !== null && free > 0) return { total: size, used: size - free, pct: ((size - free) / size) * 100 };
  return dfDisk(df);
}

// pmset -g batt + ioreg AppleSmartBattery. 배터리가 없으면 null.
export function macBattery(pm, io) {
  const pct = /(\d+)%;\s*([^;]*)/.exec(pm ?? "");
  if (!pct || !/InternalBattery/.test(pm)) return null;
  const v = (k) => { const m = new RegExp(`"${k}"\\s*=\\s*(\\d+|Yes|No)`).exec(io ?? ""); return m ? (m[1] === "Yes" ? true : m[1] === "No" ? false : Number(m[1])) : null; };
  const source = /'([^']+)'/.exec(pm)?.[1];
  const raw = v("AppleRawMaxCapacity"), design = v("DesignCapacity"), max = v("MaxCapacity");
  // 애플 실리콘: MaxCapacity는 늘 100(%)이라 실제 최대 용량 ÷ 설계 용량으로 센다.
  const health = raw && design ? (raw / design) * 100 : max && max <= 100 ? max : max && design ? (max / design) * 100 : null;
  const temp = v("Temperature");
  return {
    pct: Number(pct[1]), state: pct[2].trim(),
    source: source === "AC Power" ? "전원 어댑터" : source === "Battery Power" ? "배터리" : source ?? null,
    health, cycles: v("CycleCount"), temp: temp ? temp / 100 : null,
  };
}

// networksetup -listallhardwareports: 그 장치가 Wi-Fi 포트인지
export function macKind(ports, iface) {
  const blocks = (ports ?? "").split(/\n\s*\n/);
  const b = blocks.find((x) => new RegExp(`^Device:\\s*${iface}\\s*$`, "m").test(x));
  const name = /Hardware Port:\s*(.+)/.exec(b ?? "")?.[1]?.trim();
  return name ? (/wi-?fi|airport/i.test(name) ? "Wi-Fi" : /ethernet|lan/i.test(name) ? "이더넷" : name) : null;
}

// ── Linux ──
// /proc/stat 첫 줄 → 누적 틱(두 표본 차로 %를 낸다)
export function linuxTicks(s) {
  const f = (s ?? "").trim().split(/\s+/);
  if (f[0] !== "cpu") return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f.slice(1).map(Number);
  return { user: user + nice, system: system + irq + softirq + steal, idle: idle + iowait };
}

export function cpuFromTicks(a, b) {
  if (!a || !b) return null;
  const du = b.user - a.user, ds = b.system - a.system, di = b.idle - a.idle, all = du + ds + di;
  if (all <= 0) return null;
  return { user: (du / all) * 100, system: (ds / all) * 100, idle: (di / all) * 100, used: ((du + ds) / all) * 100 };
}

export function linuxMem(s, psi) {
  const kb = (k) => (num(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(s ?? "")?.[1]) ?? 0) * 1024;
  const total = kb("MemTotal");
  if (!total) return null;
  const avail = kb("MemAvailable"), used = total - avail;
  const p = num(/some avg10=([\d.]+)/.exec(psi ?? "")?.[1]);
  return { total, used, pct: (used / total) * 100, pressure: p, cache: kb("Cached") + kb("Buffers"), swap: kb("SwapTotal") - kb("SwapFree") };
}

// /proc/net/dev: "eth0: rx_bytes … (8칸) tx_bytes …"
export function linuxNet(s, iface) {
  const line = (s ?? "").split("\n").find((l) => l.trim().startsWith(iface + ":"));
  if (!line) return null;
  const f = line.split(":")[1].trim().split(/\s+/);
  return { rx: num(f[0]), tx: num(f[8]) };
}

export function linuxBattery(s) {
  const kv = Object.fromEntries((s ?? "").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
  if (kv.capacity === undefined) return null;
  const full = num(kv.energy_full ?? kv.charge_full), design = num(kv.energy_full_design ?? kv.charge_full_design);
  return {
    pct: num(kv.capacity), state: kv.status ?? "",
    source: kv.ac === "1" ? "전원 어댑터" : kv.ac === "0" ? "배터리" : null,
    health: full && design ? (full / design) * 100 : null, cycles: num(kv.cycle_count) || null, temp: num(kv.temp) ? num(kv.temp) / 10 : null,
  };
}

// df -k(P) 마지막 줄: 장치 전체 사용 사용가능 … — 비율은 df처럼 사용 ÷ (사용 + 사용가능)
export function dfDisk(s) {
  const f = (s ?? "").trim().split(/\s+/);
  const total = num(f[1]), used = num(f[2]), avail = num(f[3]);
  if (!total || used === null || avail === null) return null;
  return { total: total * 1024, used: used * 1024, pct: (used / (used + avail)) * 100 };
}

// ── 보기 좋게 ──
export const gb = (b) => (b === null || b === undefined ? "" : `${(b / 1e9).toFixed(1)} GB`);
export const pct = (x, d = 1) => (x === null || x === undefined ? "" : `${x.toFixed(d)}%`);
export function rate(bps) {
  if (bps === null || bps === undefined) return "";
  const k = bps / 1000;
  return k >= 1000 ? `${(k / 1000).toFixed(1)} MB/s` : `${k.toFixed(1)} kB/s`;
}

// 표본 하나 읽기. prev: 이 기기의 지난 상태(누적 틱·바이트·느린 묶음). slow: 느린 묶음도 읽을지.
// 돌려주는 것: 다음 prev로 쓸 상태 객체(그대로 화면에 쓴다). 못 읽으면 throw.
export async function sample(exec, on, prev, slow) {
  let os = prev?.os;
  if (!os) {
    const u = await exec("uname", [], { on, timeout: 10000 });
    os = u.stdout.trim().toLowerCase();
  }
  const sc = SCRIPTS[os];
  if (!sc) throw new Error(`지원하지 않는 시스템: ${os}`);
  const script = slow || !prev?.slowAt ? `${sc.fast}\n${sc.slow}` : sc.fast;
  const r = await exec("sh", ["-c", script], { on, timeout: 15000 });
  const s = sections(r.stdout);
  const now = Date.now();
  const next = { ...prev, os, at: now, error: null };
  if (s.if !== undefined) {   // 느린 묶음
    next.slowAt = now;
    next.iface = s.if.trim() || null;
    next.ip = (s.ip ?? "").trim() || null;
    if (os === "darwin") {
      next.disk = macDisk(s.disk, s.df);
      next.battery = macBattery(s.batt, s.ioreg);
      next.kind = next.iface ? macKind(s.ports, next.iface) : null;
    } else {
      next.disk = dfDisk(s.df);
      next.battery = linuxBattery(s.batt);
      next.kind = next.iface ? ((s.wifi ?? "").trim() === "yes" ? "Wi-Fi" : "이더넷") : null;
    }
  }
  let bytes = null;
  if (os === "darwin") {
    next.cpu = macCpu(s.cpu);
    next.mem = macMem(s.vm, s.sys);
    bytes = next.iface ? macNet(s.net, next.iface) : null;
  } else {
    const ticks = linuxTicks(s.stat);
    next.cpu = cpuFromTicks(prev?.ticks, ticks) ?? prev?.cpu ?? null;
    next.ticks = ticks;
    next.mem = linuxMem(s.mem, s.psi);
    bytes = next.iface ? linuxNet(s.dev, next.iface) : null;
  }
  // 속도: 같은 인터페이스의 지난 바이트와의 차
  const last = prev?.bytes;
  if (bytes && last && last.iface === next.iface && prev.at && now > prev.at) {
    const dt = (now - prev.at) / 1000;
    next.up = Math.max(0, (bytes.tx - last.tx) / dt);
    next.down = Math.max(0, (bytes.rx - last.rx) / dt);
  }
  next.bytes = bytes ? { ...bytes, iface: next.iface } : null;
  // 최근 사용률 60개(스파크라인)
  next.history = [...(prev?.history ?? []), next.cpu?.used ?? null].filter((x) => x !== null).slice(-60);
  return next;
}
