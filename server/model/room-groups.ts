// Salas por funcionalidade do pipeline do Orca (HABBLAUD_PIPELINE_DIR = a pasta _pipeline da workspace).
//
// Sem isso, cada pasta é uma sala: o worktree de cada tarefa (_wt/aj3-back, _wt/aj3-front…) e a pasta dela em
// _pipeline/tarefas viram salas separadas. Aqui as pastas de uma mesma entrega (campo `entrega` do task.json, a
// unidade que o CP1 aprova) caem numa sala só, e a revisão de MR de colega ganha uma sala por MR:
//
// - _pipeline/tarefas/<tarefa>/…       → sala da entrega da tarefa (task.json)
// - _pipeline/tarefas/<entrega>/…      → sala da entrega (a pasta tem o nome de uma entrega conhecida)
// - <worktree da tarefa>/…             → sala da entrega (config/local.json: repo do task.json → pasta), só sob _wt/
// - _pipeline/.local/runs/<tarefa>/…   → sala da entrega (o agy registra a sessão na 1ª pasta extra do runner)
// - tarefa sem entrega: worktree, runs e pasta em tarefas/ caem na sala da pasta da tarefa
// - _pipeline/tarefas/mr-<N>-…/…       → sala "MR !<N>"
// - _review-wt/<x>_mr<N>[_rK]/…        → sala "MR !<N>"; os checkouts sem número vão para "Revisões"
//
// Só lê: task.json de cada tarefa e config/local.json. Fora da workspace, ou sem regra, a sala continua a pasta.
// No Docker, os arquivos ficam montados noutro lugar (`readDir`), mas os cwds das sessões são os do host (`dir`).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';
import { normalizeCwd } from './rooms';

/** Prefixo dos ids das salas agrupadas: nunca colide com um cwd (que começa com / ou com a letra do disco). */
export const GROUP_ROOM_PREFIX = 'pipeline:';
/** De quanto em quanto tempo os task.json são relidos (tarefa nova entra sozinha). */
const RESCAN_MS = 30_000;

export interface RoomGroup {
  /** Id da sala (GROUP_ROOM_PREFIX + tipo + chave). */
  id: string;
  /** Nome exibido (o apelido escolhido pelo usuário, por `path`, continua valendo por cima). */
  name: string;
  /** Pasta da sala: onde "Nova sessão" abre o agente (e que volta para esta mesma sala). */
  path: string;
}

export interface PipelineRoomGroupsOptions {
  /** A pasta _pipeline como as sessões a veem (caminho do host). */
  dir: string;
  /** Onde ler tarefas/ e config/local.json (no Docker, a montagem; padrão: `dir`). */
  readDir?: string;
  now?: () => number;
}

interface Index {
  /** Tarefa → entrega. */
  entregaOf: Map<string, string>;
  /** Entregas conhecidas → tarefas (ordenadas). */
  tasksOf: Map<string, string[]>;
  /** Worktree (relativo à workspace, normalizado) → entrega. */
  worktreeEntrega: Map<string, string>;
  /** Tarefas sem entrega (com task.json) e o worktree de cada uma (relativo à workspace) → tarefa. */
  soloTasks: Set<string>;
  worktreeTask: Map<string, string>;
  /** Número do MR → pasta em tarefas/ (mr-<N>-…). */
  mrDir: Map<string, string>;
}

/** Caminho relativo de `p` dentro de `base` (com /), ou undefined se estiver fora. */
function inside(base: string, p: string): string | undefined {
  if (p === base) return '';
  return p.startsWith(`${base}/`) ? p.slice(base.length + 1) : undefined;
}

export class PipelineRoomGroups {
  private readonly dir: string;
  private readonly workspace: string;
  private readonly readDir: string;
  private readonly now: () => number;
  private index: Index | null = null;
  private loadedAt = 0;

  constructor(opts: PipelineRoomGroupsOptions) {
    this.dir = normalizeCwd(opts.dir);
    this.workspace = posix.dirname(this.dir);
    this.readDir = opts.readDir ?? opts.dir;
    this.now = opts.now ?? Date.now;
  }

