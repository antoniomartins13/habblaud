// Pendências do runner do pipeline do Orca (gate, recuperação, MR para abrir): o que é, de qual tarefa e a linha que
// resolve, com botões Spec/Plano que abrem uma janela flutuante ampla (como o terminal, responsiva no celular) com
// Markdown formatado e o botão de Aprovar/Recuperar tanto no cartão quanto no rodapé da janela.
import { tr } from '../../../shared/i18n';
import type { AgentInfo, PipelinePending } from '../../../shared/types';
import { copyText, h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { maximizeButton, Movable } from './movable';

export interface PendingItemsOptions {
  /** Sessão interativa do usuário (Claude Code) que recebe o comando; ausente = console fechado. */
  consoleAgent?: AgentInfo;
  /** Envia a linha exata, sozinha, para a sessão interativa (POST /api/messages). */
  sendCommand?: (agentId: string, command: string) => Promise<{ message: unknown } | { error: string }>;
  /** Busca a spec ou o plano da tarefa (GET /api/pipeline/doc). */
  fetchDoc?: (task: string, doc: 'spec' | 'plan') => Promise<{ name: string; content: string } | { error: string }>;
}

const WHAT_LABEL: Record<PipelinePending['kind'], () => string> = {
  cp1: () => tr('Aprovar o CP1'),
  prototype: () => tr('Aprovar o protótipo'),
  blocked: () => tr('Recuperar o bloqueio'),
  draft: () => tr('Abrir o MR em draft e testar'),
};

/**
 * Acha a sessão interativa do usuário que pode receber `APROVAR` / `RECUPERAR` pelo plugin `habblaud-mensagens`:
 * agente principal do Claude Code com `canMessage`, que não é `--bg` nem sessão de fase do runner (`pipelinePhase`).
 * Prefere uma sessão aberta na própria sala; senão, a mais recente do escritório (ex.: a gerência).
 */
export function findInteractiveConsole(agents: readonly AgentInfo[], roomId?: string): AgentInfo | undefined {
  const eligible = agents.filter(
    (a) =>
      a.kind === 'main' &&
      a.canMessage &&
      !a.background &&
      !a.pipelinePhase &&
      a.status !== 'offline' &&
      a.status !== 'done' &&
      (!a.provider || a.provider === 'claude'),
  );
  if (!eligible.length) return undefined;
  if (roomId) {
    const inRoom = eligible.filter((a) => a.roomId === roomId).sort((a, b) => b.lastEventAt - a.lastEventAt);
    if (inRoom.length) return inRoom[0];
  }
  return [...eligible].sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
}

export async function defaultFetchPipelineDoc(task: string, doc: 'spec' | 'plan'): Promise<{ name: string; content: string } | { error: string }> {
  try {
    const res = await fetch(`/api/pipeline/doc?task=${encodeURIComponent(task)}&doc=${encodeURIComponent(doc)}`);
    const body = (await res.json().catch(() => undefined)) as { name?: unknown; content?: unknown; error?: unknown } | undefined;
    if (res.ok && typeof body?.content === 'string') {
      return { name: typeof body.name === 'string' ? body.name : `${task}/${doc}`, content: body.content };
    }
    return { error: typeof body?.error === 'string' ? body.error : tr('documento não encontrado') };
  } catch {
    return { error: tr('sem conexão com o servidor') };
  }
}

function createActionButton(
  label: string,
  confirmLabel: string,
  command: string,
  feedbackEl: HTMLElement,
  opts?: PendingItemsOptions,
): HTMLButtonElement {
  const consoleAgent = opts?.consoleAgent;
  const send = opts?.sendCommand;
  const btn = h('button', {
    class: 'ui-btn ui-btn--xs ui-pending__act',
    type: 'button',
    text: label,
  });
  if (!consoleAgent || !send) {
    btn.disabled = true;
    setAttr(btn, 'aria-disabled', 'true');
    setTitle(btn, tr('Console interativo fechado: abra uma sessão interativa do Claude Code no terminal para usar este botão'));
    return btn;
  }
  const idleTitle = tr('Enviar "{0}" para {1} (pede confirmação antes de mandar)', [command, consoleAgent.name]);
  setTitle(btn, idleTitle);
  let armedTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let done = false;

  const disarm = () => {
    if (armedTimer) clearTimeout(armedTimer);
    armedTimer = null;
    if (!busy && !done) {
      btn.classList.remove('is-armed');
      setText(btn, label);
      setTitle(btn, idleTitle);
    }
  };

  btn.addEventListener('click', async () => {
    if (busy || done) return;
    if (!armedTimer) {
      btn.classList.add('is-armed');
      setText(btn, confirmLabel);
      setTitle(btn, tr('Clique de novo para enviar "{0}" para {1}', [command, consoleAgent.name]));
      armedTimer = setTimeout(disarm, 4_000);
      return;
    }
    if (armedTimer) clearTimeout(armedTimer);
    armedTimer = null;
    busy = true;
    btn.disabled = true;
    btn.classList.remove('is-armed');
    setText(btn, tr('Enviando…'));
    setHidden(feedbackEl, true);
    try {
      const r = await send(consoleAgent.id, command);
      if ('error' in r) {
        busy = false;
        btn.disabled = false;
        setText(btn, label);
        setText(feedbackEl, tr('Não foi possível enviar: {0}', [r.error]));
        feedbackEl.classList.add('is-error');
        setHidden(feedbackEl, false);
        return;
      }
      done = true;
      btn.classList.add('is-done');
      setText(btn, tr('Enviado ✓'));
      setText(feedbackEl, tr('Comando enviado para {0}.', [consoleAgent.name]));
      feedbackEl.classList.remove('is-error');
      setHidden(feedbackEl, false);
    } catch (err) {
      busy = false;
      btn.disabled = false;
      setText(btn, label);
      setText(feedbackEl, tr('Não foi possível enviar: {0}', [(err as Error)?.message || tr('erro')]));
      feedbackEl.classList.add('is-error');
      setHidden(feedbackEl, false);
    }
  });
  return btn;
}

function buildActionButtonsForPending(p: PipelinePending, feedbackEl: HTMLElement, opts?: PendingItemsOptions): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (!p.command || !opts?.sendCommand) return out;
  const target = p.entrega ?? p.task;
  const label = p.kind === 'cp1' || p.kind === 'prototype' ? tr('Aprovar') : tr('Recuperar');
  const confirmLabel =
    p.kind === 'cp1'
      ? tr('Aprovar o CP1 de {0}?', [target])
      : p.kind === 'prototype'
        ? tr('Aprovar o protótipo de {0}?', [target])
        : p.command.endsWith(' validate')
          ? tr('Recuperar {0} p/ validação?', [p.task])
          : tr('Recuperar {0}?', [target]);
  out.push(createActionButton(label, confirmLabel, p.command, feedbackEl, opts));
  if (p.kind === 'blocked' && p.reason?.startsWith('dev:') && !p.command.endsWith(' validate')) {
    const valCmd = `RECUPERAR ${p.task} validate`;
    out.push(createActionButton(tr('Validar'), tr('Recuperar {0} p/ validação?', [p.task]), valCmd, feedbackEl, opts));
  }
  return out;
}

