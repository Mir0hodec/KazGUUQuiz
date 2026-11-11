import type { Age } from './types';

/** Цвета возрастных категорий (согласованы с заказчиком): junior — зелёный, middle — жёлтый, senior — красный. */
export const AGE_COLOR: Record<Age, string> = { junior: '#22C55E', middle: '#EAB308', senior: '#EF4444' };
export const AGE_LABEL: Record<Age, string> = { junior: 'Juniors', middle: 'Middles', senior: 'Seniors' };
/** Цвет текста поверх цвета категории: тёмный на зелёном и жёлтом, белый на красном. */
export const AGE_TEXT: Record<Age, string> = { junior: '#0B1020', middle: '#0B1020', senior: '#FFFFFF' };
export const ageColor = (a: Age | null | undefined, fallback = '#3A486B') => (a ? AGE_COLOR[a] : fallback);

export const AGE_SUBTITLE: Record<Age, string> = { junior: 'Junior League', middle: 'Middle League', senior: 'Senior League' };
export const AGE_CODE: Record<Age, string> = { junior: 'JUNIOR', middle: 'MIDDLE', senior: 'SENIOR' };

/** Подпись паузы: какой вопрос дальше (при лигах по кругу — с названием лиги). */
export const nextLabel = (auto: { next: number | null; nextAge?: Age | null }) =>
  auto.next == null ? 'Это был последний вопрос' : `Следующий вопрос — ${auto.nextAge ? `${AGE_LABEL[auto.nextAge]}, ` : ''}№${auto.next}`;