  /** A sala agrupada do cwd, ou undefined (fica a sala da própria pasta). */
  group(cwd: string): RoomGroup | undefined {
    const rel = inside(this.workspace, normalizeCwd(cwd));
    if (rel === undefined || rel === '') return undefined;
    const idx = this.load();
    const seg = rel.split('/');

    if (seg[0] === '_review-wt') {
      if (seg.length < 2) return undefined;
      const mr = /(?:^|_)mr(\d+)(?:_|$)/i.exec(seg[1]!);
      if (mr) return this.mrGroup(mr[1]!, idx);
      return { id: `${GROUP_ROOM_PREFIX}revisoes`, name: tr('Revisões'), path: join(this.workspace, '_review-wt') };
    }

    if (seg[0] === posix.basename(this.dir) && seg[1] === 'tarefas' && seg[2]) {
      const name = seg[2];
      const mr = /^mr-(\d+)(?:-|$)/i.exec(name);
      if (mr) return this.mrGroup(mr[1]!, idx);
      const entrega = idx.entregaOf.get(name) ?? (idx.tasksOf.has(name) ? name : undefined);
      return entrega ? this.entregaGroup(entrega, idx) : undefined;
    }

    if (seg[0] === posix.basename(this.dir) && seg[1] === '.local' && seg[2] === 'runs' && seg[3]) {
      return this.taskGroup(seg[3], idx);
    }

    // Worktree de tarefa: o mais longo que contém o cwd (um worktree pode estar dentro de outro repo).
    let best: string | undefined;
    for (const wt of idx.worktreeEntrega.keys()) {
      if ((rel === wt || rel.startsWith(`${wt}/`)) && (!best || wt.length > best.length)) best = wt;
    }
    if (best) return this.entregaGroup(idx.worktreeEntrega.get(best)!, idx);
    for (const wt of idx.worktreeTask.keys()) {
      if ((rel === wt || rel.startsWith(`${wt}/`)) && (!best || wt.length > best.length)) best = wt;
    }
    return best ? this.taskGroup(idx.worktreeTask.get(best)!, idx) : undefined;
  }

  /** Sala de uma tarefa: a da entrega dela; sem entrega, a da pasta dela em tarefas/ (onde ficam as pendências). */
  private taskGroup(task: string, idx: Index): RoomGroup | undefined {
    const entrega = idx.entregaOf.get(task);
    if (entrega) return this.entregaGroup(entrega, idx);
    if (!idx.soloTasks.has(task)) return undefined;
    const path = join(this.dir, 'tarefas', task);
    return { id: normalizeCwd(path), name: task, path };
  }

  /** A sala onde as pendências de uma tarefa aparecem: a da entrega, a do MR ou a pasta da própria tarefa. */
  roomForTask(task: string, entrega?: string): string {
    const mr = /^mr-(\d+)(?:-|$)/i.exec(task);
    if (mr) return `${GROUP_ROOM_PREFIX}mr:${mr[1]}`;
    if (entrega) return `${GROUP_ROOM_PREFIX}entrega:${entrega}`;
    return normalizeCwd(join(this.dir, 'tarefas', task));
  }

  /** A sala das pendências de uma tarefa com nome e pasta: aparece mesmo sem ninguém trabalhando nela. */
  groupForTask(task: string, entrega?: string): RoomGroup {
    const idx = this.load();
    const mr = /^mr-(\d+)(?:-|$)/i.exec(task);
    if (mr) return this.mrGroup(mr[1]!, idx);
    if (entrega) return this.entregaGroup(entrega, idx);
    const path = join(this.dir, 'tarefas', task);
    return { id: normalizeCwd(path), name: task, path };
  }

  private entregaGroup(entrega: string, idx: Index): RoomGroup {
    const tarefas = join(this.dir, 'tarefas');
    const own = join(tarefas, entrega);
    const path = this.existsOnHost(own) ? own : join(tarefas, idx.tasksOf.get(entrega)?.[0] ?? entrega);
    return { id: `${GROUP_ROOM_PREFIX}entrega:${entrega}`, name: entrega, path };
  }

