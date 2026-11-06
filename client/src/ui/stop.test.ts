import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import { setAccess } from '../net/access';
import { canStop } from './stop';

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: 'a1', name: 'Ana', kind: 'main', roomId: '/home/u', look: 'm', role: 'Agente principal', sessionId: 's1',
    account: '.claude', status: 'idle', recent: [], tasks: [], startedAt: 10, lastEventAt: 100, statusSince: 100,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: 1, ...overrides,
  } as AgentInfo;
}
const snap = { meta: { stop: true } } as unknown as OfficeSnapshot;

afterEach(() => setAccess(null));

describe('canStop (botão Encerrar)', () => {
  it('Claude Code e agy (Antigravity) sim; fase do runner do pipeline, Codex e sem permissão de spawn não', () => {
    setAccess({ remote: false, local: true, permissions: true, messages: true, terminal: true, spawn: true });
    expect(canStop(agent({}), true, snap)).toBe(true);
    expect(canStop(agent({ provider: 'antigravity' }), true, snap)).toBe(true);
    expect(canStop(agent({ provider: 'antigravity', pipelinePhase: 'dev' }), true, snap)).toBe(false);
    expect(canStop(agent({ pipelinePhase: 'review' }), true, snap)).toBe(false);
    expect(canStop(agent({ provider: 'codex' }), true, snap)).toBe(false);
    expect(canStop(agent({ provider: 'antigravity' }), false, snap)).toBe(false);
    setAccess({ remote: false, local: true, permissions: true, messages: true, terminal: true, spawn: false });
    expect(canStop(agent({ provider: 'antigravity' }), true, snap)).toBe(false);
  });
});
