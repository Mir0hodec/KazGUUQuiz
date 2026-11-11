import Awards from '../components/Awards';
import QuestionImage from '../components/QuestionImage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Volume2, VolumeX, Check, X, Radio, Lock, Crown, Flag, CheckCircle2, Maximize, Minimize } from 'lucide-react';
import { createSocket } from '../lib/socket';
import { useSounds } from '../lib/sounds';
import { fmtSec, useCountdown, useJoinBase, useQr } from '../lib/util';
import type { BoardRow, PublicState, RevealState } from '../lib/types';
import { AGE_COLOR, AGE_LABEL, AGE_TEXT, ageColor, nextLabel } from '../lib/age';

function useBeep() {
  const ctx = useRef<AudioContext | null>(null);
  const [on, setOn] = useState(false);
  const enable = () => {
    try {
      ctx.current ??= new (window.AudioContext || (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      void ctx.current.resume();
      setOn(true);
    } catch { /* нет звука */ }
  };
  useEffect(() => {
    const h = () => enable();
    window.addEventListener('pointerdown', h, { once: true });
    window.addEventListener('keydown', h, { once: true });
    return () => { window.removeEventListener('pointerdown', h); window.removeEventListener('keydown', h); };
  }, []);
  const tone = (freqs: number[], dur = 0.14, type: OscillatorType = 'sine') => {
    const c = ctx.current;
    if (!c || c.state !== 'running') return;
    freqs.forEach((f, i) => {
      const o = c.createOscillator(); const g = c.createGain();
      const t0 = c.currentTime + i * dur;
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02);
    });
  };
  return { on, enable, tone };
}

/** Полноэкранный режим проектора: браузер разрешает его только после клика или нажатия клавиши. */
function useFullscreen() {
  const [full, setFull] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const h = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  const enter = () => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {}); };
  const toggle = () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else enter(); };
  return { full, enter, toggle };
}

const CONFETTI_COLORS = ['#3B82F6', '#22C55E', '#F8FAFC', '#EAB308', '#EF4444'];

/** Разовый салют из квадратов (CSS-only, без бесконечной анимации). */
function Confetti({ n = 40 }: { n?: number }) {
  const bits = useMemo(() => Array.from({ length: n }, (_, i) => {
    const a = Math.random() * Math.PI * 2; const d = 25 + Math.random() * 45;
    return { x: `${Math.cos(a) * d}vw`, y: `${Math.sin(a) * d * 0.9 - 8}vh`, r: `${Math.random() * 720 - 360}deg`, c: CONFETTI_COLORS[i % CONFETTI_COLORS.length], delay: `${Math.random() * 0.15}s` };
  }), [n]);
  return (
    <div className="confetti absolute inset-0 pointer-events-none overflow-hidden">
      {bits.map((b, i) => <i key={i} style={{ background: b.c, animationDelay: b.delay, ['--x' as string]: b.x, ['--y' as string]: b.y, ['--r' as string]: b.r }} />)}
    </div>
  );
}

/** Крупный таймер: число + полоса. Последние 5 секунд — красный и мигает. */
function Clock({ s, label, light, size = '14vh', compact = false }: { s: PublicState; label?: string; light?: boolean; size?: string; compact?: boolean }) {
  const c = useCountdown(s.timer, s.t);
  if (!c) return null;
  const urgent = c.sec <= 5;
  return (
    <div className="relative z-[2] flex flex-col items-center" style={{ width: compact ? '100%' : '46vw', marginTop: size === '14vh' ? '4vh' : '1.5vh' }}>
      {label && <div className="caps font-black text-[2.6vh] opacity-80 mb-[.5vh]">{c.ms === 0 ? 'Время вышло' : label}</div>}
      <div className={`num tabular-nums leading-none ${urgent && c.ms > 0 ? 'blink' : ''} ${urgent ? (light ? 'text-warn' : 'text-danger') : ''}`} style={{ fontSize: size }}>{fmtSec(c.sec)}</div>
      <div className={`w-full h-[2vh] mt-[1.5vh] border-2 border-current ${light ? '' : ''}`}>
        <div className={`h-full ${urgent ? (light ? 'bg-warn' : 'bg-danger') : 'bg-current'}`} style={{ width: `${c.frac * 100}%` }} />
      </div>
    </div>
  );
}

function QuestionLine({ text }: { text: string }) {
  return <div className="rise relative z-[2] font-black text-center mt-[3vh] max-w-[80vw] leading-tight" style={{ fontSize: text.length > 120 ? '3.6vh' : text.length > 60 ? '4.8vh' : '6vh' }}>{text}</div>;
}

