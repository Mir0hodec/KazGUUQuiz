import { describe, it, expect } from 'vitest';
import { matchesAnswer } from '../server/grade.js';

// Настоящие ответы детей из турнира «Юный бизнесмен»
describe('автопроверка письменных ответов', () => {
  const yes = [
    ['манета', 'монета / монетка / монеты'],
    ['Продовец', 'продавец / продавщица'],
    [')Продавец( торговец', 'продавец / продавщица'],
    ['Покупатель, клиент', 'покупатель / клиент'],
    ['Продуктовый магазин', 'магазин / рынок / супермаркет'],
    ['Породуктовый магазин', 'магазин / рынок / супермаркет'],
    ['Машазин( супермаркет)', 'магазин / рынок / супермаркет'],
    ['Долор', 'доллар / доллары'],
    ['Брижа', 'биржа'],
    ['100 копеек', '100 / сто'],
    ['100 тг', '100 / сто'],
    ['ЗАРПЛАТА', 'зарплата / заработная плата / зп'],
    ['заработная плата', 'зарплата / заработная плата / зп'],
    ['займ', 'кредит / заём / займ'],
    ['заем', 'кредит / заём / займ'],
    ['Свинья копилка', 'копилка / свинья-копилка / свинка-копилка'],
  ];
  const no = [
    ['Доход', 'зарплата / заработная плата / зп'],
    ['Прибыль', 'зарплата / заработная плата / зп'],
    ['Чек', 'ценник'],
    ['деньги', 'ценник'],
    ['Трейд', 'бартер / обмен'],
    ['Торговец', 'бартер / обмен'],
    ['10', '100 / сто'],
    ['1', '100 / сто'],
    ['долг', 'кредит / заём / займ'],
    ['Дохода', 'бюджет'],
    ['расходы и доходы', 'бюджет'],
    ['не магазин', 'магазин / рынок / супермаркет'],
    ['это точно не какой-то там магазин наверное', 'магазин / рынок / супермаркет'],
    ['', 'бюджет'],
  ];
  it.each(yes)('засчитывает «%s» для «%s»', (text, key) => expect(matchesAnswer(text, key)).toBe(true));
  it.each(no)('не засчитывает «%s» для «%s»', (text, key) => expect(matchesAnswer(text, key)).toBe(false));
  it('фразы сравниваются по словам, «двойники» букв и слитное написание', () => {
    const k = 'раунд A / серия A / series A / A';
    expect(matchesAnswer('Series B', k)).toBe(false);
    expect(matchesAnswer('серия А', k)).toBe(true); // русская А
    expect(matchesAnswer('series a', k)).toBe(true);
    expect(matchesAnswer('zip 2', 'Zip2 / зип2')).toBe(true);
    expect(matchesAnswer('S&P500', 'S&P 500 / sp500')).toBe(true);
    expect(matchesAnswer('nasdaq', 'S&P 500 / sp500')).toBe(false);
  });
  it('строгая проверка для взрослых: другое слово с двумя отличиями не засчитывается', () => {
    expect(matchesAnswer('монопсония', 'монополия', { strict: true })).toBe(false);
    expect(matchesAnswer('монаполия', 'монополия', { strict: true })).toBe(true);
    expect(matchesAnswer('Долор', 'доллар', { strict: true })).toBe(false); // детям — да, взрослым — нет
    expect(matchesAnswer('Долор', 'доллар')).toBe(true);
    expect(matchesAnswer('Брижа', 'биржа', { strict: true })).toBe(false);
  });
  it('число слитно с рублями и числа с пробелами', () => {
    expect(matchesAnswer('30р', '30 / тридцать')).toBe(true);
    expect(matchesAnswer('500руб', '500 / пятьсот')).toBe(true);
    expect(matchesAnswer('30 000 р', '30000')).toBe(true);
    expect(matchesAnswer('300р', '30 / тридцать')).toBe(false);
    expect(matchesAnswer('10млн', '10 / десять')).toBe(true);
  });
  it('короткие слова только точно', () => {
    expect(matchesAnswer('чек', 'чек')).toBe(true);
    expect(matchesAnswer('чак', 'чек')).toBe(false);
    expect(matchesAnswer('зп', 'зарплата / зп')).toBe(true);
  });
});

describe('допустимые формулировки', () => {
  it('принимает точный длинный ответ, сохраняя запрет на длинные перечисления', () => {
    const key = 'Рост бык и падение медведь рынка';
    expect(matchesAnswer(key, key)).toBe(true);
    expect(matchesAnswer('это наверное рост бык и падение медведь рынка', key)).toBe(false);
    expect(matchesAnswer('один два три четыре логотип', 'логотип')).toBe(false);
  });
  const variants = ['логотип', 'лого', 'logo', 'logotype'];
  it.each(['ЛОГОТИП', 'лого', 'LOGO', 'logotyp', 'логотпи'])('принимает %s', v => expect(matchesAnswer(v, variants)).toBe(true));
  it.each(['картинка', 'не логотип', 'это не логотип', 'один два три четыре логотип'])('отклоняет %s', v => expect(matchesAnswer(v, variants)).toBe(false));
  it('сохраняет строгий режим и разделитель', () => {
    expect(matchesAnswer('лога', variants, { strict: true })).toBe(false);
    expect(matchesAnswer('восемь', ['8 / восемь'])).toBe(true);
  });
});
