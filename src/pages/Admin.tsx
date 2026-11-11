import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  Play, Lock, RotateCcw, Check, X, ArrowRight, SkipForward, Repeat, Monitor, Trophy, Flag, Home, Users, Settings, ScrollText,
  QrCode, Download, MessageSquare, Printer, LogOut, Copy, Trophy as TrophyIcon, ListChecks, Plus, Trash2, Ban, RefreshCw, Pencil, KeyRound, WifiOff, Wifi, Minus, FlaskConical, ExternalLink,
  Eye, EyeOff, ShieldCheck, SlidersHorizontal,
} from 'lucide-react';
import { createSocket, emitAck } from '../lib/socket';
import { fmtTime, useJoinBase, useQr } from '../lib/util';
import type { AdminState, Age, AdminTeam, Call, DisplayView, TournamentItem, Watermark } from '../lib/types';
import { AGE_COLOR, AGE_LABEL, AGE_SUBTITLE, AGE_CODE, AGE_TEXT, ageColor } from '../lib/age';
import Questions from './Questions';
import HostDesk from '../components/HostDesk';
import { DIFFICULTY } from '../lib/difficulty';

type Tab = 'home' | 'game' | 'questions' | 'results' | 'tournaments' | 'teams' | 'register' | 'settings' | 'log' | 'demo';
const KEY = 'qa.adminToken';
const getToken = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const setToken = (t: string | null) => { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* */ } };

const STATUS_LABEL: Record<string, { t: string; c: string }> = {
  idle: { t: 'ОЖИДАНИЕ ВОПРОСА', c: 'bg-idle' },
  open: { t: 'КНОПКИ ОТКРЫТЫ', c: 'bg-go text-ink' },
  buzzed: { t: 'ЕСТЬ НАЖАТИЕ', c: 'bg-electric' },
  locked: { t: 'КНОПКИ ЗАКРЫТЫ', c: 'bg-warn text-ink' },
  judged: { t: 'ОТВЕТ ОЦЕНЁН', c: 'bg-panel border border-line' },
};

const btn = 'hard inline-flex items-center justify-center gap-2 font-black uppercase tracking-wide px-3 h-10 border-2 border-ink disabled:opacity-35 disabled:pointer-events-none';
const btnGhost = `${btn} bg-panel !border-snow/60 hover:!border-electric`;

type Mode = 'buzz' | 'quiz';

export default function Admin() {
  const [s, setS] = useState<AdminState | null>(null);
  const [conn, setConn] = useState(false);
  const [auth, setAuth] = useState<{ setup: boolean; canSetup: boolean } | null>(null);
  const [toast, setToast] = useState<{ m: string; bad: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>('game');
  const [questionsDirty, setQuestionsDirty] = useState(false);
  const navigate = (next: Tab) => {
    if (next === tab) return;
    if (questionsDirty && !confirm('Изменения вопросов ещё не сохранены. Уйти без сохранения?')) return;
    setQuestionsDirty(false); setTab(next);
  };
  // во всём турнире только письменные ответы: режим кнопки BUZZ в интерфейсе отключён
  const mode: Mode = 'quiz';
  const setMode = (_m: Mode) => { /* режим один */ };
  const sockRef = useRef<Socket | null>(null);

  const say = useCallback((m: string, bad = false) => {
    setToast({ m, bad });
    setTimeout(() => setToast((t) => (t?.m === m ? null : t)), 3500);
  }, []);

  useEffect(() => {
    const sock = createSocket((cb) => cb({ role: 'admin', token: getToken() }));
    sockRef.current = sock;
    sock.on('connect', () => setConn(true));
    sock.on('disconnect', () => setConn(false));
    sock.on('a:state', (st: AdminState) => { setS(st); setAuth(null); });
    sock.on('auth:required', (a: { setup: boolean; canSetup: boolean }) => { setS(null); setAuth(a); setToken(null); });
    return () => { sock.close(); };
  }, []);

  const call = useCallback(async (ev: string, payload: unknown = {}) => {
    const r = await emitAck(sockRef.current!, ev, payload);
    if (!r.ok) say(r.error === 'forbidden' ? 'Нет прав администратора' : r.error || 'Ошибка', true);
    return r;
  }, [say]);

  const submitAuth = async (password: string): Promise<string | null> => {
    const ev = auth?.setup ? 'a:setup' : 'a:login';
    const r = await emitAck<{ token?: string; setup?: boolean; canSetup?: boolean }>(sockRef.current!, ev, { password });
    if (r.ok && r.token) { setToken(r.token); return null; }
    if (r.setup) setAuth({ setup: true, canSetup: !!r.canSetup });
    return r.error || 'Не удалось войти';
  };
  const logout = async () => {
    await emitAck(sockRef.current!, 'a:logout');
    setToken(null); setQuestionsDirty(false); setTab('home'); setS(null); setAuth({ setup: false, canSetup: false });
  };


  if (!s && auth) return <AuthScreen auth={auth} onSubmit={submitAuth} />;
  if (!s) return <div className="min-h-dvh flex items-center justify-center text-muted">Подключение к серверу…</div>;

  const { pub } = s;
  const currentAge = pub.tournament.age;
  const ageMode = !!pub.tournament.ageMode;
  const switchAge = async (age: Age) => {
    if (questionsDirty && !confirm('Изменения вопросов ещё не сохранены. Переключить группу без сохранения?')) return;
    const r = await call('a:age:activate', { age });
    if (r.ok) { setQuestionsDirty(false); say(`Сейчас играют: ${AGE_LABEL[age]}`); }
  };
  const st = pub.quiz.status === 'open' ? { t: 'ПРИЁМ ОТВЕТОВ', c: 'bg-go text-ink' } : pub.quiz.status === 'closed' ? { t: 'ПРИЁМ ЗАКРЫТ', c: 'bg-warn text-ink' } : STATUS_LABEL[pub.status];
  // 'qr' — устаревший алиас 'start': отдельного экрана QR больше нет, оба режима показывают одну арену.
  const qrOnScreen = pub.displayView === 'start' || pub.displayView === 'qr';
  const gameLive = pub.auto.running || pub.quiz.status !== 'idle' || pub.status !== 'idle';
  const NAV: [Tab, string, typeof Home][] = [
    ['game', 'Проведение игры', Play], ['questions', 'Вопросы', ListChecks],
    ['teams', 'Команды', Users], ['results', 'Результаты', Trophy], ['tournaments', 'Мои турниры', Flag],
  ];
  const titles: Record<Tab, [string, string]> = {
    home: ['Ваш турнир', 'Подготовьте вопросы и команды — затем всё проведение на одном экране.'],
    game: ['Пульт ведущего', 'Читайте вопрос и нажимайте большую кнопку. Лиги переключаются сами.'],
    questions: ['Вопросы', 'Добавляйте вопросы, правильные ответы и варианты.'],
    teams: ['Команды и подключение', 'Пригласите капитанов и проверьте, кто уже на связи.'],
    register: ['Регистрация', 'Капитан подходит, называет команду — вы говорите PIN. Зелёные уже вошли.'],
    results: ['Результаты', 'Проверьте баллы и выберите, как объявить победителей.'],
    tournaments: ['Мои турниры', 'Создавайте, копируйте и открывайте турниры.'],
    settings: ['Настройки турнира', 'Время, баллы, автоматическая проверка и доступ.'],
    log: ['Журнал событий', 'История действий для разбора спорных ситуаций.'],
    demo: ['Проверка и демо', 'Инструменты для репетиции перед мероприятием.'],
  };
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <a href="/admin" className="admin-brand">QUIZ <span>ARENA</span><small>Кабинет ведущего</small></a>
        <div className="admin-tournament"><span className="text-xs text-muted">Текущий турнир</span><strong>{pub.tournament.name}</strong><button onClick={() => navigate('tournaments')}>Сменить или создать →</button></div>
        <nav aria-label="Основные разделы" className="admin-nav">
          {NAV.map(([id, label, Icon]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19} /><span>{label}</span>{id === 'questions' && <small>{s.questions.length}</small>}{id === 'teams' && <small>{pub.online}/{pub.teamCount}</small>}</button>)}
        </nav>
        <details className="admin-tools" open={['home', 'register', 'settings', 'log', 'demo'].includes(tab)}><summary>Ещё</summary><button onClick={() => navigate('home')}><Home size={16} /> Обзор</button><button onClick={() => navigate('register')}><KeyRound size={16} /> Регистрация (PIN)</button><button onClick={() => navigate('settings')}><Settings size={16} /> Настройки</button><button onClick={() => navigate('log')}><ScrollText size={16} /> Журнал событий</button><button onClick={() => navigate('demo')}><FlaskConical size={16} /> Проверка и демо</button></details>
        <div className="admin-sidebar-bottom"><span className={conn ? 'text-go' : 'text-danger'}>{conn ? '● Сервер подключён' : '● Нет связи с сервером'}</span><button onClick={() => { if (!questionsDirty || confirm('Выйти без сохранения вопросов?')) void logout(); }}><LogOut size={16} /> Выйти</button></div>
      </aside>
      <div className="admin-workspace">
        <header className="admin-topbar"><div className="min-w-0"><span className="text-muted text-xs">{pub.tournament.name}</span><div className="font-semibold">{ageMode && currentAge ? `${AGE_LABEL[currentAge]} · ` : ''}{s.questions.length && pub.tournament.question > s.questions.length ? 'Зачёт завершён' : <>{pub.auto.running ? 'Идёт автоматическая игра' : st.t.toLowerCase()} · вопрос {pub.tournament.question}{s.questions.length ? ` / ${s.questions.length}` : ''}</>}</div></div><div className="flex flex-wrap gap-2">{qrOnScreen ? (gameLive ? <button className={`${btn} bg-go text-ink`} onClick={() => call('a:display:set', { view: 'auto' })}><Monitor size={17} /> Вернуть игру на экран</button> : <button className={btnGhost} disabled><QrCode size={17} /> QR уже на экране</button>) : <button className={`${btn} bg-electric text-white`} onClick={() => call('a:display:set', { view: 'start' })}><QrCode size={17} /> QR на экран</button>}<a href="/display" target="_blank" rel="noreferrer" className={btnGhost}><Monitor size={17} /> Открыть проектор</a></div></header>
        <ShowBar view={pub.displayView} wm={pub.watermark} call={call} />
        {!conn && <div role="alert" className="admin-alert">Связь потеряна. Дождитесь подключения перед следующим действием.</div>}
        {pub.auto.running && tab !== 'game' && <button className="admin-live-banner" onClick={() => navigate('game')}><Play size={18} /> Игра продолжается · вопрос {pub.tournament.question} · вернуться к проведению →</button>}
        <div className="admin-content">
          <div className="admin-page-heading"><h1>{titles[tab][0]}{ageMode && currentAge && ['questions', 'game'].includes(tab) ? ` · ${AGE_LABEL[currentAge]}` : ''}</h1><p>{titles[tab][1]}</p></div>
          {ageMode && tab !== 'game' && <section className="admin-age-section" aria-label="Возрастные зачёты"><div className="flex justify-between gap-3 text-sm mb-3"><strong>Один турнир · три возрастных зачёта</strong><span className="text-muted">Вопросы и места считаются отдельно</span></div><div className="admin-age-grid">{s.ageGroups.map(group => <button key={group.age} aria-pressed={group.age === currentAge} disabled={pub.auto.running || pub.quiz.status === 'open' || ['open', 'buzzed'].includes(pub.status)} onClick={() => void switchAge(group.age)} style={{ borderColor: group.age === currentAge ? AGE_COLOR[group.age] : '#354660', borderTopColor: AGE_COLOR[group.age], background: `${AGE_COLOR[group.age]}${group.age === currentAge ? '22' : '0a'}` }}><small className="age-code" style={{ color: AGE_COLOR[group.age] }}>{AGE_CODE[group.age]}</small><strong>{AGE_LABEL[group.age]}</strong><span className="age-league">{AGE_SUBTITLE[group.age]}</span><span>Команды: {group.teams} · Вопросы: {group.questions}</span><small>{group.age === currentAge ? 'Выбрана' : 'Перейти к группе'} · {group.finished ? 'завершено' : `вопрос ${group.question}`}</small></button>)}</div><p className="text-xs text-muted mt-3">По одному вопросу по кругу: Juniors → Middles → Seniors → снова Juniors. Кнопка «Дальше» и автопроведение переключают лиги сами. Счёт, PIN и прогресс сохраняются.</p></section>}
          {!ageMode && tab === 'home' && <div className="admin-card mb-5"><h2 className="admin-section-title">Три возраста в одном турнире</h2><p className="text-sm text-muted mb-4">Отдельные вопросы и топы Juniors, Middles и Seniors. Лиги играют по кругу, по одному вопросу. Текущие вопросы станут набором Juniors; укажите лигу каждой команды.</p><button className={btnGhost} onClick={() => { if (confirm('Включить три возрастных зачёта внутри этого турнира? Текущие вопросы будут отнесены к Juniors.')) void call('a:age:enable'); }}>Включить возрастные зачёты</button></div>}
          {tab === 'home' && <><div className="host-welcome"><div><small>ГОТОВИМСЯ → ИГРАЕМ → ОБЪЯВЛЯЕМ ИТОГИ</small><h2>Ведите игру в своём темпе</h2><p>Один вопрос — одна лига. Пульт подскажет каждое следующее действие.</p></div><button className="host-primary" onClick={() => navigate('game')}>Открыть пульт <ArrowRight size={20} /></button></div><Overview s={s} navigate={navigate} /></>}
          {tab === 'questions' && <Questions key={`${s.activeId}:${currentAge}`} s={s} call={call} say={say} onDirty={setQuestionsDirty} getToken={getToken} />}
          {tab === 'teams' && <div className="flex flex-col gap-6"><div className="admin-card"><Connect s={s} call={call} /></div><div className="admin-card"><h2 className="admin-section-title">Список команд</h2><p className="text-muted mb-4">Капитан сканирует QR, выбирает команду и вводит её PIN. Название можно изменить кнопкой карандаша.</p><Teams s={s} call={call} /></div><details className="admin-card"><summary>Карточки с личными QR для печати</summary><div className="mt-4"><Cards s={s} /></div></details></div>}
          {tab === 'register' && <Register s={s} call={call} />}
          {tab === 'results' && <div className="flex flex-col gap-5"><div className="admin-card"><Results s={s} call={call} say={say} /></div><details className="admin-card"><summary>{ageMode && currentAge ? `Повторить зачёт: ${AGE_LABEL[currentAge]}` : 'Повторить игру с теми же командами'}</summary><p className="text-sm text-muted my-3">Счёт и ответы выбранного зачёта обнулятся. Вопросы, команды, PIN и результаты других возрастов сохранятся.</p><button className={btnGhost} onClick={async () => { if (confirm(s.pub.tournament.ageMode ? 'Сыграть выбранную возрастную группу заново? Её счёт и ответы обнулятся. Другие группы сохранят результаты.' : 'Сыграть заново? Счёт и история ответов обнулятся. Команды, PIN и вопросы сохранятся.')) { const r = await call('a:game:restart'); if (r.ok) navigate('game'); } }}><RotateCcw size={16} /> Сыграть заново</button></details></div>}
          {tab === 'tournaments' && <div className="admin-card"><Tournaments key={s.activeId} s={s} call={call} say={say} /></div>}
          {tab === 'settings' && <div className="admin-card"><TournamentSettings key={s.activeId} s={s} call={call} say={say} /></div>}
          {tab === 'log' && <div className="admin-card overflow-auto"><div className="flex gap-2 mb-4"><button className="admin-button" onClick={() => void downloadData('/api/data/log.jsonl', 'quiz-arena-log.jsonl', say)}>Скачать журнал</button><button className="admin-button" onClick={() => void downloadData('/api/data/log.jsonl?all=1', 'quiz-arena-all-logs.jsonl', say)}>Скачать все журналы</button></div><LogView s={s} /></div>}
          {tab === 'demo' && <div className="admin-card"><Demo s={s} call={call} say={say} setTab={navigate} /></div>}
      {tab === 'game' && <HostDesk s={s} call={call} mode={mode} setMode={setMode} connected={conn} navigate={navigate} />}
        </div>
      </div>
      {toast && <div role="status" aria-live="polite" className={`fixed bottom-4 left-1/2 -translate-x-1/2 px-5 py-3 font-black shadow-lg z-50 ${toast.bad ? 'bg-danger text-white' : 'bg-go text-ink'}`}>{toast.m}</div>}
    </div>
  );
}

