// Encerrar uma sessão do Claude Code pelo escritório, com o Habblaud no Docker (o container não vê os processos do
// computador). O pedido fica na fila; o auxiliar do host (scripts/codex-bridge.ts) busca em POST /api/host/stop/poll,
// encerra e confirma em POST /api/host/stop/ack. Quem encerra acha a sessão no registro dela
// (<conta>/sessions/<pid>.json) pelo sessionId, nunca por um PID vindo do servidor:
// - sessão em segundo plano (`kind: "bg"`, a do "Novo agente" ou do `claude --bg`): `claude stop <jobId>`, com o
//   CLAUDE_CONFIG_DIR da conta. A conversa fica guardada (`claude attach <jobId>` abre de novo);
// - sessão num terminal: SIGTERM no PID do registro, só depois de conferir que ele ainda é aquele Claude Code (início
//   do processo e nome do executável, pty/procinfo.ts). A conversa fica no transcript, como num /exit.
// No modo Node o terminal interativo já tem o "Encerrar" (pty/manager.ts): este serviço é só do Docker.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';
import { isDefaultDir } from '../accounts/detect';
import { readProcInfo, sameProcess, type ProcInfo } from '../pty/procinfo';
import { parseRegistryEntry, type RegistryEntry } from '../sources/registry';
import { HOST_PRESENCE_MS } from './spawn';

export type StopStatus = 'queued' | 'sent' | 'stopped' | 'failed';
/** Como o auxiliar encerrou: `claude stop` (segundo plano) ou sinal no processo (terminal). */
export type StopHow = 'job' | 'signal';

/** De quem é a sessão: Claude Code (registro em <conta>/sessions) ou Antigravity (processo agy da conversa). */
export type StopProvider = 'claude' | 'antigravity';

export interface StopInfo {
  id: string;
  sessionId: string;
  provider?: StopProvider;
  status: StopStatus;
  how?: StopHow;
  error?: string;
}

export interface PolledStop {
  id: string;
  sessionId: string;
  provider?: StopProvider;
}

export type StopSubmit = { stop: StopInfo } | { error: 'invalid' | 'unavailable' | 'busy'; reason: string };

/** Prazo do `claude stop` (ele fala com o serviço de segundo plano e espera a sessão sair). */
export const STOP_CLI_TIMEOUT_MS = 20_000;
export const STOP_QUEUED_TIMEOUT_MS = 30_000;
export const STOP_SENT_TIMEOUT_MS = STOP_CLI_TIMEOUT_MS + 10_000;
const KEEP_MS = 10 * 60_000;
const ERROR_MAX = 300;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

interface Entry {
  info: StopInfo;
  at: number;
}

export interface StopServiceOptions {
  now?: () => number;
  newId?: () => string;
}

export class StopService {
  private readonly entries = new Map<string, Entry>();
  private hostSeenAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly opts: StopServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** O auxiliar do host passou há pouco. */
  available(): boolean {
    return this.now() - this.hostSeenAt <= HOST_PRESENCE_MS;
  }

  submit(sessionId: string, provider: StopProvider = 'claude'): StopSubmit {
    this.prune();
    if (!SESSION_ID.test(sessionId)) return { error: 'invalid', reason: tr('sessão inválida') };
    if (!this.available()) {
      return { error: 'unavailable', reason: tr('o auxiliar do computador não está rodando: deixe npm run codex:bridge no ar (o Habblaud está no Docker)') };
    }
    for (const e of this.entries.values()) {
      if (e.info.sessionId === sessionId && (e.info.status === 'queued' || e.info.status === 'sent')) return { stop: { ...e.info } };
    }
    const info: StopInfo = { id: this.opts.newId?.() ?? randomUUID(), sessionId, ...(provider !== 'claude' ? { provider } : {}), status: 'queued' };
    this.entries.set(info.id, { info, at: this.now() });
    return { stop: { ...info } };
  }

  get(id: string): StopInfo | undefined {
    this.prune();
    const e = this.entries.get(id);
    return e && { ...e.info };
  }

  /** Rodada do auxiliar: marca presença e entrega os pedidos na fila. */
  poll(): PolledStop[] {
    this.hostSeenAt = this.now();
    this.prune();
    const out: PolledStop[] = [];
    for (const e of this.entries.values()) {
      if (e.info.status !== 'queued') continue;
      e.info.status = 'sent';
      e.at = this.now();
      out.push({ id: e.info.id, sessionId: e.info.sessionId, ...(e.info.provider ? { provider: e.info.provider } : {}) });
    }
    return out;
  }

