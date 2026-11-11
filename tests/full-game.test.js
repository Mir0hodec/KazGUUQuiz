/**
 * Этап 4 ТЗ: полный игровой сценарий с 30 командами, тремя блоками по 15 вопросов.
 * Баллы считаются независимо от сервера («контрольный ручной подсчёт») и сверяются с результатом системы.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { io as connectIo } from 'socket.io-client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuizServer } from '../server/app.js';

const sockets = [];
let srv;
afterAll(async () => { for (const s of sockets) s.close(); if (srv) await srv.close(); });

const connect = (auth = {}) => new Promise((res, rej) => {
  const s = connectIo(`http://127.0.0.1:${srv.port}`, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(s);
  s.on('connect', () => res(s)); s.on('connect_error', rej);
});
const call = (s, ev, p = {}) => new Promise((res) => s.emit(ev, p, res));

const TEAMS = 30, BLOCKS = 3, PER_BLOCK = 15;
const DIFF = ['easy', 'medium', 'hard'];
const DIFF_RU = ['лёгкий', 'средний', 'сложный'];
const POINTS = { easy: 1, medium: 2, hard: 3 };

describe('полный сценарий: 30 команд × 3 блока × 15 вопросов', () => {
  it('баллы, блоки и рейтинг совпадают с контрольным подсчётом; каждый ответ сохранён ровно один раз', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-full-'));
    srv = createQuizServer({ readSec: 0, port: 0, host: '127.0.0.1', staticDir: null, adminPassword: 'pw1234', dataFile: path.join(dir, 'state.json') });
    await srv.start();

    const admin = await connect({ role: 'admin' });
    expect((await call(admin, 'a:login', { password: 'pw1234' })).ok).toBe(true);

    // вопросы: чётные — с вариантами (верный — по кругу А/Б/В/Г), нечётные — текст; сложность по кругу 1/2/3
    const lines = []; const items = [];
    for (let b = 1; b <= BLOCKS; b++) for (let k = 0; k < PER_BLOCK; k++) {
      const n = items.length; const d = n % 3; const choice = n % 2 === 0; const right = n % 4;
      items.push({ n, block: b, diff: DIFF[d], choice, right });
      const body = choice ? ['Лондон', 'Париж', 'Рим', 'Берлин'].map((o, i) => (i === right ? `${o}*` : o)).join('; ') : `ответ${n}`;
      lines.push(`Вопрос ${n + 1}? | ${body} | ${DIFF_RU[d]} | | | ${b}`);
    }
    expect((await call(admin, 'a:questions:set', { text: lines.join('\n') })).count).toBe(BLOCKS * PER_BLOCK);
    await call(admin, 'a:teams:generate', { count: TEAMS });
    const teams = srv.db.teams;
    const ages = ['junior', 'middle', 'senior'];
    for (const [i, t] of teams.entries()) await call(admin, 'a:team:update', { id: t.id, age: ages[i % 3] });

    const caps = [];
    for (const t of teams) { const c = await connect(); expect((await call(c, 'team:login', { team: t.id, pin: t.pin })).ok).toBe(true); caps.push(c); }

    // сценарий ответов: у каждой команды свой «характер»; часть вопросов пропускают
    const plan = (i, n) => {
      if ((i + n) % 11 === 0) return null;                           // не ответила
      return ((i * 7 + n * 3) % 5) < 3 ? 'right' : 'wrong';
    };
    const expected = teams.map(() => ({ score: 0, blocks: {}, answered: 0, correct: 0 }));
    let accepted = 0;

    for (const q of items) {
      await call(admin, 'a:settings:update', { question: q.n + 1 });
      const { quizId } = await call(admin, 'a:quiz:open', {});
      await Promise.all(caps.map(async (c, i) => {
        const what = plan(i, q.n);
        if (what === null) return;
        const payload = q.choice
          ? { quizId, choice: what === 'right' ? q.right : (q.right + 1) % 4 }
          : { quizId, text: what === 'right' ? `Ответ${q.n}!` : 'не знаю' }; // регистр и знаки не важны
        const r = await call(c, 'team:answer', payload);
        expect(r.ok).toBe(true); accepted++;
        if ((i + q.n) % 4 === 0) expect((await call(c, 'team:answer', payload)).ok).toBe(true);  // повтор не дублирует
        if ((i + q.n) % 9 === 0) expect((await call(c, 'team:answer', q.choice ? { quizId, choice: (payload.choice + 1) % 4 } : { quizId, text: 'другое' })).reason).toBe('already_answered');
        const e = expected[i]; e.answered++;
        if (what === 'right') { const p = POINTS[q.diff]; e.score += p; e.correct++; e.blocks[q.block] = (e.blocks[q.block] ?? 0) + p; }
      }));
      await call(admin, 'a:quiz:close');
      // запоздавший ответ после закрытия не принимается (повтор уже принятого — только подтверждается, без новой записи)
      const before = Object.keys(srv.db.quiz.answers).length;
      const late = await call(caps[0], 'team:answer', q.choice ? { quizId, choice: 0 } : { quizId, text: 'поздно' });
      expect(late.ok ? 'confirmed' : late.reason).toMatch(/closed|already_answered|confirmed/);
      expect(Object.keys(srv.db.quiz.answers).length).toBe(before);
      await call(admin, 'a:quiz:reset');
      await new Promise((r) => setTimeout(r, 90)); // живой темп: человек не шлёт 40+ пакетов в секунду
    }

    // --- сверка с контрольным подсчётом ---
    const st = (await call(admin, 'a:state')).state;
    for (const [i, t] of teams.entries()) {
      const row = st.stats.find((x) => x.teamId === t.id);
      expect(srv.db.teams[i].score, `баллы команды ${i + 1}`).toBe(expected[i].score);
      expect(row.answered).toBe(expected[i].answered);
      expect(row.correct).toBe(expected[i].correct);
      for (let b = 1; b <= BLOCKS; b++) expect(row.perBlock[String(b)]?.points ?? 0, `блок ${b}, команда ${i + 1}`).toBe(expected[i].blocks[b] ?? 0);
    }
    // каждый принятый ответ сохранён ровно один раз
    const stored = srv.db.history.reduce((s, h) => s + h.answers.length, 0);
    expect(stored).toBe(accepted);
    expect(srv.db.history.length).toBe(BLOCKS * PER_BLOCK);
    for (const h of srv.db.history) expect(new Set(h.answers.map((a) => a.teamId)).size).toBe(h.answers.length);

    // рейтинг: по баллам, при равенстве — по времени верных ответов, иначе совместное место
    const board = st.pub.board;
    expect(board.length).toBe(TEAMS);
    for (let i = 1; i < board.length; i++) {
      const a = board[i - 1]; const b = board[i];
      expect(a.score).toBeGreaterThanOrEqual(b.score);
      if (a.score === b.score && a.timeMs != null && b.timeMs != null) expect(a.timeMs).toBeLessThanOrEqual(b.timeMs);
      expect(b.rank).toBeGreaterThanOrEqual(a.rank);
    }
    expect(board[0].rank).toBe(1);
    const sumScores = board.reduce((s, r) => s + r.score, 0);
    expect(sumScores).toBe(expected.reduce((s, e) => s + e.score, 0));

    // до объявления итогов участники не видят ни таблицы, ни чужих баллов
    const seen = [];
    caps[3].on('state', (x) => seen.push(x));
    await call(admin, 'a:display:set', { view: 'auto' });
    await new Promise((r) => setTimeout(r, 120));
    expect(seen.at(-1).board).toEqual([]);

    // последовательное раскрытие: всё от 30-го места до 1-го
    await call(admin, 'a:reveal:start', { mode: 'all' });
    for (let i = 0; i < TEAMS; i++) await call(admin, 'a:reveal:next');
    await new Promise((r) => setTimeout(r, 120));
    const rv = seen.at(-1).reveal;
    expect(rv).toMatchObject({ active: true, shown: TEAMS, total: TEAMS, done: true });
    expect(rv.rows.at(-1).rank).toBe(1);
    expect(rv.rows.map((r) => r.id)).toEqual([...board].reverse().map((r) => r.id).slice(-12)); // проектору уходят последние 12 строк
  }, 60000);

  it('результаты восстанавливаются после перезапуска и из резервной копии', async () => {
    const before = srv.db.teams.map((t) => [t.id, t.score]);
    const histLen = srv.db.history.length;
    const admin = await connect({ role: 'admin' });
    await call(admin, 'a:login', { password: 'pw1234' });
    const b = await call(admin, 'a:backup');
    expect(b.ok).toBe(true);
    await srv.close();
    // поднимаем новый сервер на тех же данных
    const dir = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('qa-full-')).map((f) => path.join(os.tmpdir(), f)).sort((a, c) => fs.statSync(c).mtimeMs - fs.statSync(a).mtimeMs)[0];
    srv = createQuizServer({ readSec: 0, port: 0, host: '127.0.0.1', staticDir: null, adminPassword: 'pw1234', dataFile: path.join(dir, 'state.json') });
    await srv.start();
    expect(srv.db.teams.map((t) => [t.id, t.score])).toEqual(before);
    expect(srv.db.history.length).toBe(histLen);
    // копия валидна и содержит те же результаты
    const copy = JSON.parse(fs.readFileSync(path.join(dir, 'backups', b.file), 'utf8'));
    expect(copy.teams.map((t) => [t.id, t.score])).toEqual(before);
  }, 30000);
});
