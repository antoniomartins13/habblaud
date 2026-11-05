// Notificações para o Mattermost via Incoming Webhook.
// Disparado estritamente quando o sistema necessita de intervenção humana (gates do pipeline ou pedidos de aprovação).
import { tr } from '../../shared/i18n';
import type { PipelinePending } from '../../shared/types';

export interface MattermostConfig {
  webhookUrl?: string;
  channel?: string;
  habblaudUrl?: string;
}

export interface MattermostPermissionNotice {
  id: string;
  agentName?: string;
  roomName?: string;
  tool?: string;
  head?: string;
}

// Os tipos de PipelinePending (status.ts): CP1, protótipo, pronto para concluir e bloqueado.
const HUMAN_ACTION_KINDS = new Set<PipelinePending['kind']>(['cp1', 'prototype', 'draft', 'blocked']);

export function readMattermostConfig(env: NodeJS.ProcessEnv = process.env): MattermostConfig {
  const webhookUrl = env.HABBLAUD_MATTERMOST_WEBHOOK_URL?.trim() || env.MATTERMOST_WEBHOOK_URL?.trim() || undefined;
  const channel = env.HABBLAUD_MATTERMOST_CHANNEL?.trim() || env.MATTERMOST_CHANNEL?.trim() || undefined;
  const habblaudUrl = env.HABBLAUD_PUBLIC_URL?.trim() || env.HABBLAUD_REMOTE_URL?.trim() || 'http://127.0.0.1:4747';
  return { webhookUrl, channel, habblaudUrl };
}

export class MattermostNotifier {
  private readonly sentKeys = new Set<string>();
  private readonly sentPermissions = new Set<string>();

  constructor(
    private readonly config: MattermostConfig,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.webhookUrl && /^https?:\/\//i.test(this.config.webhookUrl));
  }

  async send(text: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const payload: { text: string; channel?: string } = { text };
      if (this.config.channel) payload.channel = this.config.channel;

      const res = await this.fetcher(this.config.webhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Notifica pendências do pipeline que exigem ação do usuário (CP1, protótipo, pronto para draft, bloqueado).
   * Nunca repete para a mesma chave já notificada até que ela seja resolvida.
   */
  async notifyPending(items: readonly PipelinePending[]): Promise<number> {
    if (!this.isConfigured()) return 0;

    const currentKeys = new Set<string>();
    let sentCount = 0;

    for (const item of items) {
      if (!HUMAN_ACTION_KINDS.has(item.kind)) continue;
      const key = `${item.task}:${item.kind}:${item.hash ?? ''}`;
      currentKeys.add(key);

      if (this.sentKeys.has(key)) continue;

      let label = tr('Ação necessária');
      if (item.kind === 'cp1') label = tr('Aguardando aprovação de plano (CP1)');
      else if (item.kind === 'prototype') label = tr('Aguardando aprovação de protótipo');
      else if (item.kind === 'draft') label = tr('Entrega pronta para revisão e validação humana');
      else if (item.kind === 'blocked') label = tr('Fase bloqueada no runner (intervenção necessária)');

      const lines = [
        `### :warning: [Habblaud] ${label}: **${item.task}**`,
        item.reason ? `> ${item.reason.slice(0, 300)}` : '',
        item.command ? `- **Comando:** \`${item.command}\`` : '',
        this.config.habblaudUrl ? `- **Abrir no Habblaud:** ${this.config.habblaudUrl}` : '',
      ].filter(Boolean);

      const ok = await this.send(lines.join('\n'));
      if (ok) {
        this.sentKeys.add(key);
        sentCount++;
      }
    }

    // Limpa chaves de pendências que foram resolvidas
    for (const oldKey of this.sentKeys) {
      if (!currentKeys.has(oldKey)) {
        this.sentKeys.delete(oldKey);
      }
    }

    return sentCount;
  }

  /**
   * Notifica um pedido interativo de permissão que está esperando decisão do usuário no Habblaud.
   */
  async notifyPermission(notice: MattermostPermissionNotice): Promise<boolean> {
    if (!this.isConfigured()) return false;
    if (this.sentPermissions.has(notice.id)) return false;

    const lines = [
      `### :raised_hand: [Habblaud] Pedido de Permissão de **${notice.agentName || tr('Agente')}**`,
      notice.roomName ? `- **Sala:** ${notice.roomName}` : '',
      // Só o nome da ferramenta: o comando/conteúdo pedido pode ter senha, token ou código e não sai da máquina.
      notice.tool ? `- **Ferramenta:** ${notice.tool}` : '',
      this.config.habblaudUrl ? `- **Decidir no Habblaud:** ${this.config.habblaudUrl}` : '',
    ].filter(Boolean);

    const ok = await this.send(lines.join('\n'));
    if (ok) {
      this.sentPermissions.add(notice.id);
    }
    return ok;
  }

  clearResolvedPermission(id: string): void {
    this.sentPermissions.delete(id);
  }
}
