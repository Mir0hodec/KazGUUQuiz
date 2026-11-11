@echo off
rem QUIZ ARENA — запуск двойным щелчком (Windows).
rem Сам ставит всё нужное, запускает сервер и интернет-ссылку для телефонов, открывает админку.
rem Окно не закрывайте, пока идёт игра.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Не найден Node.js. Установите его с https://nodejs.org ^(кнопка LTS^) и запустите снова. & start https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Первый запуск: ставлю зависимости...
  call npm install || (echo Не удалось поставить зависимости. Нужен интернет. & pause & exit /b 1)
)
call npm run build || (echo Ошибка сборки. & pause & exit /b 1)
if exist "%LOCALAPPDATA%\cloudflared\cloudflared.exe" set "PATH=%PATH%;%LOCALAPPDATA%\cloudflared"
where cloudflared >nul 2>nul || (
  echo Ставлю cloudflared для интернет-ссылки...
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements || echo Не получилось поставить cloudflared — телефоны смогут зайти только через ту же Wi-Fi сеть.
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000/admin"
call npm start
pause
