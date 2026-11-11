export type Status = 'idle' | 'open' | 'buzzed' | 'locked' | 'judged';
/** 'qr' — устаревший алиас 'start': отдельного «второго» экрана QR больше нет, оба режима показывают одну арену. */
export type DisplayView = 'start' | 'qr' | 'auto' | 'leaderboard' | 'final' | 'closing' | 'reveal' | 'splash' | 'sponsors' | 'record' | 'flag';
export type Age = 'junior' | 'middle' | 'senior';

export interface BoardRow { id: string; name: string; score: number; rank: number; age: Age | null; correct?: number; timeMs?: number | null }
export interface RevealState { active: boolean; mode: 'all' | 'top3' | 'top10'; start: number; shown: number; total: number; done: boolean; rows: BoardRow[] }
export interface Verdict { teamId: string; name: string; correct: boolean; points: number }

export interface TimerInfo { kind: 'open' | 'quiz' | 'answer' | 'pause' | 'result' | 'read'; endsAt: number; durationMs: number }

export interface PublicState {
  t: number;
  tournament: { name: string; round: number; question: number; ageMode?: boolean; age?: Age; resultAge?: Age | 'all'; progress?: Partial<Record<Age, { question: number; round: number }>> };
  status: Status;
  roundId: string | null;
  answerer: { id: string; name: string } | null;
  verdict: Verdict | null;
  excluded: string[];
  timer: TimerInfo | null;
  questionText: string;
  questionImage?: string | null;
  questionMeta: { difficulty: 'easy' | 'medium' | 'hard' | null; points: number };
  auto: { running: boolean; mode: 'quiz' | 'buzz'; phase: 'idle' | 'question' | 'pause' | 'blockbreak' | 'review'; next: number | null; nextAge?: Age | null; finished: boolean; total: number; doneBlock: number | null };
  quiz: { id: string | null; status: 'idle' | 'open' | 'closed'; reading?: boolean; question: string; image?: string | null; answeredCount: number; options: string[]; difficulty: 'easy' | 'medium' | 'hard' | null; points: number | null; block: number };
  teams?: { id: string; name: string; age: Age | null }[]; // только в состоянии админа
  reveal: RevealState;
  displayView: DisplayView;
  joinBase?: string | null;
  watermark?: Watermark;
  tunnel?: { status: 'off' | 'missing' | 'starting' | 'checking' | 'ready' | 'restarting' | 'error'; url: string | null; error: string | null };
  ceremony?: { running: boolean; group: Age | 'all' | null; step: number; total: number; order?: (Age | 'all')[]; phase?: 'idle' | 'intro' | 'place'; rank?: number | null; winners?: BoardRow[]; page?: number; pages?: number; shared?: boolean; nextRank?: number | null; nextGroup?: Age | 'all' | null; endsAt?: number | null; durationMs?: number };
  board: BoardRow[];
  boards?: Record<Age, BoardRow[]>;
  activeTeamCount?: number;
  points: { correct: number; wrong: number };
  online: number;
  teamCount: number;
}

export interface AdminTeam { id: string; name: string; pin: string; score: number; disabled: boolean; connected: boolean; rtt: number | null; age: Age | null }
export interface BuzzRec { teamId: string; teamName: string; order: number; kind: 'first' | 'queued'; ts: number; mono: number; delta: number; source: string }
export interface LogEntry { id: number; ts: string; t: number; type: string; data: Record<string, unknown> }

export interface QuizAnswer { teamId: string; teamName: string; text: string; choice: number | null; ts: number; mono: number; verdict: boolean | null; points: number; delivery: number | null }
export interface TeamStat { teamId: string; name: string; age: Age | null; score: number; answered: number; correct: number; timeCorrectMs: number; timeAllMs: number; avgAnswerMs: number | null; avgDeliveryMs: number | null; perBlock: Record<string, { points: number; correct: number }> }

export interface TournamentRules { correctPoints: number; wrongPoints: number; quizSec: number; readSec: number; autoGrade: boolean; showQuestion: boolean; ageMode: boolean }
export interface TournamentItem { id: string; name: string; teams: number; round: number; question: number; questions: number; demo: boolean; createdAt: number; active: boolean; rules?: TournamentRules }
export interface QuestionItem { q: string; a: string; image?: string | null; accept?: string[]; options?: string[]; correct?: number; difficulty?: 'easy' | 'medium' | 'hard' | null; points?: number | null; sec?: number | null; block?: number }

export interface AdminState {
  tournaments: TournamentItem[];
  activeId: string;
  ageGroups: { age: Age; questions: number; teams: number; online: number; question: number; finished: boolean }[];
  questions: QuestionItem[];
  sim: { running: boolean; lines: string[]; startedAt: number | null; cfg: Record<string, number> | null };
  quizAnswers: QuizAnswer[];
  quizMeta: { options: string[]; correct: number; key: string; points: number | null; difficulty: string | null; block: number };
  stats: TeamStat[];
  blocks: number[];
  historyCount: number;
  pub: PublicState;
  settings: { readSec?: number; strictGrade?: boolean; correctPoints: number; wrongPoints: number; queueWindowMs: number; openSec: number; quizSec: number; answerSec: number; showQuestion: boolean; pauseSec: number; autoGrade: boolean; resultSec: number; blockBreak: boolean; difficultyPoints: { easy: number; medium: number; hard: number }; difficultyTiming: boolean; difficultySec: { easy: number; medium: number; hard: number } };
  demo: boolean;
  teams: AdminTeam[];
  buzzes: BuzzRec[];
  answererIdx: number;
  canPass: boolean;
  log: LogEntry[];
  info: { port: number; ips: string[] };
}

/** Вызов админ-события через сокет: ответ сервера с подтверждением. */
export type Call = (ev: string, payload?: unknown) => Promise<{ ok: boolean; error?: string }>;

export type Watermark = { on: boolean; text: string; size: number; corner: 'br' | 'bl' | 'tr' | 'tl'; x: number; y: number; opacity: number };
