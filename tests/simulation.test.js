import { describe, it, expect, afterAll } from 'vitest';
import { io as connectIo } from 'socket.io-client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuizServer } from '../server/app.js';
import { runSimulation } from '../scripts/simulation.mjs';

const servers = []; const sockets = [];
afterAll(async () => { for (const s of sockets) s.close(); for (const s of servers) await s.close(); });
const boot = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sim-'));
  const srv = createQuizServer({ readSec: 0, port: 0, host: '127.0.0.1', staticDir: null, adminPassword: 'pw1234', dataFile: path.join(dir, 'state.json') });
  await srv.start(); servers.push(srv); return srv;
};
const client = (srv, auth = {}) => new Promise((res, rej) => {
  const s = connectIo(`http://127.0.0.1:${srv.port}`, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(s); s.on('connect', () => res(s)); s.on('connect_error', rej);
});
const call = (s, ev, p = {}) => new Promise((res) => s.emit(ev, p, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('полная симуляция турнира', () => {
  it('боты играют весь турнир (блоки, перерыв, итоги); баллы совпадают с контрольным подсчётом', async () => {
    const srv = await boot();
    const lines = [];
    const res = await runSimulation({
      url: `http://127.0.0.1:${srv.port}`, password: 'pw1234', teams: 8, blocks: 2, perBlock: 2,
      questionSec: 2, pauseSec: 0, blockWaitSec: 0, revealStepSec: 0, seed: 7, onLog: (m) => lines.push(m),
    });
    expect(res.mismatches).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.accepted).toBeGreaterThan(8);               // ответы действительно зарегистрированы
    expect(res.stats.sent).toBeGreaterThanOrEqual(res.stats.accepted);
    expect(srv.db.demo).toBe(true);                        // симуляция идёт в отдельном демо-турнире
    expect(srv.db.history.length).toBe(4);                 // 2 блока × 2 вопроса
    expect(srv.db.displayView).toBe('leaderboard');        // итоги объявлены
    expect(lines.some((l) => l.includes('Контрольный подсчёт'))).toBe(true);
    expect(lines.some((l) => l.includes('Блок 1 завершён'))).toBe(true); // перерыв между блоками был
    expect(srv.db.log.some((e) => e.type === 'auto.blockbreak')).toBe(true);
  }, 90000);

  it('кнопка администратора: запуск, статус, повторный запуск отклоняется, остановка/завершение', async () => {
    const srv = await boot();
    const admin = await client(srv, { role: 'admin' });
    expect((await call(admin, 'a:login', { password: 'pw1234' })).ok).toBe(true);
    const team = await client(srv);
    expect((await call(team, 'a:sim:start', {})).error).toBe('forbidden');   // команда запустить не может
    expect((await call(admin, 'a:sim:start', { teams: 1 })).ok).toBe(false); // проверка параметров
    const cfg = { teams: 6, blocks: 1, perBlock: 2, questionSec: 2, pauseSec: 0, blockWaitSec: 0, revealStepSec: 0 };
    expect((await call(admin, 'a:sim:start', cfg)).ok).toBe(true);
    expect((await call(admin, 'a:sim:start', cfg)).ok).toBe(false);          // уже идёт
    let st;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      st = (await call(admin, 'a:state')).state;
      if (!st.sim.running && st.sim.lines.some((l) => l.includes('симуляция завершена'))) break;
    }
    expect(st.sim.running).toBe(false);
    expect(st.sim.lines.some((l) => l.includes('✓ Контрольный подсчёт'))).toBe(true);
    expect(st.pub.tournament.name).toMatch(/^Симуляция/);
    expect((await call(admin, 'a:sim:stop', {})).ok).toBe(false);            // останавливать уже нечего
  }, 90000);

  it('остановка посреди симуляции: боты отключаются, автопроведение выключается', async () => {
    const srv = await boot();
    const admin = await client(srv, { role: 'admin' });
    await call(admin, 'a:login', { password: 'pw1234' });
    await call(admin, 'a:sim:start', { teams: 6, blocks: 2, perBlock: 5, questionSec: 5, pauseSec: 1, blockWaitSec: 1, revealStepSec: 0 });
    for (let i = 0; i < 60; i++) { await sleep(300); if ((await call(admin, 'a:state')).state.pub.auto.running) break; }
    expect((await call(admin, 'a:state')).state.pub.auto.running).toBe(true);
    expect((await call(admin, 'a:sim:stop', {})).ok).toBe(true);
    for (let i = 0; i < 40; i++) { await sleep(250); if (!(await call(admin, 'a:state')).state.sim.running) break; }
    const st = (await call(admin, 'a:state')).state;
    expect(st.sim.running).toBe(false);
    expect(st.pub.auto.running).toBe(false);
  }, 60000);
});
