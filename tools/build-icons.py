#!/usr/bin/env python3
"""Material Icon Theme(npm material-icon-theme) 패키지에서 office-apps 아이콘을 만든다.

사용법:
  npm pack material-icon-theme && tar -xzf material-icon-theme-*.tgz
  python3 tools/build-icons.py package
결과: office/mods/office-apps/icons/*.svg, icons.json(이름 → 아이콘 표), LICENSE-material-icon-theme
"""
import json
import os
import shutil
import sys

pkg = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), "..", "office", "mods", "office-apps")
icons_out = os.path.join(out, "icons")
shutil.rmtree(icons_out, ignore_errors=True)
os.makedirs(icons_out)

m = json.load(open(os.path.join(pkg, "dist", "material-icons.json")))
defs = {k: os.path.basename(v["iconPath"]).removesuffix(".svg") for k, v in m["iconDefinitions"].items()}

def pick(d):
    return {k: defs[v] for k, v in (d or {}).items() if v in defs}

table = {
    "file": defs[m["file"]],
    "folder": defs[m["folder"]],
    "folderExpanded": defs[m["folderExpanded"]],
    "fileExtensions": pick(m["fileExtensions"]),
    "fileNames": pick(m["fileNames"]),
    "folderNames": pick(m["folderNames"]),
    "folderNamesExpanded": pick(m["folderNamesExpanded"]),
    "languageIds": pick(m["languageIds"]),
    "light": {k: pick(m["light"].get(k)) for k in ("fileExtensions", "fileNames", "folderNames", "folderNamesExpanded", "languageIds")},
}
used = {table["file"], table["folder"], table["folderExpanded"]}
for k in ("fileExtensions", "fileNames", "folderNames", "folderNamesExpanded", "languageIds"):
    used |= set(table[k].values()) | set(table["light"][k].values())
for name in sorted(used):
    src = os.path.join(pkg, "icons", name + ".svg")
    if os.path.exists(src):
        shutil.copy(src, os.path.join(icons_out, name + ".svg"))
json.dump(table, open(os.path.join(out, "icons.json"), "w"), separators=(",", ":"))
shutil.copy(os.path.join(pkg, "LICENSE"), os.path.join(out, "LICENSE-material-icon-theme"))
print(f"{len(os.listdir(icons_out))} icons")
