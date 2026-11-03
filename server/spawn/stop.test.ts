import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { findSession, STOP_QUEUED_TIMEOUT_MS, StopService, stopSession, type HostStopDeps } from './stop';
import { HOST_PRESENCE_MS } from './spawn';

setQuiet(true);

const SID = '8c5c67e7-3005-4b69-af11-5d1ef064cc56';

describe('StopService (servidor)', () => {
  function make() {
    let clock = 1_000;
    let n = 0;
    const s = new StopService({ now: () => clock, newId: () => `st${++n}` });
    return { s, advance: (ms: number) => (clock += ms) };
  }

  it('sem o auxiliar do host por perto, recusa; com ele, enfileira, entrega uma vez e guarda o resultado', () => {
    const { s, advance } = make();
    expect(s.submit(SID)).toMatchObject({ error: 'unavailable' });
    expect(s.poll()).toEqual([]);
    const r = s.submit(SID);
    expect(r).toEqual({ stop: { id: 'st1', sessionId: SID, status: 'queued' } });
    // O mesmo pedido de novo não duplica.
    expect(s.submit(SID)).toEqual({ stop: { id: 'st1', sessionId: SID, status: 'queued' } });
    expect(s.poll()).toEqual([{ id: 'st1', sessionId: SID }]);
    expect(s.poll()).toEqual([]);
    expect(s.get('st1')?.status).toBe('sent');
    s.ack({ results: [{ id: 'st1', ok: true, how: 'job' }] });
    expect(s.get('st1')).toEqual({ id: 'st1', sessionId: SID, status: 'stopped', how: 'job' });
    advance(HOST_PRESENCE_MS + 1);
    expect(s.available()).toBe(false);
  });

  it('falha do auxiliar e pedido que ninguém buscou viram "failed" com o motivo', () => {
    const { s, advance } = make();
    s.poll();
    s.submit(SID);
    s.poll();
    s.ack({ results: [{ id: 'st1', ok: false, error: 'o processo da sessão já não existe' }] });
    expect(s.get('st1')).toMatchObject({ status: 'failed', error: 'o processo da sessão já não existe' });
    s.poll();
    s.submit('aaaaaaaa-bbbb');
    advance(STOP_QUEUED_TIMEOUT_MS + 1);
    expect(s.get('st2')).toMatchObject({ status: 'failed', error: 'o auxiliar do computador não buscou o pedido' });
  });

  it('sessão com caracteres estranhos é recusada antes de chegar ao auxiliar', () => {
    const { s } = make();
    s.poll();
    expect(s.submit('../../etc/passwd')).toMatchObject({ error: 'invalid' });
    expect(s.submit('$(rm -rf ~)')).toMatchObject({ error: 'invalid' });
  });
});

describe('stopSession (auxiliar do host)', () => {
  const reg = (o: Record<string, unknown>) => JSON.stringify({ pid: 4242, sessionId: SID, cwd: '/w', startedAt: 1_000_000, procStart: '99', ...o });
  function deps(files: Record<string, string>, extra: Partial<HostStopDeps> = {}): HostStopDeps & { kills: Array<[number, string]>; stops: Array<[string, string | undefined]> } {
    const kills: Array<[number, string]> = [];
    const stops: Array<[string, string | undefined]> = [];
    return {
      accountDirs: ['/home/u/.claude', '/home/u/.claude-b'],
      home: '/home/u',
      claudeBin: '/bin/claude',
      readDir: (d) => {
        const names = Object.keys(files).filter((f) => f.startsWith(`${d}/`)).map((f) => f.slice(d.length + 1));
        if (!names.length) throw new Error('ENOENT');
        return names;
      },
      readFile: (f) => {
        if (!(f in files)) throw new Error('ENOENT');
        return files[f]!;
      },
      procInfo: async () => ({ startMs: 1_000_000 - 500, name: 'claude' }),
      kill: (pid, sig) => void kills.push([pid, sig]),
      runStop: async (_bin, job, env) => (stops.push([job, env.CLAUDE_CONFIG_DIR]), { ok: true }),
      env: { CLAUDE_CONFIG_DIR: '/herdado' },
      kills,
      stops,
      ...extra,
    };
  }

  it('sessão em segundo plano: claude stop <jobId>, sem CLAUDE_CONFIG_DIR na conta padrão e com ele nas outras', async () => {
    const d = deps({ '/home/u/.claude/sessions/4242.json': reg({ kind: 'bg', jobId: '8c5c67e7' }) });
    expect(await stopSession(SID, d)).toEqual({ ok: true, how: 'job' });
    expect(d.stops).toEqual([['8c5c67e7', undefined]]);
    expect(d.kills).toEqual([]);
    const b = deps({ '/home/u/.claude-b/sessions/4242.json': reg({ kind: 'bg', jobId: '8c5c67e7' }) });
    await stopSession(SID, b);
    expect(b.stops).toEqual([['8c5c67e7', '/home/u/.claude-b']]);
  });

  it('sessão num terminal: SIGTERM no PID do registro, só se ainda for aquele Claude Code', async () => {
    const d = deps({ '/home/u/.claude/sessions/4242.json': reg({ kind: 'interactive' }) });
    expect(await stopSession(SID, d)).toEqual({ ok: true, how: 'signal' });
    expect(d.kills).toEqual([[4242, 'SIGTERM']]);
  });

  it('PID reaproveitado por outro processo (ou outro programa): nada é encerrado', async () => {
    const outro = deps({ '/home/u/.claude/sessions/4242.json': reg({}) }, { procInfo: async () => ({ startMs: 5_000_000, name: 'claude' }) });
    expect(await stopSession(SID, outro)).toMatchObject({ ok: false });
    expect(outro.kills).toEqual([]);
    const vim = deps({ '/home/u/.claude/sessions/4242.json': reg({}) }, { procInfo: async () => ({ startMs: 1_000_000, name: 'vim' }) });
    expect(await stopSession(SID, vim)).toMatchObject({ ok: false });
    expect(vim.kills).toEqual([]);
    const morto = deps({ '/home/u/.claude/sessions/4242.json': reg({}) }, { procInfo: async () => undefined });
    expect(await stopSession(SID, morto)).toEqual({ ok: false, error: 'o processo da sessão já não existe' });
  });

  it('sessão que não está no registro, ou id inválido, não encerra nada', async () => {
    const d = deps({ '/home/u/.claude/sessions/1.json': reg({ sessionId: 'outra-sessao-1234' }) });
    expect(await stopSession(SID, d)).toMatchObject({ ok: false });
    expect(await stopSession('x', d)).toEqual({ ok: false, error: 'sessão inválida' });
    expect(d.kills).toEqual([]);
    expect(d.stops).toEqual([]);
  });

  it('dois registros da mesma sessão: vale o mais novo', () => {
    const d = deps({
      '/home/u/.claude/sessions/1.json': reg({ pid: 1, startedAt: 10 }),
      '/home/u/.claude/sessions/2.json': reg({ pid: 2, startedAt: 20 }),
    });
    expect(findSession(SID, d)?.entry.pid).toBe(2);
  });

  it('sem o claude, a sessão em segundo plano não é encerrada (e não cai no SIGTERM)', async () => {
    const d = deps({ '/home/u/.claude/sessions/4242.json': reg({ kind: 'bg', jobId: '8c5c67e7' }) }, { claudeBin: undefined });
    expect(await stopSession(SID, d)).toMatchObject({ ok: false });
    expect(d.kills).toEqual([]);
  });
});
