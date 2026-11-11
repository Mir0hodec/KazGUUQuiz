import { describe, it, expect, afterEach } from 'vitest';
import { io as connectIo } from 'socket.io-client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuizServer } from '../server/app.js';

const open = [];
const dirs = [];
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  for (const s of servers.splice(0)) await s.close();
});
const servers = [];

async function boot(opts = {}, dir) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
  dirs.push(dir);
  const srv = createQuizServer({ readSec: 0, port: 0, host: '127.0.0.1', staticDir: null, adminPassword: 'pw1234', dataFile: path.join(dir, 'state.json'), ...opts });
  await srv.start();
  servers.push(srv);
  return { srv, dir };
}
function client(srv, auth = {}) {
  const s = connectIo(`http://127.0.0.1:${srv.port}`, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  open.push(s);
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
/** Админ-сокет: подключение + вход по паролю. */
async function adminClient(srv, password = 'pw1234') {
  const s = await client(srv, { role: 'admin' });
  const r = await call(s, 'a:login', { password });
  if (!r.ok) throw new Error(`admin login failed: ${r.error}`);
  s.token = r.token;
  return s;
}
const call = (s, ev, p = {}) => new Promise((res) => s.emit(ev, p, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(n = 5, opts) {
  const ctx = await boot(opts);
  const admin = await adminClient(ctx.srv);
  await call(admin, 'a:teams:generate', { count: n });
  const teams = ctx.srv.db.teams;
  const caps = [];
  for (const t of teams) {
    const c = await client(ctx.srv);
    const r = await call(c, 'team:login', { team: t.id, pin: t.pin });
    expect(r.ok).toBe(true);
    caps.push(c);
  }
  return { ...ctx, admin, teams, caps };
}

describe('QUIZ ARENA', () => {
  it('30 одновременных нажатий → ровно один победитель, остальные в очереди без дублей', async () => {
    const { srv, admin, caps, teams } = await setup(30);
    const { roundId } = await call(admin, 'a:round:open');
    const acks = await Promise.all(caps.map((c) => call(c, 'team:buzz', { roundId, nonce: Math.random().toString(36) })));
    const firsts = acks.filter((a) => a.result === 'first');
    expect(firsts.length).toBe(1);
    const r = srv.db.round;
    expect(r.status).toBe('buzzed');
    expect(r.buzzes[0].kind).toBe('first');
    expect(new Set(r.buzzes.map((b) => b.teamId)).size).toBe(r.buzzes.length);
    expect(r.buzzes.map((b) => b.order)).toEqual(r.buzzes.map((_, i) => i + 1));
    expect(acks.every((a) => a.ok || ['late'].includes(a.reason))).toBe(true);
    // победитель = тот, чей ack 'first'
    const idx = acks.findIndex((a) => a.result === 'first');
    expect(r.buzzes[0].teamId).toBe(teams[idx].id);
    expect(srv.db.log.filter((e) => e.type === 'buzz.first').length).toBe(1);
  });

  it('повторное нажатие одной команды не меняет победителя и не дублируется', async () => {
    const { srv, admin, caps } = await setup(3);
    const { roundId } = await call(admin, 'a:round:open');
    const a1 = await call(caps[0], 'team:buzz', { roundId, nonce: 'n1' });
    const a2 = await call(caps[0], 'team:buzz', { roundId, nonce: 'n1' }); // replay того же nonce
    const a3 = await call(caps[0], 'team:buzz', { roundId, nonce: 'n2' }); // новое нажатие
    expect(a1.result).toBe('first');
    expect(a2).toEqual(a1);
    expect(a3.result).toBe('duplicate');
    expect(srv.db.round.buzzes.length).toBe(1);
  });

  it('нажатие при закрытом раунде отклоняется', async () => {
    const { srv, admin, caps } = await setup(2);
    const a = await call(caps[0], 'team:buzz', { roundId: null, nonce: 'x' });
    expect(a.ok).toBe(false);
    const { roundId } = await call(admin, 'a:round:open');
    await call(admin, 'a:round:lock');
    const b = await call(caps[0], 'team:buzz', { roundId, nonce: 'y' });
    expect(b).toMatchObject({ ok: false, reason: 'closed' });
    expect(srv.db.round.buzzes.length).toBe(0);
  });

  it('запоздавшее нажатие после окна очереди не принимается', async () => {
    const { srv, admin, caps } = await setup(3);
    await call(admin, 'a:settings:update', { queueWindowMs: 30 });
    const { roundId } = await call(admin, 'a:round:open');
    await call(caps[0], 'team:buzz', { roundId, nonce: 'a' });
    await sleep(80);
    const late = await call(caps[1], 'team:buzz', { roundId, nonce: 'b' });
    expect(late).toMatchObject({ ok: false, reason: 'late' });
    expect(srv.db.round.buzzes.length).toBe(1);
  });

  it('переподключение: состояние команды восстанавливается, старая сессия вытесняется', async () => {
    const { srv, admin, caps, teams } = await setup(2);
    await call(admin, 'a:score:set', { id: teams[0].id, score: 40 });
    caps[0].close();
    await sleep(100);
    expect(srv.db.teams[0].score).toBe(40);
    const c2 = await client(srv);
    let me;
    c2.on('me', (x) => { me = x; });
    const r = await call(c2, 'team:login', { team: teams[0].name, pin: teams[0].pin });
    expect(r.ok).toBe(true);
    await sleep(50);
    expect(me.score).toBe(40); // команда получает только свои очки
    // вторая сессия той же команды вытесняет первую
    const c3 = await client(srv);
    const kicked = new Promise((res) => c2.once('kicked', res));
    await call(c3, 'team:login', { team: teams[0].id, pin: teams[0].pin });
    expect((await kicked).reason).toBe('replaced');
    // неверный PIN
    const bad = await call(await client(srv), 'team:login', { team: teams[0].id, pin: '0000x' });
    expect(bad.ok).toBe(false);
  });

  it('команда не может выполнять админ-команды и подменять идентичность', async () => {
    const { srv, admin, caps, teams } = await setup(3);
    const denied = await call(caps[0], 'a:round:open');
    expect(denied).toEqual({ ok: false, error: 'forbidden' });
    expect((await call(caps[0], 'a:score:adjust', { id: teams[0].id, delta: 1000 })).ok).toBe(false);
    expect((await call(caps[0], 'a:teams:clear')).ok).toBe(false);
    expect(srv.db.teams.length).toBe(3);
    expect(srv.db.teams[0].score).toBe(0);
    expect(srv.db.round.status).toBe('idle');
    expect(srv.db.log.some((e) => e.type === 'security.denied')).toBe(true);
    // подмена teamId в нажатии игнорируется
    const { roundId } = await call(admin, 'a:round:open');
    await call(caps[0], 'team:buzz', { roundId, nonce: 'z', teamId: teams[2].id });
    expect(srv.db.round.buzzes[0].teamId).toBe(teams[0].id);
    // попытка стать админом чужим ключом
    const g = await client(srv);
    expect((await call(g, 'a:login', { password: 'wrong' })).ok).toBe(false);
    expect((await call(g, 'a:round:reset')).error).toBe('forbidden');
  });

  it('пароль админки: без входа прав нет, неверный пароль отклоняется, верный даёт доступ', async () => {
    const { srv } = await boot();
    const a = await client(srv, { role: 'admin' }); // даже с localhost без пароля прав нет
    expect((await call(a, 'a:round:open')).error).toBe('forbidden');
    expect((await call(a, 'a:login', { password: 'nope' })).ok).toBe(false);
    expect((await call(a, 'a:round:open')).error).toBe('forbidden');
    const r = await call(a, 'a:login', { password: 'pw1234' });
    expect(r.ok).toBe(true);
    expect((await call(a, 'a:round:open')).ok).toBe(true);
    // повторное подключение по токену, без пароля
    const b = await client(srv, { role: 'admin', token: r.token });
    expect((await call(b, 'a:state')).ok).toBe(true);
    const c = await client(srv, { role: 'admin', token: 'fake' });
    expect((await call(c, 'a:state')).error).toBe('forbidden');
    // пароль хранится хэшем, а не открытым текстом
    expect(JSON.stringify(srv.db.auth)).not.toContain('pw1234');
  });

  it('первичная установка пароля и его смена', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
    const srv = createQuizServer({ readSec: 0, port: 0, host: '127.0.0.1', staticDir: null, adminPassword: '', dataFile: path.join(dir, 'state.json') });
    await srv.start(); servers.push(srv);
    expect(srv.hasPassword).toBe(false);
    const a = await client(srv, { role: 'admin' });
    expect((await call(a, 'a:login', { password: 'x' })).setup).toBe(true);
    expect((await call(a, 'a:setup', { password: '12' })).ok).toBe(false); // слишком короткий
    const s1 = await call(a, 'a:setup', { password: 'secret1' });
    expect(s1.ok).toBe(true);
    expect((await call(a, 'a:setup', { password: 'again1' })).ok).toBe(false); // повторно нельзя
    expect((await call(a, 'a:round:open')).ok).toBe(true);
    const other = await adminClient(srv, 'secret1');
    expect((await call(other, 'a:password:change', { oldPassword: 'bad', newPassword: 'newpass1' })).ok).toBe(false);
    expect((await call(other, 'a:password:change', { oldPassword: 'secret1', newPassword: 'newpass1' })).ok).toBe(true);
    expect((await call(a, 'a:state')).error).toBe('forbidden'); // чужие сессии сброшены
    expect((await call(other, 'a:state')).ok).toBe(true);
    await expect(adminClient(srv, 'secret1')).rejects.toThrow();
    await adminClient(srv, 'newpass1');
    // пароль переживает перезапуск
    await srv.close(); servers.splice(servers.indexOf(srv), 1);
    const { srv: s2 } = await boot({ adminPassword: '' }, dir);
    expect(s2.hasPassword).toBe(true);
    await adminClient(s2, 'newpass1');
  });

  it('RESET и новый раунд: новый roundId, старые события отклоняются как stale', async () => {
    const { srv, admin, caps } = await setup(3);
    const o1 = await call(admin, 'a:round:open');
    await call(caps[0], 'team:buzz', { roundId: o1.roundId, nonce: '1' });
    await call(admin, 'a:round:judge', { correct: true });
    expect(srv.db.teams[0].score).toBe(10);
    expect(srv.db.tournament.question).toBe(1);
    await call(admin, 'a:round:reset');
    expect(srv.db.round.status).toBe('idle');
    expect(srv.db.round.buzzes.length).toBe(0);
    expect(srv.db.tournament.question).toBe(2);
    const o2 = await call(admin, 'a:round:open');
    expect(o2.roundId).not.toBe(o1.roundId);
    const stale = await call(caps[1], 'team:buzz', { roundId: o1.roundId, nonce: '2' });
    expect(stale).toMatchObject({ ok: false, reason: 'stale' });
    const ok = await call(caps[1], 'team:buzz', { roundId: o2.roundId, nonce: '3' });
    expect(ok.result).toBe('first');
  });

  it('неверный ответ: передача следующему претенденту и повторное открытие', async () => {
    const { srv, admin, caps, teams } = await setup(3);
    await call(admin, 'a:settings:update', { wrongPoints: -5 });
    const { roundId } = await call(admin, 'a:round:open');
    await call(caps[0], 'team:buzz', { roundId, nonce: 'a' });
    await call(caps[1], 'team:buzz', { roundId, nonce: 'b' });
    await call(admin, 'a:round:judge', { correct: false });
    expect(srv.db.teams[0].score).toBe(-5);
    expect((await call(admin, 'a:round:pass')).ok).toBe(true);
    expect(srv.db.round.buzzes[srv.db.round.answererIdx].teamId).toBe(teams[1].id);
    await call(admin, 'a:round:judge', { correct: false });
    expect((await call(admin, 'a:round:pass')).ok).toBe(false); // претендентов больше нет
    const o2 = await call(admin, 'a:round:open');
    const ex = await call(caps[0], 'team:buzz', { roundId: o2.roundId, nonce: 'c' });
    expect(ex.reason).toBe('excluded');
    expect((await call(caps[2], 'team:buzz', { roundId: o2.roundId, nonce: 'd' })).result).toBe('first');
  });

  it('данные сохраняются после перезапуска сервера', async () => {
    const { srv, admin, dir } = await setup(4);
    const pins = srv.db.teams.map((t) => t.pin);
    await call(admin, 'a:score:set', { id: srv.db.teams[1].id, score: 77 });
    await call(admin, 'a:settings:update', { tournamentName: 'Турнир школы', round: 3, question: 7 });
    const { roundId } = await call(admin, 'a:round:open');
    await call(await client(srv).then(async (c) => { await call(c, 'team:login', { team: srv.db.teams[0].id, pin: pins[0] }); return c; }), 'team:buzz', { roundId, nonce: 'p' });
    await srv.close();
    servers.splice(servers.indexOf(srv), 1);

    const { srv: s2 } = await boot({}, dir);
    expect(s2.db.teams.map((t) => t.pin)).toEqual(pins);
    expect(s2.db.teams[1].score).toBe(77);
    expect(s2.db.tournament).toMatchObject({ name: 'Турнир школы', round: 3, question: 7 });
    expect(s2.db.log.some((e) => e.type === 'buzz.first')).toBe(true);
    expect(s2.db.round.buzzes[0].kind).toBe('first');
  });

  it('CSV экспорт требует прав и защищён от формул', async () => {
    const { srv, admin } = await setup(2);
    await call(admin, 'a:team:create', { name: '=SUM(A1)' });
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/export/results.csv`, { headers: { 'x-admin-token': admin.token } });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("'=SUM(A1)");
    expect((await fetch(`http://127.0.0.1:${srv.port}/api/export/results.csv`)).status).toBe(403); // без токена нельзя
    expect((await fetch(`http://127.0.0.1:${srv.port}/api/export/results.csv`, { headers: { 'x-admin-token': 'bad' } })).status).toBe(403);
  });

  it('письменные ответы: отправка, правка, закрытие, оценка и сброс', async () => {
    const { srv, admin, caps, teams } = await setup(3);
    expect((await call(caps[0], 'a:quiz:open', { question: 'x' })).error).toBe('forbidden');
    const { quizId } = await call(admin, 'a:quiz:open', { question: 'Столица Франции?' });
    expect(srv.db.quiz.question).toBe('Столица Франции?');
    expect(await call(caps[0], 'team:answer', { quizId, text: '   ' })).toMatchObject({ ok: false, reason: 'empty' });
    expect((await call(caps[0], 'team:answer', { quizId: 'old', text: 'a' })).reason).toBe('stale');
    expect((await call(caps[0], 'team:answer', { quizId, text: 'Лондон' })).ok).toBe(true);
    expect((await call(caps[0], 'team:answer', { quizId, text: 'Париж' })).reason).toBe('already_answered');
    expect((await call(caps[0], 'team:answer', { quizId, text: 'Лондон' })).ok).toBe(true); // повтор того же текста идемпотентен
    await call(caps[1], 'team:answer', { quizId, text: 'Париж' });
    expect(Object.keys(srv.db.quiz.answers).length).toBe(2);
    expect(srv.db.quiz.answers[teams[0].id].text).toBe('Лондон');
    await call(admin, 'a:quiz:close');
    expect((await call(caps[2], 'team:answer', { quizId, text: 'Рим' })).reason).toBe('closed');
    await call(admin, 'a:quiz:markall', { text: 'париж', correct: true });
    expect(srv.db.teams[0].score).toBe(0);
    expect(srv.db.teams[1].score).toBe(10);
    await call(admin, 'a:quiz:mark', { teamId: teams[1].id, correct: false }); // переоценка не дублирует баллы
    expect(srv.db.teams[1].score).toBe(0);
    // восстановление ответа при повторном входе
    const c = await client(srv);
    const login = await call(c, 'team:login', { team: teams[0].id, pin: teams[0].pin });
    expect(login.answer).toBe('Лондон');
    await call(admin, 'a:quiz:reset');
    expect(srv.db.quiz.status).toBe('idle');
    expect(srv.db.tournament.question).toBe(2);
  });

  it('таймеры: автозакрытие кнопок и ответов, таймер на ответ команды, продление', async () => {
    const { srv, admin, caps } = await setup(2);
    await call(admin, 'a:settings:update', { openSec: 1, quizSec: 1, answerSec: 30 });
    const o = await call(admin, 'a:round:open');
    expect(srv.db.round.timer.kind).toBe('open');
    await sleep(1250);
    expect(srv.db.round.status).toBe('locked');
    expect(await call(caps[0], 'team:buzz', { roundId: o.roundId, nonce: 'a' })).toMatchObject({ ok: false, reason: 'closed' });
    expect(srv.db.log.some((e) => e.type === 'round.autolock')).toBe(true);

    await call(admin, 'a:settings:update', { openSec: 0 });
    const o2 = await call(admin, 'a:round:open');
    expect(srv.db.round.timer).toBe(null);
    await call(caps[0], 'team:buzz', { roundId: o2.roundId, nonce: 'b' });
    expect(srv.db.round.timer).toMatchObject({ kind: 'answer', durationMs: 30000 });
    const before = srv.db.round.timer.endsAt;
    await call(admin, 'a:timer:add', { seconds: 10 });
    expect(srv.db.round.timer.endsAt - before).toBe(10000);
    expect((await call(caps[0], 'a:timer:add', { seconds: 99 })).error).toBe('forbidden');
    await call(admin, 'a:round:judge', { correct: true });
    expect(srv.db.round.timer).toBe(null);

    const { quizId } = await call(admin, 'a:quiz:open', { question: 'q' });
    expect(srv.db.quiz.timer.kind).toBe('quiz');
    await sleep(1250);
    expect(srv.db.quiz.status).toBe('closed');
    expect((await call(caps[1], 'team:answer', { quizId, text: 'x' })).reason).toBe('closed');
  });

  it('отмена оценки возвращает баллы и право ответа', async () => {
    const { srv, admin, caps } = await setup(2);
    const { roundId } = await call(admin, 'a:round:open');
    await call(caps[0], 'team:buzz', { roundId, nonce: 'u' });
    await call(admin, 'a:round:judge', { correct: true });
    expect(srv.db.teams[0].score).toBe(10);
    expect((await call(caps[0], 'a:round:undo')).error).toBe('forbidden');
    expect((await call(admin, 'a:round:undo')).ok).toBe(true);
    expect(srv.db.teams[0].score).toBe(0);
    expect(srv.db.round.status).toBe('buzzed');
    await call(admin, 'a:round:judge', { correct: false });
    expect(srv.db.round.excluded).toContain(srv.db.teams[0].id);
    await call(admin, 'a:round:undo');
    expect(srv.db.round.excluded).not.toContain(srv.db.teams[0].id);
    expect((await call(admin, 'a:round:undo')).ok).toBe(false); // нечего отменять
  });

  it('флуд с одного сокета ограничивается, сервер продолжает работать', async () => {
    const { srv, caps } = await setup(2);
    for (let i = 0; i < 300; i++) caps[0].emit('sys:ping', {});
    await sleep(300);
    expect(srv.db.log.some((e) => e.type === 'security.flood')).toBe(true);
    expect((await call(caps[1], 'sys:ping', {})) > 0).toBe(true); // другие клиенты не затронуты
  });

  it('турниры: создание со своими командами и вопросами, переключение, изоляция данных, удаление', async () => {
    const { srv, admin, caps, teams } = await setup(3);
    await call(admin, 'a:score:set', { id: teams[0].id, score: 50 });
    const kicked = new Promise((res) => caps[0].once('kicked', res));
    const c = await call(admin, 'a:tournament:create', {
      name: 'Школьный кубок', teamNames: 'Орлы\nСоколы\n  Орлы  \nЯстребы', correctPoints: 5, quizSec: 20,
      questions: '2+2? | 4\nСтолица Франции?|Париж\n\nБез ответа', showQuestion: true,
    });
    expect(c.ok).toBe(true);
    expect((await kicked).reason).toBe('tournament');
    expect(srv.db.activeId).toBe(c.id);
    expect(srv.db.teams.map((t) => t.name)).toEqual(['Орлы', 'Соколы', 'Ястребы']); // дубли убраны
    expect(srv.db.settings).toMatchObject({ correctPoints: 5, quizSec: 20, showQuestion: true });
    expect(srv.db.questions.map(({ q, a }) => ({ q, a }))).toEqual([{ q: '2+2?', a: '4' }, { q: 'Столица Франции?', a: 'Париж' }, { q: 'Без ответа', a: '' }]);
    expect(srv.db.teams.every((t) => t.score === 0)).toBe(true);
    // старые капитаны не могут войти в новый турнир со своим PIN
    const old = await client(srv);
    expect((await call(old, 'team:login', { team: teams[0].id, pin: teams[0].pin })).ok).toBe(false);
    // вопрос подставляется из списка, ответ виден только ведущему
    await call(admin, 'a:quiz:open', {});
    expect(srv.db.quiz.question).toBe('2+2?');
    const st = (await call(admin, 'a:state')).state;
    expect(JSON.stringify(st.pub)).not.toContain('Париж');
    expect(st.questions[1].a).toBe('Париж'); // а ведущему ответ виден
    await call(admin, 'a:quiz:reset');
    expect(srv.db.tournament.question).toBe(1); // никто не отвечал — номер не растёт
    // первый турнир сохранился нетронутым, журналы раздельны
    expect(srv.db.tournaments[Object.keys(srv.db.tournaments)[0]].teams[0].score).toBe(50);
    const list = (await call(admin, 'a:state')).state.tournaments;
    expect(list.length).toBe(2);
    expect((await call(admin, 'a:tournament:delete', { id: c.id })).ok).toBe(false); // активный
    const firstId = list.find((t) => !t.active).id;
    await call(admin, 'a:tournament:activate', { id: firstId });
    expect(srv.db.teams[0].score).toBe(50);
    expect(srv.db.log.some((e) => e.type === 'tournament.create')).toBe(true);
    expect((await call(admin, 'a:tournament:delete', { id: c.id })).ok).toBe(true);
    expect(Object.keys(srv.db.tournaments).length).toBe(0);
    expect((await call(await client(srv), 'a:tournament:create', { name: 'x' })).error).toBe('forbidden'); // команде нельзя
  });

  it('турниры: копирование и сохранение после перезапуска', async () => {
    const { srv, admin, dir } = await setup(4);
    const cp = await call(admin, 'a:tournament:create', { copyFrom: srv.db.activeId, name: 'Копия', activate: false });
    expect(srv.db.tournaments[cp.id].teams.length).toBe(4);
    expect(srv.db.tournaments[cp.id].teams[0].pin).not.toBe(srv.db.teams[0].pin); // новые PIN
    await call(admin, 'a:tournament:activate', { id: cp.id });
    await call(admin, 'a:settings:update', { tournamentName: 'Финал', question: 5 });
    const { activeId } = srv.db;
    await srv.close(); servers.splice(servers.indexOf(srv), 1);
    const { srv: s2 } = await boot({}, dir);
    expect(s2.db.activeId).toBe(activeId);
    expect(s2.db.tournament).toMatchObject({ name: 'Финал', question: 5 });
    expect(Object.values(s2.db.tournaments)[0].teams.length).toBe(4);
    expect(s2.db.log.some((e) => e.type === 'tournament.create')).toBe(false); // журнал активного отделён от старого
  });

  it('демо создаётся отдельным турниром и не затирает настоящий', async () => {
    const { srv, admin, teams } = await setup(3);
    const realId = srv.db.activeId;
    await call(admin, 'a:demo:start');
    expect(srv.db.demo).toBe(true);
    expect(srv.db.teams.length).toBe(30);
    expect(srv.db.questions.length).toBeGreaterThan(0);
    expect(srv.db.tournaments[realId].teams.map((t) => t.id)).toEqual(teams.map((t) => t.id));
    // демо сразу играбельно: вопрос открывается, ответы принимаются
    expect((await call(admin, 'a:quiz:open')).ok).toBe(true);
    expect(srv.db.quiz.status).toBe('open');
  });

  it('автопрограмма: вопрос → пауза → следующий вопрос, автооценка по ответу из списка, остановка', async () => {
    const { srv, admin, caps, teams } = await setup(3);
    await call(admin, 'a:settings:update', { quizSec: 1, pauseSec: 1 });
    await call(admin, 'a:questions:set', { text: '2+2? | 4 / четыре\nСтолица Франции? | Париж' });
    expect((await call(caps[0], 'a:auto:start')).error).toBe('forbidden');
    await call(admin, 'a:settings:update', { quizSec: 0 });
    expect((await call(admin, 'a:auto:start')).ok).toBe(false); // без таймера вопрос не закончится
    await call(admin, 'a:settings:update', { quizSec: 1 });
    expect((await call(admin, 'a:auto:start')).ok).toBe(true);
    expect((await call(admin, 'a:auto:start')).ok).toBe(false); // уже идёт
    const quizId = srv.db.quiz.id;
    expect(srv.db.quiz.question).toBe('2+2?');
    await call(caps[0], 'team:answer', { quizId, text: 'Четыре!' });
    await call(caps[1], 'team:answer', { quizId, text: '5' });
    await sleep(1250); // время вышло → пауза
    expect(srv.db.quiz.status).toBe('closed');
    expect(srv.db.quiz.timer.kind).toBe('pause');
    expect(srv.db.teams[0].score).toBe(10);  // «Четыре!» совпало с вариантом «четыре»
    expect(srv.db.teams[1].score).toBe(0);
    expect(srv.db.quiz.answers[teams[1].id].verdict).toBe(false);
    expect(srv.db.teams[2].score).toBe(0);   // не ответила — не оценивается
    await call(admin, 'a:timer:add', { seconds: 1 }); // паузу можно продлить
    await sleep(1300);
    expect(srv.db.quiz.status).toBe('closed'); // продлили — ещё пауза
    await sleep(1200);                          // следующий вопрос открылся сам
    expect(srv.db.tournament.question).toBe(2);
    expect(srv.db.quiz.status).toBe('open');
    expect(srv.db.quiz.question).toBe('Столица Франции?');
    await sleep(1250); // второй вопрос закончился → пауза → список кончился
    await sleep(1250);
    expect(srv.db.quiz.status).toBe('idle');
    expect(srv.db.displayView).toBe('closing'); // итоги скрыты, пока ведущий их не откроет
    expect(srv.db.log.some((e) => e.type === 'auto.stop' && e.data.reason === 'list-end')).toBe(true);
    // ручной RESET останавливает автопрограмму
    await call(admin, 'a:settings:update', { question: 1 });
    await call(admin, 'a:auto:start');
    await call(admin, 'a:quiz:reset');
    expect(srv.db.log.filter((e) => e.type === 'auto.stop').pop().data.reason).toBe('manual-reset');
  });

  it('автопроведение BUZZ: открытие, таймаут ответа, передача, верный ответ, пустой раунд, итоги', async () => {
    const { srv, admin, caps, teams } = await setup(3);
    await call(admin, 'a:settings:update', { openSec: 1, answerSec: 1, pauseSec: 1, resultSec: 0 });
    await call(admin, 'a:questions:set', { text: 'Первый?\nВторой?\nТретий?' });
    expect((await call(caps[0], 'a:auto:start', { mode: 'buzz', allowBuzz: true })).error).toBe('forbidden');
    await call(admin, 'a:settings:update', { openSec: 0 });
    expect((await call(admin, 'a:auto:start', { mode: 'buzz', allowBuzz: true })).ok).toBe(false); // без таймера кнопок раунд не завершится
    await call(admin, 'a:settings:update', { openSec: 1 });
    expect((await call(admin, 'a:auto:start', { mode: 'buzz', allowBuzz: true })).ok).toBe(true);
    expect(srv.db.round.status).toBe('open');
    // вопрос 1: две команды нажали, ведущий молчит → таймаут неверно, право переходит, снова таймаут
    let rid = srv.db.round.id;
    await call(caps[0], 'team:buzz', { roundId: rid, nonce: 'a' });
    await call(caps[1], 'team:buzz', { roundId: rid, nonce: 'b' });
    await sleep(1300);
    expect(srv.db.round.buzzes[srv.db.round.answererIdx].teamId).toBe(teams[1].id);
    expect(srv.db.round.status).toBe('buzzed');
    await sleep(1300);
    expect(srv.db.round.timer.kind).toBe('pause');
    await sleep(1250);
    expect(srv.db.tournament.question).toBe(2);
    expect(srv.db.round.status).toBe('open');
    // вопрос 2: ведущий оценил «верно» → сразу пауза (resultSec=0)
    rid = srv.db.round.id;
    await call(caps[2], 'team:buzz', { roundId: rid, nonce: 'c' });
    await call(admin, 'a:round:judge', { correct: true });
    expect(srv.db.teams[2].score).toBe(10);
    expect(srv.db.round.timer.kind).toBe('pause');
    await sleep(1250);
    expect(srv.db.tournament.question).toBe(3);
    // вопрос 3 (последний): никто не нажал → автозакрытие → сразу конец списка, без паузы «до вопроса 4»
    await sleep(1400);
    expect(srv.db.displayView).toBe('closing'); // итоги скрыты, пока ведущий их не откроет
    const pub = (await call(admin, 'a:state')).state.pub;
    expect(pub.auto).toMatchObject({ running: false, finished: true });
    expect(srv.db.log.some((e) => e.type === 'auto.timeout')).toBe(true);
    expect(srv.db.log.some((e) => e.type === 'auto.stop' && e.data.reason === 'list-end' && e.data.mode === 'buzz')).toBe(true);
  });

  it('простая панель: «Стоп» посреди вопроса и повторный старт; «Сыграть заново» обнуляет игру', async () => {
    const { srv, admin, caps, teams } = await setup(2);
    await call(admin, 'a:settings:update', { quizSec: 30, pauseSec: 1 });
    await call(admin, 'a:questions:set', { text: 'Один? | 1\nДва? | 2' });
    expect((await call(admin, 'a:auto:start', { mode: 'quiz', clean: true })).ok).toBe(true);
    await call(caps[0], 'team:answer', { quizId: srv.db.quiz.id, text: '1' });
    await call(admin, 'a:auto:stop');
    expect(srv.db.quiz.status).toBe('open'); // «Стоп» не закрывает вопрос
    expect((await call(admin, 'a:auto:start', { mode: 'quiz' })).ok).toBe(false); // без clean — как раньше, нужен RESET
    expect((await call(admin, 'a:auto:start', { mode: 'quiz', clean: true })).ok).toBe(true);
    expect(srv.db.tournament.question).toBe(2); // вопрос с ответами считается сыгранным
    await call(admin, 'a:auto:stop');
    srv.db.teams[0].score = 7;
    expect((await call(admin, 'a:game:restart')).ok).toBe(true);
    expect(srv.db.tournament.question).toBe(1);
    expect(srv.db.teams.every((t) => t.score === 0)).toBe(true);
    expect(srv.db.history).toEqual([]);
    expect(srv.db.quiz.status).toBe('idle');
    expect(srv.db.teams.map((t) => t.id)).toEqual(teams.map((t) => t.id)); // команды и PIN на месте
    expect((await call(caps[0], 'a:game:restart')).error).toBe('forbidden');
    expect((await call(admin, 'a:auto:start', { mode: 'quiz', clean: true })).ok).toBe(true);
    expect(srv.db.quiz.question).toBe('Один?');
  });

  it('автоматическое награждение: тройка каждой лиги по очереди, затем общий зачёт; общий топ по всем командам', async () => {
    const { srv } = await boot({ ceremonyTiming: { intro: 30, step: 30, hold: 30 } });
    const admin = await adminClient(srv);
    const names = ['J1 | junior', 'J2 | junior', 'M1 | middle', 'M2 | middle', 'S1 | senior'].join('\n');
    expect((await call(admin, 'a:tournament:create', { name: 'Награды', teamNames: names, ageMode: true, questions: 'Q? | a' })).ok).toBe(true);
    srv.db.teams.forEach((t, i) => { t.score = 10 - i; });
    // общий зачёт: все 5 команд
    expect((await call(admin, 'a:age:results', { age: 'all' })).ok).toBe(true);
    expect((await call(admin, 'a:state')).state.pub.board.length).toBe(5);
    await call(admin, 'a:age:results', { age: 'middle' });
    expect((await call(admin, 'a:state')).state.pub.board.map((r) => r.name)).toEqual(['M1', 'M2']);
    // награждение
    const seen = [];
    expect((await call(admin, 'a:ceremony:start')).ok).toBe(true);
    for (let i = 0; i < 80 && srv.db.log.every((e) => e.type !== 'ceremony.done'); i++) {
      const g = (await call(admin, 'a:state')).state.pub.ceremony.group;
      if (g && seen[seen.length - 1] !== g) seen.push(g);
      await sleep(15);
    }
    expect(seen).toEqual(['junior', 'middle', 'senior', 'all']);
    expect(srv.db.displayView).toBe('leaderboard');
    expect((await call(admin, 'a:state')).state.pub.board.length).toBe(5);
    expect((await call(admin, 'a:state')).state.pub.ceremony.running).toBe(false);
    // ручное действие останавливает награждение
    await call(admin, 'a:ceremony:start');
    await call(admin, 'a:display:set', { view: 'leaderboard' });
    expect((await call(admin, 'a:state')).state.pub.ceremony.running).toBe(false);
  });

  it('автоигра письменная: без allowBuzz режим кнопки не включается; ответили все — вопрос закрывается сразу', async () => {
    const { srv, admin, caps } = await setup(2);
    await call(admin, 'a:settings:update', { quizSec: 60, pauseSec: 30 });
    await call(admin, 'a:questions:set', { text: 'Один? | 1\nДва? | 2' });
    expect((await call(admin, 'a:auto:start', { mode: 'buzz', clean: true })).ok).toBe(true);
    expect(srv.db.quiz.status).toBe('open'); // письменный, а не кнопки
    expect(srv.db.round.status).toBe('idle');
    const qid = srv.db.quiz.id;
    await call(caps[0], 'team:answer', { quizId: qid, text: '1' });
    await sleep(1200);
    expect(srv.db.quiz.status).toBe('open'); // ждём вторую команду
    await call(caps[1], 'team:answer', { quizId: qid, text: '2' });
    await sleep(1300);
    expect(srv.db.quiz.status).toBe('closed'); // не ждали 60 секунд
    expect(srv.db.teams[0].score).toBeGreaterThan(0);
  });

  it('через туннель (заголовки Cloudflare) первый пароль задать нельзя, с ноутбука — можно', async () => {
    const { srv } = await boot({ adminPassword: '' });
    const ask = (headers) => new Promise((res) => {
      const c = connectIo(`http://127.0.0.1:${srv.port}`, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { role: 'admin' }, extraHeaders: headers });
      open.push(c); c.on('auth:required', res);
    });
    expect((await ask({})).canSetup).toBe(true);
    expect((await ask({ 'cf-connecting-ip': '8.8.8.8' })).canSetup).toBe(false);
    expect((await ask({ host: 'abc-def.trycloudflare.com' })).canSetup).toBe(false);
  });

  it('повтор того же ответа после закрытия приёма подтверждается (телефон не получил ack), другой — нет', async () => {
    const { srv, admin, caps } = await setup(2);
    await call(admin, 'a:quiz:open', { question: 'Q?' });
    const qid = srv.db.quiz.id;
    expect((await call(caps[0], 'team:answer', { quizId: qid, text: 'ответ' })).ok).toBe(true);
    await call(admin, 'a:quiz:close');
    expect((await call(caps[0], 'team:answer', { quizId: qid, text: 'ответ' })).ok).toBe(true);
    expect((await call(caps[0], 'team:answer', { quizId: qid, text: 'другой' })).reason).toBe('already_answered');
    expect((await call(caps[1], 'team:answer', { quizId: qid, text: 'поздно' })).reason).toBe('closed');
    expect(Object.keys(srv.db.quiz.answers)).toHaveLength(1);
  });

  it('баг-ресерч: удалённая команда, лига без команд, кнопки поверх вопроса, импорт без «*»', async () => {
    const { srv } = await boot();
    const L = (ev, p = {}) => { try { return { ok: true, ...srv.local(ev, p) }; } catch (e) { return { ok: false, error: e.message }; } };
    // 1) удалили ответившую команду — автоигра идёт дальше
    L('a:tournament:create', { name: 'A', teamCount: 3, questions: 'A? | a\nB? | b', quizSec: 1, pauseSec: 0 });
    L('a:auto:start', { mode: 'quiz', clean: true });
    const t = srv.db.teams[0];
    srv.db.quiz.answers[t.id] = { teamId: t.id, teamName: t.name, text: 'a', choice: null, ts: Date.now(), mono: 1, verdict: null, points: 0 };
    expect(L('a:team:delete', { id: t.id }).ok).toBe(true);
    await sleep(1500);
    expect(srv.db.tournament.question).toBe(2);
    expect(srv.db.quiz.status).toBe('open');
    L('a:auto:stop');
    // 4) кнопки поверх письменного вопроса нельзя
    expect(L('a:round:open').error).toMatch(/письменный вопрос/);
    // 5) импорт вариантов без «*» — предупреждение
    L('a:quiz:reset');
    expect(L('a:questions:set', { text: 'A? | x; y\nB? | p; q*' }).noCorrect).toBe(1);
    // 2–3) лиги: Juniors без команд, Middles без команд — играют только Seniors
    L('a:tournament:create', { name: 'B', teamNames: 'S1 | senior', ageMode: true, questions: 'J? | a', quizSec: 1, pauseSec: 0 });
    for (const age of ['middle', 'senior']) { L('a:age:activate', { age }); L('a:questions:set', { text: `${age}? | b` }); }
    L('a:age:activate', { age: 'junior' });
    expect(L('a:auto:start', { mode: 'quiz', clean: true }).ok).toBe(true);
    expect(srv.db.tournament.age).toBe('senior');
    await sleep(1500);
    expect(L('a:state').state.pub.auto.finished).toBe(true);
  });

  it('лимит входа: через туннель ошибки одной команды не блокируют другие; блокировка растёт', async () => {
    const { srv, teams } = await setup(2);
    const tunnelClient = (ip) => new Promise((res) => { const c = connectIo(`http://127.0.0.1:${srv.port}`, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { 'cf-connecting-ip': ip } }); open.push(c); c.on('connect', () => res(c)); });
    const a = await tunnelClient('5.5.5.5');
    for (let i = 0; i < 8; i++) await call(a, 'team:login', { team: teams[0].id, pin: '0000' });
    expect((await call(a, 'team:login', { team: teams[0].id, pin: teams[0].pin })).error).toMatch(/Подождите/);
    // другая команда с того же адреса и другой телефон — входят
    expect((await call(a, 'team:login', { team: teams[1].id, pin: teams[1].pin })).ok).toBe(true);
    const b = await tunnelClient('6.6.6.6');
    expect((await call(b, 'team:login', { team: teams[0].id, pin: teams[0].pin })).ok).toBe(true);
    // ведущий на ноутбуке не страдает от подбора пароля через туннель
    const evil = await tunnelClient('7.7.7.7');
    for (let i = 0; i < 6; i++) await call(evil, 'a:login', { password: 'wrong' });
    expect((await call(evil, 'a:login', { password: 'pw1234' })).error).toMatch(/Слишком много/);
    const host = await client(srv, { role: 'admin' });
    expect((await call(host, 'a:login', { password: 'pw1234' })).ok).toBe(true);
  });

  it('лиги по кругу: перерыв между блоками срабатывает один раз', async () => {
    const { srv } = await boot();
    const L = (ev, p = {}) => srv.local(ev, p);
    L('a:tournament:create', { name: 'Блоки', teamNames: 'J | junior\nM | middle', ageMode: true, questions: 'J1? | a | | | | 1\nJ2? | a | | | | 2', quizSec: 1, pauseSec: 0, blockBreak: true });
    L('a:age:activate', { age: 'middle' }); L('a:questions:set', { text: 'M1? | a | | | | 1\nM2? | a | | | | 2' }); L('a:age:activate', { age: 'junior' });
    L('a:auto:start', { mode: 'quiz', clean: true });
    let breaks = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      const a = L('a:state').state.pub.auto;
      if (a.phase === 'blockbreak') { breaks++; L('a:auto:resume'); }
      if (!a.running) break;
    }
    expect(breaks).toBe(1);
    expect(L('a:state').state.pub.auto.finished).toBe(true);
  });

  it('чтение вопроса: ответы закрыты, пока ведущий читает; потом приём сам; «открыть сейчас» пропускает чтение', async () => {
    const { srv, admin, caps } = await setup(2, { readSec: 1 });
    await call(admin, 'a:settings:update', { quizSec: 30 });
    await call(admin, 'a:questions:set', { text: 'Первый? | да\nВторой? | нет' });
    await call(admin, 'a:quiz:open');
    const st = (await call(admin, 'a:state')).state.pub;
    expect(st.quiz).toMatchObject({ status: 'open', reading: true });
    expect(st.timer.kind).toBe('read');
    expect((await call(caps[0], 'team:answer', { quizId: srv.db.quiz.id, text: 'да' })).reason).toBe('reading');
    await sleep(1150);
    const st2 = (await call(admin, 'a:state')).state.pub;
    expect(st2.quiz.reading).toBe(false);
    expect(st2.timer.kind).toBe('quiz');
    expect((await call(caps[0], 'team:answer', { quizId: srv.db.quiz.id, text: 'да' })).ok).toBe(true);
    expect(srv.db.quiz.answers[srv.db.teams[0].id].mono).toBeLessThan(500); // время ответа — от старта приёма, а не от показа вопроса
    await call(admin, 'a:quiz:close'); await call(admin, 'a:quiz:reset');
    await call(admin, 'a:quiz:open');
    expect(srv.db.quiz.reading).toBe(true);
    expect((await call(admin, 'a:quiz:start')).ok).toBe(true);
    expect(srv.db.quiz.reading).toBe(false);
    expect((await call(admin, 'a:quiz:start')).ok).toBe(false);
    // повторное открытие закрытого вопроса — без нового чтения
    await call(admin, 'a:quiz:close'); await call(admin, 'a:quiz:open');
    expect(srv.db.quiz.reading).toBe(false);
  });

  it('продление этапа чтения не отменяет автозапуск приёма ответов', async () => {
    const { srv, admin } = await setup(2, { readSec: 1 });
    await call(admin, 'a:questions:set', { text: 'Первый? | да' });
    await call(admin, 'a:quiz:open');
    expect(srv.db.quiz.reading).toBe(true);
    expect(srv.db.quiz.timer.kind).toBe('read');
    // «Добавить 10 секунд» и «-» используют один и тот же обработчик; -1 сокращает чтение до 0,5 с
    expect((await call(admin, 'a:timer:add', { seconds: -1 })).ok).toBe(true);
    await sleep(1200);
    expect(srv.db.quiz.reading).toBe(false);
    expect(srv.db.quiz.status).toBe('open');
    expect(srv.db.quiz.timer.kind).toBe('quiz');
  });

  it('адрес для QR сохраняется после перезапуска сервера', async () => {
    const { srv, dir } = await boot();
    srv.local('a:join:set', { base: 'https://quiz.example.com' });
    await srv.close(); servers.splice(servers.indexOf(srv), 1);
    const { srv: again } = await boot({}, dir);
    expect(again.db.joinBase).toBe('https://quiz.example.com');
  });

  it('QR на проектор и адрес для входа: экран qr, сохранённый адрес виден всем, команды капитана запрещены', async () => {
    const { srv, admin, caps } = await setup(2);
    expect((await call(admin, 'a:display:set', { view: 'qr' })).ok).toBe(true);
    expect(srv.db.displayView).toBe('qr');
    expect((await call(admin, 'a:join:set', { base: 'http://192.168.1.10:3000/' })).ok).toBe(true);
    const disp = await client(srv);
    const got = new Promise((r) => disp.once('state', r));
    await call(admin, 'a:display:set', { view: 'qr' }); // свежая рассылка после подписки
    const st = await got;
    expect(st.joinBase).toBe('http://192.168.1.10:3000');
    expect(st.displayView).toBe('qr');
    expect((await call(admin, 'a:join:set', { base: 'javascript:alert(1)' })).ok).toBe(false);
    expect((await call(caps[0], 'a:join:set', { base: 'http://evil:1' })).error).toBe('forbidden');
    expect((await call(caps[0], 'a:display:set', { view: 'qr' })).error).toBe('forbidden');
    expect(srv.local('a:tournament:create', { name: 'Локально', teamCount: 3 }).id).toBeTruthy();
    expect(srv.db.tournament.name).toBe('Локально');
  });

  it('результаты скрыты от участников до действия ведущего; команда видит только свои очки', async () => {
    const { srv, admin, caps, teams } = await setup(3);
    const seen = [];
    caps[0].on('state', (x) => seen.push(x));
    let me;
    caps[0].on('me', (x) => { me = x; });
    await call(admin, 'a:score:set', { id: teams[1].id, score: 70 });
    await call(admin, 'a:score:set', { id: teams[0].id, score: 30 });
    await sleep(100);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((x) => x.board.length === 0)).toBe(true);   // нет таблицы
    expect(JSON.stringify(seen)).not.toContain('"score":70');      // нет чужих баллов
    expect(me.score).toBe(30);
    expect((await call(admin, 'a:state')).state.pub.board.length).toBe(3); // у админа есть
    await call(admin, 'a:display:set', { view: 'leaderboard' });
    await sleep(100);
    expect(seen.at(-1).board.map((b) => b.score)).toEqual([70, 30, 0]);
    expect(seen.at(-1).board[0].timeMs).toBeUndefined();            // служебные поля не уходят
    await call(admin, 'a:display:set', { view: 'auto' });
    await sleep(100);
    expect(seen.at(-1).board.length).toBe(0);                       // снова скрыто
  });

  it('при равенстве баллов выше команда с меньшим суммарным временем верных ответов, иначе совместное место', async () => {
    const { srv, admin, caps, teams } = await setup(4);
    await call(admin, 'a:questions:set', { text: 'Q1? | да\nQ2? | да' });
    for (let n = 1; n <= 2; n++) {
      const { quizId } = await call(admin, 'a:quiz:open', {});
      // команда 1 отвечает быстрее команды 0
      await call(caps[1], 'team:answer', { quizId, text: 'да' });
      await sleep(30);
      await call(caps[0], 'team:answer', { quizId, text: 'да' });
      await call(admin, 'a:quiz:close'); // автооценка по ответу из списка
      await call(admin, 'a:quiz:reset');
    }
    expect(srv.db.teams[0].score).toBe(srv.db.teams[1].score);
    const b = (await call(admin, 'a:state')).state.pub.board;
    expect(b[0].id).toBe(teams[1].id);
    expect([b[0].rank, b[1].rank]).toEqual([1, 2]);
    expect(b[0].timeMs).toBeLessThan(b[1].timeMs);
    // команды 2 и 3 без ответов и с равными баллами делят место
    expect([b[2].rank, b[3].rank]).toEqual([3, 3]);
  });

  it('вопросы: варианты ответа, сложность → баллы 1/2/3, свои баллы и время, верный вариант не утекает', async () => {
    const { srv, admin, caps, teams } = await setup(3);
    await call(admin, 'a:questions:set', { text: [
      'Столица Франции? | Лондон; Париж*; Рим | средний | | 20 | 1',
      'Корень из 9? | 3 | л',
      'Сложный? | да | сложный',
      'Свои баллы? | да | т | 7',
    ].join('\n') });
    const qs = srv.db.questions;
    expect(qs[0]).toMatchObject({ options: ['Лондон', 'Париж', 'Рим'], correct: 1, a: 'Париж', difficulty: 'medium', sec: 20, block: 1 });
    expect(qs[1]).toMatchObject({ options: [], difficulty: 'easy' });
    expect(qs[3]).toMatchObject({ difficulty: 'hard', points: 7 });

    const { quizId } = await call(admin, 'a:quiz:open', {});
    expect(srv.db.quiz.timer.durationMs).toBe(20000);                 // своё время вопроса
    const st = (await call(admin, 'a:state')).state;
    expect(st.pub.quiz.options).toEqual(['Лондон', 'Париж', 'Рим']);
    const guest = await new Promise((res) => { const c = caps[0]; c.once('state', res); call(admin, 'a:settings:update', { question: 1 }); });
    expect(Object.keys(guest.quiz)).not.toContain('correct');          // верный вариант игрокам неизвестен
    expect(Object.keys(guest.quiz)).not.toContain('key');
    expect(JSON.stringify(guest)).not.toContain('Париж*');
    expect((await call(caps[0], 'team:answer', { quizId, text: 'Париж' })).reason).toBe('bad_choice'); // для вопроса с вариантами нужен номер
    expect((await call(caps[0], 'team:answer', { quizId, choice: 9 })).reason).toBe('bad_choice');
    expect((await call(caps[0], 'team:answer', { quizId, choice: 1 })).ok).toBe(true);
    expect((await call(caps[1], 'team:answer', { quizId, choice: 0 })).ok).toBe(true);
    await call(admin, 'a:quiz:close');
    expect(srv.db.teams[0].score).toBe(2);   // средний = 2 балла
    expect(srv.db.teams[1].score).toBe(0);
    expect(srv.db.quiz.answers[teams[0].id].text).toBe('Б) Париж');
    await call(admin, 'a:quiz:reset');
    // лёгкий = 1, сложный = 3, свои баллы = 7
    for (const [n, pts] of [[2, 1], [3, 3], [4, 7]]) {
      const o = await call(admin, 'a:quiz:open', {});
      const key = srv.db.quiz.key;
      await call(caps[2], 'team:answer', { quizId: o.quizId, text: key });
      await call(admin, 'a:quiz:close');
      expect(srv.db.quiz.answers[teams[2].id].points).toBe(pts);
      await call(admin, 'a:quiz:reset');
    }
    expect(srv.db.teams[2].score).toBe(1 + 3 + 7);
  });

  it('блоки: перерыв между блоками, нейтральный экран, резервная копия, продолжение; итоги по блокам', async () => {
    const { srv, admin, caps, teams, dir } = await setup(2);
    await call(admin, 'a:settings:update', { quizSec: 1, pauseSec: 0 });
    await call(admin, 'a:questions:set', { text: 'Б1В1? | да | л | | | 1\nБ2В1? | да | с | | | 2\nБ2В2? | да | т | | | 2' });
    expect((await call(admin, 'a:auto:start', { mode: 'quiz' })).ok).toBe(true);
    await call(caps[0], 'team:answer', { quizId: srv.db.quiz.id, text: 'да' });
    await sleep(1300);
    let pub = (await call(admin, 'a:state')).state.pub;
    expect(pub.auto).toMatchObject({ running: true, phase: 'blockbreak', doneBlock: 1 });
    expect(pub.quiz.status).toBe('idle');
    expect(srv.db.teams[0].score).toBe(1);
    const files = fs.readdirSync(path.join(dir, 'backups'));
    expect(files.some((f) => f.includes('block1'))).toBe(true);        // копия при завершении блока
    expect((await call(caps[0], 'a:auto:resume')).error).toBe('forbidden');
    expect((await call(admin, 'a:auto:resume')).ok).toBe(true);
    expect(srv.db.quiz.block).toBe(2);
    await call(caps[1], 'team:answer', { quizId: srv.db.quiz.id, text: 'да' });
    await sleep(1300); // вопрос 2 закрыт; вопрос 3 — тот же блок, без перерыва
    expect(srv.db.quiz.question).toBe('Б2В2?');
    await call(caps[1], 'team:answer', { quizId: srv.db.quiz.id, text: 'да' });
    await sleep(1300);
    pub = (await call(admin, 'a:state')).state.pub;
    expect(pub.auto.finished).toBe(true);
    expect(pub.displayView).toBe('closing');
    const stats = (await call(admin, 'a:state')).state.stats;
    const t1 = stats.find((x) => x.teamId === teams[1].id);
    expect(t1.perBlock['2']).toMatchObject({ points: 2 + 3, correct: 2 });
    expect(stats.find((x) => x.teamId === teams[0].id).perBlock['1']).toMatchObject({ points: 1, correct: 1 });
  });

  it('раскрытие результатов: с последнего места к первому и только тройка', async () => {
    const { srv, admin, caps, teams } = await setup(5);
    for (const [i, t] of teams.entries()) await call(admin, 'a:score:set', { id: t.id, score: (i + 1) * 10 }); // 5-я команда — лидер
    const seen = [];
    caps[0].on('state', (x) => seen.push(x));
    expect((await call(caps[0], 'a:reveal:start', { mode: 'all' })).error).toBe('forbidden');
    await call(admin, 'a:reveal:start', { mode: 'all' });
    await sleep(80);
    expect(seen.at(-1).displayView).toBe('reveal');
    expect(seen.at(-1).reveal.rows.length).toBe(0);
    expect(seen.at(-1).board.length).toBe(0);
    await call(admin, 'a:reveal:next');
    await sleep(80);
    expect(seen.at(-1).reveal.rows.map((r) => r.rank)).toEqual([5]);   // сначала последнее место
    expect(seen.at(-1).reveal.rows[0].id).toBe(teams[0].id);
    await call(admin, 'a:reveal:next'); await call(admin, 'a:reveal:prev');
    await sleep(80);
    expect(seen.at(-1).reveal.rows.length).toBe(1);
    for (let i = 0; i < 6; i++) await call(admin, 'a:reveal:next'); // дальше конца не уходит
    await sleep(80);
    expect(seen.at(-1).reveal).toMatchObject({ shown: 5, total: 5, done: true });
    expect(seen.at(-1).reveal.rows.at(-1).id).toBe(teams[4].id);        // последним — победитель
    // только тройка
    await call(admin, 'a:reveal:start', { mode: 'top3' });
    await call(admin, 'a:reveal:next');
    await sleep(80);
    expect(seen.at(-1).reveal.rows.map((r) => r.rank)).toEqual([3]);
    await call(admin, 'a:display:set', { view: 'leaderboard' });
    await sleep(80);
    expect(seen.at(-1).reveal.active).toBe(false);
    expect(seen.at(-1).board.length).toBe(5);
  });

  it('возрастные категории: разбор списка, правка, цвета только из junior/middle/senior', async () => {
    const { srv, admin } = await setup(1);
    await call(admin, 'a:tournament:create', { name: 'Возраст', teamNames: 'Орлы | junior\nСоколы | средние\nЯстребы | senior\nВороны | ??\nЧайки' });
    expect(srv.db.teams.map((t) => t.age)).toEqual(['junior', 'middle', 'senior', null, null]);
    const id = srv.db.teams[3].id;
    expect((await call(admin, 'a:team:update', { id, age: 'senior' })).ok).toBe(true);
    expect(srv.db.teams[3].age).toBe('senior');
    expect((await call(admin, 'a:team:update', { id, age: 'purple' })).ok).toBe(false);
    expect((await call(admin, 'a:team:update', { id, age: null })).ok).toBe(true);
    expect(srv.db.teams[3].age).toBe(null);
    const pub = (await call(admin, 'a:state')).state.pub;
    expect(pub.teams.map((t) => t.age)).toEqual(['junior', 'middle', 'senior', null, null]);
  });

  it('задержка доставки вопроса и статистика времени; резервная копия по запросу', async () => {
    const { srv, admin, caps, teams, dir } = await setup(2);
    await call(admin, 'a:questions:set', { text: 'Вопрос? | да' });
    const { quizId } = await call(admin, 'a:quiz:open', {});
    caps[0].emit('team:seen', { quizId });
    caps[0].emit('team:seen', { quizId });      // повтор не перезаписывает
    caps[1].emit('team:seen', { quizId: 'old' }); // чужой/старый вопрос не засчитывается
    await sleep(100);
    expect(typeof srv.db.quiz.delivery[teams[0].id]).toBe('number');
    expect(srv.db.quiz.delivery[teams[1].id]).toBeUndefined();
    await call(caps[0], 'team:answer', { quizId, text: 'да' });
    await call(admin, 'a:quiz:close');
    await call(admin, 'a:quiz:reset');
    const stats = (await call(admin, 'a:state')).state.stats;
    const s0 = stats.find((x) => x.teamId === teams[0].id);
    expect(s0.avgDeliveryMs).toBeGreaterThan(0);
    expect(s0.avgAnswerMs).toBeGreaterThan(0);
    expect(s0).toMatchObject({ answered: 1, correct: 1 });
    expect(srv.db.history.length).toBe(1);
    const b = await call(admin, 'a:backup');
    expect(fs.existsSync(path.join(dir, 'backups', b.file))).toBe(true);
    expect((await call(caps[0], 'a:backup')).error).toBe('forbidden');
  });
});