function Header({ s }: { s: PublicState }) {
  return (
    <div className="absolute top-0 inset-x-0 z-10 flex justify-between items-center px-[3vw] py-[2.2vh] font-black caps text-[2.2vh] mix-blend-normal">
      <span className="flex items-center gap-[1.2vw]"><span className="opacity-80">{s.tournament.name}</span>{s.tournament.ageMode && s.tournament.age && <span className="px-[1.2vw] py-[.6vh] border-2" style={{ background: AGE_COLOR[s.tournament.age], color: AGE_TEXT[s.tournament.age], borderColor: AGE_COLOR[s.tournament.age] }}>{AGE_LABEL[s.tournament.age]}</span>}{s.status === 'open' && s.questionMeta?.difficulty && <span className="border-2 px-[1vw] py-[.4vh]">{DIFF_LABEL[s.questionMeta.difficulty]}</span>}</span>
      <span className="flex gap-[1.2vw] items-center">
        {s.auto.running && <span className="px-[1vw] py-[.4vh] bg-warn text-ink">Авто</span>}
        <span className="px-[1vw] py-[.4vh] border-2 border-current">Раунд {s.tournament.round}</span>
        <span className="px-[1vw] py-[.4vh] border-2 border-current shadow-[.6vh_.6vh_0_0_currentColor]">Вопрос {s.tournament.question}</span>
      </span>
    </div>
  );
}

function AgeLegend({ big = false, board }: { big?: boolean; board?: BoardRow[] }) {
  return (
    <div className="flex gap-[1vw] items-center">
      {(['junior', 'middle', 'senior'] as const).filter(a => !board || board.some(r => r.age === a)).map((a) => (
        <span key={a} className="font-black caps px-[.9vw] py-[.3vh]" style={{ background: AGE_COLOR[a], color: AGE_TEXT[a], fontSize: big ? '2.2vh' : '1.7vh' }}>{AGE_LABEL[a]}</span>
      ))}
    </div>
  );
}