function Teams({ s, call }: { s: AdminState; call: Call }) {
  const [name, setName] = useState('');
  const [showPins, setShowPins] = useState(true);
  const ranks = useMemo(() => new Map((s.pub.boards ? Object.values(s.pub.boards).flat() : s.pub.board).map((b) => [b.id, b.rank])), [s.pub.board]);
  const rows = [...s.teams].sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
  const del = (t: AdminTeam) => { if (confirm(`Удалить команду «${t.name}»?`)) void call('a:team:delete', { id: t.id }); };
  const adj = async (t: AdminTeam) => {
    const v = prompt(`Изменить счёт «${t.name}» на (например, 5 или -5):`, '0');
    if (v === null) return;
    const n = Number(v);
    if (Number.isInteger(n) && n !== 0) void call('a:score:adjust', { id: t.id, delta: n });
  };
  const rename = (t: AdminTeam) => { const v = prompt('Новое название:', t.name); if (v) void call('a:team:update', { id: t.id, name: v }); };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2 items-center">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { void call('a:team:create', { name }); setName(''); } }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Новая команда" className="h-10 bg-ink border-2 border-line px-3 outline-none focus:border-electric" />
          <button className={`${btn} bg-electric text-white`}><Plus size={16} /> Добавить</button>
        </form>
        <button className={btnGhost} onClick={() => call('a:teams:generate', { count: 30 })}>Сгенерировать до 30</button>
        <button className={btnGhost} onClick={() => setShowPins(!showPins)}><KeyRound size={16} /> {showPins ? 'Скрыть PIN' : 'Показать PIN'}</button>
        <details className="admin-danger-menu"><summary>Действия со всеми командами</summary><div className="flex flex-wrap gap-2 mt-3"><button className={btnGhost} onClick={() => { if (confirm('Обнулить счёт всех команд?')) void call('a:scores:reset'); }}>Обнулить счёт</button>
        <button className={`${btnGhost} text-danger`} onClick={() => { if (confirm('Удалить ВСЕ команды?')) void call('a:teams:clear'); }}><Trash2 size={16} /> Удалить все</button></div></details>
      </div>
      {rows.length === 0 && <div className="text-muted py-8 text-center">Команд нет. Добавьте вручную, сгенерируйте 30 или запустите демо.</div>}
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead className="text-muted text-left text-xs uppercase">
          <tr><th className="py-1 w-10">#</th><th>Команда</th><th>Возраст</th><th className="text-right">Баллы</th><th className="text-center">Корр.</th>{showPins && <th className="text-center">PIN</th>}<th>Связь</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const isFirst = s.pub.answerer?.id === t.id;
            return (
              <tr key={t.id} className={`border-t border-line/60 ${t.disabled ? 'opacity-50' : ''} ${isFirst ? 'bg-electric/20' : ''}`}>
                <td className="py-1.5 font-bold">{ranks.get(t.id)}</td>
                <td className="font-semibold border-l-[6px]" style={{ borderLeftColor: ageColor(t.age, 'transparent') }}><button className="inline-flex items-center gap-2 text-left" onClick={() => rename(t)} title="Изменить название команды">{t.name}<Pencil size={13} className="text-muted shrink-0" /></button></td>
                <td>
                  <select value={t.age ?? ''} onChange={(e) => call('a:team:update', { id: t.id, age: e.target.value || null })}
                    className="h-8 bg-ink border-2 border-line px-1 text-xs font-black outline-none focus:border-electric"
                    style={t.age ? { background: AGE_COLOR[t.age], color: AGE_TEXT[t.age] } : undefined}>
                    <option value="">—</option>
                    {(['junior', 'middle', 'senior'] as const).map((a) => <option key={a} value={a}>{AGE_LABEL[a]}</option>)}
                  </select>
                </td>
                <td className="text-right font-black tabular-nums text-base">{t.score}</td>
                <td className="text-center whitespace-nowrap">
                  <button aria-label={`Снять балл: ${t.name}`} className="px-1.5 text-muted hover:text-snow" onClick={() => call('a:score:adjust', { id: t.id, delta: -1 })}><Minus size={14} /></button>
                  <button aria-label={`Добавить балл: ${t.name}`} className="px-1.5 text-muted hover:text-snow" onClick={() => call('a:score:adjust', { id: t.id, delta: 1 })}><Plus size={14} /></button>
                  <button className="px-1.5 text-muted hover:text-snow text-xs" onClick={() => adj(t)}>±N</button>
                </td>
                {showPins && <td className="text-center font-mono tracking-widest">{t.pin}</td>}
                <td>
                  <span className={`inline-flex items-center gap-1 ${t.disabled ? 'text-danger' : t.connected ? 'text-go' : 'text-muted'}`}>
                    <span className={`w-2 h-2 rounded-full ${t.disabled ? 'bg-danger' : t.connected ? 'bg-go' : 'bg-idle'}`} />
                    {t.disabled ? 'отключена' : t.connected ? `онлайн${t.rtt !== null ? ` · ${t.rtt} мс` : ''}` : 'офлайн'}
                  </span>
                </td>
                <td className="text-right whitespace-nowrap">
                  <a className="px-1.5 text-muted hover:text-electric inline-block align-middle" title="Открыть как эта команда (новая вкладка)" target="_blank" href={`/play?t=${encodeURIComponent(t.id)}&p=${encodeURIComponent(t.pin)}`}><ExternalLink size={15} /></a>
                  <button title="Сбросить сессию (переподключение)" className="px-1.5 text-muted hover:text-snow" onClick={() => call('a:team:kick', { id: t.id })}><RefreshCw size={15} /></button>
                  <button title="Новый PIN" className="px-1.5 text-muted hover:text-snow" onClick={() => call('a:team:regenpin', { id: t.id })}><KeyRound size={15} /></button>
                  <button title={t.disabled ? 'Включить' : 'Отключить'} className={`px-1.5 ${t.disabled ? 'text-danger' : 'text-muted hover:text-snow'}`} onClick={() => call('a:team:disable', { id: t.id, disabled: !t.disabled })}><Ban size={15} /></button>
                  <button title="Удалить" className="px-1.5 text-muted hover:text-danger" onClick={() => del(t)}><Trash2 size={15} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </div>
  );
}

