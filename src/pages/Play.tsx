import QuestionImage from '../components/QuestionImage';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { Wifi, WifiOff, LogIn, Loader2, Send, Check, Zap, Lock, Ban, Crown, X, Search, CheckCircle2, Flag, Headphones, School, Hourglass } from 'lucide-react';
import { createSocket } from '../lib/socket';
import type { Age, PublicState } from '../lib/types';
import { DIFFICULTY } from '../lib/difficulty';
import { AGE_COLOR, AGE_LABEL, AGE_SUBTITLE, AGE_TEXT, ageColor, nextLabel } from '../lib/age';

const LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'];
import { fmtSec, useCountdown } from '../lib/util';
type Creds = { team: string; pin: string };
type Mode = 'closed' | 'ready' | 'pending' | 'won' | 'lost' | 'excluded' | 'correct' | 'wrong';

const KEY = 'qa.creds';
const loadCreds = (): Creds | null => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v?.team && v?.pin ? v : null; } catch { return null; }
};
const saveCreds = (c: Creds | null) => {
  try { if (c) localStorage.setItem(KEY, JSON.stringify(c)); else localStorage.removeItem(KEY); } catch { /* ignore */ }
};

/** Цвета состояний: грань кнопки, «боковина» (тень глубины) и подсветка фона. */
const TONE: Record<Mode, { face: string; side: string; glow: string; title: string; icon: typeof Zap }> = {
  closed: { face: '#334155', side: '#1E293B', glow: '#334155', title: 'ЖДИТЕ', icon: Lock },
  ready: { face: '#22C55E', side: '#15803D', glow: '#22C55E', title: 'ЖМИ!', icon: Zap },
  pending: { face: '#EAB308', side: '#A16207', glow: '#EAB308', title: 'ОТПРАВЛЕНО', icon: Loader2 },
  won: { face: '#3B82F6', side: '#1D4ED8', glow: '#3B82F6', title: 'ВЫ ПЕРВЫЕ', icon: Crown },
  lost: { face: '#EF4444', side: '#B91C1C', glow: '#EF4444', title: 'ОПЕРЕДИЛИ', icon: X },
  excluded: { face: '#334155', side: '#1E293B', glow: '#334155', title: 'ВЫ УЖЕ ОТВЕЧАЛИ', icon: Ban },
  correct: { face: '#22C55E', side: '#15803D', glow: '#22C55E', title: 'ВЕРНО!', icon: Check },
  wrong: { face: '#EF4444', side: '#B91C1C', glow: '#EF4444', title: 'НЕВЕРНО', icon: X },
};

function Shell({ glow, children }: { glow: string; children: React.ReactNode }) {
  return (
    <div className="relative h-dvh overflow-hidden bg-ink nosel">
      <div className="absolute inset-0 transition-colors duration-200" style={{ background: `radial-gradient(130% 55% at 50% -5%, ${glow}55, transparent 70%)` }} />
      <div className="absolute inset-0 bg-grid opacity-60" />
      <div className="relative z-10 h-full flex flex-col gap-3 overflow-y-auto px-4 pt-[max(.75rem,env(safe-area-inset-top))] pb-[max(.75rem,env(safe-area-inset-bottom))] max-w-md mx-auto">{children}</div>
    </div>
  );
}