function Leaderboard({ board: full, title = 'LEADERBOARD' }: { board: BoardRow[]; title?: string }) {
  const LIMIT = 30;
  const pages = Math.max(1, Math.ceil(full.length / LIMIT));
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [full.length]);
  useEffect(() => { if (pages <= 1) return; const timer = window.setInterval(() => setPage(p => (p + 1) % pages), 12000); return () => window.clearInterval(timer); }, [pages]);
  const board = full.slice((page % pages) * LIMIT, (page % pages + 1) * LIMIT);
  const rows = Math.min(10, Math.max(board.length, 1));
  const cols = Math.max(1, Math.ceil(board.length / rows));
  const max = Math.max(1, ...board.map((b) => b.score));
  const hasAge = board.some((b) => b.age);
  return (
    <div className="h-full flex flex-col px-[3vw] pt-[4vh] pb-[3vh]">
      <div className="flex items-end justify-between mb-[2vh] border-b-[0.8vh] border-electric pb-[1vh]">
        <h1 className="brutal font-black leading-none" style={{ fontSize: title.length > 18 ? '5.5vh' : '8vh' }}>{title}</h1>
        <div className="flex items-center gap-[2vw]">
          {hasAge && <AgeLegend board={board} />}
          <div className="caps font-black text-muted text-[2.4vh]">{pages > 1 ? `страница ${page % pages + 1} из ${pages} · ${full.length} команд` : `${full.length} команд`}</div>
        </div>
      </div>
      <div className="flex-1 grid gap-x-[2vw] gap-y-[0.9vh]" style={{ gridTemplateRows: `repeat(${rows}, 1fr)`, gridAutoFlow: 'column', gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {board.map((r, i) => (
          <div key={r.id} className={`rise relative overflow-hidden flex items-center gap-[1vw] px-[1vw] border-l-[1.4vh] ${r.rank === 1 ? 'bg-electric' : 'bg-panel'}`}
            style={{ animationDelay: `${i * 18}ms`, borderLeftColor: ageColor(r.age, r.rank === 1 ? '#F8FAFC' : '#3A486B') }}>
            <div className="absolute inset-y-0 left-0 bg-white/10 transition-[width] duration-700" style={{ width: `${Math.max(0, r.score) / max * 100}%` }} />
            <span className="relative w-[3.4vw] text-center font-black text-[3.6vh] tabular-nums">{r.rank}</span>
            <span className="relative flex-1 truncate font-bold text-[3.4vh]">{r.name}</span>
            <span className="relative font-black text-[4.2vh] tabular-nums brutal">{r.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const shownNames = (g: { name: string }[]) => g.slice(0, 3).map((x) => x.name);

function Final({ board, title = 'ИТОГИ ТУРНИРА' }: { board: BoardRow[]; title?: string }) {
  // группы по месту: при ничьей на одном месте может быть несколько команд
  const groups: BoardRow[][] = [];
  for (const r of board) { const g = groups[groups.length - 1]; if (g && g[0].rank === r.rank) g.push(r); else groups.push([r]); }
  const first = groups.find(g => g[0].rank === 1);
  const second = groups.find(g => g[0].rank === 2);
  const third = groups.find(g => g[0].rank === 3);
  const rest = board.filter((b) => b.rank > 3).slice(0, 6);
  const column = (g: BoardRow[] | undefined, place: number, h: string, color: string, delay: string) => {
    if (!g) return null;
    const big = place === 1;
    const shown = g.slice(0, 3);
    // размер имени зависит и от ширины колонки: на проекторе 4:3 длинные названия иначе обрезались
    const longest = Math.max(...shownNames(g).map((n) => n.length), 6);
    const nameSize = `min(${big ? (g.length === 1 ? 7 : 4.8) : (g.length === 1 ? 4.6 : 3.4)}vh, ${((big ? 33 : 26) / longest).toFixed(2)}vw)`;
    return (
      <div className="flex flex-col justify-end items-center w-[29vw] min-h-0 rise" style={{ animationDelay: delay }}>
        {big && <Crown className="text-warn shrink-0 mb-[.5vh]" size="7vh" strokeWidth={2.5} />}
        <div className="min-h-0 overflow-hidden flex flex-col items-center justify-end w-full text-center brutal font-black leading-[1.02] mb-[.8vh]" style={{ fontSize: nameSize }}>
          {shown.map((x) => (
            <div key={x.id} className="truncate max-w-full flex items-center justify-center gap-[.6vw]">
              {x.age && <i className="shrink-0 inline-block" style={{ width: '.9em', height: '.9em', background: AGE_COLOR[x.age] }} />}
              <span className="truncate">{x.name}</span>
            </div>
          ))}
          {g.length > shown.length && <div className="text-muted" style={{ fontSize: '0.7em' }}>+ ещё {g.length - shown.length}</div>}
        </div>
        <div className={`num tabular-nums shrink-0 mb-[.6vh] ${big ? 'text-[5vh] text-warn' : 'text-[3.6vh] text-muted'}`}>{g[0].score}</div>
        <div className={`w-full shrink-0 ${color} border-2 border-snow flex items-start justify-center brutal font-black text-ink`}
          style={{ height: h, fontSize: '9vh', transformOrigin: 'bottom', animation: 'growY .7s cubic-bezier(.2,.9,.2,1) both', animationDelay: delay }}>
          <span className="mt-[.5vh] leading-none">{g[0].rank}</span>
        </div>
      </div>
    );
  };
  return (
    <div className="h-full relative grid grid-rows-[auto_minmax(0,1fr)_auto] gap-[1.5vh] px-[3vw] pt-[3vh] pb-[3vh] overflow-hidden">
      <Confetti n={60} />
      <div className="brutal caps font-black text-[3.6vh] text-warn tracking-[0.3em] text-center">Итоги турнира</div>
      <div className="min-h-0 flex items-stretch justify-center gap-[1.5vw]">
        {column(second, 2, '17vh', 'bg-snow', '.25s')}
        {column(first, 1, '24vh', 'bg-warn', '0s')}
        {column(third, 3, '11vh', 'bg-electric', '.4s')}
      </div>
      {rest.length > 0 && (
        <div className="grid grid-cols-3 gap-x-[1.5vw] gap-y-[.6vh] w-full">
          {rest.map((r) => (
            <div key={r.id} className="flex items-center gap-[1vw] bg-panel border-l-[1vh] border-line px-[1vw] py-[.4vh]">
              <span className="w-[2.6vw] font-black text-[2.6vh] text-center">{r.rank}</span>
              <span className="flex-1 truncate font-bold text-[2.6vh]">{r.name}</span>
              <span className="font-black text-[2.8vh] tabular-nums">{r.score}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Options({ options, compact = false }: { options: string[]; compact?: boolean }) {
  const size = compact ? '2.4vh' : options.length > 4 ? '3.2vh' : '3.8vh';
  return (
    <div className="grid grid-cols-2 gap-x-[1.5vw] gap-y-[1vh] mt-[2vh] relative z-[2]" style={{ width: compact ? '100%' : '80vw' }}>
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-[1vw] bg-white/12 border-2 border-white/40 px-[1vw] py-[.7vh] text-left rise" style={{ animationDelay: `${i * 60}ms`, fontSize: size }}>
          <span className="shrink-0 w-[1.6em] h-[1.6em] flex items-center justify-center bg-white text-electric font-black brutal">{['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'][i]}</span>
          <span className={compact ? "font-bold break-words min-w-0" : "font-bold truncate"}>{o}</span>
        </div>
      ))}
    </div>
  );
}

const DIFF_LABEL = { easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный' } as const;
const pointsWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'балл' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'балла' : 'баллов');

/** Нейтральный экран: ни мест, ни баллов — только факт завершения. */
function Neutral({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="h-full relative flex flex-col items-center justify-center text-center px-[5vw] bg-panel">
      <div className="text-electric pop">{icon}</div>
      <div className="brutal slam font-black leading-[.92] text-snow mt-[2vh]" style={{ fontSize: title.length > 16 ? '11vh' : '14vh' }}>{title}</div>
      <div className="caps font-black text-[4vh] mt-[3vh] text-white/75 rise">{sub}</div>
    </div>
  );
}

/** Последовательное объявление мест: от последнего к первому (или только тройка). */
function Reveal({ rv, tone, title }: { rv: RevealState; tone: (f: number[], d?: number, t?: OscillatorType) => void; title?: string }) {
  const last = rv.rows[rv.rows.length - 1];
  const prevRows = rv.rows.slice(0, -1).slice(-9).reverse();
  const winner = !!last && rv.done && last.rank === 1;
  const lastRank = last?.rank;
  useEffect(() => {
    if (!last) return;
    if (winner) tone([523, 659, 784, 1047], 0.14, 'triangle'); else tone([440, 587], 0.1, 'triangle');
  }, [rv.shown]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!last) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center bg-panel px-[5vw]">
        <Flag size="16vh" className="text-warn pop" strokeWidth={2.5} />
        {title && title.includes(' · ')
          ? <><div className="caps font-black text-warn text-[4.5vh] mt-[2vh]">{title.split(' · ')[0]}</div><div className="brutal slam font-black text-[12vh] leading-[.9] mt-[1vh]">{title.split(' · ').slice(1).join(' · ')}</div></>
          : <div className="brutal slam font-black text-[13vh] leading-[.9] mt-[2vh]">{title || 'ИТОГИ'}</div>}
        <div className="caps font-black text-[4vh] mt-[3vh] text-white/75 rise">{rv.mode === 'top3' ? 'Объявляем тройку призёров' : rv.mode === 'top10' ? 'Объявляем десятку лучших' : `Объявляем места: с ${rv.total}-го до 1-го`}</div>
      </div>
    );
  }
  const col = ageColor(last.age, '#3B82F6');
  const tcol = last.age ? AGE_TEXT[last.age] : '#FFFFFF';
  return (
    <div className="h-full relative grid grid-rows-[minmax(0,1fr)_auto] gap-[2vh] px-[4vw] pt-[5vh] pb-[3vh] overflow-hidden">
      {winner && <Confetti n={70} />}
      {title && <div className="absolute top-[2vh] left-0 right-0 text-center caps font-black text-[3.4vh] text-warn">{title}</div>}
      <div className="min-h-0 flex items-center justify-center gap-[3vw]">
        <div className="shrink-0 text-center">
          <div className="caps font-black text-[2.6vh] text-muted">{winner ? 'Победитель' : 'Место'}</div>
          <div className="brutal slam font-black leading-[.85] tabular-nums" style={{ fontSize: '30vh', color: winner ? '#EAB308' : '#F8FAFC' }}>{lastRank}</div>
        </div>
        <div className="min-w-0 flex-1 border-l-[2vh] pl-[3vw] py-[2vh] rise" style={{ borderColor: col }}>
          {winner && <Crown className="text-warn mb-[1vh]" size="9vh" strokeWidth={2.5} />}
          <div className="brutal font-black leading-[.95] break-words" style={{ fontSize: last.name.length > 22 ? '8vh' : '11vh' }}>{last.name}</div>
          <div className="mt-[2vh] flex items-center gap-[2vw]">
            <span className="num tabular-nums text-warn" style={{ fontSize: '10vh' }}>{last.score}</span>
            <span className="caps font-black text-[3vh] text-muted">баллов</span>
            {last.age && <span className="font-black caps px-[1vw] py-[.5vh] text-[2.4vh]" style={{ background: col, color: tcol }}>{AGE_LABEL[last.age]}</span>}
          </div>
        </div>
      </div>
      {prevRows.length > 0 && (
        <div className="grid grid-cols-3 gap-x-[1.5vw] gap-y-[.6vh]">
          {prevRows.map((r) => (
            <div key={r.id} className="flex items-center gap-[1vw] bg-panel border-l-[1vh] px-[1vw] py-[.5vh]" style={{ borderLeftColor: ageColor(r.age) }}>
              <span className="w-[3vw] text-center font-black text-[2.8vh] tabular-nums">{r.rank}</span>
              <span className="flex-1 truncate font-bold text-[2.8vh]">{r.name}</span>
              <span className="font-black text-[3vh] tabular-nums">{r.score}</span>
            </div>
          ))}
        </div>
      )}
      <div className="absolute top-[2vh] right-[3vw] opacity-90"><AgeLegend board={rv.rows} /></div>
    </div>
  );
}

/** Отдельного «старого» экрана QR больше нет: режим 'qr' показывает ту же арену, что и 'start'. */

function Start({ s }: { s: PublicState }) {
  const { base, unreachable } = useJoinBase(s.joinBase, s.tunnel?.url);
  const url = `${base}/play`;
  const qr = useQr(url, '#0B1020', '#FFFFFF');
  const total = s.teamCount;
  const pct = total ? Math.round((s.online / total) * 100) : 0;
  const allIn = total > 0 && s.online >= total;
  const note = !total ? 'Команды ещё не добавлены' : allIn ? 'Все команды на связи — можно начинать' : s.online === 0 ? 'Ждём первых капитанов…' : `Подключилось ${s.online} из ${total}`;
  return (
    <div className="start-screen">
      <div className="start-aurora start-aurora-1" />
      <div className="start-aurora start-aurora-2" />
      <div className="start-aurora start-aurora-3" />
      <div className="start-grid" />
      <div className="start-inner">
        <div className="start-copy">
          <div className="start-kicker"><span className="start-dot" /> Интеллектуальный турнир</div>
          <h1 className="start-title">{s.tournament.name}</h1>
          <p className="start-sub">Капитаны, наведите камеру телефона на QR-код — и ваша команда в игре. Ничего устанавливать не нужно.</p>
          <div className="start-steps">
            <div className="start-step"><b>1</b><span>Наведите камеру на код</span></div>
            <div className="start-step"><b>2</b><span>Выберите свою команду</span></div>
            <div className="start-step"><b>3</b><span>Введите PIN у ведущего</span></div>
          </div>
          <div className="start-url">
            <span>Открыть вручную</span>
            <strong>{url.replace(/^https?:\/\//, '')}</strong>
          </div>
          <div className="start-progress">
            <div className="start-progress-top"><span>Команд на связи</span><b>{s.online}<i> / {total}</i></b></div>
            <div className="start-progress-bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="start-progress-note">{note}</div>
          </div>
        </div>
        <div className="start-qr-wrap">
          <div className="start-qr">
            {qr && !unreachable
              ? <img src={qr} alt="QR" />
              : <div className="start-qr-placeholder">{unreachable ? 'Ноутбук не в Wi-Fi сети — подключите его или используйте интернет-ссылку' : 'Готовим QR-код…'}</div>}
            <span className="start-corner start-corner-tl" />
            <span className="start-corner start-corner-tr" />
            <span className="start-corner start-corner-bl" />
            <span className="start-corner start-corner-br" />
          </div>
          <div className="start-qr-caption">Наведите камеру телефона<small>Выберите команду и введите PIN</small></div>
        </div>
      </div>
      <div className="start-brand">QUIZ <span>ARENA</span> · {unreachable ? 'нет сетевого адреса' : 'локальная сеть · без интернета'}</div>
    </div>
  );
}

function Center({ icon, label, sub, color, children, under }: { icon?: React.ReactNode; label: string; sub?: string; color: string; children?: React.ReactNode; under?: React.ReactNode }) {
  return (
    <div className="relative z-[1] h-full flex flex-col items-center justify-center text-center px-[4vw]">
      <div className={`${color} pop`}>{icon}</div>
      <div className={`brutal slam font-black leading-[.9] ${color}`} style={{ fontSize: label.length > 14 ? '12vh' : '16vh' }}>{label}</div>
      {under}
      {sub && <div className={`caps font-black mt-[3vh] text-[4.5vh] opacity-80 rise ${color}`}>{sub}</div>}
      {children}
    </div>
  );
}

export default function Display() {
  const [s, setS] = useState<PublicState | null>(null);
  const [online, setOnline] = useState(false);
  const { on, tone, enable } = useBeep();
  const sfx = useSounds(on);
  const fs = useFullscreen();
  // первый клик по проектору включает и звук, и весь экран; двойной клик или клавиша F — переключить весь экран
  useEffect(() => {
    const first = () => fs.enter();
    const key = (e: KeyboardEvent) => { if ((e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') && !e.ctrlKey && !e.metaKey && !e.altKey) fs.toggle(); };
    window.addEventListener('pointerdown', first, { once: true });
    window.addEventListener('dblclick', fs.toggle);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', first); window.removeEventListener('dblclick', fs.toggle); window.removeEventListener('keydown', key); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const prev = useRef<string>('');

  useEffect(() => {
    const sock = createSocket({ role: 'display' });
    sock.on('connect', () => setOnline(true));
    sock.on('disconnect', () => setOnline(false));
    sock.on('state', (st: PublicState) => setS(st));
    return () => { sock.close(); };
  }, []);

  useEffect(() => {
    if (!s) return;
    const sig = `${s.roundId}|${s.status}|${s.answerer?.id}|${s.verdict?.correct}|${s.quiz.id}|${s.quiz.status}|${s.quiz.reading}|${s.auto.phase}`;
    if (sig === prev.current) return;
    const before = prev.current; prev.current = sig;
    if (!before) return;
    const [, bRound, , , bQuiz, bStatus] = before.split('|'); // bStatus — статус письменного вопроса, bRound — кнопок
    // письменный вопрос: короткая заставка при появлении нового вопроса (своя для вопросов с картинкой);
    // фон во время приёма ответов включает отдельный эффект ниже
    if (s.quiz.status !== 'idle' || bStatus !== 'idle') {
      if (s.quiz.status === 'open' && s.quiz.reading && bQuiz !== s.quiz.id) sfx.play(s.quiz.image ? 'nextImage' : 'nextText');
      return;
    }
    // режим кнопок (не используется в «Финале») — прежние короткие сигналы
    if (s.status === 'buzzed' && bRound !== 'buzzed') tone([880, 1175], 0.12, 'square');
    else if (s.status === 'judged') tone(s.verdict?.correct ? [660, 880, 1320] : [220, 165], 0.16, 'triangle');
    else if (s.status === 'open') tone([660], 0.1);
  }, [s, tone, sfx]);

  // тихий джаз, пока команды отвечают; плавно затихает, когда приём закрыт
  const bgOn = !!s && on && s.displayView === 'auto' && s.quiz.status === 'open' && !s.quiz.reading;
  useEffect(() => { sfx.bg(bgOn); }, [bgOn, sfx]);

  if (!s) return <div className="h-dvh bg-ink bg-grid flex items-center justify-center text-muted brutal font-black text-[6vh]">Подключение…</div>;

  let body: React.ReactNode;
  let tone$ = 'text-snow';
  const v = s.displayView;
  const resultAge = s.tournament.resultAge || s.tournament.age;
  const ageTitle = s.tournament.ageMode && resultAge ? (resultAge === 'all' ? 'Общий зачёт' : AGE_LABEL[resultAge]) : '';
  const groupTitle = s.tournament.ageMode && s.tournament.age ? AGE_LABEL[s.tournament.age] : '';
  const key = `${resultAge}|${s.tournament.age}|${v}|${s.status}|${s.roundId}|${s.quiz.status}|${s.answerer?.id}|${s.verdict?.correct}|${s.auto.phase}|${s.reveal.shown}|${s.ceremony?.phase}|${s.ceremony?.rank}|${s.ceremony?.page}`;
  // 'qr' — устаревший алиас 'start': QR всегда живёт на красивой стартовой арене, второго экрана нет.
  const show = v === 'splash' || v === 'sponsors' || v === 'record' || v === 'flag';
  if (v === 'splash' || v === 'sponsors') body = <img src={`/show/${v}.png`} alt="" className="w-full h-full object-contain bg-black" draggable={false} />;
  else if (v === 'record' || v === 'flag') body = <ShowVideo key={v} src={`/show/${v}.mp4`} loop={v === 'flag'} sound={on} />;
  else if (v === 'start' || v === 'qr') body = <Start s={s} />;
  else if (v === 'leaderboard') body = <Leaderboard board={s.board} title={resultAge === 'all' ? 'Общая сетка турнира' : ageTitle ? `Топ · ${ageTitle}` : 'Результаты'} />;
  else if (v === 'final') body = <Final board={s.board} title={ageTitle ? `Итоги · ${ageTitle}` : 'Итоги турнира'} />;
  else if (v === 'reveal' && s.ceremony?.running) body = <><Awards s={s} sfx={sfx} />{s.ceremony.rank === 1 && s.ceremony.page === 1 && <Confetti n={50} />}</>;
  else if (v === 'reveal' && s.reveal.active) body = <Reveal rv={s.reveal} tone={tone} title={s.ceremony?.running ? `Награждение · ${ageTitle || 'Итоги'}` : ageTitle} />;
  else if (v === 'closing') body = <Neutral icon={<Flag size="18vh" strokeWidth={2.5} />} title={groupTitle ? `${groupTitle}: зачёт завершён` : "КВИЗ ЗАВЕРШЁН"} sub="Подводим итоги" />;
  else if (s.auto.running && s.auto.phase === 'blockbreak') {
    body = <Neutral icon={<CheckCircle2 size="18vh" strokeWidth={2.5} />} title={`БЛОК ${s.auto.doneBlock ?? ''} ЗАВЕРШЁН`} sub="Скоро следующий блок" />;
  }
  else if (s.auto.running && s.auto.phase === 'pause') {
    tone$ = 'text-white';
    body = (
      <div className="h-full relative flex flex-col items-center justify-center text-center px-[5vw] bg-panel">
        <Lock size="20vh" strokeWidth={2.5} className="text-warn pop" />
        <div className="brutal slam font-black text-[14vh] leading-[.9] text-warn mt-[2vh]">ПАУЗА</div>
        <div className="caps font-black text-[4.5vh] mt-[3vh] text-white/80 rise">{nextLabel(s.auto)}</div>
        <Clock s={s} light />
      </div>
    );
  } else if (s.quiz.status !== 'idle' && s.quiz.image) {
    const reading = s.quiz.status === 'open' && !!s.quiz.reading;
    const open = s.quiz.status === 'open' && !reading;
    const eligibleCount = s.activeTeamCount ?? s.teamCount;
    tone$ = 'text-white';
    body = <div className={`h-full flex flex-col gap-[2vh] px-[4vw] pt-[10vh] pb-[3vh] ${open ? 'bg-electric' : reading ? 'bg-ink' : 'bg-panel'}`}>
      <div className="flex items-center justify-between gap-[2vw]">
        <div className={`brutal font-black leading-none text-[5vh] ${reading ? 'text-warn' : 'text-white'}`}>{reading ? 'СЛУШАЕМ ВОПРОС' : open ? 'ПИШИТЕ ОТВЕТ' : 'ВРЕМЯ ВЫШЛО'}</div>
        <div className="flex gap-[1vw] caps font-black text-[2vh] shrink-0"><span>Блок {s.quiz.block}</span>{s.quiz.difficulty && <span>{DIFF_LABEL[s.quiz.difficulty]}</span>}{s.quiz.points != null && <span>{s.quiz.points} {pointsWord(s.quiz.points)}</span>}</div>
      </div>
      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-[3vw] flex-1 min-h-0">
        <div className="min-h-0 flex items-center justify-center bg-black/15 rounded-lg p-[1vh]"><QuestionImage src={s.quiz.image} className="w-full h-full min-h-0" /></div>
        <div className="min-h-0 flex flex-col justify-center items-center text-center overflow-y-auto">
          <div className="font-black leading-tight text-white break-words w-full" style={{ fontSize: s.quiz.question.length > 160 ? '3vh' : '4.2vh' }}>{s.quiz.question || 'Вопрос задаёт ведущий'}</div>
          {!!s.quiz.options.length && <Options options={s.quiz.options} compact />}
          {(open || reading) && <Clock s={s} light compact size="9vh" label={reading ? 'До начала ответов' : undefined} />}
        </div>
      </div>
    </div>;
  } else if (s.quiz.status !== 'idle') {
    const reading = s.quiz.status === 'open' && !!s.quiz.reading;
    const open = s.quiz.status === 'open' && !reading;
    const eligibleCount = s.activeTeamCount ?? s.teamCount;
    const len = s.quiz.question.length;
    const hasOpts = s.quiz.options.length > 0;
    const pts = s.quiz.points;
    tone$ = 'text-white';
    body = (
      <div style={{ justifyContent: 'safe center' }} className={`h-full relative flex flex-col items-center text-center px-[5vw] pt-[9vh] pb-[3vh] overflow-hidden ${open ? 'bg-electric' : reading ? 'bg-ink' : 'bg-panel'}`}>
        <div key={reading ? 'r' : 'o'} className={`brutal slam font-black ${reading ? 'text-warn' : 'text-white'}`} style={{ fontSize: hasOpts ? '6vh' : '8vh' }}>{reading ? 'СЛУШАЕМ ВОПРОС' : open ? 'ПИШИТЕ ОТВЕТ' : 'ВРЕМЯ ВЫШЛО'}</div>
        <div className="flex gap-[1vw] mt-[1.2vh] caps font-black text-[2.2vh] rise">
          <span className="border-2 border-white/70 px-[1vw] py-[.3vh]">Блок {s.quiz.block}</span>
          {s.quiz.difficulty && <span className="bg-white text-electric px-[1vw] py-[.3vh]">{DIFF_LABEL[s.quiz.difficulty]}</span>}
          {pts != null && <span className="bg-warn text-ink px-[1vw] py-[.3vh]">{pts} {pointsWord(pts)}</span>}
        </div>
        {s.quiz.question && (
          <div className="font-black leading-tight mt-[2.5vh] text-white rise" style={{ fontSize: hasOpts ? (len > 100 ? 'min(4vh, 2.7vw)' : 'min(5.4vh, 3.6vw)') : (len > 220 ? 'min(4.4vh, 2.9vw)' : len > 160 ? 'min(5vh, 3.3vw)' : len > 80 ? 'min(7vh, 4.6vw)' : 'min(10vh, 6.5vw)') }}>{s.quiz.question}</div>
        )}
        {hasOpts && <Options options={s.quiz.options} />}
        {(open || reading) && <Clock s={s} light size={hasOpts ? '9vh' : '14vh'} label={reading ? 'До начала ответов' : undefined} />}
      </div>
    );
  } else if (s.status === 'open') {
    tone$ = 'text-ink';
    body = (
      <div className="h-full bg-go text-ink relative overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center text-ink/25">
          {[0, 0.8, 1.6].map((d) => <span key={d} className="ring" style={{ width: '60vh', height: '60vh', animationDelay: `${d}s` }} />)}
        </div>
        <Center color="text-ink" icon={<Radio size="14vh" strokeWidth={3} />} label="BUZZERS OPEN" sub="Жмите кнопку">
          {s.questionText && <QuestionLine text={s.questionText} />}
          <Clock s={s} />
        </Center>
      </div>
    );
  } else if (s.status === 'buzzed' && s.answerer) {
    tone$ = 'text-white';
    body = (
      <div className="h-full bg-electric relative overflow-hidden">
        <div className="absolute inset-0 bg-grid opacity-40" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.12) 1px, transparent 1px)' }} />
        <div className="flash" />
        <Center color="text-white" label={s.answerer.name} sub="Team buzzed">
          {s.questionText && <QuestionLine text={s.questionText} />}
          {s.timer ? <Clock s={s} label="Время на ответ" light /> : <div className="h-[1.6vh] bg-white mt-[4vh]" style={{ animation: 'grow .5s .15s ease-out both', width: '40vw', transformOrigin: 'left' }} />}
        </Center>
      </div>
    );
  } else if (s.status === 'judged' && s.verdict) {
    const ok = s.verdict.correct;
    tone$ = ok ? 'text-ink' : 'text-white';
    body = (
      <div className={`h-full relative overflow-hidden ${ok ? 'bg-go' : 'bg-danger'}`}>
        {ok && <Confetti n={44} />}
        <Center
          color={ok ? 'text-ink' : 'text-white'}
          icon={ok ? <Check size="18vh" strokeWidth={5} /> : <X size="18vh" strokeWidth={5} />}
          label={ok ? 'CORRECT' : 'INCORRECT'}
          sub={`${s.verdict.name}${s.verdict.points ? `  ${s.verdict.points > 0 ? '+' : ''}${s.verdict.points}` : ''}`}
        />
      </div>
    );
  } else if (s.status === 'locked') {
    body = <Center color="text-warn" icon={<Lock size="12vh" strokeWidth={3} />} label="BUZZERS LOCKED" sub="Время вышло" />;
  } else {
    const age = s.tournament.ageMode ? s.tournament.age : null;
    // плашка лиги (как в углу), крупно по центру — чтобы зал видел, чей сейчас вопрос
    body = <Center color="text-snow" label="GET READY" sub="Ожидание вопроса" under={age && <span className="pop font-black caps mt-[4vh] px-[3vw] py-[1.4vh] border-[.4vh] text-[7vh] leading-none" style={{ background: AGE_COLOR[age], color: AGE_TEXT[age], borderColor: AGE_COLOR[age] }}>{AGE_LABEL[age]}</span>} />;
  }

  return (
    <div className={`h-dvh w-screen overflow-hidden relative select-none ${show ? 'bg-black' : 'bg-ink bg-grid'}`}>
      {v === 'auto' && <div className={tone$}><Header s={s} /></div>}
      <div key={key} className="h-full fade">{body}</div>
      {/* логотипы организаторов — белая плашка сверху по центру, видна на всех экранах проектора */}
      {!show && <div className="absolute top-[1.2vh] left-1/2 -translate-x-1/2 z-20 flex items-center gap-[1.8vh] bg-white rounded-[1.2vh] px-[2vh] py-[.9vh] shadow-[0_.6vh_2.4vh_rgba(0,0,0,.35)] pointer-events-none">
        <img src="/brand/qsbi.png" alt="QSBI" style={{ height: '5.2vh' }} draggable={false} />
        <span className="w-px self-stretch bg-black/15" />
        <img src="/brand/medeu.png" alt="MEDEU" style={{ height: '2.7vh' }} draggable={false} />
      </div>}
      {!on && ['start', 'qr', 'auto', 'splash', 'sponsors', 'record', 'flag'].includes(v) && <button onClick={() => { enable(); fs.enter(); }} className="absolute bottom-[2vh] right-[2vw] z-30 bg-warn text-ink font-black caps px-[1.2vw] py-[1vh] text-[1.9vh] flex items-center gap-[.6vw] shadow-2xl max-w-[28vw] text-left leading-tight"><VolumeX size={24} className="shrink-0" /> Нажмите: звук и весь экран</button>}
      {on && !fs.full && ['start', 'qr', 'splash', 'sponsors'].includes(v) && <button onClick={fs.enter} className="absolute bottom-[2vh] right-[2vw] z-30 bg-warn text-ink font-black caps px-[1.2vw] py-[1vh] text-[1.9vh] flex items-center gap-[.6vw] shadow-2xl"><Maximize size={22} className="shrink-0" /> На весь экран</button>}
      {fs.full && <button onClick={fs.toggle} className="absolute bottom-[1.5vh] right-[4vw] z-20 opacity-0 hover:opacity-100 text-muted" title="Выйти из полноэкранного режима (или Esc)"><Minimize size={22} /></button>}
      <button onClick={enable} className={`absolute bottom-[1.5vh] right-[1.5vw] z-20 ${show ? 'opacity-0' : 'opacity-40'} hover:opacity-100 text-muted`} title="Звук">
        {on ? <Volume2 size={22} /> : <VolumeX size={22} />}
      </button>
      {s.watermark?.on && s.watermark.text && <div className="absolute z-40 pointer-events-none whitespace-nowrap font-semibold text-white" style={{
        fontSize: `${s.watermark.size}vh`, opacity: s.watermark.opacity, textShadow: '0 0 .4vh rgba(0,0,0,.8)',
        [s.watermark.corner[0] === 'b' ? 'bottom' : 'top']: `${s.watermark.y}vh`, [s.watermark.corner[1] === 'r' ? 'right' : 'left']: `${s.watermark.x}vw`,
      }}>{s.watermark.text}</div>}
      {!online && <div className="absolute bottom-[1.5vh] left-[1.5vw] z-20 bg-danger text-white px-3 py-1 font-black uppercase text-sm">Нет связи с сервером</div>}
    </div>
  );
}

/** Видео на весь экран: «рекорд» играет один раз со звуком, «флаг» крутится по кругу. */
function ShowVideo({ src, loop, sound }: { src: string; loop: boolean; sound: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.muted = !sound;
    el.play().catch(() => { el.muted = true; void el.play().catch(() => {}); });
  }, [sound]);
  return <video ref={ref} src={src} loop={loop} autoPlay playsInline preload="auto" className="w-full h-full object-contain bg-black" />;
}
