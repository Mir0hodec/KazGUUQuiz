/**
 * Нагрузочный тест: N клиентов (по умолчанию 1000), каждый — отдельная команда.
 *   npm run load                # 1000 клиентов, сервер поднимается сам
 *   node scripts/load-test.mjs 300
 *   node scripts/load-test.mjs 1000 http://192.168.1.10:3000 пароль   # против настоящего сервера (создаст отдельный турнир!)
 * Фазы: вход → доставка вопроса → шквал ответов → шквал нажатий BUZZ → шторм переподключений → размеры сообщений.
 * Задержки измеряются на одной машине (клиенты и сервер на одном ноутбуке), поэтому показывают нагрузку на сервер,
 * а не качество Wi-Fi.
 */
import { io } from 'socket.io-client';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const N = Number(process.argv[2]) || 1000;
const extUrl = process.argv[3] || null;
const extPass = process.argv[4] || 'loadtest1';
const PORT = 3088;
const url = extUrl || `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, p = {}, ms = 30000) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, error: 'timeout' }), ms);
  s.emit(ev, p, (r) => { clearTimeout(t); res(r); });
});
const pct = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN; };
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(0) : '—');
const stat = (arr) => `p50 ${fmt(pct(arr, 0.5))} · p95 ${fmt(pct(arr, 0.95))} · p99 ${fmt(pct(arr, 0.99))} · max ${fmt(Math.max(...arr))} мс`;

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const info = (m) => console.log(`      ${m}`);

let server = null; let dir = null;
async function startServer() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-load-'));
  server = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_PASSWORD: extPass, TUNNEL: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* ждём */ } await sleep(100); }
  throw new Error('сервер не запустился');
}
const serverStats = () => {
  if (!server) return null;
  try { const [rss, cpu] = execSync(`ps -o rss=,pcpu= -p ${server.pid}`).toString().trim().split(/\s+/).map(Number); return { rssMb: rss / 1024, cpu }; } catch { return null; }
};

async function main() {
  console.log(`\nНагрузочный тест: ${N} клиентов → ${url}\n`);
  if (!extUrl) await startServer();
  const admin = io(url, { transports: ['websocket'], auth: { role: 'admin' }, forceNew: true });
  await new Promise((r) => admin.on('connect', r));
  const lg = await call(admin, 'a:login', { password: extPass });
  if (!lg.ok) throw new Error(`вход админа: ${lg.error}`);

  // турнир на N команд: вопросы с вариантами; блок 1
  const created = await call(admin, 'a:tournament:create', {
    name: `Нагрузка ${N}`, teamCount: N, quizSec: 120, pauseSec: 0,
    questions: ['Нагрузочный вопрос 1? | Раз; Два*; Три; Четыре | средний | | | 1', 'Нагрузочный вопрос 2? | Пять; Шесть; Семь*; Восемь | сложный | | | 1'].join('\n'),
  });
  ok(created.ok, `турнир на ${N} команд создан`);
  const t0 = performance.now();
  const st0 = (await call(admin, 'a:state')).state;
  info(`админ-состояние: ${(JSON.stringify(st0).length / 1024).toFixed(0)} КБ, получено за ${fmt(performance.now() - t0)} мс`);
  const teams = st0.teams;

  // ---- 1. вход ----
  const clients = new Array(N);
  const states = new Array(N).fill(null);   // последнее состояние
  const t1 = performance.now();
  let loginFail = 0;
  const BATCH = 100;
  for (let b = 0; b < N; b += BATCH) {
    await Promise.all(Array.from({ length: Math.min(BATCH, N - b) }, async (_, k) => {
      const i = b + k;
      const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
      clients[i] = s;
      s.on('state', (x) => { states[i] = { x, at: performance.now() }; });
      await new Promise((r) => s.on('connect', r));
      const r = await call(s, 'team:login', { team: teams[i].id, pin: teams[i].pin });
      if (!r.ok) loginFail++;
    }));
  }
  const loginMs = performance.now() - t1;
  await sleep(500);
  ok(loginFail === 0, `${N} клиентов вошли за ${(loginMs / 1000).toFixed(1)} с (${(N / (loginMs / 1000)).toFixed(0)} входов/с), ошибок входа: ${loginFail}`);
  const online = (await call(admin, 'a:state')).state.pub.online;
  ok(online === N, `сервер видит онлайн: ${online} из ${N}`);

  // зонд: задержка ответа сервера на маленький запрос во время нагрузки (показывает «залипание» цикла событий)
  const probe = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((r) => probe.on('connect', r));
  let probing = true; const probeMs = [];
  (async () => { while (probing) { const t = performance.now(); await call(probe, 'sys:ping', {}, 10000); probeMs.push(performance.now() - t); await sleep(25); } })();
  const probeStats = () => { const a = probeMs.splice(0); return a.length ? stat(a) : 'нет данных'; };

  // ---- 2. доставка вопроса ----
  states.fill(null);
  const tOpen = performance.now();
  const opened = await call(admin, 'a:quiz:open', {});
  ok(opened.ok, 'вопрос открыт');
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline && states.filter((s) => s && s.x.quiz.status === 'open').length < N) await sleep(20);
  const got = states.filter((s) => s && s.x.quiz.status === 'open');
  ok(got.length === N, `вопрос дошёл до ${got.length} из ${N} клиентов`);
  const deliver = got.map((s) => s.at - tOpen);
  info(`доставка вопроса: ${stat(deliver)}`);
  info(`размер состояния для каждой команды: ${(JSON.stringify(states[0].x).length / 1024).toFixed(1)} КБ`);
  info(`отклик сервера во время рассылки: ${probeStats()}`);
  const quizId = states[0].x.quiz.id;
  const sv1 = serverStats(); if (sv1) info(`сервер: память ${sv1.rssMb.toFixed(0)} МБ, CPU ${sv1.cpu}%`);

  // ---- 3. шквал ответов ----
  const ackMs = new Array(N);
  const tAns = performance.now();
  const acks = await Promise.all(clients.map(async (c, i) => {
    const t = performance.now();
    const r = await call(c, 'team:answer', { quizId, choice: i % 3 === 0 ? 1 : 0 }); // каждая 3-я команда отвечает верно
    ackMs[i] = performance.now() - t; return r;
  }));
  const ansTotal = performance.now() - tAns;
  const accepted = acks.filter((r) => r.ok).length;
  ok(accepted === N, `принято ответов: ${accepted} из ${N} за ${(ansTotal / 1000).toFixed(2)} с`);
  info(`подтверждение ответа: ${stat(ackMs)}`);
  info(`отклик сервера во время шквала: ${probeStats()}`);
  await sleep(300);
  const stA = (await call(admin, 'a:state')).state;
  ok(stA.quizAnswers.length === N, `в базе ровно ${stA.quizAnswers.length} ответов (по одному на команду)`);
  ok(new Set(stA.quizAnswers.map((a) => a.teamId)).size === N, 'дублей ответов нет');
  const rep = await Promise.all(clients.slice(0, 50).map((c) => call(c, 'team:answer', { quizId, choice: 1 })));
  ok(rep.every((r) => r.ok || r.reason === 'already_answered'), 'повторные отправки не создают дублей');
  await call(admin, 'a:quiz:close');
  const stB = (await call(admin, 'a:state')).state;
  const right = Math.ceil(N / 3);
  const sumScore = stB.teams.reduce((s, t) => s + t.score, 0);
  ok(sumScore === right * 2, `автооценка: верных ${right}, сумма баллов ${sumScore} (ожидалось ${right * 2})`);
  ok(stB.quizAnswers.every((a) => a.verdict !== null), 'у всех ответов есть оценка');
  const sv2 = serverStats(); if (sv2) info(`сервер: память ${sv2.rssMb.toFixed(0)} МБ, CPU ${sv2.cpu}%`);
  await call(admin, 'a:quiz:reset');

  // ---- 3б. длинная игра: ещё ROUNDS-1 раундов ответов подряд (проверяем рост базы и «залипание» к концу) ----
  const ROUNDS = Number(process.env.ROUNDS) || 1;
  if (ROUNDS > 1) {
    const worst = []; let lag = 0;
    for (let r = 2; r <= ROUNDS; r++) {
      states.fill(null);
      const o = await call(admin, 'a:quiz:open', {});
      const dl = performance.now() + 15000;
      while (performance.now() < dl && states.filter((x) => x && x.x.quiz.status === 'open').length < N) await sleep(10);
      const q = states[0]?.x.quiz;
      const times = new Array(N);
      const res = await Promise.all(clients.map(async (c, i) => {
        const t = performance.now();
        const rr = await call(c, 'team:answer', q.options.length ? { quizId: q.id, choice: i % 4 } : { quizId: q.id, text: `ответ ${i % 7}` });
        times[i] = performance.now() - t; return rr;
      }));
      if (res.some((x) => !x.ok)) ok(false, `раунд ${r}: принято ${res.filter((x) => x.ok).length} из ${N}`);
      worst.push(pct(times, 0.95));
      await call(admin, 'a:quiz:close'); await call(admin, 'a:quiz:reset');
      await sleep(150);
    }
    ok(true, `длинная игра: ${ROUNDS} раундов × ${N} ответов = ${ROUNDS * N} ответов, подтверждение p95 по раундам: ${worst.map(fmt).join(' / ')} мс`);
    const histN = (await call(admin, 'a:state')).state.historyCount;
    ok(histN >= ROUNDS - 1, `в архиве ${histN} вопросов`);
    try { const sz = fs.statSync(path.join(dir ?? '.', 'state.json')).size; info(`файл состояния на диске: ${(sz / 1048576).toFixed(1)} МБ`); } catch { /* внешний сервер */ }
    const svx = serverStats(); if (svx) info(`сервер после длинной игры: память ${svx.rssMb.toFixed(0)} МБ, CPU ${svx.cpu}%`);
    info(`отклик сервера за длинную игру: ${probeStats()}`);
    void lag;
  }

  // ---- 4. шквал нажатий BUZZ ----
  await call(admin, 'a:settings:update', { queueWindowMs: 1000, openSec: 0 });
  await call(admin, 'a:round:reset', { advance: false });
  const opened2 = await call(admin, 'a:round:open');
  await sleep(300);
  const roundId = opened2.roundId;
  const buzzMs = new Array(N);
  const tBuzz = performance.now();
  const bz = await Promise.all(clients.map(async (c, i) => {
    const t = performance.now();
    const r = await call(c, 'team:buzz', { roundId, nonce: `n${i}` });
    buzzMs[i] = performance.now() - t; return r;
  }));
  const firsts = bz.filter((r) => r.result === 'first').length;
  ok(firsts === 1, `при ${N} одновременных нажатиях победитель ровно один (${firsts})`);
  info(`нажатий принято в очередь: ${bz.filter((r) => r.result === 'queued').length}, поздних: ${bz.filter((r) => r.reason === 'late').length}; за ${fmt(performance.now() - tBuzz)} мс`);
  info(`подтверждение нажатия: ${stat(buzzMs)}`);
  info(`отклик сервера во время шквала: ${probeStats()}`);
  await call(admin, 'a:round:reset', { advance: false });

  // ---- 5. шторм переподключений ----
  const scoreBefore = (await call(admin, 'a:state')).state.teams.reduce((x, t) => x + t.score, 0);
  const drop = Math.floor(N * 0.3);
  for (let i = 0; i < drop; i++) clients[i].close();
  await sleep(1500);
  const onl = (await call(admin, 'a:state')).state.pub.online;
  info(`после обрыва ${drop} клиентов онлайн: ${onl}`);
  const tRe = performance.now();
  let reFail = 0;
  for (let b = 0; b < drop; b += BATCH) {
    await Promise.all(Array.from({ length: Math.min(BATCH, drop - b) }, async (_, k) => {
      const i = b + k;
      const s = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
      clients[i] = s; s.on('state', (x) => { states[i] = { x, at: performance.now() }; });
      await new Promise((r) => s.on('connect', r));
      const r = await call(s, 'team:login', { team: teams[i].id, pin: teams[i].pin });
      if (!r.ok) reFail++;
    }));
  }
  ok(reFail === 0, `${drop} клиентов переподключились за ${((performance.now() - tRe) / 1000).toFixed(1)} с, ошибок: ${reFail}`);
  await sleep(500);
  const st5 = (await call(admin, 'a:state')).state;
  ok(st5.pub.online === N, `снова онлайн: ${st5.pub.online} из ${N}`);
  ok(st5.teams.length === N, 'команды не продублировались при переподключении');
  const scoreAfter = st5.teams.reduce((s, t) => s + t.score, 0);
  ok(scoreAfter === scoreBefore, 'баллы после переподключений не изменились');

  // ---- 6. итоги и размеры ----
  const t6 = performance.now();
  await call(admin, 'a:display:set', { view: 'leaderboard' });
  await sleep(1000);
  const lb = states[N - 1]?.x;
  info(`таблица рейтинга после открытия: ${lb?.board.length} строк, ${(JSON.stringify(lb).length / 1024).toFixed(0)} КБ в сообщении; открытие заняло ${fmt(performance.now() - t6)} мс`);
  await call(admin, 'a:display:set', { view: 'auto' });
  const backup = await call(admin, 'a:backup');
  ok(backup.ok, 'резервная копия сохраняется');
  const sv3 = serverStats(); if (sv3) info(`сервер в конце: память ${sv3.rssMb.toFixed(0)} МБ, CPU ${sv3.cpu}%`);
  info(`отклик сервера за остальное время: ${probeStats()}`);

  probing = false;
  for (const c of clients) c.close();
  probe.close(); admin.close();
  console.log(fails ? `\nПРОВАЛЕНО проверок: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОШЛИ');
}

main().catch((e) => { console.error('ОШИБКА:', e); fails++; }).finally(async () => {
  if (server) { server.kill('SIGINT'); await sleep(500); }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
});
