// O que o runner do pipeline do Orca espera do usuário (gate, recuperação, MR para abrir), por tarefa. Quem lê é o
// auxiliar do host (scripts/codex-bridge.ts): os state.json ficam em _pipeline/.local/tasks/, que o container nunca vê,
// e o hash do gate vem de `pipeline.py gate`, só leitura. O servidor guarda a última foto (POST /api/host/pipeline) e
// a põe no snapshot, na sala da funcionalidade.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelinePending } from '../../shared/types';

/** Uma foto vale por este tempo: auxiliar parado = ninguém sabe mais o estado. */
export const PIPELINE_STALE_MS = 3 * 60_000;
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HASH = /^[0-9a-f]{8,64}$/;
const TEXT_MAX = 240;

export class PipelineStatus {
  private items: PipelinePending[] = [];
  private at = -Infinity;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Foto nova do auxiliar. Devolve true se algo mudou. */
  set(raw: unknown): boolean {
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { pending?: unknown }).pending) ? (raw as { pending: unknown[] }).pending : [];
    const next = list.map(parsePending).filter((p): p is PipelinePending => !!p);
    const changed = JSON.stringify(next) !== JSON.stringify(this.items) || !this.fresh();
    this.items = next;
    this.at = this.now();
    return changed;
  }

  fresh(): boolean {
    return this.now() - this.at <= PIPELINE_STALE_MS;
  }

  /** O que espera o usuário agora (vazio se o auxiliar parou de mandar). */
  list(): PipelinePending[] {
    return this.fresh() ? this.items.map((p) => ({ ...p })) : [];
  }
}

function str(v: unknown, max = TEXT_MAX): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

export function parsePending(raw: unknown): PipelinePending | undefined {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const task = str(r?.task, 80);
  const kind = r?.kind;
  if (!task || !TASK_ID.test(task) || (kind !== 'cp1' && kind !== 'prototype' && kind !== 'blocked' && kind !== 'draft')) return undefined;
  const p: PipelinePending = { task, kind };
  const entrega = str(r?.entrega, 80);
  if (entrega && TASK_ID.test(entrega)) p.entrega = entrega;
  const hash = str(r?.hash, 64);
  if (hash && HASH.test(hash)) p.hash = hash;
  const reason = str(r?.reason);
  if (reason) p.reason = reason;
  const since = r?.since;
  if (typeof since === 'number' && Number.isFinite(since)) p.since = since;
  return p;
}

/** A linha que o usuário manda na sessão interativa dele para resolver (o hook do pipeline registra). */
export function pendingCommand(p: PipelinePending): string | undefined {
  const target = p.entrega ?? p.task;
  if (p.kind === 'cp1' && p.hash) return `APROVAR CP1 ${target} ${p.hash.slice(0, 10)}`;
  if (p.kind === 'prototype' && p.hash) return `APROVAR PROTOTIPO ${target} ${p.hash.slice(0, 10)}`;
  if (p.kind === 'blocked') return `RECUPERAR ${target}`;
  return undefined;
}

// ---------------------------------------------------------------- lado do host (auxiliar)

export interface ReadPipelineDeps {
  /** A pasta _pipeline. */
  dir: string;
  readDir?: (d: string) => string[];
  readFile?: (f: string) => string;
  exists?: (p: string) => boolean;
  /** `python3 scripts/pipeline.py gate <alvo>` (só leitura); ausente = sem hash. */
  gate?: (target: string) => Promise<{ combined_hash?: string } | undefined>;
}

function readJson(file: string, read: (f: string) => string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(read(file)) as unknown;
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `pipeline.py gate <alvo>`, só leitura, com prazo. */
export function createGateReader(dir: string, python = 'python3', timeoutMs = 20_000): (target: string) => Promise<{ combined_hash?: string } | undefined> {
  return (target) =>
    new Promise((ok) => {
      if (!TASK_ID.test(target)) return ok(undefined);
      execFile(python, [join(dir, 'scripts', 'pipeline.py'), 'gate', target], { cwd: join(dir, '..'), timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) return ok(undefined);
        try {
          ok(JSON.parse(String(stdout)) as { combined_hash?: string });
        } catch {
          ok(undefined);
        }
      });
    });
}

/** Lê o estado de cada tarefa do runner e devolve o que espera o usuário. Nunca lança. */
export async function readPipelinePending(deps: ReadPipelineDeps): Promise<PipelinePending[]> {
  const readDir = deps.readDir ?? ((d: string) => readdirSync(d));
  const readFile = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
  const exists = deps.exists ?? existsSync;
  const local = join(deps.dir, '.local', 'tasks');
  let tasks: string[] = [];
  try {
    tasks = readDir(local).filter((t) => TASK_ID.test(t)).sort();
  } catch {
    return [];
  }
  const out: PipelinePending[] = [];
  const hashes = new Map<string, string | undefined>();
  for (const task of tasks) {
    const statePath = join(local, task, 'state.json');
    if (!exists(statePath)) continue;
    const st = readJson(statePath, readFile);
    const phase = typeof st?.phase === 'string' ? st.phase : '';
    const kind: PipelinePending['kind'] | undefined =
      phase === 'awaiting_CP1' ? 'cp1' : phase === 'awaiting_PROTOTIPO' ? 'prototype' : phase === 'blocked' ? 'blocked' : phase === 'ready_for_draft' ? 'draft' : undefined;
    if (!kind) continue;
    const manifest = readJson(join(deps.dir, 'tarefas', task, 'task.json'), readFile);
    const entrega = typeof manifest?.entrega === 'string' && TASK_ID.test(manifest.entrega) ? manifest.entrega : undefined;
    const p: PipelinePending = { task, kind };
    if (entrega) p.entrega = entrega;
    if (kind === 'blocked') {
      const why = [typeof st?.blocked_phase === 'string' ? st.blocked_phase : '', typeof st?.reason === 'string' ? st.reason : ''].filter(Boolean).join(': ');
      if (why) p.reason = why.slice(0, TEXT_MAX);
    }
    if ((kind === 'cp1' || kind === 'prototype') && deps.gate) {
      const target = entrega ?? task;
      if (!hashes.has(target)) hashes.set(target, (await deps.gate(target).catch(() => undefined))?.combined_hash);
      const h = hashes.get(target);
      if (h && HASH.test(h)) p.hash = h;
    }
    out.push(p);
  }
  return out;
}
