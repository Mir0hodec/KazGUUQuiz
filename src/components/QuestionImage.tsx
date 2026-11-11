import { useEffect, useRef, useState } from 'react';

export default function QuestionImage({ src, className = '', zoom = false }: { src: string; className?: string; zoom?: boolean }) {
  const [broken, setBroken] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { setBroken(false); dialog.current?.close(); }, [src]);
  if (broken) return <p role="status" className="text-warn text-sm p-3">Не удалось загрузить изображение. Сообщите ведущему.</p>;
  const img = <img src={src} alt="Изображение к вопросу" className={`object-contain ${className}`} onError={() => setBroken(true)} />;
  if (!zoom) return img;
  return <>
    <button type="button" className="block w-full cursor-zoom-in" aria-label="Увеличить изображение к вопросу" onClick={() => dialog.current?.showModal()}>{img}<span className="block text-xs text-muted mt-1">Нажмите, чтобы увеличить</span></button>
    <dialog ref={dialog} className="fixed m-auto max-w-[96vw] max-h-[94dvh] bg-ink text-snow p-3 border-2 border-snow/30 backdrop:bg-black/80" onClick={e => { if (e.target === e.currentTarget) dialog.current?.close(); }}>
      <button type="button" autoFocus className="block ml-auto px-4 py-2 font-bold" onClick={() => dialog.current?.close()}>Закрыть ×</button>
      <img src={src} alt="Увеличенное изображение к вопросу" className="object-contain max-w-full max-h-[78dvh]" />
    </dialog>
  </>;
}
