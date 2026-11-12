// 작업 공간 앱 정리 규칙 확인: node office/mods/office-apps/workspace/test.mjs
//   고정 사례는 실제 `hc ls --json` + `hc get`(앞 프로그램)을 옮긴 것: git show 탭 7개가 git(pager 대기)을 앞에 둔 채 남아 있었다.
import assert from "node:assert/strict";
import { review, judge, recheckTidy, recheckClose, riskOf, skipSummary, gitLeftover } from "./tidy.js";
import { sleepable, confirmed, sleepSkips, probeWhy, lockWake, unlockWake, wakingNow, WAKE_LOCK } from "./sleep.js";

const NOW = 1_800_000_000_000;
const ZSH = { key: "shell", name: "zsh", shell: true, agent: false };
const GIT = { key: "program", name: "git", shell: false, agent: false };
const LESS = { key: "program", name: "/usr/bin/less", shell: false, agent: false };
const NVIM = { key: "nvim", name: "Neovim", shell: false, agent: false };
const CLAUDE = { key: "claude", name: "Claude Code", shell: false, agent: true };

const tab = (id, name, index, extra = {}) => ({ id, name, index, active: false, status: null, working_since: null, settled: false, changed_at: NOW - 60000, ...extra });
const pane = (id, tabId, program, extra = {}) => ({ pane: `p${id}`, terminal: `t${id}`, tab: tabId, program, status: null, cwd: "/r", ...extra });

// ── 실제 사례(hc ls --json, 2026-11-12) ──
const hashes = ["907ac4a7c827eb42b8ef8bc00ae6aef56c255c10", "3dfd72a9e6576e710a887fb655d9928504ece918", "907ac4a7c827eb42b8ef8bc00ae6aef56c255c10",
  "07aa9674ce23c52d685bd05ad4d76fc947602cdd", "e90dbe742ef618232d6b236d436c6c924cc8de8e", "e90dbe742ef618232d6b236d436c6c924cc8de8e",
  "93e8ad944fd7d1e3e8b6e48b1964d0104c97ea4b"];
const shows = hashes.map((h, i) => tab(`g${i}`, `show ${h}`, i + 1));
const handoff = tab("h", "handoff", 8, { active: true, status: "working" });
const sps = [
  { id: "home", name: "~", active: false, tabs: [tab("a", "1", 1, { active: true })] },
  { id: "puree", name: "puree-mcp-frontend", active: false, tabs: [tab("b", "1", 1, { active: true })] },
  { id: "hl", name: "herdr-layout", active: true, tabs: [...shows, handoff] },
];
const ps = [
  pane(1, "a", ZSH), pane(2, "b", ZSH),
  ...shows.map((tb, i) => pane(10 + i, tb.id, GIT)),
  pane(17, "h", CLAUDE, { status: "working", app: "claude-code" }),
];
const viewed = new Set(["h"]);
const r = review(sps, ps, { now: NOW, viewed });
assert.equal(r.cands.length, 7, "git show 탭 7개가 모두 후보");
assert.ok(r.cands.every((c) => c.rule === "git" && c.check && /pager/.test(c.reason)));
assert.deepEqual(r.skipped.map((x) => [x.tab.id, x.why]), [["a", "스페이스의 하나뿐인 탭"], ["b", "스페이스의 하나뿐인 탭"], ["h", "지금 보는 탭"]]);
assert.deepEqual(skipSummary(r.skipped), [["스페이스의 하나뿐인 탭", 2], ["지금 보는 탭", 1]]);

