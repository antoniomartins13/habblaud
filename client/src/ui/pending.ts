// Pendências do runner do pipeline do Orca (gate, recuperação, MR para abrir): o que é, de qual tarefa e a linha que
// resolve, com leitura da spec e do plano ao lado, botão de copiar e botão de Aprovar/Recuperar (com confirmação em
// dois cliques, enviando a linha exata, sozinha, para a sessão interativa do usuário).
import { tr } from '../../../shared/i18n';
import type { AgentInfo, PipelinePending } from '../../../shared/types';
import { copyText, h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { ICONS } from './icons';

export interface PendingItemsOptions {
  /** Sessão interativa do usuário (Claude Code) que recebe o comando; ausente = console fechado. */
  consoleAgent?: AgentInfo;
  /** Envia a linha exata, sozinha, para a sessão interativa (POST /api/messages). */
  sendCommand?: (agentId: string, command: string) => Promise<{ message: unknown } | { error: string }>;
  /** Busca a spec ou o plano da tarefa (GET /api/pipeline/doc). */
  fetchDoc?: (task: string, doc: 'spec' | 'plan') => Promise<{ name: string; content: string } | { error: string }>;
}

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

export function pendingItems(items: readonly PipelinePending[], opts?: PendingItemsOptions): HTMLElement[] {
  const what: Record<PipelinePending['kind'], string> = {
    cp1: tr('Aprovar o CP1'),
    prototype: tr('Aprovar o protótipo'),
    blocked: tr('Recuperar o bloqueio'),
    draft: tr('Abrir o MR em draft e testar'),
  };
  const fetchDoc = opts?.fetchDoc ?? defaultFetchPipelineDoc;
  return items.map((p) => {
    const target = p.entrega ?? p.task;
    const docTitle = h('strong', { class: 'ui-pending__doc-title' });
    const docBody = h('pre', { class: 'ui-pending__doc-body' });
    let openDoc: 'spec' | 'plan' | null = null;
    const specBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-btn',
      type: 'button',
      text: tr('Spec'),
      title: tr('Ler task-spec.md de {0}', [p.task]),
    });
    const planBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-btn',
      type: 'button',
      text: tr('Plano'),
      title: tr('Ler plan.md de {0}', [p.task]),
    });
    const closeDoc = () => {
      openDoc = null;
      specBtn.classList.remove('is-active');
      planBtn.classList.remove('is-active');
      setHidden(docBox, true);
    };
    const closeBtn = h('button', {
      class: 'ui-btn ui-btn--xs ui-pending__doc-close',
      type: 'button',
      text: tr('Fechar'),
      on: { click: closeDoc },
    });
    const docBox = h(
      'div',
      { class: 'ui-pending__doc-box', hidden: true },
      h('div', { class: 'ui-pending__doc-head' }, docTitle, closeBtn),
      docBody,
    );
    const toggleDoc = async (doc: 'spec' | 'plan') => {
      if (openDoc === doc) {
        closeDoc();
        return;
      }
      openDoc = doc;
      specBtn.classList.toggle('is-active', doc === 'spec');
      planBtn.classList.toggle('is-active', doc === 'plan');
      setText(docTitle, `${p.task} · ${doc === 'spec' ? 'task-spec.md' : 'plan.md'}`);
      setText(docBody, tr('Carregando…'));
      setHidden(docBox, false);
      const res = await fetchDoc(p.task, doc);
      if (openDoc !== doc) return;
      if ('error' in res) {
        setText(docBody, res.error);
      } else {
        setText(docTitle, `${p.task} · ${res.name}`);
        setText(docBody, res.content);
      }
    };
    specBtn.addEventListener('click', () => void toggleDoc('spec'));
    planBtn.addEventListener('click', () => void toggleDoc('plan'));

    const feedback = h('span', {
      class: 'ui-pending__feedback',
      hidden: !(opts?.sendCommand && !opts.consoleAgent && p.command),
      text: opts?.sendCommand && !opts.consoleAgent && p.command ? tr('Console interativo fechado: abra uma sessão no terminal para habilitar o botão.') : '',
    });

    const actionButtons: HTMLElement[] = [];
    if (p.command && opts?.sendCommand) {
      const label = p.kind === 'cp1' || p.kind === 'prototype' ? tr('Aprovar') : tr('Recuperar');
      const confirmLabel =
        p.kind === 'cp1'
          ? tr('Aprovar o CP1 de {0}?', [target])
          : p.kind === 'prototype'
            ? tr('Aprovar o protótipo de {0}?', [target])
            : p.command.endsWith(' validate')
              ? tr('Recuperar {0} p/ validação?', [p.task])
              : tr('Recuperar {0}?', [target]);
      actionButtons.push(createActionButton(label, confirmLabel, p.command, feedback, opts));
      if (p.kind === 'blocked' && p.reason?.startsWith('dev:') && !p.command.endsWith(' validate')) {
        const valCmd = `RECUPERAR ${p.task} validate`;
        actionButtons.push(createActionButton(tr('Validar'), tr('Recuperar {0} p/ validação?', [p.task]), valCmd, feedback, opts));
      }
    }

    return h(
      'li',
      { class: `ui-pending__item ui-pending__item--${p.kind}` },
      h(
        'div',
        { class: 'ui-pending__head' },
        h('span', { class: 'ui-pending__what', text: `${what[p.kind]} · ${p.task}` }),
        h('span', { class: 'ui-pending__docs' }, specBtn, planBtn),
      ),
      docBox,
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
