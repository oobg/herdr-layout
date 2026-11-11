// 파일 앱의 뷰어: 확장자에 따라 알맞은 미리보기를 만든다. 추가 설치 없이 macOS 기본 도구와 Python 표준 라이브러리만 쓴다.
//   돌려주는 모양(kind):
//     code   { text, lang }            코드·텍스트·JSON(정렬)·압축 파일 목록·16진수 덤프
//     md     { blocks }                마크다운(markdown.js가 나눈 블록, 그림은 캐시에 복사한 경로·크기)
//     pages  { pages: [{path,w,h}], count, note? }   이미지·PDF 페이지·Quick Look 미리보기(세로로 이어 보기)
//     table  { sheets: [{name, rows, more}] }        CSV·TSV·엑셀
//     slides { slides: [{n, texts}], thumb? }        파워포인트
//     error  { message }
// 만든 미리보기는 data/office-apps/preview/<파일 경로·수정 시각 해시>/ 에 둔다(같은 파일은 다시 만들지 않는다).

import { exec, appHome, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { parseMarkdown } from "./markdown.js";

const ME = "mods/office-apps";
const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
const SIPS = new Set(["heic", "heif", "tif", "tiff", "psd", "jp2", "tga", "dng", "cr2", "nef", "arw", "raf", "exr", "hdr"]);
const QUICKLOOK = new Set(["key", "numbers", "pages", "ttf", "otf", "woff", "woff2", "ttc", "mp4", "mov", "m4v", "avi", "mkv", "webm",
  "usdz", "usd", "obj", "stl", "dae", "glb", "gltf", "ai", "eps", "sketch", "fig", "epub"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "aiff", "aif", "opus"]);
const TEXTUTIL = new Set(["docx", "doc", "rtf", "rtfd", "odt", "webarchive", "wordml"]);
const ZIP = new Set(["zip", "jar", "whl", "apk", "ipa", "xpi", "nupkg", "vsix"]);
const TAR = new Set(["tar", "tgz", "gz", "bz2", "xz", "tbz", "txz", "zst"]);
const MD = new Set(["md", "markdown", "mdx"]);
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", json5: "json",
  svelte: "html", vue: "html", htm: "html", yml: "yaml", sh: "bash", zsh: "bash", py: "python", rs: "rust", rb: "ruby", kt: "kotlin" };

function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h.toString(36); }

// 그림 크기(px): sips로 읽는다
async function dims(abs) {
  const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs]).catch(() => null);
  const w = Number(/pixelWidth: (\d+)/.exec(r?.stdout ?? "")?.[1] ?? 800), h = Number(/pixelHeight: (\d+)/.exec(r?.stdout ?? "")?.[1] ?? 600);
  return { w, h };
}

// Herdr의 fs/promises에는 stat·copyFile이 없어 셸 명령으로 한다.
const exists = async (p) => (await exec("test", ["-e", p]).catch(() => ({ code: 1 }))).code === 0;
const copy = (a, b) => exec("cp", ["-f", a, b]);

async function cacheDir(abs) {
  const m = await exec("stat", ["-f", "%m", abs]);
  const rel = `data/office-apps/preview/${hash(`${abs}|${m.stdout.trim()}`)}`;
  await fs.mkdir(`${appHome()}/${rel}`, { recursive: true });
  return rel;
}

// PDF 렌더러: 처음 쓸 때 Swift(PDFKit) 소스를 data/ 아래에 컴파일해 둔다. swiftc가 없으면 swift로 바로 실행.
async function pdfRenderer() {
  const bin = `${appHome()}/data/office-apps/bin/pdfpages`, src = `${appHome()}/${ME}/viewers/pdf.swift`;
  if (await exists(bin)) return [bin];
  await fs.mkdir(`${appHome()}/data/office-apps/bin`, { recursive: true });
  const r = await exec("xcrun", ["swiftc", "-O", src, "-o", bin], { timeout: 180000 }).catch(() => null);
  return r?.code === 0 ? [bin] : ["swift", src];
}

