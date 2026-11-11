import express from 'express';
import compression from 'compression';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createStore } from './store.js';
import { matchesAnswer } from './grade.js';
import { createMediaStore, imageName, validImage, MAX_IMAGE_BYTES } from './media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG = 20000;

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

const int = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name}: нужно целое число от ${min} до ${max}`);
  return n;
};
const str = (v, max, name) => {
  if (typeof v !== 'string') fail(`${name}: нужна строка`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) fail(`${name}: пусто`);
  if (s.length > max) fail(`${name}: максимум ${max} символов`);
  return s;
};
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const normAddr = (a) => (a || '').replace(/^::ffff:/, '');
const uid = () => crypto.randomBytes(4).toString('hex');
const blankQuiz = () => ({ id: null, status: 'idle', question: '', image: null, openedAt: null, answers: {}, timer: null, options: [], correct: -1, key: '', accept: [], points: null, difficulty: null, sec: null, block: 1, delivery: {} });
const blankReveal = () => ({ active: false, mode: 'all', shown: 0 });
const blankRound = () => ({
  id: null, status: 'idle', openedAt: null, firstAt: null,
  buzzes: [], answererIdx: -1, verdict: null, excluded: [], sealed: false, timer: null,
});

export function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
    }
  }
  const prio = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => prio(a) - prio(b));
}

function localAddrs() {
  const s = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) s.add(i.address);
  return s;
}

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
const makeAuth = (pw) => { const salt = crypto.randomBytes(16); return { salt: salt.toString('base64'), hash: hashPw(pw, salt).toString('base64') }; };
const validPw = (pw) => {
  if (typeof pw !== 'string') fail('Пароль: нужна строка');
  if (pw.length < 4) fail('Пароль: минимум 4 символа');
  if (pw.length > 64) fail('Пароль: максимум 64 символа');
  return pw;
};

const AGES = ['junior', 'middle', 'senior'];
/** Число строк ниже выбранных призовых мест. Все команды с одинаковым местом включаются. */
const revealStart = (rows, mode) => rows.filter(r => r.rank > (mode === 'top3' ? 3 : mode === 'top10' ? 10 : Infinity)).length;
const parseAge = (v) => {
  const x = String(v ?? '').trim().toLowerCase();
  if (!x) return null;
  if (AGES.includes(x)) return x;
  if (/^(jun|мл|ю)/.test(x)) return 'junior';
  if (/^(mid|ср)/.test(x)) return 'middle';
  if (/^(sen|ст)/.test(x)) return 'senior';
  return null;
};
const parseDifficulty = (v) => {
  const x = String(v ?? '').trim().toLowerCase();
  if (!x) return null;
  if (/^(е|e|л|1)/.test(x) && !/^ср/.test(x)) return 'easy';
  if (/^(m|ср|с$|2)/.test(x)) return 'medium';
  if (/^(h|сл|т|3)/.test(x)) return 'hard';
  return null;
};
const LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'];

/** Команды: по строке на команду, «Название» или «Название | junior/middle/senior». */
function parseNames(text) {
  const seen = new Set(); const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const [rawName, rawAge] = line.split('|');
    const n = (rawName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase()); out.push({ name: n, age: parseAge(rawAge) });
    if (out.length >= 1000) break;
  }
  return out;
}
/**
 * Вопросы: по строке на вопрос, столбцы через « | »:
 *   вопрос | ответ ИЛИ варианты | сложность | баллы | секунд | блок
 * Варианты через «;», верный помечается «*»: Лондон; Париж*; Рим. Сложность: лёгкий/средний/сложный (л/с/т, easy/medium/hard).
 * Всё, кроме вопроса, необязательно. Ответ и верный вариант видит только ведущий.
 */
function parseQuestions(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const cols = l.split('|').map((c) => c.trim());
    const q = cols[0].slice(0, 500);
    if (!q) continue;
    const c2 = cols[1] || '';
    let a = c2.slice(0, 200); let options = []; let correct = -1;
    const parts = c2.split(';').map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      options = parts.slice(0, 8).map((x, i) => { if (x.endsWith('*')) { correct = i; return x.slice(0, -1).trim().slice(0, 80); } return x.slice(0, 80); });
      a = correct >= 0 ? options[correct] : '';
    }
    const num = (v, min, max) => { const n = v ? Number(v) : NaN; return Number.isInteger(n) && n >= min && n <= max ? n : null; };
    const image = cols[6] || null;
    if (!validImage(image)) fail('Некорректная ссылка на изображение');
    out.push({ q, a, ...(image ? { image } : {}), options, correct, difficulty: parseDifficulty(cols[2]), points: num(cols[3], 0, 1000), sec: num(cols[4], 5, 3600), block: num(cols[5], 1, 9) ?? 1 });
    if (out.length >= 500) break;
  }
  return out;
}
function makeTeams(items) {
  const used = new Set();
  return items.map((it) => {
    const { name, age = null } = typeof it === 'string' ? { name: it } : it;
    let pin;
    do { pin = String(crypto.randomInt(1000, 10000)); } while (used.has(pin));
    used.add(pin);
    return { id: `t${uid()}`, name, pin, score: 0, disabled: false, age };
  });
}

const NAMES = ['Альфа', 'Бета', 'Гамма', 'Дельта', 'Омега', 'Сигма', 'Орбита', 'Квант', 'Вектор', 'Нейрон',
  'Фотон', 'Импульс', 'Горизонт', 'Атлант', 'Феникс', 'Титан', 'Зенит', 'Маяк', 'Спектр', 'Ракета',
  'Галактика', 'Протон', 'Эврика', 'Логика', 'Синтез', 'Прометей', 'Радиан', 'Аргумент', 'Кортекс', 'Дедукция'];

/** Демо-турнир: короткие вопросы с готовыми ответами — можно сразу нажать «Показать вопрос». */
const demoQuestions = () => parseQuestions([
  'Столица Казахстана? | Астана',
  'Самая большая планета Солнечной системы? | Юпитер',
  'Сколько сторон у шестиугольника? | 6 / шесть',
  'Автор романа «Война и мир»? | Лев Толстой / Толстой',
  'Какой океан самый большой? | Тихий океан / Тихий',
  'Столица Франции? | Лондон; Париж*; Рим; Берлин',
  'Кто написал «Сказку о рыбаке и рыбке»? | Пушкин / Александр Пушкин',
  'Сколько дней в високосном году? | 366 / 366 дней',
  'Самый маленький материк? | Австралия',
  'Какая планета ближе всех к Солнцу? | Меркурий',
  'Какой газ растения поглощают при фотосинтезе? | Углекислый газ / углекислый',
  'Сколько минут в двух часах? | 120 / сто двадцать',
].join('\n'));
const DEMO_SETTINGS = { quizSec: 15, readSec: 3, pauseSec: 2, autoGrade: true, blockBreak: false, showQuestion: true };

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function createQuizServer(opts = {}) {
  const {
    port = Number(process.env.PORT) || 3000,
    host = '0.0.0.0',
    dataFile = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'state.json'),
    staticDir = path.join(__dirname, '..', 'dist'),
    adminPassword = process.env.ADMIN_PASSWORD,
    silent = false,
    ceremonyTiming = null, // { intro, step, hold } мс — для тестов
    readSec: readSecDefault = -1, // время на чтение вопроса по умолчанию (-1 — по длине, 0 — без чтения; в тестах 0)
  } = opts;

  const store = createStore(dataFile);
  const media = createMediaStore(dataFile ? path.join(path.dirname(dataFile), 'media') : null);
  const checkImages = rows => { try { rows.forEach(q => media.assert(q.image)); } catch (e) { fail(e.message); } };
  const WATERMARK = { on: true, text: 'Made by Шибанов Даниил, Бубнов Иван', size: 1.8, corner: 'br', x: 1, y: 4.5, opacity: 0.55 };
  const saved = store.load();
  const d = saved && saved.version === 1 ? saved : {};
  const DEFAULT_SETTINGS = { readSec: readSecDefault, correctPoints: 10, wrongPoints: 0, queueWindowMs: 1000, openSec: 0, quizSec: 60, answerSec: 15, showQuestion: false, pauseSec: 10, autoGrade: true, resultSec: 4, blockBreak: true, difficultyPoints: { easy: 1, medium: 2, hard: 3 }, difficultyTiming: false, difficultySec: { easy: 20, medium: 30, hard: 45 } };
  // Состояние турнира, которое хранится «внутри» каждого турнира. Остальное (auth, список других турниров) общее.
  const TKEYS = ['tournament', 'settings', 'teams', 'displayView', 'logSeq', 'roundSeq', 'played', 'demo', 'round', 'quiz', 'questions', 'history', 'reveal', 'ageQuestions', 'buzzHistory'];
  const normalize = (t) => {
    t.tournament = { ageMode: false, age: 'junior', progress: {}, ...t.tournament };
    if (!AGES.includes(t.tournament.age)) t.tournament.age = 'junior';
    t.ageQuestions = Object.fromEntries(AGES.map(age => [age, Array.isArray(t.ageQuestions?.[age]) ? t.ageQuestions[age] : []]));
    if (!Array.isArray(t.buzzHistory)) t.buzzHistory = [];
    t.settings = { ...DEFAULT_SETTINGS, ...t.settings, difficultyPoints: { ...DEFAULT_SETTINGS.difficultyPoints, ...(t.settings?.difficultyPoints || {}) }, difficultySec: { ...DEFAULT_SETTINGS.difficultySec, ...(t.settings?.difficultySec || {}) } };
    t.quiz = { ...blankQuiz(), ...t.quiz };
    if (!Array.isArray(t.history)) t.history = [];
    if (!t.reveal) t.reveal = blankReveal();
    if (t.round.status === 'open') t.round.status = 'locked';
    if (t.round.status === 'buzzed') t.round.sealed = true;
    if (t.quiz.status === 'open') t.quiz.status = 'closed';
    t.round.timer = null; t.quiz.timer = null; // таймеры после перезапуска/переключения не восстанавливаются
    return t;
  };
  const makeTournament = (name, o = {}) => ({
    tournament: { name, round: 1, question: 1, ageMode: !!o.ageMode, age: 'junior', progress: {} }, settings: { ...DEFAULT_SETTINGS, ...(o.settings || {}) },
    teams: o.teams || [], displayView: 'start', logSeq: 0, roundSeq: 0, played: false, demo: !!o.demo,
    ageQuestions: o.ageQuestions || { junior: o.ageMode ? (o.questions || []) : [], middle: [], senior: [] }, buzzHistory: [], round: blankRound(), quiz: blankQuiz(), questions: o.questions || [], history: [], reveal: blankReveal(), createdAt: Date.now(),
  });
  const activeId = d.activeId || 'default';
  const db = {
    version: 1,
    activeId,
    createdAt: d.createdAt || Date.now(),
    auth: d.auth || null,
    joinBase: typeof d.joinBase === 'string' ? d.joinBase : null, // адрес для QR, выбранный ведущим
    watermark: { ...WATERMARK, ...(d.watermark || {}) }, // подпись авторов на проекторе (скрытая настройка в пульте)
    offlineSecret: d.offlineSecret, // сохраняем поле старых файлов для совместимости
    tournament: { name: 'QUIZ ARENA', round: 1, question: 1, ...(d.tournament || {}) },
    settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
    teams: Array.isArray(d.teams) ? d.teams : [],
    displayView: 'start',
    logSeq: d.logSeq || 0,
    roundSeq: d.roundSeq || 0,
    played: !!d.played,
    demo: !!d.demo,
    round: d.round || blankRound(),
    quiz: d.quiz || blankQuiz(),
    questions: Array.isArray(d.questions) ? d.questions : [],
    ageQuestions: d.ageQuestions || {}, buzzHistory: d.buzzHistory || [],
    history: Array.isArray(d.history) ? d.history : [],
    reveal: d.reveal || blankReveal(),
    tournaments: {},
    log: [],
  };
  normalize(db);
  db.reveal.active = false;
  for (const [id, t] of Object.entries(d.tournaments || {})) db.tournaments[id] = normalize({ ...makeTournament('Турнир'), ...t });
  // журнал: один файл, записи помечены tid турнира (старые без tid — в активный)
  const logs = new Map();
  for (const e of store.loadLog(MAX_LOG * 3)) {
    const tid = e.tid || activeId;
    if (!logs.has(tid)) logs.set(tid, []);
    logs.get(tid).push(e);
  }
  for (const [k, arr] of logs) if (arr.length > MAX_LOG) logs.set(k, arr.slice(-MAX_LOG));
  db.log = logs.get(activeId) || [];
  logs.set(activeId, db.log);
  if (adminPassword) db.auth = makeAuth(validPw(adminPassword));
  const sessions = new Map(); // token -> expires
  const SESSION_MS = 12 * 3600 * 1000;
  const newSession = () => { const t = crypto.randomBytes(24).toString('base64url'); sessions.set(t, Date.now() + SESSION_MS); return t; };
  const validToken = (t) => {
    if (typeof t !== 'string' || !t) return false;
    const exp = sessions.get(t);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(t); return false; }
    sessions.set(t, Date.now() + SESSION_MS);
    return true;
  };
  const checkPw = (pw) => {
    if (!db.auth || typeof pw !== 'string') return false;
    try { return crypto.timingSafeEqual(hashPw(pw, Buffer.from(db.auth.salt, 'base64')), Buffer.from(db.auth.hash, 'base64')); } catch { return false; }
  };

  // ---- runtime (не сохраняется) ----
  let openHr = null;        // hrtime открытия кнопок
  let firstHr = null;       // hrtime первого нажатия
  let quizHr = null;        // hrtime показа вопроса (для задержки доставки)
  let answersHr = null;     // hrtime старта приёма ответов (после чтения) — от него считается время ответа
  let actualPort = port;
  const teamSockets = new Map(); // teamId -> socket.id
  const rtts = new Map();        // teamId -> ms
  const loginFails = new Map();  // ip -> {n, until}
  const nonceCache = new Map();  // `${team}:${nonce}` -> результат
  const rejLogged = new Set();
  let adminTimer = null;
  const handles = { round: null, quiz: null };
  // автопрограмма письменных вопросов: вопрос → пауза → следующий вопрос (не сохраняется, после перезапуска выключена)
  let tunnelState = { status: 'off', url: null, error: null };
  const auto = { running: false, mode: 'quiz', phase: 'idle', finished: false, block: 1, doneBlock: null, brokeTo: new Set() };

  // ---- серверные таймеры: endsAt — серверное время, клиенты показывают обратный отсчёт ----
  function setTimer(slot, holder, kind, ms, onExpire) {
    clearTimeout(handles[slot]); handles[slot] = null;
    holder.timer = ms > 0 ? { kind, endsAt: Date.now() + ms, durationMs: ms } : null;
    if (ms > 0 && onExpire) handles[slot] = setTimeout(() => {
      handles[slot] = null;
      // ошибка в обработчике таймера не должна останавливать игру: пишем в журнал, останавливаем автоигру понятно для ведущего
      try { onExpire(); } catch (e) { console.error('[таймер]', e); try { stopAuto(`error: ${e.message}`); commit(); } catch { /* */ } }
    }, ms);
  }
  function clearTimer(slot, holder) { clearTimeout(handles[slot]); handles[slot] = null; if (holder) holder.timer = null; }
  function clearAllTimers() { clearTimer('round'); clearTimer('quiz'); }

  const persist = () => store.save(() => { const { log, ...rest } = db; return rest; });
  const findTeam = (id) => db.teams.find((t) => t.id === id);
  const monoMs = (hr) => Math.round(Number(hr - openHr) / 1e3) / 1e3;

  function log(type, data = {}) {
    const e = { id: ++db.logSeq, tid: db.activeId, ts: new Date().toISOString(), t: Date.now(), type, data };
    db.log.push(e);
    if (db.log.length > MAX_LOG) db.log.splice(0, db.log.length - MAX_LOG);
    store.appendLog(e);
    persist();
    scheduleAdmin();
    return e;
  }
  const ctx = () => ({ age: activeAge(), round: db.tournament.round, question: db.tournament.question, roundId: db.round.id });

  // ---- вопросы, баллы, статистика, рейтинг ----
  const activeAge = () => db.tournament.ageMode ? db.tournament.age : null;
  // resultAge 'all' — общий зачёт: рейтинг по всем командам всех лиг
  const resultAge = () => db.tournament.ageMode ? (db.tournament.resultAge === 'all' ? null : (db.tournament.resultAge || db.tournament.age)) : null;
  const questions = () => activeAge() ? db.ageQuestions[activeAge()] : db.questions;
  const resultQuestions = () => resultAge() ? db.ageQuestions[resultAge()] : db.questions;
  const eligible = (team) => !activeAge() || team?.age === activeAge();
  const groupTeams = (age = activeAge()) => db.teams.filter(t => !age || t.age === age);
  const questionInProgress = () => auto.running || db.quiz.status === 'open' || ['open', 'buzzed'].includes(db.round.status);
  const ensureAgeReady = () => {
    if (!activeAge()) return;
    if (!groupTeams().some(t => !t.disabled)) fail('Добавьте команды выбранной возрастной группы');
    if (!questions().length) fail('Добавьте вопросы выбранной возрастной группы');
    if (db.tournament.question > questions().length) fail('Все вопросы этого возраста сыграны. Откройте итоги или начните зачёт заново');
  };
  // После каждого вопроса лига передаёт ход следующей.
  // Сохраняем номер следующего вопроса для следующего круга.
  function advanceQuestion() {
    const completed = db.tournament.question;
    db.tournament.question = Math.min(999, completed + 1);
    const age = activeAge();
    if (!age) return false;
    db.tournament.progress[age] = { question: db.tournament.question, round: db.tournament.round };
    const start = AGES.indexOf(age);
    for (let offset = 1; offset <= AGES.length; offset++) {
      const nextAge = AGES[(start + offset) % AGES.length];
      const progress = db.tournament.progress[nextAge] || { question: 1, round: 1 };
      if (progress.question > db.ageQuestions[nextAge].length) continue;
      if (!groupTeams(nextAge).some((t) => !t.disabled)) continue; // лига без команд — пропускаем
      if (nextAge === age) return false;
      clearAllTimers();
      db.tournament.age = nextAge; db.tournament.resultAge = nextAge;
      db.tournament.question = progress.question; db.tournament.round = progress.round;
      db.round = blankRound(); db.quiz = blankQuiz(); db.played = false;
      openHr = null; firstHr = null; nonceCache.clear(); rejLogged.clear();
      db.reveal = blankReveal(); auto.finished = false; auto.doneBlock = null;
      log('age.rotate', { from: age, age: nextAge, question: progress.question, turnSize: 1 });
      return true;
    }
    return false;
  }
  const getQ = (n) => { const it = questions()[n - 1]; return it ? { options: [], correct: -1, difficulty: null, points: null, sec: null, block: 1, ...it } : null; };
  /** Баллы за вопрос: свои баллы вопроса → по сложности (1/2/3) → общие баллы за верный ответ. */
  const qPoints = (item) => item?.points ?? (item?.difficulty ? db.settings.difficultyPoints[item.difficulty] : undefined) ?? db.settings.correctPoints;
  const qSeconds = (item, mode) => item?.sec ?? (db.settings.difficultyTiming && item?.difficulty ? db.settings.difficultySec[item.difficulty] : undefined) ?? (mode === 'buzz' ? db.settings.openSec : db.settings.quizSec);
  const R3 = (n) => Math.round(n * 1000) / 1000;

  /** Сводка по командам из архива вопросов и текущего (ещё не архивированного) вопроса. */
  function teamStats() {
    const m = new Map(db.teams.map((t) => [t.id, {
      teamId: t.id, name: t.name, age: t.age ?? null, score: t.score, answered: 0, correct: 0,
      timeCorrectMs: 0, timeAllMs: 0, deliveries: [], perBlock: {},
    }]));
    const addAnswer = (block, a) => {
      const r = m.get(a.teamId); if (!r) return;
      r.answered++; r.timeAllMs += a.mono || 0;
      const b = (r.perBlock[block] ||= { points: 0, correct: 0 });
      b.points += a.points || 0;
      if (a.correct === true) { r.correct++; r.timeCorrectMs += a.mono || 0; b.correct++; }
    };
    const addDelivery = (map) => { for (const [tid, ms] of Object.entries(map || {})) m.get(tid)?.deliveries.push(ms); };
    for (const h of db.history) { for (const a of h.answers) addAnswer(h.block, a); addDelivery(h.delivery); }
    if (db.quiz.id) {
      for (const a of Object.values(db.quiz.answers)) addAnswer(db.quiz.block, { teamId: a.teamId, mono: a.mono, correct: a.verdict, points: a.points });
      addDelivery(db.quiz.delivery);
    }
    for (const a of db.buzzHistory) addAnswer(a.block, a);
    return [...m.values()].map((r) => ({
      ...r, timeCorrectMs: R3(r.timeCorrectMs), timeAllMs: R3(r.timeAllMs),
      avgAnswerMs: r.answered ? R3(r.timeAllMs / r.answered) : null,
      avgDeliveryMs: r.deliveries.length ? R3(r.deliveries.reduce((x, y) => x + y, 0) / r.deliveries.length) : null,
      deliveries: undefined,
    }));
  }
  /** Рейтинг: баллы по убыванию; при равенстве — меньшее суммарное время верных ответов; иначе совместное место. */
  function board(age = resultAge()) {
    const rows = teamStats().filter(r => !age || r.age === age).map((r) => ({ id: r.teamId, name: r.name, age: r.age, score: r.score, correct: r.correct, timeKey: r.correct > 0 ? r.timeCorrectMs : Infinity }));
    const cmp = (a, b) => b.score - a.score || (a.timeKey === b.timeKey ? 0 : a.timeKey < b.timeKey ? -1 : 1) || a.name.localeCompare(b.name, 'ru');
    rows.sort(cmp);
    let rank = 0; let prev = null;
    rows.forEach((r, i) => {
      if (!prev || prev.score !== r.score || prev.timeKey !== r.timeKey) rank = i + 1;
      prev = r; r.rank = rank;
    });
    return rows.map(({ timeKey, ...r }) => ({ ...r, timeMs: Number.isFinite(timeKey) ? timeKey : null }));
  }
  const pubRow = ({ timeMs, correct, ...r }) => r; // без служебных полей — участникам и проектору
  function revealState(rows) {
    const rv = db.reveal;
    if (!rv.active) return { active: false, mode: rv.mode, start: 0, shown: 0, total: 0, done: false, rows: [] };
    const order = [...rows].reverse(); // от последнего места к первому
    const total = order.length;
    const start = revealStart(rows, rv.mode);
    const shown = Math.min(total, Math.max(start, rv.shown));
    // проектору нужны только последние строки; при 1000 команд полный список в каждом сообщении был бы огромным
    return { active: true, mode: rv.mode, start, shown, total, done: shown >= total, rows: order.slice(start, shown).slice(-12).map(pubRow) };
  }
  function answerBuzz() { return db.round.buzzes[db.round.answererIdx] || null; }
  /** Публичное состояние. Рейтинг и баллы других команд скрыты, пока ведущий сам не откроет рейтинг/итоги/раскрытие. */
  /** Какой вопрос будет следующим: при лигах по кругу — вопрос следующей лиги со своим номером; null — вопросы кончились. */
  function nextTurn() {
    const cur = activeAge();
    if (!cur) return { age: null, question: questions().length && db.tournament.question >= questions().length ? null : db.tournament.question + 1 };
    const start = AGES.indexOf(cur);
    for (let off = 1; off <= AGES.length; off++) {
      const age = AGES[(start + off) % AGES.length];
      const q = age === cur ? db.tournament.question + 1 : (db.tournament.progress?.[age]?.question ?? 1);
      if (q <= (db.ageQuestions[age] || []).length && groupTeams(age).some((t) => !t.disabled)) return { age, question: q };
    }
    return { age: null, question: null };
  }
  function publicState(full = false) {
    const r = db.round; const a = answerBuzz();
    const rows = (full || db.displayView === 'leaderboard' || db.displayView === 'final' || db.reveal.active) ? board() : null;
    const showBoard = full || db.displayView === 'leaderboard' || db.displayView === 'final';
    return {
      t: Date.now(),
      tournament: db.tournament,
      status: r.status,
      roundId: r.id,
      answerer: a ? { id: a.teamId, name: a.teamName } : null,
      verdict: r.verdict,
      excluded: r.excluded,
      questionMeta: { difficulty: getQ(db.tournament.question)?.difficulty ?? null, points: qPoints(getQ(db.tournament.question)) },
      questionText: db.settings.showQuestion ? (questions()[db.tournament.question - 1]?.q ?? '') : '',
      questionImage: db.settings.showQuestion ? (getQ(db.tournament.question)?.image || null) : null,
      auto: { running: auto.running, mode: auto.mode, phase: auto.phase, next: nextTurn().question, nextAge: nextTurn().age, finished: auto.finished || (questions().length > 0 && db.tournament.question > questions().length), total: questions().length, doneBlock: auto.doneBlock },
      timer: db.quiz.timer && (db.quiz.status === 'open' || db.quiz.timer.kind === 'pause') ? db.quiz.timer
        : r.timer && (r.status === 'open' || r.status === 'buzzed' || r.timer.kind === 'pause') ? r.timer : null,
      quiz: {
        id: db.quiz.id, status: db.quiz.status, reading: !!db.quiz.reading, question: db.quiz.question, image: db.quiz.image || null, answeredCount: Object.keys(db.quiz.answers).length,
        options: db.quiz.options, difficulty: db.quiz.difficulty, points: db.quiz.points, block: db.quiz.block,
      },
      displayView: db.displayView,
      joinBase: db.joinBase || null,
      watermark: db.watermark,
      tunnel: tunnelState, // ссылка через интернет (cloudflared), если поднята
      ceremony: ceremonyState(), // адрес для QR, выбранный ведущим (одинаковый на проекторе, в админке и на карточках)
      // Список команд — только админу. Телефонам он не нужен (экран входа берёт его из /api/teams), а при 1000 команд это 50 КБ на каждую рассылку.
      ...(full ? { teams: db.teams.map((t) => ({ id: t.id, name: t.name, age: t.age ?? null })) } : {}),
      ...(full && activeAge() ? { boards: Object.fromEntries(AGES.map(age => [age, board(age)])) } : {}),
      board: showBoard && rows ? (full ? rows : rows.map(pubRow)) : [], // таблица доступна полностью только после объявления результатов
      reveal: revealState(rows || []),
      points: { correct: qPoints(getQ(db.tournament.question)), wrong: db.settings.wrongPoints },
      online: teamSockets.size,
      teamCount: db.teams.length,
      activeTeamCount: groupTeams().filter(t => !t.disabled).length,
    };
  }
  function adminState() {
    const r = db.round; const first = r.buzzes[0];
    const stats = teamStats().filter(r => !resultAge() || r.age === resultAge());
    const blocks = [...new Set([...resultQuestions().map(q => q.block ?? 1), ...db.history.filter(h => !resultAge() || h.age === resultAge()).map(h => h.block), ...db.buzzHistory.filter(h => !resultAge() || h.age === resultAge()).map(h => h.block)].filter(x => x != null))].sort((a,b) => a-b);
    return {
      pub: publicState(true),
      settings: db.settings,
      demo: db.demo,
      teams: db.teams.map((t) => ({ ...t, connected: teamSockets.has(t.id), rtt: rtts.get(t.id) ?? null })),
      quizAnswers: Object.values(db.quiz.answers).sort((a, b) => a.ts - b.ts).map((a) => ({ ...a, delivery: db.quiz.delivery[a.teamId] ?? null })),
      quizDelivery: db.quiz.delivery,
      quizMeta: { options: db.quiz.options, correct: db.quiz.correct, key: db.quiz.key, points: db.quiz.points, difficulty: db.quiz.difficulty, block: db.quiz.block },
      stats, blocks, historyCount: db.history.filter(h => !resultAge() || h.age === resultAge()).length + new Set(db.buzzHistory.filter(h => !resultAge() || h.age === resultAge()).map(h => `${h.age}:${h.question}`)).size,
      buzzes: r.buzzes.map((b) => ({ ...b, delta: first ? Math.round((b.mono - first.mono) * 1000) / 1000 : 0 })),
      answererIdx: r.answererIdx,
      canPass: r.status === 'judged' && !!r.verdict && !r.verdict.correct &&
        r.buzzes.some((b, i) => i > r.answererIdx && !r.excluded.includes(b.teamId) && findTeam(b.teamId) && !findTeam(b.teamId).disabled),
      log: db.log.slice(-300),
      info: { port: actualPort, ips: lanIps() },
      tournaments: tournamentList(),
      activeId: db.activeId,
      questions: questions(),
      ageGroups: AGES.map(age => ({ age, questions: db.ageQuestions[age].length, teams: groupTeams(age).length,
        online: groupTeams(age).filter(t => teamSockets.has(t.id)).length,
        question: age === activeAge() ? db.tournament.question : (db.tournament.progress[age]?.question || 1),
        finished: db.ageQuestions[age].length > 0 && (age === activeAge() ? db.tournament.question : (db.tournament.progress[age]?.question || 1)) > db.ageQuestions[age].length })),
      sim: { running: sim.running, lines: sim.lines.slice(-40), startedAt: sim.startedAt, cfg: sim.cfg },
    };
  }

  // ---- HTTP ----
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    transports: ['websocket', 'polling'],
    pingInterval: 5000, pingTimeout: 10000, // через туннель и мобильный интернет паузы до 10 с — не повод рвать связь
    perMessageDeflate: false, maxHttpBufferSize: 1e5,
  });

  const httpIsAdmin = (req) => validToken(req.get('x-admin-token') || req.query.token);

  app.get('/api/health', (_q, res) => res.json({ ok: true, t: Date.now() }));
  app.get('/api/teams', (_q, res) => res.json(db.teams.filter((t) => !t.disabled).map((t) => ({ id: t.id, name: t.name, age: t.age ?? null }))));
  app.get('/api/info', (_q, res) => {
    const h = os.hostname();
    res.json({ ips: lanIps(), port: actualPort, host: h.includes('.') ? h : `${h}.local` });
  });
  app.post('/api/media', (req, res, next) => {
    if (!httpIsAdmin(req)) return res.status(403).json({ ok: false, error: 'Нет прав администратора' });
    next();
  }, express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), (req, res) => {
    try { res.json({ ok: true, image: media.save(req.body) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  }, (err, _req, res, _next) => res.status(err.status || 400).json({ ok: false, error: err.status === 413 ? 'Изображение больше 8 МБ' : 'Не удалось загрузить изображение' }));
  app.get('/api/media/:name', (req, res) => {
    const name = imageName(`/api/media/${req.params.name}`);
    if (!name || !media.has(name)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable').set('X-Content-Type-Options', 'nosniff');
    res.type(name.split('.').at(-1)).send(media.read(name));
  });
  // Backup files deliberately omit credentials and team PINs. PINs are regenerated on import.
  const cleanExport = value => JSON.parse(JSON.stringify(value, (key, val) =>
    /^(auth|password|hash|salt|token|sessions|offlineSecret|pin)$/i.test(key) ? undefined : val));
  function exportData() {
    store.flush();
    const { log: _log, ...state } = db;
    const all = dataFile ? store.loadLog() : [...logs.values()].flat();
    return { format: 'quiz-arena-backup', version: 1, state: cleanExport(state), logs: cleanExport(all), media: media.export(state) };
  }
  function importData(payload) {
    if (!payload || payload.format !== 'quiz-arena-backup' || payload.version !== 1 || !payload.state || payload.state.version !== 1 || !Array.isArray(payload.logs)) fail('Неверный формат или версия файла');
    const incoming = structuredClone(payload.state);
    const obj = x => x && typeof x === 'object' && !Array.isArray(x);
    const validQuestion = q => obj(q) && typeof q.q === 'string' && typeof q.a === 'string' && validImage(q.image) && (!('accept' in q) || (Array.isArray(q.accept) && q.accept.every(x => typeof x === 'string'))) && (!('options' in q) || Array.isArray(q.options));
    const validTournament = t => obj(t) && obj(t.tournament) && typeof t.tournament.name === 'string' && obj(t.settings) && Array.isArray(t.teams) && Array.isArray(t.questions) && t.questions.every(validQuestion) && (!t.ageQuestions || (obj(t.ageQuestions) && Object.values(t.ageQuestions).every(q => Array.isArray(q) && q.every(validQuestion)))) && Array.isArray(t.history) && obj(t.round) && Array.isArray(t.round.buzzes) && Array.isArray(t.round.excluded) && obj(t.quiz) && Array.isArray(t.quiz.options) && obj(t.quiz.answers) && (!t.reveal || obj(t.reveal));
    if (typeof incoming.activeId !== 'string' || !incoming.activeId || !validTournament(incoming) || !incoming.tournaments || typeof incoming.tournaments !== 'object' || Array.isArray(incoming.tournaments) || Object.hasOwn(incoming.tournaments, incoming.activeId) || Object.values(incoming.tournaments).some(t => !validTournament(t)) || payload.logs.some(e => !e || typeof e !== 'object' || typeof e.type !== 'string' || !e.data || typeof e.data !== 'object')) fail('Файл повреждён: отсутствуют обязательные данные турнира или журнала');
    const installMedia = media.prepareImport(incoming, payload.media);
    const entries = cleanExport(payload.logs);
    const restorePins = t => {
      if (t.teams.length > 1000 || t.teams.some(team => !team || typeof team.id !== 'string' || typeof team.name !== 'string')) fail('Некорректные данные команд');
      const pins = makeTeams(t.teams.map(team => ({ name: team.name }))); t.teams.forEach((team, i) => { team.pin = pins[i].pin; });
      normalize(t);
    };
    restorePins(incoming); Object.values(incoming.tournaments).forEach(restorePins);
    incoming.auth = db.auth; incoming.offlineSecret = db.offlineSecret;
    incoming.displayView = 'start'; incoming.reveal.active = false;
    const backup = store.backup('before-import');
    if (dataFile && !backup) fail('Не удалось создать резервную копию перед импортом');
    installMedia();
    store.replace(incoming, entries);
    clearAllTimers(); stopCeremony(); auto.running = false; auto.phase = 'idle'; auto.finished = false; auto.brokeTo.clear();
    for (const sid of teamSockets.values()) { const sk = io.sockets.sockets.get(sid); if (sk) { sk.data.teamId = null; sk.disconnect(true); } }
    teamSockets.clear(); rtts.clear(); nonceCache.clear(); rejLogged.clear(); openHr = firstHr = quizHr = answersHr = null;
    for (const key of Object.keys(db)) delete db[key];
    Object.assign(db, incoming); logs.clear();
    for (const e of entries) { const id = e.tid || db.activeId; if (!logs.has(id)) logs.set(id, []); logs.get(id).push(e); }
    for (const [id, list] of logs) if (list.length > MAX_LOG) logs.set(id, list.slice(-MAX_LOG));
    db.log = logs.get(db.activeId) || []; logs.set(db.activeId, db.log);
    commit();
    return { backup };
  }
  app.get('/api/data/export.json', (req, res) => {
    if (!httpIsAdmin(req)) return res.status(403).json({ ok: false, error: 'Нет прав администратора' });
    res.attachment(`quiz-arena-backup-${new Date().toISOString().slice(0, 10)}.json`).json(exportData());
  });
  app.get('/api/data/log.jsonl', (req, res) => {
    if (!httpIsAdmin(req)) return res.status(403).json({ ok: false, error: 'Нет прав администратора' });
    const entries = exportData().logs.filter(e => req.query.all === '1' || (e.tid || db.activeId) === db.activeId);
    res.type('application/x-ndjson').attachment('quiz-arena-log.jsonl').send(entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  });
  app.post('/api/data/import.json', (req, res, next) => {
    if (!httpIsAdmin(req)) return res.status(403).json({ ok: false, error: 'Нет прав администратора' });
    next();
  }, express.json({ limit: '150mb' }), (req, res) => {
    try { res.json({ ok: true, ...importData(req.body) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message || 'Не удалось импортировать файл' }); }
  }, (err, _req, res, _next) => res.status(err.status || 400).json({ ok: false, error: err.status === 413 ? 'Файл больше 150 МБ' : 'Некорректный JSON' }));
  app.get('/api/export/:kind.csv', (req, res) => {
    if (!httpIsAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    let body;
    if (req.params.kind === 'results') {
      body = csv([['Место', 'Команда', 'Возраст', 'Баллы', 'Верных ответов', 'Время верных ответов, с'],
        ...(activeAge() ? AGES.flatMap(age => board(age)) : board()).map((r) => [r.rank, r.name, r.age ?? '', r.score, r.correct, r.timeMs === null ? '' : (r.timeMs / 1000).toFixed(3)])]);
    } else if (req.params.kind === 'history') {
      const rows = [...db.history];
      if (db.quiz.id) rows.push({ block: db.quiz.block, question: db.tournament.question, text: db.quiz.question, points: db.quiz.points, difficulty: db.quiz.difficulty, delivery: db.quiz.delivery,
        answers: Object.values(db.quiz.answers).map((a) => ({ teamName: a.teamName, teamId: a.teamId, text: a.text, correct: a.verdict, points: a.points, mono: a.mono })) });
      body = csv([['Блок', 'Вопрос №', 'Вопрос', 'Сложность', 'Баллы за вопрос', 'Команда', 'Ответ', 'Верно', 'Начислено', 'Время ответа, с', 'Доставка вопроса, мс'],
        ...rows.flatMap((h) => h.answers.map((a) => [h.block, h.question, h.text, h.difficulty ?? '', h.points ?? '', a.teamName, a.text, a.correct === true ? 'да' : a.correct === false ? 'нет' : '', a.points, (a.mono / 1000).toFixed(3), h.delivery?.[a.teamId] ?? '']))]);
    } else if (req.params.kind === 'stats') {
      const blocks = [...new Set((activeAge() ? Object.values(db.ageQuestions).flat() : questions()).map((q) => q.block ?? 1))].sort((x, y) => x - y);
      body = csv([['Команда', 'Возраст', 'Баллы', 'Ответов', 'Верных', 'Сумма времени верных, с', 'Среднее время ответа, с', 'Средняя доставка вопроса, мс', ...blocks.map((b) => `Блок ${b}, баллы`)],
        ...teamStats().map((r) => [r.name, r.age ?? '', r.score, r.answered, r.correct, (r.timeCorrectMs / 1000).toFixed(3), r.avgAnswerMs == null ? '' : (r.avgAnswerMs / 1000).toFixed(3), r.avgDeliveryMs ?? '', ...blocks.map((b) => r.perBlock[b]?.points ?? 0)])]);
    } else if (req.params.kind === 'buzzes') {
      body = csv([['Время (сервер)', 'Раунд', 'Вопрос', 'ID нажатия', 'Порядок', 'Тип', 'Команда', 'Мс от открытия'],
        ...db.log.filter((e) => e.type.startsWith('buzz.') && e.type !== 'buzz.rejected')
          .map((e) => [e.ts, e.data.round, e.data.question, e.data.roundId, e.data.order, e.data.kind, e.data.teamName, e.data.mono])]);
    } else if (req.params.kind === 'answers') {
      body = csv([['Время (сервер)', 'Раунд', 'Вопрос', 'Команда', 'Ответ'],
        ...db.log.filter((e) => e.type === 'answer.submit').map((e) => [e.ts, e.data.round, e.data.question, e.data.teamName, e.data.text])]);
    } else if (req.params.kind === 'log') {
      body = csv([['#', 'Время (сервер)', 'Тип', 'Данные'], ...db.log.map((e) => [e.id, e.ts, e.type, JSON.stringify(e.data)])]);
    } else return res.status(404).end();
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="quiz-arena-${req.params.kind}.csv"`);
    res.send(body);
  });

  if (staticDir) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      if (req.path === '/') return res.redirect('/play');
      const idx = path.join(staticDir, 'index.html');
      if (fs.existsSync(idx)) return res.sendFile(idx);
      res.status(503).type('text').send('Frontend не собран. Выполните: npm run build');
    });
  }

  // ---- рассылка ----
  const broadcastPublic = () => io.emit('state', publicState());
  /** Состояние админки с коалесцией: чем больше команд, тем реже (при 1000 команд состояние весит сотни КБ). */
  function scheduleAdmin() {
    if (adminTimer) return;
    const delay = Math.max(40, Math.min(500, Math.round(db.teams.length * 0.4)));
    adminTimer = setTimeout(() => {
      adminTimer = null;
      if (io.sockets.adapter.rooms.has('admin')) io.to('admin').emit('a:state', adminState());
    }, delay);
  }
  /** Проектор обновляется не чаще раза в 250 мс: счётчик ответов и подключений меняется потоком, телефонам он не нужен. */
  let presenceTimer = null;
  function queueDisplay() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => { presenceTimer = null; io.to('display').emit('state', publicState()); }, 250);
  }
  function presenceChanged() { scheduleAdmin(); queueDisplay(); }
  /** Каждая команда получает только свои очки (а не таблицу). */
  function emitMine() {
    for (const [tid, sid] of teamSockets) {
      const t = findTeam(tid); const sk = io.sockets.sockets.get(sid);
      if (t && sk) sk.emit('me', { score: t.score, age: t.age ?? null });
    }
  }
  const commit = () => { persist(); broadcastPublic(); emitMine(); scheduleAdmin(); };

  // ---- логика раунда ----
  function handleBuzz(teamId, payload, source = 'team') {
    const r = db.round;
    const nonce = typeof payload?.nonce === 'string' ? payload.nonce.slice(0, 64) : null;
    const nkey = nonce ? `${teamId}:${nonce}` : null;
    if (nkey && nonceCache.has(nkey)) return nonceCache.get(nkey);

    const reply = (res) => { if (nkey) nonceCache.set(nkey, res); return res; };
    const reject = (reason) => {
      const k = `${teamId}|${r.id}|${reason}`;
      if (!rejLogged.has(k) && rejLogged.size < 5000) {
        rejLogged.add(k);
        log('buzz.rejected', { ...ctx(), teamId, teamName: findTeam(teamId)?.name, reason, source });
      }
      return reply({ ok: false, result: 'rejected', reason });
    };

    const team = findTeam(teamId);
    if (!team) return reject('unknown_team');
    if (team.disabled) return reject('disabled');
    if (!eligible(team)) return reject('inactive_age');
    if (typeof payload?.roundId !== 'string' || payload.roundId !== r.id) return reject('stale');
    const existing = r.buzzes.findIndex((b) => b.teamId === teamId);
    if (existing >= 0) return { ok: true, result: 'duplicate', order: existing + 1 };
    if (r.excluded.includes(teamId)) return reject('excluded');

    const hr = process.hrtime.bigint();
    let kind;
    if (r.status === 'open') {
      kind = 'first';
    } else if (r.status === 'buzzed' && !r.sealed && firstHr !== null &&
      Number(hr - firstHr) / 1e6 <= db.settings.queueWindowMs) {
      kind = 'queued';
    } else {
      return reject(r.status === 'buzzed' ? 'late' : 'closed');
    }

    const now = Date.now();
    const rec = { teamId, teamName: team.name, order: r.buzzes.length + 1, kind, ts: now, mono: monoMs(hr), source };
    r.buzzes.push(rec);
    if (kind === 'first') {
      r.status = 'buzzed'; r.answererIdx = 0; r.firstAt = now; firstHr = hr; db.played = true;
      answerTimer(r);
      broadcastPublic(); // победитель фиксируется синхронно, до любых await
    }
    log(`buzz.${kind}`, { ...ctx(), teamId, teamName: team.name, order: rec.order, kind, mono: rec.mono, source });
    if (kind === 'queued') scheduleAdmin();
    return reply({ ok: true, result: kind, order: rec.order });
  }

  function openRound() {
    stopCeremony();
    if (db.quiz.status === 'open') fail('Сейчас идёт письменный вопрос — сначала закройте приём ответов');
    if (auto.running && auto.mode === 'quiz') fail('Идёт автоигра с письменными ответами');
    ensureAgeReady();
    const r = db.round;
    const ok = r.status === 'idle' || r.status === 'locked' || (r.status === 'judged' && r.verdict && !r.verdict.correct);
    if (!ok) fail(r.status === 'open' ? 'Кнопки уже открыты' : 'Сначала RESET (или оцените ответ)');
    const id = `r${++db.roundSeq}-${uid().slice(0, 4)}`;
    db.round = { ...blankRound(), id, status: 'open', openedAt: Date.now(), excluded: [...r.excluded] };
    openHr = process.hrtime.bigint(); firstHr = null;
    nonceCache.clear(); rejLogged.clear();
    const sec = qSeconds(getQ(db.tournament.question), 'buzz');
    setTimer('round', db.round, 'open', sec * 1000, () => {
      if (db.round.id === id && db.round.status === 'open') {
        db.round.status = 'locked'; db.round.timer = null;
        log('round.autolock', { ...ctx(), afterSec: sec });
        if (auto.running && auto.mode === 'buzz') beginPause();
        commit();
      }
    });
    if (db.displayView !== 'auto') db.displayView = 'auto';
    auto.block = getQ(db.tournament.question)?.block || 1;
    log('round.open', ctx());
    commit();
    return { roundId: id };
  }
  function lockRound() {
    const r = db.round;
    if (r.status === 'open') { r.status = 'locked'; clearTimer('round', r); }
    else if (r.status === 'buzzed') r.sealed = true;
    else return {};
    log('round.lock', ctx());
    if (auto.running && auto.mode === 'buzz' && r.status === 'locked') beginPause();
    commit();
    return {};
  }
  function resetRound(advance) {
    const adv = advance ?? db.played;
    clearTimer('round');
    db.round = blankRound(); openHr = null; firstHr = null;
    nonceCache.clear(); rejLogged.clear();
    db.played = false;
    if (adv) advanceQuestion();
    db.displayView = 'auto';
    log('round.reset', { ...ctx(), advanced: !!adv });
    commit();
    return {};
  }
  function judge(correct, points) {
    const r = db.round;
    if (r.status !== 'buzzed') fail('Нет команды, ожидающей оценки');
    const a = answerBuzz(); const team = findTeam(a.teamId);
    if (!team) fail('Команда удалена');
    const pts = points !== undefined ? int(points, -10000, 10000, 'Баллы') : (correct ? qPoints(getQ(db.tournament.question)) : db.settings.wrongPoints);
    team.score += pts;
    db.buzzHistory.push({ roundId: r.id, teamId: team.id, teamName: team.name, correct: !!correct, points: pts, mono: a.mono, question: db.tournament.question, age: activeAge(), block: getQ(db.tournament.question)?.block || 1 });
    r.verdict = { teamId: team.id, name: team.name, correct: !!correct, points: pts };
    r.status = 'judged'; r.sealed = true; clearTimer('round', r);
    if (!correct) r.excluded.push(team.id);
    db.played = true;
    log('judge', { ...ctx(), teamId: team.id, teamName: team.name, correct: !!correct, points: pts, score: team.score });
    afterJudgeAuto(!!correct);
    commit();
    return {};
  }
  function undoJudge() {
    const r = db.round;
    if (r.status !== 'judged' || !r.verdict) fail('Нечего отменять');
    const team = findTeam(r.verdict.teamId);
    if (team) team.score -= r.verdict.points;
    const record = db.buzzHistory.findLastIndex(a => a.roundId === r.id && a.teamId === r.verdict.teamId);
    if (record >= 0) db.buzzHistory.splice(record, 1);
    r.excluded = r.excluded.filter((id) => id !== r.verdict.teamId);
    log('judge.undo', { ...ctx(), teamId: r.verdict.teamId, teamName: r.verdict.name, points: r.verdict.points });
    r.verdict = null; r.status = 'buzzed';
    answerTimer(r);
    commit();
    return {};
  }
  function passRound() {
    const r = db.round;
    if (r.status !== 'judged' || !r.verdict || r.verdict.correct) fail('Передача возможна только после неверного ответа');
    const idx = r.buzzes.findIndex((b, i) => i > r.answererIdx && !r.excluded.includes(b.teamId) && findTeam(b.teamId) && !findTeam(b.teamId).disabled);
    if (idx < 0) fail('Нет других претендентов — откройте кнопки заново');
    r.answererIdx = idx; r.status = 'buzzed'; r.verdict = null; r.sealed = true;
    answerTimer(r);
    log('round.pass', { ...ctx(), teamId: r.buzzes[idx].teamId, teamName: r.buzzes[idx].teamName });
    commit();
    return {};
  }

  // ---- письменные ответы ----
  function handleAnswer(teamId, p) {
    const q = db.quiz;
    const team = findTeam(teamId);
    if (!team || team.disabled) return { ok: false, result: 'rejected', reason: 'unknown_team' };
    if (!eligible(team)) return { ok: false, result: 'rejected', reason: 'inactive_age' };
    if (typeof p?.quizId !== 'string' || p.quizId !== q.id) return { ok: false, result: 'rejected', reason: 'stale' };
    if (q.reading) return { ok: false, result: 'rejected', reason: 'reading' }; // ведущий ещё читает вопрос
    let text; let choice = null;
    if (q.options.length) { // вопрос с вариантами: принимается только номер варианта
      if (!Number.isInteger(p.choice) || p.choice < 0 || p.choice >= q.options.length) return { ok: false, result: 'rejected', reason: 'bad_choice' };
      choice = p.choice; text = `${LETTERS[choice]}) ${q.options[choice]}`;
    } else {
      text = typeof p.text === 'string' ? p.text.trim().replace(/\s+/g, ' ') : '';
      if (!text) return { ok: false, result: 'rejected', reason: 'empty' };
      if (text.length > 300) return { ok: false, result: 'rejected', reason: 'too_long' };
    }
    const now = Date.now();
    // Один ответ на команду: повтор того же ответа — идемпотентен (даже после закрытия: телефон мог не получить подтверждение), другой — отказ.
    const prev = q.answers[teamId];
    if (prev) {
      if (prev.text === text) return { ok: true, result: 'saved' };
      return { ok: false, result: 'rejected', reason: 'already_answered' };
    }
    if (q.status !== 'open') return { ok: false, result: 'rejected', reason: 'closed' };
    q.answers[teamId] = {
      teamId, teamName: team.name, text, choice, ts: now,
      mono: Math.round(Number(process.hrtime.bigint() - (answersHr ?? quizHr)) / 1e3) / 1e3,
      verdict: null, points: 0,
    };
    log('answer.submit', { round: db.tournament.round, question: db.tournament.question, block: q.block, teamId, teamName: team.name, text, choice, mono: q.answers[teamId].mono });
    scheduleAdmin(); queueDisplay(); // счётчик «ответили» нужен только проектору и админу, не телефонам
    // Отключившиеся команды тоже получают всё время вопроса на переподключение.
    if (auto.running && auto.mode === 'quiz') {
      const allAnswered = () => groupTeams().filter(t => !t.disabled).every(t => !!db.quiz.answers[t.id]);
      if (allAnswered()) {
        const qid = q.id;
        setTimeout(() => { if (auto.running && db.quiz.id === qid && db.quiz.status === 'open' && allAnswered()) { log('quiz.allAnswered', { quizId: qid }); closeQuiz(); } }, 1000);
      }
    }
    return { ok: true, result: 'saved' };
  }
  function openQuiz(question) {
    stopCeremony();
    ensureAgeReady();
    const q = db.quiz;
    if (db.round.status === 'open') fail('Сначала закройте кнопки (LOCK BUZZERS)');
    if (q.status === 'open') fail('Приём ответов уже открыт');
    const item = getQ(db.tournament.question);
    let text = typeof question === 'string' ? question.trim().slice(0, 500) : '';
    const useItem = !text && q.status === 'idle' && !!item;
    if (useItem) text = item.q;
    if (q.status === 'idle') {
      db.quiz = {
        ...blankQuiz(), id: `q${++db.roundSeq}-${uid().slice(0, 4)}`, status: 'open', question: text, image: useItem ? (item.image || null) : null, openedAt: Date.now(),
        options: useItem ? item.options : [], correct: useItem ? item.correct : -1, key: useItem ? item.a : '', accept: useItem ? (item.accept || []) : [],
        points: useItem ? qPoints(item) : null, difficulty: useItem ? item.difficulty : null, sec: useItem ? item.sec : null, block: item?.block ?? 1,
      };
    } else { q.status = 'open'; if (text) q.question = text; }
    const fresh = !db.quiz.answeredOnce;
    quizHr = process.hrtime.bigint();
    auto.block = db.quiz.block;
    const sec = qSeconds(db.quiz, 'quiz');
    const qid = db.quiz.id;
    db.displayView = 'auto'; db.reveal.active = false; db.played = true;
    log('quiz.open', { round: db.tournament.round, question: db.tournament.question, block: db.quiz.block, quizId: db.quiz.id, text: db.quiz.question, sec, points: db.quiz.points, difficulty: db.quiz.difficulty });
    // сначала ведущий читает вопрос: он уже на экране, но ответы не принимаются и таймер ответа не идёт
    const read = fresh ? readMs(db.quiz) : 0;
    if (read > 0) {
      db.quiz.reading = true;
      setTimer('quiz', db.quiz, 'read', read, () => { if (db.quiz.id === qid) startAnswers(); });
      commit(); return { quizId: qid };
    }
    startAnswers(); return { quizId: qid };
  }
  /** Время на чтение: настройка readSec (-1 — по длине вопроса, 0 — без чтения). */
  function readMs(q) {
    const set = db.settings.readSec ?? readSecDefault;
    if (set === 0 || !q.question) return 0;
    if (set > 0) return set * 1000;
    const len = q.question.length + (q.options?.length ? q.options.join(' ').length : 0);
    return Math.max(5, Math.min(15, Math.round(len / 14) + 3)) * 1000; // вслух примерно 14 знаков в секунду
  }
  /** Чтение закончилось (или ведущий нажал «Открыть приём») — принимаем ответы, пошёл таймер. */
  function startAnswers() {
    const q = db.quiz;
    if (q.status !== 'open' || !q.id) return {};
    const qid = q.id;
    q.reading = false; q.answeredOnce = true;
    answersHr = process.hrtime.bigint();
    const sec = qSeconds(q, 'quiz');
    setTimer('quiz', q, 'quiz', sec * 1000, () => { if (db.quiz.id === qid && db.quiz.status === 'open') closeQuiz(); });
    log('quiz.answers', { quizId: qid, sec });
    commit(); return {};
  }
  function closeQuiz() {
    if (db.quiz.status !== 'open') return {};
    db.quiz.status = 'closed'; db.quiz.closedAt = Date.now(); clearTimer('quiz', db.quiz);
    log('quiz.close', { quizId: db.quiz.id, answers: Object.keys(db.quiz.answers).length });
    autoGradeNow();
    if (auto.running && auto.mode === 'quiz') beginPause();
    commit(); return {};
  }

  // ---- автопрограмма ----
  const norm = (t) => String(t).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  /** Автооценка: вариант совпал с верным; текст совпал с одним из ответов (варианты через «/», регистр/ё/знаки не важны, опечатки — см. grade.js). */
  function autoGradeNow() {
    if (!db.settings.autoGrade) return;
    const q = db.quiz;
    const choice = q.options.length > 0;
    const okAnswers = choice ? [] : [q.key, ...(q.accept || [])].flatMap(k => String(k || '').split('/')).map(norm).filter(Boolean);
    if (choice ? q.correct < 0 : okAnswers.length === 0) return;
    let n = 0;
    for (const a of Object.values(q.answers)) {
      if (a.verdict !== null || !findTeam(a.teamId)) continue; // команду удалили во время вопроса — её ответ не оцениваем
      markAnswer(a.teamId, choice ? a.choice === q.correct : matchesAnswer(a.text, [q.key, ...(q.accept || [])], { strict: db.settings.strictGrade === true && activeAge() !== 'junior' }), true); n++; // опечатки и слова вокруг прощаются
    }
    if (n) log('auto.grade', { ...ctx(), graded: n });
  }
  function stopAuto(reason) {
    if (!auto.running) return;
    auto.running = false; auto.phase = 'idle';
    if (db.quiz.timer?.kind === 'pause') clearTimer('quiz', db.quiz);
    if (db.round.timer && ['pause', 'result'].includes(db.round.timer.kind)) clearTimer('round', db.round);
    log('auto.stop', { ...ctx(), reason, mode: auto.mode });
  }
  /** Таймер ответа команды; в авто-режиме BUZZ по истечении времени ответ засчитывается неверным. */
  function answerExpire(r) {
    const rid = r.id; const idx = r.answererIdx;
    return () => {
      if (auto.running && auto.mode === 'buzz' && db.round.id === rid && db.round.status === 'buzzed' && db.round.answererIdx === idx) {
        log('auto.timeout', { ...ctx(), teamId: answerBuzz()?.teamId });
        judge(false);
      }
    };
  }
  function answerTimer(r) {
    setTimer('round', r, 'answer', db.settings.answerSec * 1000, auto.running && auto.mode === 'buzz' ? answerExpire(r) : null);
  }
  /** Авто-BUZZ после оценки: верно → итог → пауза; неверно → следующему претенденту, а если их нет — итог → пауза. */
  function afterJudgeAuto(correct) {
    if (!auto.running || auto.mode !== 'buzz') return;
    const r = db.round;
    if (!correct) {
      const idx = r.buzzes.findIndex((b, i) => i > r.answererIdx && !r.excluded.includes(b.teamId) && findTeam(b.teamId) && !findTeam(b.teamId).disabled);
      if (idx >= 0) { passRound(); return; }
    }
    const ms = db.settings.resultSec * 1000;
    if (ms <= 0) { beginPause(); return; }
    const rid = r.id;
    setTimer('round', r, 'result', ms, () => { if (auto.running && db.round.id === rid) { beginPause(); commit(); } });
  }
  function beginPause() {
    if (auto.mode === 'quiz') autoGradeNow();
    if (auto.mode === 'quiz' && Object.values(db.quiz.answers).some(a => a.verdict === null && findTeam(a.teamId))) {
      auto.phase = 'review'; log('auto.review', { ...ctx() }); commit(); return;
    }
    auto.phase = 'pause';
    const last = nextTurn().question === null;
    const ms = last ? 0 : db.settings.pauseSec * 1000; // после последнего вопроса паузы «до вопроса №N+1» нет
    if (ms <= 0) { advanceAuto(); return; }
    const slot = auto.mode === 'quiz' ? 'quiz' : 'round';
    const holder = auto.mode === 'quiz' ? db.quiz : db.round;
    const id = holder.id;
    setTimer(slot, holder, 'pause', ms, () => { if (auto.running && (auto.mode === 'quiz' ? db.quiz : db.round).id === id) advanceAuto(); });
  }
  function advanceAuto() {
    if (!auto.running) return;
    const doneBlock = auto.block;
    const previousAge = activeAge();
    if (auto.mode === 'quiz') resetQuiz(true); else resetRound(true);
    if (questions().length > 0 && db.tournament.question > questions().length) {
      store.backup('final');
      stopAuto('list-end'); auto.finished = true; auto.doneBlock = doneBlock;
      db.displayView = 'closing'; // итоги скрыты, пока ведущий сам их не откроет
      commit();
      return;
    }
    const next = getQ(db.tournament.question);
    // перерыв — один раз на каждый новый блок; при лигах по кругу лига меняется каждый вопрос, поэтому смотрим на номер блока, а не на лигу
    const newBlock = next && (activeAge() === previousAge ? next.block !== doneBlock : next.block > doneBlock && !auto.brokeTo.has(next.block));
    if (db.settings.blockBreak && newBlock) {
      auto.brokeTo.add(next.block);
      store.backup(`block${doneBlock}`);
      auto.phase = 'blockbreak'; auto.doneBlock = doneBlock;
      log('auto.blockbreak', { ...ctx(), doneBlock, nextBlock: next.block });
      commit();
      return;
    }
    auto.phase = 'question';
    try { if (auto.mode === 'quiz') openQuiz(''); else openRound(); } catch (e) { stopAuto(`error: ${e.message}`); commit(); }
  }
  function resumeAuto() {
    if (!auto.running || !['blockbreak', 'review'].includes(auto.phase)) fail('Сейчас нет перерыва или проверки ответов');
    if (auto.phase === 'review') {
      if (Object.values(db.quiz.answers).some(a => a.verdict === null && findTeam(a.teamId))) fail('Сначала оцените все ответы');
      log('auto.review.complete', ctx()); beginPause(); commit(); return {};
    }
    auto.phase = 'question';
    log('auto.resume', ctx());
    try { if (auto.mode === 'buzz') openRound(); else openQuiz(''); } catch (e) { stopAuto(`error: ${e.message}`); throw e; }
    return {};
  }
  /** Сыграть заново: счёт 0, вопрос 1, история ответов очищается. Команды и PIN остаются. */
  function restartGame(allAges = false) {
    stopCeremony();
    auto.brokeTo = new Set();
    stopAuto('restart');
    clearTimer('quiz'); clearTimer('round');
    db.quiz = blankQuiz(); db.round = blankRound(); openHr = null; firstHr = null;
    nonceCache.clear(); rejLogged.clear();
    db.history = !allAges && activeAge() ? db.history.filter(h => h.age !== activeAge()) : [];
    db.buzzHistory = !allAges && activeAge() ? db.buzzHistory.filter(h => h.age !== activeAge()) : [];
    db.played = false;
    (allAges ? db.teams : groupTeams()).forEach((t) => { t.score = 0; });
    if (allAges && db.tournament.ageMode) {
      db.tournament.progress = Object.fromEntries(AGES.map(age => [age, { question: 1, round: 1 }]));
      db.tournament.age = AGES.find(age => db.ageQuestions[age].length > 0) || 'junior';
      db.tournament.resultAge = db.tournament.age;
    }
    db.tournament.question = 1; db.tournament.round = 1;
    if (activeAge()) db.tournament.progress[activeAge()] = { question: 1, round: 1 };
    db.reveal = blankReveal(); db.displayView = 'start';
    auto.finished = false; auto.doneBlock = null; auto.block = 1;
    log('game.restart', { ...ctx(), allAges }); commit(); return {};
  }
  // ---- одна церемония: лиги → общий топ-3 → полная таблица ----
  const CER = { intro: 4000, step: 8000, hold: 8000, ...(ceremonyTiming || {}) };
  const AWARD_PAGE = 6;
  const ceremony = { running: false, groups: [], plan: [], idx: 0, award: -1, page: 0, timer: null, endsAt: null, durationMs: 0, generation: 0 };
  function ceremonyState() {
    const current = ceremony.plan[ceremony.idx];
    const award = current?.awards[ceremony.award];
    const next = current?.awards[ceremony.award + 1];
    return {
      running: ceremony.running, group: ceremony.running ? ceremony.groups[ceremony.idx] : null,
      step: ceremony.running ? ceremony.idx + 1 : 0, total: ceremony.groups.length,
      order: ceremony.groups, phase: ceremony.running ? (award ? 'place' : 'intro') : 'idle',
      rank: ceremony.running ? (award?.rank ?? null) : null,
      winners: ceremony.running && award ? award.rows.slice(ceremony.page * AWARD_PAGE, (ceremony.page + 1) * AWARD_PAGE).map(pubRow) : [],
      page: ceremony.running && award ? ceremony.page + 1 : 0,
      pages: ceremony.running && award ? Math.ceil(award.rows.length / AWARD_PAGE) : 0,
      shared: ceremony.running && award ? award.rows.length > 1 : false,
      nextRank: ceremony.running ? (next?.rank ?? null) : null,
      nextGroup: ceremony.running ? (ceremony.groups[ceremony.idx + 1] ?? null) : null,
      endsAt: ceremony.running ? ceremony.endsAt : null, durationMs: ceremony.durationMs,
    };
  }
  function stopCeremony() {
    if (ceremony.timer) clearTimeout(ceremony.timer);
    ceremony.timer = null; ceremony.endsAt = null; ceremony.durationMs = 0; ceremony.generation++;
    if (ceremony.running) { ceremony.running = false; log('ceremony.stop', {}); }
  }
  function showAllResults() {
    if (db.tournament.ageMode) db.tournament.resultAge = 'all';
    db.reveal = blankReveal(); db.displayView = 'leaderboard';
    log('ceremony.standings', {}); commit();
  }
  function scheduleAllResults() {
    if (ceremony.timer) clearTimeout(ceremony.timer);
    const id = db.activeId;
    ceremony.timer = setTimeout(() => {
      ceremony.timer = null;
      if (db.activeId === id) showAllResults();
    }, CER.hold);
  }
  function ceremonySchedule(ms) {
    if (ceremony.timer) clearTimeout(ceremony.timer);
    ceremony.durationMs = ms; ceremony.endsAt = Date.now() + ms;
    const generation = ceremony.generation; const id = db.activeId;
    ceremony.timer = setTimeout(() => {
      ceremony.timer = null;
      if (ceremony.running && ceremony.generation === generation && db.activeId === id) ceremonyStep();
    }, ms);
  }
  function ceremonyNextGroup() {
    ceremony.idx++;
    if (ceremony.idx >= ceremony.groups.length) {
      ceremony.running = false; ceremony.timer = null; ceremony.endsAt = null;
      log('ceremony.done', {}); showAllResults(); return;
    }
    ceremonyBeginGroup();
  }
  function ceremonyStep() {
    if (!ceremony.running) return;
    const current = ceremony.plan[ceremony.idx];
    const previous = current.awards[ceremony.award];
    if (previous && (ceremony.page + 1) * AWARD_PAGE < previous.rows.length) ceremony.page++;
    else { ceremony.award++; ceremony.page = 0; }
    const award = current.awards[ceremony.award];
    if (!award) { ceremonyNextGroup(); return; }
    const already = current.awards.slice(0, ceremony.award).reduce((sum, a) => sum + a.rows.length, 0);
    db.reveal.shown = current.start + already + Math.min(award.rows.length, (ceremony.page + 1) * AWARD_PAGE);
    const lastPage = (ceremony.page + 1) * AWARD_PAGE >= award.rows.length;
    const lastPlace = ceremony.award === current.awards.length - 1;
    ceremonySchedule(lastPage && lastPlace ? CER.hold : CER.step);
    log('ceremony.place', { group: current.group, rank: award.rank, page: ceremony.page + 1, teams: award.rows.slice(ceremony.page * AWARD_PAGE, (ceremony.page + 1) * AWARD_PAGE).map(r => r.id) });
    commit();
  }
  function ceremonyBeginGroup() {
    const current = ceremony.plan[ceremony.idx];
    if (db.tournament.ageMode) db.tournament.resultAge = current.group;
    ceremony.award = -1; ceremony.page = 0;
    db.reveal = { active: true, mode: 'top3', shown: current.start };
    db.displayView = 'reveal';
    ceremonySchedule(CER.intro);
    log('ceremony.group', { group: current.group }); commit();
  }
  function startCeremony() {
    if (auto.running || questionInProgress()) fail('Сначала завершите вопрос и остановите автоматическое проведение');
    if (Object.values(db.quiz.answers).some(a => a.verdict === null && findTeam(a.teamId))) fail('Сначала проверьте все ответы текущего вопроса');
    const groups = db.tournament.ageMode ? [...AGES.filter(a => groupTeams(a).length > 0), 'all'] : ['all'];
    // Фиксируем призёров при запуске. Для ничьих объявляется место со всеми командами, а не первые три строки.
    const plan = groups.map(group => {
      const rows = board(group === 'all' ? null : group);
      const ranks = [...new Set(rows.filter(r => r.rank <= 3).map(r => r.rank))].sort((a, b) => b - a);
      return { group, start: revealStart(rows, 'top3'), awards: ranks.map(rank => ({ rank, rows: rows.filter(r => r.rank === rank) })) };
    }).filter(p => p.awards.length > 0);
    if (!plan.length) fail('Нет команд для награждения');
    stopCeremony();
    ceremony.plan = plan; ceremony.groups = plan.map(p => p.group);
    ceremony.idx = 0; ceremony.running = true;
    log('ceremony.start', { groups: ceremony.groups });
    ceremonyBeginGroup(); return {};
  }

  const playableAge = (age) => groupTeams(age).some((t) => !t.disabled) && (db.tournament.progress?.[age]?.question ?? (age === activeAge() ? db.tournament.question : 1)) <= (db.ageQuestions[age] || []).length;
  function validateAutoTimers(mode) {
    const banks = activeAge() ? AGES.filter(a => groupTeams(a).some(t => !t.disabled)).map(a => {
      const question = a === activeAge() ? db.tournament.question : (db.tournament.progress?.[a]?.question ?? 1);
      return db.ageQuestions[a].slice(question - 1);
    }) : [questions().slice(db.tournament.question - 1)];
    if (banks.some(bank => bank.some(item => qSeconds(item, mode) <= 0))) fail('Для всех оставшихся вопросов автопроведения задайте время ответа больше нуля');
  }
  function startAuto(mode, clean = false) {
    stopCeremony();
    // текущая лига без команд или уже доиграна — начинаем с первой лиги, где есть кого играть
    if (activeAge() && !auto.running && db.quiz.status !== 'open' && !['open', 'buzzed'].includes(db.round.status)) {
      const cur = activeAge();
      const curOk = groupTeams(cur).some((t) => !t.disabled) && db.tournament.question <= questions().length;
      if (!curOk) { const next = AGES.find((a) => a !== cur && playableAge(a)); if (next) adminActions['a:age:activate']({ age: next }); }
    }
    if (auto.running) fail('Автопроведение уже идёт');
    // простая панель: хвосты прошлого вопроса (после «Стоп») убираем сами, без ручного RESET
    if (clean && db.round.status !== 'idle') resetRound();
    if (clean && db.quiz.status !== 'idle') {
      if (db.quiz.status === 'open') closeQuiz();
      if (Object.values(db.quiz.answers).some(a => a.verdict === null && findTeam(a.teamId))) fail('Сначала оцените ответы текущего вопроса');
      resetQuiz();
    }
    if (db.round.status !== 'idle') fail('Сначала сбросьте текущий раунд кнопок (RESET)');
    if (db.quiz.status !== 'idle') fail('Сначала сбросьте текущий письменный вопрос (RESET)');
    if (!questions().length) fail('Добавьте вопросы перед запуском автопроведения');
    if (!groupTeams().some(t => !t.disabled)) fail('Добавьте команды перед запуском автопроведения');
    if (mode === 'buzz') {
      if (db.settings.openSec <= 0 && !(questions().length > 0 && questions().every(item => qSeconds(item, 'buzz') > 0))) fail('Включите «Кнопки открыты, сек» (Турнир → Таймеры): иначе раунд не закончится, если никто не нажмёт');
    } else if (db.settings.quizSec <= 0 && !(questions().length > 0 && questions().every(item => qSeconds(item, 'quiz') > 0))) fail('Включите «Письменный ответ, сек» (Турнир → Таймеры) или задайте секунды у каждого вопроса: иначе вопрос не закончится сам');
    if (questions().length > 0 && db.tournament.question > questions().length) fail('Вопросы в списке закончились — выберите номер вопроса заново');
    validateAutoTimers(mode);
    db.reveal.active = false;
    auto.running = true; auto.mode = mode; auto.phase = 'question'; auto.finished = false; auto.doneBlock = null;
    log('auto.start', { ...ctx(), mode });
    try { if (mode === 'buzz') openRound(); else openQuiz(''); } catch (e) { auto.running = false; auto.phase = 'idle'; throw e; }
    return {};
  }

  function continueAuto() {
    if (auto.running) fail('Автопроведение уже идёт');
    if (db.round.status !== 'idle') fail('Сначала завершите раунд кнопок');
    if (db.quiz.status === 'idle') return startAuto('quiz');
    if (!questions().length || !groupTeams().some(t => !t.disabled)) fail('Добавьте вопросы и команды');
    validateAutoTimers('quiz');
    if (db.quiz.status === 'open' && !db.quiz.timer) fail('У текущего вопроса нет таймера: завершите его вручную');
    auto.running = true; auto.mode = 'quiz'; auto.phase = 'question'; auto.finished = false; auto.block = db.quiz.block;
    log('auto.continue', ctx());
    if (db.quiz.status === 'closed') beginPause();
    commit(); return {};
  }

  /** Результаты вопроса уходят в архив (для итогов блоков, статистики и тай-брейка по времени). */
  function archiveQuiz() {
    const q = db.quiz;
    if (!q.id || (!Object.keys(q.answers).length && !Object.keys(q.delivery).length && !q.openedAt)) return;
    db.history.push({
      age: activeAge(), block: q.block, question: db.tournament.question, quizId: q.id, text: q.question, image: q.image || null, points: q.points, difficulty: q.difficulty,
      options: q.options, correct: q.correct, key: q.key, openedAt: q.openedAt, closedAt: q.closedAt ?? Date.now(), delivery: { ...q.delivery },
      answers: Object.values(q.answers).map((a) => ({ teamId: a.teamId, teamName: a.teamName, text: a.text, choice: a.choice ?? null, correct: a.verdict, points: a.points, mono: a.mono, ts: a.ts })),
    });
    if (db.history.length > 2000) db.history.splice(0, db.history.length - 2000);
  }
  function resetQuiz(force = false) {
    const had = Object.keys(db.quiz.answers).length > 0 || force === true;
    archiveQuiz();
    clearTimer('quiz');
    db.quiz = blankQuiz();
    if (had) advanceQuestion();
    db.played = false; db.displayView = 'auto';
    log('quiz.reset', { advanced: had });
    commit(); return {};
  }
  function markAnswer(teamId, correct, quiet = false) {
    const a = db.quiz.answers[teamId] || fail('Ответ не найден');
    const team = findTeam(teamId) || fail('Команда удалена');
    const verdict = correct === true ? true : correct === false ? false : null;
    const pts = verdict === null ? 0 : verdict ? (db.quiz.points ?? db.settings.correctPoints) : db.settings.wrongPoints;
    team.score += pts - a.points;
    a.verdict = verdict; a.points = pts;
    log('quiz.mark', { quizId: db.quiz.id, teamId, teamName: team.name, correct: verdict, points: pts, score: team.score });
    if (!quiet) commit();
    return {};
  }

  // ---- турниры: независимые контейнеры (команды, счёт, настройки, вопросы, журнал) ----
  const listItem = (id, t, active) => ({
    id, name: t.tournament.name, teams: t.teams.length, round: t.tournament.round, question: t.tournament.question,
    questions: t.questions.length, demo: !!t.demo, createdAt: t.createdAt, active,
    // краткая сводка правил — чтобы настроить любой турнир прямо из списка, не переключаясь на него
    rules: {
      correctPoints: t.settings.correctPoints, wrongPoints: t.settings.wrongPoints,
      quizSec: t.settings.quizSec, readSec: t.settings.readSec ?? -1,
      autoGrade: !!t.settings.autoGrade, showQuestion: !!t.settings.showQuestion,
      ageMode: !!t.tournament.ageMode,
    },
  });
  function tournamentList() {
    return [listItem(db.activeId, db, true), ...Object.entries(db.tournaments).map(([id, t]) => listItem(id, t, false))]
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  function switchTournament(id) {
    stopCeremony();
    if (id === db.activeId) return {};
    const target = db.tournaments[id] || fail('Турнир не найден');
    stopAuto('tournament-switch');
    // 1) выкидываем всех капитанов (их PIN относятся к прежнему турниру) — пока турнир ещё активен
    for (const tm of db.teams) kickTeam(tm.id, 'tournament');
    teamSockets.clear(); rtts.clear();
    log('tournament.deactivate', { name: db.tournament.name });
    // 2) убираем таймеры/открытые раунды и убираем текущий в хранилище
    clearAllTimers(); normalize(db);
    auto.finished = false; auto.doneBlock = null;
    const snap = { createdAt: db.createdAt };
    for (const k of TKEYS) snap[k] = db[k];
    db.tournaments[db.activeId] = snap;
    logs.set(db.activeId, db.log);
    // 3) загружаем выбранный
    for (const k of TKEYS) db[k] = target[k];
    db.createdAt = target.createdAt; db.activeId = id;
    delete db.tournaments[id];
    db.log = logs.get(id) || []; logs.set(id, db.log);
    openHr = null; firstHr = null; quizHr = null; answersHr = null;
    nonceCache.clear(); rejLogged.clear();
    log('tournament.activate', { name: db.tournament.name });
    commit();
    return {};
  }
  function createTournament(p) {
    if (Object.keys(db.tournaments).length >= 50) fail('Слишком много турниров');
    let src = null;
    if (p.copyFrom) src = p.copyFrom === db.activeId ? db : (db.tournaments[p.copyFrom] || fail('Турнир-источник не найден'));
    const name = str(p.name ?? (src ? `${src.tournament.name} (копия)` : 'Новый турнир'), 60, 'Название');
    let names = parseNames(p.teamNames);
    if (!names.length && src) names = src.teams.map((t) => ({ name: t.name, age: t.age ?? null }));
    if (!names.length) {
      const n = int(p.teamCount ?? 30, 0, 1000, 'Число команд');
      names = Array.from({ length: n }, (_, i) => ({ name: `Команда ${String(i + 1).padStart(2, '0')}`, age: null }));
    }
    const settings = { ...(src ? src.settings : DEFAULT_SETTINGS) };
    if (p.correctPoints !== undefined) settings.correctPoints = int(p.correctPoints, -10000, 10000, 'Баллы за верный');
    if (p.wrongPoints !== undefined) settings.wrongPoints = int(p.wrongPoints, -10000, 10000, 'Баллы за неверный');
    if (p.openSec !== undefined) settings.openSec = int(p.openSec, 0, 3600, 'Таймер кнопок');
    if (p.quizSec !== undefined) settings.quizSec = int(p.quizSec, 0, 3600, 'Таймер письменного ответа');
    if (p.answerSec !== undefined) settings.answerSec = int(p.answerSec, 0, 3600, 'Время на ответ');
    if (p.queueWindowMs !== undefined) settings.queueWindowMs = int(p.queueWindowMs, 0, 10000, 'Окно очереди');
    if (p.showQuestion !== undefined) settings.showQuestion = p.showQuestion === true;
    if (p.pauseSec !== undefined) settings.pauseSec = int(p.pauseSec, 0, 600, 'Пауза между вопросами');
    if (p.autoGrade !== undefined) settings.autoGrade = p.autoGrade === true;
    if (p.resultSec !== undefined) settings.resultSec = int(p.resultSec, 0, 60, 'Показ результата');
    if (p.blockBreak !== undefined) settings.blockBreak = p.blockBreak === true;
    if (p.difficultyTiming !== undefined) settings.difficultyTiming = p.difficultyTiming === true;
    if (p.readSec !== undefined) settings.readSec = int(p.readSec, -1, 60, 'Время на чтение вопроса');
    if (p.strictGrade !== undefined) settings.strictGrade = p.strictGrade === true;
    const questions = p.questions !== undefined ? parseQuestions(p.questions) : (src ? src.questions.map((q) => ({ ...q })) : []);
    checkImages(questions);
    const id = `T${uid()}`;
    db.tournaments[id] = makeTournament(name, { settings, teams: makeTeams(names), questions,
      ageMode: p.ageMode === true || !!src?.tournament.ageMode,
      ageQuestions: src ? structuredClone(src.ageQuestions) : undefined, demo: p.demo === true });
    log('tournament.create', { id, name, teams: names.length, copyFrom: p.copyFrom || null });
    if (p.activate !== false) switchTournament(id); else commit();
    return { id };
  }
  function deleteTournament(id) {
    if (id === db.activeId) fail('Активный турнир удалить нельзя — сначала переключитесь на другой');
    const t = db.tournaments[id] || fail('Турнир не найден');
    delete db.tournaments[id]; logs.delete(id);
    log('tournament.delete', { id, name: t.tournament.name });
    commit();
    return {};
  }
  /** Быстрое редактирование турнира на ходу: имя, баллы, таймеры, чтение вслух, автооценка.
   *  Работает и для активного, и для неактивного турнира — активный сразу видит изменения. */
  function updateTournament(id, p) {
    const active = id === db.activeId;
    const t = active ? db : (db.tournaments[id] || fail('Турнир не найден'));
    if (p.name !== undefined) t.tournament.name = str(p.name, 60, 'Название турнира');
    const s = t.settings;
    const patchNum = (key, field, min, max, label) => {
      if (p[field] === undefined) return;
      const v = int(p[field], min, max, label);
      s[key] = v;
      // выключили чтение вслух во время чтения вопроса — сразу открываем приём, не ждём остаток таймера
      if (active && key === 'readSec' && v === 0 && db.quiz.status === 'open' && db.quiz.reading) startAnswers();
    };
    patchNum('correctPoints', 'correctPoints', -10000, 10000, 'Баллы за верный');
    patchNum('wrongPoints', 'wrongPoints', -10000, 10000, 'Баллы за неверный');
    patchNum('openSec', 'openSec', 0, 3600, 'Таймер кнопок');
    patchNum('quizSec', 'quizSec', 0, 3600, 'Таймер письменного ответа');
    patchNum('answerSec', 'answerSec', 0, 3600, 'Время на ответ');
    patchNum('queueWindowMs', 'queueWindowMs', 0, 10000, 'Окно очереди');
    patchNum('pauseSec', 'pauseSec', 0, 600, 'Пауза между вопросами');
    patchNum('resultSec', 'resultSec', 0, 60, 'Показ результата');
    patchNum('readSec', 'readSec', -1, 60, 'Время на чтение вопроса');
    if (p.showQuestion !== undefined) s.showQuestion = p.showQuestion === true;
    if (p.autoGrade !== undefined) s.autoGrade = p.autoGrade === true;
    if (p.blockBreak !== undefined) s.blockBreak = p.blockBreak === true;
    if (p.difficultyTiming !== undefined) s.difficultyTiming = p.difficultyTiming === true;
    if (p.strictGrade !== undefined) s.strictGrade = p.strictGrade === true;
    if (p.ageMode !== undefined) t.tournament.ageMode = p.ageMode === true;
    if (p.questions !== undefined) {
      const qs = parseQuestions(p.questions);
      if (t.tournament.ageMode) {
        // вопросы разложены по лигам — заменяем набор текущей лиги
        t.ageQuestions[t.tournament.age] = qs;
      } else t.questions = qs;
    }
    log('tournament.update', { id, name: t.tournament.name, changed: Object.keys(p) });
    commit();
    return {};
  }

  // ---- полная симуляция: отдельный процесс с ботами-командами, играющими по-настоящему (scripts/simulation.mjs) ----
  const sim = { running: false, child: null, lines: [], startedAt: null, cfg: null };
  function simPush(line) {
    sim.lines.push(line);
    if (sim.lines.length > 80) sim.lines.shift();
    scheduleAdmin();
  }
  function startSim(p) {
    if (sim.running) fail('Симуляция уже идёт');
    if (auto.running) fail('Сначала остановите автопроведение');
    const cfg = {
      teams: int(p.teams ?? 30, 2, 1000, 'Команд'), blocks: int(p.blocks ?? 3, 1, 5, 'Блоков'), perBlock: int(p.perBlock ?? 5, 1, 30, 'Вопросов в блоке'),
      questionSec: int(p.questionSec ?? 20, 2, 600, 'Секунд на вопрос'), pauseSec: int(p.pauseSec ?? 5, 0, 60, 'Пауза'),
      blockWaitSec: int(p.blockWaitSec ?? 8, 0, 120, 'Перерыв между блоками'), revealStepSec: int(p.revealStepSec ?? 3, 0, 30, 'Шаг объявления'),
    };
    const script = path.join(__dirname, '..', 'scripts', 'simulate.mjs');
    if (!fs.existsSync(script)) fail('Скрипт симуляции не найден (scripts/simulate.mjs)');
    const token = newSession(); // одноразовый вход для процесса симуляции
    const args = [script, '--url', `http://127.0.0.1:${actualPort}`, '--teams', String(cfg.teams), '--blocks', String(cfg.blocks), '--per-block', String(cfg.perBlock),
      '--question-sec', String(cfg.questionSec), '--pause', String(cfg.pauseSec), '--block-wait', String(cfg.blockWaitSec), '--reveal-step', String(cfg.revealStepSec)];
    const child = spawn(process.execPath, args, { env: { ...process.env, SIM_TOKEN: token, ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    sim.running = true; sim.child = child; sim.lines = []; sim.startedAt = Date.now(); sim.cfg = cfg;
    log('sim.start', cfg);
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split('\n'); buf = parts.pop();
      for (const l of parts) if (l.trim()) simPush(l);
    };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('exit', (code) => {
      if (buf.trim()) simPush(buf);
      sessions.delete(token);
      sim.running = false; sim.child = null;
      log('sim.end', { code });
      simPush(code === 0 ? '— симуляция завершена —' : `— симуляция остановлена (код ${code ?? 'сигнал'}) —`);
    });
    return {};
  }
  function stopSim() {
    if (!sim.running || !sim.child) fail('Симуляция не запущена');
    sim.child.kill('SIGTERM');
    stopAuto('sim-stop');
    commit();
    return {};
  }

  // ---- команды ----
  function genPin() {
    for (;;) {
      const p = String(crypto.randomInt(1000, 10000));
      if (!db.teams.some((t) => t.pin === p)) return p;
    }
  }
  const nameTaken = (n, exceptId) => db.teams.some((t) => t.id !== exceptId && t.name.toLowerCase() === n.toLowerCase());
  function validPin(p) {
    if (typeof p !== 'string' || !/^[0-9A-Za-z]{3,12}$/.test(p.trim())) fail('PIN: 3–12 букв/цифр');
    return p.trim();
  }
  function addTeam(name, pin) {
    const n = str(name, 40, 'Название');
    if (nameTaken(n)) fail('Команда с таким названием уже есть');
    if (db.teams.length >= 1000) fail('Слишком много команд');
    const t = { id: `t${uid()}`, name: n, pin: pin ? validPin(pin) : genPin(), score: 0, disabled: false, age: null };
    db.teams.push(t);
    log('team.create', { teamId: t.id, teamName: n });
    return t;
  }
  function kickTeam(id, reason) {
    const sid = teamSockets.get(id);
    const s = sid && io.sockets.sockets.get(sid);
    if (s) { s.emit('kicked', { reason }); s.disconnect(true); }
  }
  function genTeams(count, namer) {
    let i = 0;
    while (db.teams.length < count) {
      i++;
      const nm = namer(i);
      if (!nameTaken(nm)) addTeam(nm);
    }
  }

  // ---- socket handlers ----
  const fnAck = (a) => (typeof a === 'function' ? a : () => {});

  const adminActions = {
    'a:state': () => ({ state: adminState() }),
    'a:age:enable': () => {
      if (db.tournament.ageMode) return {};
      if (questionInProgress()) fail('Сначала завершите текущий вопрос');
      archiveQuiz();
      db.ageQuestions.junior = structuredClone(db.questions);
      db.tournament.ageMode = true; db.tournament.age = 'junior'; db.tournament.resultAge = 'junior';
      db.tournament.progress = {}; db.tournament.question = 1; db.tournament.round = 1;
      db.round = blankRound(); db.quiz = blankQuiz(); db.played = false; auto.finished = false;
      db.reveal = blankReveal(); db.displayView = 'start';
      log('age.enable', {}); commit(); return {};
    },
    'a:age:activate': (p) => {
      const age = AGES.includes(p.age) ? p.age : fail('Неизвестная возрастная группа');
      if (!db.tournament.ageMode) fail('Включите возрастные зачёты');
      if (age === activeAge()) return {};
      if (questionInProgress()) fail('Сначала завершите вопрос и остановите автоматическое проведение');
      archiveQuiz(); clearAllTimers();
      db.tournament.progress[activeAge()] = { question: db.tournament.question, round: db.tournament.round };
      db.tournament.age = age; db.tournament.resultAge = age;
      const progress = db.tournament.progress[age] || { question: 1, round: 1 };
      db.tournament.question = progress.question; db.tournament.round = progress.round;
      db.round = blankRound(); db.quiz = blankQuiz(); db.played = false;
      auto.finished = questions().length > 0 && db.tournament.question > questions().length; auto.doneBlock = null;
      db.reveal = blankReveal(); db.displayView = 'start';
      log('age.activate', { age }); commit(); return {};
    },
    'a:age:results': (p) => {
      if (!db.tournament.ageMode || !(AGES.includes(p.age) || p.age === 'all')) fail('Неизвестная возрастная группа');
      stopCeremony();
      db.tournament.resultAge = p.age; db.reveal = blankReveal();
      log('age.results', { age: p.age }); commit(); return {};
    },
    'a:join:set': (p) => {
      const b = p.base == null || p.base === '' ? null : String(p.base).trim().replace(/\/+$/, '');
      if (b !== null && (b.length > 100 || !/^https?:\/\/[\w.\-[\]:]+$/.test(b))) fail('Адрес должен быть вида http://192.168.1.10:3000');
      db.joinBase = b; log('join.set', { base: b }); commit(); return {};
    },
    'a:backup': () => ({ file: store.backup('manual') }),
    'a:data:export': () => ({ data: exportData() }),
    'a:sim:start': (p) => startSim(p),
    'a:sim:stop': () => stopSim(),
    'a:auto:resume': () => resumeAuto(),
    'a:reveal:start': (p) => {
      stopCeremony();
      if (auto.running) fail('Сначала остановите автопроведение');
      if (!board().length) fail('Нет команд в этом зачёте');
      const mode = p.mode === 'top3' ? 'top3' : p.mode === 'top10' ? 'top10' : 'all';
      db.reveal = { active: true, mode, shown: revealStart(board(), mode) };
      db.displayView = 'reveal';
      log('reveal.start', { mode }); commit(); return {};
    },
    'a:reveal:next': () => {
      if (!db.reveal.active) fail('Раскрытие не запущено');
      stopCeremony();
      db.reveal.shown = Math.min(board().length, Math.max(db.reveal.shown, 0) + 1);
      log('reveal.next', { shown: db.reveal.shown });
      if (db.reveal.shown >= board().length) scheduleAllResults();
      commit(); return {};
    },
    'a:reveal:prev': () => {
      if (!db.reveal.active) fail('Раскрытие не запущено');
      stopCeremony();
      const start = revealStart(board(), db.reveal.mode);
      db.reveal.shown = Math.max(start, db.reveal.shown - 1);
      log('reveal.prev', { shown: db.reveal.shown }); commit(); return {};
    },
    'a:tournament:create': (p) => createTournament(p),
    'a:tournament:update': (p) => updateTournament(String(p.id), p),
    'a:tournament:activate': (p) => switchTournament(String(p.id)),
    'a:tournament:delete': (p) => deleteTournament(String(p.id)),
    'a:questions:set': (p) => {
      if (questionInProgress()) fail('Сначала завершите вопрос и остановите автоматическое проведение');
      const parsed = parseQuestions(p.text);
      checkImages(parsed);
      if (Array.isArray(p.accepts)) {
        if (p.accepts.length !== parsed.length || p.accepts.some(a => !Array.isArray(a) || a.length > 30 || a.some(v => typeof v !== 'string' || !v.trim() || v.length > 200))) fail('Некорректные варианты ответа');
        parsed.forEach((q, i) => { q.accept = p.accepts[i].map(v => v.trim()); });
      }
      if (activeAge()) db.ageQuestions[activeAge()] = parsed;
      else db.questions = parsed;
      log('questions.set', { count: questions().length, age: activeAge() }); commit();
      const noCorrect = questions().filter((x) => x.options?.length && x.correct < 0).length; // варианты без «*» не проверятся сами
      return { count: questions().length, noCorrect };
    },
    'a:password:change': (p, socket) => {
      if (!checkPw(p.oldPassword)) fail('Старый пароль неверный');
      db.auth = makeAuth(validPw(p.newPassword));
      for (const t of [...sessions.keys()]) if (t !== socket.data.token) sessions.delete(t);
      // уже вошедшие админ-сокеты с другими токенами теряют права немедленно
      for (const sid of io.sockets.adapter.rooms.get('admin') ?? []) {
        const other = io.sockets.sockets.get(sid);
        if (other && other.id !== socket.id) {
          other.data.role = 'guest'; other.data.token = null; other.leave('admin');
          other.emit('auth:required', { setup: false, canSetup: false });
        }
      }
      log('admin.password_change', {}); persist();
      return {};
    },
    'a:round:open': () => openRound(),
    'a:round:lock': () => lockRound(),
    'a:round:reset': (p) => { stopAuto('manual-reset'); return resetRound(typeof p.advance === 'boolean' ? p.advance : undefined); },
    'a:round:judge': (p) => judge(p.correct === true, p.points),
    'a:round:pass': () => passRound(),
    'a:round:undo': () => undoJudge(),
    'a:timer:add': (p) => {
      const sec = int(p.seconds, -600, 600, 'Секунды');
      const q = db.quiz;
      const quizActive = q.timer && (q.status === 'open' || q.timer.kind === 'pause');
      const holder = quizActive ? q : db.round.timer && (db.round.status === 'open' || db.round.status === 'buzzed' || db.round.timer.kind === 'pause') ? db.round : null;
      if (!holder) fail('Нет активного таймера');
      const t = holder.timer;
      const endsAt = Math.max(Date.now() + 500, t.endsAt + sec * 1000);
      const remaining = endsAt - Date.now();
      const slot = quizActive ? 'quiz' : 'round';
      const id = holder.id;
      const expire = t.kind === 'pause' ? () => { if (auto.running && (slot === 'quiz' ? db.quiz.id : db.round.id) === id) advanceAuto(); }
        : t.kind === 'quiz' ? () => { if (db.quiz.id === id && db.quiz.status === 'open') closeQuiz(); }
        : t.kind === 'read' ? () => { if (db.quiz.id === id && db.quiz.reading) startAnswers(); } // иначе продление чтения навсегда оставляло вопрос без приёма ответов
        : t.kind === 'open' ? () => { if (db.round.id === id && db.round.status === 'open') { db.round.status = 'locked'; db.round.timer = null; log('round.autolock', ctx()); if (auto.running && auto.mode === 'buzz') beginPause(); commit(); } }
        : t.kind === 'answer' ? answerExpire(holder)
        : null;
      setTimer(slot, holder, t.kind, remaining, expire);
      holder.timer.durationMs = Math.max(t.durationMs + sec * 1000, remaining);
      log('timer.add', { ...ctx(), kind: t.kind, seconds: sec });
      commit(); return {};
    },
    'a:quiz:open': (p) => openQuiz(p.question),
    'a:quiz:close': () => closeQuiz(),
    'a:quiz:start': () => { if (!db.quiz.reading) fail('Приём ответов уже открыт'); return startAnswers(); }, // ведущий дочитал раньше
    'a:quiz:reset': () => { stopAuto('manual-reset'); return resetQuiz(db.quiz.status === 'closed'); }, // закрытый вопрос считается сыгранным, даже если никто не ответил
    'a:auto:start': (p) => startAuto(p.mode === 'buzz' && p.allowBuzz === true ? 'buzz' : 'quiz', p.clean === true), // в турнире только письменные ответы
    'a:game:restart': (p) => restartGame(p.allAges === true),
    'a:auto:stop': () => { stopAuto('manual'); commit(); return {}; },
    'a:auto:continue': () => continueAuto(),
    'a:quiz:mark': (p) => markAnswer(p.teamId, p.correct),
    'a:quiz:markall': (p) => {
      if (typeof p.text !== 'string') fail('Нет текста');
      const key = p.text.trim().toLowerCase();
      for (const a of Object.values(db.quiz.answers)) if (a.text.toLowerCase() === key) markAnswer(a.teamId, p.correct === true);
      return {};
    },
    'a:team:create': (p) => { const t = addTeam(p.name, p.pin); if (activeAge()) t.age = activeAge(); commit(); return { id: t.id }; },
    'a:team:update': (p) => {
      const t = findTeam(p.id) || fail('Команда не найдена');
      if (p.name !== undefined) { const n = str(p.name, 40, 'Название'); if (nameTaken(n, t.id)) fail('Название занято'); t.name = n; }
      if (p.pin !== undefined) t.pin = validPin(p.pin);
      if (p.age !== undefined) {
        if (db.tournament.ageMode && (questionInProgress() || t.score !== 0 || db.history.some(h => h.answers.some(a => a.teamId === t.id)) || db.buzzHistory.some(a => a.teamId === t.id))) fail('Возраст нельзя менять во время вопроса или после игры команды');
        if (p.age === null || p.age === '') t.age = null;
        else t.age = parseAge(p.age) || fail('Возраст: junior, middle или senior');
      }
      log('team.update', { teamId: t.id, teamName: t.name }); commit(); return {};
    },
    'a:team:regenpin': (p) => {
      const t = findTeam(p.id) || fail('Команда не найдена');
      t.pin = genPin(); log('team.pin', { teamId: t.id, teamName: t.name }); kickTeam(t.id, 'pin'); commit(); return {};
    },
    'a:team:delete': (p) => {
      const t = findTeam(p.id) || fail('Команда не найдена');
      kickTeam(t.id, 'deleted'); db.teams = db.teams.filter((x) => x.id !== t.id);
      log('team.delete', { teamId: t.id, teamName: t.name }); commit(); return {};
    },
    'a:team:disable': (p) => {
      const t = findTeam(p.id) || fail('Команда не найдена');
      t.disabled = p.disabled === true;
      if (t.disabled) kickTeam(t.id, 'disabled');
      log(t.disabled ? 'team.disable' : 'team.enable', { teamId: t.id, teamName: t.name }); commit(); return {};
    },
    'a:team:kick': (p) => {
      const t = findTeam(p.id) || fail('Команда не найдена');
      kickTeam(t.id, 'reset'); log('team.kick', { teamId: t.id, teamName: t.name }); return {};
    },
    'a:teams:generate': (p) => {
      const n = int(p.count ?? 30, 1, 1000, 'Количество');
      genTeams(n, (i) => `Команда ${String(i).padStart(2, '0')}`); commit(); return {};
    },
    'a:teams:clear': () => {
      for (const t of db.teams) kickTeam(t.id, 'deleted');
      clearAllTimers();
      db.teams = []; db.round = blankRound(); db.quiz = blankQuiz(); db.history = []; db.reveal = blankReveal(); db.played = false; log('teams.clear'); commit(); return {};
    },
    'a:score:adjust': (p) => {
      const t = findTeam(p.id) || fail('Команда не найдена');
      const delta = int(p.delta, -10000, 10000, 'Баллы'); t.score += delta;
      log('score.adjust', { ...ctx(), teamId: t.id, teamName: t.name, delta, score: t.score }); commit(); return {};
    },
    'a:score:set': (p) => {
      const t = findTeam(p.id) || fail('Команда не найдена');
      t.score = int(p.score, -100000, 100000, 'Счёт');
      log('score.set', { teamId: t.id, teamName: t.name, score: t.score }); commit(); return {};
    },
    'a:scores:reset': () => { db.teams.forEach((t) => { t.score = 0; }); log('scores.reset'); commit(); return {}; },
    'a:settings:update': (p) => {
      let difficultySec;
      if (p.difficultySec !== undefined) {
        if (!p.difficultySec || typeof p.difficultySec !== 'object') fail('Время по сложности: нужен список значений');
        difficultySec = { ...db.settings.difficultySec };
        for (const key of ['easy', 'medium', 'hard']) if (p.difficultySec[key] !== undefined) difficultySec[key] = int(p.difficultySec[key], 5, 3600, `Время (${key})`);
      }
      if (difficultySec) db.settings.difficultySec = difficultySec;
      if (p.difficultyTiming !== undefined) db.settings.difficultyTiming = p.difficultyTiming === true;
      if (p.readSec !== undefined) {
        db.settings.readSec = int(p.readSec, -1, 60, 'Время на чтение вопроса');
        // Чтение выключили прямо во время чтения вопроса — не ждём остаток таймера, сразу открываем приём ответов.
        if (db.settings.readSec === 0 && db.quiz.status === 'open' && db.quiz.reading) startAnswers();
      }
      if (p.strictGrade !== undefined) db.settings.strictGrade = p.strictGrade === true; // взрослая проверка: меньше прощаем опечаток
      if (p.tournamentName !== undefined) db.tournament.name = str(p.tournamentName, 60, 'Название турнира');
      if (p.round !== undefined) db.tournament.round = int(p.round, 1, 999, 'Раунд');
      if (p.question !== undefined) db.tournament.question = int(p.question, 1, 999, 'Вопрос');
      if (p.correctPoints !== undefined) db.settings.correctPoints = int(p.correctPoints, -10000, 10000, 'Баллы за верный');
      if (p.wrongPoints !== undefined) db.settings.wrongPoints = int(p.wrongPoints, -10000, 10000, 'Баллы за неверный');
      if (p.openSec !== undefined) db.settings.openSec = int(p.openSec, 0, 3600, 'Таймер кнопок');
      if (p.quizSec !== undefined) db.settings.quizSec = int(p.quizSec, 0, 3600, 'Таймер письменного ответа');
      if (p.answerSec !== undefined) db.settings.answerSec = int(p.answerSec, 0, 3600, 'Время на ответ');
      if (p.queueWindowMs !== undefined) db.settings.queueWindowMs = int(p.queueWindowMs, 0, 10000, 'Окно очереди');
      if (p.showQuestion !== undefined) db.settings.showQuestion = p.showQuestion === true;
      if (p.blockBreak !== undefined) db.settings.blockBreak = p.blockBreak === true;
      if (p.difficultyPoints && typeof p.difficultyPoints === 'object') {
        for (const k of ['easy', 'medium', 'hard']) if (p.difficultyPoints[k] !== undefined) db.settings.difficultyPoints[k] = int(p.difficultyPoints[k], 0, 1000, `Баллы (${k})`);
      }
      if (p.pauseSec !== undefined) db.settings.pauseSec = int(p.pauseSec, 0, 600, 'Пауза между вопросами');
      if (p.autoGrade !== undefined) db.settings.autoGrade = p.autoGrade === true;
      if (p.resultSec !== undefined) db.settings.resultSec = int(p.resultSec, 0, 60, 'Показ результата');
      log('settings.update', { tournament: db.tournament, settings: db.settings }); commit(); return {};
    },
    'a:ceremony:start': () => startCeremony(),
    'a:ceremony:stop': () => { stopCeremony(); commit(); return {}; },
    'a:watermark:set': (p = {}) => {
      const w = { ...db.watermark };
      const num = (k, lo, hi) => { if (p[k] !== undefined) { const n = Number(p[k]); if (!Number.isFinite(n)) fail('Неверное значение'); w[k] = Math.min(hi, Math.max(lo, n)); } };
      num('size', 0.5, 10); num('x', 0, 95); num('y', 0, 95); num('opacity', 0, 1);
      if (p.on !== undefined) w.on = p.on === true;
      if (p.corner !== undefined) { if (!['br', 'bl', 'tr', 'tl'].includes(p.corner)) fail('Неверный угол'); w.corner = p.corner; }
      if (p.text !== undefined) w.text = String(p.text).slice(0, 120);
      if (p.reset === true) Object.assign(w, WATERMARK);
      db.watermark = w; commit(); return {};
    },
    'a:display:set': (p) => {
      stopCeremony();
      if (!['start', 'qr', 'auto', 'leaderboard', 'final', 'closing', 'splash', 'sponsors', 'record', 'flag'].includes(p.view)) fail('Неизвестный режим экрана');
      db.reveal.active = false;
      db.displayView = p.view; log('display.set', { view: p.view });
      if (p.view === 'final') scheduleAllResults();
      commit(); return {};
    },
    'a:demo:start': () => {
      const teams = makeTeams(NAMES.slice(0, 30).map((name, i) => ({ name, age: AGES[i % 3] })));
      teams.forEach((t) => { t.score = crypto.randomInt(0, 13) * 10; });
      const questions = demoQuestions();
      if (!db.demo) {
        // демо живёт в отдельном турнире, чтобы не затереть настоящий
        for (const [id, t] of Object.entries(db.tournaments)) if (t.demo) { delete db.tournaments[id]; logs.delete(id); }
        const t = makeTournament('QUIZ ARENA — демо', { teams, questions, settings: DEMO_SETTINGS, demo: true });
        t.displayView = 'auto';
        const id = `T${uid()}`;
        db.tournaments[id] = t;
        log('demo.start', { id });
        return switchTournament(id);
      }
      // активный демо-турнир перезапускаем на месте: свежие команды, вопросы и счёт
      for (const t of db.teams) kickTeam(t.id, 'deleted');
      clearAllTimers();
      db.teams = teams; db.questions = questions;
      db.ageQuestions = { junior: [], middle: [], senior: [] };
      db.settings = { ...DEFAULT_SETTINGS, ...DEMO_SETTINGS };
      db.tournament = { name: 'QUIZ ARENA — демо', round: 1, question: 1, ageMode: false, age: 'junior', progress: {} };
      db.round = blankRound(); db.quiz = blankQuiz(); db.history = []; db.buzzHistory = [];
      db.reveal = blankReveal(); db.played = false; db.demo = true; db.displayView = 'auto';
      log('demo.start'); commit(); return {};
    },
  };

  io.on('connection', (socket) => {
    socket.data.role = 'guest';
    const ip = normAddr(socket.handshake.address);
    const auth = socket.handshake.auth || {};

    // через туннель запросы приходят с 127.0.0.1 — отличаем их по заголовкам Cloudflare и по адресу
    const hdr = socket.handshake.headers;
    const viaTunnel = !!(hdr['x-forwarded-for'] || hdr['cf-connecting-ip'] || /trycloudflare\.com$/i.test(String(hdr.host || '').split(':')[0]));
    const trustedLocal = !viaTunnel && localAddrs().has(ip);
    // через туннель у всех телефонов адрес 127.0.0.1 — для лимитов берём настоящий адрес из заголовков Cloudflare
    const clientIp = viaTunnel ? String(hdr['cf-connecting-ip'] || String(hdr['x-forwarded-for'] || '').split(',')[0] || ip).trim().slice(0, 64) : ip;
    const lockMs = (n, after, base) => (n >= after ? Math.min(10 * 60000, base * 2 ** Math.floor((n - after) / after)) : 0); // каждая новая серия ошибок — блокировка вдвое дольше
    const grantAdmin = (token) => {
      socket.data.role = 'admin'; socket.data.token = token; socket.join('admin');
      log('admin.login', { ip });
      socket.emit('a:state', adminState());
    };
    if (auth.role === 'admin') {
      if (validToken(auth.token)) grantAdmin(auth.token);
      else socket.emit('auth:required', { setup: !db.auth, canSetup: trustedLocal });
    }

    if (auth.role === 'display') socket.join('display');
    socket.emit('state', publicState());

    // защита от флуда: не больше 40 пакетов в секунду с одного сокета
    let winStart = Date.now(); let winCount = 0; let floodLogged = false;
    socket.use((_packet, next) => {
      if (socket.data.role === 'admin') return next(); // вошедший администратор — доверенный, ему лимит не нужен
      const now = Date.now();
      if (now - winStart >= 1000) { winStart = now; winCount = 0; }
      if (++winCount > 40) {
        if (!floodLogged) { floodLogged = true; log('security.flood', { ip, teamId: socket.data.teamId || null }); }
        return next(new Error('rate_limited'));
      }
      next();
    });

    socket.on('a:login', (p, ack) => {
      ack = fnAck(ack);
      if (!db.auth) return ack({ ok: false, setup: true, canSetup: trustedLocal, error: 'Пароль ещё не задан' });
      const fl = loginFails.get(`admin|${clientIp}`);
      if (fl && fl.until > Date.now()) return ack({ ok: false, error: 'Слишком много попыток. Подождите несколько секунд' });
      if (checkPw(p?.password)) {
        loginFails.delete(`admin|${clientIp}`);
        const token = newSession(); grantAdmin(token);
        return ack({ ok: true, token });
      }
      const n = (fl?.n || 0) + 1;
      loginFails.set(`admin|${clientIp}`, { n, until: n % 5 === 0 ? Date.now() + lockMs(n, 5, 15000) : 0 });
      log('admin.login_failed', { ip: clientIp });
      ack({ ok: false, error: 'Неверный пароль' });
    });

    // Первичная установка пароля — только с самого ноутбука ведущего, пока пароль не задан.
    socket.on('a:setup', (p, ack) => {
      ack = fnAck(ack);
      if (db.auth) return ack({ ok: false, error: 'Пароль уже задан' });
      if (!trustedLocal) return ack({ ok: false, error: 'Пароль можно задать только на ноутбуке ведущего (откройте админку на нём)' });
      try {
        db.auth = makeAuth(validPw(p?.password));
        persist();
        const token = newSession(); grantAdmin(token);
        log('admin.setup', { ip });
        ack({ ok: true, token });
      } catch (e) { ack({ ok: false, error: e instanceof UserError ? e.message : 'Ошибка' }); }
    });

    socket.on('a:logout', (p, ack) => {
      if (typeof p === 'function') ack = p;
      if (socket.data.token) sessions.delete(socket.data.token);
      socket.data.role = 'guest'; socket.data.token = null; socket.leave('admin');
      fnAck(ack)({ ok: true });
    });

    for (const [name, fn] of Object.entries(adminActions)) {
      socket.on(name, (p, ack) => {
        if (typeof p === 'function') { ack = p; p = {}; }
        ack = fnAck(ack);
        if (socket.data.role !== 'admin') {
          log('security.denied', { event: name, ip, teamId: socket.data.teamId || null });
          return ack({ ok: false, error: 'forbidden' });
        }
        try { ack({ ok: true, ...runAdminAction(name, p && typeof p === 'object' ? p : {}, socket) }); } catch (e) {
          if (e instanceof UserError) ack({ ok: false, error: e.message });
          else { console.error(e); ack({ ok: false, error: 'Внутренняя ошибка' }); }
        }
      });
    }

    socket.on('team:login', (p, ack) => {
      ack = fnAck(ack);
      const key = typeof p?.team === 'string' ? p.team.trim() : '';
      const pin = typeof p?.pin === 'string' || typeof p?.pin === 'number' ? String(p.pin).trim() : '';
      const team = db.teams.find((t) => t.id === key) || db.teams.find((t) => t.name.toLowerCase() === key.toLowerCase());
      // лимит по устройству и команде: ошибки одной команды не блокируют вход остальным
      const fk = `team|${clientIp}|${team?.id || key.toLowerCase().slice(0, 40)}`;
      const fl = loginFails.get(fk);
      if (fl && fl.until > Date.now()) return ack({ ok: false, error: `Слишком много попыток. Подождите ${Math.ceil((fl.until - Date.now()) / 1000)} с.` });
      if (!team || !safeEq(pin, team.pin)) {
        const n = (fl?.n || 0) + 1;
        loginFails.set(fk, { n, until: n % 8 === 0 ? Date.now() + lockMs(n, 8, 10000) : 0 });
        log('team.login_failed', { ip: clientIp, team: key.slice(0, 40) });
        return ack({ ok: false, error: 'Неверная команда или PIN' });
      }
      if (team.disabled) return ack({ ok: false, code: 'disabled', error: 'Команда отключена организатором' });
      loginFails.delete(fk);
      if (socket.data.teamId && socket.data.teamId !== team.id && teamSockets.get(socket.data.teamId) === socket.id) {
        teamSockets.delete(socket.data.teamId);
      }
      const prev = teamSockets.get(team.id);
      if (prev && prev !== socket.id) {
        const old = io.sockets.sockets.get(prev);
        if (old) { old.emit('kicked', { reason: 'replaced' }); old.disconnect(true); }
      }
      socket.data.role = socket.data.role === 'admin' ? 'admin' : 'team';
      socket.data.teamId = team.id;
      teamSockets.set(team.id, socket.id);
      log('team.connect', { teamId: team.id, teamName: team.name, ip });
      ack({ ok: true, team: { id: team.id, name: team.name }, answer: db.quiz.answers[team.id]?.text ?? null });
      socket.emit('state', publicState());
      socket.emit('me', { score: team.score, age: team.age ?? null });
      presenceChanged();
    });

    // Идентичность берётся ТОЛЬКО из socket.data — клиент не может указать чужую команду.
    socket.on('team:buzz', (p, ack) => {
      ack = fnAck(ack);
      const tid = socket.data.teamId;
      if (!tid) return ack({ ok: false, result: 'rejected', reason: 'not_logged_in' });
      ack(handleBuzz(tid, p));
    });

    socket.on('team:answer', (p, ack) => {
      ack = fnAck(ack);
      const tid = socket.data.teamId;
      if (!tid) return ack({ ok: false, result: 'rejected', reason: 'not_logged_in' });
      ack(handleAnswer(tid, p));
    });

    // Команда сообщает, что вопрос дошёл до экрана: фиксируем задержку доставки (мс от открытия до показа).
    socket.on('team:seen', (p) => {
      const tid = socket.data.teamId;
      if (!tid || !eligible(findTeam(tid)) || typeof p?.quizId !== 'string' || p.quizId !== db.quiz.id || quizHr === null) return;
      if (db.quiz.delivery[tid] !== undefined) return;
      db.quiz.delivery[tid] = Math.round(Number(process.hrtime.bigint() - quizHr) / 1e3) / 1e3;
      persist(); scheduleAdmin();
    });

    socket.on('sys:ping', (p, ack) => {
      if (typeof p === 'function') { ack = p; p = {}; }
      const tid = socket.data.teamId;
      if (tid && typeof p?.rtt === 'number' && p.rtt >= 0 && p.rtt < 60000) rtts.set(tid, Math.round(p.rtt));
      fnAck(ack)(Date.now());
    });

    socket.on('disconnect', () => {
      const tid = socket.data.teamId;
      if (tid && teamSockets.get(tid) === socket.id) {
        teamSockets.delete(tid);
        log('team.disconnect', { teamId: tid, teamName: findTeam(tid)?.name });
        presenceChanged();
      }
    });
  });

  const adminTick = setInterval(() => { if (io.sockets.adapter.rooms.has('admin')) io.to('admin').emit('a:state', adminState()); }, 3000);
  adminTick.unref?.();

  log('server.start', {});

  /** Команда админа внутри процесса — для локальных скриптов на ноутбуке и тестов. По сети недоступна. */
  /** Состояние туннеля от server/index.js: { status, url }. */
  function setTunnel(st) {
    const next = { status: st.status, url: st.status === 'ready' ? st.url : null, error: st.error || null };
    if (JSON.stringify(next) === JSON.stringify(tunnelState)) return;
    tunnelState = next;
    log('tunnel', next); broadcastPublic(); scheduleAdmin();
  }

  function runAdminAction(name, p, socket) {
    const fn = adminActions[name] || fail(`Неизвестная команда ${name}`);
    // Изменение результатов или возвращение к игре отменяет церемонию и её таймеры.
    // Зафиксированные при запуске призёры не должны расходиться с отредактированным счётом.
    if (ceremony.running && /^a:(score:|team:|teams:|game:|age:(activate|enable)|questions:|settings:|tournament:|quiz:|round:|auto:)/.test(name)) stopCeremony();
    return fn(p, socket);
  }
  const local = (name, p = {}) => runAdminAction(name, p, { data: { role: 'admin', token: null } });

  return {
    db, app, io, httpServer, store, local, setTunnel,
    get port() { return actualPort; },
    get hasPassword() { return !!db.auth; },
    start() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => { actualPort = httpServer.address().port; resolve(actualPort); });
      });
    },
    async close() {
      stopCeremony();
      clearInterval(adminTick);
      clearAllTimers();
      if (sim.child) { try { sim.child.kill('SIGTERM'); } catch { /* уже завершён */ } }
      if (presenceTimer) clearTimeout(presenceTimer);
      if (adminTimer) clearTimeout(adminTimer);
      log('server.stop', {});
      store.flush();
      await new Promise((r) => { io.close(() => r()); setTimeout(r, 500); });
    },
  };
}
