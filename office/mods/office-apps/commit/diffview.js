// diff 줄 그리기(커밋 앱·PR 앱 공용). 데이터는 commit/git.js의 diffRows → wordSpans(→ splitRows)로 만든다.
//   inlineRow(row, t, pal)   위아래 보기 한 줄: 옛 번호 · 새 번호 · 기호 · 내용
//   splitRow(pair, t, pal)   좌우 보기 한 줄: 왼쪽(옛 파일) 번호·내용 | 오른쪽(새 파일) 번호·내용
//   splitWidth(pairs) / inlineWidth(rows)   가로 스크롤 폭(px)
//   diffMode() / setDiffMode(mode) / modeToggle(t, id, narrow)   위아래|좌우 보기 모드(두 앱이 같은 값을 나눈다)
// pal은 diffPalette(t, dark). 줄 높이는 DIFF_LINE, 글꼴 크기·글꼴은 부르는 쪽 컨테이너에서 정한다.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { columns } from "./git.js";

export { isDark, diffPalette, wordSpans, splitRows } from "./git.js";

export const DIFF_LINE = 20;
export const NARROW = 760;   // diff 칸이 이보다 좁으면 좌우 모드여도 위아래로 그린다

// 보기 모드: localStorage "commit.diffMode" = "inline"(위아래) | "split"(좌우). 두 앱이 그릴 때마다 읽어
// 어느 쪽에서 바꿔도 다른 쪽이 따른다. localStorage가 안 되면 이번 실행 동안만 메모리 값을 쓴다.
const MODE_KEY = "commit.diffMode";
let modeMem = "inline";
export function diffMode() {
  try { return localStorage.getItem(MODE_KEY) === "split" ? "split" : "inline"; } catch { return modeMem; }
}
export function setDiffMode(mode) {
  modeMem = mode === "split" ? "split" : "inline";
  try { localStorage.setItem(MODE_KEY, modeMem); } catch { /* 이번 실행 동안만 */ }
}

// 작은 글자 전환: 위아래 | 좌우. 고른 쪽만 진하게. 좁아서 위아래로 그리는 중이면 "좌우" 옆에 표시.
// id는 요소 id 앞부분("commit"·"pr"), narrow는 지금 diff 칸이 좁은지.
export function modeToggle(t, id, narrow) {
  const cur = diffMode();
  const opt = (mode, label) => div().id(`${id}-mode-${mode}`).px(6).py(2).rounded(4).text_size(11).cursor_pointer()
    .text_color(cur === mode ? t.foreground : t.dim).when(cur === mode, (el) => el.bg(t.hover))
    .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { setDiffMode(mode); cx.notify(); }).child(label);
  return h_flex().flex_none().ml(4).gap(2).items_center()
    .child(opt("inline", "위아래"))
    .child(div().text_size(11).text_color(t.dim).child("|"))
    .child(opt("split", cur === "split" && narrow ? "좌우(좁아서 위아래)" : "좌우"));
}
const NUM_W = 40, SIGN_W = 16, CHAR_W = 7;

// 내용: 바뀐 구간(row.hl)이 있으면 앞 · 가운데(진한 바탕) · 뒤 세 조각으로.
function content(row, t, word) {
  const el = h_flex().flex_1().min_w(0).h_full().items_center().whitespace_nowrap().text_color(row.kind === "" ? t.dim : t.foreground);
  if (!row.hl) return el.child(div().whitespace_nowrap().child(row.text));
  const ch = Array.from(row.text), [a, b] = row.hl;
  return el
    .when(a > 0, (e) => e.child(div().whitespace_nowrap().child(ch.slice(0, a).join(""))))
    .child(div().whitespace_nowrap().rounded(2).bg(word).child(ch.slice(a, b).join("")))
    .when(b < ch.length, (e) => e.child(div().whitespace_nowrap().child(ch.slice(b).join(""))));
}

const num = (n, t, bg) => div().w(NUM_W).h_full().flex_none().pr(6).flex().items_center().justify_end().text_size(11).text_color(t.dim)
  .when(Boolean(bg), (e) => e.bg(bg)).child(n === undefined || n === null ? "" : String(n));

function colors(kind, pal) {
  if (kind === "+") return { line: pal.addLine, word: pal.addWord, gutter: pal.addGutter, sign: pal.addSign };
  if (kind === "-") return { line: pal.delLine, word: pal.delWord, gutter: pal.delGutter, sign: pal.delSign };
  return { line: null, word: null, gutter: null, sign: null };
}

function hunk(text, pal) {
  return div().w_full().h(DIFF_LINE).flex_none().px(12).flex().items_center().whitespace_nowrap().text_size(11)
    .text_color(pal.hunkFg).bg(pal.hunkBg).child(text);
}

export function inlineRow(row, t, pal) {
  if (row.kind === "@") return hunk(row.text, pal);
  const c = colors(row.kind, pal);
  return h_flex().w_full().h(DIFF_LINE).flex_none().items_center()
    .when(Boolean(c.line), (e) => e.bg(c.line))
    .child(num(row.old, t, c.gutter)).child(num(row.next, t, c.gutter))
    .child(div().w(SIGN_W).h_full().flex_none().flex().items_center().justify_center().text_color(c.sign ?? t.dim)
      .when(Boolean(c.gutter), (e) => e.bg(c.gutter)).child(row.kind === "+" || row.kind === "-" ? row.kind : ""))
    .child(div().w(6).flex_none())
    .child(content(row, t, c.word));
}

// 한쪽 반: 줄이 없으면 흐린 빈칸. 왼쪽은 옛 번호, 오른쪽은 새 번호.
function half(row, side, t, pal) {
  if (!row) return div().flex_1().min_w(0).h_full().bg(pal.emptyBg);
  const c = colors(row.kind, pal);
  return h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden()
    .when(Boolean(c.line), (e) => e.bg(c.line))
    .child(num(side === "left" ? row.old : row.next, t, c.gutter))
    .child(div().w(SIGN_W).h_full().flex_none().flex().items_center().justify_center().text_color(c.sign ?? t.dim)
      .when(Boolean(c.gutter), (e) => e.bg(c.gutter)).child(row.kind === "+" || row.kind === "-" ? row.kind : ""))
    .child(div().w(6).flex_none())
    .child(content(row, t, c.word));
}

export function splitRow(pair, t, pal) {
  if (pair.hunk !== undefined) return hunk(pair.hunk, pal);
  return h_flex().w_full().h(DIFF_LINE).flex_none().items_center()
    .child(half(pair.left, "left", t, pal))
    .child(div().w(1).h_full().flex_none().bg(t.border))
    .child(half(pair.right, "right", t, pal));
}

export function inlineWidth(rows) {
  let w = 300;
  for (const r of rows) w = Math.max(w, columns(r.text) * CHAR_W + NUM_W * 2 + SIGN_W + 40);
  return w;
}

export function splitWidth(pairs) {
  let w = 150;
  for (const p of pairs) for (const r of [p.left, p.right]) if (r) w = Math.max(w, columns(r.text) * CHAR_W + NUM_W + SIGN_W + 30);
  return w * 2 + 1;
}
