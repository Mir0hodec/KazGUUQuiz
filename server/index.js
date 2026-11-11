import { createQuizServer, lanIps } from './app.js';
import { createTunnel, findCloudflared } from './tunnel.js';

const srv = createQuizServer();
const port = await srv.start().catch((e) => {
  console.error(e.code === 'EADDRINUSE' ? `Порт ${process.env.PORT || 3000} занят. Задайте другой: PORT=3001 npm start` : e);
  process.exit(1);
});

const ips = lanIps();
const line = '─'.repeat(60);
console.log(`\n${line}\n  QUIZ ARENA запущен (порт ${port})\n${line}`);
for (const ip of ips.length ? ips : ['localhost']) {
  console.log(`  Админ:     http://${ip}:${port}/admin  (единый кабинет ведущего)`);
  console.log(`  Проектор:  http://${ip}:${port}/display`);
  console.log(`  Капитаны:  http://${ip}:${port}/play`);
  console.log('');
}
console.log(srv.hasPassword
  ? '  Пароль админки задан. Введите его на странице /admin.'
  : '  Пароль админки ещё не задан: откройте /admin НА ЭТОМ НОУТБУКЕ и придумайте его.');
console.log(`${line}\n`);

// Туннель: телефоны заходят по интернет-ссылке из любой сети. Выключить: TUNNEL=0 npm start
let tunnel = null;
if (process.env.TUNNEL !== '0') {
  if (!findCloudflared()) {
    console.log('  Интернет-ссылка выключена: не установлен cloudflared (brew install cloudflared).');
    console.log('  Телефоны подключаются только через Wi-Fi, по адресам выше.\n');
  } else {
    console.log('  Поднимаю интернет-ссылку для телефонов…');
    let lastUrl = null;
    tunnel = createTunnel({
      port,
      networkKey: () => lanIps().join(','),
      onChange: (st) => {
        srv.setTunnel(st);
        if (st.status === 'ready' && st.url !== lastUrl) {
          lastUrl = st.url;
          console.log(`\n  ✓ Интернет-ссылка готова — QR на проекторе уже ведёт на неё:\n      ${st.url}/play   (телефоны)\n      ${st.url}/admin  (админка с любого устройства)\n`);
        } else if (st.status === 'restarting') console.log(`  … перезапуск интернет-ссылки (${st.error || 'нет связи'})`);
      },
    });
  }
}

process.on('uncaughtException', (e) => console.error('[ошибка]', e));
process.on('unhandledRejection', (e) => console.error('[ошибка]', e));

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  tunnel?.stop();
  await srv.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // окно start.command закрыли крестиком — туннель тоже закрываем
