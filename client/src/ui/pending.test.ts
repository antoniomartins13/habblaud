import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, PipelinePending } from '../../../shared/types';
import { findInteractiveConsole, pendingItems, resetPipelineDocModalForTest } from './pending';

function agent(overrides: Partial<AgentInfo> & { id: string; name: string }): AgentInfo {
  return {
    kind: 'main',
    roomId: '/home/u',
    look: 'm',
    role: 'Agente principal',
    sessionId: overrides.id,
    account: '.claude',
    status: 'idle',
    recent: [],
    tasks: [],
    startedAt: 10,
    lastEventAt: 100,
    statusSince: 100,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    canMessage: true,
    ...overrides,
  };
}

class FakeElement {
  className = '';
  textContent = '';
  innerHTML = '';
  title = '';
  type = '';
  hidden = false;
  disabled = false;
  tabIndex = 0;
  scrollTop = 0;
  parentElement: FakeElement | null = null;
  onclick: (() => void) | null = null;
  style = {
    removeProperty: () => {},
    setProperty: () => {},
  };
  children: FakeElement[] = [];
  private classes = new Set<string>();
  private attrs = new Map<string, string>();
  private clicks: (() => void)[] = [];

  classList = {
    add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      return next;
    },
    contains: (name: string) => this.classes.has(name),
  };

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === 'hidden') this.hidden = true;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === 'hidden') this.hidden = false;
  }
  hasAttribute(name: string): boolean {
    return name === 'hidden' ? this.hidden : this.attrs.has(name);
  }
  addEventListener(name: string, fn: () => void): void {
    if (name === 'click') this.clicks.push(fn);
  }
  append(...nodes: unknown[]): void {
    for (const n of nodes) {
      if (n instanceof FakeElement) {
        n.parentElement = this;
        this.children.push(n);
      }
    }
  }
  replaceChildren(...nodes: unknown[]): void {
    this.children = [];
    this.append(...nodes);
  }
  click(): void {
    if (this.disabled) return;
    this.onclick?.();
    for (const fn of this.clicks) fn();
  }
}

function stubDom(): FakeElement[] {
  const elements: FakeElement[] = [];
  const body = new FakeElement();
  vi.stubGlobal('document', {
    body,
    querySelector: () => body,
    createElement: () => {
      const el = new FakeElement();
      elements.push(el);
      return el;
    },
  });
  return elements;
}

afterEach(() => {
  resetPipelineDocModalForTest();
  vi.unstubAllGlobals();
});

describe('findInteractiveConsole', () => {
  it('ignora sessões em segundo plano (--bg), sessões de fase do runner e outros provedores; prefere a própria sala', () => {
    const bg = agent({ id: 'bg', name: 'Theo', background: true, lastEventAt: 500 });
    const worker = agent({ id: 'wk', name: 'Worker', pipelinePhase: 'dev', lastEventAt: 600 });
    const codex = agent({ id: 'cx', name: 'Codex', provider: 'codex', lastEventAt: 700 });
    const gerencia = agent({ id: 'ger', name: 'Andrius', roomId: '/home/u', lastEventAt: 300 });
    const sala = agent({ id: 'sala', name: 'Coord', roomId: 'pipeline:entrega:aj4', lastEventAt: 200 });

    expect(findInteractiveConsole([bg, worker, codex])).toBeUndefined();
    expect(findInteractiveConsole([bg, worker, gerencia, sala])).toBe(gerencia);
    expect(findInteractiveConsole([bg, worker, gerencia, sala], 'pipeline:entrega:aj4')).toBe(sala);
  });
});

describe('pendingItems (botão Aprovar/Recuperar + Spec/Plano)', () => {
  const item: PipelinePending = {
    task: 'aj4-back',
    entrega: 'transparencia-ajustes-4',
    kind: 'cp1',
    hash: 'bf700af09eee',
    command: 'APROVAR CP1 transparencia-ajustes-4 bf700af09e',
  };

  it('desativa o botão e explica por quê quando o console interativo está fechado', () => {
    const elements = stubDom();
    const send = vi.fn();
    pendingItems([item], { sendCommand: send });
    const act = elements.find((el) => el.className.includes('ui-pending__act'))!;
    const feedback = elements.find((el) => el.className.includes('ui-pending__feedback'))!;
    expect(act.disabled).toBe(true);
    expect(feedback.hidden).toBe(false);
  });

  it('agrupa sub-tarefas da mesma funcionalidade (entrega), pede confirmação no primeiro clique e envia a linha no segundo', async () => {
    const elements = stubDom();
    const consoleAgent = agent({ id: 'ger', name: 'Andrius' });
    const send = vi.fn().mockResolvedValue({ message: { id: 'm1' } });
    const fetchDoc = vi.fn().mockResolvedValue({ name: 'task-spec.md', content: '# Spec da funcionalidade' });
    const item2: PipelinePending = { ...item, task: 'aj4-front' };
    const cards = pendingItems([item, item2], { consoleAgent, sendCommand: send, fetchDoc });
    expect(cards.length).toBe(1);

    const docBtns = elements.filter((el) => el.className.includes('ui-pending__doc-btn'));
    docBtns[0]!.click();
    await Promise.resolve();
    expect(fetchDoc).toHaveBeenCalledWith('transparencia-ajustes-4', 'spec');
    const modal = elements.find((el) => el.className.includes('ui-pipe-doc ')) ?? elements.find((el) => el.className.endsWith('ui-pipe-doc'))!;
    const docMd = elements.find((el) => el.className.includes('ui-pipe-doc__md'))!;
    expect(modal.hidden).toBe(false);
    expect(docMd.textContent).toBe('# Spec da funcionalidade');

    const actButtons = elements.filter((el) => el.className.includes('ui-pending__act'));
    expect(actButtons.length).toBe(2); // um no item e outro no rodapé da janela flutuante
    const act = actButtons[1]!;
    act.click();
    expect(send).not.toHaveBeenCalled();
    expect(act.classList.contains('is-armed')).toBe(true);

    act.click();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith('ger', 'APROVAR CP1 transparencia-ajustes-4 bf700af09e');
    expect(act.classList.contains('is-done')).toBe(true);
  });
});
