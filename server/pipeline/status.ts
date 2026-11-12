// O que o runner do pipeline do Orca espera do usuário (gate, recuperação, MR para abrir), por tarefa. Quem lê é o
// auxiliar do host (scripts/codex-bridge.ts): os state.json ficam em _pipeline/.local/tasks/, que o container nunca vê,
// e o hash do gate vem de `pipeline.py gate`, só leitura. O servidor guarda a última foto (POST /api/host/pipeline) e
// a põe no snapshot, na sala da funcionalidade.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineLink, PipelinePending } from '../../shared/types';

/** Uma foto vale por este tempo: auxiliar parado = ninguém sabe mais o estado. */
export const PIPELINE_STALE_MS = 3 * 60_000;
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HASH = /^[0-9a-f]{8,64}$/;
const TEXT_MAX = 240;
const LINKS_MAX = 12;

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
    const next = groupPendingByEntrega(list.map(parsePending).filter((p): p is PipelinePending => !!p));
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
  if (!task || !TASK_ID.test(task) || (kind !== 'cp1' && kind !== 'prototype' && kind !== 'blocked' && kind !== 'draft' && kind !== 'review')) return undefined;
  const p: PipelinePending = { task, kind };
  const entrega = str(r?.entrega, 80);
  if (entrega && TASK_ID.test(entrega)) p.entrega = entrega;
  const hash = str(r?.hash, 64);
  if (hash && HASH.test(hash)) p.hash = hash;
  const reason = str(r?.reason);
  if (reason) p.reason = reason;
  const since = r?.since;
  if (typeof since === 'number' && Number.isFinite(since)) p.since = since;
  const links = Array.isArray(r?.links) ? r.links.map(parseLink).filter((l): l is PipelineLink => !!l).slice(0, LINKS_MAX) : [];
  if (links.length) p.links = links;
  return p;
}

/** Só https (nada de javascript:, file: ou http em claro), com rótulo curto. */
function parseLink(raw: unknown): PipelineLink | undefined {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const label = str(r?.label, 60);
  const url = str(r?.url, 400);
  if (!label || !url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? { label, url: u.href } : undefined;
  } catch {
    return undefined;
  }
}

/** Links do ambiente de revisão (`.local/ambientes/<alvo>.json`, gravado por scripts/ambiente_revisao.py). */
export function reviewEnvironmentLinks(info: Record<string, unknown> | undefined): { links: PipelineLink[]; note?: string } {
  const links: PipelineLink[] = [];
  if (!info || info.encerrado_em) return { links };
  const tarefas = Array.isArray(info.tarefas) ? (info.tarefas as Record<string, unknown>[]) : [];
  for (const t of tarefas) {
    const kind = typeof t.kind === 'string' ? t.kind : String(t.task ?? '');
    const srv = t.servidor as Record<string, unknown> | undefined;
    const mr = t.mr as Record<string, unknown> | undefined;
    if (typeof srv?.url === 'string') links.push({ label: kind, url: srv.url });
    if (typeof mr?.url === 'string') links.push({ label: `MR ${kind}${typeof mr.iid === 'number' ? ` !${mr.iid}` : ''}`, url: mr.url });
  }
  const notes: string[] = [];
  const migrations = Array.isArray(info.migrations) ? info.migrations.length : 0;
  if (migrations) notes.push(`${migrations} migration(s) a aprovar antes de testar (ver Roteiro)`);
  const erros = tarefas.filter((t) => (t.mr as { erro?: unknown } | undefined)?.erro || (t.servidor as { erro?: unknown } | undefined)?.erro).length;
  if (erros) notes.push(`${erros} repositório(s) com erro no ambiente (ver Roteiro)`);
  return { links: links.map(parseLink).filter((l): l is PipelineLink => !!l), note: notes.join(' · ') || undefined };
}

