// 앱 화면 키 계약의 순수 부분(herdr·gpui를 import하지 않아 node로 시험한다). 런처(main.js)가 쓴다.
//   포커스 고리: [왼쪽 목록, ...상세의 멈출 곳(stop) 순서]. Tab = 다음, Shift+Tab = 앞, 끝에서 감는다.
//   멈출 곳은 앱의 focusables()가 그때그때 돌려주는 [{ id, kind: "button"|"check"|"input", ... }] 순서(화면 위→아래, 왼→오른).
//   at = 지금 멈춘 곳의 id(null이면 왼쪽 목록). 그 id가 목록에서 사라졌으면 마지막으로 있던 자리(last)로 이어 간다.

// 다음 멈출 곳의 id. null이면 왼쪽 목록. 멈출 곳이 하나도 없으면 늘 null.
export function step(ids, at, dir, last = 0) {
  const n = ids.length;
  if (!n) return null;
  let i = at == null ? -1 : ids.indexOf(at);
  // 사라진 곳: 그 자리로 밀려 들어온 것이 "다음", 그 앞 것이 "앞"
  if (at != null && i < 0) { const k = Math.max(0, Math.min(last, n)); i = dir > 0 ? k - 1 : k; }
  const m = n + 1, j = ((i + 1 + dir) % m + m) % m - 1;
  return j < 0 ? null : ids[j];
}

const plain = (m) => !m.shift && !m.alt && !m.control && !m.platform;
const isSpace = (e) => e.key === "space" || e.key_char === " ";

// 상세 칸(멈출 곳 하나에 커서가 있음)에서 받은 키 → 할 일.
//   next·prev(Tab·Shift+Tab) · left(Esc: 왼쪽 목록으로) · press(Enter·Space: 버튼 누르기·체크 토글)
//   · submit(⌘Enter: 상세의 입력칸 내용 보내기/저장) · up·down(↑↓: 왼쪽 목록 이동, 상세에서도 그대로) · null(건드리지 않음)
export function detailKey(e) {
  const m = e.modifiers ?? {};
  if (e.key === "tab" && !m.alt && !m.control && !m.platform) return m.shift ? "prev" : "next";
  if (e.key === "enter" && m.platform && !m.shift && !m.alt && !m.control) return "submit";
  if (!plain(m)) return null;
  if (e.key === "escape") return "left";
  if (e.key === "enter" || isSpace(e)) return "press";
  if (e.key === "up" || e.key === "down") return e.key;
  return null;
}

// 입력칸 안에서 올라온 키: 글자·화살표·Enter는 입력칸 몫이라 건드리지 않고 Tab·Shift+Tab·Esc만.
//   ⌘Enter는 여기서 받지 않는다: 입력칸의 submit 이벤트(secondary)로 앱이 직접 받는다(한 길만 두어 두 번 보내지 않게).
export function inputKey(e) {
  const m = e.modifiers ?? {};
  if (e.key === "tab" && !m.alt && !m.control && !m.platform) return m.shift ? "prev" : "next";
  if (e.key === "escape" && plain(m)) return "left";
  return null;
}

// 왼쪽 목록에서 받은 Tab: 첫 멈출 곳(Shift면 마지막)으로. 그 밖은 null.
export function listKey(e) {
  const m = e.modifiers ?? {};
  if (e.key !== "tab" || m.alt || m.control || m.platform) return null;
  return m.shift ? "prev" : "next";
}
