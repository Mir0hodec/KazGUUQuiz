// Автоматический туннель Cloudflare: телефоны заходят по ссылке https://….trycloudflare.com
// из любой сети. Ссылка живёт, пока работает cloudflared; при смене Wi-Fi она часто умирает —
// сторож замечает это и поднимает туннель заново, а QR на проекторе обновляется сам.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import dns from 'node:dns';
import https from 'node:https';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Где лежит cloudflared: PATH или стандартные места Homebrew. */
export function findCloudflared() {
  const candidates = [process.env.CLOUDFLARED, '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'].filter(Boolean);
  for (const p of candidates) { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* нет */ } }
  for (const dir of String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const name of process.platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared']) {
      const p = `${dir}/${name}`;
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* нет */ }
    }
  }
  return null;
}

/**
 * @param {object} o
 * @param {number} o.port           порт сервера
 * @param {string} [o.bin]          путь к cloudflared (или к заглушке в тестах)
 * @param {string[]} [o.args]       аргументы (по умолчанию quick tunnel на localhost:port)
 * @param {(state:{status:string,url:string|null,error?:string})=>void} o.onChange
 * @param {() => string} [o.networkKey]  «отпечаток» сети (IP ноутбука): сменился — перезапуск
 * @param {(url:string)=>Promise<boolean>} [o.probe]  проверка, что ссылка открывается
 * @param {number} [o.checkMs]      как часто проверять ссылку
 */
export function createTunnel({ port, bin = findCloudflared(), args, onChange, networkKey = () => '', probe = defaultProbe, checkMs = 20000, readyTimeoutMs = 90000 }) {
  let child = null; let url = null; let registered = false; let status = bin ? 'starting' : 'missing';
  let stopped = false; let fails = 0; let failLimit = 5; let restartTimer = null; let readyTimer = null; let lastNet = networkKey();
  const set = (st, extra = {}) => { status = st; onChange?.({ status, url, ...extra }); };
  const maybeReady = () => { if (url && registered && status !== 'ready') { clearTimeout(readyTimer); fails = 0; set('ready'); } };

  function launch() {
    if (stopped || !bin) return;
    url = null; registered = false; set('starting');
    const a = args || ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];
    let me;
    try { me = spawn(bin, a, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { set('error', { error: e.message }); return scheduleRestart(10000); }
    child = me;
    const onData = (buf) => {
      if (child !== me) return;
      const text = String(buf);
      const m = text.match(URL_RE);
      if (m && m[0] !== url) { url = m[0]; set('checking'); confirmByProbe(me, url); }
      // ссылка готова, когда cloudflared сам сообщил о соединении с Cloudflare — DNS ноутбука тут не нужен (он кэширует «нет такого адреса»)
      if (/Registered tunnel connection/i.test(text)) registered = true;
      maybeReady();
    };
    me.stdout.on('data', onData); me.stderr.on('data', onData);
    me.on('error', (e) => { if (child === me) set('error', { error: e.message }); });
    // выход процесса, который мы сами заменили, ничего не перезапускает (раньше это давало второй cloudflared)
    me.on('exit', () => { if (child !== me) return; child = null; if (!stopped) { url = null; set('restarting', { error: 'cloudflared остановился' }); scheduleRestart(3000); } });
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => { if (child === me && status !== 'ready') { set('restarting', { error: 'Cloudflare не ответил' }); restart(); } }, readyTimeoutMs);
  }
  // запасной путь: строки о соединении нет (другая версия cloudflared) — готово, как только ссылка открылась через внешний DNS
  async function confirmByProbe(me, u) {
    for (let i = 0; i < 18 && child === me && url === u && status !== 'ready' && !stopped; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (child === me && url === u && status !== 'ready' && await probe(u)) { registered = true; maybeReady(); return; }
    }
  }
  function kill() { const c = child; child = null; if (c) { try { c.kill('SIGTERM'); } catch { /* уже нет */ } } }
  function scheduleRestart(ms) { if (stopped || restartTimer) return; restartTimer = setTimeout(() => { restartTimer = null; launch(); }, ms); }
  function restart() { kill(); clearTimeout(restartTimer); restartTimer = null; launch(); }

  // Сторож: сменилась сеть — новый туннель сразу; ссылка не открывается много раз подряд — тоже,
  // но каждый следующий такой перезапуск требует вдвое больше неудач (чтобы не крутиться по кругу).
  const watch = setInterval(async () => {
    if (stopped || !bin) return;
    const net = networkKey();
    if (net !== lastNet) { lastNet = net; set('restarting', { error: 'сменилась сеть' }); restart(); return; }
    if (status !== 'ready' || !url) return;
    const u = url;
    if (await probe(u)) { fails = 0; return; }
    if (url !== u) return;
    if (++fails >= failLimit) { failLimit = Math.min(failLimit * 2, 40); set('restarting', { error: 'ссылка перестала открываться' }); restart(); }
  }, checkMs);
  watch.unref?.();

  if (bin) launch(); else set('missing');
  return {
    get url() { return status === 'ready' ? url : null; },
    get status() { return status; },
    restart,
    stop() { stopped = true; clearInterval(watch); clearTimeout(restartTimer); clearTimeout(readyTimer); kill(); },
  };
}

// Проверка ссылки через DNS Cloudflare и Google, мимо кэша ноутбука: macOS помнит «адреса нет» несколько минут.
const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);
async function defaultProbe(u) {
  try {
    const host = new URL(u).hostname;
    const [ip] = await resolver.resolve4(host);
    return await new Promise((res) => {
      const req = https.request({ host: ip, servername: host, path: '/api/health', headers: { Host: host }, timeout: 8000 }, (r) => { r.resume(); res(r.statusCode === 200); });
      req.on('timeout', () => { req.destroy(); res(false); });
      req.on('error', () => res(false));
      req.end();
    });
  } catch { return false; }
}
