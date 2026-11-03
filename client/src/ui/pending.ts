// Pendências do runner do pipeline do Orca (gate, recuperação, MR para abrir): o que é, de qual tarefa e a linha que
// resolve, com botão de copiar (a linha vai, sozinha, na sessão interativa do usuário, onde o hook do pipeline registra).
import { tr } from '../../../shared/i18n';
import type { PipelinePending } from '../../../shared/types';
import { copyText, h, iconButton, setTitle } from './dom';
import { ICONS } from './icons';

export function pendingItems(items: readonly PipelinePending[]): HTMLElement[] {
  const what: Record<PipelinePending['kind'], string> = {
    cp1: tr('Aprovar o CP1'),
    prototype: tr('Aprovar o protótipo'),
    blocked: tr('Recuperar o bloqueio'),
    draft: tr('Abrir o MR em draft e testar'),
  };
  return items.map((p) =>
    h(
      'li',
      { class: `ui-pending__item ui-pending__item--${p.kind}` },
      h('span', { class: 'ui-pending__what', text: `${what[p.kind]} · ${p.task}` }),
      ...(p.reason ? [h('span', { class: 'ui-pending__reason', text: p.reason })] : []),
      ...(p.command
        ? [h('span', { class: 'ui-copy-row ui-pending__cmd' }, h('code', { text: p.command }), copyButton(() => p.command ?? '', tr('Copiar a linha (mande só ela na sua sessão interativa)')))]
        : []),
    ),
  );
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
