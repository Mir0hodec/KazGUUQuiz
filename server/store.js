import fs from 'node:fs';
import path from 'node:path';

/**
 * Локальное хранилище: state.json (атомарная запись через tmp+rename)
 * и append-only журнал state.log.jsonl. file=null → только память (тесты).
 */
export function createStore(file, { debounceMs = 250 } = {}) {
  const logFile = file ? file.replace(/\.json$/, '') + '.log.jsonl' : null;
  let getter = null;
  let timer = null;
  let logTimer = null;
  let logBuf = [];
  let stateDelay = debounceMs; // растёт, если запись состояния дорогая (большой турнир)

  function ensureDir() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  function load() {
    if (!file) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      // копируем только успешно прочитанное состояние: иначе повреждённый файл затирал бы хорошую копию
      try { fs.copyFileSync(file, `${file}.bak`); } catch { /* резервная копия необязательна */ }
      return data;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const bad = `${file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(file, bad); } catch { /* ignore */ }
        console.error(`[store] state повреждён (${e.message}); копия: ${bad}`);
      }
      return null;
    }
  }

  function loadLog(max = Infinity) {
    if (!logFile) return [];
    try {
      const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
      const out = [];
      for (const l of lines.slice(-max)) {
        try { out.push(JSON.parse(l)); } catch { /* битая строка */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  function writeState() {
    if (!file || !getter) return;
    try {
      const t0 = performance.now();
      ensureDir();
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getter()));
      fs.renameSync(tmp, file);
      // запись не должна занимать больше ~10% времени сервера: дорогая запись → реже
      stateDelay = Math.min(3000, Math.max(debounceMs, Math.round((performance.now() - t0) * 10)));
    } catch (e) {
      console.error('[store] не удалось сохранить state:', e.message);
    }
  }

  function flushLog() {
    if (!logFile || !logBuf.length) return;
    const chunk = logBuf.join('');
    logBuf = [];
    try {
      ensureDir();
      fs.appendFileSync(logFile, chunk);
    } catch (e) {
      console.error('[store] не удалось записать журнал:', e.message);
    }
  }

  return {
    load,
    loadLog,
    /** Запланировать сохранение (getter вызывается в момент записи). */
    save(fn) {
      getter = fn;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        writeState();
        flushLog();
      }, stateDelay);
    },
    /** Журнал дописывается отдельно и часто (каждые ~200 мс): это дёшево и не ждёт дорогой записи состояния. */
    appendLog(entry) {
      if (!logFile) return;
      logBuf.push(JSON.stringify(entry) + '\n');
      if (!logTimer) logTimer = setTimeout(() => { logTimer = null; flushLog(); }, 200);
    },
    /** Резервная копия состояния в <data>/backups (хранятся последние 60). Возвращает имя файла. */
    backup(tag = 'manual') {
      if (!file) return null;
      this.flush();
      try {
        const dir = path.join(path.dirname(file), 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const name = `state-${new Date().toISOString().replace(/[:.]/g, '-')}-${String(tag).replace(/[^\w-]/g, '')}.json`;
        fs.copyFileSync(file, path.join(dir, name));
        if (fs.existsSync(logFile)) fs.copyFileSync(logFile, path.join(dir, name.replace(/\.json$/, '.log.jsonl')));
        const all = fs.readdirSync(dir).filter((f) => f.startsWith('state-') && f.endsWith('.json')).sort();
        for (const old of all.slice(0, Math.max(0, all.length - 60))) { fs.unlinkSync(path.join(dir, old)); const oldLog = path.join(dir, old.replace(/\.json$/, '.log.jsonl')); if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog); }
        return name;
      } catch (e) {
        console.error('[store] не удалось сделать резервную копию:', e.message);
        return null;
      }
    },
    /** Заменяет оба файла с откатом при ошибке; резервная копия создаётся вызывающей стороной. */
    replace(state, entries) {
      if (!file) return;
      this.flush();
      ensureDir();
      const oldState = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const oldLog = fs.existsSync(logFile) ? fs.readFileSync(logFile) : null;
      const stateTmp = `${file}.import.tmp`; const logTmp = `${logFile}.import.tmp`;
      try {
        fs.writeFileSync(stateTmp, JSON.stringify(state));
        fs.writeFileSync(logTmp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
        fs.renameSync(logTmp, logFile);
        fs.renameSync(stateTmp, file);
      } catch (e) {
        if (oldState === null) { if (fs.existsSync(file)) fs.unlinkSync(file); } else fs.writeFileSync(file, oldState);
        if (oldLog === null) { if (fs.existsSync(logFile)) fs.unlinkSync(logFile); } else fs.writeFileSync(logFile, oldLog);
        throw e;
      } finally {
        for (const f of [stateTmp, logTmp]) if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    },
    /** Синхронный сброс на диск (перед выходом). */
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (logTimer) { clearTimeout(logTimer); logTimer = null; }
      writeState();
      flushLog();
    },
  };
}
