// 이번 턴의 흐름(parse.js flow)을 시간 띠와 단계로 바꾼다. herdr를 부르지 않아 node로도 시험할 수 있다.
//   단계 묶기 규칙은 오른쪽 패널(office 모드)과 같다:
//     종류 → 단계: 읽음·검색·찾기·웹·스킬 → 살펴보기, 수정·작성 → 고치기, 실행 → 실행, 서브에이전트 → 맡기기, 그 밖 → 기타.
//     같은 단계가 이어지면 하나로 합친다. 항목 사이가 3분 이상 비면 그 자리에 "쉼" 단계.
//   테두리 칸(rest)은 도구를 돌리지 않고 기다리는 시간이다(사무실 왼쪽 패널 office/parse.js band와 같은 판정). 그때 앞 칸은 end에서 끊는다:
//     1) 쉼: 다음 묶음 시작까지 비는 시간(end → 다음 from)이 3분 이상
//     2) 백그라운드 기다림: 묶음의 마지막 호출을 백그라운드로 띄웠으면(bg) end(띄운 결과 시각) → 다음 from(마지막이면 now/lastAt), 길이 무관
//     3) 결과 뒤 기다림: 마지막 묶음이고 작업 중인데 그 묶음에 결과를 기다리는 호출(fg)이 없으면 end → now, 길이 무관
//   2·3은 "기다림"(wait), 1은 "쉼". 단계 목록에서 기다림은 끝에 붙은 것과 3분 이상인 것만 단계로 보인다(짧은 중간 기다림은 띠에만).

export const REST_MS = 180000;   // 이만큼 비면 쉼
const PHASE = { 읽음: "살펴보기", 검색: "살펴보기", 찾기: "살펴보기", 웹: "살펴보기", 스킬: "살펴보기",
  수정: "고치기", 작성: "고치기", 실행: "실행", 서브에이전트: "맡기기" };
export const phaseOf = (kind) => PHASE[kind] ?? "기타";

const base = (p) => String(p).split("/").pop();

// 흐름 항목마다 시작(from)·끝(to)·걸린 시간(ms)·뒤에 붙는 테두리 칸(rest, 없으면 0)·그게 기다림인지(wait)를 붙인다.
//   끝은 다음 항목의 시작. 마지막 항목은 작업 중이면 now, 아니면 lastAt. 위 1~3이면 end에서 끊고 나머지를 rest로.
//   running: 지금 도는 칸(작업 중이고 마지막 항목에 fg가 있을 때만). fg가 없는 옛 형식은 running으로 대신.
export function spans(flow, { working = false, now = Date.now(), lastAt = 0 } = {}) {
  return flow.map((f, i) => {
    const next = flow[i + 1], from = f.from ?? f.at, end = Math.max(f.at ?? 0, f.end ?? 0);
    const fg = f.fg ?? f.running;
    const tail = next ? next.from ?? next.at : working ? now : Math.max(lastAt, end);
    const wait = next ? Boolean(f.bg) : working ? !fg : Boolean(f.bg);
    const cut = wait || (next && (next.from ?? next.at) - end >= REST_MS);
    const to = cut ? Math.min(end, tail) : tail;
    const rest = cut ? Math.max(0, tail - end) : 0;
    return { ...f, from, to, ms: Math.max(0, to - from), rest, wait: Boolean(rest && wait), running: Boolean(working && !next && fg) };
  });
}

// 시간 띠의 칸: 흐름 항목마다 한 칸(ms 비례), 쉼이면 그 뒤에 쉼 칸.
//   칸이 max보다 많으면(칸마다 최소 너비·간격이 있어 띠가 넘친다) 이웃한 두 칸 중 합이 가장 짧은 쌍을 하나로 합친다.
//   쉼 칸과 도는 칸은 합치지 않는다. 합친 칸의 색은 더 긴 쪽 종류.
export function band(sp, max = 60) {
  const cells = [];
  for (const s of sp) {
    cells.push({ kind: s.kind, ms: s.ms, running: s.running });
    if (s.rest) cells.push({ rest: true, wait: s.wait, ms: s.rest });
  }
  const fixed = (c) => c.rest || c.running;
  while (cells.length > max) {
    let best = -1;
    for (let i = 0; i + 1 < cells.length; i++) {
      if (fixed(cells[i]) || fixed(cells[i + 1])) continue;
      if (best < 0 || cells[i].ms + cells[i + 1].ms < cells[best].ms + cells[best + 1].ms) best = i;
    }
    if (best < 0) break;
    const a = cells[best], b = cells[best + 1];
    cells.splice(best, 2, { kind: a.ms >= b.ms ? a.kind : b.kind, ms: a.ms + b.ms, running: false });
  }
  const last = sp[sp.length - 1];
  return { cells, from: sp[0]?.from ?? 0, to: last ? last.to + (last.rest || 0) : 0 };
}

// 단계: { name, rest?, items(spans), from, to, ms, current, summary }
//   쉼·기다림 단계는 rest: true(기다림은 wait: true도). 짧은 중간 기다림은 단계로 떼지 않는다(띠에만).
export function phases(sp, { working = false } = {}) {
  const out = [];
  sp.forEach((s, i) => {
    const name = phaseOf(s.kind), last = out[out.length - 1];
    if (last && !last.rest && last.name === name) { last.items.push(s); last.to = s.to; last.ms += s.ms; }
    else out.push({ name, items: [s], from: s.from, to: s.to, ms: s.ms });
    if (s.rest && (!s.wait || i === sp.length - 1 || s.rest >= REST_MS))
      out.push({ name: s.wait ? "기다림" : "쉼", rest: true, wait: s.wait, items: [], from: s.to, to: s.to + s.rest, ms: s.rest });
  });
  // current: 지금 단계(끝에 붙은 기다림이면 그것, "…째"를 단다). live: 작업 중일 때 마지막 일 단계(기본으로 펼친다:
  //   도구 사이 기다림이 생길 때마다 접혔다 펼쳤다 하지 않게)
  const live = working ? out.findLastIndex((p) => !p.rest) : -1;
  out.forEach((p, i) => { p.current = working && i === out.length - 1; p.live = i === live; p.summary = summary(p); });
  return out;
}

// 단계 요약 한 줄
export function summary(p) {
  if (p.wait) return "";   // 머리 줄이 "기다림 · n분"
  if (p.rest) return `${Math.floor(p.ms / 60000)}분 쉼`;
  const sum = (k) => p.items.filter((x) => !k || k.includes(x.kind)).reduce((a, x) => a + x.n, 0);
  if (p.name === "고치기") {
    const files = [...new Set(p.items.flatMap((x) => x.targets ?? (x.target ? [x.target] : [])))];
    const head = files.length ? `${base(files[0])}${files.length > 1 ? ` 외 ${files.length - 1}개` : ""} · ` : "";
    return `${head}수정 ${sum()}번`;
  }
  if (p.name === "실행") return p.items[0].targets?.[0] ?? p.items[0].target ?? "";
  if (p.name === "맡기기") return `서브에이전트 ${sum()}`;
  // 살펴보기·기타: 종류별 개수(처음 나온 순서)
  const n = new Map();
  for (const x of p.items) n.set(x.kind, (n.get(x.kind) ?? 0) + x.n);
  return [...n].map(([k, c]) => `${k} ${c}`).join(" · ");
}

// 걸린 시간: 59초 · 3분 10초 · 1시간 5분
export function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

// 시각 HH:MM(이 기기 시간대)
export function clock(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