function TournamentSettings({ s, call, say }: { s: AdminState; call: Call; say: (m: string, bad?: boolean) => void }) {
  const [f, setF] = useState({
    tournamentName: s.pub.tournament.name, round: String(s.pub.tournament.round), question: String(s.pub.tournament.question),
    correctPoints: String(s.settings.correctPoints), wrongPoints: String(s.settings.wrongPoints), queueWindowMs: String(s.settings.queueWindowMs),
    openSec: String(s.settings.openSec), quizSec: String(s.settings.quizSec), answerSec: String(s.settings.answerSec),
    pauseSec: String(s.settings.pauseSec), resultSec: String(s.settings.resultSec), readSec: String(s.settings.readSec ?? -1),
    dEasy: String(s.settings.difficultyPoints.easy), dMedium: String(s.settings.difficultyPoints.medium), dHard: String(s.settings.difficultyPoints.hard),
    tEasy: String(s.settings.difficultySec.easy), tMedium: String(s.settings.difficultySec.medium), tHard: String(s.settings.difficultySec.hard),
  });
  const [difficultyTiming, setDifficultyTiming] = useState(s.settings.difficultyTiming);
  const [blockBreak, setBlockBreak] = useState(s.settings.blockBreak);
  const [autoGrade, setAutoGrade] = useState(s.settings.autoGrade);
  const [showQ, setShowQ] = useState(s.settings.showQuestion);
  const [pw, setPw] = useState({ old: '', next: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const [init] = useState(() => ({ f, blockBreak, autoGrade, showQ, difficultyTiming }));
  const save = async () => {
    // отправляем только изменённые поля: иначе старые значения формы затрут то, что успело поменяться (например, номер вопроса)
    const p: Record<string, unknown> = {};
    const nums = ['round', 'question', 'correctPoints', 'wrongPoints', 'queueWindowMs', 'openSec', 'quizSec', 'answerSec', 'pauseSec', 'resultSec', 'readSec'] as const;
    if (f.tournamentName !== init.f.tournamentName) p.tournamentName = f.tournamentName;
    for (const k of nums) if (f[k] !== init.f[k]) p[k] = Number(f[k]);
    if (f.dEasy !== init.f.dEasy || f.dMedium !== init.f.dMedium || f.dHard !== init.f.dHard) p.difficultyPoints = { easy: Number(f.dEasy), medium: Number(f.dMedium), hard: Number(f.dHard) };
    if (f.tEasy !== init.f.tEasy || f.tMedium !== init.f.tMedium || f.tHard !== init.f.tHard) p.difficultySec = { easy: Number(f.tEasy), medium: Number(f.tMedium), hard: Number(f.tHard) };
    if (difficultyTiming !== init.difficultyTiming) p.difficultyTiming = difficultyTiming;
    if (autoGrade !== init.autoGrade) p.autoGrade = autoGrade;
    if (blockBreak !== init.blockBreak) p.blockBreak = blockBreak;
    if (showQ !== init.showQ) p.showQuestion = showQ;
    if (!Object.keys(p).length) return say('Ничего не изменено');
    const r = await call('a:settings:update', p);
    if (r.ok) { Object.assign(init, { f: { ...f }, blockBreak, autoGrade, showQ, difficultyTiming }); say('Сохранено'); }
  };
  const download = (kind: string) => downloadCsv(kind, say);
  const inp = 'h-10 bg-ink border-2 border-line px-3 outline-none focus:border-electric w-full';
  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><L t="Название мероприятия"><input className={inp} value={f.tournamentName} onChange={set('tournamentName')} /></L></div>
        <L t="Номер раунда"><input className={inp} type="number" min={1} value={f.round} onChange={set('round')} /></L>
        <div className="text-xs text-muted self-end pb-2">Номер вопроса меняется на экране «Проведение игры», когда приём ответов закрыт.</div>
        <L t="Баллы за верный ответ"><input className={inp} type="number" value={f.correctPoints} onChange={set('correctPoints')} /></L>
        <L t="Баллы за неверный ответ"><input className={inp} type="number" value={f.wrongPoints} onChange={set('wrongPoints')} /></L>
        <div className="sm:col-span-2 text-xs font-black caps text-muted pt-2">Баллы по сложности (если у вопроса не заданы свои)</div>
        <div className="sm:col-span-2 grid grid-cols-3 gap-3">
          <L t="Лёгкий"><input className={inp} type="number" min={0} value={f.dEasy} onChange={set('dEasy')} /></L>
          <L t="Средний"><input className={inp} type="number" min={0} value={f.dMedium} onChange={set('dMedium')} /></L>
          <L t="Сложный"><input className={inp} type="number" min={0} value={f.dHard} onChange={set('dHard')} /></L>
        </div>
        <section className="sm:col-span-2 difficulty-settings"><div className="flex items-start justify-between gap-3 mb-4"><div><h3>Время по сложности</h3><p>Свой темп для каждого уровня</p></div><label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={difficultyTiming} onChange={e => setDifficultyTiming(e.target.checked)} className="w-5 h-5" /> Включено</label></div><div className="grid grid-cols-3 gap-3">{([['easy', 'tEasy'], ['medium', 'tMedium'], ['hard', 'tHard']] as const).map(([key, field]) => <label key={key} className="admin-field"><span style={{ color: DIFFICULTY[key].color }}>{DIFFICULTY[key].label}</span><small>{DIFFICULTY[key].subtitle}</small><div><input aria-label={`Время: ${DIFFICULTY[key].label.toLowerCase()}`} type="number" min={5} max={3600} value={f[field]} onChange={set(field)} disabled={!difficultyTiming} /><small>секунд</small></div></label>)}</div><p className="mt-4">Время конкретного вопроса важнее уровня. У вопроса без сложности действует общий таймер. В режиме кнопок это время на нажатие; время устного ответа задаётся отдельно.</p></section>
        <label className="sm:col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={blockBreak} onChange={(e) => setBlockBreak(e.target.checked)} className="w-5 h-5 accent-[#3B82F6]" /> Останавливаться между блоками (ведущий нажимает «Начать следующий блок»)</label>
        <div className="sm:col-span-2 text-xs font-black caps text-muted pt-2">Таймеры (0 — выключен). Время можно задать и для каждого вопроса отдельно.</div>
        <L t="Кнопки открыты, сек (автозакрытие)"><input className={inp} type="number" min={0} value={f.openSec} onChange={set('openSec')} /></L>
        <L t="Письменный ответ, сек"><input className={inp} type="number" min={0} value={f.quizSec} onChange={set('quizSec')} /></L>
        <L t="Время на ответ после нажатия, сек"><input className={inp} type="number" min={0} value={f.answerSec} onChange={set('answerSec')} /></L>
        <L t="Время на чтение вопроса, сек (-1 — по длине вопроса, 0 — без чтения)"><input className={inp} type="number" min={-1} max={60} value={f.readSec} onChange={set('readSec')} /></L>
        <L t="Пауза между вопросами (автопрограмма), сек"><input className={inp} type="number" min={0} max={600} value={f.pauseSec} onChange={set('pauseSec')} /></L>
        <L t="Показ результата в авто-BUZZ, сек"><input className={inp} type="number" min={0} max={60} value={f.resultSec} onChange={set('resultSec')} /></L>
        <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" checked={autoGrade} onChange={(e) => setAutoGrade(e.target.checked)} className="w-5 h-5 accent-[#3B82F6]" /> Автооценка по ответу из списка</label>
        <div className="sm:col-span-2"><L t="Окно приёма «очереди» после первого нажатия, мс (0 — только первый)"><input className={inp} type="number" min={0} max={10000} value={f.queueWindowMs} onChange={set('queueWindowMs')} /></L></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showQ} onChange={(e) => setShowQ(e.target.checked)} className="w-5 h-5 accent-[#3B82F6]" /> Показывать текст вопроса (из списка вопросов) на проекторе при открытых кнопках</label>
      <button onClick={save} className={`${btn} bg-electric text-white w-fit`}>Сохранить</button>
      <div className="border-t-2 border-snow/20 pt-4">
        <div className="caps text-xs font-black text-muted mb-2">ПАРОЛЬ АДМИНКИ</div>
        <div className="flex flex-wrap gap-2 items-end">
          <input type="password" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} placeholder="Текущий пароль" className={`${inp} !w-48`} />
          <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} placeholder="Новый пароль (от 4 знаков)" className={`${inp} !w-56`} />
          <button className={btnGhost} onClick={async () => { const r = await call('a:password:change', { oldPassword: pw.old, newPassword: pw.next }); if (r.ok) { say('Пароль изменён, остальные сеансы завершены'); setPw({ old: '', next: '' }); } }}><KeyRound size={16} /> Сменить</button>
        </div>
      </div>
      <div>
        <div className="caps text-xs font-black text-muted mb-2">ЭКСПОРТ</div>
        <div className="flex flex-wrap gap-2">
          <button className={btnGhost} onClick={() => download('results')}><Download size={16} /> Результаты CSV</button>
          <button className={btnGhost} onClick={() => download('stats')}><Download size={16} /> Статистика команд CSV</button>
          <button className={btnGhost} onClick={() => download('history')}><Download size={16} /> Ответы по вопросам CSV</button>
          <button className={btnGhost} onClick={() => download('buzzes')}><Download size={16} /> История нажатий CSV</button>
          <button className={btnGhost} onClick={() => download('answers')}><Download size={16} /> Письменные ответы CSV</button>
          <button className={btnGhost} onClick={() => download('log')}><Download size={16} /> Полный журнал CSV</button>
        </div>
      </div>
      <div className="text-xs text-muted">Копии создаются автоматически после каждого блока и игры; ручная копия — в разделе «Результаты».</div>
    </div>
  );
}

