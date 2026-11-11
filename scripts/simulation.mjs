/**
 * Полная симуляция турнира: N ботов-команд подключаются к настоящему серверу по WebSocket и играют так, как играют люди:
 *   — думают случайное время (кто-то быстро, кто-то под конец таймера), ошибаются в зависимости от «силы» команды;
 *   — задержки сети у каждого свои; часть команд теряет связь посреди вопроса и возвращается;
 *   — кто-то отвечает поздно (после закрытия), кто-то повторяет отправку, кто-то не отвечает совсем.
 * Ведущий (скрипт) создаёт турнир, запускает автопроведение, продолжает блоки и объявляет итоги. Всё идёт в реальном времени:
 * можно смотреть /display, /admin и /host. В конце баллы каждой команды сверяются с независимым контрольным подсчётом по тому,
 * что реально приняли боты от сервера.
 */
import { io } from 'socket.io-client';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DIFF = ['easy', 'medium', 'hard'];
const DIFF_RU = ['лёгкий', 'средний', 'сложный'];
const POINTS = { easy: 1, medium: 2, hard: 3 };
const AGES = ['junior', 'middle', 'senior'];

export function buildQuestions(blocks, perBlock) {
  const items = [];
  for (let b = 1; b <= blocks; b++) for (let k = 0; k < perBlock; k++) {
    const n = items.length; const d = n % 3; const choice = n % 2 === 0; const right = (n * 3) % 4;
    items.push({ n, block: b, diff: DIFF[d], choice, right, key: `ответ${n}` });
  }
  const lines = items.map((q) => {
    const body = q.choice ? ['Вариант А', 'Вариант Б', 'Вариант В', 'Вариант Г'].map((o, i) => (i === q.right ? `${o}*` : o)).join('; ') : q.key;
    return `Вопрос ${q.n + 1} (блок ${q.block}): выберите верное? | ${body} | ${DIFF_RU[DIFF.indexOf(q.diff)]} | | | ${q.block}`;
  });
  return { items, text: lines.join('\n') };
}