// ── git 이름 규칙 ──
const one = (name, programs, extra = {}) => {
  const t = tab("x", name, 1, extra), s = { id: "s", tabs: [t, tab("y", "other", 2)] };
  return judge(t, s, programs.map((p, i) => pane(100 + i, "x", p.program ?? p, p.status ? { status: p.status } : {})), { now: NOW });
};
assert.equal(one("show 93e8ad9", [ZSH]).check, true);                      // 셸만 남음
assert.equal(one("diff --stat", [LESS]).rule, "git");                       // pager(경로 이름)
assert.equal(one("push -u origin x", [GIT]).check, false);                  // push인데 git이 떠 있음: 기본 해제
assert.equal(one("push tag v1", [ZSH]).check, true);
assert.equal(one("pull --rebase", [ZSH, GIT]).rule, "git");
assert.match(one("diff", [NVIM]).why, /^프로그램 실행 중 \(Neovim\)/);       // 다른 프로그램이 있으면 뺀다
assert.equal(one("diff", [ZSH, { program: CLAUDE, status: "working" }]).why, "작업 중");
assert.equal(one("diff", [ZSH, { program: CLAUDE, status: "blocked" }]).why, "답 필요");
assert.equal(one("show zzz", [GIT]).why, "프로그램 실행 중 (git)");          // 해시가 아니면 git 탭이 아니다
assert.equal(one("build", [ZSH]).why, "셸만 있음 · 1시간 안에 씀");
assert.equal(one("build", [ZSH], { changed_at: NOW - 2 * 3600000 }).rule, "shell");
assert.equal(gitLeftover([]), false);
// 프로그램 표의 key로 맞춘다: 표에 git이 있으면 key "git", lazygit은 표시 이름이 "Git"이어도 pager가 아니다
assert.equal(one("diff", [{ key: "git", name: "Git", shell: false, agent: false }]).rule, "git");
assert.match(one("diff", [{ key: "lazygit", name: "Git", shell: false, agent: false }]).why, /^프로그램 실행 중 \(Git\)/);
assert.match(one("diff", [{ key: "nvim", name: "less", shell: false, agent: false }]).why, /^프로그램 실행 중/);
assert.equal(one("push origin x", [{ key: "git", name: "Git", shell: false, agent: false }]).check, false);
// 잠든 에이전트가 있는 탭
{
  const t = shows[0];
  assert.equal(judge(t, sps[2], ps, { now: NOW, asleep: new Set([t.id]) }).why, "잠든 에이전트가 있음");
}

// ── 닫기 직전 다시 보기 ──
const ids = r.cands.map((c) => c.tab.id);
const snap = riskOf(ids, sps, ps, { viewed });
// 그대로면 모두 닫는다
assert.deepEqual(recheckTidy(ids, snap, sps, ps, { now: NOW, viewed }).keep, ids);
// pager를 끄고 셸만 남아도(덜 위험) 그대로 닫는다
const quieter = ps.map((p) => (p.tab === "g0" ? { ...p, program: ZSH } : p));
assert.deepEqual(recheckTidy(ids, snap, sps, quieter, { now: NOW, viewed }).keep, ids);
// 창을 연 사이 g1 칸이 nvim으로 바뀌고 g2를 보게 됐고 g3에 Claude가 일을 시작했다
const busier = ps.map((p) => (p.tab === "g1" ? { ...p, program: NVIM } : p.tab === "g3" ? { ...p, program: CLAUDE, status: "working" } : p));
const sps2 = sps.map((s) => (s.id !== "hl" ? s : { ...s, tabs: s.tabs.map((tb) => (tb.id === "g3" ? { ...tb, status: "working" } : tb)) }));
const v2 = new Set(["h", "g2"]);
const rc = recheckTidy(ids, snap, sps2, busier, { now: NOW, viewed: v2 });
assert.deepEqual(rc.keep, ["g0", "g4", "g5", "g6"]);
assert.deepEqual(rc.dropped.map((d) => [d.id, d.why]),
  [["g1", "다른 프로그램이 실행됐습니다"], ["g2", "지금 보는 탭이 됐습니다"], ["g3", "작업 중인 에이전트가 생겼습니다"]]);
// 창을 열 때 기본 선택이던 pull 탭에서 git이 다시 돈다(덜 위험해 보여도 기본 해제로 바뀌면 뺀다)
{
  const t = tab("p", "pull", 1), s = [{ id: "s", tabs: [t, tab("q", "q", 2)] }];
  const sn = riskOf(["p"], s, [pane(1, "p", ZSH)], {});
  sn.p.check = true;
  const after = recheckTidy(["p"], sn, s, [pane(1, "p", GIT)], { now: NOW });
  assert.deepEqual(after.keep, []);
  assert.match(after.dropped[0].why, /git이 아직 떠 있습니다/);
}
// 이미 닫힌 탭
const gone = sps.map((s) => (s.id !== "hl" ? s : { ...s, tabs: s.tabs.filter((tb) => tb.id !== "g6") }));
assert.equal(recheckTidy(ids, snap, gone, ps, { now: NOW, viewed }).dropped[0].why, "이미 닫혔습니다");

