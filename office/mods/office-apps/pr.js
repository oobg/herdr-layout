// office-apps의 앱(준비 중 자리표시자). 서브에이전트가 이 파일을 채운다.
// 앱 셸(main.js)이 부르는 것: init(props, cx) / list(cx, t) 왼쪽 칸 / detail(cx, t) 오른쪽 칸(null이면 "선택 내용이 없습니다") / subtitle(t) 위 막대 부제
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

export class PrApp {
  init(_p, _cx) {}
  list(_cx, t) { return v_flex().p(16).child(div().text_color(t.muted).child("준비 중인 앱입니다")); }
  detail(_cx, _t) { return null; }
  subtitle(_t) { return null; }
}