function LogView({ s }: { s: AdminState }) {
  const rows = [...s.log].reverse();
  return (
    <div className="font-mono text-xs flex flex-col gap-0.5">
      {rows.map((e) => {
        const d = e.data as Record<string, unknown>;
        const detail = Object.entries(d).filter(([k]) => !['round', 'question'].includes(k)).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
        const hot = e.type.startsWith('buzz.') || e.type === 'judge';
        const bad = e.type.includes('denied') || e.type.includes('failed') || e.type === 'buzz.rejected';
        return (
          <div key={e.id} className={`flex gap-3 px-2 py-0.5 rounded ${hot ? 'bg-electric/15' : ''}`}>
            <span className="text-muted tabular-nums">{fmtTime(e.t)}</span>
            <span className={`w-36 shrink-0 font-bold ${bad ? 'text-danger' : ''}`}>{e.type}</span>
            <span className="text-muted break-all">{detail}</span>
          </div>
        );
      })}
    </div>
  );
}

function TeamCard({ name, pin, url }: { name: string; pin: string; url: string }) {
  const qr = useQr(url, '#000000', '#FFFFFF');
  return (
    <div className="card bg-white text-black rounded-xl p-3 flex items-center gap-3 border border-black/20">
      {qr && <img src={qr} alt="" className="w-28 h-28 shrink-0" />}
      <div className="min-w-0">
        <div className="text-[10px] font-bold tracking-widest text-black/50">QUIZ ARENA</div>
        <div className="text-lg font-black leading-tight break-words">{name}</div>
        <div className="mt-1 text-sm">PIN: <b className="font-mono text-base tracking-widest">{pin}</b></div>
        <div className="text-[10px] text-black/50 mt-1 leading-tight">Наведите камеру на QR — вход выполнится сам</div>
      </div>
    </div>
  );
}

export function Cards({ s }: { s: AdminState }) {
  const { base: saved, options } = useJoinBase(s.pub.joinBase, s.pub.tunnel?.url);
  const [i, setI] = useState(-1);
  const base = i < 0 ? saved : options[Math.min(i, options.length - 1)];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">Адрес
          <select value={i} onChange={(e) => setI(Number(e.target.value))} className="h-10 rounded-lg bg-ink border border-line px-2 text-snow">
            <option value={-1}>{saved} (выбран для QR)</option>
            {options.map((o, k) => <option key={o} value={k}>{o}</option>)}
          </select>
        </label>
        <button className={`${btn} bg-electric text-white`} onClick={() => window.print()}><Printer size={16} /> Печать</button>
        <span className="text-xs text-muted max-w-md">QR на карточке содержит личную ссылку со входом без PIN. Раздавайте карточки только своим капитанам. Если IP ноутбука поменяется — перепечатайте карточки.</span>
      </div>
      {s.teams.length === 0 && <div className="text-muted py-6 text-center">Сначала создайте команды</div>}
      <div id="cards" className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {s.teams.map((t) => <TeamCard key={t.id} name={t.name} pin={t.pin} url={`${base}/play?t=${encodeURIComponent(t.id)}&p=${encodeURIComponent(t.pin)}`} />)}
      </div>
    </div>
  );
}