// 탭 하나 닫기: 끝난 Claude 탭을 열어 두고 닫기 창을 띄웠는데 그새 일을 시작했다 / 답을 기다린다
{
  const t = tab("c", "chat", 1), s = [{ id: "s", tabs: [t, tab("d", "d", 2)] }];
  const p0 = [pane(1, "c", CLAUDE, { status: "done" })];
  const sn = riskOf(["c"], s, p0, {});
  assert.deepEqual(recheckClose(["c"], sn, s, p0, {}), []);
  assert.deepEqual(recheckClose(["c"], sn, s, [{ ...p0[0], status: "idle" }], {}), []);   // 완료→대기는 바뀐 게 아니다
  assert.equal(recheckClose(["c"], sn, s, [{ ...p0[0], status: "working" }], {})[0].why, "작업 중인 에이전트가 생겼습니다");
  assert.equal(recheckClose(["c"], sn, s, [{ ...p0[0], status: "blocked" }], {})[0].why, "답을 기다리는 에이전트가 생겼습니다");
  // 스페이스 닫기: 창을 연 뒤 생긴 탭
  const sn2 = riskOf(["c", "d"], s, p0, {});
  const s3 = [{ id: "s", tabs: [...s[0].tabs, tab("e", "new", 3)] }];
  assert.equal(recheckClose(["c", "d", "e"], sn2, s3, p0, {})[0].why, "창을 연 뒤 생긴 탭입니다");
}

// ── 재우기: 후보에서 뺀 에이전트와 이유 ──
{
  const CODEX = { key: "codex", name: "Codex", shell: false, agent: true };
  const old = NOW - 30 * 60000;
  const T = (id, extra = {}) => tab(id, id, 1, { changed_at: old, ...extra });
  const tabs = [T("ok"), T("seen"), T("fresh", { changed_at: NOW - 5 * 60000 }), T("unknown", { changed_at: null }),
    T("bg"), T("nolog"), T("work", { status: "working" }), T("cx"), T("slept")];
  const s = [{ id: "s", name: "S", tabs }];
  const C = (id, tb, extra = {}) => pane(id, tb, CLAUDE, { status: "done", ...extra });
  const pz = [C(1, "ok"), C(2, "seen"), C(3, "fresh"), C(4, "unknown"), C(5, "bg"), C(6, "nolog"),
    C(7, "work", { status: "working" }), pane(8, "cx", CODEX, { status: "idle" }), C(9, "slept"), pane(10, "ok", ZSH)];
  const good = { ok: true, session: "11111111-2222-3333-4444-555555555555", guessed: false, cwd: "/r", state: "done", open: [], agentsRunning: false, recordsWorking: false };
  const probes = { t1: good, t5: { ...good, open: ["a", "b"] }, t6: { ok: false, why: "세션을 특정하지 못함", open: [] } };
  const o = { now: NOW, viewed: new Set(["seen"]), sleeping: [{ address: "t9" }] };
  const pre = sleepable(s, pz, o);
  assert.deepEqual(confirmed(pre, probes).map((c) => c.address), ["t1"]);
  const sk = sleepSkips(s, pz, probes, o);
  assert.deepEqual(sk.map((x) => [x.tab.id, x.why]), [
    ["seen", "지금 보는 탭"],
    ["fresh", "20분 안에 씀 · 5분 변화 없음"],
    ["unknown", "쉰 시간 모름 · 앱을 켠 뒤 변화 없음"],
    ["bg", "백그라운드 작업이 돎 · 2개"],
    ["nolog", "확인 실패 · 세션을 특정하지 못함"],
    ["work", "작업 중"],
    ["cx", "Claude Code만 재울 수 있음 (Codex)"],
  ]);
  // 후보와 뺀 것이 겹치지 않고, 잠든 칸·셸 칸은 둘 다에 없다
  assert.ok(!sk.some((x) => x.address === "t1" || x.address === "t9" || x.address === "t10"));
  assert.equal(probeWhy(undefined), "기록 확인 중");
  assert.deepEqual(skipSummary(sk).slice(0, 1), [["지금 보는 탭", 1]]);
}

// ── 깨우기 잠금: 두 번 눌러도 한 번만 ──
{
  const rs = [{ address: "a", session: "x" }, { address: "b" }];
  const one = lockWake(rs, "a", NOW);
  assert.equal(one.got, true);
  assert.equal(one.next.find((r) => r.address === "a").waking, NOW);
  const two = lockWake(one.next, "a", NOW + 1000);
  assert.deepEqual([two.got, two.missing], [false, false]);            // 깨우는 중: 다시 보내지 않는다
  assert.equal(lockWake(one.next, "a", NOW + WAKE_LOCK + 1).got, true); // 오래된 잠금은 풀린 것으로
  assert.equal(lockWake(rs, "zz", NOW).missing, true);                  // 이미 깨웠거나 지운 기록
  const un = unlockWake(one.next, "a");
  assert.equal("waking" in un.find((r) => r.address === "a"), false);
  assert.equal(wakingNow(un[0], NOW), false);
  assert.equal(lockWake(un, "a", NOW + 1).got, true);                    // 실패 뒤 다시 깨울 수 있다
}

console.log("workspace/tidy ok");
