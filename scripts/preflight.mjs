#!/usr/bin/env node
// Предполётная проверка перед показом: сервер, страницы, турнир и чистота данных.
// Запуск: npm run preflight   (или PREFLIGHT_URL=https://… npm run preflight)

import fs from 'node:fs';
import path from 'node:path';

const base = (process.env.PREFLIGHT_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const dataFile = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'state.json');
let failures = 0;
let warnings = 0;

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => { warnings++; console.log(`  ! ${m}`); };
const bad = (m) => { failures++; console.log(`  ✗ ${m}`); };

async function get(p) {
  const res = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
  return { res, text: await res.text() };
}
async function json(p) {
  const res = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
  return { res, body: await res.json().catch(() => null) };
}

console.log(`\nQUIZ ARENA — проверка перед показом\nСервер: ${base}\n`);

try {
  const { res, body } = await json('/api/health');
  if (res.ok && body?.ok) ok('сервер отвечает на /api/health');
  else bad(`/api/health вернул HTTP ${res.status}`);
} catch (e) {
  bad(`сервер недоступен: ${e.message}`);
}

for (const p of ['/admin', '/display', '/play']) {
  try {
    const { res, text } = await get(p);
    if (res.ok && text.includes('QUIZ ARENA')) ok(`страница ${p} отдаётся`);
    else bad(`страница ${p}: HTTP ${res.status}`);
  } catch (e) {
    bad(`страница ${p}: ${e.message}`);
  }
}

try {
  const { res, body } = await json('/api/teams');
  if (res.ok && Array.isArray(body)) {
    if (body.length) ok(`список команд доступен: ${body.length}`);
    else bad('в активном турнире нет команд');
  } else bad(`/api/teams: HTTP ${res.status}`);
} catch (e) {
  bad(`/api/teams: ${e.message}`);
}

try {
  const { body } = await json('/api/info');
  if (body?.ips?.length) ok(`сетевые адреса: ${body.ips.map((ip) => `${ip}:${body.port}`).join(', ')}`);
  else warn('не удалось определить сетевой адрес ноутбука');
} catch { /* уже сообщили о недоступности сервера */ }

console.log('\nДанные турнира:');
try {
  const d = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const t = d;
  const ageMode = !!t.tournament?.ageMode;
  const banks = ageMode ? Object.entries(t.ageQuestions || {}).map(([age, list]) => `${age}: ${list.length}`) : [`всего: ${t.questions?.length ?? 0}`];
  console.log(`  · турнир: «${t.tournament?.name || '—'}»${ageMode ? ' (три возрастных зачёта)' : ''}`);
  console.log(`  · команды: ${t.teams?.length ?? 0}, вопросы: ${banks.join(', ')}`);
  if (!t.teams?.length) bad('нет команд');
  const totalQ = ageMode ? Object.values(t.ageQuestions || {}).reduce((n, list) => n + list.length, 0) : (t.questions?.length || 0);
  if (!totalQ) bad('нет вопросов');
  const score = (t.teams || []).reduce((n, team) => n + (team.score || 0), 0);
  if (score !== 0) warn(`суммарный счёт не нулевой (${score}) — для чистого показа лучше «Сыграть заново»`);
  if (t.history?.length) warn(`в архиве уже ${t.history.length} вопрос(ов) — показатели не с нуля`);
  if (t.quiz?.status !== 'idle' || t.round?.status !== 'idle') warn('есть незакрытый вопрос — лучше сделать RESET перед показом');
  if (!t.auth) warn('пароль админки не задан — задайте его на ноутбуке заранее');
  if (t.tournament?.question !== 1) warn(`турнир стоит на вопросе ${t.tournament.question}, а не на первом`);
  const backups = fs.existsSync(path.join(path.dirname(dataFile), 'backups')) ? fs.readdirSync(path.join(path.dirname(dataFile), 'backups')).length : 0;
  console.log(`  · резервные копии: ${backups}`);
} catch (e) {
  bad(`не удалось прочитать ${dataFile}: ${e.message}`);
}

console.log(`\nИтог: ${failures ? `✗ ошибок ${failures}` : '✓ можно показывать'}${warnings ? `, предупреждений ${warnings}` : ''}\n`);
process.exit(failures ? 1 : 0);
