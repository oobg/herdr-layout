// 런처 즐겨찾기 순수 함수. herdr를 import하지 않아 node로 시험할 수 있다.
//   즐겨찾기는 순서 있는 앱 id 배열(localStorage "launcher.favorites"). 저장·읽기는 main.js가 한다.

// 저장된 값 → 깨끗한 id 배열(문자열만, 중복은 앞의 것만 남김)
export function cleanFavs(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const id of v) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  return out;
}

// 있으면 빼고, 없으면 맨 뒤에 더한다
export function toggleFav(favs, id) {
  return favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
}

// 보이는 즐겨찾기(visible: 그릴 수 있는 id들) 사이에서 id를 한 칸 앞(-1)/뒤(+1)로.
//   꺼진 앱·없는 id는 그 자리에 그대로 두고 건너뛴다(다시 켜면 원래 자리로 돌아온다).
export function moveFav(favs, id, d, visible = favs) {
  const vis = favs.filter((x) => visible.includes(x));
  const i = vis.indexOf(id), j = i + d;
  if (i < 0 || j < 0 || j >= vis.length) return favs;
  const other = vis[j];
  return favs.map((x) => (x === id ? other : x === other ? id : x));
}

// 그릴 즐겨찾기 줄: 즐겨찾기 순서대로, apps(켜진 앱만 넘긴다)에 있는 것만
export function favRow(favs, apps) {
  const by = new Map(apps.map((a) => [a.id, a]));
  return favs.map((id) => by.get(id)).filter(Boolean);
}

// 격자 순서(↑↓·Enter와 그리기가 같이 쓴다): 즐겨찾기 줄(검색 중이 아니고 있을 때만) → GROUPS 순서의 줄들.
//   apps는 이미 끈 앱·검색어로 거른 목록. 즐겨찾기 앱은 자기 줄에도 그대로 남는다(같은 앱이 두 번 나올 수 있다).
//   → [{ id, title, fav, apps }]
export function homeRows({ apps, groups, favs, query }) {
  const rows = [];
  const fav = query ? [] : favRow(favs, apps);
  if (fav.length) rows.push({ id: "favorites", title: "즐겨찾기", fav: true, apps: fav });
  for (const g of groups) {
    const list = apps.filter((a) => a.group === g.id);
    if (list.length) rows.push({ ...g, fav: false, apps: list });
  }
  return rows;
}

// 격자 한 줄에 들어가는 칸 수: 줄 폭(width, 안쪽 여백 뺀 값) · 칸 폭(cell) · 칸 사이(gap). 폭을 모르면 null.
export function gridCols(width, cell = 92, gap = 18) {
  if (!(typeof width === "number" && width > 0)) return null;
  return Math.max(1, Math.floor((width + gap) / (cell + gap)));
}

// 격자 ↑(-1)↓(+1): 보이는 줄 단위로 옮긴다. lens = 묶음(즐겨찾기·앱·에이전트·설정)마다 칸 수,
//   cols = 한 줄 칸 수(null이면 예전처럼 순번 ±1). 묶음마다 flex_wrap이라 줄은 묶음 안에서 cols개씩 끊긴다.
//   같은 열로 가되 그 줄이 짧으면 마지막 칸. 맨 위·맨 아래에서는 멈춘다.
export function gridStep(lens, cols, sel, d) {
  const total = lens.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  if (!cols) return Math.max(0, Math.min(total - 1, sel + d));
  const lines = [];   // [시작 순번, 칸 수]
  let start = 0;
  for (const n of lens) {
    for (let i = 0; i < n; i += cols) lines.push([start + i, Math.min(cols, n - i)]);
    start += n;
  }
  const L = Math.max(0, lines.findIndex(([s, n]) => sel >= s && sel < s + n));
  const col = sel - lines[L][0], T = L + d;
  if (T < 0 || T >= lines.length) return sel;
  const [s, n] = lines[T];
  return s + Math.min(col, n - 1);
}

// 격자 ←(-1)→(+1): 읽는 순서대로 한 칸(줄 끝에서 다음 줄 첫 칸으로), 처음·끝에서는 멈춘다. 검색창이 비었을 때만 쓴다.
export function gridSide(total, sel, d) {
  if (!total) return 0;
  return Math.max(0, Math.min(total - 1, sel + d));
}