// ---------------------------------------------------------------- janela flutuante de leitura (Spec / Plano)

class PipelineDocModal {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private specTab: HTMLButtonElement;
  private planTab: HTMLButtonElement;
  private scrollEl: HTMLElement;
  private mdEl: HTMLElement;
  private footEl: HTMLElement;
  private movable: Movable | null = null;
  private currentTask = '';
  private currentDoc: 'spec' | 'plan' = 'plan';
  private rawContent = '';
  private reqSeq = 0;

  constructor() {
    const icon = h('span', { class: 'ui-term__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.terminal;
    this.titleEl = h('strong', { class: 'ui-term__name' });
    this.subEl = h('span', { class: 'ui-term__room' });

    this.specTab = h('button', {
      class: 'ui-seg__opt ui-pipe-doc__tab',
      type: 'button',
      role: 'tab',
      text: tr('Spec'),
      title: tr('Ler task-spec.md'),
    });
    this.planTab = h('button', {
      class: 'ui-seg__opt ui-pipe-doc__tab',
      type: 'button',
      role: 'tab',
      text: tr('Plano'),
      title: tr('Ler plan.md'),
    });
    const tabs = h('div', { class: 'ui-seg ui-pipe-doc__tabs', role: 'tablist' }, this.specTab, this.planTab);

    const copyDocBtn = copyButton(() => this.rawContent, tr('Copiar texto do documento'));
    const closeBtn = iconButton(ICONS.close, tr('Fechar janela (Esc)'), () => this.close(), 'ui-icon-btn--sm ui-term__close');

    const maxBtn =
      typeof addEventListener === 'function'
        ? maximizeButton(() => this.movable!)
        : null;

    const bar = h(
      'div',
      { class: 'ui-term__bar ui-pipe-doc__bar' },
      icon,
      h('span', { class: 'ui-term__kind', text: tr('pipeline') }),
      h('div', { class: 'ui-term__who' }, this.titleEl, this.subEl),
      tabs,
      copyDocBtn,
      ...(maxBtn ? [maxBtn] : []),
      closeBtn,
    );

    this.mdEl = h('div', { class: 'ui-md ui-pipe-doc__md' });
    this.scrollEl = h('div', { class: 'ui-term__scroll ui-pipe-doc__scroll', tabIndex: 0 }, this.mdEl);
    this.footEl = h('div', { class: 'ui-pipe-doc__foot' });

    this.el = h(
      'section',
      {
        class: 'ui-panel ui-term ui-pipe-doc',
        hidden: true,
        role: 'dialog',
        tabIndex: -1,
        attrs: { 'aria-label': tr('Documento da tarefa do pipeline') },
      },
      bar,
      h('div', { class: 'ui-term__body' }, this.scrollEl),
      this.footEl,
    );

    if (typeof addEventListener === 'function') {
      this.movable = new Movable(this.el, bar, {
        key: 'habblaud.move.pipedoc',
        enabled: () => typeof window !== 'undefined' && window.innerWidth > 900,
      });
      addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.el.hidden) {
          e.stopPropagation();
          this.close();
        }
      });
    }
  }

  mount(): void {
    if (this.el.parentElement) return;
    const doc = typeof document !== 'undefined' ? (document as { querySelector?: (s: string) => Element | null; body?: { append?: (n: Node) => void } }) : undefined;
    const root = doc?.querySelector?.('.ui-root') ?? doc?.body;
    root?.append?.(this.el);
  }

  close(): void {
    this.reqSeq++;
    setHidden(this.el, true);
  }

  async open(p: PipelinePending, doc: 'spec' | 'plan', opts?: PendingItemsOptions): Promise<void> {
    this.mount();
    if (!this.el.hidden && this.currentTask === p.task && this.currentDoc === doc) {
      this.close();
      return;
    }
    this.currentTask = p.task;
    this.currentDoc = doc;
    this.movable?.restore();

    const switchDoc = (next: 'spec' | 'plan') => {
      if (this.currentDoc === next && !this.el.hidden) return;
      this.currentTask = '';
      void this.open(p, next, opts);
    };
    this.specTab.onclick = () => switchDoc('spec');
    this.planTab.onclick = () => switchDoc('plan');
    this.specTab.classList.toggle('is-active', doc === 'spec');
    this.planTab.classList.toggle('is-active', doc === 'plan');
    setAttr(this.specTab, 'aria-selected', doc === 'spec' ? 'true' : 'false');
    setAttr(this.planTab, 'aria-selected', doc === 'plan' ? 'true' : 'false');

    const fileName = doc === 'spec' ? 'task-spec.md' : 'plan.md';
    setText(this.titleEl, `${p.task} · ${fileName}`);
    setText(this.subEl, `${WHAT_LABEL[p.kind]()} · ${p.entrega ?? p.task}`);
    this.rawContent = '';
    setText(this.mdEl, tr('Carregando…'));

    // Rodapé da janela com a linha do comando e o botão Aprovar/Recuperar ali mesmo
    const feedback = h('span', {
      class: 'ui-pending__feedback',
      hidden: !(opts?.sendCommand && !opts.consoleAgent && p.command),
      text: opts?.sendCommand && !opts.consoleAgent && p.command ? tr('Console interativo fechado: abra uma sessão no terminal para habilitar o botão.') : '',
    });
    const actions = buildActionButtonsForPending(p, feedback, opts);
    const footChildren: HTMLElement[] = [];
    if (p.command) {
      footChildren.push(
        h(
          'div',
          { class: 'ui-copy-row ui-pending__cmd ui-pipe-doc__cmd' },
          h('code', { text: p.command }),
          copyButton(() => p.command ?? '', tr('Copiar a linha (mande só ela na sua sessão interativa)')),
          ...actions,
        ),
      );
    }
    footChildren.push(feedback);
    if (typeof this.footEl.replaceChildren === 'function') {
      this.footEl.replaceChildren(...footChildren);
    } else {
      this.footEl.innerHTML = '';
      this.footEl.append(...footChildren);
    }
    setHidden(this.footEl, !p.command);
    setHidden(this.el, false);
    this.scrollEl.scrollTop = 0;

    const seq = ++this.reqSeq;
    const fetchDoc = opts?.fetchDoc ?? defaultFetchPipelineDoc;
    const res = await fetchDoc(p.task, doc);
    if (seq !== this.reqSeq) return;
    if ('error' in res) {
      setText(this.mdEl, res.error);
      return;
    }
    this.rawContent = res.content;
    setText(this.titleEl, `${p.task} · ${res.name}`);
    if (typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function' && typeof this.mdEl.replaceChildren === 'function') {
      this.mdEl.replaceChildren(renderMarkdown(res.content));
    } else {
      setText(this.mdEl, res.content);
    }
  }
}

