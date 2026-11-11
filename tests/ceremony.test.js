import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createQuizServer } from '../server/app.js';

const servers = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { vi.clearAllTimers(); vi.useRealTimers(); for (const server of servers.splice(0)) await server.close(); });
function boot(names, ageMode = true) {
  const server = createQuizServer({ dataFile: null, staticDir: null, silent: true, ceremonyTiming: { intro: 10, step: 10, hold: 10 } });
  servers.push(server);
  server.local('a:tournament:create', { name: 'Награждение', teamNames: names, ageMode, teamCount: 0 });
  return server;
}
const state = server => server.local('a:state').state.pub;
async function complete(server, visit = () => {}) {
  for (let n = 0; n < 150; n++) {
    const pub = state(server); visit(pub);
    if (!pub.ceremony.running) return pub;
    await vi.advanceTimersByTimeAsync(10);
  }
  throw new Error('Церемония не завершилась');
}

it('один запуск: Juniors → Middles → Seniors → общий топ-3 → полная сетка; в каждом зачёте 3 → 2 → 1', async () => {
  const names = ['junior', 'middle', 'senior'].flatMap(age => Array.from({ length: 10 }, (_, i) => `${age}-${i} | ${age}`)).join('\n');
  const server = boot(names);
  server.db.teams.forEach((team, i) => { team.score = 100 - i; });
  server.local('a:ceremony:start');
  const screens = [], groups = [];
  const final = await complete(server, pub => {
    const c = pub.ceremony;
    if (!c.running) return;
    expect(pub.displayView).toBe('reveal');
    expect(pub.board).toHaveLength(c.group === 'all' ? 30 : 10);
    if (c.phase === 'intro') groups.push(c.group);
    else screens.push([c.group, c.rank]);
    expect(c.endsAt).toBeGreaterThanOrEqual(pub.t);
  });
  expect(groups).toEqual(['junior', 'middle', 'senior', 'all']);
  expect(screens).toEqual(['junior', 'middle', 'senior', 'all'].flatMap(group => [3, 2, 1].map(rank => [group, rank])));
  expect(final.displayView).toBe('leaderboard'); expect(final.tournament.resultAge).toBe('all'); expect(final.board).toHaveLength(30);
  await vi.advanceTimersByTimeAsync(1000); expect(state(server).displayView).toBe('leaderboard');
});

it('включает всех четырёх обладателей третьего места и не объявляет четвёртое', async () => {
  const server = boot('A\nB\nC\nD\nE\nF\nG', false);
  server.db.teams.forEach((team, i) => { team.score = [30, 20, 10, 10, 10, 10, 5][i]; });
  server.local('a:ceremony:start');
  const awards = [];
  await complete(server, pub => { if (pub.ceremony.phase === 'place') awards.push({ rank: pub.ceremony.rank, names: pub.ceremony.winners.map(w => w.name), shared: pub.ceremony.shared }); });
  expect(awards).toEqual([{ rank: 3, names: ['C', 'D', 'E', 'F'], shared: true }, { rank: 2, names: ['B'], shared: false }, { rank: 1, names: ['A'], shared: false }]);
  server.local('a:reveal:start', { mode: 'top3' });
  let pub = state(server); expect(pub.reveal.total - pub.reveal.start).toBe(6);
  for (let n = 0; n < 6; n++) server.local('a:reveal:next');
  expect(state(server).reveal.rows.map(r => r.name).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
});

it('при полной ничьей показывает все 30 команд страницами; пустые лиги пропускает', async () => {
  const server = boot(Array.from({ length: 30 }, (_, i) => `Команда-${i} | junior`).join('\n'));
  server.db.teams.forEach(team => { team.score = 10; });
  server.local('a:ceremony:start');
  const seen = { junior: [], all: [] };
  await complete(server, pub => {
    const c = pub.ceremony;
    expect(c.order).toEqual(['junior', 'all']);
    if (c.phase === 'place') { expect(c.rank).toBe(1); expect(c.shared).toBe(true); expect(c.pages).toBe(5); expect(c.winners.length).toBeLessThanOrEqual(6); seen[c.group].push(...c.winners.map(w => w.id)); }
  });
  for (const rows of Object.values(seen)) { expect(rows).toHaveLength(30); expect(new Set(rows).size).toBe(30); }
});

it('остановка и повторный запуск отменяют прежние таймеры; ручной экран не переключается сам', async () => {
  const server = boot('A | junior\nB | middle\nC | senior');
  server.local('a:ceremony:start'); await vi.advanceTimersByTimeAsync(5);
  server.local('a:ceremony:stop'); await vi.advanceTimersByTimeAsync(100);
  expect(state(server).ceremony.running).toBe(false); expect(server.db.log.some(e => e.type === 'ceremony.done')).toBe(false);
  server.local('a:ceremony:start'); await vi.advanceTimersByTimeAsync(5);
  server.local('a:ceremony:start'); await vi.advanceTimersByTimeAsync(5);
  expect(state(server).ceremony.phase).toBe('intro');
  await complete(server); expect(server.db.log.filter(e => e.type === 'ceremony.done')).toHaveLength(1);
  server.local('a:ceremony:start'); server.local('a:display:set', { view: 'closing' }); await vi.advanceTimersByTimeAsync(100);
  expect(state(server).displayView).toBe('closing'); expect(state(server).ceremony.running).toBe(false);
  server.local('a:ceremony:start');
  server.local('a:score:adjust', { id: server.db.teams[0].id, delta: 2 });
  expect(state(server).ceremony.running).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(server.db.log.filter(e => e.type === 'ceremony.done')).toHaveLength(1);
});

it('не запускает награждение без команд или до проверки ответов', () => {
  const server = boot('', false);
  expect(() => server.local('a:ceremony:start')).toThrow(/Нет команд/);
  server.local('a:team:create', { name: 'Тест' });
  server.db.quiz = { ...server.db.quiz, id: 'q', status: 'closed', answers: { [server.db.teams[0].id]: { teamId: server.db.teams[0].id, verdict: null } } };
  expect(() => server.local('a:ceremony:start')).toThrow(/проверьте/);
});
