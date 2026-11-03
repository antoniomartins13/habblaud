// Pipeline do Orca no escritório: o papel de cada sessão (a fase que o runner pediu) e o "aguardando você" das
// sessões que terminaram o turno pedindo algo ao usuário. Puro e sem dependências (servidor e cliente).
import { truncate } from './activity';
import { tr } from './i18n';

/** Fases que o runner (_pipeline/scripts/pipeline.py) pede a uma sessão. */
export type PipelinePhase = 'plan' | 'prototype' | 'dev' | 'validate' | 'review' | 'docs';
const PHASES: readonly PipelinePhase[] = ['plan', 'prototype', 'dev', 'validate', 'review', 'docs'];

/** O pedido do runner começa sempre assim (build_prompt): "Execute SOMENTE a fase <fase> desta tarefa." */
const RUNNER_PROMPT = /^\s*Execute SOMENTE a fase ([a-z_]+) desta tarefa\b/;

/** A fase do runner, se este for o pedido dele. */
export function pipelinePhaseOf(prompt: string | undefined): PipelinePhase | undefined {
  const m = prompt ? RUNNER_PROMPT.exec(prompt) : null;
  const phase = m?.[1] as PipelinePhase | undefined;
  return phase && PHASES.includes(phase) ? phase : undefined;
}

/**
 * Frases de quem termina o turno esperando o usuário: um gate do pipeline, um teste, uma leitura, uma decisão.
 * Heurística: na dúvida, prefere não marcar (um "aguardando você" falso cansa mais que um que faltou).
 */
const ASKS: readonly RegExp[] = [
  /\b(APROVAR\s+(CP1|PROTOTIPO)|RECUPERAR\s+[A-Za-z0-9_-]+)\b/,
  /\b(me (avise|diga|diz|fala|responda|confirme)|aguardo (a sua|sua|o seu|seu|você)|fico (aguardando|esperando)|espero (a sua|sua|o seu|seu|você))\b/i,
  /\b(você|vc) (quer|prefere|pode|precisa|decide|aprova)\b[^.\n]*\?/i,
  /\b(posso|devo) (seguir|continuar|disparar|implementar|aplicar|encerrar|publicar|abrir)\b[^.\n]*\?/i,
  /\b(quando (você|vc) (terminar|testar|aprovar|decidir|mandar|ler|conferir|voltar))\b/i,
  /\b(depende d[ae] (sua|você)|precis[oa] d[ae] (sua|você)|decisão (sua|do antonio)|só (sigo|continuo) depois)\b/i,
  /\b(teste|testar|abra|abrir|confira|conferir) (a tela|no navegador|o roteiro|a página)\b/i,
];

/** Ignora o que está dentro de blocos de código (exemplos, comandos) ao procurar o pedido. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
}

/**
 * A última resposta pede algo ao usuário? Devolve o trecho que disparou (a frase), para mostrar no escritório.
 * Só olha o fim da resposta: o pedido costuma estar no último parágrafo.
 */
export function asksYou(reply: string | undefined): string | undefined {
  if (!reply?.trim()) return undefined;
  const text = withoutCode(reply);
  const tail = text.slice(-1_200);
  // Gates do pipeline podem vir num bloco de código ("mande só esta linha:"): esses contam mesmo lá.
  const gate = /\b(APROVAR\s+(CP1|PROTOTIPO)\s+[A-Za-z0-9_-]+(\s+[0-9a-f]{8,})?|RECUPERAR\s+[A-Za-z0-9_-]+)/.exec(reply.slice(-1_500));
  if (gate) return truncate(tr1(gate[0]), 160);
  for (const re of ASKS) {
    const m = re.exec(tail);
    if (!m) continue;
    // A frase que contém o pedido.
    const start = Math.max(tail.lastIndexOf('\n', m.index), tail.lastIndexOf('. ', m.index) + 1, 0);
    const endDot = tail.slice(m.index).search(/[.?!](\s|$)|\n/);
    const end = endDot === -1 ? tail.length : m.index + endDot + 1;
    const sentence = tail.slice(start, end).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    return truncate(sentence || m[0], 160);
  }
  // Pergunta no fim da resposta.
  const last = tail.trim().split('\n').filter((l) => l.trim()).pop() ?? '';
  if (/\?\s*$/.test(last)) return truncate(last.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim(), 160);
  return undefined;
}

function tr1(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Prefixo dos ids das salas por funcionalidade (server/model/room-groups.ts). */
const GROUP_ROOM = 'pipeline:';

/**
 * Etiqueta do papel no escritório: a fase do runner (DEV, REVISÃO…) ou, para o agente principal numa sala de
 * funcionalidade sem fase, COORD. (quem você abriu para tocar a entrega). Sem etiqueta fora do pipeline.
 */
export function pipelineTag(a: { kind: string; roomId: string; pipelinePhase?: PipelinePhase }): { key: PipelinePhase | 'coord'; label: string } | undefined {
  const labels: Record<PipelinePhase | 'coord', string> = {
    plan: tr('PLANO'),
    prototype: tr('PROTÓTIPO'),
    dev: tr('DEV'),
    validate: tr('VALIDAÇÃO'),
    review: tr('REVISÃO'),
    docs: tr('DOCS'),
    coord: tr('COORD.'),
  };
  if (a.pipelinePhase) return { key: a.pipelinePhase, label: labels[a.pipelinePhase] };
  if (a.kind === 'main' && a.roomId.startsWith(GROUP_ROOM)) return { key: 'coord', label: labels.coord };
  return undefined;
}
