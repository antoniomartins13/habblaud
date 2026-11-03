import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { NameStore } from './names';
import { Office } from './office';
import { GROUP_ROOM_PREFIX, PipelineRoomGroups } from './room-groups';

setQuiet(true);

/** Workspace falsa: <ws>/_pipeline com tarefas/ e config/local.json, como o Orca grava. */
function workspace(root: string) {
  const ws = join(root, 'Orca-workspace');
  const pipeline = join(ws, '_pipeline');
  const task = (id: string, data: Record<string, unknown> | null) => {
    mkdirSync(join(pipeline, 'tarefas', id), { recursive: true });
    if (data) writeFileSync(join(pipeline, 'tarefas', id, 'task.json'), JSON.stringify(data));
  };
  mkdirSync(join(pipeline, 'config'), { recursive: true });
  writeFileSync(
    join(pipeline, 'config', 'local.json'),
    JSON.stringify({
      repositories: {
        'erp-back-end': '../erp-back-end',
        'erp-back-end-aj3': '../_wt/aj3-back',
        'erp-front-end-aj3': '../_wt/aj3-front',
        'erp-back-end-imp2': '../_wt/importacoes-2-back',
        'erp-back-end-x': '../_wt/compartilhado',
        'erp-front-end-y': '../_wt/compartilhado',
      },
    }),
  );
  task('aj3-back', { repo: 'erp-back-end-aj3', entrega: 'transparencia-ajustes-3' });
  task('aj3-front', { repo: 'erp-front-end-aj3', entrega: 'transparencia-ajustes-3' });
  task('transparencia-ajustes-3', null);
  task('imp2-back', { repo: 'erp-back-end-imp2', entrega: 'transparencia-importacoes-2' });
  task('direto-no-repo', { repo: 'erp-back-end', entrega: 'outra' });
  task('x', { repo: 'erp-back-end-x', entrega: 'ex' });
  task('y', { repo: 'erp-front-end-y', entrega: 'ey' });
  task('sem-entrega', { repo: 'erp-back-end' });
  task('mr-596-471-home-3954', null);
  task('balancete-mensal', null);
  return { ws, pipeline, task };
}

