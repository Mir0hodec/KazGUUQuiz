import type { AdminState, QuestionItem } from './types';
export const DIFFICULTY = { easy: { label: 'Лёгкий', subtitle: 'Разминка', color: '#5EEAD4' }, medium: { label: 'Средний', subtitle: 'Вызов', color: '#93C5FD' }, hard: { label: 'Сложный', subtitle: 'Эксперт', color: '#D8B4FE' } } as const;
export function questionSeconds(item: QuestionItem | undefined, settings: AdminState['settings'], mode: 'quiz' | 'buzz' = 'quiz') {
  return item?.sec ?? (settings.difficultyTiming && item?.difficulty ? settings.difficultySec[item.difficulty] : undefined) ?? (mode === 'buzz' ? settings.openSec : settings.quizSec);
}
