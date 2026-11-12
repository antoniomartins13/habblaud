import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { parsePending, pendingCommand, PIPELINE_STALE_MS, PipelineStatus, readPipelineDoc, readPipelinePending, reviewEnvironmentLinks } from './status';

setQuiet(true);

const DIR = '/w/_pipeline';

function fs(files: Record<string, unknown>) {
  const paths = Object.keys(files);
  return {
    readDir: (d: string) => {
      const names = new Set(paths.filter((p) => p.startsWith(`${d}/`)).map((p) => p.slice(d.length + 1).split('/')[0]!));
      if (!names.size) throw new Error('ENOENT');
      return [...names];
    },
    readFile: (f: string) => {
      if (!(f in files)) throw new Error('ENOENT');
      return JSON.stringify(files[f]);
    },
    exists: (p: string) => p in files,
  };
}

describe('readPipelinePending (auxiliar do host)', () => {
  it('só as fases que esperam o usuário, com a entrega, o motivo do bloqueio e o hash do gate', async () => {
    const gates: string[] = [];
    const pending = await readPipelinePending({
      dir: DIR,
      ...fs({
        [`${DIR}/.local/tasks/a-back/state.json`]: { phase: 'awaiting_CP1' },
        [`${DIR}/tarefas/a-back/task.json`]: { entrega: 'ent-a' },
        [`${DIR}/.local/tasks/a-front/state.json`]: { phase: 'awaiting_CP1' },
        [`${DIR}/tarefas/a-front/task.json`]: { entrega: 'ent-a' },
        [`${DIR}/.local/tasks/b/state.json`]: { phase: 'blocked', blocked_phase: 'review', reason: 'RuntimeError: claude saiu com codigo 1' },
        [`${DIR}/.local/tasks/c/state.json`]: { phase: 'ready_for_draft' },
        [`${DIR}/.local/tasks/d/state.json`]: { phase: 'dev' },
        [`${DIR}/.local/tasks/e/state.json`]: { phase: 'validate' },
      }),
      gate: async (t) => (gates.push(t), { combined_hash: 'ccecccfb8bc5b101fb93' }),
    });
    expect(pending).toEqual([
      { task: 'a-back', kind: 'cp1', entrega: 'ent-a', hash: 'ccecccfb8bc5b101fb93' },
      { task: 'a-front', kind: 'cp1', entrega: 'ent-a', hash: 'ccecccfb8bc5b101fb93' },
      { task: 'b', kind: 'blocked', reason: 'review: RuntimeError: claude saiu com codigo 1' },
      { task: 'c', kind: 'draft' },
    ]);
    // O gate da entrega é lido uma vez só.
    expect(gates).toEqual(['ent-a']);
  });

  it('"a concluir" de uma entrega só aparece quando todas as tarefas dela estão prontas', async () => {
    const files = (backPhase: string) =>
      fs({
        [`${DIR}/.local/tasks/r-back/state.json`]: { phase: backPhase },
        [`${DIR}/tarefas/r-back/task.json`]: { entrega: 'rel' },
        [`${DIR}/.local/tasks/r-front/state.json`]: { phase: 'ready_for_draft' },
        [`${DIR}/tarefas/r-front/task.json`]: { entrega: 'rel' },
      });
    expect(await readPipelinePending({ dir: DIR, ...files('dev') })).toEqual([]);
    expect((await readPipelinePending({ dir: DIR, ...files('ready_for_draft') })).map((p) => p.task)).toEqual(['r-back', 'r-front']);
  });

  it('revisão de colega com ambiente no ar vira cartão com roteiro e links, com CONCLUIR (derruba a sala; o merge também)', async () => {
    const amb = `${DIR}/.local/ambientes`;
    const srv = { url: 'https://h.ts.net:18036' };
    const files = fs({
        [`${DIR}/.local/tasks/c/state.json`]: { phase: 'dev' },
        [`${amb}/mr-591-465-acl.json`]: { revisao: true, tarefas: [{ kind: 'front', servidor: srv, mr: { url: 'https://gl/mr/465', iid: 465 } }] },
        [`${amb}/mr-596-471-home.json`]: { revisao: true, encerrado_em: '2026-11-09', tarefas: [] },
        [`${amb}/processo-adm.json`]: { tarefas: [] },
        [`${amb}/portas.json`]: {},
      });
    // Revisora ainda trabalhando (tmux rev-*): o cartão não aparece, ninguém espera o usuário.
    expect(await readPipelinePending({ dir: DIR, ...files, reviewerBusy: () => true })).toEqual([]);
    const pending = await readPipelinePending({ dir: DIR, ...files, reviewerBusy: () => false });
    expect(pending).toEqual([
      { task: 'mr-591-465-acl', kind: 'review', links: [{ label: 'front', url: 'https://h.ts.net:18036/' }, { label: 'MR front !465', url: 'https://gl/mr/465' }] },
    ]);
    expect(pendingCommand(pending[0]!)).toBe('CONCLUIR mr-591-465-acl');
    expect(parsePending({ task: 'mr-591-465-acl', kind: 'review' })).toEqual({ task: 'mr-591-465-acl', kind: 'review' });
  });

  it('sem .local/tasks, nada (e nada lança)', async () => {
    expect(await readPipelinePending({ dir: DIR, ...fs({}) })).toEqual([]);
  });
});