  ack(raw: unknown): void {
    this.hostSeenAt = this.now();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const e = typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      if (!e || e.info.status !== 'sent') continue;
      if (x.ok === true) {
        e.info.status = 'stopped';
        e.info.how = x.how === 'job' ? 'job' : 'signal';
      } else {
        e.info.status = 'failed';
        e.info.error = typeof x.error === 'string' && x.error ? x.error.slice(0, ERROR_MAX) : tr('o auxiliar não encerrou a sessão');
      }
      e.at = this.now();
    }
  }

  private fail(e: Entry, error: string): void {
    e.info.status = 'failed';
    e.info.error = error;
    e.at = this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const age = now - e.at;
      if (e.info.status === 'queued' && age > STOP_QUEUED_TIMEOUT_MS) this.fail(e, tr('o auxiliar do computador não buscou o pedido'));
      else if (e.info.status === 'sent' && age > STOP_SENT_TIMEOUT_MS) this.fail(e, tr('o auxiliar do computador não confirmou'));
      else if ((e.info.status === 'stopped' || e.info.status === 'failed') && age > KEEP_MS) this.entries.delete(id);
    }
  }
}

// ---------------------------------------------------------------- lado do host (auxiliar)

export type StopResult = { ok: true; how: StopHow } | { ok: false; error: string };

export interface HostStopDeps {
  /** Pastas das contas do Claude Code no computador (discoverClaudeDirs). */
  accountDirs: readonly string[];
  home: string;
  /** Binário do claude (ausente: sessões em segundo plano não dão para encerrar). */
  claudeBin?: string;
  readDir?: (dir: string) => string[];
  readFile?: (file: string) => string;
  procInfo?: (pid: number) => Promise<ProcInfo | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  runStop?: (bin: string, jobId: string, env: NodeJS.ProcessEnv) => Promise<{ ok: true } | { ok: false; error: string }>;
  env?: NodeJS.ProcessEnv;
}

/** A sessão no registro de alguma conta (o arquivo mais novo, se houver mais de um). */
export function findSession(sessionId: string, deps: HostStopDeps): { entry: RegistryEntry; accountDir: string } | undefined {
  const readDir = deps.readDir ?? ((d: string) => readdirSync(d));
  const readFile = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
  let best: { entry: RegistryEntry; accountDir: string } | undefined;
  for (const dir of deps.accountDirs) {
    let files: string[] = [];
    try {
      files = readDir(join(dir, 'sessions')).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      let raw: string;
      try {
        raw = readFile(join(dir, 'sessions', f));
      } catch {
        continue;
      }
      if (!raw.includes(sessionId)) continue;
      const entry = parseRegistryEntry(raw);
      if (entry?.sessionId !== sessionId) continue;
      if (!best || (entry.startedAt ?? 0) > (best.entry.startedAt ?? 0)) best = { entry, accountDir: dir };
    }
  }
  return best;
}

function defaultRunStop(bin: string, jobId: string, env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((ok) => {
    execFile(bin, ['stop', jobId], { env, timeout: STOP_CLI_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return ok({ ok: true });
      const why = String(stderr || '').trim().split('\n').pop() || err.message;
      ok({ ok: false, error: tr('claude stop falhou: {0}', [why]).slice(0, ERROR_MAX) });
    });
  });
}

/** Encerra a sessão do Claude Code `sessionId` neste computador. Nunca lança. */
export async function stopSession(sessionId: string, deps: HostStopDeps): Promise<StopResult> {
  if (!SESSION_ID.test(sessionId)) return { ok: false, error: tr('sessão inválida') };
  const found = findSession(sessionId, deps);
  if (!found) return { ok: false, error: tr('a sessão não está aberta neste computador (sem registro em <conta>/sessions)') };
  const { entry, accountDir } = found;
  if (entry.kind === 'bg' && entry.jobId) {
    if (!deps.claudeBin) return { ok: false, error: tr('sem o claude no PATH (ou HABBLAUD_CLAUDE_BIN) para encerrar a sessão em segundo plano') };
    const env = { ...(deps.env ?? process.env) };
    // A conta padrão roda sem CLAUDE_CONFIG_DIR, como o `claude` puro (o mesmo cuidado do mod-install).
    if (isDefaultDir(accountDir, deps.home)) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = accountDir;
    const r = await (deps.runStop ?? defaultRunStop)(deps.claudeBin, entry.jobId, env);
    return r.ok ? { ok: true, how: 'job' } : r;
  }
  const info = await (deps.procInfo ?? ((pid: number) => readProcInfo(pid)))(entry.pid);
  if (!info) return { ok: false, error: tr('o processo da sessão já não existe') };
  if (!sameProcess({ startedAt: entry.startedAt, procStart: entry.procStart }, info)) {
    return { ok: false, error: tr('o PID do registro agora é outro processo: nada foi encerrado') };
  }
  try {
    (deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig)))(entry.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: tr('não consegui encerrar o processo: {0}', [(err as Error).message]).slice(0, ERROR_MAX) };
  }
  return { ok: true, how: 'signal' };
}