function Connect({ s, call }: { s: AdminState; call: Call }) {
  const { base, options, unreachable, deadSaved } = useJoinBase(s.pub.joinBase, s.pub.tunnel?.url);
  const tn = s.pub.tunnel;
  const qr = useQr(`${base}/play`);
  const qrOnScreen = s.pub.displayView === 'start' || s.pub.displayView === 'qr';
  const gameLive = s.pub.auto.running || s.pub.quiz.status !== 'idle' || s.pub.status !== 'idle';
  const all = options.includes(base) ? options : [base, ...options];
  return (
    <div className="flex flex-wrap gap-8 items-start">
      {qr && !unreachable ? <img src={qr} alt="QR /play" className="w-64 h-64" /> : <div className="w-64 h-64 border-2 border-warn text-warn p-4 text-sm font-bold flex items-center">Ноутбук не в Wi-Fi сети — телефоны не смогут открыть адрес. Подключитесь к сети или укажите ссылку туннеля ниже.</div>}
      <div className="flex flex-col gap-3 text-sm min-w-0">
        {qrOnScreen ? (gameLive ? <button className={`${btn} h-14 text-base bg-go text-ink w-fit`} onClick={() => call('a:display:set', { view: 'auto' })}><Monitor size={20} /> Вернуть игру на экран</button> : <button className={`${btnGhost} h-14 text-base w-fit`} disabled><QrCode size={20} /> QR уже на экране</button>) : <button className={`${btn} h-14 text-base bg-electric text-white w-fit`} onClick={() => call('a:display:set', { view: 'start' })}><QrCode size={20} /> Вывести QR на экран (проектор)</button>}
        <p className="text-muted max-w-md">Большой QR на весь проектор: капитаны сканируют с места, PIN берут у вас (раздел «Регистрация»). Когда откроете первый вопрос, экран переключится на игру сам.</p>
        <label className="flex flex-col gap-1 text-muted">Адрес ноутбука для телефонов (один раз выберите адрес Wi-Fi сети)
          <select value={base} onChange={(e) => void call('a:join:set', { base: e.target.value })} className="h-10 bg-ink border-2 border-line px-2 text-snow max-w-md">
            {all.map((o) => <option key={o} value={o}>{o}{s.pub.joinBase === o ? ' — выбран' : ''}</option>)}
          </select>
        </label>
        <form className="flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('custom') || '').trim(); void call('a:join:set', { base: v || null }); }}>
          <label className="flex flex-col gap-1 text-muted">Или свой адрес (например, ссылка https://….trycloudflare.com)
            <input name="custom" defaultValue={s.pub.joinBase && !options.includes(s.pub.joinBase) ? s.pub.joinBase : ''} placeholder="https://…" className="h-10 w-80 max-w-full bg-ink border-2 border-line px-2 text-snow" />
          </label>
          <button className={`${btn} bg-electric text-white`}>Сохранить адрес</button>
          {s.pub.joinBase && <button type="button" className={btnGhost} onClick={() => call('a:join:set', { base: null })}>Сбросить</button>}
        </form>
        <div className={`border-2 p-3 max-w-md font-bold ${tn?.status === 'ready' ? 'border-go bg-go/10 text-go' : tn?.status === 'missing' || tn?.status === 'off' ? 'border-snow/30 text-muted' : 'border-warn bg-warn/10 text-warn'}`}>
          {tn?.status === 'ready' ? <>✓ Интернет-ссылка работает — телефоны зайдут из любой сети<div className="text-snow font-normal break-all mt-1">{tn.url}/play</div></>
            : tn?.status === 'missing' ? 'Интернет-ссылка выключена: на ноутбуке нет cloudflared. Телефоны — только через ту же Wi-Fi сеть.'
            : tn?.status === 'off' || !tn ? 'Интернет-ссылка выключена (запуск с TUNNEL=0). Телефоны — только через ту же Wi-Fi сеть.'
            : `… Интернет-ссылка поднимается${tn.error ? ` (${tn.error})` : ''}. QR обновится сам через несколько секунд.`}
        </div>
        {deadSaved && <div className="border-2 border-danger bg-danger/15 text-danger p-3 font-bold max-w-md">Ссылка {s.pub.joinBase} не отвечает (туннель закрыт или сменилась сеть). QR временно ведёт на адрес ноутбука. Запустите туннель заново и вставьте новую ссылку или нажмите «Сбросить».</div>}
        <div><div className="text-muted">Капитаны (телефоны)</div><div className="text-xl font-bold text-electric break-all">{base}/play</div></div>
        <div><div className="text-muted">Проектор</div><div className="text-xl font-bold break-all">{base}/display</div></div>
        <p className="text-muted max-w-sm">Телефоны и ноутбук должны быть в одной Wi-Fi сети. Если телефоны не открывают адрес — выберите другой в списке.</p>
      </div>
    </div>
  );
}

/** Регистрация: ведущий называет PIN подошедшему капитану и видит, кто уже вошёл. */
function Register({ s, call }: { s: AdminState; call: Call }) {
  const [q, setQ] = useState('');
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const teams = s.teams.filter((t) => !t.disabled)
    .filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()))
    .filter((t) => !onlyWaiting || !t.connected);
  const online = s.teams.filter((t) => t.connected).length;
  const qrOnScreen = s.pub.displayView === 'start' || s.pub.displayView === 'qr';
  const gameLive = s.pub.auto.running || s.pub.quiz.status !== 'idle' || s.pub.status !== 'idle';
  return (
    <div className="flex flex-col gap-4">
      <div className="admin-card flex flex-wrap items-center gap-3">
        <div className="brutal font-black text-3xl">Вошли: <span className="text-go">{online}</span> из {s.teams.length}</div>
        {qrOnScreen ? (gameLive ? <button className={`${btn} h-12 bg-go text-ink`} onClick={() => call('a:display:set', { view: 'auto' })}><Monitor size={18} /> Вернуть игру на экран</button> : <button className={`${btnGhost} h-12`} disabled><QrCode size={18} /> QR уже на экране</button>) : <button className={`${btn} h-12 bg-electric text-white`} onClick={() => call('a:display:set', { view: 'start' })}><QrCode size={18} /> QR на экран</button>}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти команду…" className="h-12 bg-ink border-2 border-line px-3 text-lg outline-none focus:border-electric flex-1 min-w-[12rem]" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyWaiting} onChange={(e) => setOnlyWaiting(e.target.checked)} className="w-5 h-5" /> Только кто ещё не вошёл</label>
      </div>
      {s.teams.length === 0 && <div className="admin-card text-muted">Команд нет — создайте их в разделе «Команды и подключение».</div>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        {teams.map((t) => (
          <div key={t.id} className={`border-2 border-l-[10px] p-4 flex flex-col gap-1 ${t.connected ? 'border-go bg-go/10' : 'border-snow/25 bg-panel'}`} style={{ borderLeftColor: ageColor(t.age, t.connected ? '#22C55E' : '#3A486B') }}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-black text-lg leading-tight break-words">{t.name}</div>
              {t.age && <span className="px-1.5 py-0.5 text-[10px] font-black shrink-0" style={{ background: AGE_COLOR[t.age], color: AGE_TEXT[t.age] }}>{AGE_LABEL[t.age]}</span>}
            </div>
            <div className="num text-5xl tabular-nums tracking-[.15em]">{t.pin}</div>
            <div className={`text-sm font-black ${t.connected ? 'text-go' : 'text-muted'}`}>{t.connected ? '✓ вошла' : 'ждём капитана'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Полная симуляция: боты-команды играют весь турнир в реальном времени, в конце контрольный подсчёт. */
function SimPanel({ s, call }: { s: AdminState; call: Call }) {
  const [f, setF] = useState({ teams: '30', blocks: '3', perBlock: '5', questionSec: '20', pauseSec: '5', blockWaitSec: '8' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const logRef = useRef<HTMLDivElement>(null);
  const sim = s.sim;
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [sim.lines.length]);
  const n = (v: string) => Number(v) || 0;
  const total = n(f.blocks) * n(f.perBlock);
  const est = total * (n(f.questionSec) + n(f.pauseSec)) + Math.max(0, n(f.blocks) - 1) * n(f.blockWaitSec) + 15;
  const start = async () => {
    if (!confirm(`Запустить полную симуляцию?\n${n(f.teams)} ботов-команд, ${total} вопросов, примерно ${Math.ceil(est / 60)} мин.\nОна создаст отдельный турнир «Симуляция» и сделает его активным: настоящие капитаны будут отключены.`)) return;
    await call('a:sim:start', { teams: n(f.teams), blocks: n(f.blocks), perBlock: n(f.perBlock), questionSec: n(f.questionSec), pauseSec: n(f.pauseSec), blockWaitSec: n(f.blockWaitSec) });
  };
  const inp = 'h-10 bg-ink border-2 border-line px-3 outline-none focus:border-electric w-full';
  return (
    <div className="border-2 border-warn/60 bg-warn/5 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="caps text-xs font-black text-warn">Полная симуляция турнира</div>
        {sim.running && <span className="bg-warn text-ink px-2 py-0.5 caps text-xs font-black">идёт</span>}
      </div>
      <p className="text-sm text-muted leading-relaxed">Боты-команды подключаются к серверу как настоящие телефоны и играют весь турнир в реальном времени: думают случайное время, ошибаются, отвечают поздно, теряют связь и возвращаются. Откройте <a className="text-electric hover:underline" href="/display" target="_blank">/display</a> и смотрите вживую. В конце баллы каждой команды сверяются с независимым подсчётом.</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <L t="Команд (ботов)"><input className={inp} type="number" min={2} max={1000} value={f.teams} onChange={set('teams')} disabled={sim.running} /></L>
        <L t="Блоков"><input className={inp} type="number" min={1} max={5} value={f.blocks} onChange={set('blocks')} disabled={sim.running} /></L>
        <L t="Вопросов в блоке"><input className={inp} type="number" min={1} max={30} value={f.perBlock} onChange={set('perBlock')} disabled={sim.running} /></L>
        <L t="Секунд на вопрос"><input className={inp} type="number" min={2} value={f.questionSec} onChange={set('questionSec')} disabled={sim.running} /></L>
        <L t="Пауза между вопросами, с"><input className={inp} type="number" min={0} value={f.pauseSec} onChange={set('pauseSec')} disabled={sim.running} /></L>
        <L t="Перерыв между блоками, с"><input className={inp} type="number" min={0} value={f.blockWaitSec} onChange={set('blockWaitSec')} disabled={sim.running} /></L>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {sim.running
          ? <button className={`${btn} bg-danger text-white h-12`} onClick={() => call('a:sim:stop')}><X size={18} /> Остановить симуляцию</button>
          : <button className={`${btn} bg-warn text-ink h-12`} onClick={start}><Play size={18} /> Запустить симуляцию</button>}
        <span className="text-xs text-muted">{total} вопросов · примерно {Math.ceil(est / 60)} мин</span>
      </div>
      {sim.lines.length > 0 && (
        <div ref={logRef} className="bg-ink border-2 border-line p-3 max-h-64 overflow-auto font-mono text-xs leading-relaxed">
          {sim.lines.map((l, i) => <div key={i} className={l.includes('✓') ? 'text-go' : l.includes('✗') || l.includes('ОШИБКА') ? 'text-danger' : l.includes('▶') || l.includes('■') ? 'text-warn' : ''}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

function Demo({ s, call, say, setTab }: { s: AdminState; call: Call; say: (m: string, bad?: boolean) => void; setTab: (t: Tab) => void }) {
  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      <SimPanel s={s} call={call} />
      <div className="text-sm text-muted leading-relaxed">
        Демонстрация за 2 минуты: <b className="text-snow">1)</b> «Запустить демо» создаёт отдельный турнир с 30 командами и 12 вопросами (тестовые баллы). <b className="text-snow">2)</b> Откройте проектор (<code>/display</code>). <b className="text-snow">3)</b> В «Проведении игры» нажмите «Показать вопрос» — вопрос появится на проекторе, на телефонах поле ответа; ответы проверяются сами. <b className="text-snow">4)</b> «Результаты» → «Автоматическое награждение». Настоящий турнир остаётся в «Моих турнирах».
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <button className={`${btn} bg-electric text-white h-12`} onClick={async () => {
          if (!confirm('Создать отдельный демо-турнир с 30 командами и 12 вопросами и переключиться на него? Настоящий турнир останется в «Моих турнирах».')) return;
          const r = await call('a:demo:start'); if (r.ok) { say('Демо запущено: 30 команд, 12 вопросов'); setTab('game'); }
        }}><FlaskConical size={18} /> Запустить демо (30 команд)</button>
      </div>
      <p className="text-xs text-muted">Для полноценной игры ботов с потерей связи и проверкой счёта используйте «Полную симуляцию турнира» выше.</p>
    </div>
  );
}

async function downloadData(path: string, name: string, say: (m: string, bad?: boolean) => void) {
  try {
    const r = await fetch(path, { headers: { 'x-admin-token': getToken() } });
    if (!r.ok) throw new Error('Нет прав или сервер недоступен');
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  } catch (e) { say(e instanceof Error ? e.message : 'Не удалось скачать файл', true); }
}

export async function downloadCsv(kind: string, say: (m: string, bad?: boolean) => void) {
  const r = await fetch(`/api/export/${kind}.csv`, { headers: { 'x-admin-token': getToken() } });
  if (!r.ok) return say('Экспорт недоступен (нет прав)', true);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = `quiz-arena-${kind}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function Results({ s, call, say }: { s: AdminState; call: Call; say: (m: string, bad?: boolean) => void }) {
  const rv = s.pub.reveal;
  const board = s.pub.board;
  const resultAge = s.pub.tournament.resultAge || s.pub.tournament.age;
  const stats = new Map(s.stats.map((r) => [r.teamId, r]));
  const sec = (ms: number | null | undefined) => (ms == null ? '—' : (ms / 1000).toFixed(2));
  const view = s.pub.displayView;
  const section = 'border-2 border-snow/20 p-3 flex flex-col gap-2';
  return (
    <div className="flex flex-col gap-5">
      <section className={`${section} !border-go/60`}><h2 className="admin-section-title">Награждение</h2><div className="flex flex-wrap items-center gap-3"><button className={`${btn} h-12 ${s.pub.ceremony?.running ? 'bg-danger text-white' : 'bg-go text-ink'}`} onClick={() => { if (s.pub.ceremony?.running) void call('a:ceremony:stop'); else if (confirm(s.pub.tournament.ageMode ? 'Запустить автоматическое награждение?\nJuniors → Middles → Seniors → общий топ-3 → общая таблица всех команд. Всё переключается автоматически.' : 'Объявить призёров и автоматически открыть общую таблицу?')) void call('a:ceremony:start'); }}><Trophy size={18} /> {s.pub.ceremony?.running ? 'Остановить награждение' : 'Автоматическое награждение'}</button>{s.pub.ceremony?.running && <span className="font-black text-go">Идёт: {s.pub.ceremony.group === 'all' ? 'общий топ-3' : s.pub.ceremony.group ? AGE_LABEL[s.pub.ceremony.group] : ''} · {s.pub.ceremony.rank ? `${s.pub.ceremony.rank}-е место` : 'заставка'} · {s.pub.ceremony.step} из {s.pub.ceremony.total}</span>}</div><p className="text-sm text-muted">Одна кнопка запускает всю церемонию: {s.pub.tournament.ageMode ? 'Juniors → Middles → Seniors → общий топ-3 → общая таблица всех команд' : 'топ-3 → общая таблица'}. Места объявляются от третьего к первому, по 8 секунд на экран. При ничьей показываем всех призёров. Весь сценарий — около двух минут; после награждения таблица остаётся на проекторе.</p></section>
      {s.pub.tournament.ageMode && <section className={section}><h2 className="admin-section-title">Топ · {resultAge === 'all' ? 'общий зачёт' : resultAge && AGE_LABEL[resultAge]}</h2><div className="flex flex-wrap gap-2">{s.ageGroups.map(g => <button key={g.age} aria-pressed={resultAge === g.age} className={`${btnGhost} ${resultAge === g.age ? '!border-electric' : ''}`} onClick={() => call('a:age:results', { age: g.age })}>{AGE_LABEL[g.age]} · {g.teams} команд</button>)}<button aria-pressed={resultAge === 'all'} className={`${btnGhost} ${resultAge === 'all' ? '!border-electric' : ''}`} onClick={() => call('a:age:results', { age: 'all' })}>Общий зачёт · {s.teams.length} команд</button></div><p className="text-sm text-muted">Выберите зачёт: таблица ниже и кнопки объявления работают по нему. «Общий зачёт» — все команды всех лиг вместе.</p></section>}
      <section className={section}>
        <div className="caps text-xs font-black text-muted">Объявление результатов (участники не видят места, пока вы не откроете)</div>
        <div className="flex flex-wrap gap-2">
          <button className={`${btn} bg-warn text-ink`} onClick={() => { if ((board.length <= 60 || confirm(`Команд ${board.length}: раскрытие с последнего места займёт ${board.length} нажатий. Лучше «Только десятка». Продолжить?`)) && confirm('Начать раскрытие мест с последнего?')) void call('a:reveal:start', { mode: 'all' }); }}><Flag size={16} /> С последнего места</button>
          <button className={`${btn} bg-warn text-ink`} onClick={() => { if (confirm('Объявить только тройку призёров (3, 2, 1)?')) void call('a:reveal:start', { mode: 'top3' }); }}><Trophy size={16} /> Только тройка</button>
          {board.length > 10 && <button className={`${btn} bg-warn text-ink`} onClick={() => { if (confirm('Объявить десятку лучших (с 10-го до 1-го)?')) void call('a:reveal:start', { mode: 'top10' }); }}><Trophy size={16} /> Только десятка</button>}
          <button className={btnGhost} onClick={() => call('a:display:set', { view: 'leaderboard' })}>Показать таблицу</button>
          <button className={btnGhost} onClick={() => call('a:display:set', { view: 'final' })}>Показать подиум</button>
          <button className={btnGhost} onClick={() => call('a:display:set', { view: 'closing' })}><Lock size={16} /> Скрыть (экран «завершена»)</button>
        </div>
        {rv.active && (
          <div className="flex flex-wrap items-center gap-3 bg-warn/10 border-2 border-warn p-3">
            <div className="font-black">Раскрыто {rv.shown - rv.start} из {rv.total - rv.start}{rv.done ? ' · всё объявлено' : ''}</div>
            <button className={`${btn} bg-panel !border-snow/60`} onClick={() => call('a:reveal:prev')}>← Назад</button>
            <button className={`${btn} bg-go text-ink h-12 text-base`} disabled={rv.done} onClick={() => call('a:reveal:next')}>Следующее место →</button>
            <span className="text-xs text-muted">Сейчас на проекторе: {rv.rows.length ? `место ${rv.rows[rv.rows.length - 1].rank} — ${rv.rows[rv.rows.length - 1].name}` : 'заставка «Итоги»'}</span>
          </div>
        )}
        {!rv.active && <div className="text-xs text-muted">Сейчас на проекторе: {{ start: 'старт · QR для входа', qr: 'QR для входа (старый экран)', auto: 'игра', leaderboard: 'таблица', final: 'подиум', splash: 'заставка', sponsors: 'спонсоры', record: 'видео: рекорд', flag: 'видео: флаг', closing: 'экран «завершена»', reveal: '—' }[view]}</div>}
      </section>

      <section className={section}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="caps text-xs font-black text-muted">Рейтинг (виден только вам)</div>
          <div className="text-xs text-muted">Равные баллы → выше команда с меньшей суммой времени верных ответов. Полное равенство → совместное место.</div>
        </div>
        <div className="overflow-auto max-h-96">
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase sticky top-0 bg-panel"><tr><th className="py-1 w-10">Место</th><th>Команда</th><th>Возраст</th><th className="text-right">Баллы</th><th className="text-right">Верных</th><th className="text-right">Время верных, с</th></tr></thead>
            <tbody>
              {board.map((r) => (
                <tr key={r.id} className="border-t border-line/60">
                  <td className="py-1 font-black">{r.rank}</td>
                  <td className="font-semibold border-l-[6px] pl-2" style={{ borderLeftColor: ageColor(r.age, 'transparent') }}>{r.name}</td>
                  <td>{r.age ? <span className="px-1.5 py-0.5 text-[10px] font-black" style={{ background: AGE_COLOR[r.age], color: AGE_TEXT[r.age] }}>{AGE_LABEL[r.age]}</span> : '—'}</td>
                  <td className="text-right font-black tabular-nums">{r.score}</td>
                  <td className="text-right tabular-nums">{r.correct ?? 0}</td>
                  <td className="text-right tabular-nums text-muted">{sec(r.timeMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={section}>
        <div className="caps text-xs font-black text-muted">Результаты по блокам (баллы / верных)</div>
        {s.blocks.length === 0 ? <div className="text-sm text-muted">Блоков пока нет — загрузите вопросы с номерами блоков.</div> : (
          <div className="overflow-auto max-h-80">
            <table className="w-full text-sm">
              <thead className="text-muted text-left text-xs uppercase"><tr><th className="py-1">Команда</th>{s.blocks.map((b) => <th key={b} className="text-right">Блок {b}</th>)}<th className="text-right">Всего</th></tr></thead>
              <tbody>
                {board.map((r) => {
                  const st = stats.get(r.id);
                  return (
                    <tr key={r.id} className="border-t border-line/60">
                      <td className="py-1 font-semibold">{r.name}</td>
                      {s.blocks.map((b) => <td key={b} className="text-right tabular-nums">{st?.perBlock[String(b)]?.points ?? 0} <span className="text-muted text-xs">/ {st?.perBlock[String(b)]?.correct ?? 0}</span></td>)}
                      <td className="text-right font-black tabular-nums">{r.score}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={section}>
        <div className="caps text-xs font-black text-muted">Статистика времени (для анализа; в рейтинге используется только при равенстве баллов)</div>
        <div className="overflow-auto max-h-80">
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase"><tr><th className="py-1">Команда</th><th className="text-right">Ответов</th><th className="text-right">Верных</th><th className="text-right">Ср. время ответа, с</th><th className="text-right">Суммарное время, с</th><th className="text-right">Ср. доставка вопроса, мс</th></tr></thead>
            <tbody>
              {s.stats.map((r) => (
                <tr key={r.teamId} className="border-t border-line/60">
                  <td className="py-1 font-semibold">{r.name}</td>
                  <td className="text-right tabular-nums">{r.answered}</td><td className="text-right tabular-nums">{r.correct}</td>
                  <td className="text-right tabular-nums">{sec(r.avgAnswerMs)}</td>
                  <td className="text-right tabular-nums">{sec(r.timeAllMs)}</td>
                  <td className="text-right tabular-nums">{r.avgDeliveryMs == null ? '—' : Math.round(r.avgDeliveryMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={section}>
        <div className="caps text-xs font-black text-muted">Экспорт и сохранность</div>
        <div className="flex flex-wrap gap-2">
          <button className={btnGhost} onClick={() => downloadCsv('results', say)}><Download size={16} /> Итоги CSV</button>
          <button className={btnGhost} onClick={() => downloadCsv('stats', say)}><Download size={16} /> Статистика CSV</button>
          <button className={btnGhost} onClick={() => downloadCsv('history', say)}><Download size={16} /> Все ответы CSV</button>
          <button className={btnGhost} onClick={async () => { const r = await call('a:backup'); if (r.ok) say('Резервная копия сохранена в data/backups'); }}>Резервная копия сейчас</button>
        </div>
        <div className="text-xs text-muted">Копии создаются сами при завершении каждого блока и игры, хранятся последние 60 в <code>data/backups</code>. Сохранено вопросов в архиве: {s.historyCount}.</div>
      </section>
    </div>
  );
}

function L({ t, children }: { t: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-xs font-black caps text-muted">{t}{children}</label>;
}

export function AuthScreen({ auth, onSubmit }: { auth: { setup: boolean; canSetup: boolean }; onSubmit: (pw: string) => Promise<string | null> }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setup = auth.setup;
  const submit = async () => {
    setErr('');
    if (setup && pw !== pw2) return setErr('Пароли не совпадают');
    setBusy(true);
    const e = await onSubmit(pw);
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <div className="auth-shell">
      <div className="auth-glow auth-glow-a" />
      <div className="auth-glow auth-glow-b" />
      <div className="auth-grid" />
      <div className="auth-wrap">
        <section className="auth-brand">
          <div className="auth-logo">QUIZ <span>ARENA</span></div>
          <p className="auth-tag">Локальная система для школьного интеллектуального турнира: до 30 команд, три возрастные лиги, проектор и телефоны капитанов — в одной Wi-Fi сети, без интернета.</p>
          <ul className="auth-feats">
            <li><Users size={18} strokeWidth={2.4} /> Капитаны заходят по QR и PIN — без установки приложений</li>
            <li><Flag size={18} strokeWidth={2.4} /> Juniors, Middles и Seniors: свои вопросы и отдельные зачёты</li>
            <li><Monitor size={18} strokeWidth={2.4} /> Проектор, таймеры, автооценка и автоматическое награждение</li>
          </ul>
          <div className="auth-foot">Кабинет ведущего · вопрос → чтение → приём → оценка</div>
        </section>
        <form className="auth-card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="auth-card-head">
            <h2>{setup ? 'Первый запуск' : 'Вход для ведущего'}</h2>
            <span className="auth-badge">{setup ? 'Настройка' : 'Админка'}</span>
          </div>
          <div className="auth-tabs">{setup ? <b>Придумайте пароль админки</b> : <b>Введите пароль, чтобы управлять турниром</b>}</div>
          {setup && !auth.canSetup ? (
            <div className="auth-error">Пароль ещё не задан. Откройте админку на ноутбуке ведущего (адрес localhost) и задайте его там.</div>
          ) : (
            <>
              <label className="auth-field"><span>{setup ? 'Новый пароль (от 4 знаков)' : 'Пароль'}</span>
                <div className="auth-input-wrap">
                  <input autoFocus type={show ? 'text' : 'password'} value={pw} onChange={(e) => { setPw(e.target.value); setErr(''); }} autoComplete={setup ? 'new-password' : 'current-password'} placeholder={setup ? 'Минимум 4 знака' : '••••••••'} className="auth-input" />
                  <button type="button" className="auth-eye" onClick={() => setShow(!show)} aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}>{show ? <EyeOff size={19} /> : <Eye size={19} />}</button>
                </div>
              </label>
              {setup && <label className="auth-field"><span>Повторите пароль</span>
                <div className="auth-input-wrap">
                  <input type={show ? 'text' : 'password'} value={pw2} onChange={(e) => { setPw2(e.target.value); setErr(''); }} autoComplete="new-password" placeholder="Повторите пароль" className="auth-input" />
                </div>
              </label>}
              {err && <div className="auth-error">{err}</div>}
              <button disabled={busy || pw.length < (setup ? 4 : 1)} className="auth-submit">{busy ? 'Входим…' : setup ? 'Задать пароль и войти' : 'Войти в кабинет'}</button>
            </>
          )}
          <p className="auth-note">Пароль защищает управление турниром. Капитаны и проектор его не используют.</p>
        </form>
      </div>
    </div>
  );
}

function Tournaments({ s, call, say }: { s: AdminState; call: Call; say: (m: string, bad?: boolean) => void }) {
  const blank = { name: '', copyFrom: '', teamCount: '30', teamNames: '', correctPoints: '10', wrongPoints: '0', openSec: '30', quizSec: '30', answerSec: '15', showQuestion: true, questions: '', ageMode: false, difficultyTiming: true };
  const [f, setF] = useState(blank);
  const [open, setOpen] = useState(false);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const inp = 'h-10 bg-ink border-2 border-line px-3 outline-none focus:border-electric w-full';

  const create = async () => {
    const payload: Record<string, unknown> = { name: f.name.trim() || undefined, showQuestion: f.showQuestion, ageMode: f.ageMode, difficultyTiming: f.difficultyTiming };
    if (f.copyFrom) payload.copyFrom = f.copyFrom;
    if (f.teamNames.trim()) payload.teamNames = f.teamNames; else if (!f.copyFrom) payload.teamCount = Number(f.teamCount);
    for (const k of ['correctPoints', 'wrongPoints', 'openSec', 'quizSec', 'answerSec'] as const) if (!f.copyFrom) payload[k] = Number(f[k]);
    if (f.questions.trim()) payload.questions = f.questions;
    const r = await call('a:tournament:create', payload);
    if (r.ok) { say('Турнир создан и открыт. Капитанам нужно войти заново.'); setF(blank); setOpen(false); }
  };
  const activate = (t: TournamentItem) => { if (confirm(`Переключить на турнир «${t.name}»?\nВсе капитаны будут отключены и войдут заново.`)) void call('a:tournament:activate', { id: t.id }); };
  const remove = (t: TournamentItem) => { if (confirm(`Удалить турнир «${t.name}» вместе с командами и счётом? Это нельзя отменить.`)) void call('a:tournament:delete', { id: t.id }); };
  const copy = (t: TournamentItem) => { setF({ ...blank, copyFrom: t.id, name: `${t.name} (копия)` }); setOpen(true); };

  return (
    <div className="flex flex-col gap-6">
      <section className="admin-card flex flex-wrap gap-3 items-center"><button className="admin-button" onClick={() => void downloadData('/api/data/export.json', `quiz-arena-backup-${new Date().toISOString().slice(0, 10)}.json`, say)}>Экспорт данных</button><label className="admin-button cursor-pointer">Импорт данных<input className="hidden" type="file" accept="application/json,.json" onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        if (file.size > 20 * 1024 * 1024) { say('Файл больше 20 МБ', true); return; }
        if (!confirm('Заменить все турниры и журналы данными из файла? Текущие данные будут сохранены в резервную копию. PIN команд будут созданы заново.')) return;
        try { const r = await fetch('/api/data/import.json', { method: 'POST', headers: { 'x-admin-token': getToken(), 'Content-Type': 'application/json' }, body: await file.text() }); const result = await r.json(); if (!r.ok) throw new Error(result.error || 'Ошибка импорта'); say('Данные восстановлены. PIN команд обновлены.'); } catch (err) { say(err instanceof Error ? err.message : 'Ошибка импорта', true); }
      }} /></label><p className="text-xs text-muted">Пароль администратора и PIN команд в файл не включаются. После импорта PIN создаются заново.</p></section>
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="caps text-xs font-black text-muted">ТУРНИРЫ · {s.tournaments.length}</div>
          <button className={`${btn} bg-electric text-white`} onClick={() => { setF(blank); setOpen(!open); }}><Plus size={16} /> Создать турнир</button>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          {s.tournaments.map((t) => (
            <div key={t.id} className={`border-2 p-3 flex flex-col gap-2 ${t.active ? 'border-electric bg-electric/10' : 'border-snow/25 bg-ink/40'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="brutal font-black text-xl leading-tight break-words">{t.name}</div>
                {t.active && <span className="shrink-0 bg-electric text-white text-[10px] font-black caps px-2 py-0.5">Активный</span>}
                {t.demo && !t.active && <span className="shrink-0 border border-snow/50 text-[10px] font-black caps px-2 py-0.5">Демо</span>}
              </div>
              <div className="text-xs text-muted">{t.teams} команд · вопросов в списке: {t.questions} · раунд {t.round}, вопрос {t.question}</div>
              {t.rules && <div className="text-[11px] text-muted/90 leading-snug">{t.rules.correctPoints} б. за верный · ответ {t.rules.quizSec} с · чтение {t.rules.readSec === 0 ? 'выкл' : t.rules.readSec === -1 ? 'по длине' : `${t.rules.readSec} с`} · автооценка {t.rules.autoGrade ? 'вкл' : 'выкл'}{t.rules.ageMode ? ' · 3 лиги' : ''}</div>}
              <div className="flex gap-2 mt-auto flex-wrap">
                {!t.active && <button className={`${btn} h-9 bg-go text-ink`} onClick={() => activate(t)}>Открыть</button>}
                <button className={`${btnGhost} h-9`} onClick={() => copy(t)}><Copy size={14} /> Копия</button>
                {!t.active && <button className={`${btnGhost} h-9 !text-danger`} onClick={() => remove(t)}><Trash2 size={14} /></button>}
              </div>
              {t.rules && <TournamentQuickEdit t={t} call={call} say={say} />}
            </div>
          ))}
        </div>
      </section>

      {open && (
        <section className="border-2 border-snow/30 p-4 bg-panel flex flex-col gap-4">
          <div className="caps text-xs font-black text-electric">{f.copyFrom ? 'Новый турнир на основе существующего' : 'Новый турнир'}</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2"><L t="Название"><input className={inp} value={f.name} onChange={set('name')} placeholder="Например: Школьный кубок 2026" /></L></div>
            {f.copyFrom ? (
              <div className="sm:col-span-2 text-sm text-muted">Берутся команды (с новыми PIN и нулевым счётом), настройки и вопросы исходного турнира. Ниже можно переопределить команды или вопросы.</div>
            ) : (
              <>
                <L t="Сколько команд создать"><input className={inp} type="number" min={0} max={200} value={f.teamCount} onChange={set('teamCount')} /></L>
                <div />
                <details className="sm:col-span-2"><summary>Баллы и время для нового турнира</summary><div className="grid sm:grid-cols-2 gap-3 mt-3">
                <L t="Баллы за верный"><input className={inp} type="number" value={f.correctPoints} onChange={set('correctPoints')} /></L>
                <L t="Баллы за неверный"><input className={inp} type="number" value={f.wrongPoints} onChange={set('wrongPoints')} /></L>
                <L t="Таймер кнопок, сек (0 — выкл.)"><input className={inp} type="number" min={0} value={f.openSec} onChange={set('openSec')} /></L>
                <L t="Письменный ответ, сек"><input className={inp} type="number" min={0} value={f.quizSec} onChange={set('quizSec')} /></L>
                <L t="Время на ответ после нажатия, сек"><input className={inp} type="number" min={0} value={f.answerSec} onChange={set('answerSec')} /></L>
                </div></details>
              </>
            )}
            <label className="sm:col-span-2 flex items-start gap-2 text-sm"><input type="checkbox" checked={f.ageMode} onChange={e => setF({ ...f, ageMode: e.target.checked })} className="w-5 h-5" /> Один турнир: Juniors, Middles и Seniors — свои вопросы и места у каждой группы</label>
            <div className="sm:col-span-2"><L t="Названия команд (по одному в строке — вместо числа выше)"><textarea rows={4} className={`${inp} h-auto py-2 normal-case tracking-normal font-bold`} value={f.teamNames} onChange={set('teamNames')} placeholder={'Орлы\nСоколы\nЯстребы'} /></L></div>
            
            <label className="sm:col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.showQuestion} onChange={(e) => setF({ ...f, showQuestion: e.target.checked })} className="w-5 h-5 accent-[#3B82F6]" /> Показывать вопрос на проекторе при открытых кнопках</label>
          </div>
          <div className="flex gap-2">
            <button className={`${btn} bg-go text-ink`} onClick={create}>Создать и открыть</button>
            <button className={btnGhost} onClick={() => setOpen(false)}>Отмена</button>
          </div>
          <div className="text-xs text-muted">После создания турнир станет активным: все капитаны отключатся и войдут в новый турнир по своим новым PIN (карточки с QR — во разделе «Команды и подключение»).</div>
        </section>
      )}

      <p className="text-sm text-muted">После создания откройте раздел «Вопросы», чтобы добавить задания, и «Команды и подключение», чтобы пригласить капитанов.</p>
    </div>
  );
}

/** Быстрый редактор правил прямо в списке турниров — без переключения и без ухода из раздела. */
function TournamentQuickEdit({ t, call, say }: { t: TournamentItem; call: Call; say: (m: string, bad?: boolean) => void }) {
  const r = t.rules!;
  const [f, setF] = useState({
    correctPoints: String(r.correctPoints), wrongPoints: String(r.wrongPoints), quizSec: String(r.quizSec),
    readSec: String(r.readSec), autoGrade: r.autoGrade, showQuestion: r.showQuestion,
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setF({
      correctPoints: String(r.correctPoints), wrongPoints: String(r.wrongPoints), quizSec: String(r.quizSec),
      readSec: String(r.readSec), autoGrade: r.autoGrade, showQuestion: r.showQuestion,
    });
    setDone(false);
  }, [r.correctPoints, r.wrongPoints, r.quizSec, r.readSec, r.autoGrade, r.showQuestion]);
  const save = async () => {
    setBusy(true);
    const res = await call('a:tournament:update', {
      id: t.id, correctPoints: Number(f.correctPoints), wrongPoints: Number(f.wrongPoints), quizSec: Number(f.quizSec),
      readSec: Number(f.readSec), autoGrade: f.autoGrade, showQuestion: f.showQuestion,
    });
    setBusy(false);
    if (res.ok) { setDone(true); say(`Правила «${t.name}» обновлены${t.active ? ' и уже действуют' : ''}`); }
  };
  const inp = 'h-9 bg-ink border-2 border-line px-2 text-sm outline-none focus:border-electric w-full';
  return (
    <details className="border-t border-snow/15 pt-2">
      <summary className="text-[11px] font-black caps text-muted cursor-pointer select-none">Настроить правила</summary>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <label className="flex flex-col gap-1 text-[10px] font-black caps text-muted">Баллы за верный<input className={inp} type="number" value={f.correctPoints} onChange={(e) => setF({ ...f, correctPoints: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-[10px] font-black caps text-muted">Баллы за неверный<input className={inp} type="number" value={f.wrongPoints} onChange={(e) => setF({ ...f, wrongPoints: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-[10px] font-black caps text-muted">Ответ, сек<input className={inp} type="number" min={0} value={f.quizSec} onChange={(e) => setF({ ...f, quizSec: e.target.value })} /></label>
        <label className="flex flex-col gap-1 text-[10px] font-black caps text-muted">Чтение, сек (-1/0)<input className={inp} type="number" min={-1} max={60} value={f.readSec} onChange={(e) => setF({ ...f, readSec: e.target.value })} /></label>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-2">
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={f.autoGrade} onChange={(e) => setF({ ...f, autoGrade: e.target.checked })} className="w-4 h-4 accent-[#3B82F6]" /> Автооценка</label>
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={f.showQuestion} onChange={(e) => setF({ ...f, showQuestion: e.target.checked })} className="w-4 h-4 accent-[#3B82F6]" /> Показывать вопрос</label>
        <button className={`${btn} h-8 bg-electric text-white ml-auto`} disabled={busy} onClick={() => void save()}>{busy ? '…' : done ? 'Сохранено' : 'Сохранить'}</button>
      </div>
      <p className="text-[10px] text-muted mt-1 leading-snug">Чтение 0 — ведущий читает сам без отсчёта, −1 — по длине вопроса. Для активного турнира изменения действуют сразу, даже во время игры.</p>
    </details>
  );
}

function Overview({ s, navigate }: { s: AdminState; navigate: (tab: Tab) => void }) {
  const playing = s.pub.auto.running || s.pub.quiz.status === 'open' || s.pub.status === 'open' || s.pub.status === 'buzzed';
  const finished = s.pub.auto.finished;
  const next: Tab = playing ? 'game' : finished ? 'results' : !s.questions.length ? 'questions' : !s.teams.length || s.pub.online < s.teams.filter(t => !t.disabled).length ? 'teams' : 'game';
  const nextText = { game: 'Перейти к проведению', results: 'Объявить результаты', questions: 'Добавить вопросы', teams: 'Подключить команды' };
  return <div className="flex flex-col gap-6">
    <section className="admin-welcome">
      <div className="admin-welcome-copy">
        <span className="admin-eyebrow">{playing ? '● Турнир в эфире' : finished ? 'Игра завершена' : 'Ваш турнир'}</span>
        <h2>{s.pub.tournament.name}</h2>
        <p>{playing ? 'Игра продолжается. Вернитесь к вопросам и ответам команд.' : finished ? 'Результаты готовы. Вы решаете, когда показать их участникам.' : 'Здесь видно, что уже готово и что сделать перед стартом.'}</p>
        <div className="admin-welcome-actions">
          <button className={`${btn} bg-electric text-white !h-12`} onClick={() => navigate(next)}><Play size={18} />{nextText[next as keyof typeof nextText]}</button>
          {next === 'questions' && <button className="admin-text-link" onClick={() => navigate('game')}>Буду читать вопросы вслух</button>}
        </div>
      </div>
      <div className="admin-welcome-stat"><strong>{s.pub.online}<span> / {s.teams.length}</span></strong><span>команд на связи</span></div>
    </section>
    <div className="admin-stat-grid">{([
      ['Вопросов', s.questions.length, 'questions'], ['Команд', s.teams.length, 'teams'], ['Блоков', s.blocks.length || 1, 'questions'], ['Время вопросов', s.settings.difficultyTiming ? `${Math.min(...Object.values(s.settings.difficultySec))}–${Math.max(...Object.values(s.settings.difficultySec))} с` : `${s.settings.quizSec} с`, 'settings'],
    ] as [string, number | string, Tab][]).map(([label, value, dest]) => <button key={label} onClick={() => navigate(dest)} className="admin-stat"><span>{label}</span><strong>{value}</strong><small>Открыть →</small></button>)}</div>
    <section className="admin-card"><h2 className="admin-section-title">Подготовка к игре</h2><div className="admin-checklist">{([
      ['questions', 'Подготовьте вопросы', s.questions.length ? `Сохранено вопросов: ${s.questions.length}. Можно проверить ответы и порядок.` : 'Текст, правильный ответ и варианты — в обычных полях.', s.questions.length > 0],
      ['teams', 'Пригласите команды', `${s.pub.online} из ${s.teams.length} на связи. QR и PIN находятся в этом разделе.`, s.teams.length > 0 && s.pub.online === s.teams.length],
      ['settings', 'Проверьте правила', `${s.settings.difficultyTiming ? `По сложности: ${s.settings.difficultySec.easy} / ${s.settings.difficultySec.medium} / ${s.settings.difficultySec.hard} с` : `Письменный ответ: ${s.settings.quizSec} с`}. Пауза: ${s.settings.pauseSec} с. Автопроверка ${s.settings.autoGrade ? 'включена' : 'выключена'}.`, false],
      ['game', 'Проведите игру', 'Выберите формат. Ведите каждый вопрос вручную или включите автоматическое проведение.', playing || finished],
    ] as [Tab, string, string, boolean][]).map(([dest, title, text, done], i) => <button key={dest} onClick={() => navigate(dest)} className="admin-check-row"><span className={`admin-check-number ${done ? 'is-done' : ''}`}>{done ? <Check size={20} /> : i + 1}</span><span><strong>{title}</strong><small>{text}</small></span><span className="text-muted">→</span></button>)}</div></section>
    <div className="admin-help"><Monitor size={22} /><div><strong>Что видит зал?</strong><p>«Открыть проектор» открывает отдельный экран для участников. Управление его содержимым — на экране игры, объявление мест — в результатах.</p></div></div>
  </div>;
}

/** Экран проектора: заставка, спонсоры, игра, видео — ведущий переключает вручную. */
const SHOW: [DisplayView, string][] = [['splash', 'Заставка'], ['sponsors', 'Спонсоры'], ['auto', 'Игра (вопросы)'], ['record', 'Видео: рекорд'], ['flag', 'Видео: флаг (повтор)']];
function ShowBar({ view, wm, call }: { view: DisplayView; wm?: Watermark; call: Call }) {
  // скрытая настройка подписи: 5 щелчков по «НА ПРОЕКТОРЕ:» или Ctrl+Alt+W
  const [open, setOpen] = useState(false);
  const clicks = useRef<number[]>([]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.ctrlKey && e.altKey && (e.code === 'KeyW')) { e.preventDefault(); setOpen((o) => !o); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  const secret = () => { const t = Date.now(); clicks.current = [...clicks.current.filter((x) => t - x < 2000), t]; if (clicks.current.length >= 5) { clicks.current = []; setOpen((o) => !o); } };
  const set = (p: Record<string, unknown>) => void call('a:watermark:set', p);
  const slider = (label: string, k: 'size' | 'x' | 'y' | 'opacity', min: number, max: number, step: number, unit: string) => wm && (
    <label className="flex items-center gap-2 text-sm"><span className="w-28 text-muted">{label}</span>
      <input type="range" min={min} max={max} step={step} value={wm[k]} onChange={(e) => set({ [k]: Number(e.target.value) })} className="w-56" />
      <span className="w-16 tabular-nums">{k === 'opacity' ? `${Math.round(wm[k] * 100)}%` : `${wm[k]}${unit}`}</span></label>
  );
  return (
    <div className="border-b-2 border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="font-black text-sm text-muted mr-1 select-none cursor-default" onClick={secret}>НА ПРОЕКТОРЕ:</span>
        {SHOW.map(([v, label]) => (
          <button key={v} onClick={() => call('a:display:set', { view: v })}
            className={`h-11 px-4 font-black text-base border-2 ${view === v ? 'bg-warn text-ink border-warn' : 'bg-ink text-snow border-line hover:border-electric'}`}>
            {view === v ? '● ' : ''}{label}
          </button>
        ))}
      </div>
      {open && wm && (
        <div className="flex flex-col gap-2 px-4 pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <strong>Подпись на проекторе</strong>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={wm.on} onChange={(e) => set({ on: e.target.checked })} className="w-5 h-5" /> показывать</label>
            <input defaultValue={wm.text} key={wm.text} onBlur={(e) => e.target.value !== wm.text && set({ text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} className="h-9 bg-ink border-2 border-line px-2 text-sm flex-1 min-w-[16rem]" />
            <select value={wm.corner} onChange={(e) => set({ corner: e.target.value })} className="h-9 bg-ink border-2 border-line px-2 text-sm">
              <option value="br">справа снизу</option><option value="bl">слева снизу</option><option value="tr">справа сверху</option><option value="tl">слева сверху</option>
            </select>
            <button className="h-9 px-3 border-2 border-line text-sm" onClick={() => set({ reset: true })}>Сбросить</button>
            <button className="h-9 px-3 border-2 border-line text-sm" onClick={() => setOpen(false)}>Скрыть</button>
          </div>
          {slider('Размер', 'size', 0.8, 6, 0.1, ' vh')}
          {slider('От края (бок)', 'x', 0, 40, 0.5, ' vw')}
          {slider('От края (верх/низ)', 'y', 0, 40, 0.5, ' vh')}
          {slider('Прозрачность', 'opacity', 0, 1, 0.05, '')}
        </div>
      )}
    </div>
  );
}
