import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

describe('хранилище состояния', () => {
  it('повреждённый state.json не затирает последнюю хорошую копию .bak', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-store-'));
    const file = path.join(dir, 'state.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 1, name: 'турнир' }));
      const store = createStore(file);
      expect(store.load()).toMatchObject({ version: 1, name: 'турнир' });
      expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).name).toBe('турнир');

      fs.writeFileSync(file, '{ это не json');
      expect(store.load()).toBe(null);
      // копия осталась от последнего успешного чтения, а не от повреждённого файла
      expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).name).toBe('турнир');
      expect(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