describe('резервные копии и варианты ответов', () => {
  it('изолирует новый турнир и оценивает дополнительный ответ', async () => {
    const { srv, admin, caps, teams } = await setup(1);
    await call(admin, 'a:questions:set', { text: 'Что это? | логотип | средний | | | 2', accepts: [['лого', 'logo', 'logotype']] });
    const { quizId } = await call(admin, 'a:quiz:open');
    await call(caps[0], 'team:answer', { quizId, text: 'LOGO' });
    await call(admin, 'a:quiz:close');
    expect(srv.db.quiz.answers[teams[0].id].verdict).toBe(true);
    const old = srv.db.activeId;
    await call(admin, 'a:tournament:create', { name: 'Новый', teamCount: 1 });
    expect(srv.db.displayView).toBe('start');
    expect(srv.db.teams[0].score).toBe(0);
    expect(srv.db.history).toEqual([]);
    expect(srv.db.quiz.answers).toEqual({});
    expect(srv.db.tournaments[old].teams[0].score).toBe(2);
  });
  it('экспортирует и восстанавливает журналы, защищая данные от некорректного импорта', async () => {
    const { srv, admin, dir } = await setup(1);
    const url = `http://127.0.0.1:${srv.port}/api/data`;
    expect((await fetch(`${url}/export.json`)).status).toBe(403);
    const headers = { 'x-admin-token': admin.token, 'content-type': 'application/json' };
    const snapshot = await (await fetch(`${url}/export.json`, { headers })).json();
    expect(snapshot.state.auth).toBeUndefined();
    expect(snapshot.state.offlineSecret).toBeUndefined();
    expect(snapshot.state.teams[0].pin).toBeUndefined();
    expect(snapshot.logs.length).toBeGreaterThan(0);
    const original = srv.db.tournament.name;
    const bad = await fetch(`${url}/import.json`, { method: 'POST', headers, body: JSON.stringify({ ...snapshot, state: {} }) });
    expect(bad.status).toBe(400); expect(srv.db.tournament.name).toBe(original);
    await call(admin, 'a:tournament:create', { name: 'Другая игра', teamCount: 1 });
    const res = await fetch(`${url}/import.json`, { method: 'POST', headers, body: JSON.stringify(snapshot) });
    expect(res.status).toBe(200); expect(srv.db.tournament.name).toBe(original);
    expect(fs.readdirSync(path.join(dir, 'backups')).some(f => f.includes('before-import'))).toBe(true);
    const log = await (await fetch(`${url}/log.jsonl`, { headers })).text();
    expect(log).toContain('server.start');
  });
  it('после перезапуска открывает стартовый экран, сохраняя счёт', async () => {
    const { srv, dir } = await setup(1);
    srv.db.teams[0].score = 42; srv.db.displayView = 'final'; srv.db.reveal.active = true;
    srv.store.flush(); await srv.close(); servers.splice(servers.indexOf(srv), 1);
    const { srv: restarted } = await boot({}, dir);
    expect(restarted.db.displayView).toBe('start'); expect(restarted.db.reveal.active).toBe(false);
    expect(restarted.db.teams[0].score).toBe(42);
    expect(restarted.db.log.some(e => e.type === 'server.start')).toBe(true);
  });
});