let docModal: PipelineDocModal | null = null;
function getDocModal(): PipelineDocModal {
  if (!docModal) docModal = new PipelineDocModal();
  return docModal;
}

/** Limpa o singleton entre testes. */
export function resetPipelineDocModalForTest(): void {
  docModal = null;
}

export function pendingItems(items: readonly PipelinePending[], opts?: PendingItemsOptions): HTMLElement[] {
  return items.map((p) => {
    const specBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-btn',
      type: 'button',
      text: tr('Spec'),
      title: tr('Abrir task-spec.md de {0} em janela de leitura', [p.task]),
    });
    const planBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-btn',
      type: 'button',
      text: tr('Plano'),
      title: tr('Abrir plan.md de {0} em janela de leitura', [p.task]),
    });
    specBtn.addEventListener('click', () => void getDocModal().open(p, 'spec', opts));
    planBtn.addEventListener('click', () => void getDocModal().open(p, 'plan', opts));

    const feedback = h('span', {
      class: 'ui-pending__feedback',
      hidden: !(opts?.sendCommand && !opts.consoleAgent && p.command),
      text: opts?.sendCommand && !opts.consoleAgent && p.command ? tr('Console interativo fechado: abra uma sessão no terminal para habilitar o botão.') : '',
    });
    const actionButtons = buildActionButtonsForPending(p, feedback, opts);

    return h(
      'li',
      { class: `ui-pending__item ui-pending__item--${p.kind}` },
      h(
        'div',
        { class: 'ui-pending__head' },
        h('span', { class: 'ui-pending__what', text: `${WHAT_LABEL[p.kind]()} · ${p.task}` }),
        h('span', { class: 'ui-pending__docs' }, specBtn, planBtn),
      ),
      ...(p.reason ? [h('span', { class: 'ui-pending__reason', text: p.reason })] : []),
      ...(p.command
        ? [
            h(
              'span',
              { class: 'ui-copy-row ui-pending__cmd' },
              h('code', { text: p.command }),
              copyButton(() => p.command ?? '', tr('Copiar a linha (mande só ela na sua sessão interativa)')),
              ...actionButtons,
            ),
          ]
        : []),
      feedback,
    );
  });
}

/** Botão de copiar com retorno (✓ por um instante). */
export function copyButton(getText: () => string, label: string): HTMLButtonElement {
  const b = iconButton(ICONS.copy, label, async () => {
    const ok = await copyText(getText());
    b.classList.toggle('is-done', ok);
    b.innerHTML = ok ? ICONS.check : ICONS.copy;
    setTitle(b, ok ? tr('Copiado!') : tr('Não foi possível copiar'));
    setTimeout(() => {
      b.classList.remove('is-done');
      b.innerHTML = ICONS.copy;
      setTitle(b, label);
    }, 1400);
  }, 'ui-icon-btn--sm');
  return b;
}