export async function runSimulation(o = {}) {
  const cfg = {
    url: 'http://127.0.0.1:3000', token: '', password: '', teams: 30, blocks: 3, perBlock: 5, questionSec: 20, pauseSec: 5,
    blockWaitSec: 8, revealStepSec: 3, seed: 42, chaos: true, maxMinutes: 60, onLog: (m) => console.log(m), shouldStop: () => false, ...o,
  };
  const log = (m) => cfg.onLog(m);
  const rnd = rng(cfg.seed);
  const { items, text: questionsText } = buildQuestions(cfg.blocks, cfg.perBlock);
  const total = items.length;

  // ---------- ведущий ----------
  const admin = io(cfg.url, { transports: ['websocket'], auth: { role: 'admin', token: cfg.token || undefined }, forceNew: true });
  await new Promise((res, rej) => { admin.on('connect', res); admin.on('connect_error', rej); });
  const call = (s, ev, p = {}, ms = 20000) => new Promise((res) => { const t = setTimeout(() => res({ ok: false, error: 'timeout' }), ms); s.emit(ev, p, (r) => { clearTimeout(t); res(r); }); });
  let me = await call(admin, 'a:state');
  if (!me.ok) {
    if (!cfg.password) throw new Error('Нет доступа администратора: передайте токен или пароль');
    const lg = await call(admin, 'a:login', { password: cfg.password });
    if (!lg.ok) throw new Error(`Вход администратора: ${lg.error}`);
  }
  const adminState = async () => (await call(admin, 'a:state')).state;

  const names = Array.from({ length: cfg.teams }, (_, i) => `Команда ${String(i + 1).padStart(2, '0')} | ${AGES[i % 3]}`).join('\n');
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const created = await call(admin, 'a:tournament:create', {
    name: `Симуляция ${stamp}`, teamNames: names, quizSec: cfg.questionSec, pauseSec: cfg.pauseSec, questions: questionsText,
    autoGrade: true, blockBreak: true, showQuestion: false, demo: true,
  });
  if (!created.ok) throw new Error(`Не удалось создать турнир: ${created.error}`);
  const st0 = await adminState();
  const teams = st0.teams;
  log(`Турнир «${st0.pub.tournament.name}»: ${teams.length} команд, ${cfg.blocks} блока × ${cfg.perBlock} вопросов = ${total}, на вопрос ${cfg.questionSec} с, пауза ${cfg.pauseSec} с`);

  // ---------- боты ----------
  const stats = { sent: 0, accepted: 0, rejected: {}, disconnects: 0, late: 0, duplicates: 0, silent: 0 };
  const bots = teams.map((t, i) => ({
    i, team: t, sock: null, connected: false, lastState: null, handled: new Set(),
    skill: 0.35 + rnd() * 0.6,                 // вероятность знать ответ
    pace: 0.15 + rnd() * 0.65,                 // доля времени вопроса, которую команда обычно думает
    lag: 5 + rnd() * 150,                      // сетевая задержка устройства, мс
    accepted: [],                              // принятые сервером ответы: {n, correct, points}
  }));

  async function connectBot(b) {
    const s = io(cfg.url, { transports: ['websocket'], forceNew: true, reconnection: false });
    b.sock = s;
    s.on('state', (st) => { b.lastState = st; onState(b, st); });
    s.on('disconnect', () => { b.connected = false; });
    await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
    const r = await call(s, 'team:login', { team: b.team.id, pin: b.team.pin });
    if (!r.ok) throw new Error(`вход бота ${b.i}: ${r.error}`);
    b.connected = true;
    return r;
  }
  async function reconnectBot(b) {
    try { b.sock?.close(); } catch { /* уже закрыт */ }
    for (let k = 0; k < 20; k++) { try { await connectBot(b); return; } catch { await sleep(300); } }
  }

  const rejectedBump = (reason) => { stats.rejected[reason] = (stats.rejected[reason] || 0) + 1; };

  function onState(b, st) {
    if (st.quiz.status !== 'open' || st.quiz.reading || !st.quiz.id || b.handled.has(st.quiz.id)) return; // пока ведущий читает — ждём
    b.handled.add(st.quiz.id);
    const q = items[st.tournament.question - 1];
    if (!q) return;
    void playQuestion(b, q, st.quiz.id, st.quiz.options.length > 0);
  }

  async function playQuestion(b, q, quizId, isChoice) {
    const qs = cfg.questionSec * 1000;
    const r1 = rnd(); const r2 = rnd(); const r3 = rnd();
    let think = b.pace * qs * (0.55 + r2 * 0.9) + (q.diff === 'hard' ? 0.1 * qs : 0);
    let kind = 'normal';
    if (cfg.chaos) {
      if (r1 < 0.05) kind = 'silent';
      else if (r1 < 0.11) { kind = 'late'; think = qs + 300 + r3 * 1500; }
    }
    if (kind === 'silent') { stats.silent++; return; }
    const pCorrect = clamp(b.skill + (q.diff === 'easy' ? 0.15 : q.diff === 'hard' ? -0.2 : 0), 0.05, 0.97);
    const correct = rnd() < pCorrect;
    const payload = isChoice
      ? { quizId, choice: correct ? q.right : (q.right + 1 + Math.floor(rnd() * 3)) % 4 }
      : { quizId, text: correct ? `Ответ${q.n}!` : 'не знаю' }  // регистр и знаки не важны: «Ответ5!» = «ответ5»;
    // часть команд теряет связь посреди вопроса
    const dropAt = cfg.chaos && rnd() < 0.05 ? think * (0.2 + rnd() * 0.6) : null;
    if (dropAt !== null) {
      await sleep(dropAt);
      stats.disconnects++;
      try { b.sock.close(); } catch { /* */ }
      b.connected = false;
      await sleep(1000 + rnd() * 4000);
      await reconnectBot(b);
      think = Math.max(0, think - dropAt - 1000);
    } else {
      await sleep(think);
    }
    await sleep(b.lag);
    if (!b.connected) await reconnectBot(b);
    stats.sent++;
    if (kind === 'late') stats.late++;
    const ack = await call(b.sock, 'team:answer', payload);
    if (ack.ok) {
      stats.accepted++;
      b.accepted.push({ n: q.n, correct, points: correct ? POINTS[q.diff] : 0, block: q.block });
      if (cfg.chaos && rnd() < 0.05) { stats.duplicates++; await sleep(200 + rnd() * 400); await call(b.sock, 'team:answer', payload); }
    } else rejectedBump(ack.reason || ack.error || 'ошибка');
  }

  // подключаем ботов с небольшим разбросом, как будто люди заходят по QR
  for (const b of bots) { await connectBot(b); await sleep(15); }
  log(`Подключено ботов: ${bots.filter((b) => b.connected).length} из ${bots.length}`);
  await sleep(800);

  // ---------- игра ----------
  const started = await call(admin, 'a:auto:start', { mode: 'quiz' });
  if (!started.ok) throw new Error(`Автопроведение не запустилось: ${started.error}`);
  log('▶ Игра началась. Откройте /display, /admin или /host и смотрите вживую.');

  const deadline = Date.now() + cfg.maxMinutes * 60000;
  let lastQuiz = null; let lastBlockHandled = null; let stopped = false;
  while (Date.now() < deadline) {
    if (cfg.shouldStop()) { stopped = true; await call(admin, 'a:auto:stop'); break; }
    const st = await adminState();
    if (!st) { await sleep(500); continue; }
    const a = st.pub.auto; const qz = st.pub.quiz;
    if (qz.id && qz.id !== lastQuiz && qz.status === 'open') {
      lastQuiz = qz.id;
      log(`Вопрос ${st.pub.tournament.question}/${total}: блок ${qz.block}, ${{ easy: 'лёгкий', medium: 'средний', hard: 'сложный', null: '' }[String(qz.difficulty)]}, ${qz.points} балл., ${qz.options.length ? 'варианты' : 'текст'}`);
    }
    if (qz.status === 'closed' && qz.id && qz.id === lastQuiz && !String(lastQuiz).endsWith('·')) {
      const n = st.pub.tournament.question; const answered = qz.answeredCount;
      lastQuiz = `${lastQuiz}·`;
      log(`   время вышло: ответили ${answered} из ${teams.length}`);
      void n;
    }
    if (a.running && a.phase === 'blockbreak' && lastBlockHandled !== a.doneBlock) {
      lastBlockHandled = a.doneBlock;
      log(`■ Блок ${a.doneBlock} завершён, результаты сохранены. Следующий блок через ${cfg.blockWaitSec} с`);
      await sleep(cfg.blockWaitSec * 1000);
      await call(admin, 'a:auto:resume');
      log(`▶ Блок ${a.doneBlock + 1}`);
    }
    if (a.finished) break;
    await sleep(400);
  }
  if (stopped) { log('■ Симуляция остановлена'); for (const b of bots) b.sock?.close(); admin.close(); return { ok: false, stopped: true, stats }; }
  await sleep(1500);

  // ---------- контрольный подсчёт ----------
  const st = await adminState();
  const mism = [];
  for (const b of bots) {
    const row = st.teams.find((t) => t.id === b.team.id);
    const stat = st.stats.find((x) => x.teamId === b.team.id);
    const expectScore = b.accepted.reduce((s, x) => s + x.points, 0);
    const expectCorrect = b.accepted.filter((x) => x.correct).length;
    if (row.score !== expectScore) mism.push(`${b.team.name}: баллы ${row.score}, ожидалось ${expectScore}`);
    if (stat.answered !== b.accepted.length) mism.push(`${b.team.name}: ответов ${stat.answered}, ожидалось ${b.accepted.length}`);
    if (stat.correct !== expectCorrect) mism.push(`${b.team.name}: верных ${stat.correct}, ожидалось ${expectCorrect}`);
  }
  const histOk = st.historyCount === total;
  const verified = mism.length === 0 && histOk;
  log('');
  log(`Ответов отправлено ботами: ${stats.sent}, принято сервером: ${stats.accepted}, отклонено: ${Object.entries(stats.rejected).map(([k, v]) => `${k} ${v}`).join(', ') || 'нет'}`);
  log(`Событий: обрывов связи ${stats.disconnects}, поздних ответов ${stats.late}, повторных отправок ${stats.duplicates}, молчунов ${stats.silent}`);
  log(`${verified ? '✓' : '✗'} Контрольный подсчёт: ${verified ? 'баллы, число ответов и верных у всех команд совпали с независимым расчётом' : `расхождения: ${mism.slice(0, 5).join('; ')}`}; вопросов в архиве ${st.historyCount} из ${total}`);
  const top = st.pub.board.slice(0, 5);
  log(`Итог (топ-5): ${top.map((r) => `${r.rank}. ${r.name} — ${r.score}`).join(' · ')}`);

  // ---------- объявление итогов ----------
  if (cfg.revealStepSec >= 0) {
    log('Объявляем тройку призёров…');
    await call(admin, 'a:reveal:start', { mode: 'top3' });
    for (let i = 0; i < Math.min(3, teams.length); i++) { await sleep(cfg.revealStepSec * 1000); await call(admin, 'a:reveal:next'); }
    await sleep(cfg.revealStepSec * 1000);
    await call(admin, 'a:display:set', { view: 'leaderboard' });
  }
  for (const b of bots) b.sock?.close();
  admin.close();
  log('ГОТОВО');
  return { ok: verified, stats, mismatches: mism, total, accepted: stats.accepted, top };
}
