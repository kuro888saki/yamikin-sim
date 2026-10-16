#!/bin/zsh
# どてらい金融をブラウザで起動する。ダブルクリックで動く。終わったらこのウィンドウを閉じる。
cd "$(dirname "$0")"
PORT=8750
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT/"
  echo "すでに起動しています。ブラウザを開きました。"
  exit 0
fi
(sleep 1; open "http://127.0.0.1:$PORT/") &
echo "どてらい金融を起動しました。遊び終わったらこのウィンドウを閉じてください。"
python3 -m http.server $PORT --bind 127.0.0.1