/** Consolida sub-tarefas da mesma funcionalidade (`entrega`) e mesmo tipo (`kind`) em um único item. */
export function groupPendingByEntrega(items: readonly PipelinePending[]): PipelinePending[] {
  const out: PipelinePending[] = [];
  const byKey = new Map<string, { item: PipelinePending; tasks: string[]; reasons: string[] }>();
  for (const p of items) {
    if (!p.entrega) {
      out.push({ ...p });
      continue;
    }
    const key = `${p.entrega}|${p.kind}`;
    const existing = byKey.get(key);
    if (!existing) {
      const clone: PipelinePending = { ...p };
      const entry = { item: clone, tasks: [p.task], reasons: p.reason ? [`${p.task}: ${p.reason}`] : [] };
      byKey.set(key, entry);
      out.push(clone);
    } else {
      existing.tasks.push(p.task);
      if (p.reason) existing.reasons.push(`${p.task}: ${p.reason}`);
      if (!existing.item.hash && p.hash) existing.item.hash = p.hash;
      if (!existing.item.links && p.links) existing.item.links = p.links;
    }
  }
  for (const { item, tasks, reasons } of byKey.values()) {
    // Mesma nota em todas (ex.: a do ambiente de revisão, que é da entrega): uma vez só.
    if (tasks.length > 1 && reasons.length && new Set(reasons.map((r) => r.slice(r.indexOf(': ') + 2))).size === 1 && item.kind === 'draft') {
      continue;
    }
    if (tasks.length > 1 && reasons.length) {
      item.reason = reasons.join(' · ').slice(0, TEXT_MAX);
    }
  }
  return out;
}

/** A linha que o usuário manda na sessão interativa dele para resolver (o hook do pipeline registra). */
export function pendingCommand(p: PipelinePending): string | undefined {
  const target = p.entrega ?? p.task;
  if (p.kind === 'cp1' && p.hash) return `APROVAR CP1 ${target} ${p.hash.slice(0, 10)}`;
  if (p.kind === 'prototype' && p.hash) return `APROVAR PROTOTIPO ${target} ${p.hash.slice(0, 10)}`;
  if (p.kind === 'blocked') {
    if (p.reason?.includes('Dev sem progresso')) return `RECUPERAR ${target} validate`;
    return `RECUPERAR ${target}`;
  }
  if (p.kind === 'draft' || p.kind === 'review') return `CONCLUIR ${target}`;
  return undefined;
}

export type PipelineDocKind = 'spec' | 'plan' | 'review' | 'docs' | 'roteiro';
const DOC_MAX_BYTES = 256 * 1024;
const DOC_FILES: Record<PipelineDocKind, string> = {
  spec: 'task-spec.md',
  plan: 'plan.md',
  review: 'review-report.md',
  docs: 'documentacao-tecnica.md',
  roteiro: 'roteiro-teste.md',
};

function isDocKind(d: string): d is PipelineDocKind {
  return d === 'spec' || d === 'plan' || d === 'review' || d === 'docs' || d === 'roteiro';
}

/**
 * Lê a spec (`task-spec.md`), plano (`plan.md`), revisão (`review-report.md`) ou documentação (`documentacao-tecnica.md`)
 * de uma funcionalidade (`entrega`) ou tarefa em `_pipeline/tarefas/`, somente leitura.
 * Quando `task` é uma `entrega`, consolida os documentos das sub-tarefas da entrega.
 */
export function readPipelineDoc(
  readDir: string,
  task: string,
  doc: string,
  read: (f: string) => string = (f) => readFileSync(f, 'utf8'),
  listDir: (d: string) => string[] = (d) => readdirSync(d),
): { task: string; doc: PipelineDocKind; name: string; content: string } | undefined {
  if (!TASK_ID.test(task) || !isDocKind(doc)) return undefined;
  const name = DOC_FILES[doc];
  try {
    const content = read(join(readDir, 'tarefas', task, name)).slice(0, DOC_MAX_BYTES);
    return { task, doc, name, content };
  } catch {
    // Se for o ID de uma entrega (ex.: transparencia-ajustes-4), procura nas sub-tarefas da entrega.
  }
  try {
    const tarefasDir = join(readDir, 'tarefas');
    const members = listDir(tarefasDir)
      .filter((t) => TASK_ID.test(t))
      .sort()
      .filter((t) => readJson(join(tarefasDir, t, 'task.json'), read)?.entrega === task);
    if (!members.length) return undefined;
    if (doc === 'spec') {
      for (const m of members) {
        try {
          const content = read(join(tarefasDir, m, name)).slice(0, DOC_MAX_BYTES);
          return { task, doc, name, content };
        } catch {
          // tenta a próxima
        }
      }
      return undefined;
    }
    const parts: string[] = [];
    for (const m of members) {
      try {
        const c = read(join(tarefasDir, m, name)).trim();
        if (c) parts.push(`# ${m}\n\n${c}`);
      } catch {
        // sub-tarefa ainda sem este documento
      }
    }
    if (!parts.length) return undefined;
    return { task, doc, name: `${task}/${name}`, content: parts.join('\n\n---\n\n').slice(0, DOC_MAX_BYTES) };
  } catch {
    return undefined;
  }
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
  /** Sessão revisora (tmux `rev-<revisão>`) ainda trabalhando: a revisão não espera o usuário. Padrão: pergunta ao tmux. */
  reviewerBusy?: (task: string) => boolean;
}

