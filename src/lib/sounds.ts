import { useCallback, useEffect, useMemo, useRef } from 'react';

// Звуки проектора — файлы лежат в public/sounds (источники и лицензии — в public/sounds/ИСТОЧНИКИ.md).
const FILES = {
  drumroll: '/sounds/drumroll.mp3', // 5 с, удар тарелки на 3,8 с
  fanfare: '/sounds/fanfare.mp3', // 1-е место
  nextText: '/sounds/next-text.mp3', // смена вопроса — обычный вопрос
  nextImage: '/sounds/next-image.mp3', // смена вопроса — вопрос с картинкой
  bg: '/sounds/question-bg.mp3', // фон, пока команды отвечают
} as const;
export type Sfx = Exclude<keyof typeof FILES, 'bg'>;
export const DRUM_HIT_MS = 3800;
const BG_VOLUME = 0.22;

export interface Sounds { play: (name: Sfx) => void; bg: (on: boolean) => void }

/** Короткие звуки + зацикленный фон. Играют только после того, как звук включён кликом (on). */
export function useSounds(on: boolean): Sounds {
  const pool = useRef<Partial<Record<keyof typeof FILES, HTMLAudioElement>>>({});
  const fade = useRef<number | null>(null);
  const onRef = useRef(on); onRef.current = on;
  const get = (name: keyof typeof FILES) => {
    let a = pool.current[name];
    if (!a) { a = new Audio(FILES[name]); a.preload = 'auto'; if (name === 'bg') { a.loop = true; a.volume = BG_VOLUME; } pool.current[name] = a; }
    return a;
  };
  useEffect(() => { (Object.keys(FILES) as (keyof typeof FILES)[]).forEach(get); }, []); // заранее грузим, чтобы не было задержки
  const play = useCallback((name: Sfx) => {
    if (!onRef.current) return;
    const a = get(name);
    try { a.currentTime = 0; void a.play().catch(() => {}); } catch { /* нет звука */ }
  }, []);
  const bg = useCallback((want: boolean) => {
    const a = get('bg');
    if (fade.current) { clearInterval(fade.current); fade.current = null; }
    if (want && onRef.current) {
      a.volume = BG_VOLUME;
      if (a.paused) { try { a.currentTime = 0; } catch { /* */ } void a.play().catch(() => {}); }
    } else if (!a.paused) {
      fade.current = window.setInterval(() => { // мягко затихает за ~0,6 с
        a.volume = Math.max(0, a.volume - BG_VOLUME / 12);
        if (a.volume <= 0.001) { a.pause(); a.volume = BG_VOLUME; if (fade.current) clearInterval(fade.current); fade.current = null; }
      }, 50);
    }
  }, []);
  useEffect(() => () => { Object.values(pool.current).forEach((a) => a?.pause()); }, []);
  return useMemo(() => ({ play, bg }), [play, bg]);
}