describe('ambiente de revisão na pendência "a concluir"', () => {
  const info = {
    tarefas: [
      { task: 'aj3-back', kind: 'back', servidor: { url: 'https://pc.tail.ts.net:18015' }, mr: { url: 'https://git.x/back/-/merge_requests/616', iid: 616 } },
      { task: 'aj3-front', kind: 'front', servidor: { erro: 'porta ocupada' }, mr: { url: 'javascript:alert(1)' } },
    ],
    migrations: ['aj3-back: m1.php', 'aj3-back: m2.php'],
  };

  it('servidores e MRs viram links (só https) e a nota conta migrations e erros', () => {
    expect(reviewEnvironmentLinks(info)).toEqual({
      links: [
        { label: 'back', url: 'https://pc.tail.ts.net:18015/' },
        { label: 'MR back !616', url: 'https://git.x/back/-/merge_requests/616' },
      ],
      note: '2 migration(s) a aprovar antes de testar (ver Roteiro) · 1 repositório(s) com erro no ambiente (ver Roteiro)',
    });
    expect(reviewEnvironmentLinks({ ...info, encerrado_em: 'x' })).toEqual({ links: [] });
    expect(reviewEnvironmentLinks(undefined)).toEqual({ links: [] });
  });

  it('o auxiliar lê o ambiente da entrega e o servidor recusa link que não é https', async () => {
    const pending = await readPipelinePending({
      dir: DIR,
      ...fs({
        [`${DIR}/.local/tasks/aj3-back/state.json`]: { phase: 'ready_for_draft' },
        [`${DIR}/tarefas/aj3-back/task.json`]: { entrega: 'ent' },
        [`${DIR}/.local/ambientes/ent.json`]: info,
      }),
    });
    expect(pending[0]?.links).toHaveLength(2);
    expect(parsePending({ task: 'x', kind: 'draft', links: [{ label: 'a', url: 'http://inseguro' }, { label: 'b', url: 'https://ok.ts.net' }] })?.links).toEqual([
      { label: 'b', url: 'https://ok.ts.net/' },
    ]);
  });
});

