// 메모 앱 순수 함수 확인: node office/mods/office-apps/notes/test.mjs [마크다운 파일] [레포 루트...]
//   파일을 쓰지 않는다(데이터 폴더에 시험 메모가 생기지 않게).
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  hash, noteId, notePath, rootName, parseFile, serialize, parseTodos, openCount, split, join, toggleLine, toggleTodo,
  todoLine, addTodo, clearDone, payload, ago, order,
} from "./model.js";

const HOME = "/Users/someone";

// 파일 이름: 같은 루트라도 기기가 다르면 다른 파일, 원격은 기기 폴더 아래
const a = notePath({ root: "/Users/someone/proj", machine: null });
const b = notePath({ root: "/Users/someone/proj", machine: "vps" });
const c = notePath({ root: "/Users/someone/proj-wt", machine: null });
assert.match(a, /^data\/office-apps\/notes\/[0-9a-z]+\.md$/);
assert.match(b, /^data\/office-apps\/notes\/vps\/[0-9a-z]+\.md$/);
assert.notEqual(a.split("/").pop(), b.split("/").pop());
assert.notEqual(a, c);
assert.equal(a, notePath({ root: "/Users/someone/proj", machine: null }));   // 늘 같은 이름
assert.equal(notePath({ root: "/x", machine: "../evil box" }).split("/").length, 5);  // 기기 이름이 경로를 깨지 않는다
assert.equal(noteId({ root: "/r", machine: null }), "|/r");
assert.equal(rootName("/Users/someone/proj/", HOME), "proj");
assert.equal(rootName(HOME, HOME), "홈");
assert.equal(rootName("/home/ubuntu", HOME), "홈");
assert.equal(rootName("~", HOME), "홈");

// 머리줄: 쓰고 읽으면 그대로, "-->"가 이름에 있어도 주석이 끝나지 않는다
const meta = { root: "/Users/someone/proj", machine: null, name: "a --> b", updated: 1 };
const file = serialize(meta, "본문\n");
assert.equal(file.split("\n")[0].match(/-->/g).length, 1);
assert.deepEqual(parseFile(file), { meta, body: "본문\n" });
assert.deepEqual(parseFile("머리줄 없음"), { meta: null, body: "머리줄 없음" });
assert.equal(parseFile(null).body, "");
assert.equal(parseFile(serialize(meta, "a\r\nb")).body, "a\nb");   // CRLF

// 할 일 파싱: [X]·들여쓰기·*·+ 글머리, 코드 블록 안은 빼고, CRLF
const md = "# 제목\r\n- [ ] 하나\r\n  - [X] 둘\r\n* [ ] 셋\r\n+ [x] 넷\r\n```\r\n- [ ] 코드 안\r\n```\r\n- [] 아님\r\n-[ ] 아님\r\n- [ ]\r\n본문";
const td = parseTodos(md);
assert.deepEqual(td.map((x) => [x.line, x.done, x.text]), [[1, false, "하나"], [2, true, "둘"], [3, false, "셋"], [4, true, "넷"], [10, false, ""]]);
assert.equal(openCount(md), 3);

// 토글: 같은 줄만, 두 번 하면 제자리
assert.equal(toggleLine("  - [X] 둘"), "  - [ ] 둘");
assert.equal(toggleLine("- [ ] 하나"), "- [x] 하나");
assert.equal(toggleLine("그냥 줄"), "그냥 줄");
const md2 = md.replace(/\r\n/g, "\n");
assert.equal(toggleTodo(toggleTodo(md2, 1), 1), md2);
assert.equal(toggleTodo(md2, 99), md2);

// 나누기·합치기: 할 일을 앞으로 모으고 메모는 나머지
const s = split("메모 위\n\n- [ ] a\n\n\n\n중간\n- [x] b\n");
assert.deepEqual(s, { todos: ["- [ ] a", "- [x] b"], memo: "메모 위\n\n중간" });
assert.equal(join(s.todos, s.memo), "- [ ] a\n- [x] b\n\n메모 위\n\n중간\n");
assert.deepEqual(split(join(s.todos, s.memo)), s);     // 다시 나눠도 같다(저장된 것과 비교할 때 쓴다)
assert.equal(join([], ""), "");
assert.equal(join([], "m"), "m\n");

// 할 일 추가: 앞의 글머리·체크 칸은 떼고, 빈 글은 무시
assert.equal(todoLine("  - [ ] 고치기 "), "- [ ] 고치기");
assert.equal(todoLine("[x] 이미"), "- [ ] 이미");
assert.equal(todoLine("   "), null);
assert.equal(addTodo("메모만\n", "새 일"), "- [ ] 새 일\n\n메모만\n");
assert.equal(addTodo("- [ ] a\n\n메모\n", "b"), "- [ ] a\n- [ ] b\n\n메모\n");
assert.equal(clearDone("- [ ] a\n- [x] b\n\n메모\n"), "- [ ] a\n\n메모\n");

// 보낼 글: 첫 줄은 대시로 시작하지 않는다
const p1 = payload("- [ ] a\n- [x] b\n\n메모\n", "proj", "todo");
assert.equal(p1, "proj 작업 공간의 남은 할 일:\n- [ ] a");
assert.ok(!payload("- [ ] a\n", "proj", "all").startsWith("-"));
assert.equal(payload("- [x] b\n", "proj", "todo"), null);
assert.equal(payload("  \n", "proj", "all"), null);

// 시각, 순서
const now = Date.UTC(2026, 10, 12, 3, 0);
assert.equal(ago(now - 30000, now), "방금");
assert.equal(ago(now - 5 * 60000, now), "5분 전");
assert.equal(ago(now - 26 * 3600000, now), "어제");
assert.equal(ago(0, now), "");
assert.deepEqual(order([{ id: "x", updated: 5 }, { id: "h", updated: 1 }, { id: "y", updated: 9 }], "h").map((n) => n.id), ["h", "y", "x"]);
assert.notEqual(hash("/a/b"), hash("/a/c")); assert.notEqual(hash("/w/proj-Aa"), hash("/w/proj-BB"));   // 31 곱하기 식만으로는 겹치는 쌍 assert.ok(hash("/Users/someone/proj").length >= 10);

// 실제 마크다운(인수: .handoff.md 등)과 실제 루트(hc ls의 cwd)
for (const f of process.argv.slice(2).filter((x) => x.endsWith(".md"))) {
  const body = readFileSync(f, "utf8");
  const t = parseTodos(body), sp = split(body);
  assert.deepEqual(split(join(sp.todos, sp.memo)), sp);
  console.log(`${f}: 줄 ${body.split("\n").length}, 할 일 ${t.length}(남음 ${openCount(body)}), 메모 ${sp.memo.length}자`);
  console.log("  할 일만 보내기:", JSON.stringify(payload(body, "herdr-layout", "todo")));
  console.log("  전체 보내기 첫 줄:", JSON.stringify(payload(body, "herdr-layout", "all").split("\n")[0]));
}
for (const r of process.argv.slice(2).filter((x) => !x.endsWith(".md"))) {
  console.log(`${r} → ${rootName(r, process.env.HOME)} · ${notePath({ root: r, machine: null })}`);
}
console.log("ok");
