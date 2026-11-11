import { io, type Socket } from 'socket.io-client';

/** Только WebSocket (без polling-апгрейда) — минимальная задержка; быстрый авто-реконнект. */
export function createSocket(auth?: Record<string, unknown> | ((cb: (d: Record<string, unknown>) => void) => void)): Socket {
  return io({
    transports: ['websocket', 'polling'],
    tryAllTransports: true, // websocket заблокирован (прокси, туннель, старый браузер) — переходим на опрос
    auth,
    reconnection: true,
    reconnectionDelay: 250,
    reconnectionDelayMax: 1500,
    randomizationFactor: 0.2,
    timeout: 5000,
  });
}

export function emitAck<T = Record<string, unknown>>(s: Socket, ev: string, payload: unknown = {}): Promise<T & { ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!s.connected) return resolve({ ok: false, error: 'Нет связи с сервером' } as never);
    const t = setTimeout(() => resolve({ ok: false, error: 'Сервер не ответил' } as never), 5000);
    s.emit(ev, payload, (r: never) => { clearTimeout(t); resolve(r); });
  });
}