function parseCSV(text, sep) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length && rows.length < 1000; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export async function preview(abs, ext, on) {
  if (on) {
    // 원격 머신: 글로 읽을 수 있는 것만
    const text = await readTextFile(abs, { on });
    if (text === null) return { kind: "error", message: "파일이 더 이상 없습니다" };
    if (text.includes("\0")) return { kind: "error", message: "원격 머신의 바이너리 파일은 미리볼 수 없습니다" };
    if (MD.has(ext)) return { kind: "md", blocks: parseMarkdown(text.slice(0, 300000)) };
    return { kind: "code", text: text.slice(0, 400000), lang: LANG[ext] ?? ext };
  }

  if (IMG.has(ext)) {
    const dir = await cacheDir(abs), out = `${dir}/image.${ext}`;
    await copy(abs, `${appHome()}/${out}`);
    const d = ext === "svg" ? { w: 800, h: 800 } : await dims(abs);
    return { kind: "pages", pages: [{ path: out, ...d }], count: 1 };
  }
  if (SIPS.has(ext)) {
    const dir = await cacheDir(abs), out = `${dir}/image.png`;
    const r = await exec("sips", ["-s", "format", "png", abs, "--out", `${appHome()}/${out}`]);
    if (r.code !== 0) return { kind: "error", message: "이미지를 변환하지 못했습니다" };
    return { kind: "pages", pages: [{ path: out, ...(await dims(`${appHome()}/${out}`)) }], count: 1 };
  }
  if (ext === "pdf") {
    const dir = await cacheDir(abs), cmd = await pdfRenderer();
    const r = await exec(cmd[0], [...cmd.slice(1), abs, `${appHome()}/${dir}/pdf`, "1400", "40"], { timeout: 120000 });
    let j = null;
    try { j = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* 아래 */ }
    if (!j?.pages) return { kind: "error", message: "PDF를 렌더하지 못했습니다" };
    return { kind: "pages", count: j.count, pages: j.pages.map((p) => ({ path: `${dir}/pdf/${p.file}`, w: p.w, h: p.h })),
      note: j.count > j.pages.length ? `${j.count}쪽 중 앞 ${j.pages.length}쪽` : null };
  }
  if (ext === "csv" || ext === "tsv") {
    const text = await readTextFile(abs);
    const rows = parseCSV(text ?? "", ext === "tsv" ? "\t" : text?.split("\n")[0]?.includes(";") && !text.split("\n")[0].includes(",") ? ";" : ",");
    return { kind: "table", sheets: [{ name: ext.toUpperCase(), rows: rows.slice(0, 1000), more: rows.length >= 1000 }] };
  }
  if (ext === "xlsx" || ext === "xlsm") {
    const r = await exec("python3", ["-I", `${appHome()}/${ME}/viewers/office.py`, "xlsx", abs, "500", "60"], { timeout: 60000 });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 아래 */ }
    if (!j?.sheets) return { kind: "error", message: j?.error ?? "엑셀 파일을 읽지 못했습니다" };
    return { kind: "table", sheets: j.sheets };
  }
  if (ext === "pptx") {
    const r = await exec("python3", ["-I", `${appHome()}/${ME}/viewers/office.py`, "pptx", abs], { timeout: 60000 });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* 아래 */ }
    const thumb = await quicklook(abs);
    if (!j?.slides) return thumb ?? { kind: "error", message: "파워포인트 파일을 읽지 못했습니다" };
    return { kind: "slides", slides: j.slides, thumb: thumb?.pages?.[0] ?? null };
  }
  if (TEXTUTIL.has(ext)) {
    const r = await exec("textutil", ["-convert", "txt", "-stdout", abs], { timeout: 60000 });
    if (r.code !== 0) return (await quicklook(abs)) ?? { kind: "error", message: "문서를 읽지 못했습니다" };
    return { kind: "md", blocks: parseMarkdown(r.stdout.slice(0, 300000)) };
  }
  if (ZIP.has(ext)) {
    const r = await exec("unzip", ["-l", abs]);
    return { kind: "code", text: r.stdout.slice(0, 300000), lang: "text" };
  }
  if (TAR.has(ext)) {
    const r = await exec("tar", ["-tvf", abs], { timeout: 60000 });
    return { kind: "code", text: (r.stdout || r.stderr).slice(0, 300000), lang: "text" };
  }
  if (AUDIO.has(ext)) {
    const r = await exec("mdls", ["-name", "kMDItemDurationSeconds", "-name", "kMDItemAudioBitRate", "-name", "kMDItemAudioSampleRate",
      "-name", "kMDItemAudioChannelCount", "-name", "kMDItemTitle", "-name", "kMDItemAuthors", "-name", "kMDItemAlbum", abs]);
    const art = await quicklook(abs);
    return art ? { ...art, note: r.stdout.trim() } : { kind: "code", text: r.stdout, lang: "text" };
  }
  if (QUICKLOOK.has(ext)) return (await quicklook(abs)) ?? { kind: "error", message: "미리보기를 만들지 못했습니다" };

  // 그 밖: 글이면 편집기, 바이너리면 Quick Look → 안 되면 16진수 덤프
  const text = await readTextFile(abs);
  if (text === null) return { kind: "error", message: "파일이 더 이상 없습니다" };
  if (!text.includes("\0")) {
    if (MD.has(ext)) return { kind: "md", blocks: await mdImages(parseMarkdown(text.slice(0, 300000)), abs) };
    if ((ext === "json" || ext === "geojson") && text.length < 3000000) {
      try { return { kind: "code", text: JSON.stringify(JSON.parse(text), null, 2).slice(0, 400000), lang: "json" }; } catch { /* 원문 그대로 */ }
    }
    return { kind: "code", text: text.length > 400000 ? text.slice(0, 400000) + "\n… (잘림)" : text, lang: LANG[ext] ?? ext };
  }
  const ql = await quicklook(abs);
  if (ql) return ql;
  const x = await exec("xxd", ["-l", "8192", abs]);
  return { kind: "code", text: x.stdout, lang: "text", note: "바이너리 파일: 앞 8KB를 16진수로" };
}

