import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTunnel } from '../server/tunnel.js';

// Заглушка cloudflared: печатает новую ссылку и «Registered tunnel connection», как настоящий, и живёт, пока её не остановят.
// Каждый запуск пишет свой pid — так проверяем, что лишних процессов не остаётся.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-tun-'));
const fake = path.join(dir, 'fake.mjs');
const pids = path.join(dir, 'pids.txt');
fs.writeFileSync(fake, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
const n = Math.random().toString(36).slice(2, 8);
process.stderr.write('INF | https://fake-' + n + '.trycloudflare.com |\\n');
if (process.argv[2] !== 'silent') setTimeout(() => process.stderr.write('INF Registered tunnel connection connIndex=0\\n'), 30);
if (process.argv[2] === 'die') setTimeout(() => process.exit(1), 150); else setInterval(() => {}, 1000);`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(20); } };
const alive = () => (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []).filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });

describe('автотуннель', () => {
  it('готов, когда cloudflared сообщил о соединении — без проверки через DNS ноутбука', async () => {
    const states = [];
    const t = createTunnel({ port: 1, bin: process.execPath, args: [fake], probe: async () => false, onChange: (s) => states.push(s), checkMs: 100000 });
    await waitFor(() => t.status === 'ready');
    expect(t.url).toMatch(/^https:\/\/fake-[a-z0-9]+\.trycloudflare\.com$/);
    expect(states.map((s) => s.status)).toEqual(expect.arrayContaining(['starting', 'checking', 'ready']));
    t.stop();
  });

  it('сменилась сеть — новый туннель с новой ссылкой, старый процесс закрыт, лишних нет', async () => {
    let net = 'wifi-1';
    const t = createTunnel({ port: 1, bin: process.execPath, args: [fake], probe: async () => true, networkKey: () => net, onChange: () => {}, checkMs: 50 });
    await waitFor(() => t.status === 'ready');
    const first = t.url;
    net = 'wifi-2';
    await waitFor(() => t.status === 'ready' && t.url !== first);
    await sleep(300);
    expect(alive().length).toBe(1); // раньше выход заменённого процесса запускал второй cloudflared
    t.stop();
    await sleep(300);
    expect(alive().length).toBe(0);
  });

  it('ссылка не открывается много раз подряд — перезапуск, и каждый следующий требует больше неудач', async () => {
    let ok = true; let restarts = 0;
    const t = createTunnel({ port: 1, bin: process.execPath, args: [fake], probe: async () => ok, onChange: (s) => { if (s.status === 'restarting') restarts++; }, checkMs: 20 });
    await waitFor(() => t.status === 'ready');
    const first = t.url; ok = false;
    await waitFor(() => restarts >= 1, 3000);
    await waitFor(() => t.status === 'ready' && t.url !== first, 3000);
    const at = Date.now();
    await waitFor(() => restarts >= 2, 5000); // второй перезапуск — после 10 неудач, а не после 5
    expect(Date.now() - at).toBeGreaterThan(150);
    t.stop();
  });

  it('cloudflared упал — поднимается снова', async () => {
    const seen = new Set();
    const t = createTunnel({ port: 1, bin: process.execPath, args: [fake, 'die'], probe: async () => true, onChange: (s) => { if (s.url) seen.add(s.url); }, checkMs: 100000 });
    await waitFor(() => seen.size >= 2, 8000);
    t.stop();
  });

  it('Cloudflare не подтвердил соединение — перезапуск по таймауту', async () => {
    let restarts = 0;
    const t = createTunnel({ port: 1, bin: process.execPath, args: [fake, 'silent'], probe: async () => true, onChange: (s) => { if (s.status === 'restarting') restarts++; }, checkMs: 100000, readyTimeoutMs: 200 });
    await waitFor(() => restarts >= 1, 3000);
    expect(t.status).not.toBe('ready');
    t.stop();
  });

  it('cloudflared не установлен — статус missing, без ошибок', () => {
    const t = createTunnel({ port: 1, bin: null, onChange: () => {} });
    expect(t.status).toBe('missing');
    expect(t.url).toBe(null);
    t.stop();
  });
});
