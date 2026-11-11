// Создать турнир из файла без входа в админку (работает только на этом ноутбуке).
// Сервер должен быть ОСТАНОВЛЕН, иначе он перезапишет данные.
// Запуск: node scripts/create-tournament.mjs docs/бизнес-турнир.md
import fs from 'node:fs';
import { createQuizServer } from '../server/app.js';

const file = process.argv[2] || 'docs/бизнес-турнир.md';
const md = fs.readFileSync(file, 'utf8');
const name = (md.match(/^# Турнир «(.+?)»/m) || [])[1] || 'Новый турнир';
// блоки ``` после заголовков ## Команды / ## Juniors / ## Middles / ## Seniors
const section = (title) => {
  const m = md.match(new RegExp(`^## ${title}[^\\n]*\\n+\`\`\`\\n([\\s\\S]*?)\`\`\``, 'm'));
  return m ? m[1].trim() : '';
};
const teams = section('Команды');
const qs = { junior: section('Juniors'), middle: section('Middles'), senior: section('Seniors') };
const plain = section('Вопросы'); // турнир без возрастных зачётов
const ageMode = !/^Возрастные зачёты:\s*нет/mi.test(md) && !plain;
const sec = Number((md.match(/^Время на вопрос, сек:\s*(\d+)/m) || [])[1]) || null;
const pause = (md.match(/^Пауза между вопросами, сек:\s*(\d+)/m) || [])[1];
const strictGrade = /^Проверка ответов:\s*строгая/mi.test(md);
if (!teams || !(ageMode ? qs.junior : plain)) { console.error('В файле нет раздела «## Команды» или вопросов («## Juniors» / «## Вопросы»)'); process.exit(1); }

const srv = createQuizServer({ port: 0, host: '127.0.0.1', staticDir: null });
const run = (ev, p) => { const r = srv.local(ev, p); return r; };
run('a:tournament:create', {
  name, teamNames: teams, ageMode, questions: ageMode ? qs.junior : plain,
  quizSec: sec || 30, pauseSec: pause !== undefined ? Number(pause) : 8, showQuestion: true, autoGrade: true, blockBreak: true, difficultyTiming: !sec, strictGrade,
});
if (ageMode) {
  for (const age of ['middle', 'senior']) {
    if (!qs[age]) continue;
    run('a:age:activate', { age });
    run('a:questions:set', { text: qs[age] });
  }
  run('a:age:activate', { age: 'junior' });
}
const st = srv.db;
console.log(`Создан и открыт турнир «${st.tournament.name}»: команд ${st.teams.length},`,
  ageMode ? Object.entries(st.ageQuestions).map(([a, l]) => `${a}: ${l.length} вопр.`).join(', ') : `вопросов ${st.questions.length}, на вопрос ${st.settings.quizSec} с`);
await srv.close();
process.exit(0);