describe('надёжное автопроведение', () => {
  it('продолжает открытый вопрос после остановки и сохраняет ответ', async () => {
    const { srv, admin, caps, teams } = await setup(1);
    await call(admin, 'a:settings:update', { quizSec: 30, pauseSec: 0 });
    await call(admin, 'a:questions:set', { text: 'Первый | да\nВторой | нет' });
    await call(admin, 'a:auto:start');
    const quizId = srv.db.quiz.id;
    await call(caps[0], 'team:answer', { quizId, text: 'да' });
    await call(admin, 'a:auto:stop');
    expect((await call(admin, 'a:auto:continue')).ok).toBe(true);
    expect(srv.db.quiz.id).toBe(quizId);
    await call(admin, 'a:quiz:close');
    expect(srv.db.teams[0].score).toBe(10);
    expect(srv.db.history[0].answers[0]).toMatchObject({ teamId: teams[0].id, correct: true });
    expect(srv.db.tournament.question).toBe(2);
  });
  it('ожидает ручной оценки перед переходом к следующему вопросу', async () => {
    const { srv, admin, caps } = await setup(1);
    await call(admin, 'a:settings:update', { quizSec: 30, pauseSec: 0 });
    await call(admin, 'a:questions:set', { text: 'Первый без ключа\nВторой | да' });
    await call(admin, 'a:auto:start');
    await call(caps[0], 'team:answer', { quizId: srv.db.quiz.id, text: 'ответ' });
    await call(admin, 'a:quiz:close');
    expect((await call(admin, 'a:state')).state.pub.auto.phase).toBe('review');
    expect((await call(admin, 'a:auto:resume')).ok).toBe(false);
    await call(admin, 'a:quiz:mark', { teamId: srv.db.teams[0].id, correct: true });
    expect((await call(admin, 'a:auto:resume')).ok).toBe(true);
    expect(srv.db.history[0].answers[0].correct).toBe(true);
    expect(srv.db.teams[0].score).toBe(10);
    expect(srv.db.tournament.question).toBe(2);
  });
  it('не запускает пустой турнир', async () => {
    const { srv, admin } = await setup(1);
    const r = await call(admin, 'a:auto:start');
    expect(r.ok).toBe(false); expect(r.error).toMatch(/вопрос/); expect(srv.db.quiz.status).toBe('idle');
  });
});


