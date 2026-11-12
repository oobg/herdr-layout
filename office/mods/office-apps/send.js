// office-apps 공용: 에이전트에게 글 보내기. 검토·배포·출력·메모 앱이 같이 쓴다(받는 사람 고르기와 막힘 처리를 한 곳에서).
//   후보: agents() + 상태를 알리지 않는 에이전트 프로그램(review/model.js withSilent, 상태 null = 상태 모름).
//         어디서 고르는지는 앱이 정한다: 지금 스페이스(배포·메모), 오류가 난 터미널의 스페이스(출력, 그 터미널 자신은 뺌),
//         그 폴더에서 일하는 에이전트(검토).
//   순서: 입력 대기는 맨 뒤 → 같은 탭 → 포커스된 것 → 원래 순서(스페이스·탭·칸).
//   표시: "스페이스 › 탭 · 프로그램 · 상태 낱말". 고르기 줄은 recipients()(앱마다 같은 모양).
//   상태 규칙: 대기 중·끝남 → 바로 보냄, 작업 중·상태 모름 → 확인 창("그래도 보내기"), 입력 대기 → 보내지 않고 이유 안내
//             (hc send는 대화 상자에 답하지 않으려고 거절한다; --force는 쓰지 않는다).
//   실행 직전(바로 보낼 때도, 확인 창에서 눌렀을 때도) 상태를 다시 읽고, 본 것과 다르거나 닫혔으면 보내지 않는다.
//   호출: `hc send -- <주소> <글>`(원격은 machine/tN 주소 그대로 이 Mac의 hc로). 사람이 쓰다 만 입력이 있으면 hc가 기다리므로
//         넉넉히 2분. 결과 알림은 한 가지. ctx.reply가 있으면 그 공유 상태에 { id, phase: "sending" | "done", ok }를 쓴다
//         (확인 창은 오버레이 복사본이라 앱이 결과를 거기서 받는다).
// 확인 창 동작은 ACTIONS["send.toAgent"] 하나. main.js가 모든 앱을 import하므로 오버레이 복사본에서도 등록돼 있다.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, panes, spaces, exec, notify, openOverlay, setShared } from "herdr";
import { ACTIONS } from "./menu.js";
import { withSilent } from "./review/model.js";

export const STATUS_WORD = { working: "작업 중", blocked: "입력 대기", done: "끝남", idle: "대기 중" };
export const statusWord = (s) => STATUS_WORD[s] ?? "상태 모름";
const spaceLabel = (n) => (n === "~" ? "홈" : n || "");
const first = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 200);

// ── 순수 함수(node로 시험) ──────────────────────────────

// near = { tab, exclude }: 같은 탭을 앞에, exclude 주소는 뺀다.
export function order(list, near = {}) {
  const rank = (a) => (a.status === "blocked" ? 4 : 0) + (near.tab && a.tab === near.tab ? 0 : 2) + (a.focused ? 0 : 1);
  return list.map((a, i) => [a, i]).filter(([a]) => !near.exclude || a.address !== near.exclude)
    .sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([a]) => a);
}

// "스페이스 › 탭 · 프로그램"
export function who(a) {
  const tab = a.tab_name || (a.tab_index ? String(a.tab_index) : "");
  return [`${spaceLabel(a.space_name)} › ${tab}`, a.program?.name || a.title || a.address].join(" · ");
}
export const label = (a) => `${who(a)} · ${statusWord(a.status)}`;

// 상태 → { kind: "send" | "confirm" | "block", why }
export function rule(status) {
  if (status === "blocked") return { kind: "block", why: "답을 기다리는 중이라 보내지 않았습니다. 그 터미널에서 먼저 답한 뒤 다시 보내세요." };
  if (status === "idle" || status === "done") return { kind: "send", why: "" };
  if (status === "working") return { kind: "confirm", why: "작업 중입니다. 보낸 글은 하던 일이 끝난 뒤 다음 입력으로 처리됩니다." };
  return { kind: "confirm", why: "상태를 알 수 없습니다(상태를 알리지 않는 에이전트). 입력 중이면 그 사이에 글이 들어갑니다." };
}

// 본 상태와 지금 상태가 다르면 멈춘 이유, 같으면 null. 끝남과 대기 중은 같게 본다(보고 나면 끝남이 대기 중으로 바뀐다).
const norm = (s) => (s === "done" ? "idle" : s ?? null);
export function drift(seen, live) {
  if (!live) return "받을 에이전트가 닫혔습니다";
  if (norm(seen) !== norm(live.status)) return `상태가 바뀌었습니다(${statusWord(seen)} → ${statusWord(live.status)}). 다시 보고 보내세요.`;
  return null;
}

export const sendArgs = (address, text) => ["send", "--", address, text];

// ── 지금 상태 ───────────────────────────────────────────

