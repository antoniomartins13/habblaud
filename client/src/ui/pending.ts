// Pendências do runner do pipeline do Orca (gate, recuperação, MR para abrir): o que é, de qual tarefa e a linha que
// resolve, com botões Spec/Plano que abrem uma janela flutuante ampla (como o terminal, responsiva no celular) com
// Markdown formatado e o botão de Aprovar/Recuperar tanto no cartão quanto no rodapé da janela.
import { tr } from '../../../shared/i18n';
import type { AgentInfo, PipelinePending } from '../../../shared/types';
import { copyText, h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { maximizeButton, Movable } from './movable';

export type PipelineDocKind = 'spec' | 'plan' | 'review' | 'docs' | 'roteiro';

export interface PendingItemsOptions {
  /** Sessão interativa do usuário (Claude Code) que recebe o comando; ausente = console fechado. */
  consoleAgent?: AgentInfo;
  /** Envia a linha exata, sozinha, para a sessão interativa (POST /api/messages). */
  sendCommand?: (agentId: string, command: string) => Promise<{ message: unknown } | { error: string }>;
  /** Busca a spec, plano, revisão ou documentação da funcionalidade/tarefa (GET /api/pipeline/doc). */
  fetchDoc?: (task: string, doc: PipelineDocKind) => Promise<{ name: string; content: string } | { error: string }>;
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
 * Prefere o console do pipeline (título fixo); senão, uma sessão aberta na própria sala; senão, a mais recente.
 */
/** Titulo da sessao do console sem janela (`_pipeline/scripts/console.sh -n`). */
export const PIPELINE_CONSOLE_TITLE = 'Console do pipeline';

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
  // O console do pipeline (habblaud-console.service, titulo fixo) sempre vence: gate nao vai para a sessao
  // de trabalho mais recente nem para a coordenadora da sala.
  const pipelineConsole = eligible.find((a) => a.title === PIPELINE_CONSOLE_TITLE);
  if (pipelineConsole) return pipelineConsole;
  if (roomId) {
    const inRoom = eligible.filter((a) => a.roomId === roomId).sort((a, b) => b.lastEventAt - a.lastEventAt);
    if (inRoom.length) return inRoom[0];
  }
  return [...eligible].sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
}

export async function defaultFetchPipelineDoc(task: string, doc: PipelineDocKind): Promise<{ name: string; content: string } | { error: string }> {
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
  commandOrGetter: string | (() => string),
  feedbackEl: HTMLElement,
  opts?: PendingItemsOptions,
  extraClass = 'ui-pending__act',
): HTMLButtonElement {
  const consoleAgent = opts?.consoleAgent;
  const send = opts?.sendCommand;
  const resolveCmd = typeof commandOrGetter === 'function' ? commandOrGetter : () => commandOrGetter;
  const btn = h('button', {
    class: `ui-btn ui-btn--xs ${extraClass}`,
    type: 'button',
    text: label,
  });
  if (!consoleAgent || !send) {
    btn.disabled = true;
    setAttr(btn, 'aria-disabled', 'true');
    setTitle(btn, tr('Console interativo fechado: abra uma sessão interativa do Claude Code no terminal para usar este botão'));
    return btn;
  }
  const idleTitle = tr('Enviar comando para {0} (pede confirmação antes de mandar)', [consoleAgent.name]);
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
    const command = resolveCmd().trim();
    if (!command) {
      setText(feedbackEl, tr('Escreva ou edite os pontos da correção antes de enviar.'));
      feedbackEl.classList.add('is-error');
      setHidden(feedbackEl, false);
      return;
    }
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

function buildActionButtonsForPending(
  p: PipelinePending,
  feedbackEl: HTMLElement,
  opts?: PendingItemsOptions,
  onRequestCorrection?: () => void,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  const target = p.entrega ?? p.task;
  const cmd = p.command ?? (p.kind === 'draft' ? `CONCLUIR ${target}` : undefined);
  if (cmd && opts?.sendCommand) {
    const label =
      p.kind === 'cp1' || p.kind === 'prototype'
        ? tr('Aprovar')
        : p.kind === 'draft'
          ? tr('Concluir')
          : tr('Recuperar');
    const confirmLabel =
      p.kind === 'cp1'
        ? tr('Aprovar o CP1 de {0}?', [target])
        : p.kind === 'prototype'
          ? tr('Aprovar o protótipo de {0}?', [target])
          : p.kind === 'draft'
            ? tr('Concluir {0}?', [target])
            : cmd.endsWith(' validate')
              ? tr('Recuperar {0} p/ validação?', [target])
              : tr('Recuperar {0}?', [target]);
    out.push(createActionButton(label, confirmLabel, cmd, feedbackEl, opts));
    if (p.kind === 'blocked' && (p.reason?.startsWith('dev:') || p.reason?.includes(': dev:')) && !cmd.endsWith(' validate')) {
      const valCmd = `RECUPERAR ${target} validate`;
      out.push(createActionButton(tr('Validar'), tr('Recuperar {0} p/ validação?', [target]), valCmd, feedbackEl, opts));
    }
  }
  if ((p.kind === 'draft' || p.kind === 'blocked') && onRequestCorrection) {
    const corrBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__corr-btn',
      type: 'button',
      text: tr('Pedir correção'),
      title: tr('Abrir a revisão de {0}, remover ou acrescentar pontos e devolver para o autor corrigir', [target]),
    });
    corrBtn.addEventListener('click', onRequestCorrection);
    out.push(corrBtn);
  }
  return out;
}

