import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { parsePending, pendingCommand, PIPELINE_STALE_MS, PipelineStatus, readPipelinePending } from './status';

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

  it('sem .local/tasks, nada (e nada lança)', async () => {
    expect(await readPipelinePending({ dir: DIR, ...fs({}) })).toEqual([]);
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
    expect(pendingCommand({ task: 'c', kind: 'draft' })).toBeUndefined();
    expect(parsePending({ task: 'x', kind: 'cp1', reason: 'a'.repeat(500) })?.reason).toHaveLength(240);
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
