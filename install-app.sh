#!/usr/bin/env bash
# 安装 dist 里的 app 到 /Applications，并刷新 LaunchServices 图标缓存。
# 直接 cp -R 覆盖正在运行的旧 bundle 时，Dock 可能缓存到旧图标，显示成空白方块；
# 这里先退出、再替换、再强制重新登记图标，最后启动。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/dist/AI 工具箱.app"
DEST="/Applications/AI 工具箱.app"

if [ ! -d "$APP" ]; then
  echo "找不到 $APP，请先运行 ./build-app.sh"
  exit 1
fi
if [ ! -s "$APP/Contents/Resources/AppIcon.icns" ]; then
  echo "⚠️ 构建产物里没有 AppIcon.icns，安装后图标会是空白；请重新运行 ./build-app.sh"
  exit 1
fi

echo "==> 退出正在运行的 AI 工具箱"
osascript -e 'tell application "AI 工具箱" to quit' >/dev/null 2>&1 || true
sleep 2
pkill -f "$DEST/Contents/MacOS/AIToolbox" >/dev/null 2>&1 || true
sleep 1

echo "==> 安装到 $DEST"
rm -rf "$DEST"
cp -R "$APP" "$DEST"

echo "==> 刷新 LaunchServices 图标缓存"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
fi
touch "$DEST"

echo "==> 启动"
open "$DEST"
