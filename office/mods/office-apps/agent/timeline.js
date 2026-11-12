// 이번 턴의 흐름(parse.js flow)을 시간 띠와 단계로 바꾼다. herdr를 부르지 않아 node로도 시험할 수 있다.
//   단계 묶기 규칙은 오른쪽 패널(office 모드)과 같다:
//     종류 → 단계: 읽음·검색·찾기·웹·스킬 → 살펴보기, 수정·작성 → 고치기, 실행 → 실행, 서브에이전트 → 맡기기, 그 밖 → 기타.
//     같은 단계가 이어지면 하나로 합친다. 항목 사이가 3분 이상 비면 그 자리에 "쉼" 단계.

export const REST_MS = 180000;   // 이만큼 비면 쉼
const PHASE = { 읽음: "살펴보기", 검색: "살펴보기", 찾기: "살펴보기", 웹: "살펴보기", 스킬: "살펴보기",
  수정: "고치기", 작성: "고치기", 실행: "실행", 서브에이전트: "맡기기" };
export const phaseOf = (kind) => PHASE[kind] ?? "기타";

const base = (p) => String(p).split("/").pop();

// 흐름 항목마다 시작(from)·끝(to)·걸린 시간(ms)·뒤에 이어지는 쉼(rest, 없으면 0)을 붙인다.
//   끝은 다음 항목의 시작. 마지막 항목은 작업 중이면 now, 아니면 lastAt.
//   다음 항목까지 비는 시간(이 항목의 마지막 결과 → 다음 시작)이 REST_MS 이상이면 끝을 마지막 결과로 당기고 그 사이를 쉼으로 뗀다.
export function spans(flow, { working = false, now = Date.now(), lastAt = 0 } = {}) {
  return flow.map((f, i) => {
    const next = flow[i + 1], from = f.from ?? f.at;
    const stop = next ? next.from ?? next.at : working ? now : Math.max(lastAt, f.end ?? f.at);
    const done = f.running ? stop : Math.max(f.end ?? f.at, f.at);
    const gap = next ? stop - done : 0;
    const rest = gap >= REST_MS ? gap : 0;
    const to = rest ? done : stop;
    return { ...f, from, to, ms: Math.max(0, to - from), rest, running: Boolean(f.running && working) };
  });
}

// 시간 띠의 칸: 흐름 항목마다 한 칸(ms 비례), 쉼이면 그 뒤에 쉼 칸.
//   칸이 max보다 많으면(칸마다 최소 너비·간격이 있어 띠가 넘친다) 이웃한 두 칸 중 합이 가장 짧은 쌍을 하나로 합친다.
//   쉼 칸과 도는 칸은 합치지 않는다. 합친 칸의 색은 더 긴 쪽 종류.
export function band(sp, max = 60) {
  const cells = [];
  for (const s of sp) {
    cells.push({ kind: s.kind, ms: s.ms, running: s.running });
    if (s.rest) cells.push({ rest: true, ms: s.rest });
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
  return { cells, from: sp[0]?.from ?? 0, to: sp[sp.length - 1]?.to ?? 0 };
}

// 단계: { name, rest?, items(spans), from, to, ms, current, summary }
//   current: 작업 중일 때 마지막 단계(지금 단계).
export function phases(sp, { working = false } = {}) {
  const out = [];
  for (const s of sp) {
    const name = phaseOf(s.kind), last = out[out.length - 1];
    if (last && !last.rest && last.name === name) { last.items.push(s); last.to = s.to; last.ms += s.ms; }
    else out.push({ name, items: [s], from: s.from, to: s.to, ms: s.ms });
    if (s.rest) out.push({ name: "쉼", rest: true, items: [], from: s.to, to: s.to + s.rest, ms: s.rest });
  }
  out.forEach((p, i) => { p.current = working && i === out.length - 1; p.summary = summary(p); });
  return out;
}

// 단계 요약 한 줄
export function summary(p) {
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