// macOS 훑어보기(Quick Look) 미리보기 이미지. 대부분의 문서·글꼴·동영상·3D가 된다(첫 쪽·첫 장면).
async function quicklook(abs) {
  const dir = await cacheDir(abs);
  const r = await exec("qlmanage", ["-t", "-s", "1400", "-o", `${appHome()}/${dir}`, abs], { timeout: 60000 }).catch(() => null);
  const name = `${abs.split("/").pop()}.png`;
  if (!(await exists(`${appHome()}/${dir}/${name}`))) return null;
  if (r?.code !== 0 && r?.code != null) return null;
  return { kind: "pages", pages: [{ path: `${dir}/${name}`, ...(await dims(`${appHome()}/${dir}/${name}`)) }], count: 1, note: "macOS 훑어보기 미리보기" };
}

// 마크다운 그림: md 파일 폴더 기준 상대 경로·절대 경로·http(s) 주소를 캐시 폴더로 가져와 image()가 읽을 수 있게 한다.
const MAX_IMAGES = 40;
async function mdImages(blocks, abs) {
  const items = blocks.filter((b) => b.kind === "images").flatMap((b) => b.items).slice(0, MAX_IMAGES);
  if (!items.length) return blocks;
  const dir = await cacheDir(abs), base = abs.slice(0, abs.lastIndexOf("/")), saved = `${appHome()}/${dir}/md-images.json`;
  // 같은 파일(경로·수정 시각이 같으면 캐시 폴더도 같다)은 지난번 결과를 다시 쓴다: 원격 그림을 매번 받지 않게
  try {
    const prev = JSON.parse((await readTextFile(saved)) ?? "null");
    if (Array.isArray(prev) && prev.length === items.length && prev.every((p, i) => p.src === items[i].src)) {
      prev.forEach((p, i) => Object.assign(items[i], p));
      return blocks;
    }
  } catch { /* 새로 만든다 */ }
  await Promise.all(items.map(async (it, i) => {
    try {
      const src = it.src.trim();
      if (/^https?:\/\//i.test(src)) {
        const tmp = `${appHome()}/${dir}/md-${i}`;
        const r = await exec("curl", ["-sfL", "--max-time", "8", "-o", tmp, "-w", "%{content_type}", src], { timeout: 12000 }).catch(() => null);
        if (r?.code !== 0) return;
        const type = r.stdout.toLowerCase();
        const ext = type.includes("svg") ? "svg" : type.includes("png") ? "png" : type.includes("gif") ? "gif" : type.includes("webp") ? "webp" : type.includes("jpeg") ? "jpg"
          : (/\.(\w{3,4})(?:[?#]|$)/.exec(src)?.[1]?.toLowerCase() ?? "png");
        await exec("mv", ["-f", tmp, `${tmp}.${ext}`]);
        Object.assign(it, { path: `${dir}/md-${i}.${ext}`, ...(await size(`${tmp}.${ext}`, ext)) });
        return;
      }
      if (/^data:/i.test(src)) return;
      let p = decodeURIComponent(src.replace(/^file:\/\//i, "").replace(/[?#].*$/, ""));
      if (!p.startsWith("/")) p = normalize(`${base}/${p}`);
      if (!(await exists(p))) return;
      const ext = p.split(".").pop().toLowerCase(), out = `${dir}/md-${i}.${IMG.has(ext) ? ext : "png"}`;
      if (IMG.has(ext)) await copy(p, `${appHome()}/${out}`);
      else if ((await exec("sips", ["-s", "format", "png", p, "--out", `${appHome()}/${out}`])).code !== 0) return;
      Object.assign(it, { path: out, ...(await size(`${appHome()}/${out}`, ext)) });
    } catch { /* 못 가져온 그림은 대체 글로 */ }
  }));
  await fs.writeFile(saved, JSON.stringify(items)).catch(() => {});
  return blocks;
}

function normalize(p) {
  const out = [];
  for (const part of p.split("/")) { if (part === "..") out.pop(); else if (part && part !== ".") out.push(part); }
  return "/" + out.join("/");
}

// 그림 크기: SVG는 width·height 속성(없으면 viewBox), 나머지는 sips
async function size(file, ext) {
  if (ext !== "svg") return dims(file);
  const t = (await readTextFile(file)) ?? "";
  const head = /<svg\b[^>]*>/i.exec(t)?.[0] ?? "";
  const num = (n) => Number(new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(head)?.[1]) || 0;
  let w = num("width"), h = num("height");
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
  if ((!w || !h) && vb) { const vw = Number(vb[1]), vh = Number(vb[2]); if (w) h = w * vh / vw; else if (h) w = h * vw / vh; else { w = vw; h = vh; } }
  return { w: Math.round(w || 300), h: Math.round(h || 150) };
}
