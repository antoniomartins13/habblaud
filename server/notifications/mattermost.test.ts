import { describe, expect, it, vi } from 'vitest';
import { MattermostNotifier, readMattermostConfig } from './mattermost';
import type { PipelinePending } from '../../shared/types';

describe('MattermostNotifier', () => {
  it('identifica quando está configurado ou não', () => {
    const unconf = new MattermostNotifier({});
    expect(unconf.isConfigured()).toBe(false);

    const conf = new MattermostNotifier({ webhookUrl: 'https://mattermost.example.com/hooks/xyz' });
    expect(conf.isConfigured()).toBe(true);
  });

  it('lê variáveis de ambiente com prefixo HABBLAUD ou padrão', () => {
    const cfg = readMattermostConfig({
      HABBLAUD_MATTERMOST_WEBHOOK_URL: 'https://conecta.jucese.se.gov.br/hooks/123',
      HABBLAUD_MATTERMOST_CHANNEL: 'alertas-ia',
      HABBLAUD_PUBLIC_URL: 'https://habblaud.tailnet',
    });
    expect(cfg.webhookUrl).toBe('https://conecta.jucese.se.gov.br/hooks/123');
    expect(cfg.channel).toBe('alertas-ia');
    expect(cfg.habblaudUrl).toBe('https://habblaud.tailnet');
  });

  it('envia notificação formatada para o webhook', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true };
    });

    const notifier = new MattermostNotifier(
      { webhookUrl: 'https://example.com/hook', channel: 'ia-dev', habblaudUrl: 'https://habblaud.ts' },
      mockFetch as unknown as typeof fetch,
    );

    const ok = await notifier.send('Teste de mensagem');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ text: 'Teste de mensagem', channel: 'ia-dev' });
  });

  it('notifica pendências de CP1, protótipo, ready_for_draft e blocked, e evita duplicatas', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true };
    });

    const notifier = new MattermostNotifier(
      { webhookUrl: 'https://example.com/hook' },
      mockFetch as unknown as typeof fetch,
    );

    const items: PipelinePending[] = [
      { task: 'tarefa-1', kind: 'cp1', hash: 'abc12345', command: 'APROVAR CP1 tarefa-1 abc12345' },
      { task: 'tarefa-2', kind: 'draft', command: 'CONCLUIR tarefa-2' },
    ];

    const sent = await notifier.notifyPending(items);
    expect(sent).toBe(2);
    expect(calls).toHaveLength(2);
    // Os rótulos certos (antes comparavam com awaiting_CP1/ready_for_draft, que nunca chegam).
    expect(JSON.stringify(calls[0])).toContain('CP1');
    expect(JSON.stringify(calls[1])).toContain('pronta');

    // Na segunda rodada com os mesmos itens, não reenvia nada
    const sentAgain = await notifier.notifyPending(items);
    expect(sentAgain).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('notifica pedido de permissão pendente e evita duplicação', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true };
    });

    const notifier = new MattermostNotifier(
      { webhookUrl: 'https://example.com/hook' },
      mockFetch as unknown as typeof fetch,
    );

    const ok1 = await notifier.notifyPermission({
      id: 'perm-1',
      agentName: 'Sofia',
      roomName: 'processo-adm-3960-testes',
      tool: 'Bash',
      head: 'DB_PASSWORD=segredo php artisan migrate',
    });
    expect(ok1).toBe(true);
    expect(calls).toHaveLength(1);
    // O comando (que pode ter senha ou código) não sai da máquina: só o nome da ferramenta.
    expect(JSON.stringify(calls[0])).toContain('Bash');
    expect(JSON.stringify(calls[0])).not.toContain('segredo');
    expect(JSON.stringify(calls[0])).not.toContain('artisan');

    // Duplicado ignorado
    const ok2 = await notifier.notifyPermission({
      id: 'perm-1',
      agentName: 'Sofia',
      head: 'php artisan migrate',
    });
    expect(ok2).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
