#!/bin/sh
# office 레이아웃과 모드를 Herdr 폴더에 복사한다. 내용이 바뀐 파일만 쓴다.
# (Herdr는 모드 폴더의 파일이 저장될 때마다 그 모드를 다시 불러온다. 바뀌지 않은 파일까지
#  다시 쓰면 재로드가 쌓여 JS 런타임이 메모리 부족이 될 수 있다.)
# -t(수정 시각 보존)가 없으면 내용이 같아도 매번 시각만 갱신(.f..T....)돼 Herdr가 변경으로 보고 다시 불러온다. --checksum은 내용 기준 비교용.
set -e
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
SRC="$(cd "$(dirname "$0")" && pwd)/office"
rsync -rlpt --checksum "$SRC/layouts/" "$HOME_DIR/layouts/"
for m in "$SRC"/mods/*/; do
  name=$(basename "$m")
  mkdir -p "$HOME_DIR/mods/$name"
  rsync -rlpt --checksum --itemize-changes --exclude gpui-kit.d.ts --exclude jsconfig.json "$m" "$HOME_DIR/mods/$name/" | sed "s|^|$name: |"
done
echo "installed to $HOME_DIR"
