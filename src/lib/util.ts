import { useEffect, useRef, useState } from 'react';
import type { TimerInfo } from './types';
import QRCode from 'qrcode';

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Базовый URL, по которому телефоны смогут открыть /play (не hardcode: берём LAN IP с сервера). */
export function useBaseUrl() {
  const [ips, setIps] = useState<string[]>([]);
  const [port, setPort] = useState<number>(Number(location.port) || 80);
  const [host, setHost] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // адрес ноутбука может смениться (другая Wi-Fi сеть) — перепроверяем, чтобы QR не вёл на старый IP
    const load = () => fetch('/api/info').then((r) => r.json()).then((j) => { setIps((old) => (JSON.stringify(old) === JSON.stringify(j.ips) ? old : j.ips)); setPort(j.port); setHost(j.host || ''); setLoaded(true); }).catch(() => setLoaded(true));
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);
  const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  const p = location.port || port;
  const options = isLocal ? [...ips.map((ip) => `http://${ip}:${p}`), ...(host ? [`http://${host}:${p}`] : [])] : [location.origin];
  // пока адрес не узнали — пусто: иначе на долю секунды появится QR на localhost, который телефон не откроет
  return { options: options.length ? options : loaded || !isLocal ? [location.origin] : [], isLocal, loaded };
}

/** Адрес для QR: тот, что ведущий выбрал в админке (сервер помнит), иначе первый сетевой адрес ноутбука. */
/** Порядок: адрес, вписанный ведущим вручную (если жив) → интернет-ссылка туннеля → адрес ноутбука в Wi-Fi. */
export function useJoinBase(saved?: string | null, tunnelUrl?: string | null) {
  const { options, isLocal } = useBaseUrl();
  const external = !!saved && /^https:/.test(saved) && !options.includes(saved);
  // внешняя ссылка (туннель) может умереть при смене сети — проверяем её раз в 15 с
  const [alive, setAlive] = useState(true);
  useEffect(() => {
    if (!external) { setAlive(true); return; }
    let stop = false;
    const check = () => fetch(`${saved}/api/health`, { mode: 'no-cors', cache: 'no-store' }).then(() => !stop && setAlive(true)).catch(() => !stop && setAlive(false));
    check();
    const id = setInterval(check, 15000);
    return () => { stop = true; clearInterval(id); };
  }, [saved, external]);
  const deadSaved = external && !alive;
  const stillValid = !!saved && !deadSaved && (options.includes(saved) || !isLocal || external);
  const base = stillValid ? saved! : tunnelUrl || (options[0] ?? '');
  // localhost открывается только на самом ноутбуке — для телефонов это не адрес
  const unreachable = !base || /\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(base);
  return { base, options, isLocal, unreachable, deadSaved };
}

export function useQr(text: string, dark = '#0B1020', light = '#F8FAFC'): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(text, { margin: 1, width: 640, color: { dark, light }, errorCorrectionLevel: 'M' })
      .then((u) => alive && setUrl(u)).catch(() => {});
    return () => { alive = false; };
  }, [text, dark, light]);
  return url;
}

export const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s));

/** Обратный отсчёт по серверному времени: разница часов сервера и клиента вычисляется при каждом state. */
export function useCountdown(timer: TimerInfo | null, serverT: number) {
  const off = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => { off.current = serverT - Date.now(); }, [serverT]);
  const endsAt = timer?.endsAt;
  useEffect(() => {
    if (!endsAt) return;
    const id = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [endsAt]);
  if (!timer) return null;
  const ms = Math.max(0, timer.endsAt - (Date.now() + off.current));
  return { ms, sec: Math.ceil(ms / 1000), frac: Math.min(1, ms / timer.durationMs), kind: timer.kind };
}
