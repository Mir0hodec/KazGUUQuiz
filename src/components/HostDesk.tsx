import QuestionImage from './QuestionImage';
import { useEffect, useRef, useState } from 'react';
import { Play, Check, X, ArrowRight, Monitor, Users, ListChecks, Trophy, Settings, RotateCcw, Mic, MicOff } from 'lucide-react';
import type { AdminState, Age } from '../lib/types';
import { AGE_COLOR, AGE_LABEL } from '../lib/age';
import { DIFFICULTY, questionSeconds } from '../lib/difficulty';
import { fmtSec, useCountdown } from '../lib/util';

type Call = (event: string, payload?: unknown) => Promise<{ ok: boolean; error?: string }>;
type Mode = 'quiz' | 'buzz';
const ages: Age[] = ['junior', 'middle', 'senior'];

export default function HostDesk({ s, call, mode, setMode, connected, navigate }: {
  s: AdminState; call: Call; mode: Mode; setMode: (mode: Mode) => void; connected: boolean;
  navigate: (tab: 'questions' | 'teams' | 'results' | 'settings') => void;
}) {
  const [busy, setBusy] = useState(false);
  const { pub } = s;
  const age = pub.tournament.ageMode ? pub.tournament.age : undefined;
  const number = pub.tournament.question;
  const item = s.questions[number - 1];
  const timer = useCountdown(pub.timer, pub.t);
  const live = pub.quiz.status === 'open' || pub.status === 'open' || pub.status === 'buzzed';
  const used = pub.quiz.status !== 'idle' || pub.status !== 'idle';
  // 'qr' — устаревший алиас 'start': QR живёт на той же арене, отдельного экрана больше нет.
  const qrOnScreen = pub.displayView === 'start' || pub.displayView === 'qr';
  const gameLive = pub.auto.running || pub.quiz.status !== 'idle' || pub.status !== 'idle';
  const playableGroups = s.ageGroups.filter(g => g.questions > 0 && s.teams.some(t => !t.disabled && t.age === g.age));
  const finished = pub.tournament.ageMode
    ? playableGroups.length > 0 && playableGroups.every(g => g.finished)
    : s.questions.length > 0 && number > s.questions.length;
  const teams = s.teams.filter(t => !t.disabled && (!age || t.age === age));
  const missing = !item || !teams.length;
  const canAutoStart = !missing || (!!age && playableGroups.some(g => !g.finished));
  const unchecked = s.quizAnswers.filter(a => a.verdict === null).length;
  const pending = s.ageGroups.filter(g => g.questions > 0 && (!g.finished || g.age === age && number <= g.questions));
  const nextGroup = age ? [...ages.slice(ages.indexOf(age) + 1), ...ages.slice(0, ages.indexOf(age) + 1)].find(a => {
    const g = pending.find(g => g.age === a);
    return g && (a !== age || number < g.questions);
  }) : undefined;
  const nextLabel = nextGroup ? AGE_LABEL[nextGroup] : age ? 'итоги' : number < s.questions.length ? `вопрос ${number + 1}` : 'итоги';
  const completed = pub.tournament.ageMode ? s.ageGroups.reduce((n, g) => n + Math.min(g.questions, Math.max(0, g.question - 1)), 0) : Math.min(s.questions.length, number - 1);
  const total = pub.tournament.ageMode ? s.ageGroups.reduce((n, g) => n + g.questions, 0) : s.questions.length;
  const run = async (event: string, payload?: unknown) => {
    if (busy || !connected) return;
    setBusy(true);
    try { return await call(event, payload); } finally { setBusy(false); }
  };
  const restart = () => {
    if (confirm('Начать весь турнир заново? Баллы и ответы ВСЕХ лиг обнулятся. Команды, PIN и вопросы сохранятся.')) void run('a:game:restart', { allAges: true });
  };
  const next = async () => {
    if (mode === 'quiz' && unchecked && !confirm(`Не проверены ответы: ${unchecked}. Перейти дальше без их оценки?`)) return;
    const r = await run(mode === 'quiz' ? 'a:quiz:reset' : 'a:round:reset');
    if (r?.ok && nextLabel === 'итоги') navigate('results');
  };
  const reading = pub.quiz.status === 'open' && !!pub.quiz.reading; // вопрос на экране, ведущий читает, ответы ещё не принимаются
  const readOn = (s.settings.readSec ?? -1) !== 0; // чтение вслух включено; можно выключить на ходу, не заходя в настройки
  const toggleRead = () => void run('a:settings:update', { readSec: readOn ? 0 : -1 });
  const buttonText = pub.auto.running ? 'Взять управление' : mode === 'quiz'
    ? pub.quiz.status === 'idle' ? 'Начать автоматически' : reading ? 'Открыть приём ответов' : pub.quiz.status === 'open' ? 'Завершить приём' : `Дальше → ${nextLabel}`
    : pub.status === 'idle' ? 'Начать вопрос' : pub.status === 'open' ? 'Завершить приём' : pub.status === 'buzzed' ? 'Оцените ответ ниже' : `Дальше → ${nextLabel}`;
  const primary = () => {
    if (pub.auto.running) { void run('a:auto:stop'); return; }
    if (mode === 'quiz') {
      if (pub.quiz.status === 'idle') void run('a:auto:start', { mode: 'quiz' });
      else if (reading) void run('a:quiz:start');
      else if (pub.quiz.status === 'open') void run('a:quiz:close');
      else void next();
    } else {
      if (pub.status === 'idle') void run('a:round:open');
      else if (pub.status === 'open') void run('a:round:lock');
      else if (pub.status !== 'buzzed') void next();
    }
  };
  const hint = reading ? `Читайте вопрос вслух. Приём ответов откроется сам, когда закончится отсчёт${pub.auto.running ? '' : ' — или нажмите «Открыть приём ответов»'}. Если читать не нужно — выключите «Чтение вслух» ниже.`
    : pub.auto.running ? pub.auto.phase === 'blockbreak' ? 'Перерыв между блоками. Продолжите, когда зал будет готов.' : pub.auto.phase === 'review' ? `Оцените ответы ниже: осталось ${unchecked}. После проверки продолжите игру.` : 'Вопросы и лиги сменяются сами. Вы можете в любой момент взять управление.'
    : mode === 'buzz' && pub.status === 'buzzed' ? `${pub.answerer?.name || 'Команда'} отвечает вслух. Поставьте «Верно» или «Неверно».`
    : live ? `Сейчас отвечают ${age ? AGE_LABEL[age] : 'команды'}. ${age ? 'У остальных ответы заблокированы.' : ''} Приём закроется по таймеру или по вашей кнопке.`
    : used ? unchecked ? `Проверьте оставшиеся ответы (${unchecked}), затем переходите дальше.` : `Проверьте оценки. Следом — ${nextLabel}. Лига переключится сама.`
    : 'Начните автоматическую игру: вопросы, таймер и проверка будут работать сами. При необходимости можно вести вручную.';
  const showTop = async (a?: Age) => {
    if (a && !(await run('a:age:results', { age: a }))?.ok) return;
    await run('a:display:set', { view: 'leaderboard' });
  };

  return <div className="host-desk">
    <div className="host-shortcuts"><button onClick={() => navigate('questions')}><ListChecks size={16} /> Вопросы</button><button onClick={() => navigate('teams')}><Users size={16} /> Подключить команды <b>{pub.online}/{pub.teamCount}</b></button><button onClick={() => navigate('results')}><Trophy size={16} /> Итоги</button></div>
    {age && <div className="host-order" aria-label="Порядок лиг">{ages.map((a, i) => <div key={a} className={a === age ? 'is-active' : ''} style={{ borderColor: AGE_COLOR[a] }}><i style={{ background: AGE_COLOR[a] }} /><strong>{AGE_LABEL[a]}</strong><span>{a === age ? 'Сейчас играют' : `Вопрос ${s.ageGroups.find(g => g.age === a)?.question ?? 1}`}</span>{i < 2 && <ArrowRight size={15} />}</div>)}<small>По одному вопросу · по кругу</small></div>}
    {finished ? <section className="host-finish"><Trophy size={42} /><h2>Все вопросы сыграны</h2><p>Осталось объявить победителей. У каждой лиги свой топ.</p><button className="host-primary" disabled={busy || !connected} onClick={() => { if (confirm(age ? 'Запустить автоматическое награждение?\nJuniors → Middles → Seniors → общий топ-3 → общая таблица всех команд. Всё переключается автоматически.' : 'Объявить призёров и автоматически открыть общую таблицу?')) { void run('a:ceremony:start'); navigate('results'); } }}><Trophy size={20} /> Автоматическое награждение</button><button className="host-secondary" onClick={() => navigate('results')}>Результаты вручную <ArrowRight size={16} /></button><button className="host-secondary" disabled={busy || !connected} onClick={restart}><RotateCcw size={16} /> Новый старт с теми же командами</button></section> : <>
      {missing && <div className="host-notice" role="status">{!item ? 'В этой лиге пока нет следующего вопроса.' : 'В этой лиге пока нет команд.'}<button onClick={() => navigate(!item ? 'questions' : 'teams')}>{!item ? 'Добавить вопросы' : 'Добавить команды'} →</button></div>}
      <div className="host-main-grid"><section className="host-question">
        <div className="host-question-top"><span>Вопрос {number}{age ? ` · ${AGE_LABEL[age]}` : ''}</span><small>Пройдено {completed} из {total}</small></div>
        <div className="host-chips">{item?.difficulty && <span style={{ color: DIFFICULTY[item.difficulty].color }}>{DIFFICULTY[item.difficulty].label}</span>}<span>{questionSeconds(item, s.settings, mode)} с</span><span>{item?.points ?? (item?.difficulty ? s.settings.difficultyPoints[item.difficulty] : s.settings.correctPoints)} балл.</span></div>
        <h2>{item?.q || 'Добавьте вопросы, чтобы начать игру'}</h2>
        {item?.image && <QuestionImage src={item.image} className="w-full max-h-80 my-4" zoom />}
        {!!item?.options?.length && <div className="host-options">{item.options.map((text,i) => <span key={i}>{i+1}. {text}</span>)}</div>}
        <details className="host-key"><summary>Правильный ответ · виден только вам</summary><p>{item?.a || 'Ответ не указан'}</p></details>
        <div className="host-progress"><i style={{ width: `${total ? completed / total * 100 : 0}%` }} /></div>
      </section><section className="host-action" aria-label="Следующее действие">
        <div className="host-status">{pub.auto.running ? 'Автопроведение' : live ? 'Идёт вопрос' : used ? 'Проверьте результат' : 'Готовы к вопросу'}</div>
        <strong className="host-clock">{timer ? fmtSec(timer.sec) : live ? '∞' : used ? '✓' : '▶'}</strong>
        <p aria-live="polite">{hint}</p>
        {pub.auto.running && (pub.auto.phase === 'blockbreak' || pub.auto.phase === 'review') ? <><button className="host-primary" disabled={busy || !connected || (pub.auto.phase === 'review' && unchecked > 0)} onClick={() => void run('a:auto:resume')}>Продолжить игру</button><button className="host-secondary" disabled={busy || !connected} onClick={() => void run('a:auto:stop')}>Взять управление</button></> : <button className="host-primary" disabled={busy || !connected || (!pub.auto.running && ((pub.quiz.status === 'idle' ? !canAutoStart : false) || mode === 'buzz' && pub.status === 'buzzed'))} onClick={primary}>{buttonText}<ArrowRight size={20} /></button>}
        {!pub.auto.running && pub.quiz.status === 'idle' && <button className="host-secondary" disabled={busy || !connected || missing} onClick={() => void run('a:quiz:open')}>Показать вопрос вручную</button>}
        {!pub.auto.running && pub.quiz.status !== 'idle' && <button className="host-secondary" disabled={busy || !connected} onClick={() => void run('a:auto:continue')}><Play size={16} /> Продолжить автоматически</button>}
        {reading && pub.auto.running && <button className="host-secondary" disabled={busy || !connected} onClick={() => void run('a:quiz:start')}>Дочитал — открыть приём сейчас</button>}
        {timer && live && <button className="host-secondary" disabled={busy || !connected} onClick={() => void run('a:timer:add', { seconds: 10 })}>Добавить 10 секунд</button>}
        <button className={`host-read-toggle ${readOn ? 'is-on' : ''}`} disabled={busy || !connected} onClick={toggleRead} title="Ведущий читает вопрос вслух. Выключите, чтобы сразу перейти к ответам.">
          {readOn ? <Mic size={15} /> : <MicOff size={15} />} Чтение вслух: <b>{readOn ? 'ВКЛ' : 'ВЫКЛ'}</b>
        </button>
      </section></div>
      <details className="host-extra host-quick"><summary><Settings size={16} /> Быстрые настройки · применяется сразу</summary><div className="host-extra-body"><QuickSettings s={s} call={call} connected={connected} /></div></details>
      {mode === 'quiz' && pub.quiz.status !== 'idle' && <section className="host-answers"><div className="host-section-heading"><h3>Ответы команд</h3><span>{s.quizAnswers.length} из {teams.length}{unchecked > 0 && ` · проверить ${unchecked}`}</span></div>{s.quizAnswers.length ? s.quizAnswers.map(a => <div className="host-answer" key={a.teamId}><div><strong>{a.teamName}</strong><p>{a.text || (a.choice != null ? s.quizMeta.options[a.choice] : '')}</p></div><span>{a.verdict === null ? 'Не проверен' : `${a.points} б.`}</span><button aria-label={`Верно: ${a.teamName}`} aria-pressed={a.verdict === true} className={a.verdict === true ? 'correct' : ''} disabled={busy || !connected} onClick={() => void run('a:quiz:mark', { teamId: a.teamId, correct: true })}><Check size={19} /></button><button aria-label={`Неверно: ${a.teamName}`} aria-pressed={a.verdict === false} className={a.verdict === false ? 'wrong' : ''} disabled={busy || !connected} onClick={() => void run('a:quiz:mark', { teamId: a.teamId, correct: false })}><X size={19} /></button></div>) : <p className="host-muted">{pub.quiz.status === 'open' ? 'Ждём первый ответ…' : 'Никто не отправил ответ. Можно идти дальше.'}</p>}</section>}
      {mode === 'buzz' && pub.answerer && <section className="host-answers"><div className="host-section-heading"><h3>Отвечает {pub.answerer.name}</h3><span>{pub.status === 'judged' ? 'Оценка сохранена' : 'Слушайте ответ команды'}</span></div><div className="host-judge"><button className="host-primary" disabled={busy || !connected || pub.status !== 'buzzed'} onClick={() => void run('a:round:judge', { correct: true })}><Check size={20} /> Верно · +{pub.points.correct}</button><button className="host-secondary" disabled={busy || !connected || pub.status !== 'buzzed'} onClick={() => void run('a:round:judge', { correct: false })}><X size={20} /> Неверно</button>{pub.status === 'judged' && !pub.auto.running && <button className="host-secondary" onClick={() => void run('a:round:undo')}>Отменить оценку</button>}{pub.status === 'judged' && !pub.verdict?.correct && !pub.auto.running && <><button className="host-secondary" disabled={!s.canPass} onClick={() => void run('a:round:pass')}>Следующей команде</button><button className="host-secondary" onClick={() => void run('a:round:open')}>Открыть заново</button></>}</div></section>}
    </>}
    <details className="host-extra"><summary><Settings size={16} /> Формат и дополнительные действия</summary><div className="host-extra-body"><div className="host-manual">{age && <label>Выбрать лигу вручную<select aria-label="Выбрать лигу вручную" value={age} disabled={used || pub.auto.running || busy || !connected} onChange={e => void run('a:age:activate', { age: e.target.value })}>{ages.map(a => <option key={a} value={a}>{AGE_LABEL[a]}</option>)}</select></label>}{!finished && s.questions.length > 0 && <label>Номер вопроса вручную<select aria-label="Номер вопроса вручную" value={number} disabled={used || pub.auto.running || busy || !connected} onChange={e => void run('a:settings:update', { question: Number(e.target.value) })}>{s.questions.map((q,i) => <option key={i} value={i+1}>{i+1}. {q.q.slice(0,45)}</option>)}</select></label>}</div><p>Формат: письменные ответы на телефонах, проверка по ответу из списка.</p><div className="host-judge"><button className="host-secondary" onClick={() => navigate('settings')}>Время и баллы</button><button className="host-secondary" disabled={busy || !connected || live || pub.auto.running} onClick={restart}>Начать весь турнир заново</button>{qrOnScreen ? (gameLive ? <button className="host-secondary" disabled={busy || !connected} onClick={() => void run('a:display:set', { view: 'auto' })}><Monitor size={16} /> Вернуть игру на проектор</button> : <button className="host-secondary" disabled><Monitor size={16} /> QR уже на проекторе</button>) : <button className="host-secondary" disabled={busy || !connected} onClick={() => void run('a:display:set', { view: 'start' })}><Monitor size={16} /> QR на проектор</button>}</div></div></details>
    <details className="host-extra"><summary><Users size={16} /> Команды и счёт · на связи {pub.online}/{pub.teamCount}</summary><div className="host-score-grid">{(age ? ages : [undefined]).map(a => <section key={a || 'all'}><h3 style={{ color: a ? AGE_COLOR[a] : undefined }}>{a ? AGE_LABEL[a] : 'Команды'}</h3>{(a ? pub.boards?.[a] || [] : s.teams).map(t => <div key={t.id}><i className={s.teams.find(team => team.id === t.id)?.connected ? 'online' : ''} /><span>{t.name}</span><b>{t.score}</b></div>)}<button className="host-secondary" onClick={() => void showTop(a)}>Показать топ{a ? ` · ${AGE_LABEL[a]}` : ''}</button></section>)}</div></details>
  </div>;
}

