import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Save, Trash2 } from 'lucide-react';
import type { AdminState, QuestionItem, Call } from '../lib/types';
import QuestionImage from '../components/QuestionImage';
import { DIFFICULTY, questionSeconds } from '../lib/difficulty';

const blank = (): QuestionItem => ({ q: '', a: '', options: [], correct: -1, difficulty: null, points: null, sec: null, block: 1 });
const signature = (rows: QuestionItem[]) => JSON.stringify(rows);
const copy = (rows: QuestionItem[]) => rows.map(q => ({ ...q, options: [...(q.options || [])] }));
const diff = { easy: 'лёгкий', medium: 'средний', hard: 'сложный' };
function serialize(q: QuestionItem) {
  const answer = q.options?.length ? q.options.map((o, i) => o + (i === q.correct ? '*' : '')).join('; ') : q.a;
  return [q.q, answer, q.difficulty ? diff[q.difficulty] : '', q.points ?? '', q.sec ?? '', q.block ?? 1, q.image || ''].join(' | ');
}
export default function Questions({ s, call, say, onDirty, getToken }: { s: AdminState; call: Call; say: (m: string, bad?: boolean) => void; onDirty: (v: boolean) => void; getToken: () => string }) {
  const [rows, setRows] = useState<QuestionItem[]>(() => copy(s.questions));
  const [base, setBase] = useState(() => signature(s.questions));
  const [selected, setSelected] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const serverSignature = signature(s.questions);
  const conflict = dirty && serverSignature !== base;
  const active = s.pub.auto.running || s.pub.quiz.status === 'open' || s.pub.status === 'open' || s.pub.status === 'buzzed';
  useEffect(() => {
    if (!dirty) { setRows(copy(s.questions)); setBase(serverSignature); }
  }, [serverSignature, dirty]);
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy, onDirty]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, busy]);
  const mutate = (next: QuestionItem[]) => { setRows(next); setDirty(true); setError(''); };
  const current = rows[selected];
  const update = (change: Partial<QuestionItem>) => mutate(rows.map((q, i) => i === selected ? { ...q, ...change } : q));
  const uploadImage = async (file?: File) => {
    if (!file || busy) return;
    if (file.size > 8 * 1024 * 1024) { setError('Изображение должно быть не больше 8 МБ.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/media', { method: 'POST', headers: { 'x-admin-token': getToken(), 'Content-Type': 'application/octet-stream' }, body: file });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Не удалось загрузить изображение');
      update({ image: result.image });
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось загрузить изображение'); }
    finally { setBusy(false); }
  };
  const add = () => { mutate([...rows, blank()]); setSelected(rows.length); setSearch(''); };
  const discard = () => { if (!dirty || confirm('Отменить несохранённые изменения вопросов?')) { setDirty(false); setRows(copy(s.questions)); setBase(serverSignature); setError(''); setSelected(0); } };
  const save = async () => {
    if (busy || active || conflict) return;
    for (let i = 0; i < rows.length; i++) {
      const q = rows[i];
      let problem = '';
      if (!q.q.trim()) problem = 'введите текст вопроса';
      else if (/[|\r\n]/.test(q.q + q.a) || (!q.options?.length && q.a.includes(';'))) problem = 'уберите переносы строк, знак | и точку с запятой из свободного ответа';
      else if (q.options?.length && (q.options.length < 2 || q.options.some(o => !o.trim() || /[|;*\r\n]/.test(o)))) problem = 'заполните хотя бы два варианта; символы | ; * и переносы строк в вариантах не поддерживаются';
      else if (q.options?.length && (q.correct == null || q.correct < 0 || q.correct >= q.options.length)) problem = 'выберите правильный вариант ответа';
      else if (q.points != null && (!Number.isInteger(q.points) || q.points < 0 || q.points > 1000)) problem = 'баллы должны быть целым числом от 0 до 1000';
      else if (q.sec != null && (!Number.isInteger(q.sec) || q.sec < 5 || q.sec > 3600)) problem = 'время должно быть целым числом от 5 до 3600 секунд';
      if (problem) { setSelected(i); setSearch(''); setError(`Вопрос ${i + 1}: ${problem}.`); return; }
    }
    setBusy(true);
    try {
      const r = await call('a:questions:set', { text: rows.map(serialize).join('\n'), accepts: rows.map(q => (q.accept || []).map(v => v.trim()).filter(Boolean)) });
      if (r.ok) { setDirty(false); onDirty(false); say('Вопросы сохранены'); }
    } finally { setBusy(false); }
  };
  const move = (delta: number) => {
    const target = selected + delta;
    const next = [...rows]; [next[selected], next[target]] = [next[target], next[selected]];
    mutate(next); setSelected(target);
  };
  return <div className="flex flex-col gap-4">
    <div className="admin-editor-toolbar"><span className={dirty ? 'text-warn' : 'text-muted'}>{dirty ? 'Есть несохранённые изменения' : `${rows.length} в списке · всё сохранено`}</span><div className="flex gap-2"><button className="admin-button" disabled={!dirty || busy} onClick={discard}>Отменить изменения</button><button className="admin-button primary" disabled={!dirty || busy || active || conflict} onClick={() => void save()}><Save size={17} />{busy ? 'Сохраняем…' : 'Сохранить вопросы'}</button></div></div>
    {active && <div className="admin-help">Идёт вопрос. Сохранение и импорт доступны после закрытия приёма ответов и остановки автоматической игры.</div>}
    {conflict && <div role="alert" className="admin-alert">Список вопросов изменился в другом окне. Отмените свои изменения, чтобы загрузить актуальный список перед редактированием.</div>}
    {error && <div role="alert" className="admin-alert">{error}</div>}
    <div className="admin-question-layout">
      <section className="admin-card admin-question-list"><label className="admin-field">Поиск вопросов<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Найти по тексту…" /></label><button className="admin-button w-full" disabled={busy || rows.length >= 500} onClick={add}><Plus size={17} /> Добавить вопрос</button><div className="admin-question-items">{rows.map((q, i) => (!search || q.q.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <button key={i} disabled={busy} onClick={() => setSelected(i)} aria-current={i === selected ? 'true' : undefined}><span>{i + 1}</span><div><strong>{q.q || 'Новый вопрос'}</strong><small>Блок {q.block ?? 1} · {q.options?.length ? 'С вариантами' : 'Свободный ответ'}{q.image ? ' · Картинка' : ''}</small></div></button>)}{rows.length === 0 && <p className="text-muted text-sm py-5">Пока пусто. Добавьте первый вопрос — он появится здесь.</p>}{rows.length > 0 && search && !rows.some(q => q.q.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <p className="text-muted text-sm py-5">Ничего не найдено.</p>}</div></section>
      <section className="admin-card">{current ? <fieldset disabled={busy} className="flex flex-col gap-5 min-w-0"><div className="flex items-center justify-between gap-3"><h2 className="admin-section-title !mb-0">Вопрос {selected + 1}</h2><div className="flex gap-1"><button aria-label="Переместить вопрос выше" className="admin-icon-button" disabled={selected === 0} onClick={() => move(-1)}><ArrowUp size={17} /></button><button aria-label="Переместить вопрос ниже" className="admin-icon-button" disabled={selected === rows.length - 1} onClick={() => move(1)}><ArrowDown size={17} /></button><button aria-label="Удалить вопрос" className="admin-icon-button text-danger" onClick={() => { if (confirm(`Удалить вопрос ${selected + 1}? Изменения вступят в силу после сохранения.`)) { mutate(rows.filter((_, i) => i !== selected)); setSelected(Math.max(0, selected - 1)); } }}><Trash2 size={17} /></button></div></div>
        <label className="admin-field">Текст вопроса<textarea rows={3} maxLength={500} value={current.q} onChange={e => update({ q: e.target.value })} placeholder="Например: Какая планета самая большая?" /><small>Виден участникам, если показ вопросов включён в настройках.</small></label>
        <div className="admin-field"><span>Изображение к вопросу</span><small>Появится на проекторе и телефонах вместе с вопросом. PNG, JPEG, WebP или GIF, до 8 МБ.</small>
          {current.image && <QuestionImage src={current.image} className="w-full max-h-72 rounded-lg bg-black/20" zoom />}
          <div className="flex flex-wrap gap-2"><label className="admin-button cursor-pointer">{current.image ? 'Заменить изображение' : 'Загрузить изображение'}<input type="file" className="sr-only" aria-label="Загрузить изображение к вопросу" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void uploadImage(file); }} /></label>{current.image && <button type="button" className="admin-button" onClick={() => update({ image: null })}>Убрать изображение</button>}</div>
          <small>Изменения вступят в силу после нажатия «Сохранить вопросы».</small>
        </div>
        <label className="admin-field">Как команды отвечают?<select value={current.options?.length ? 'options' : 'text'} onChange={e => { if (e.target.value === 'options') update({ options: [current.a || '', '', '', ''], correct: 0 }); else update({ a: current.options?.[current.correct ?? -1] || '', options: [], correct: -1 }); }}><option value="text">Пишут ответ сами</option><option value="options">Выбирают из вариантов</option></select></label>
        {current.options?.length ? <div className="flex flex-col gap-2"><p className="text-sm font-semibold">Варианты ответа <span className="text-muted font-normal">· отметьте правильный</span></p>{current.options.map((o, i) => <div key={i} className="admin-option"><input type="radio" name="correct-option" aria-label={`Вариант ${i + 1} — правильный`} checked={current.correct === i} onChange={() => update({ correct: i })} /><input aria-label={`Текст варианта ${i + 1}`} maxLength={80} value={o} onChange={e => update({ options: current.options!.map((v, k) => k === i ? e.target.value : v) })} /><button className="admin-icon-button" aria-label={`Удалить вариант ${i + 1}`} disabled={current.options!.length <= 2} onClick={() => update({ options: current.options!.filter((_, k) => k !== i), correct: current.correct === i ? -1 : (current.correct ?? -1) > i ? current.correct! - 1 : current.correct })}><Trash2 size={15} /></button></div>)}{current.options.length < 8 && <button className="admin-button self-start" onClick={() => update({ options: [...current.options!, ''] })}><Plus size={16} /> Ещё вариант</button>}</div> : <label className="admin-field">Правильный ответ<input maxLength={200} value={current.a} onChange={e => update({ a: e.target.value })} placeholder="Например: Юпитер" /><small>Несколько допустимых ответов разделяйте косой чертой: 8 / восемь. Пустое поле — проверяете вручную.</small></label>}
        {!current.options?.length && <div className="admin-field"><span>Допустимые формулировки</span><small>Например: логотип, лого, logo, logotype. Регистр и опечатки учитываются по правилам проверки.</small>{(current.accept || []).map((v, i) => <div className="admin-option" key={i}><input aria-label={`Допустимый ответ ${i + 1}`} maxLength={200} value={v} onChange={e => update({ accept: current.accept!.map((x, k) => k === i ? e.target.value : x) })} /><button className="admin-icon-button" aria-label={`Удалить допустимый ответ ${i + 1}`} onClick={() => update({ accept: current.accept!.filter((_, k) => k !== i) })}><Trash2 size={15} /></button></div>)}<button className="admin-button self-start" disabled={(current.accept || []).length >= 30} onClick={() => update({ accept: [...(current.accept || []), ''] })}><Plus size={16} /> Добавить вариант</button></div>}
        <div className="grid sm:grid-cols-2 gap-4"><label className="admin-field">Блок<select value={current.block ?? 1} onChange={e => update({ block: Number(e.target.value) })}>{Array.from({ length: 9 }, (_, i) => <option key={i + 1} value={i + 1}>Блок {i + 1}</option>)}</select></label><div className="admin-field"><span>Уровень сложности</span><div className="difficulty-picker">{Object.entries(DIFFICULTY).map(([key, level]) => <button key={key} aria-pressed={current.difficulty === key} style={{ color: level.color }} onClick={() => update({ difficulty: key as QuestionItem['difficulty'] })}><strong>{level.label}</strong><small>{s.settings.difficultyPoints[key as keyof typeof diff]} балл. · {s.settings.difficultyTiming ? s.settings.difficultySec[key as keyof typeof diff] : s.settings.quizSec} с</small></button>)}</div><button className="text-xs text-muted underline self-start" onClick={() => update({ difficulty: null })}>Без сложности · общий таймер</button></div><label className="admin-field">Баллы за этот вопрос<input type="number" min={0} max={1000} value={current.points ?? ''} onChange={e => update({ points: e.target.value === '' ? null : Number(e.target.value) })} placeholder="По правилам турнира" /></label><label className="admin-field">Время на этот вопрос, секунд<input type="number" min={5} max={3600} value={current.sec ?? ''} onChange={e => update({ sec: e.target.value === '' ? null : Number(e.target.value) })} placeholder={String(questionSeconds({ ...current, sec: null }, s.settings))} /><small>Если пусто: {questionSeconds({ ...current, sec: null }, s.settings)} с{current.difficulty && s.settings.difficultyTiming ? ' по сложности' : ' по общим правилам'}.</small></label></div><div className="admin-help"><Check size={19} /><p>Правильный ответ виден только вам. Баллы и время берутся из выбранного уровня. Свои значения в полях выше имеют приоритет.</p></div>
      </fieldset> : <div className="admin-empty"><h2>Начнём с первого вопроса</h2><p>Введите текст и правильный ответ. Варианты, баллы и время можно настроить отдельно.</p><button className="admin-button primary" onClick={add}><Plus size={18} /> Добавить вопрос</button></div>}</section>
    </div>
    <details className="admin-card"><summary>Импорт готового списка вопросов</summary><p className="text-muted my-3 text-sm">Для готовых списков: одна строка — один вопрос. Формат: вопрос | ответ или варианты | сложность | баллы | секунд | блок | ссылка на загруженную картинку (необязательно). Импорт заменяет весь список. Варианты разделяются ; и правильный отмечается *.</p><label className="admin-field">Список для импорта<textarea rows={5} value={importText} onChange={e => setImportText(e.target.value)} placeholder="Столица Франции? | Париж" /></label><button className="admin-button mt-3" disabled={active || busy || conflict || !importText.trim()} onClick={async () => { if (!confirm('Заменить все сохранённые вопросы импортированным списком? Несохранённые правки также будут заменены.')) return; setBusy(true); try { const r = await call('a:questions:set', { text: importText }); if (r.ok) { setDirty(false); onDirty(false); setSelected(0); setImportText(''); const nc = (r as { noCorrect?: number }).noCorrect || 0; say(nc ? `Импортировано. Внимание: в ${nc} вопрос(ах) с вариантами не отмечен верный (*) — они не проверятся сами` : 'Список импортирован', nc > 0); } } finally { setBusy(false); } }}>Импортировать и сохранить</button></details>
  </div>;
}