/** `tmux has-session -t =rev-<revisão>` (nome como em ambiente_revisao.py: reviewer_tmux_name). Sem tmux = livre. */
export function tmuxReviewerBusy(task: string): boolean {
  try {
    return spawnSync('tmux', ['has-session', '-t', `=rev-${task.slice(0, 44)}`], { stdio: 'ignore', timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
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
  // Entregas com alguma tarefa ainda trabalhando: "a concluir" só quando todas estão prontas (ou encerradas).
  const unfinished = new Set<string>();
  for (const task of tasks) {
    const st = readJson(join(local, task, 'state.json'), readFile);
    const phase = typeof st?.phase === 'string' ? st.phase : '';
    const entrega = readJson(join(deps.dir, 'tarefas', task, 'task.json'), readFile)?.entrega;
    if (typeof entrega === 'string' && phase && phase !== 'ready_for_draft' && phase !== 'closed') unfinished.add(entrega);
  }
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
    if (kind === 'draft' && entrega && unfinished.has(entrega)) continue;
    const p: PipelinePending = { task, kind };
    if (entrega) p.entrega = entrega;
    if (kind === 'blocked') {
      const why = [typeof st?.blocked_phase === 'string' ? st.blocked_phase : '', typeof st?.reason === 'string' ? st.reason : ''].filter(Boolean).join(': ');
      if (why) p.reason = why.slice(0, TEXT_MAX);
    }
    if (kind === 'draft') {
      const env = reviewEnvironmentLinks(readJson(join(deps.dir, '.local', 'ambientes', `${entrega ?? task}.json`), readFile));
      if (env.links.length) p.links = env.links;
      if (env.note) p.reason = env.note;
    }
    if ((kind === 'cp1' || kind === 'prototype') && deps.gate) {
      const target = entrega ?? task;
      if (!hashes.has(target)) hashes.set(target, (await deps.gate(target).catch(() => undefined))?.combined_hash);
      const h = hashes.get(target);
      if (h && HASH.test(h)) p.hash = h;
    }
    out.push(p);
  }
  out.push(...readReviewEnvironments(deps.dir, readDir, readFile, deps.reviewerBusy ?? tmuxReviewerBusy));
  return out;
}

/**
 * Revisões de MR de colega (`.local/ambientes/mr-*.json`, `revisao: true`) com o ambiente no ar: viram um cartão na
 * sala da revisão com o roteiro e os links. CONCLUIR derruba o ambiente e a sala (o merge no GitLab também derruba).
 */
export function readReviewEnvironments(
  dir: string,
  readDir: (d: string) => string[],
  readFile: (f: string) => string,
  reviewerBusy: (task: string) => boolean = () => false,
): PipelinePending[] {
  const envDir = join(dir, '.local', 'ambientes');
  let files: string[] = [];
  try {
    files = readDir(envDir).filter((f) => f.startsWith('mr-') && f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: PipelinePending[] = [];
  for (const f of files) {
    const task = f.slice(0, -'.json'.length);
    if (!TASK_ID.test(task)) continue;
    const info = readJson(join(envDir, f), readFile);
    if (!info || info.revisao !== true || info.encerrado_em) continue;
    // Revisora ainda escrevendo parecer e roteiro: nada para o usuário fazer ainda (o cartão aparece quando ela entrega).
    if (reviewerBusy(task)) continue;
    const env = reviewEnvironmentLinks(info);
    const p: PipelinePending = { task, kind: 'review' };
    if (env.links.length) p.links = env.links;
    if (env.note) p.reason = env.note;
    out.push(p);
  }
  return out;
}
