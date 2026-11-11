"""엑셀(xlsx)·파워포인트(pptx)를 표준 라이브러리만으로 읽어 JSON으로 출력한다.

  python3 office.py xlsx <파일> [최대 행] [최대 열]  → {"sheets": [{"name": ..., "rows": [[...], ...], "more": bool}]}
  python3 office.py pptx <파일>                     → {"slides": [{"n": 1, "texts": ["제목", "본문", ...]}]}
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


def col_index(ref):
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def xlsx(path, max_rows=500, max_cols=50):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    sheets = []
    for sh in wb.find("m:sheets", NS):
        rid = sh.get(f"{{{NS['r']}}}id")
        t = target.get(rid, "")
        p = "xl/" + t.lstrip("/").replace("xl/", "") if not t.startswith("/xl/") else t[1:]
        if p not in z.namelist():
            continue
        rows, more = [], False
        for row in ET.fromstring(z.read(p)).iter(f"{{{NS['m']}}}row"):
            if len(rows) >= max_rows:
                more = True
                break
            cells = {}
            for c in row.findall("m:c", NS):
                ref, kind = c.get("r", "A1"), c.get("t")
                v = c.find("m:v", NS)
                if kind == "s" and v is not None:
                    val = shared[int(v.text)]
                elif kind == "inlineStr":
                    val = "".join(t.text or "" for t in c.iter(f"{{{NS['m']}}}t"))
                else:
                    val = v.text if v is not None else ""
                i = col_index(ref)
                if i < max_cols:
                    cells[i] = val
            width = max(cells) + 1 if cells else 0
            rows.append([cells.get(i, "") for i in range(width)])
        sheets.append({"name": sh.get("name"), "rows": rows, "more": more})
    return {"sheets": sheets}


def pptx(path):
    z = zipfile.ZipFile(path)
    names = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=lambda n: int(re.search(r"(\d+)", n.rsplit("/", 1)[1]).group(1)))
    slides = []
    for i, n in enumerate(names, 1):
        root = ET.fromstring(z.read(n))
        texts = []
        for para in root.iter(f"{{{NS['a']}}}p"):
            line = "".join(t.text or "" for t in para.iter(f"{{{NS['a']}}}t")).strip()
            if line:
                texts.append(line)
        slides.append({"n": i, "texts": texts})
    return {"slides": slides}


if __name__ == "__main__":
    kind, path = sys.argv[1], sys.argv[2]
    try:
        out = xlsx(path, *(int(x) for x in sys.argv[3:5])) if kind == "xlsx" else pptx(path)
    except Exception as e:
        out = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(out, ensure_ascii=False))