describe('PipelineStatus e a linha que resolve', () => {
  it('valida o que chega do auxiliar e envelhece sem ele', () => {
    let clock = 0;
    const st = new PipelineStatus({ now: () => clock });
    expect(st.set({ pending: [{ task: 'x', kind: 'cp1', hash: 'abcdef0123' }, { task: '../etc', kind: 'cp1' }, { task: 'y', kind: 'deploy' }, { task: 'z', kind: 'draft', hash: 'not-hex!' }] })).toBe(true);
    expect(st.list()).toEqual([{ task: 'x', kind: 'cp1', hash: 'abcdef0123' }, { task: 'z', kind: 'draft' }]);
    expect(st.set({ pending: [{ task: 'x', kind: 'cp1', hash: 'abcdef0123' }, { task: 'z', kind: 'draft' }] })).toBe(false);
    clock += PIPELINE_STALE_MS + 1;
    expect(st.list()).toEqual([]);
  });

  it('comando: gate da entrega (ou da tarefa) com 10 caracteres do hash; RECUPERAR; MR sem comando', () => {
    expect(pendingCommand({ task: 'a-back', kind: 'cp1', entrega: 'ent-a', hash: 'ccecccfb8bc5b101fb93' })).toBe('APROVAR CP1 ent-a ccecccfb8b');
    expect(pendingCommand({ task: 'p', kind: 'prototype', hash: '0123456789abcdef' })).toBe('APROVAR PROTOTIPO p 0123456789');
    expect(pendingCommand({ task: 'p', kind: 'cp1' })).toBeUndefined();
    expect(pendingCommand({ task: 'b', kind: 'blocked', entrega: 'ent-b' })).toBe('RECUPERAR ent-b');
    expect(pendingCommand({ task: 'aj4-back', kind: 'blocked', entrega: 'ent-a', reason: 'dev: RuntimeError: Dev sem progresso verificavel' })).toBe(
      'RECUPERAR ent-a validate',
    );
    expect(pendingCommand({ task: 'c', kind: 'draft' })).toBe('CONCLUIR c');
    expect(pendingCommand({ task: 'mr-1-2-x', kind: 'review' })).toBe('CONCLUIR mr-1-2-x');
    expect(pendingCommand({ task: 'aj4-back', kind: 'draft', entrega: 'ent-a' })).toBe('CONCLUIR ent-a');
    expect(parsePending({ task: 'x', kind: 'cp1', reason: 'a'.repeat(500) })?.reason).toHaveLength(240);
  });

  it('lê a spec, plano e revisão da funcionalidade (entrega) ou tarefa em tarefas/, recusando nomes inválidos', () => {
    const files: Record<string, string> = {
      [`${DIR}/tarefas/aj4-back/task.json`]: JSON.stringify({ entrega: 'ent-aj4' }),
      [`${DIR}/tarefas/aj4-back/task-spec.md`]: '# Spec aj4',
      [`${DIR}/tarefas/aj4-back/plan.md`]: '# Plano back',
      [`${DIR}/tarefas/aj4-back/review-report.md`]: '- Achado 1\n- Achado 2',
      [`${DIR}/tarefas/aj4-front/task.json`]: JSON.stringify({ entrega: 'ent-aj4' }),
      [`${DIR}/tarefas/aj4-front/plan.md`]: '# Plano front',
    };
    const read = (f: string) => {
      if (!(f in files)) throw new Error('ENOENT');
      return files[f]!;
    };
    const listDir = () => ['aj4-back', 'aj4-front'];
    expect(readPipelineDoc(DIR, 'aj4-back', 'spec', read, listDir)).toEqual({ task: 'aj4-back', doc: 'spec', name: 'task-spec.md', content: '# Spec aj4' });
    expect(readPipelineDoc(DIR, 'ent-aj4', 'spec', read, listDir)).toEqual({ task: 'ent-aj4', doc: 'spec', name: 'task-spec.md', content: '# Spec aj4' });
    expect(readPipelineDoc(DIR, 'ent-aj4', 'review', read, listDir)).toEqual({
      task: 'ent-aj4',
      doc: 'review',
      name: 'ent-aj4/review-report.md',
      content: '# aj4-back\n\n- Achado 1\n- Achado 2',
    });
    expect(readPipelineDoc(DIR, 'ent-aj4', 'plan', read, listDir)).toEqual({
      task: 'ent-aj4',
      doc: 'plan',
      name: 'ent-aj4/plan.md',
      content: '# aj4-back\n\n# Plano back\n\n---\n\n# aj4-front\n\n# Plano front',
    });
    expect(readPipelineDoc(DIR, '../etc', 'spec', read, listDir)).toBeUndefined();
    expect(readPipelineDoc(DIR, 'aj4-back', 'outro', read, listDir)).toBeUndefined();
    expect(readPipelineDoc(DIR, 'inexistente', 'spec', read, listDir)).toBeUndefined();
  });
});

describe('Office: pendências do runner', () => {
  it('vão para a sala da funcionalidade e viram aviso quando aparecem (não na primeira foto)', () => {
    const office = new Office({
      names: new NameStore(null),
      roomGroup: (cwd) => (cwd.startsWith('/w/_wt/a-') ? { id: 'pipeline:entrega:ent-a', name: 'ent-a', path: '/w/_pipeline/tarefas/ent-a' } : undefined),
      pendingRoom: (p) => (p.entrega ? `pipeline:entrega:${p.entrega}` : `/w/_pipeline/tarefas/${p.task}`),
      version: 't',
      startedAt: 0,
      accounts: () => [],
      sources: () => [],
      accountName: () => undefined,
      now: () => 1_000,
    });
    office.addMain({ id: 'a:1', account: 'a', sessionId: 's1', cwd: '/w/_wt/a-back', role: 'x', startedAt: 0, status: 'working' });
    office.commit();
    office.setPipelinePending([{ task: 'velha', kind: 'blocked' }]);
    expect(office.commit().notices.filter((n) => n.text.startsWith('✋'))).toEqual([]);
    office.setPipelinePending([
      { task: 'velha', kind: 'blocked' },
      { task: 'a-back', kind: 'cp1', entrega: 'ent-a', hash: 'ccecccfb8b', command: 'APROVAR CP1 ent-a ccecccfb8b' },
    ]);
    const r = office.commit();
    expect(r.notices.map((n) => n.text)).toContain('✋ ent-a espera o seu CP1');
    expect(r.snapshot.rooms.find((x) => x.id === 'pipeline:entrega:ent-a')?.pending).toEqual([
      { task: 'a-back', kind: 'cp1', entrega: 'ent-a', hash: 'ccecccfb8b', command: 'APROVAR CP1 ent-a ccecccfb8b' },
    ]);
  });
});
