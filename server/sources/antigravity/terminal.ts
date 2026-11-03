// Terminal das conversas do Antigravity CLI (agy): lê o transcript que o agy grava em
// <brain>/<conversationId>/.system_generated/logs/transcript_full.jsonl (um passo por linha) e monta as TerminalEntry
// do terminal do escritório, como o do Claude Code e o do Codex.
//
// O que o arquivo traz (só a estrutura; conferido no agy 1.4.12):
// - USER_INPUT (source USER_EXPLICIT): o pedido em <USER_REQUEST>…</USER_REQUEST>, seguido de metadados do agy
//   (<ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>…), que não são do usuário e ficam de fora;
// - PLANNER_RESPONSE (source MODEL): o texto da resposta (`content`, quando houver) e as chamadas de ferramenta
//   (`tool_calls`: [{name, args}]);
// - GENERIC: o resultado de uma ferramenta, na ordem das chamadas, começando por "Created At: … Completed At: …".
// O transcript_full não corta nada (o transcript.jsonl corta e marca `truncated_fields`): os limites são os nossos.
// Só lê: o arquivo traz o texto dos pedidos, então o terminal segue com a mesma trava do resto (acesso local, ou
// `terminal` no acesso remoto) e mascara segredos como os outros.
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import { pipelinePhaseOf, type PipelinePhase } from '../../../shared/pipeline';
import type { TerminalEntry } from '../../../shared/types';
import { INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, type TerminalParser } from '../terminal';

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O transcript completo de uma conversa do agy, dentro da pasta brain/. */
export function agyTranscriptPath(brainDir: string, conversationId: string): string | undefined {
  if (!CONVERSATION_ID.test(conversationId)) return undefined;
  return join(brainDir, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

/** O texto do pedido, sem os metadados que o agy junta (só o miolo de <USER_REQUEST>, quando houver). */
export function agyRequestText(content: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (m ? m[1]! : content.replace(/<([A-Z_]+)>[\s\S]*?<\/\1>/g, '')).trim();
}

/** Tira o cabeçalho "Created At: … Completed At: …" do resultado de uma ferramenta. */
function resultText(content: string): string {
  return content.replace(/^\s*Created At:\s*\S+\s*Completed At:\s*\S+\s*/, '').trim();
}

function clip(text: string, max: number, maxLines?: number): { text: string; truncated: boolean } {
  let out = text;
  let truncated = false;
  if (maxLines !== undefined) {
    const lines = out.split('\n');
    if (lines.length > maxLines) {
      out = lines.slice(0, maxLines).join('\n');
      truncated = true;
    }
  }
  if (out.length > max) {
    out = out.slice(0, max);
    truncated = true;
  }
  return { text: maskSecrets(out), truncated };
}

/** O argumento que dá nome à chamada: o caminho, o comando ou a consulta. */
function toolTitle(name: string, args: Record<string, unknown>): string {
  const pick = ['Path', 'AbsolutePath', 'TargetFile', 'CommandLine', 'Command', 'Query', 'Url', 'SearchPath'];
  for (const k of pick) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return `${name}(${truncate(v.replace(/^"|"$/g, '').trim(), 120)})`;
  }
  return name;
}

function toolInput(args: Record<string, unknown>): string | undefined {
  if (!args || !Object.keys(args).length) return undefined;
  let s: string;
  try {
    s = JSON.stringify(args, null, 2);
  } catch {
    return undefined;
  }
  return clip(s, INPUT_MAX).text;
}

function epoch(v: unknown, fallback: number): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? fallback : t;
}

class AgyTerminalParser implements TerminalParser {
  /** Chamadas ainda sem resultado, na ordem (o GENERIC seguinte é o resultado da primeira). */
  private pending: string[] = [];
  private last = 0;

