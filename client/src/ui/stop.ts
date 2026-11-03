// "Encerrar" no painel do agente com o Habblaud no Docker (server/spawn/stop.ts): pede ao servidor, que deixa o
// pedido para o auxiliar do host (npm run codex:bridge), e acompanha até ele confirmar. No modo Node quem encerra é
// o terminal interativo (pty.ts), e este botão não aparece.
import { tr } from '../../../shared/i18n';
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import { access } from '../net/access';
import { providerOf } from './provider';

export interface StopInfo {
  id: string;
  sessionId: string;
  status: 'queued' | 'sent' | 'stopped' | 'failed';
  how?: 'job' | 'signal';
  error?: string;
}

/** Quanto a página espera o auxiliar confirmar (o servidor desiste antes: 30 s na fila, 30 s buscado). */
const WAIT_MS = 65_000;
const POLL_MS = 700;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body;
}

/** O botão aparece para este agente? Sessão principal do Claude Code, viva, com o recurso ligado e liberado. */
export function canStop(a: AgentInfo | null | undefined, live: boolean, snap: OfficeSnapshot | null | undefined): boolean {
  return !!a && live && a.kind === 'main' && providerOf(a) === 'claude' && snap?.meta.stop === true && access().spawn;
}

/** Pede o encerramento e espera o resultado. Lança com o motivo quando não deu. */
export async function stopAgent(agentId: string, wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms))): Promise<StopInfo> {
  let info = await api<StopInfo>('/api/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  const end = Date.now() + WAIT_MS;
  while ((info.status === 'queued' || info.status === 'sent') && Date.now() < end) {
    await wait(POLL_MS);
    info = await api<StopInfo>(`/api/stop/${encodeURIComponent(info.id)}`);
  }
  if (info.status === 'failed') throw new Error(info.error ?? tr('o auxiliar não encerrou a sessão'));
  if (info.status !== 'stopped') throw new Error(tr('o auxiliar do computador não confirmou'));
  return info;
}
