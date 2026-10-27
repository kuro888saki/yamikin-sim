#!/bin/zsh
# 小口金融をブラウザで起動する。ダブルクリックで動く。終わったらこのウィンドウを閉じる。
cd "$(dirname "$0")"
PORT=8750
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT/"
  echo "すでに起動しています。ブラウザを開きました。"
  exit 0
fi
(sleep 1; open "http://127.0.0.1:$PORT/") &
echo "小口金融を起動しました。遊び終わったらこのウィンドウを閉じてください。"
# ブラウザに古いファイルを覚えさせない（更新したあとも必ず新しい中身で動くように）
python3 - "$PORT" <<'PY'
import http.server, sys
class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
PY