describe('PipelineRoomGroups', () => {
  let tmp: ReturnType<typeof tempDir>;
  let ws: string;
  let pipeline: string;
  let groups: PipelineRoomGroups;
  beforeEach(() => {
    tmp = tempDir();
    ({ ws, pipeline } = workspace(tmp.dir));
    groups = new PipelineRoomGroups({ dir: pipeline });
  });
  afterEach(() => tmp.cleanup());

  it('worktrees e pastas das tarefas da mesma entrega caem numa sala só, com a pasta da entrega', () => {
    const want = { id: `${GROUP_ROOM_PREFIX}entrega:transparencia-ajustes-3`, name: 'transparencia-ajustes-3', path: join(pipeline, 'tarefas', 'transparencia-ajustes-3') };
    expect(groups.group(join(ws, '_wt/aj3-back'))).toEqual(want);
    expect(groups.group(join(ws, '_wt/aj3-front/src/pages'))).toEqual(want);
    expect(groups.group(join(pipeline, 'tarefas/aj3-back'))).toEqual(want);
    expect(groups.group(join(pipeline, 'tarefas/transparencia-ajustes-3/'))).toEqual(want);
  });

  it('o worktree vem do local.json, não do nome da pasta; sem pasta da entrega, a sala abre na primeira tarefa', () => {
    expect(groups.group(join(ws, '_wt/importacoes-2-back'))).toEqual({
      id: `${GROUP_ROOM_PREFIX}entrega:transparencia-importacoes-2`,
      name: 'transparencia-importacoes-2',
      path: join(pipeline, 'tarefas', 'imp2-back'),
    });
  });

  it('MR de colega: a pasta da revisão e os checkouts be_/fe_ do mesmo número, com as rodadas', () => {
    const want = { id: `${GROUP_ROOM_PREFIX}mr:596`, name: 'MR !596', path: join(pipeline, 'tarefas', 'mr-596-471-home-3954') };
    expect(groups.group(join(pipeline, 'tarefas/mr-596-471-home-3954'))).toEqual(want);
    expect(groups.group(join(ws, '_review-wt/be_mr596'))).toEqual(want);
    expect(groups.group(join(ws, '_review-wt/fe_mr596_r2/src'))).toEqual(want);
    // MR sem pasta em tarefas/: a sala abre em _review-wt.
    expect(groups.group(join(ws, '_review-wt/be_mr445_r2'))).toEqual({ id: `${GROUP_ROOM_PREFIX}mr:445`, name: 'MR !445', path: join(ws, '_review-wt') });
  });

  it('checkouts de revisão sem número de MR vão para "Revisões"', () => {
    const want = { id: `${GROUP_ROOM_PREFIX}revisoes`, name: 'Revisões', path: join(ws, '_review-wt') };
    expect(groups.group(join(ws, '_review-wt/be_acl591'))).toEqual(want);
    expect(groups.group(join(ws, '_review-wt/fe_acl465'))).toEqual(want);
  });

  it('sem regra, a sala continua a pasta', () => {
    expect(groups.group(ws)).toBeUndefined();
    expect(groups.group(join(ws, 'erp-back-end'))).toBeUndefined(); // repo principal, não worktree
    expect(groups.group(join(ws, '_review-wt'))).toBeUndefined();
    expect(groups.group(join(pipeline, 'tarefas/sem-entrega'))).toBeUndefined();
    expect(groups.group(join(pipeline, 'tarefas/balancete-mensal'))).toBeUndefined();
    expect(groups.group(join(ws, '_wt/compartilhado'))).toBeUndefined(); // worktree em duas entregas: ambíguo
    expect(groups.group('/home/outra/coisa')).toBeUndefined();
    expect(groups.group(`${ws}-irmao/_wt/aj3-back`)).toBeUndefined();
  });

  it('tarefa nova entra sozinha depois do intervalo de releitura', () => {
    let clock = 0;
    const g = new PipelineRoomGroups({ dir: pipeline, now: () => clock });
    expect(g.group(join(pipeline, 'tarefas/nova'))).toBeUndefined();
    mkdirSync(join(pipeline, 'tarefas', 'nova'));
    writeFileSync(join(pipeline, 'tarefas', 'nova', 'task.json'), JSON.stringify({ entrega: 'transparencia-ajustes-3' }));
    expect(g.group(join(pipeline, 'tarefas/nova'))).toBeUndefined(); // ainda no cache
    clock += 30_000;
    expect(g.group(join(pipeline, 'tarefas/nova'))?.id).toBe(`${GROUP_ROOM_PREFIX}entrega:transparencia-ajustes-3`);
  });

  it('lê os arquivos de outro lugar (Docker), comparando com os cwds do host', () => {
    const g = new PipelineRoomGroups({ dir: '/home/antonio/Orca-workspace/_pipeline', readDir: pipeline });
    expect(g.group('/home/antonio/Orca-workspace/_wt/aj3-front')).toEqual({
      id: `${GROUP_ROOM_PREFIX}entrega:transparencia-ajustes-3`,
      name: 'transparencia-ajustes-3',
      path: '/home/antonio/Orca-workspace/_pipeline/tarefas/transparencia-ajustes-3',
    });
  });

  it('sem tarefas/ legível, nada é agrupado (e nada lança)', () => {
    const g = new PipelineRoomGroups({ dir: join(tmp.dir, 'nao-existe', '_pipeline') });
    expect(g.group(join(tmp.dir, 'nao-existe', '_wt', 'aj3-back'))).toBeUndefined();
  });

  it('no escritório: dev e revisor de uma entrega dividem a sala, cada um com a própria pasta', () => {
    const office = new Office({
      names: new NameStore(null),
      roomGroup: (cwd) => groups.group(cwd),
      version: 't',
      startedAt: 0,
      accounts: () => [],
      sources: () => [],
      accountName: () => undefined,
      now: () => 1_000,
    });
    const back = join(ws, '_wt/aj3-back');
    const front = join(ws, '_wt/aj3-front');
    office.addMain({ id: 'a:1', account: 'a', sessionId: 's1', cwd: back, role: 'x', startedAt: 0, status: 'working', provider: 'codex' });
    office.addMain({ id: 'a:2', account: 'a', sessionId: 's2', cwd: front, role: 'x', startedAt: 0, status: 'working' });
    office.addMain({ id: 'a:3', account: 'a', sessionId: 's3', cwd: join(ws, 'erp-back-end'), role: 'x', startedAt: 0, status: 'working' });
    const snap = office.commit().snapshot;
    const room = `${GROUP_ROOM_PREFIX}entrega:transparencia-ajustes-3`;
    expect(office.get('a:1')!.roomId).toBe(room);
    expect(office.get('a:2')!.roomId).toBe(room);
    expect(snap.rooms.find((r) => r.id === room)).toMatchObject({ name: 'transparencia-ajustes-3', path: join(pipeline, 'tarefas', 'transparencia-ajustes-3') });
    expect(office.agentCwd('a:1')).toBe(back);
    expect(office.agentCwd('a:2')).toBe(front);
    expect(office.get('a:3')!.roomId).toBe(join(ws, 'erp-back-end'));
    expect(office.agentCwd('a:3')).toBe(join(ws, 'erp-back-end'));
  });
});