export function everyAgent() { return withSilent(agents() ?? [], panes() ?? [], spaces() ?? []); }
export function liveOf(address) { return everyAgent().find((a) => a.address === address) ?? null; }

// 후보: { space } 그 스페이스의 에이전트, { list } 앱이 준 목록(검토: 그 폴더의 에이전트). near = { tab, exclude }.
//   list로 받은 것도 상태는 지금 것으로 바꾼다.
export function candidates({ space = null, list = null, near = {} } = {}) {
  const all = everyAgent();
  let pool;
  if (list) { const live = new Map(all.map((a) => [a.address, a])); pool = list.map((a) => live.get(a.address) ?? a); }
  else pool = space ? all.filter((a) => a.space === space) : [];
  return order(pool, near);
}

// ── 보내기 ─────────────────────────────────────────────

function reply(ctx, phase, ok) { if (ctx.reply) setShared(ctx.reply, { id: ctx.id, phase, ok }); }

// 확인 창 복사본에서도 돈다: ctx는 값만 { id, address, text, label, seen, reply }
export async function deliver(ctx) {
  const why = drift(ctx.seen, liveOf(ctx.address));
  if (why) {
    notify({ title: `${ctx.label}에게 보내지 않았습니다`, body: why, level: "warning" });
    reply(ctx, "done", false);
    return false;
  }
  reply(ctx, "sending");
  let r;
  try { r = await exec("hc", sendArgs(ctx.address, ctx.text), { timeout: 120000 }); }
  catch (e) { r = { code: -1, stdout: "", stderr: String(e?.message ?? e) }; }
  const ok = r.code === 0;
  if (ok) notify({ title: `${ctx.label}에게 보냈습니다`, body: first(ctx.text), level: "success" });
  else notify({ title: `${ctx.label}에게 보내지 못했습니다`, body: first(r.stderr || r.stdout) || `hc 종료 코드 ${r.code}`, level: "error" });
  reply(ctx, "done", ok);
  return ok;
}
ACTIONS["send.toAgent"] = (ctx) => { deliver(ctx); };

// 앱에서 부른다. a = 후보 하나, opts = { id, reply, note(늘 확인 창을 띄울 이유) }.
//   돌려줌: { state: "gone" | "blocked" | "confirm" | "sending", id, done?: Promise<boolean> }
export function sendToAgent(a, text, { id = String(Date.now()), reply: key = null, note = null } = {}) {
  const live = liveOf(a.address);
  if (!live) {
    notify({ title: "보내지 않았습니다", body: "받을 에이전트가 닫혔습니다", level: "warning" });
    return { state: "gone", id };
  }
  const r = rule(live.status), ctx = { id, address: live.address, text, label: who(live), seen: live.status ?? null, reply: key };
  if (r.kind === "block") {
    notify({ title: `${ctx.label}에게 보내지 않았습니다`, body: r.why, level: "warning" });
    return { state: "blocked", id };
  }
  if (r.kind === "confirm" || note) {
    openOverlay({ mod: "office-apps", kind: "dialog", width: 440, height: 220, props: {
      role: "confirm", action: "send.toAgent", ctx, yes: r.kind === "confirm" ? "그래도 보내기" : "보내기",
      title: `${ctx.label}에게 보낼까요?`,
      detail: [note, r.why, `첫 줄: ${first(text)}`].filter(Boolean).join("\n"),
    } });
    return { state: "confirm", id };
  }
  return { state: "sending", id, done: deliver(ctx) };
}

// 받는 사람 고르기 줄: "보낼 곳" + 후보마다 한 칸(고른 것은 바탕). 후보가 없으면 그 이유 한 줄.
//   id = 앱 접두사, sel = 고른 주소, pick(address, cx).
export function recipients(id, list, sel, pick, t, empty = "이 스페이스에 에이전트가 없습니다") {
  const row = h_flex().flex_wrap().gap(6).items_center().min_w(0)
    .child(div().flex_none().text_size(12).text_color(t.muted).child("보낼 곳"));
  if (!list.length) return row.child(div().text_size(12).text_color(t.dim).child(empty));
  return row.children(list.map((a) => {
    const on = a.address === sel;
    return h_flex().id(`${id}-to-${a.address}`).flex_none().max_w(320).px(6).py(2).gap(6).items_center().rounded(4).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { pick(a.address, cx); cx.notify(); })
      .child(div().min_w(0).truncate().text_size(12).text_color(on ? t.foreground : t.muted).child(who(a)))
      .child(div().flex_none().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(statusWord(a.status)));
  }));
}

// 고른 주소가 후보에 있으면 그것, 없으면 첫 후보(입력 대기는 맨 뒤라 첫 후보가 막혀 있으면 모두 막혀 있다).
export const chosen = (list, sel) => list.find((a) => a.address === sel) ?? list[0] ?? null;
