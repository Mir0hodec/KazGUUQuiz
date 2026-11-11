// Автопроверка письменного ответа. Дети пишут с ошибками и словами вокруг ответа,
// поэтому прощаем опечатки и засчитываем верное слово внутри короткой фразы.

export const norm = (t) => String(t).toLowerCase().replace(/ё/g, 'е').replace(/й/g, 'и').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Расстояние Дамерау–Левенштейна (с перестановкой соседних букв: «брижа» → «биржа» = 1). */
function distance(a, b) {
  const n = a.length; const m = b.length;
  if (Math.abs(n - m) > 2) return 3;
  const d = Array.from({ length: n + 1 }, (_, i) => [i, ...Array(m).fill(0)]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[n][m];
}

/** Сколько опечаток прощаем: короткие слова и числа — только точно. strict — для взрослых: одна опечатка и только в длинных словах. */
const allowed = (w, strict) => (/\d/.test(w) || w.length <= 3 ? 0 : strict ? (w.length <= 5 ? 0 : 1) : w.length <= 5 ? 1 : 2);
// буквы-«двойники»: одиночные русские А, В, С… в ответе равны латинским (серия А = series A)
const LOOK = { а: 'a', в: 'b', с: 'c', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', т: 't', х: 'x', у: 'y' };
const unify = (w) => (w.length === 1 && LOOK[w] ? LOOK[w] : w);
const close = (word, key, strict) => { word = unify(word); key = unify(key); return word === key || (allowed(key, strict) > 0 && distance(word, key) <= allowed(key, strict)); };
/** Фраза: столько же слов, каждое слово близко к своему. */
const closePhrase = (words, keyWords, strict) => words.length === keyWords.length && keyWords.every((w, j) => close(words[j], w, strict));

const MAX_WORDS = 4; // «Продуктовый магазин», «100 копеек» — да; длинное перечисление — нет

/**
 * Совпадает ли ответ с одним из правильных (варианты через «/»).
 * 1) точно или с опечаткой целиком; 2) правильное слово/фраза внутри короткого ответа (до 4 слов, без «не»).
 */
export function matchesAnswer(text, key, { strict = false } = {}) {
  const answer = norm(text);
  if (!answer) return false;
  const keys = (Array.isArray(key) ? key : [key]).flatMap(k => String(k || '').split('/')).map(norm).filter(Boolean);
  // «30р», «500руб», «10млн» → число отдельно: дети часто пишут единицы слитно
  const words = answer.split(' ').flatMap((w) => { const m = w.match(/^(\d+)(р|руб|рублей|рубля|коп|тг|млн|тыс|шт)$/); return m ? [m[1], m[2]] : [w]; });
  const negated = words.includes('не') || words.includes('нет');
  if (negated) return false;
  if (keys.includes(answer)) return true;
  if (words.length > MAX_WORDS) return false;
  const compact = answer.replace(/ /g, '');
  const compactNum = words.filter((w) => !/^(р|руб|рублей|рубля|коп|тг|шт)$/.test(w)).join(''); // «30 000 р» = «30000»
  for (const k of keys) {
    const kw = k.split(' ');
    if (closePhrase(words, kw, strict)) return true;
    if (compact === k.replace(/ /g, '') || (/\d/.test(k) && compactNum === k.replace(/ /g, ''))) return true; // «zip 2» = «zip2», «S&P500» = «s p 500», «30 000 р» = «30000»
    if (negated || words.length > MAX_WORDS) continue;
    for (let i = 0; i + kw.length <= words.length; i++) {
      if (kw.every((w, j) => close(words[i + j], w, strict))) return true;
    }
  }
  return false;
}
