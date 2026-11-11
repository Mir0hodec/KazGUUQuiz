import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createQuizServer } from '../server/app.js';

const servers = [], sockets = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64');
afterEach(async () => { sockets.splice(0).forEach(s => s.close()); for (const s of servers.splice(0)) await s.close(); });
const call = (s, event, payload = {}) => new Promise(resolve => s.emit(event, payload, resolve));
async function boot(file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-media-')), 'state.json')) {
  const srv = createQuizServer({ dataFile: file, host: '127.0.0.1', port: 0, staticDir: null, readSec: 0, adminPassword: 'test-media' });
  servers.push(srv); await srv.start();
  const base = `http://127.0.0.1:${srv.port}`;
  const admin = io(base, { transports: ['websocket'], reconnection: false }); sockets.push(admin);
  await new Promise(resolve => admin.on('connect', resolve));
  const { token } = await call(admin, 'a:login', { password: 'test-media' });
  const headers = { 'x-admin-token': token, 'Content-Type': 'application/octet-stream' };
  const upload = bytes => fetch(`${base}/api/media`, { method: 'POST', headers, body: bytes });
  return { srv, admin, base, headers, upload, file };
}

it('загрузка требует входа, проверяет формат/размер и отдаёт картинку без имени исходного файла', async () => {
  const ctx = await boot();
  expect((await fetch(`${ctx.base}/api/media`, { method: 'POST', body: png })).status).toBe(403);
  expect((await ctx.upload(Buffer.from('<svg onload="alert(1)"></svg>'))).status).toBe(400);
  expect((await ctx.upload(Buffer.alloc(8 * 1024 * 1024 + 1))).status).toBe(413);
  const one = await (await ctx.upload(png)).json();
  const two = await (await ctx.upload(png)).json();
  expect(one).toEqual(two); expect(one.image).toMatch(/^\/api\/media\/[a-f0-9]{64}\.png$/);
  const response = await fetch(ctx.base + one.image);
  expect(response.headers.get('content-type')).toContain('image/png');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect((await fetch(ctx.base + '/api/media/not-found.png')).status).toBe(404);
  expect((await call(ctx.admin, 'a:questions:set', { text: 'Вопрос | Ответ | | | | 1 | https://example.com/a.png' })).ok).toBe(false);
  expect((await call(ctx.admin, 'a:questions:set', { text: `Вопрос | Ответ | | | | 1 | /api/media/${'0'.repeat(64)}.png` })).ok).toBe(false);
});

it('изображения сохраняются в лигах, копиях, открытом вопросе, архиве и после перезапуска; ключ скрыт от участников', async () => {
  const ctx = await boot();
  const { image } = await (await ctx.upload(png)).json();
  expect((await call(ctx.admin, 'a:tournament:create', { name: 'Картинки', ageMode: true, teamNames: 'Младшие | junior\nСтаршие | senior', questions: `Что здесь? | Секрет | лёгкий | | 10 | 2 | ${image}` })).ok).toBe(true);
  const id = ctx.srv.db.activeId;
  expect((await call(ctx.admin, 'a:age:activate', { age: 'senior' })).ok).toBe(true);
  expect((await call(ctx.admin, 'a:questions:set', { text: `Старшая картинка? | Другой секрет | | | | 2 | ${image}` })).ok).toBe(true);
  await call(ctx.admin, 'a:age:activate', { age: 'junior' });
  await call(ctx.admin, 'a:quiz:open');
  const display = io(ctx.base, { auth: { role: 'display' }, transports: ['websocket'], reconnection: false }); sockets.push(display);
  const publicState = await new Promise(resolve => display.once('state', resolve));
  expect(publicState.quiz.image).toBe(image); expect(publicState.quiz.key).toBeUndefined(); expect(publicState.quiz.accept).toBeUndefined();
  await call(ctx.admin, 'a:quiz:close'); await call(ctx.admin, 'a:quiz:reset');
  expect(ctx.srv.db.history[0].image).toBe(image);
  await call(ctx.admin, 'a:tournament:create', { copyFrom: id, name: 'Копия' });
  expect(ctx.srv.db.ageQuestions.junior[0].image).toBe(image); expect(ctx.srv.db.ageQuestions.senior[0].image).toBe(image);
  await ctx.srv.close(); servers.splice(servers.indexOf(ctx.srv), 1);
  const reopened = await boot(ctx.file);
  expect(reopened.srv.db.ageQuestions.junior[0].image).toBe(image);
  expect((await fetch(reopened.base + image)).status).toBe(200);
  expect((await call(reopened.admin, 'a:questions:set', { text: 'Теперь без картинки | да' })).ok).toBe(true);
  expect(reopened.srv.db.ageQuestions.junior[0].image).toBeUndefined();
  expect(reopened.srv.db.ageQuestions.senior[0].image).toBe(image);
});

it('резервная копия переносит картинки на чистый сервер; повреждённый пакет не меняет турнир', async () => {
  const source = await boot();
  const { image } = await (await source.upload(png)).json();
  await call(source.admin, 'a:questions:set', { text: `Картинка? | да | | | | 1 | ${image}` });
  const backup = await (await fetch(source.base + '/api/data/export.json', { headers: source.headers })).json();
  expect(Object.keys(backup.media)).toHaveLength(1);
  const target = await boot(); const originalId = target.srv.db.activeId;
  const post = payload => fetch(target.base + '/api/data/import.json', { method: 'POST', headers: { ...target.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const bad = structuredClone(backup); bad.media[Object.keys(bad.media)[0]] = png.subarray(0, 20).toString('base64');
  expect((await post(bad)).status).toBe(400); expect(target.srv.db.activeId).toBe(originalId);
  expect((await post(backup)).status).toBe(200);
  expect(target.srv.db.questions[0].image).toBe(image);
  expect(Buffer.from(await (await fetch(target.base + image)).arrayBuffer())).toEqual(png);
});
