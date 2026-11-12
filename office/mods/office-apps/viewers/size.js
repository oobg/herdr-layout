// 뷰어 창의 크기·배율 계산(순수 함수, import 없음: node로 시험한다).
//   크기는 px { w, h }. 최소 560×400, 최대 앱 창의 0.96(창이 오른쪽·아래로 넘치지 않게 room으로 더 줄일 수 있다).
//   배율은 0.7~2.0, 0.1 단위.

export const MIN_W = 560, MIN_H = 400, MAX_SHARE = 0.96, FULL_SHARE = 0.92;
export const DEFAULT_SIZE = { w: 1120, h: 820 };
export const ZOOM_MIN = 0.7, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
// 머리줄 크기 버튼이 도는 순서: 작게 · 보통 · 크게 · 화면 가득(앱 창의 0.92)
export const PRESETS = [{ w: 880, h: 640 }, { w: 1120, h: 820 }, { w: 1440, h: 960 }, "full"];

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// 크기를 최소·최대 안으로. view: 앱 창 { width, height }(모르면 최대 없음). room: 창 왼쪽 위에서 앱 창 끝까지 남은 칸(있으면 그것도 최대).
export function clampSize(size, view = null, room = null) {
  const w0 = num(size?.w) ?? DEFAULT_SIZE.w, h0 = num(size?.h) ?? DEFAULT_SIZE.h;
  const cap = (v, min, share, left) => {
    let max = Infinity;
    if (num(share) && share > 0) max = Math.floor(share * MAX_SHARE);
    if (num(left) && left > 0) max = Math.min(max, Math.max(min, Math.floor(left)));   // 끝에 붙은 창도 최소 크기는 지킨다
    return Math.round(Math.min(Math.max(v, min), max));   // 앱 창이 최소보다 작으면 최대가 이긴다
  };
  return { w: cap(w0, MIN_W, view?.width, room?.width), h: cap(h0, MIN_H, view?.height, room?.height) };
}

// 모서리 끌기: 시작 크기 + 포인터가 움직인 만큼
export function dragSize(start, from, to, view = null, room = null) {
  return clampSize({ w: start.w + (to.x - from.x), h: start.h + (to.y - from.y) }, view, room);
}

// 프리셋의 실제 px
export function presetSize(p, view) {
  if (p !== "full") return p;
  return { w: Math.round((num(view?.width) ?? 1400) * FULL_SHARE), h: Math.round((num(view?.height) ?? 900) * FULL_SHARE) };
}

// 지금 크기 다음 프리셋: 지금보다 넓은 첫 프리셋, 이미 가장 넓으면 처음(작게)으로
//   room: clampSize와 같은 남은 칸. 목록도 같이 줄여야 줄어든 크기에서 멈추지 않고 "작게"로 돈다.
export function nextPreset(size, view, room = null) {
  const list = PRESETS.map((p) => clampSize(presetSize(p, view), view, room));
  const w = num(size?.w) ?? DEFAULT_SIZE.w;
  return list.find((s) => s.w > w + 8) ?? list[0];
}

// 배율 바꾸기: dir +1 키우기, -1 줄이기, 0 100%로
export function stepZoom(z, dir) {
  if (!dir) return 1;
  const cur = num(z) ?? 1;
  const next = Math.round((cur + dir * ZOOM_STEP) * 10) / 10;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
}

// 저장된 값 고르기: 쓸 수 있는 첫 값
export function pickSize(...cands) {
  for (const c of cands) if (num(c?.w) && num(c?.h)) return { w: c.w, h: c.h };
  return { ...DEFAULT_SIZE };
}
export function pickZoom(...cands) {
  for (const c of cands) if (num(c) && c >= ZOOM_MIN && c <= ZOOM_MAX) return Math.round(c * 10) / 10;
  return 1;
}