/** Consolida sub-tarefas da mesma funcionalidade (`entrega`) e mesmo tipo (`kind`) em um único card. */
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
      if (clone.kind === 'blocked' && clone.command) {
        clone.command = clone.reason?.includes('Dev sem progresso') ? `RECUPERAR ${p.entrega} validate` : `RECUPERAR ${p.entrega}`;
      }
      const entry = { item: clone, tasks: [p.task], reasons: p.reason ? [`${p.task}: ${p.reason}`] : [] };
      byKey.set(key, entry);
      out.push(clone);
    } else {
      existing.tasks.push(p.task);
      if (p.reason) existing.reasons.push(`${p.task}: ${p.reason}`);
      if (!existing.item.hash && p.hash) existing.item.hash = p.hash;
      if (existing.item.kind === 'blocked' && p.reason?.includes('Dev sem progresso')) {
        existing.item.command = `RECUPERAR ${p.entrega} validate`;
      }
    }
  }
  for (const { item, tasks, reasons } of byKey.values()) {
    if (tasks.length > 1 && reasons.length) {
      item.reason = reasons.join(' · ').slice(0, 240);
    }
  }
  return out;
}

// ---------------------------------------------------------------- janela flutuante de leitura (Spec / Revisão / Entrega / Plano)

const DOC_DEFAULT_NAME: Record<PipelineDocKind, string> = {
  spec: 'task-spec.md',
  review: 'review-report.md',
  docs: 'documentacao-tecnica.md',
  plan: 'plan.md',
  roteiro: 'roteiro-teste.md',
};

class PipelineDocModal {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private tabButtons: Record<PipelineDocKind, HTMLButtonElement>;
  private scrollEl: HTMLElement;
  private mdEl: HTMLElement;
  private footEl: HTMLElement;
  private movable: Movable | null = null;
  private currentTask = '';
  private currentDoc: PipelineDocKind = 'spec';
  private rawContent = '';
  private reqSeq = 0;