  private mrGroup(n: string, idx: Index): RoomGroup {
    const dir = idx.mrDir.get(n);
    return {
      id: `${GROUP_ROOM_PREFIX}mr:${n}`,
      name: tr('MR !{0}', [n]),
      path: dir ? join(this.dir, 'tarefas', dir) : join(this.workspace, '_review-wt'),
    };
  }

  /** A pasta existe? Lida pelo lado de leitura (no Docker, a montagem de tarefas/). */
  private existsOnHost(hostPath: string): boolean {
    const rel = inside(this.dir, hostPath);
    return rel !== undefined && existsSync(join(this.readDir, rel));
  }

  private load(): Index {
    const now = this.now();
    if (this.index && now - this.loadedAt < RESCAN_MS) return this.index;
    this.loadedAt = now;
    const idx: Index = { entregaOf: new Map(), tasksOf: new Map(), worktreeEntrega: new Map(), soloTasks: new Set(), worktreeTask: new Map(), mrDir: new Map() };
    const repos = this.readRepos();
    const tarefas = join(this.readDir, 'tarefas');
    let names: string[] = [];
    try {
      names = readdirSync(tarefas).sort();
    } catch (err) {
      log.warnOnce(`room-groups:${errMsg(err)}`, tr('Salas por funcionalidade: não consegui ler {0} ({1}).', [tarefas, errMsg(err)]));
    }
    // Um worktree que aparece em duas entregas é ambíguo: fica a sala da pasta.
    const ambiguous = new Set<string>();
    for (const name of names) {
      const mr = /^mr-(\d+)(?:-|$)/i.exec(name);
      if (mr && !idx.mrDir.has(mr[1]!)) idx.mrDir.set(mr[1]!, name);
      const task = this.readTask(join(tarefas, name, 'task.json'));
      if (task && !task.entrega) {
        idx.soloTasks.add(name);
        const wt = task.repo ? repos.get(task.repo) : undefined;
        if (wt && wt.split('/').includes('_wt')) {
          if (idx.worktreeTask.has(wt)) ambiguous.add(wt);
          idx.worktreeTask.set(wt, name);
        }
        continue;
      }
      if (!task?.entrega) continue;
      idx.entregaOf.set(name, task.entrega);
      idx.tasksOf.set(task.entrega, [...(idx.tasksOf.get(task.entrega) ?? []), name]);
      const wt = task.repo ? repos.get(task.repo) : undefined;
      if (!wt || !wt.split('/').includes('_wt')) continue;
      const prev = idx.worktreeEntrega.get(wt);
      if (prev && prev !== task.entrega) ambiguous.add(wt);
      idx.worktreeEntrega.set(wt, task.entrega);
    }
    for (const wt of ambiguous) {
      idx.worktreeEntrega.delete(wt);
      idx.worktreeTask.delete(wt);
    }
    // Worktree que também é de uma entrega fica com a entrega.
    for (const wt of idx.worktreeEntrega.keys()) idx.worktreeTask.delete(wt);
    this.index = idx;
    return idx;
  }

  private readTask(file: string): { entrega?: string; repo?: string } | undefined {
    try {
      if (!statSync(file).isFile()) return undefined;
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      return { entrega: str(j.entrega), repo: str(j.repo) };
    } catch {
      return undefined;
    }
  }

  /** config/local.json: repo → pasta relativa à workspace (os caminhos lá são relativos a _pipeline). */
  private readRepos(): Map<string, string> {
    const out = new Map<string, string>();
    try {
      const j = JSON.parse(readFileSync(join(this.readDir, 'config', 'local.json'), 'utf8')) as { repositories?: Record<string, unknown> };
      for (const [repo, p] of Object.entries(j.repositories ?? {})) {
        if (typeof p !== 'string' || !p.trim()) continue;
        const rel = inside(this.workspace, normalizeCwd(resolve(this.dir, p.trim()).replace(/\\/g, '/')));
        if (rel) out.set(repo, rel);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warnOnce(`room-groups-local:${errMsg(err)}`, tr('Salas por funcionalidade: config/local.json ilegível ({0}).', [errMsg(err)]));
      }
    }
    return out;
  }
}
