// 작업 공간 앱의 재우기·깨우기 입출력: 기록 확인(probe), 잠든 기록 파일, /exit 보내기, 이어 가기.
//   잠든 기록은 Herdr 데이터 폴더 data/office-apps/sleeping.json(viewers.js의 미리보기와 같은 data/office-apps/ 아래).
//   확인 창의 동작은 오버레이 복사본에서 돌고 앱은 따로라, 둘이 나눠 갖는 상태는 이 파일뿐이다.
//   판단은 workspace/sleep.js(순수 함수)가 한다.
import { exec, hc, appHome, readTextFile, writeTextFile, panes, spaces, focused, run, notify } from "herdr";
import * as fs from "fs/promises";
import { sessionOf, readLog, machineOf } from "../agent/activity.js";
import { viewedTabs, panesOf, hasWorking } from "./tidy.js";
import { isClaude, isShellPane, confirmed, openBackground, recordsWorking, treeRss, upsert, without, paneState, resumeLine, lockWake, unlockWake, UUID } from "./sleep.js";

const DIR = () => `${appHome()}/data/office-apps`;
const FILE = () => `${DIR()}/sleeping.json`;

// ── 잠든 기록 파일 ───────────────────────────────────────
// 기록: { address, pane, space, tab, session, cwd, machine, at, tabName, kb }
export async function readSleeping() {
  const text = await readTextFile(FILE()).catch(() => null);
  try { const v = JSON.parse(text ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

// 읽고 고쳐 쓰기. 다른 쪽(앱·확인 창)이 그새 썼으면 다시 읽어 한 번 더(writeTextFile의 expected 비교).
export async function updateSleeping(fn) {
  for (let i = 0; i < 4; i++) {
    const text = await readTextFile(FILE()).catch(() => null);
    let cur = [];
    try { const v = JSON.parse(text ?? "[]"); if (Array.isArray(v)) cur = v; } catch { /* 깨졌으면 빈 것으로 */ }
    const next = fn(cur);
    if (JSON.stringify(next) === JSON.stringify(cur)) return cur;
    try {
      await fs.mkdir(DIR(), { recursive: true });
      await writeTextFile(FILE(), JSON.stringify(next, null, 1), text);
      return next;
    } catch { /* 그새 바뀌었다: 다시 */ }
  }
  return null;
}

// ── 기록 확인 ────────────────────────────────────────────
// 기록 전체에서 백그라운드로 띄운 결과 줄과 완료 알림의 tool-use-id만 뽑는다(끝 2MB만 읽는 readLog로는 오래전에 띄운 것을 놓친다).
const SCAN = [
  'f=$(eval echo "$1")/$2.jsonl; [ -f "$f" ] || exit 3',
  `LC_ALL=C grep -oE '"tool_use_id":"[^"]+","type":"tool_result","content":(\\[\\{"type":"text","text":)?"(Command running in background|Async agent launched|Monitor started)' "$f"`,
  'echo "@@"',
  // 완료 알림: id와 그 상태(Monitor는 이벤트마다 알림이 와서, 끝났다는 상태가 붙은 것만 닫힌 것으로 센다)
  "LC_ALL=C grep -oE '<tool-use-id>[^<]+</tool-use-id>(\\\\n)?(<output-file>[^<]*</output-file>(\\\\n)?)?<status>[a-z_]+</status>' \"$f\" | sort -u",
  "exit 0",
].join("\n");

// 한 터미널을 확인한다. 실패·모름은 ok: false와 why(후보에서 뺀다, 이유는 정리 화면에).
//   { ok, why?, pid, session, guessed, cwd, state, open, agentsRunning, recordsWorking, at }
export async function probe(address) {
  const at = Date.now(), bad = (why, x = {}) => ({ ok: false, why, open: [], at, ...x });
  try {
    const r = await hc(["get", address, "--json"]);
    if (r.code !== 0) return bad("터미널 상태를 읽지 못함");
    const d = JSON.parse(r.stdout);
    const pid = d.foreground?.pid ?? null, on = machineOf(address);
    if (!pid || pid === d.pid) return bad("Claude 프로세스가 앞에 없음");   // 앞쪽 프로세스가 셸 자신이면 Claude가 없다
    const sess = await sessionOf(pid, d.foreground?.cwd ?? d.cwd ?? null, on);
    if (!sess?.session || sess.guessed || !UUID.test(sess.session)) return bad("세션을 특정하지 못함", { pid });
    const g = await exec("sh", ["-c", SCAN, "scan", sess.project, sess.session], { on, timeout: 20000 });
    if (g.code !== 0) return bad("대화 기록을 읽지 못함", { pid });
    const [launched, notes] = g.stdout.split("\n@@\n");
    const open = openBackground(launched ?? "", notes ?? "");
    // 끝부분 해석(parse.js agents): 백그라운드 서브에이전트가 아직 도는지. 못 읽으면 모르는 것으로.
    let agentsRunning = true;
    if (!open.length) {
      const v = await readLog(sess, null, null, on).catch(() => null);
      // 백그라운드로 띄운 것은 완료 알림이 올 때까지 running(parse.js가 "시작했다" 결과를 끝으로 치지 않는다)
      if (v && !v.same) agentsRunning = (v.agents ?? []).some((a) => a.running);
    }
    return { ok: true, pid, session: sess.session, guessed: false, cwd: sess.cwd, state: d.status?.state ?? null,
      open, agentsRunning, recordsWorking: recordsWorking(d.records), at };
  } catch { return bad("기록을 읽지 못함"); }
}

// ── 재우기(확인 창의 동작) ────────────────────────────────
// ctx: { items: [{ address, pane, tab, space, tabName }] }. 창을 연 뒤 바뀐 것은 다시 보고 건너뛴다.
// 하나씩: 다시 확인 → 메모리 재기 → 기록 저장 → 상태 다시 보기 → /exit. 다 보낸 뒤 5초 기다려 셸이 됐는지 본다.
//   5초 안에 셸이 안 됐으면 알리기만 하고 기록은 둔다: 늦게 끝나면 그대로 잠든 것이 되고, 끝내 안 끝나면 다음 갱신(GRACE 뒤)이 지운다.
//   이 확인은 확인 창이 닫힌 뒤에 돌아 끝까지 못 갈 수도 있다. 그래도 기록 파일과 다음 갱신만으로 상태가 맞는다.
export async function sleepAgents(ctx) {
  const sent = [], skipped = [];
  for (const it of ctx.items ?? []) {
    const ps = panes() ?? [], sps = spaces();
    const viewed = viewedTabs(sps, focused()?.tab ?? null);
    const p = ps.find((x) => x.terminal === it.address && x.pane === it.pane);
    const tab = sps.flatMap((s) => s.tabs).find((x) => x.id === p?.tab);
    if (!p || !tab || viewed.has(tab.id) || hasWorking(tab, panesOf(tab.id, ps)) || !isClaude(p.program, p.app)
      || (p.status !== "done" && p.status !== "idle")) { skipped.push(it.tabName); continue; }
    const pr = await probe(it.address);
    if (!confirmed([{ address: it.address }], { [it.address]: pr }).length) { skipped.push(it.tabName); continue; }
    const on = machineOf(it.address);
    const psOut = await exec("ps", ["-A", "-o", "pid=,ppid=,rss="], { on }).catch(() => null);
    const kb = psOut?.code === 0 ? treeRss(psOut.stdout, pr.pid) : 0;
    const rec = { address: it.address, pane: it.pane, space: it.space, tab: tab.id, session: pr.session, cwd: pr.cwd,
      machine: on, at: Date.now(), tabName: tab.name, kb };
    if (!(await updateSleeping((rs) => upsert(rs, rec)))) { skipped.push(it.tabName); continue; }
    // 보내기 직전에 상태를 한 번 더(메모리 재기·파일 쓰기 사이에 일을 시작했을 수 있다)
    const g = await hc(["get", it.address, "--json"]).catch(() => null);
    let state = null;
    try { state = JSON.parse(g?.stdout ?? "null")?.status?.state ?? null; } catch { /* 모름 */ }
    if (state !== "idle" && state !== "done") { await updateSleeping((rs) => without(rs, it.address)); skipped.push(it.tabName); continue; }
    // 대기(idle)면 그 상태일 때만 치게 한다: 그새 일을 시작했으면 /exit가 들어가지 않는다
    const r = await hc(["send", ...(state === "idle" ? ["--if", "idle"] : []), it.address, "/exit"]).catch(() => null);
    if (r?.code !== 0) { await updateSleeping((rs) => without(rs, it.address)); skipped.push(it.tabName); continue; }
    sent.push(rec);
  }
  if (skipped.length) notify({ title: `${skipped.length}개는 재우지 않았습니다`, body: `그새 바뀌었거나 기록을 확인하지 못했습니다: ${skipped.join(", ")}`, level: "warning" });
  if (!sent.length) return;
  await exec("sleep", ["5"]).catch(() => null);
  const ps = panes() ?? [];
  for (const rec of sent) {
    const p = ps.find((x) => x.terminal === rec.address && x.pane === rec.pane);
    if (p && isShellPane(p)) continue;
    notify({ title: `'${rec.tabName}' 탭을 재우지 못했습니다`, body: "Claude Code가 끝나지 않았습니다. 그 탭에서 직접 확인해 주세요.", level: "warning" });
  }
}

// ── 깨우기 ───────────────────────────────────────────────
// 칸이 셸이면 그 칸에서 이어 가고, 칸이 없어졌으면 같은 폴더에 새 탭을 연다. 셸이 아니면 기록만 지운다.
// 잠든 기록은 그 칸(새 탭이면 새 칸)이 Claude Code가 된 것을 본 뒤에만 지운다. 못 보면 기록을 두고 이유를 돌려준다(다시 깨울 수 있다).
// 돌려주는 값: { ok, to?: { space, tab, pane }(옮겨 갈 곳), why?(실패 이유), removed?(기록을 지웠는지) }
const WAIT = 15;   // 깨운 뒤 Claude Code가 뜨기를 기다리는 초

// 조건을 1초마다 WAIT초까지 본다(setTimeout이 없어 sleep 프로세스로 기다린다). 맞으면 그 값, 아니면 null.
async function waitFor(fn) {
  for (let i = 0; i < WAIT; i++) {
    await exec("sleep", ["1"]).catch(() => null);
    const v = fn(panes() ?? []);
    if (v) return v;
  }
  return null;
}
const claudeUp = (p) => Boolean(p && isClaude(p.program, p.app) && !isShellPane(p));

// 잠금(sleep.js lockWake)을 잡고 깨운다. 다른 쪽이 깨우는 중이면 { ok: false, busy: true }, 기록이 이미 없으면 { removed: true }.
//   실패면 잠금을 풀어 다시 깨울 수 있게 한다(성공·지운 경우는 기록째 없어진다).
export async function wake(rec) {
  let got = false, missing = false;
  const res = await updateSleeping((rs) => { const l = lockWake(rs, rec.address); got = l.got; missing = l.missing; return l.next; });
  if (missing) return { ok: false, removed: true };
  if (!res || !got) return { ok: false, busy: true };
  const r = await wakeLocked(rec).catch(() => ({ ok: false, why: "깨우지 못했습니다" }));
  if (!r.ok && !r.removed) await updateSleeping((rs) => unlockWake(rs, rec.address));
  return r;
}

// 칸 앞에 셸 말고 다른 프로세스가 있는지(hc get). Claude가 뜨는 중이어도 칸은 잠깐 셸로 보여, 프로그램 표 대신 앞 프로세스를 본다.
async function foregroundBusy(address) {
  const g = await hc(["get", address, "--json"]).catch(() => null);
  if (g?.code !== 0) return "칸 상태를 읽지 못했습니다";
  try {
    const d = JSON.parse(g.stdout), pid = d.foreground?.pid ?? null;
    return pid && pid !== d.pid ? "그 칸에서 이미 다른 프로세스가 돌고 있습니다" : null;
  } catch { return "칸 상태를 읽지 못했습니다"; }
}

async function wakeLocked(rec) {
  const ps = panes() ?? [], st = paneState(rec, ps);
  const drop = () => updateSleeping((rs) => without(rs, rec.address));
  if (!UUID.test(rec.session ?? "")) { await drop(); return { ok: false, removed: true, why: "세션 id가 잘못된 기록이라 지웠습니다" }; }
  if (st === "busy") { await drop(); return { ok: false, removed: true, why: "이미 다른 프로그램이 돌고 있어 잠든 기록만 지웠습니다" }; }
  if (st === "shell") {
    const p = ps.find((x) => x.terminal === rec.address && x.pane === rec.pane);
    const fg = await foregroundBusy(rec.address);
    if (fg) return { ok: false, why: fg };
    const r = await hc(["send", rec.address, resumeLine(rec)]).catch(() => null);
    if (r?.code !== 0) return { ok: false, why: `재개 명령을 보내지 못했습니다 ${(r?.stderr || r?.stdout || "").trim().slice(0, 120)}`.trim() };
    const up = await waitFor((now) => claudeUp(now.find((x) => x.terminal === rec.address && x.pane === rec.pane)));
    if (!up) return { ok: false, why: `${WAIT}초 안에 Claude Code가 뜨지 않았습니다 · 그 칸에서 확인해 주세요` };
    await drop();
    const space = spaces().find((s) => s.tabs.some((x) => x.id === p.tab));
    return { ok: true, to: { space: space?.id ?? rec.space, tab: p.tab, pane: p.pane } };
  }
  // 칸이 없다: 같은 폴더에 새 탭. 원격 기록은 그 스페이스가 남아 있을 때만(다른 스페이스에 열면 이 컴퓨터에서 돈다).
  const sp = spaces().find((s) => s.id === rec.space);
  if (rec.machine && !sp) return { ok: false, why: `${rec.machine}의 스페이스가 닫혀 있습니다 · 그 기기에서 claude --resume ${rec.session}` };
  const before = new Set(ps.map((x) => x.terminal).filter(Boolean));
  run("tab.new", { name: rec.tabName, ...(sp ? { space: sp.id } : {}), folder: rec.cwd, argv: ["claude", "--resume", rec.session] });
  run("layout.show", { id: "office-term" });
  // 새로 생긴 터미널 중 Claude Code인 칸(탭 이름이 같으면 그것을 먼저)
  const tabName = (p) => spaces().flatMap((s) => s.tabs).find((x) => x.id === p.tab)?.name;
  const p = await waitFor((now) => {
    const fresh = now.filter((x) => x.terminal && !before.has(x.terminal) && claudeUp(x));
    return fresh.find((x) => tabName(x) === rec.tabName) ?? (fresh.length === 1 ? fresh[0] : null);
  });
  if (!p) return { ok: false, why: `새 탭에서 ${WAIT}초 안에 Claude Code가 뜨지 않았습니다 · 그 탭에서 확인해 주세요` };
  await drop();
  const space = spaces().find((s) => s.tabs.some((x) => x.id === p.tab));
  return { ok: true, to: { space: space?.id ?? rec.space, tab: p.tab, pane: p.pane } };
}

// 기록만 지우기(칸이 닫힌 기록을 버릴 때)
export const forget = (rec) => updateSleeping((rs) => without(rs, rec.address));