  push(line: string): TerminalEntry[] {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (!o || typeof o !== 'object') return [];
    const step = typeof o.step_index === 'number' ? o.step_index : undefined;
    if (step === undefined) return [];
    const at = epoch(o.created_at, this.last);
    this.last = at;
    const id = `agy:${step}`;
    const content = typeof o.content === 'string' ? o.content : '';
    const failed = typeof o.status === 'string' && !/^(DONE|RUNNING|PENDING)$/.test(o.status);
    const out: TerminalEntry[] = [];
    switch (o.type) {
      case 'USER_INPUT': {
        const text = agyRequestText(content);
        this.pending = [];
        if (text) out.push({ kind: 'user', id, at, text: clip(text, TEXT_MAX).text });
        break;
      }
      case 'PLANNER_RESPONSE': {
        if (content.trim()) out.push({ kind: 'assistant', id: `${id}:t`, at, text: clip(content.trim(), TEXT_MAX).text });
        const calls = Array.isArray(o.tool_calls) ? (o.tool_calls as Array<Record<string, unknown>>) : [];
        calls.forEach((c, i) => {
          const name = typeof c?.name === 'string' && c.name ? c.name : 'ferramenta';
          const args = c?.args && typeof c.args === 'object' ? (c.args as Record<string, unknown>) : {};
          const toolId = `${id}:${i}`;
          this.pending.push(toolId);
          const input = toolInput(args);
          out.push({ kind: 'tool', id: toolId, at, tool: name, title: maskSecrets(toolTitle(name, args)), ...(input ? { input, inputKind: 'json' as const } : {}) });
        });
        break;
      }
      case 'GENERIC': {
        const toolUseId = this.pending.shift();
        const c = clip(resultText(content), RESULT_MAX, RESULT_MAX_LINES);
        if (toolUseId) out.push({ kind: 'result', id: `${id}:r`, at, toolUseId, text: c.text, ...(failed ? { error: true } : {}), ...(c.truncated ? { truncated: true } : {}) });
        else if (c.text) out.push({ kind: 'system', id, at, text: truncate(c.text, 300), level: failed ? 'error' : 'info' });
        break;
      }
      default:
        if (content.trim()) out.push({ kind: 'system', id, at, text: truncate(maskSecrets(content.trim()), 300), level: failed ? 'error' : 'info' });
    }
    return out;
  }
}

export function createAgyTerminalParser(): TerminalParser {
  return new AgyTerminalParser();
}

/** A fase do runner pedida na conversa (primeiro USER_INPUT do transcript), lendo só o começo do arquivo. */
export function agyPipelinePhase(path: string, maxBytes = 256 * 1024): PipelinePhase | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"USER_INPUT"')) continue;
      try {
        const o = JSON.parse(line) as { type?: string; content?: string };
        if (o.type === 'USER_INPUT') return pipelinePhaseOf(agyRequestText(o.content ?? ''));
      } catch {
        return undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Consumo lido do transcript: tokens das respostas do modelo e o modelo escolhido na sessão. */
export interface AgyUsage {
  /** Até onde o arquivo já foi lido (bytes). */
  offset: number;
  tokensIn: number;
  tokensOut: number;
  model?: string;
}

/**
 * Soma o consumo das linhas novas do transcript (a partir de `prev.offset`): input_tokens + cache_read_tokens e
 * output_tokens de cada PLANNER_RESPONSE, e o modelo da última troca de "Model Selection" que o agy registra no pedido.
 * Linha cortada no fim fica para a próxima leitura.
 */
export function scanAgyUsage(path: string, prev: AgyUsage = { offset: 0, tokensIn: 0, tokensOut: 0 }, maxBytes = 4 * 1024 * 1024): AgyUsage {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, prev.offset);
    const chunk = buf.subarray(0, n).toString('utf8');
    const end = chunk.lastIndexOf('\n');
    if (end < 0) return prev;
    const next: AgyUsage = { ...prev, offset: prev.offset + Buffer.byteLength(chunk.slice(0, end + 1)) };
    for (const line of chunk.slice(0, end).split('\n')) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (o.type === 'PLANNER_RESPONSE') {
        const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0);
        next.tokensIn += num('input_tokens') + num('cache_read_tokens');
        next.tokensOut += num('output_tokens');
      } else if (o.type === 'USER_INPUT' && typeof o.content === 'string') {
        const m = /Model Selection`? from .*? to ([^.\n]+)/.exec(o.content);
        if (m) next.model = m[1]!.trim();
      }
    }
    return next;
  } catch {
    return prev;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
