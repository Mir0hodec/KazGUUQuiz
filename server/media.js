import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FILE = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
export const imageName = url => typeof url === 'string' && url.startsWith('/api/media/') && FILE.test(url.slice(11)) ? url.slice(11) : null;
export const validImage = url => url == null || url === '' || !!imageName(url);

function inspect(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Изображение должно быть не больше 8 МБ');
  let ext;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = 'png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ext = 'jpg';
  else if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) ext = 'gif';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
  else throw new Error('Поддерживаются изображения PNG, JPEG, WebP и GIF');
  return `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
}

// Файлы общие для всех турниров: копирование вопроса не создаёт дубликат картинки.
// Не удаляем файлы при снятии картинки с вопроса: она может быть нужна другой копии или резервной копии.
export function createMediaStore(dir) {
  const memory = new Map();
  const has = name => FILE.test(name) && (dir ? fs.existsSync(path.join(dir, name)) : memory.has(name));
  const read = name => {
    if (!has(name)) throw new Error('Изображение не найдено');
    return dir ? fs.readFileSync(path.join(dir, name)) : memory.get(name);
  };
  const put = bytes => {
    const name = inspect(bytes);
    if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' }); }
    else memory.set(name, bytes);
    return `/api/media/${name}`;
  };
  const save = bytes => {
    const name = inspect(bytes);
    return has(name) ? `/api/media/${name}` : put(bytes);
  };
  const references = state => {
    const names = new Set();
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, v] of Object.entries(value)) {
        if (key === 'image' && v) {
          const name = imageName(v);
          if (!name) throw new Error('Некорректная ссылка на изображение');
          names.add(name);
        } else if (v && typeof v === 'object') visit(v);
      }
    };
    visit(state);
    return names;
  };
  return {
    has, read, save,
    assert(url) { if (!validImage(url) || (url && !has(imageName(url)))) throw new Error('Изображение не найдено. Загрузите его заново'); },
    export(state) { return Object.fromEntries([...references(state)].map(name => [name, read(name).toString('base64')])); },
    // Проверяем весь пакет до изменения данных. Старые резервные копии без картинок тоже поддерживаются.
    prepareImport(state, media = {}) {
      if (!media || typeof media !== 'object' || Array.isArray(media)) throw new Error('Некорректный набор изображений');
      const pending = new Map();
      for (const [name, encoded] of Object.entries(media)) {
        if (!FILE.test(name) || typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Некорректное изображение в резервной копии');
        const bytes = Buffer.from(encoded, 'base64');
        if (inspect(bytes) !== name) throw new Error('Повреждено изображение в резервной копии');
        pending.set(name, bytes);
      }
      for (const name of references(state)) if (!pending.has(name) && !has(name)) throw new Error('В резервной копии отсутствует изображение');
      return () => { for (const bytes of pending.values()) save(bytes); };
    },
  };
}
