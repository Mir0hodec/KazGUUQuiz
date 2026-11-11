import { useEffect } from 'react';
import { ArrowRight, Check, Crown, Trophy } from 'lucide-react';
import type { PublicState } from '../lib/types';
import { AGE_COLOR, AGE_LABEL } from '../lib/age';
import { useCountdown } from '../lib/util';
import { DRUM_HIT_MS, type Sounds } from '../lib/sounds';

const label = (group: string | null | undefined) => group === 'all' ? 'Общий топ-3' : group ? AGE_LABEL[group as keyof typeof AGE_LABEL] : 'Общая таблица';
const medals: Record<number, { color: string; name: string }> = {
  1: { color: '#F6CA55', name: 'Победители' },
  2: { color: '#D6E0EF', name: 'Серебро' },
  3: { color: '#DE9C69', name: 'Бронза' },
};

export default function Awards({ s, sfx }: { s: PublicState; sfx: Sounds }) {
  const c = s.ceremony!;
  const rank = c.rank ?? null;
  const intro = c.phase === 'intro';
  const medal = medals[rank || 1];
  const color = c.group && c.group !== 'all' ? AGE_COLOR[c.group] : '#F6CA55';
  const countdown = useCountdown(c.endsAt && c.durationMs ? { kind: 'pause', endsAt: c.endsAt, durationMs: c.durationMs } : null, s.t);
  const winners = c.winners || [];
  const next = intro ? `${c.nextRank ?? 3}-е место` : c.pages && c.page && c.page < c.pages ? 'Продолжение общего места' : c.nextRank ? `${c.nextRank}-е место` : c.nextGroup ? label(c.nextGroup) : 'Общая таблица турнира';
  // Барабанная дробь перед каждым местом: стартует так, чтобы удар тарелки совпал с появлением команды.
  // Фанфары — только для 1-го места (в каждой лиге и в общем топе). 2-е и 3-е место открываются ударом тарелки.
  const drumNext = !!c.nextRank && !(c.pages && c.page && c.page < c.pages);
  useEffect(() => {
    if (!drumNext || !c.endsAt) return;
    const wait = c.endsAt - s.t - DRUM_HIT_MS;
    const id = window.setTimeout(() => sfx.play('drumroll'), Math.max(0, wait));
    return () => clearTimeout(id);
  }, [c.endsAt, drumNext]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!intro && rank === 1 && c.page === 1) sfx.play('fanfare');
  }, [c.group, c.phase, rank, c.page]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="h-full relative overflow-hidden flex flex-col px-[4vw] py-[3vh]" style={{ background: `radial-gradient(ellipse at 50% 42%, ${intro ? color : medal.color}22, transparent 65%), #0B1020` }}>
    <div className="absolute top-[-20vh] left-1/2 -translate-x-1/2 w-[70vw] h-[70vw] rounded-full border border-white/5 pointer-events-none" />
    <header className="relative flex justify-between items-center gap-[2vw] text-[2vh] tracking-[.2em] uppercase font-bold text-white/55"><span>{s.tournament.name}</span><span>Награждение · {c.step} / {c.total}</span></header>
    <main className="relative flex-1 min-h-0 flex flex-col justify-center items-center text-center gap-[2vh] py-[3vh]">
      {intro ? <>
        <Trophy size="12vh" strokeWidth={1.5} style={{ color }} className="rise" />
        <p className="uppercase tracking-[.35em] font-bold text-[2.6vh] text-white/55">Встречаем призёров</p>
        <h1 className="brutal font-black leading-none slam" style={{ color, fontSize: c.group === 'all' ? '12vh' : '16vh' }}>{label(c.group)}</h1>
        <p className="text-[3vh] text-white/65">От бронзы к главной победе</p>
      </> : <>
        <p className="uppercase tracking-[.25em] font-bold text-[2.5vh]" style={{ color }}>{label(c.group)}</p>
        <div className="flex w-full items-center justify-center gap-[4vw] min-h-0">
          <div className="shrink-0 flex flex-col items-center gap-[1vh]">
            {rank === 1 && <Crown size="7vh" style={{ color: medal.color }} />}
            <div className="rounded-full flex items-center justify-center border-[.6vh] shadow-2xl" style={{ width: '23vh', height: '23vh', color: medal.color, borderColor: medal.color, background: `linear-gradient(145deg, ${medal.color}30, ${medal.color}05)`, boxShadow: `0 0 10vh ${medal.color}18` }}><span className="brutal font-black leading-none text-[17vh]">{rank}</span></div>
            <p className="uppercase font-bold text-[2.5vh] tracking-[.15em]" style={{ color: medal.color }}>{c.shared ? 'Общее место' : rank === 1 ? 'Победитель' : medal.name}</p>
          </div>
          <div className="min-w-0 flex-1 grid gap-[1.5vh]" style={{ gridTemplateColumns: winners.length > 3 ? 'repeat(2,minmax(0,1fr))' : '1fr' }}>
            {winners.map((row, i) => <div key={row.id} className="rise rounded-xl border bg-white/[.035] px-[2vw] py-[1.7vh] text-left min-w-0" style={{ borderColor: `${medal.color}60`, animationDelay: `${i * 100}ms` }}>
              <h2 className="font-black leading-tight break-words" style={{ fontSize: winners.length === 1 ? (row.name.length > 25 ? '7vh' : '9vh') : winners.length > 3 ? '3.3vh' : '4.8vh' }}>{row.name}</h2>
              <p className="mt-[.8vh] flex items-center gap-[1vw] text-[2.8vh]"><strong style={{ color: medal.color }}>{row.score} баллов</strong>{row.age && <span className="text-[1.8vh] uppercase tracking-wider" style={{ color: AGE_COLOR[row.age] }}>{AGE_LABEL[row.age]}</span>}</p>
            </div>)}
          </div>
        </div>
        {(c.pages || 0) > 1 && <p className="text-white/50 text-[2vh]">Команды на общем месте · {c.page} / {c.pages}</p>}
      </>}
    </main>
    <footer className="relative shrink-0 flex flex-col gap-[1.6vh]">
      <div className="flex justify-between items-center text-[2vh] text-white/50"><span className="flex items-center gap-[.7vw]">Далее <ArrowRight size="2vh" /> <strong className="text-white/80">{next}</strong></span><span className="tabular-nums">{countdown?.sec ?? ''}{countdown ? ' с' : ''}</span></div>
      <div className="h-[.5vh] bg-white/10 overflow-hidden rounded-full"><div className="h-full transition-[width] duration-100" style={{ background: intro ? color : medal.color, width: `${(1 - (countdown?.frac ?? 1)) * 100}%` }} /></div>
      <div className="flex items-center justify-center gap-[1.5vw]">{[...(c.order || []), 'table'].map((group, i) => <div key={group} className="flex items-center gap-[.6vw] text-[1.8vh] font-bold" style={{ color: i < c.step - 1 ? '#A8B4C8' : i === c.step - 1 ? '#FFFFFF' : '#536078' }}>{i < c.step - 1 ? <Check size="2vh" /> : <span className="w-[2.5vh] h-[2.5vh] rounded-full border flex items-center justify-center text-[1.4vh]">{i + 1}</span>}{group === 'table' ? 'Общая таблица' : label(group)}</div>)}</div>
    </footer>
  </div>;
}
