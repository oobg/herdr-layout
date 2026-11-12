// 마지막 말 그리기: 에이전트 앱 요약 칸 · 알림함 상세 · 세션 앱 상세가 같이 쓴다.
//   줄바꿈을 살리고 마크다운(파일 앱 뷰어와 같은 parseMarkdown 블록)으로 그린다. 글은 TextView.markdown,
//   코드 블록은 고정폭 상자(편집기는 만들지 않는다), 알림(> [!NOTE])은 왼쪽 선, 그림은 대체 글.
//   접힌 모양은 앞 6줄까지, 넘치면 흐린 "더 보기"(누르면 onToggle). 블록 나누기와 캐시는 agent/saytext.js.
import { div } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { sayBlocks } from "./saytext.js";

const CODE_FONT = "D2Coding";

// id: 요소 id 머리. text: 마지막 말. open: 펼쳤는지. onToggle(e, cx): "더 보기"/"접기"를 눌렀을 때. size: 글 크기(기본 13)
export function sayView(id, text, { open = false, onToggle = null, size = 13, color = null, t }) {
  const v = sayBlocks(text);
  const blocks = open || !v.more ? v.full : v.head;
  const md = (k, s) => TextView.markdown(`${id}-${k}`, s).selectable(true);
  const body = blocks.map((b, i) => {
    if (b.kind === "text") return md(i, b.text);
    if (b.kind === "code") return v_flex().rounded(4).bg(t.surface).border_1().border_color(t.border).px(8).py(5)
      .font_family(CODE_FONT).text_size(size - 1).text_color(t.foreground)
      .children(b.text.split("\n").map((l) => div().whitespace_nowrap().overflow_hidden().child(l || " ")));
    if (b.kind === "alert") return v_flex().pl(10).border_l_2().border_color(t.border).child(md(i, b.text));
    if (b.kind === "images") return div().text_color(t.dim).child(b.items.map((it) => `[그림${it.alt ? `: ${it.alt}` : ""}]`).join(" "));
    return null;
  }).filter(Boolean);
  return v_flex().gap(4).min_w(0).text_size(size).text_color(color ?? t.foreground)
    .children(body)
    .when(v.more && Boolean(onToggle), (el) => el.child(div().id(`${id}-more`).text_size(11).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click(onToggle).child(open ? "접기" : "더 보기")));
}
