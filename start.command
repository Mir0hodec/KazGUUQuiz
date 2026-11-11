#!/bin/bash
# QUIZ ARENA — запуск двойным щелчком (macOS).
# Сам ставит всё нужное, запускает сервер и интернет-ссылку для телефонов, открывает админку.
# Окно не закрывайте, пока идёт игра. Остановить: Ctrl+C или закрыть окно.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-3000}"
pause() { read -r -p "Нажмите Enter, чтобы закрыть окно..." _; }

echo "QUIZ ARENA: подготовка…"

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Скачайте и установите его с https://nodejs.org (кнопка LTS), затем запустите этот файл снова."
  open "https://nodejs.org" 2>/dev/null; pause; exit 1
fi

# 2. Зависимости (один раз, нужен интернет)
if [ ! -d node_modules ]; then
  echo "Первый запуск: ставлю зависимости (1–2 минуты)…"
  npm install || { echo "Не удалось поставить зависимости. Нужен интернет."; pause; exit 1; }
fi

# 3. Интерфейс: собираем, если его нет или исходники новее сборки
if [ ! -f dist/index.html ] || [ -n "$(find src index.html -newer dist/index.html 2>/dev/null | head -1)" ]; then
  echo "Собираю интерфейс…"
  npm run build || { echo "Ошибка сборки."; pause; exit 1; }
fi

# 4. cloudflared — интернет-ссылка, чтобы телефоны заходили из любой сети
if [ "${TUNNEL:-1}" != "0" ] && ! command -v cloudflared >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Ставлю cloudflared для интернет-ссылки (один раз)…"
    brew install cloudflared || echo "Не получилось поставить cloudflared — телефоны смогут зайти только через ту же Wi-Fi сеть."
  else
    echo "cloudflared не установлен (и нет Homebrew). Телефоны смогут зайти только через ту же Wi-Fi сеть."
    echo "Чтобы включить интернет-ссылку: установите Homebrew (https://brew.sh), затем: brew install cloudflared"
  fi
fi

# 5. Уже запущено? Тогда просто открываем админку
if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Сервер уже работает на порту $PORT — открываю админку."
  open "http://localhost:$PORT/admin"; pause; exit 0
fi

# 6. Запуск: админка откроется, когда сервер ответит
( for _ in $(seq 1 40); do
    if curl -s -o /dev/null "http://localhost:$PORT/api/health"; then open "http://localhost:$PORT/admin"; break; fi
    sleep 0.5
  done ) >/dev/null 2>&1 &
PORT="$PORT" npm start
pause
