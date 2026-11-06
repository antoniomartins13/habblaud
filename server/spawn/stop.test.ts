import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { findAgyProcess, findSession, STOP_QUEUED_TIMEOUT_MS, StopService, stopAgySession, stopSession, type AgyStopDeps, type HostStopDeps } from './stop';
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

describe('stopAgySession (host, Antigravity)', () => {
  const CONV = '8608b292-c24b-4c70-9760-ae591a4d90c3';
  const LOG = '/home/u/.gemini/antigravity-cli/log/cli-20261106_150252.log';
  interface FakeProc { comm?: string; uid?: number; cmdline?: string[]; environ?: string; log?: string; logText?: string }

  function fakeProc(procs: Record<string, FakeProc>, start = 1_000) {
    const files = new Map<string, string>();
    const links = new Map<string, string>();
    for (const [pid, p] of Object.entries(procs)) {
      files.set(`/proc/${pid}/comm`, `${p.comm ?? 'agy'}\n`);
      files.set(`/proc/${pid}/cmdline`, (p.cmdline ?? ['/home/u/.local/bin/agy']).join('\0'));
      files.set(`/proc/${pid}/environ`, p.environ ?? 'HOME=/home/u\0');
      const log = p.log ?? `/home/u/.gemini/antigravity-cli/log/cli-${pid}.log`;
      links.set(`/proc/${pid}/fd/3`, log);
      links.set(`/proc/${pid}/fd/1`, '/dev/pts/1');
      files.set(log, p.logText ?? '');
    }
    const killed: Array<[number, string]> = [];
    const deps: AgyStopDeps = {
      procRoot: '/proc',
      readDir: (d) => (d === '/proc' ? [...Object.keys(procs), 'self', 'net'] : d.endsWith('/fd') ? ['1', '3'] : []),
      readFile: (f) => {
        const v = files.get(f);
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
      readLink: (p) => {
        const v = links.get(p);
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
      ownerOf: (p) => procs[p.split('/')[2]!]?.uid ?? 1000,
      uid: 1000,
      procInfo: async () => ({ startMs: start, name: 'agy' }),
      kill: (pid, sig) => killed.push([pid, sig]),
    };
    return { deps, killed };
  }

  it('encerra só o agy interativo cujo log aberto cita a conversa', async () => {
    const { deps, killed } = fakeProc({
      '10': { logText: `I1106 conversation_manager cascade_id:${CONV}\n` },
      '11': { logText: 'cascade_id:outra-conversa' },
      '12': { comm: 'node', logText: CONV },
    });
    expect(findAgyProcess(CONV, deps)).toEqual({ pid: 10 });
    expect(await stopAgySession(CONV, deps)).toEqual({ ok: true, how: 'signal' });
    expect(killed).toEqual([[10, 'SIGTERM']]);
  });

  it('nunca toca no agy headless (runner do pipeline: -p, -p=..., env do runner) nem em processo de outro usuário', async () => {
    const { deps, killed } = fakeProc({
      '20': { cmdline: ['agy', '--output-format', 'json', `-p=prompt ${CONV}`], logText: CONV },
      '21': { cmdline: ['agy', '-p', 'x'], logText: CONV },
      '22': { environ: 'PIPELINE_PHASE=dev\0', logText: CONV },
      '23': { uid: 0, logText: CONV },
    });
    expect(await stopAgySession(CONV, deps)).toEqual({ ok: false, error: 'o agy dessa conversa não está rodando neste computador' });
    expect(killed).toEqual([]);
  });

  it('dois candidatos, PID trocado no meio ou id inválido: nada é encerrado', async () => {
    const dois = fakeProc({ '30': { logText: CONV }, '31': { logText: CONV } });
    expect((await stopAgySession(CONV, dois.deps)).ok).toBe(false);
    expect(dois.killed).toEqual([]);

    const um = fakeProc({ '40': { logText: CONV } });
    let n = 0;
    um.deps.procInfo = async () => ({ startMs: n++ === 0 ? 1_000 : 2_000, name: 'agy' });
    expect(await stopAgySession(CONV, um.deps)).toEqual({ ok: false, error: 'o processo mudou durante a conferência: nada foi encerrado' });
    expect(await stopAgySession('../../etc', um.deps)).toEqual({ ok: false, error: 'sessão inválida' });
    expect(um.killed).toEqual([]);
  });

  it('o pedido leva o provedor até o auxiliar', () => {
    let clock = 1_000;
    const s = new StopService({ now: () => clock, newId: () => 'st-agy' });
    s.poll();
    expect(s.submit(CONV, 'antigravity')).toEqual({ stop: { id: 'st-agy', sessionId: CONV, provider: 'antigravity', status: 'queued' } });
    clock += 1;
    expect(s.poll()).toEqual([{ id: 'st-agy', sessionId: CONV, provider: 'antigravity' }]);
  });
});