export default function Play() {
  const [conn, setConn] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [state, setState] = useState<PublicState | null>(null);
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [teamInput, setTeamInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null); // последний подтверждённый сервером ответ
  const [sending, setSending] = useState(false);
  const [choice, setChoice] = useState<number | null>(null);
  const [mine, setMine] = useState<{ score: number; age: Age | null } | null>(null);
  const [teamList, setTeamList] = useState<{ id: string; name: string; age: Age | null }[]>([]);
  const seenRef = useRef<string | null>(null);
  const quizIdRef = useRef<string | null>(null);

  const sockRef = useRef<Socket | null>(null);
  const stateRef = useRef<PublicState | null>(null);
  const meRef = useRef(me);
  const pendingRef = useRef<string | null>(null);
  const rttRef = useRef(0);
  // Неотправленный ответ: если связь рвётся в момент отправки, ответ ждёт здесь и уходит сам после переподключения.
  const outboxRef = useRef<{ quizId: string; payload: Record<string, unknown>; label: string } | null>(null);
  const loggedInRef = useRef(false);
  const inFlightRef = useRef(false);
  meRef.current = me;
  pendingRef.current = pending;

  /** Отправить ответ из «исходящих»: ждём подтверждение 6 с, нет — повторим (сервер примет тот же ответ один раз). */
  function flushOutbox() {
    const s = sockRef.current; const ob = outboxRef.current;
    if (!ob || !s?.connected || !loggedInRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    s.timeout(6000).emit('team:answer', ob.payload, (err: Error | null, r: { ok: boolean; reason?: string }) => {
      inFlightRef.current = false;
      if (outboxRef.current !== ob) return;
      if (err) return; // нет ответа сервера — следующая попытка через 3 с или после переподключения
      outboxRef.current = null; setSending(false);
      if (r?.ok) { setSent(ob.label); navigator.vibrate?.(40); }
      else setError(r?.reason === 'inactive_age' ? 'Сейчас играет другая лига. Дождитесь своей очереди.' : r?.reason === 'closed' ? 'Приём ответов закрыт' : r?.reason === 'too_long' ? 'Слишком длинный ответ' : r?.reason === 'already_answered' ? 'Ответ уже отправлен' : 'Не удалось отправить');
    });
  }

  const login = useCallback((creds: Creds, manual = false) => {
    const s = sockRef.current;
    if (!s?.connected) return;
    if (manual) setBusy(true);
    s.emit('team:login', creds, (r: { ok: boolean; error?: string; code?: string; team?: { id: string; name: string }; answer?: string | null }) => {
      setBusy(false);
      if (r?.ok && r.team) {
        saveCreds(creds); setMe(r.team); setError(''); loggedInRef.current = true;
        if (r.answer) { setSent(r.answer); setText((t) => t || r.answer!); outboxRef.current = null; setSending(false); }
        else flushOutbox();
      }
      else {
        setMe(null);
        if (manual || r?.code === 'disabled' || r?.error === 'Неверная команда или PIN') saveCreds(null);
        setError(r?.error || 'Не удалось войти');
      }
    });
  }, []);

  useEffect(() => {
    // автологин по ссылке /play?t=<id|name>&p=<pin> (удобно для демо)
    const q = new URLSearchParams(location.search);
    if (q.get('t') && q.get('p')) {
      saveCreds({ team: q.get('t')!, pin: q.get('p')! });
      history.replaceState(null, '', location.pathname);
    }
    const s = createSocket();
    sockRef.current = s;
    const loadTeams = () => { fetch('/api/teams').then((r) => r.json()).then(setTeamList).catch(() => {}); };
    s.on('connect', () => {
      setConn('online');
      loadTeams();
      const c = loadCreds();
      if (c) login(c);
    });
    s.on('disconnect', () => { setConn('offline'); loggedInRef.current = false; inFlightRef.current = false; });
    s.on('connect_error', () => setConn('offline'));
    s.io.on('reconnect_attempt', () => setConn('connecting'));
    s.on('state', (st: PublicState) => {
      if (st.quiz.id !== quizIdRef.current) { quizIdRef.current = st.quiz.id; setText(''); setSent(null); setChoice(null); }
      // вопрос сменился — неотправленный ответ к старому вопросу больше не нужен
      if (outboxRef.current && outboxRef.current.quizId !== st.quiz.id) { outboxRef.current = null; setSending(false); setError('Предыдущий ответ не подтверждён сервером. Обратитесь к ведущему.'); }
      stateRef.current = st; setState(st);
    });
    s.on('me', (m: { score: number; age: Age | null }) => setMine(m));
    s.on('kicked', (k: { reason: string }) => {
      if (k.reason === 'reset') { setTimeout(() => s.connect(), 300); return; }
      setMe(null);
      if (k.reason === 'replaced') setError('Эта команда подключилась с другого устройства');
      else if (k.reason === 'disabled') { saveCreds(null); setError('Команда отключена организатором'); }
      else if (k.reason === 'deleted') { saveCreds(null); setError('Команда удалена'); }
      else if (k.reason === 'tournament') { saveCreds(null); setError('Турнир изменился — выберите команду и войдите заново'); }
      else if (k.reason === 'pin') { saveCreds(null); setError('PIN изменён — войдите заново'); }
      // после сброса данных входа переподключаемся «гостем» и обновляем список команд (при 'replaced' не переподключаемся: иначе два устройства будут выбивать друг друга)
      if (['tournament', 'pin', 'deleted', 'disabled'].includes(k.reason)) setTimeout(() => { loadTeams(); s.connect(); }, 600);
    });
    const retry = setInterval(() => flushOutbox(), 3000);
    const ping = setInterval(() => {
      if (!s.connected) return;
      const t0 = performance.now();
      s.emit('sys:ping', { rtt: rttRef.current }, () => { rttRef.current = Math.round(performance.now() - t0); setRtt(rttRef.current); });
    }, 3000);
    const vis = () => { if (document.visibilityState === 'visible' && !s.connected) s.connect(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('online', vis);
    return () => {
      clearInterval(ping); clearInterval(retry);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('online', vis);
      s.close();
    };
  }, [login]);

  // экран не гаснет
  useEffect(() => {
    if (!me) return;
    let lock: { release: () => Promise<void> } | null = null;
    const req = async () => {
      try { lock = await (navigator as never as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request('screen'); } catch { /* не поддерживается */ }
    };
    req();
    const v = () => { if (document.visibilityState === 'visible') req(); };
    document.addEventListener('visibilitychange', v);
    return () => { document.removeEventListener('visibilitychange', v); lock?.release().catch(() => {}); };
  }, [me]);

  // Сообщаем серверу, что вопрос показан на экране: так считается задержка доставки.
  const quizIdNow = state?.quiz.id ?? null;
  const quizOpenNow = state?.quiz.status === 'open';
  useEffect(() => {
    if (!me || !quizIdNow || !quizOpenNow || seenRef.current === quizIdNow) return;
    seenRef.current = quizIdNow;
    sockRef.current?.emit('team:seen', { quizId: quizIdNow });
  }, [me, quizIdNow, quizOpenNow]);

  // режим кнопки выводится только из состояния сервера + локального "ожидание"
  let mode: Mode = 'closed';
  if (state && me) {
    if (state.status === 'open') mode = state.excluded.includes(me.id) ? 'excluded' : pending === state.roundId ? 'pending' : 'ready';
    else if (state.status === 'buzzed') mode = state.answerer?.id === me.id ? 'won' : 'lost';
    else if (state.status === 'judged' && state.verdict?.teamId === me.id) mode = state.verdict.correct ? 'correct' : 'wrong';
  }

  const prevMode = useRef<Mode>('closed');
  useEffect(() => {
    if (mode === 'won' && prevMode.current !== 'won') navigator.vibrate?.([70, 40, 70]);
    prevMode.current = mode;
  }, [mode]);

  const buzz = () => {
    const s = sockRef.current; const st = stateRef.current;
    if (!s?.connected || !st || st.status !== 'open' || !meRef.current) return;
    if (st.tournament.ageMode && myAge !== st.tournament.age) return;
    if (st.excluded.includes(meRef.current.id) || pendingRef.current === st.roundId) return;
    pendingRef.current = st.roundId;
    setPending(st.roundId);
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    s.emit('team:buzz', { roundId: st.roundId, nonce }, (r: { ok: boolean; result: string; reason?: string }) => {
      if (r?.result === 'first') navigator.vibrate?.(60);
      else if (!r?.ok && r?.reason !== 'late') setPending(null);
    });
  };

  const submitAnswer = () => {
    const s = sockRef.current; const st = stateRef.current;
    if (!st || st.quiz.status !== 'open' || st.quiz.reading || sending || !s) return;
    if (st.tournament.ageMode && myAge !== st.tournament.age) return;
    const opts = st.quiz.options;
    let payload: Record<string, unknown>; let label: string;
    if (opts.length) {
      if (choice === null) return;
      payload = { quizId: st.quiz.id, choice }; label = `${LETTERS[choice]}) ${opts[choice]}`;
    } else {
      const v = text.trim();
      if (!v) return;
      payload = { quizId: st.quiz.id, text: v }; label = v;
    }
    setSending(true); setError('');
    outboxRef.current = { quizId: st.quiz.id!, payload, label };
    flushOutbox();
  };

  const cd = useCountdown(state?.timer ?? null, state?.t ?? 0);
  const myAge = mine?.age ?? teamList.find((t) => t.id === me?.id)?.age ?? null;
  const [filter, setFilter] = useState('');
  // Турнир ещё не начался: первый вопрос, ни раунда, ни автопроведения.
  // (question > 1 отличает «между вопросами» от «до старта» — иначе после «Дальше» телефоны
  // на секунду показывали бы «турнир ещё не начался».)
  const notStarted = !!state && state.tournament.question === 1
    && !state.auto.running && !state.auto.finished
    && state.quiz.status === 'idle' && state.status === 'idle' && !state.roundId;

  // Во время чтения вопроса поле ответа скрыто. Когда приём реально открывается — короткая
  // вибрация: капитан понимает, что уже можно писать, не глядя на таймер. Работает и когда
  // чтение выключено (тогда приём открывается сразу с показом вопроса).
  const prevAnswerableRef = useRef(false);
  useEffect(() => {
    const answerable = !!(state && state.quiz.status === 'open' && !state.quiz.reading);
    if (answerable && !prevAnswerableRef.current) navigator.vibrate?.([35, 55, 35]);
    prevAnswerableRef.current = answerable;
  }, [state]);

  const ConnPill = (
    <span className={`inline-flex items-center gap-1.5 px-2.5 h-8 border-2 text-xs font-black tabular-nums ${conn === 'online' ? (rtt !== null && rtt > 400 ? 'border-warn text-warn' : 'border-go/70 text-go') : conn === 'connecting' ? 'border-warn text-warn' : 'border-danger text-danger'}`}>
      {conn === 'online' ? <Wifi size={14} strokeWidth={3} /> : conn === 'connecting' ? <Loader2 size={14} className="animate-spin" /> : <WifiOff size={14} strokeWidth={3} />}
      {conn === 'online' ? (rtt !== null ? `${rtt} мс` : 'ОК') : conn === 'connecting' ? 'ПОДКЛ.' : 'НЕТ СВЯЗИ'}
    </span>
  );

  const Timer = cd ? (
    <div className="shrink-0 w-24 text-right">
      <div className={`num tabular-nums leading-none text-5xl ${cd.sec <= 5 ? 'text-danger blink' : cd.sec <= 10 ? 'text-warn' : 'text-snow'}`}>{fmtSec(cd.sec)}</div>
      <div className="h-1.5 mt-1.5 bg-ink border border-line"><div className={`h-full ${cd.sec <= 5 ? 'bg-danger' : cd.sec <= 10 ? 'bg-warn' : 'bg-electric'}`} style={{ width: `${cd.frac * 100}%` }} /></div>
    </div>
  ) : null;

  const Head = me && (
    <header className="flex items-center gap-3">
      <div className="w-11 h-11 shrink-0 border-2 border-snow flex items-center justify-center brutal font-black text-2xl"
        style={{ background: myAge ? AGE_COLOR[myAge] : '#3B82F6', color: myAge ? AGE_TEXT[myAge] : '#FFFFFF' }}>{me.name.trim().charAt(0).toUpperCase()}</div>
      <div className="min-w-0 flex-1">
        <div className="brutal font-black text-xl leading-none truncate">{me.name}</div>{myAge && <span className="phone-age-badge" style={{ background: `${AGE_COLOR[myAge]}22`, color: AGE_COLOR[myAge], borderColor: `${AGE_COLOR[myAge]}66` }}>{AGE_LABEL[myAge]} · {AGE_SUBTITLE[myAge]}</span>}
        <div className="caps text-[10px] font-black text-muted mt-1 truncate">Раунд {state?.tournament.round} · Вопрос {state?.tournament.question}</div>
      </div>
      {ConnPill}
    </header>
  );

  // Очки команды на телефоне не показываем: счёт и места участники узнают только на награждении.
  const Tiles = (
    <div className="grid grid-cols-1 gap-2">
      <div className="bg-panel/90 border-2 border-snow/20 px-2.5 py-1.5 min-w-0">
        <div className="caps text-[9px] font-black text-muted">За этот вопрос</div>
        <div className="num text-3xl leading-tight tabular-nums">{state && state.quiz.status !== 'idle' ? (state.quiz.points ?? state.points.correct) : '—'}</div>
      </div>
    </div>
  );

  // ---------- вход ----------
  if (!me) {
    const list = teamList.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()));
    return (
      <div className="relative min-h-dvh bg-ink">
        <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 50% at 50% -5%, #3B82F655, transparent 70%)' }} />
        <div className="absolute inset-0 bg-grid opacity-60" />
        <div className="relative z-10 min-h-dvh flex flex-col gap-5 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] max-w-md mx-auto">
          <div className="flex items-center justify-between">
            <span className="caps text-[10px] font-black text-muted">Интеллектуальный турнир</span>
            {ConnPill}
          </div>
          <div>
            <h1 className="brutal font-black leading-[.82]" style={{ fontSize: 'min(5.2rem, 9.5dvh)' }}>QUIZ<br /><span className="text-electric">ARENA</span></h1>
            <div className="h-2 w-28 bg-electric mt-4" />
          </div>

          <form className="flex flex-col gap-5 flex-1" onSubmit={(e) => { e.preventDefault(); login({ team: teamInput.trim(), pin: pinInput.trim() }, true); }}>
            <section>
              <div className="flex items-baseline justify-between mb-2">
                <div className="caps text-xs font-black"><span className="text-electric">01</span> · Ваша команда</div>
                <div className="text-[11px] text-muted">{teamList.length ? `${teamList.length} в списке` : ''}</div>
              </div>
              <div className="relative mb-2">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Поиск по названию" autoComplete="off"
                  className="w-full h-11 bg-panel border-2 border-line pl-9 pr-3 outline-none focus:border-electric" />
              </div>
              <div className="max-h-[34dvh] overflow-y-auto grid grid-cols-2 gap-2 pr-0.5">
                {list.map((t) => (
                  <button type="button" key={t.id} onClick={() => { setTeamInput(t.name); setError(''); }}
                    className={`h-12 px-2.5 text-left font-black text-sm leading-tight border-2 border-l-[8px] flex items-center justify-between gap-1 ${teamInput === t.name ? 'bg-electric border-snow text-white' : 'bg-panel border-line active:border-electric'}`}
                    style={{ borderLeftColor: ageColor(t.age, teamInput === t.name ? '#F8FAFC' : '#3A486B') }}>
                    <span className="line-clamp-2 break-words">{t.name}</span>{teamInput === t.name && <Check size={16} strokeWidth={3} />}
                  </button>
                ))}
                {list.length === 0 && <div className="col-span-2 text-sm text-muted py-4 text-center">{teamList.length ? 'Ничего не найдено' : conn === 'online' ? 'Команд пока нет — обратитесь к ведущему' : 'Список появится после подключения'}</div>}
              </div>
            </section>

            <section>
              <div className="caps text-xs font-black mb-2"><span className="text-electric">02</span> · PIN-код</div>
              <input value={pinInput} onChange={(e) => { setPinInput(e.target.value); setError(''); }} inputMode="numeric" autoComplete="off" type="password" placeholder="••••" maxLength={12}
                className="w-full h-16 bg-panel border-2 border-line text-center text-4xl font-black tracking-[.5em] outline-none focus:border-electric" />
            </section>

            {error && <div className="bg-danger/15 border-2 border-danger text-danger px-4 py-3 text-sm font-bold">{error}</div>}
            {conn !== 'online' && <div className="border-2 border-line bg-panel/80 p-3 text-xs text-muted leading-relaxed">Нет связи с сервером. Телефон должен быть в той же Wi-Fi сети, что и ноутбук ведущего.</div>}

            <button disabled={conn !== 'online' || busy || !teamInput || !pinInput}
              className="hard mt-auto h-16 bg-electric text-white font-black uppercase tracking-wide text-xl flex items-center justify-center gap-2 border-2 border-ink disabled:opacity-40">
              {busy ? <Loader2 className="animate-spin" size={22} /> : <LogIn size={22} strokeWidth={3} />} Подключиться
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ---------- турнир ещё не начался ----------
  if (notStarted) {
    return (
      <Shell glow="#3B82F6">
        {Head}
        <div className="phone-age-wait">
          {/* вместо иконки сюда потом можно поставить логотип школы */}
          <div className="phone-lock-icon"><School size={40} /></div>
          <span className="phone-blocked-label">Турнир ещё не начался</span>
          <h1>{state!.tournament.name}</h1>
          <p>Ведущий начнёт игру — экран обновится сам.</p>
        </div>
      </Shell>
    );
  }

  // ---------- чужая лига: ждём очередь или готовимся ----------
  if (state?.tournament.ageMode && myAge !== state.tournament.age) {
    const ended = state.auto.finished || ['closing', 'reveal', 'leaderboard', 'final'].includes(state.displayView);
    const prep = !!myAge && state.auto.nextAge === myAge; // следующий вопрос — нашей лиги
    const pauseLeft = prep && cd && state.timer?.kind === 'pause' ? cd.sec : null;
    return (
      <Shell glow={myAge ? AGE_COLOR[myAge] : '#334155'}>
        {Head}
        <div className="phone-age-wait">
          <div className="phone-lock-icon" style={{ borderColor: myAge ? `${AGE_COLOR[myAge]}55` : undefined }}>
            {ended ? <Flag size={40} /> : pauseLeft !== null ? <span className="num tabular-nums text-3xl font-black">{fmtSec(pauseLeft)}</span> : prep ? <Hourglass size={40} /> : <Lock size={40} />}
          </div>
          <span className="phone-blocked-label">{ended ? 'Турнир завершён' : prep ? 'Подготовка' : 'Ответы заблокированы'}</span>
          <h1>{ended ? <>Итоги объявляет<br />ведущий</> : prep ? (pauseLeft !== null ? <>Ваш вопрос<br />через {fmtSec(pauseLeft)}</> : <>Ваш вопрос<br />следующий</>) : <>Ждите своей<br />очереди</>}</h1>
          <p className="phone-wait-hint">{ended
            ? 'Смотрите на большой экран — скоро объявят победителей.'
            : !myAge ? 'Попросите ведущего указать возраст вашей команды.'
            : prep ? 'Приготовьтесь — вопрос откроется на этом экране сам, как только закончится ход другой лиги.'
            : 'Сейчас играет другая лига. Ваш вопрос откроется на этом экране сам — лиги отвечают по очереди.'}</p>
        </div>
      </Shell>
    );
  }
  // ---------- письменный ответ ----------
  if (state && state.quiz.status !== 'idle') {
    const q = state.quiz; const isOpen = q.status === 'open'; const reading = isOpen && !!q.reading;
    const locked = !isOpen || sent !== null;
    return (
      <Shell glow={sent !== null ? '#22C55E' : isOpen ? '#3B82F6' : '#334155'}>
        {Head}
        {state.auto.running && state.auto.phase === 'pause' && (
          <div className="bg-warn text-ink font-black caps px-3 py-3 flex items-center gap-3">
            <Lock size={26} strokeWidth={3} />
            <div className="flex-1 leading-tight">Пауза<div className="text-[10px] opacity-80">{nextLabel(state.auto)}</div></div>
            {cd && <span className="brutal text-4xl tabular-nums">{fmtSec(cd.sec)}</span>}
          </div>
        )}
        <div className="flex items-stretch gap-3 shrink-0">
          <div className={`flex-1 min-w-0 bg-panel/95 border-2 border-snow/25 border-l-[10px] border-l-electric p-3.5 overflow-y-auto ${q.image ? 'max-h-[48dvh]' : 'max-h-[32dvh]'}`} style={{ borderLeftColor: myAge ? AGE_COLOR[myAge] : undefined }}>
            <div className="caps text-[10px] font-black text-electric mb-1">Вопрос {state.tournament.question} · блок {q.block}{q.difficulty ? ` · ${{ easy: 'лёгкий', medium: 'средний', hard: 'сложный' }[q.difficulty]}` : ''}{q.points != null ? ` · ${q.points} б.` : ''}</div>
            <div className="text-xl font-extrabold leading-snug">{q.question || 'Вопрос задаёт ведущий'}</div>
            {q.image && <div className="mt-3"><QuestionImage src={q.image} className="w-full max-h-[26dvh]" zoom /></div>}
          </div>
          {state.auto.phase !== 'pause' && !reading && Timer}
        </div>

        {sent !== null ? (
          <div className="flex-1 bg-go/15 border-2 border-go flex flex-col items-center justify-center text-center p-5 gap-3">
            <div className="w-20 h-20 bg-go text-ink flex items-center justify-center"><Check size={52} strokeWidth={4} /></div>
            <div className="brutal font-black text-3xl text-go">ОТВЕТ ПРИНЯТ</div>
            <div className="text-lg font-bold break-words max-w-full">«{sent}»</div>
            <div className="text-xs text-muted">Изменить ответ нельзя. Ждите результата.</div>
          </div>
        ) : reading ? (
          <div className="flex-1 min-h-[15rem] flex flex-col items-center justify-center text-center gap-4 bg-electric/10 border-2 border-electric px-5 py-6 relative overflow-hidden">
            <div className="absolute inset-0 bg-grid opacity-40" />
            <div className="relative w-36 h-36 flex items-center justify-center text-electric">
              <span className="ring" style={{ width: '9rem', height: '9rem' }} />
              <Headphones size={64} strokeWidth={2.5} />
            </div>
            <div className="relative brutal font-black text-3xl leading-none text-snow">СЛУШАЙТЕ ВОПРОС</div>
            <p className="relative text-sm font-bold text-muted leading-snug max-w-[17rem]">Ведущий читает вслух.<br />Поле ответа появится, когда начнётся отсчёт.</p>
            {cd && (
              <div className="relative flex flex-col items-center gap-1">
                <span className="caps text-[10px] font-black text-muted">До начала приёма</span>
                <span className={`num tabular-nums leading-none text-5xl ${cd.sec <= 5 ? 'text-warn blink' : 'text-snow'}`}>{fmtSec(cd.sec)}</span>
              </div>
            )}
            {cd && <div className="relative w-full max-w-[17rem] h-2 border-2 border-line bg-ink"><div className="h-full bg-electric transition-[width] duration-200" style={{ width: `${cd.frac * 100}%` }} /></div>}
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-2 min-h-0">
            {q.options.length > 0 ? (
              <>
                <div className="caps text-[10px] font-black text-muted">Выберите вариант ответа</div>
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
                  {q.options.map((o, i) => (
                    <button key={i} disabled={locked} onClick={() => { setChoice(i); setError(''); }}
                      className={`min-h-14 flex-1 max-h-24 flex items-center gap-3 px-3 text-left border-2 font-bold text-lg leading-tight disabled:opacity-60 ${choice === i ? 'bg-electric border-snow text-white' : 'bg-panel border-line active:border-electric'}`}>
                      <span className={`shrink-0 w-10 h-10 flex items-center justify-center brutal font-black text-2xl ${choice === i ? 'bg-white text-electric' : 'bg-ink text-snow border-2 border-line'}`}>{LETTERS[i]}</span>
                      <span className="break-words">{o}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-between caps text-[10px] font-black text-muted"><span>Ответ команды</span><span className="tabular-nums">{text.length} / 300</span></div>
                <textarea value={text} onChange={(e) => { setText(e.target.value); setError(''); }} disabled={locked} maxLength={300}
                  placeholder={isOpen ? 'Введите ответ…' : 'Приём ответов закрыт'}
                  className="flex-1 min-h-24 bg-panel border-2 border-line p-4 text-2xl font-bold outline-none focus:border-electric disabled:opacity-60 resize-none" />
              </>
            )}
            {error && <div className="text-danger text-sm font-bold">{error}</div>}
            {isOpen && <div className="text-[11px] text-muted">Отправить можно только один раз — проверьте ответ перед отправкой.</div>}
            {!isOpen && <div className="bg-danger/15 border-2 border-danger text-danger px-3 py-2 text-sm font-bold">Время вышло — ответ не отправлен</div>}
            <button onClick={submitAnswer}
              disabled={!isOpen || (q.options.length ? choice === null : !text.trim()) || sending}
              className="hard h-16 border-2 border-ink bg-go text-ink font-black uppercase text-lg flex items-center justify-center gap-2 disabled:opacity-40">
              {sending ? <Loader2 className="animate-spin" size={22} /> : <Send size={22} strokeWidth={3} />} {sending ? (conn === 'online' ? 'Отправляем…' : 'Ждём связь…') : 'Отправить ответ'}
            </button>
            {sending && conn !== 'online' && <div className="text-warn text-sm font-bold">Связь пропала. Ответ ожидает отправки. Не закрывайте страницу: после восстановления связи телефон попробует отправить его, пока идёт этот вопрос.</div>}
          </div>
        )}
        {Tiles}
      </Shell>
    );
  }

  // ---------- кнопка ----------
  const pause = !!state && state.auto.running && state.auto.phase === 'pause';
  const blockBreak = !!state && state.auto.running && state.auto.phase === 'blockbreak';
  const closing = !!state && ['closing', 'reveal', 'leaderboard', 'final'].includes(state.displayView) && state.quiz.status === 'idle' && state.status !== 'open';
  const neutral = blockBreak || closing;
  const tn = pause || neutral ? TONE.closed : TONE[mode];
  const Icon = blockBreak ? CheckCircle2 : closing ? Flag : pause ? Lock : tn.icon;
  const sub =
    blockBreak ? 'Результаты сохранены. Ждите следующий блок' :
    closing ? (state!.displayView === 'closing' ? 'Подводим итоги' : 'Результаты объявляет ведущий — смотрите на большой экран') :
    pause ? nextLabel(state!.auto) :
    mode === 'lost' ? `Первой нажала: ${state?.answerer?.name ?? ''}` :
    mode === 'correct' ? `${state!.verdict!.points >= 0 ? '+' : ''}${state!.verdict!.points} баллов` :
    mode === 'wrong' ? 'Ответ не засчитан' :
    mode === 'won' ? 'Отвечайте ведущему' :
    mode === 'ready' ? 'Первый нажавший отвечает' :
    mode === 'pending' ? 'Ждём подтверждения сервера' :
    mode === 'excluded' ? 'Ждите следующего вопроса' :
    state?.status === 'judged' && state.verdict?.correct ? `Ответ принят у: ${state.verdict.name}` :
    state?.status === 'locked' ? 'Приём закрыт' : 'Вопрос появится на этом экране';
  const headline = blockBreak ? `БЛОК ${state!.auto.doneBlock ?? ''} ЗАВЕРШЁН` : closing ? 'КВИЗ ЗАВЕРШЁН' : pause ? 'ПАУЗА' : mode === 'closed' && state?.status === 'judged' ? 'РАУНД ЗАВЕРШЁН' : tn.title;
  // размер заголовка подбирается по самому длинному слову, чтобы оно не рвалось
  const longest = Math.max(...(conn === 'online' ? headline : 'СВЯЗЬ ПОТЕРЯНА').split(' ').map((w) => w.length));
  const avail = Math.min(window.innerWidth, 448) - 32 - (cd ? 108 : 0);
  const headSize = Math.round(Math.min(44, Math.max(24, avail / (longest * 0.76))));

  return (
    <Shell glow={tn.glow}>
      {Head}
      {state?.questionMeta?.difficulty && <div className="difficulty-chip self-start" style={{ color: DIFFICULTY[state.questionMeta.difficulty].color }}>{DIFFICULTY[state.questionMeta.difficulty].label} · {state.questionMeta.points} балл.</div>}
      <div className="flex items-end justify-between gap-3 min-h-[5.5rem]">
        <div className="min-w-0">
          <div key={mode} className="pop brutal font-black leading-[.92]" style={{ fontSize: headSize, overflowWrap: 'normal', color: mode === 'closed' || mode === 'excluded' || neutral || pause ? '#F8FAFC' : tn.face }}>{conn === 'online' ? headline : 'СВЯЗЬ ПОТЕРЯНА'}</div>
          <div className="text-sm font-semibold text-muted mt-1.5">{conn === 'online' ? sub : 'Переподключаемся…'}</div>
        </div>
        {Timer}
      </div>

      <div className={`key flex-1 min-h-[14rem] mb-3 ${conn !== 'online' ? 'opacity-50' : ''}`} style={{ ['--side' as string]: tn.side }}>
        <button
          onPointerDown={(e) => { e.preventDefault(); buzz(); }}
          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); buzz(); } }}
          aria-label="BUZZ"
          className={`key-face w-full h-full flex flex-col items-center justify-center gap-2 text-white outline-none ${mode === 'ready' ? 'ready-glow' : ''}`}
          style={{ background: `linear-gradient(180deg, ${tn.face} 0%, ${tn.face} 100%)`, ['--face' as string]: tn.face }}
        >
          <span key={mode} className="pop flex flex-col items-center gap-2">
            <Icon size={mode === 'ready' ? 84 : 110} strokeWidth={mode === 'ready' ? 3 : 2.5} className={mode === 'pending' ? 'animate-spin' : ''} />
            {mode === 'ready' && <span className="brutal font-black leading-none" style={{ fontSize: 'clamp(4.5rem, 24vw, 7.5rem)' }}>BUZZ</span>}
          </span>
        </button>
      </div>

      {Tiles}
    </Shell>
  );
}
