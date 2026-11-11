#!/usr/bin/env node
/**
 * Полная симуляция турнира (см. scripts/simulation.mjs).
 *   npm run simulate                              # 30 команд, 3 блока × 5 вопросов, 20 с на вопрос, сервер http://127.0.0.1:3000
 *   npm run simulate -- --password ВАШ_ПАРОЛЬ     # пароль администратора (или переменная ADMIN_PASSWORD)
 *   npm run simulate -- --teams 100 --per-block 15 --question-sec 20
 * Параметры: --url --teams --blocks --per-block --question-sec --pause --block-wait --reveal-step --seed --no-chaos
 * ВНИМАНИЕ: симуляция создаёт отдельный турнир «Симуляция …» и делает его активным (настоящие капитаны будут отключены).
 */
import { runSimulation } from './simulation.mjs';

const args = process.argv.slice(2);
const get = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const num = (name, def) => { const v = Number(get(name, def)); return Number.isFinite(v) ? v : def; };

const stamp = () => new Date().toLocaleTimeString('ru-RU');
const res = await runSimulation({
  url: get('url', process.env.SIM_URL || 'http://127.0.0.1:3000'),
  token: process.env.SIM_TOKEN || '',
  password: get('password', process.env.ADMIN_PASSWORD || ''),
  teams: num('teams', 30), blocks: num('blocks', 3), perBlock: num('per-block', 5),
  questionSec: num('question-sec', 20), pauseSec: num('pause', 5), blockWaitSec: num('block-wait', 8),
  revealStepSec: num('reveal-step', 3), seed: num('seed', 42), chaos: !args.includes('--no-chaos'),
  onLog: (m) => console.log(m ? `[${stamp()}] ${m}` : ''),
}).catch((e) => { console.error(`ОШИБКА: ${e.message}`); return { ok: false }; });
process.exit(res.ok ? 0 : 1);