describe('подключение команд', () => {
  it('вход не выдаёт офлайн-кодов, а прежние команды не доступны', async () => {
    const { srv, teams } = await setup(1);
    const c = await client(srv);
    const r = await call(c, 'team:login', { team: teams[0].id, pin: teams[0].pin });
    expect(r.ok).toBe(true); expect(r.offline).toBeUndefined();
    expect(() => srv.local('a:offline:check', {})).toThrow();
    expect(() => srv.local('a:offline:accept', {})).toThrow();
  });
});


describe('таблица после награждения', () => {
  it('после ручного раскрытия показывает все команды и отменяет переход при возврате назад', async () => {
    const { srv } = await boot({ ceremonyTiming: { hold: 80 } });
    const admin = await adminClient(srv);
    await call(admin, 'a:tournament:create', { name: 'Лиги', teamNames: 'J | junior\nM | middle\nS | senior', ageMode: true });
    await call(admin, 'a:age:results', { age: 'junior' });
    await call(admin, 'a:reveal:start', { mode: 'top3' });
    await call(admin, 'a:reveal:next');
    await call(admin, 'a:reveal:prev');
    await sleep(110); expect(srv.db.displayView).toBe('reveal');
    await call(admin, 'a:reveal:next'); await sleep(110);
    const pub = (await call(admin, 'a:state')).state.pub;
    expect(pub.displayView).toBe('leaderboard'); expect(pub.tournament.resultAge).toBe('all'); expect(pub.board.length).toBe(3);
  });
  it('после показа пьедестала открывает полный рейтинг', async () => {
    const { srv, admin } = await setup(2, { ceremonyTiming: { hold: 50 } });
    await call(admin, 'a:display:set', { view: 'final' });
    expect(srv.db.displayView).toBe('final'); await sleep(80);
    expect(srv.db.displayView).toBe('leaderboard');
    expect((await call(admin, 'a:state')).state.pub.board.length).toBe(2);
  });
});


it('автоигра ждёт отключившуюся команду до конца таймера', async () => {
  const { srv, admin, caps, teams } = await setup(2);
  await call(admin, 'a:settings:update', { quizSec: 30, pauseSec: 10 });
  await call(admin, 'a:questions:set', { text: 'Первый? | да\nВторой? | нет' });
  await call(admin, 'a:auto:start');
  const quizId = srv.db.quiz.id;
  caps[1].disconnect(); await sleep(100);
  await call(caps[0], 'team:answer', { quizId, text: 'да' });
  await sleep(1300);
  expect(srv.db.quiz.status).toBe('open');
  const reconnected = await client(srv);
  expect((await call(reconnected, 'team:login', { team: teams[1].id, pin: teams[1].pin })).ok).toBe(true);
  expect((await call(reconnected, 'team:answer', { quizId, text: 'да' })).ok).toBe(true);
  await sleep(1200); expect(srv.db.quiz.status).toBe('closed');
  expect(srv.db.teams.map(t => t.score)).toEqual([10, 10]);
});
