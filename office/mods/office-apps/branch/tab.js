// git 동작 탭 재사용(순수 함수, herdr를 import하지 않아 node로 시험한다). menu.js inTab이 쓴다(브랜치 앱도 그것을 부른다).
//   같은 이름의 탭이 지금 스페이스에 이미 있고, 그 탭에 칸이 하나뿐이며 그 칸이 셸만 남은(상태 없음) 터미널이면
//   새 탭을 만들지 않고 그 셸에 명령 한 줄을 보낸다(hc send). 명령이 아직 돌고 있으면(셸이 아니면) 새 탭.

// 셸 한 낱말로: 작은따옴표로 감싸고 안의 ' 는 '\'' 로.
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// 보낼 한 줄: cd <폴더> && <argv>. 줄바꿈·제어 문자가 섞이면 한 줄로 못 보내니 null(새 탭으로).
export function sendLine(argv, folder) {
  const parts = [...(argv ?? [])].map(String);
  if (!parts.length) return null;
  const bad = (x) => /[\u0000-\u001f\u007f]/.test(x);
  if (parts.some(bad) || (folder != null && bad(String(folder)))) return null;
  const run = parts.map(shellQuote).join(" ");
  return folder ? `cd ${shellQuote(folder)} && ${run}` : run;
}

// 다시 쓸 탭: { tab, terminal } 또는 null. spaces·panes는 herdr의 spaces()·panes() 값.
export function reusableTab(spaces, panes, name) {
  const s = (spaces ?? []).find((x) => x.active);
  const tab = s?.tabs?.find((x) => x.named && x.name === name);
  if (!tab) return null;
  const ps = (panes ?? []).filter((p) => p.tab === tab.id);
  if (ps.length !== 1) return null;
  const p = ps[0];
  if (!p.terminal || !p.program?.shell || p.status) return null;
  return { tab: tab.id, terminal: p.terminal };
}