  constructor() {
    const icon = h('span', { class: 'ui-term__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.terminal;
    this.titleEl = h('strong', { class: 'ui-term__name' });
    this.subEl = h('span', { class: 'ui-term__room' });

    this.tabButtons = {
      spec: h('button', {
        class: 'ui-seg__opt ui-pipe-doc__tab',
        type: 'button',
        role: 'tab',
        text: tr('Spec'),
        title: tr('Ler especificação da funcionalidade (task-spec.md)'),
      }),
      review: h('button', {
        class: 'ui-seg__opt ui-pipe-doc__tab',
        type: 'button',
        role: 'tab',
        text: tr('Revisão'),
        title: tr('Ler parecer da revisão (review-report.md)'),
      }),
      docs: h('button', {
        class: 'ui-seg__opt ui-pipe-doc__tab',
        type: 'button',
        role: 'tab',
        text: tr('Entrega'),
        title: tr('Ler documentação técnica da entrega (documentacao-tecnica.md)'),
      }),
      plan: h('button', {
        class: 'ui-seg__opt ui-pipe-doc__tab',
        type: 'button',
        role: 'tab',
        text: tr('Plano'),
        title: tr('Ler planos técnicos gerados pelos runners (plan.md)'),
      }),
      roteiro: h('button', {
        class: 'ui-seg__opt ui-pipe-doc__tab',
        type: 'button',
        role: 'tab',
        text: tr('Roteiro'),
        title: tr('Ler o roteiro de teste manual, com os links do servidor de revisão e dos MRs (roteiro-teste.md)'),
      }),
    };
    const tabs = h(
      'div',
      { class: 'ui-seg ui-pipe-doc__tabs', role: 'tablist' },
      this.tabButtons.spec,
      this.tabButtons.review,
      this.tabButtons.docs,
      this.tabButtons.plan,
      this.tabButtons.roteiro,
    );

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

  async open(p: PipelinePending, doc: PipelineDocKind, opts?: PendingItemsOptions, openCorrection = false): Promise<void> {
    this.mount();
    const target = p.entrega ?? p.task;
    if (!this.el.hidden && this.currentTask === target && this.currentDoc === doc && !openCorrection) {
      this.close();
      return;
    }
    this.currentTask = target;
    this.currentDoc = doc;
    this.movable?.restore();

    const switchDoc = (next: PipelineDocKind) => {
      if (this.currentDoc === next && !this.el.hidden) return;
      this.currentTask = '';
      void this.open(p, next, opts);
    };
    for (const k of ['spec', 'review', 'docs', 'plan', 'roteiro'] as const) {
      const b = this.tabButtons[k];
      b.onclick = () => switchDoc(k);
      b.classList.toggle('is-active', doc === k);
      setAttr(b, 'aria-selected', doc === k ? 'true' : 'false');
    }

    const fileName = DOC_DEFAULT_NAME[doc];
    setText(this.titleEl, `${target} · ${fileName}`);
    setText(this.subEl, `${WHAT_LABEL[p.kind]()} · ${target}`);
    this.rawContent = '';
    setText(this.mdEl, tr('Carregando…'));

    const cmd = p.command ?? (p.kind === 'draft' ? `CONCLUIR ${target}` : undefined);
    const feedback = h('span', {
      class: 'ui-pending__feedback',
      hidden: !(opts?.sendCommand && !opts.consoleAgent && cmd),
      text: opts?.sendCommand && !opts.consoleAgent && cmd ? tr('Console interativo fechado: abra uma sessão no terminal para habilitar os botões.') : '',
    });

    // Caixa de curadoria/correção: permite carregar os pontos da revisão da IA, apagar o que descartar e acrescentar
    const textarea = h('textarea', {
      class: 'ui-input ui-pipe-doc__textarea',
      attrs: {
        rows: '5',
        placeholder: tr('Edite os pontos da revisão (apague o que descartar e acrescente o que faltar) para enviar ao autor…'),
      },
    }) as HTMLTextAreaElement;

    const loadReviewIntoTextarea = async () => {
      if (this.currentDoc === 'review' && this.rawContent.trim()) {
        textarea.value = this.rawContent.trim();
        return;
      }
      const fetchDoc = opts?.fetchDoc ?? defaultFetchPipelineDoc;
      let r = await fetchDoc(target, 'review');
      if ('error' in r && p.entrega && p.entrega !== p.task) {
        r = await fetchDoc(p.task, 'review');
      }
      if (!('error' in r) && r.content.trim()) {
        textarea.value = r.content.trim();
      }
    };

    const useReviewBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pipe-doc__use-review',
      type: 'button',
      text: tr('Carregar pontos da revisão'),
      title: tr('Copia o parecer da revisão (review-report.md) para a caixa de edição para você remover ou acrescentar itens'),
    });
    useReviewBtn.addEventListener('click', () => void loadReviewIntoTextarea());

    const sendCorrBtn = createActionButton(
      tr('Enviar correção'),
      tr('Confirmar correção de {0}?', [target]),
      () => {
        const val = (textarea.value ?? '').trim();
        if (!val) return '';
        return `CORRIGIR ${target}: ${val.replace(/\r?\n/g, '\\n')}`;
      },
      feedback,
      opts,
      'ui-pending__corr-send',
    );

    const corrBox = h(
      'div',
      { class: 'ui-pipe-doc__corr', hidden: !openCorrection },
      h(
        'div',
        { class: 'ui-pipe-doc__corr-head' },
        h('span', {
          class: 'ui-pipe-doc__corr-hint',
          text: tr('Curadoria da revisão: remova pontos da IA que não devem ser cobrados ou acrescente os seus (vai para DECISOES-HUMANAS.md):'),
        }),
        useReviewBtn,
      ),
      textarea,
      h('div', { class: 'ui-pipe-doc__corr-actions' }, sendCorrBtn),
    );

    const toggleCorrection = () => {
      const nextOpen = corrBox.hidden;
      setHidden(corrBox, !nextOpen);
      if (nextOpen && !textarea.value) {
        void loadReviewIntoTextarea();
      }
    };

    const actions = buildActionButtonsForPending(p, feedback, opts, toggleCorrection);
    const footChildren: HTMLElement[] = [];
    if (cmd) {
      footChildren.push(
        h(
          'div',
          { class: 'ui-copy-row ui-pending__cmd ui-pipe-doc__cmd' },
          h('code', { text: cmd }),
          copyButton(() => cmd, tr('Copiar a linha (mande só ela na sua sessão interativa)')),
          ...actions,
        ),
      );
    }
    footChildren.push(corrBox, feedback);
    if (typeof this.footEl.replaceChildren === 'function') {
      this.footEl.replaceChildren(...footChildren);
    } else {
      this.footEl.innerHTML = '';
      this.footEl.append(...footChildren);
    }
    setHidden(this.footEl, !cmd && openCorrection === false);
    setHidden(this.el, false);
    this.scrollEl.scrollTop = 0;

    const seq = ++this.reqSeq;
    const fetchDoc = opts?.fetchDoc ?? defaultFetchPipelineDoc;
    let res = await fetchDoc(target, doc);
    if ('error' in res && p.entrega && p.entrega !== p.task) {
      res = await fetchDoc(p.task, doc);
    }
    if (seq !== this.reqSeq) return;
    if ('error' in res) {
      setText(this.mdEl, res.error);
      return;
    }
    this.rawContent = res.content;
    setText(this.titleEl, `${target} · ${res.name}`);
    if (openCorrection && doc === 'review' && !textarea.value && res.content.trim()) {
      textarea.value = res.content.trim();
    }
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
  return groupPendingByEntrega(items).map((p) => {
    const target = p.entrega ?? p.task;
    const cmd = p.command ?? (p.kind === 'draft' ? `CONCLUIR ${target}` : undefined);
    const specBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-btn',
      type: 'button',
      text: tr('Spec'),
      title: tr('Abrir task-spec.md de {0} em janela de leitura', [target]),
    });
    const planBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-btn',
      type: 'button',
      text: tr('Plano'),
      title: tr('Abrir plan.md de {0} em janela de leitura', [target]),
    });
    const reviewBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-btn',
      type: 'button',
      text: tr('Revisão'),
      title: tr('Abrir parecer de revisão (review-report.md) de {0}', [target]),
    });
    const roteiroBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-btn',
      type: 'button',
      text: tr('Roteiro'),
      title: tr('Abrir o roteiro de teste (roteiro-teste.md) de {0}', [target]),
    });
    roteiroBtn.addEventListener('click', () => void getDocModal().open(p, 'roteiro', opts));
    specBtn.addEventListener('click', () => void getDocModal().open(p, 'spec', opts));
    planBtn.addEventListener('click', () => void getDocModal().open(p, 'plan', opts));
    reviewBtn.addEventListener('click', () => void getDocModal().open(p, 'review', opts));

    const feedback = h('span', {
      class: 'ui-pending__feedback',
      hidden: !(opts?.sendCommand && !opts.consoleAgent && cmd),
      text: opts?.sendCommand && !opts.consoleAgent && cmd ? tr('Console interativo fechado: abra uma sessão no terminal para habilitar o botão.') : '',
    });
    const actionButtons = buildActionButtonsForPending(p, feedback, opts, () => {
      void getDocModal().open(p, 'review', opts, true);
    });
    const docButtons =
      p.kind === 'draft' ? [roteiroBtn, specBtn, planBtn, reviewBtn] : p.kind === 'blocked' ? [specBtn, planBtn, reviewBtn] : [specBtn, planBtn];
    // Servidores de revisão e MRs (só https, validados no servidor): abrem em aba nova, sem acesso de volta.
    const links = (p.links ?? []).map((l) =>
      h('a', { class: 'ui-btn ui-btn--xs ui-pending__link', text: l.label, attrs: { href: l.url, target: '_blank', rel: 'noopener noreferrer' } }),
    );

    return h(
      'li',
      { class: `ui-pending__item ui-pending__item--${p.kind}` },
      h(
        'div',
        { class: 'ui-pending__head' },
        h('span', { class: 'ui-pending__what', text: `${WHAT_LABEL[p.kind]()} · ${target}` }),
        h('span', { class: 'ui-pending__docs' }, ...docButtons),
      ),
      ...(p.reason ? [h('span', { class: 'ui-pending__reason', text: p.reason })] : []),
      ...(links.length ? [h('span', { class: 'ui-pending__links' }, ...links)] : []),
      ...(cmd
        ? [
            h(
              'span',
              { class: 'ui-copy-row ui-pending__cmd' },
              h('code', { text: cmd }),
              copyButton(() => cmd, tr('Copiar a linha (mande só ela na sua sessão interativa)')),
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