/** Быстрые настройки турнира прямо из пульта: баллы, время вопроса и чтение вслух. */
function QuickSettings({ s, call, connected }: { s: AdminState; call: Call; connected: boolean }) {
  const st = s.settings;
  const lastReadRef = useRef<number>((st.readSec ?? -1) === 0 ? -1 : (st.readSec ?? -1));
  const [f, setF] = useState({
    correctPoints: String(st.correctPoints), wrongPoints: String(st.wrongPoints), quizSec: String(st.quizSec),
    autoGrade: st.autoGrade, readOn: (st.readSec ?? -1) !== 0,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    const v = st.readSec ?? -1;
    if (v !== 0) lastReadRef.current = v;
    setF({ correctPoints: String(st.correctPoints), wrongPoints: String(st.wrongPoints), quizSec: String(st.quizSec), autoGrade: st.autoGrade, readOn: v !== 0 });
    setSaved('');
  }, [st.correctPoints, st.wrongPoints, st.quizSec, st.autoGrade, st.readSec]);
  const save = async () => {
    const p: Record<string, unknown> = {};
    if (f.correctPoints !== String(st.correctPoints)) p.correctPoints = Number(f.correctPoints);
    if (f.wrongPoints !== String(st.wrongPoints)) p.wrongPoints = Number(f.wrongPoints);
    if (f.quizSec !== String(st.quizSec)) p.quizSec = Number(f.quizSec);
    if (f.autoGrade !== st.autoGrade) p.autoGrade = f.autoGrade;
    if (f.readOn !== ((st.readSec ?? -1) !== 0)) p.readSec = f.readOn ? lastReadRef.current : 0;
    if (!Object.keys(p).length) { setSaved('Ничего не изменено'); return; }
    setBusy(true);
    const r = await call('a:settings:update', p);
    setBusy(false);
    if (r?.ok) { setSaved('Сохранено — действует сразу'); setTimeout(() => setSaved(''), 2500); }
  };
  const inp = 'h-10 bg-[#0e1a2c] border-2 border-[#405775] px-3 outline-none focus:border-electric w-full text-snow';
  return (
    <div className="host-quick-settings">
      <div className="host-quick-grid">
        <label>Баллы за верный<input className={inp} type="number" value={f.correctPoints} onChange={(e) => setF({ ...f, correctPoints: e.target.value })} disabled={!connected} /></label>
        <label>Баллы за неверный<input className={inp} type="number" value={f.wrongPoints} onChange={(e) => setF({ ...f, wrongPoints: e.target.value })} disabled={!connected} /></label>
        <label>Письменный ответ, сек<input className={inp} type="number" min={0} value={f.quizSec} onChange={(e) => setF({ ...f, quizSec: e.target.value })} disabled={!connected} /></label>
      </div>
      <div className="host-quick-row">
        <label className="host-quick-check"><input type="checkbox" checked={f.readOn} onChange={(e) => setF({ ...f, readOn: e.target.checked })} disabled={!connected} /> Ведущий читает вопрос вслух</label>
        <label className="host-quick-check"><input type="checkbox" checked={f.autoGrade} onChange={(e) => setF({ ...f, autoGrade: e.target.checked })} disabled={!connected} /> Автооценка по ответу</label>
        <button className="host-secondary" disabled={busy || !connected} onClick={() => void save()}>{busy ? 'Сохраняем…' : 'Применить'}</button>
        {saved && <span className="host-quick-saved">{saved}</span>}
      </div>
      <p className="host-muted">Эти значения меняются на ходу: уже открытый вопрос получит новые баллы, а выключенное чтение сразу откроет приём ответов.</p>
    </div>
  );
}