// ---------------------------------------------------------------- Antigravity (agy)
// O agy não tem registro de sessões como o Claude Code. Cada processo `agy` grava o próprio log
// (~/.gemini/antigravity-cli/log/cli-<data>.log, aberto por ele), onde o id da conversa (cascade_id = pasta em brain/,
// o sessionId que o Habblaud mostra) aparece quando a conversa começa. O processo da conversa é o agy do usuário cujo
// log aberto cita o id. Nunca toca no agy headless (`-p`: o runner do pipeline e afins) nem em processo com as
// variáveis do runner; com mais de um candidato, não encerra nenhum. Antes do SIGTERM, confere de novo que o PID é
// o mesmo processo (início e nome), como no Claude.

const AGY_LOG = /\/antigravity-cli\/log\/cli-[^/]+\.log$/;
const AGY_HEADLESS = (arg: string) => arg === '-p' || arg.startsWith('-p=') || arg === '--print';
const RUNNER_ENV = /(?:^|\0)PIPELINE_(?:PHASE|RUN_DIR)=/;

export interface AgyStopDeps {
  /** Raiz do procfs (padrão /proc). */
  procRoot?: string;
  readDir?: (dir: string) => string[];
  readFile?: (file: string) => string;
  readLink?: (path: string) => string;
  /** Dono do processo (uid do arquivo em /proc/<pid>). */
  ownerOf?: (path: string) => number;
  uid?: number;
  procInfo?: (pid: number) => Promise<ProcInfo | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/** O processo agy interativo do usuário que está na conversa `conversationId`, ou o motivo de não achar um só. */
export function findAgyProcess(conversationId: string, deps: AgyStopDeps = {}): { pid: number } | { error: string } {
  const root = deps.procRoot ?? '/proc';
  const readDir = deps.readDir ?? ((d: string) => readdirSync(d));
  const readFile = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
  const readLink = deps.readLink ?? ((p: string) => readlinkSync(p));
  const ownerOf = deps.ownerOf ?? ((p: string) => statSync(p).uid);
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  let pids: string[] = [];
  try {
    pids = readDir(root).filter((n) => /^\d+$/.test(n));
  } catch {
    return { error: tr('sem acesso à lista de processos deste computador') };
  }
  const found: number[] = [];
  for (const pid of pids) {
    const dir = join(root, pid);
    try {
      if (readFile(join(dir, 'comm')).trim() !== 'agy' || ownerOf(dir) !== uid) continue;
      if (readFile(join(dir, 'cmdline')).split('\0').some(AGY_HEADLESS)) continue;
      if (RUNNER_ENV.test(readFile(join(dir, 'environ')))) continue;
      const logs = readDir(join(dir, 'fd'))
        .map((fd) => {
          try {
            return readLink(join(dir, 'fd', fd));
          } catch {
            return '';
          }
        })
        .filter((target) => AGY_LOG.test(target));
      if (logs.some((log) => readFile(log).includes(conversationId))) found.push(Number(pid));
    } catch {
      // processo saiu no meio da leitura, ou não é nosso: ignora
    }
  }
  if (found.length === 1) return { pid: found[0]! };
  if (!found.length) return { error: tr('o agy dessa conversa não está rodando neste computador') };
  return { error: tr('mais de um agy cita essa conversa: nada foi encerrado') };
}

/** Encerra o agy interativo da conversa `conversationId` neste computador (SIGTERM conferido). Nunca lança. */
export async function stopAgySession(conversationId: string, deps: AgyStopDeps = {}): Promise<StopResult> {
  if (!SESSION_ID.test(conversationId)) return { ok: false, error: tr('sessão inválida') };
  const first = findAgyProcess(conversationId, deps);
  if ('error' in first) return { ok: false, error: first.error };
  const procInfo = deps.procInfo ?? ((pid: number) => readProcInfo(pid));
  const before = await procInfo(first.pid);
  if (!before) return { ok: false, error: tr('o processo da sessão já não existe') };
  // Logo antes do sinal: o mesmo PID ainda é o agy da conversa, com o mesmo início.
  const again = findAgyProcess(conversationId, deps);
  const after = await procInfo(first.pid);
  if ('error' in again || again.pid !== first.pid || !after || after.startMs !== before.startMs || after.name !== 'agy') {
    return { ok: false, error: tr('o processo mudou durante a conferência: nada foi encerrado') };
  }
  try {
    (deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig)))(first.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: tr('não consegui encerrar o processo: {0}', [(err as Error).message]).slice(0, ERROR_MAX) };
  }
  return { ok: true, how: 'signal' };
}
