#!/bin/sh
# office 레이아웃과 모드를 Herdr 폴더에 복사한다. 이미 있으면 덮어쓴다.
set -e
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
SRC="$(cd "$(dirname "$0")" && pwd)/office"
cp "$SRC"/layouts/* "$HOME_DIR/layouts/"
for m in "$SRC"/mods/*/; do
  name=$(basename "$m")
  mkdir -p "$HOME_DIR/mods/$name"
  cp -R "$m". "$HOME_DIR/mods/$name/"
done
echo "installed to $HOME_DIR"
