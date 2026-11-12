// 세션 앱 범위 규칙 확인: node office/mods/office-apps/sessions/test.mjs
import assert from "node:assert/strict";
import { scopeGlobs, inRoots, parseWorktrees, parseListing, slug } from "./list.js";

const R = "/Users/me/repo", W = "/Users/me/wt/repo-feature";
assert.deepEqual(scopeGlobs("here", R), ["-Users-me-repo"]);
assert.deepEqual(scopeGlobs("repo", R, [R, W]), ["-Users-me-repo", "-Users-me-repo-*", "-Users-me-wt-repo-feature", "-Users-me-wt-repo-feature-*"]);
assert.deepEqual(scopeGlobs("repo", R, []), ["-Users-me-repo", "-Users-me-repo-*"]);   // git이 아니면 이 폴더와 하위
assert.deepEqual(scopeGlobs("all", null), ["*"]);

// "슬러그-*"는 이웃 폴더(repo-other)도 잡는다: 기록의 cwd로 거른다
assert.equal(inRoots(`${R}/sub`, [R, W]), true);
assert.equal(inRoots(W, [R, W]), true);
assert.equal(inRoots("/Users/me/repo-other", [R, W]), false);
assert.equal(inRoots(null, [R]), true);   // cwd를 모르면 둔다

assert.deepEqual(parseWorktrees(`worktree ${R}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${W}\nHEAD def\ndetached\n`), [R, W]);

// 목록 줄의 다섯째 칸 = 기록 폴더 이름
const out = `@@T 2\n@@F aaaa 1700000000 10 1690000000 ${slug(W)}\n{"type":"user","cwd":"${W}","timestamp":"2026-11-12T00:00:00Z","message":{"content":"고쳐 줘"}}\n@@F bbbb 1600000000 5 0 ${slug(R)}\n`;
const { total, files } = parseListing(out);
assert.equal(total, 2);
assert.deepEqual(files.map((f) => [f.id, f.dir, f.cwd ?? null]), [["aaaa", slug(W), W], ["bbbb", slug(R), null]]);
assert.equal(files[0].ask, "고쳐 줘");

console.log("sessions/list ok");
