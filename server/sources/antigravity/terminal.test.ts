import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { agyPipelinePhase, agyRequestText, agyTranscriptPath, createAgyTerminalParser, scanAgyUsage } from './terminal';
import { appendFileSync } from 'node:fs';

const CID = '62706453-37f5-415e-bb56-7009873c94dd';
const step = (o: Record<string, unknown>) => JSON.stringify({ status: 'DONE', created_at: '2026-11-03T18:29:47Z', ...o });

const LINES = [
  step({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content:
      '<USER_REQUEST>\nExecute SOMENTE a fase dev desta tarefa. Nao dispare outros agentes.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-03T15:29:47-03:00.\n</ADDITIONAL_METADATA>',
  }),
  step({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: '/w/_wt/aj3-back/app/A.php' } }, { name: 'run_command', args: { CommandLine: 'php artisan test' } }] }),
  step({ step_index: 2, source: 'MODEL', type: 'GENERIC', content: 'Created At: 2026-11-03T15:29:50-03:00 Completed At: 2026-11-03T15:29:51-03:00 Showing lines 1-1 of 1\n1: <?php' }),
  step({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'ERROR', content: 'Created At: x Completed At: y\nFAILED token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }),
  step({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Implementei a fatia 1.', tool_calls: [{ name: 'finish', args: { status: 'completed' } }] }),
];

describe('terminal do agy', () => {
  it('pedido sem metadados, chamadas com título, resultados ligados à chamada, segredos mascarados', () => {
    const p = createAgyTerminalParser();
    const out = LINES.flatMap((l) => p.push(l));
    expect(out.map((e) => e.kind)).toEqual(['user', 'tool', 'tool', 'result', 'result', 'assistant', 'tool']);
    expect(out[0]).toMatchObject({ kind: 'user', text: 'Execute SOMENTE a fase dev desta tarefa. Nao dispare outros agentes.' });
    expect(out[1]).toMatchObject({ kind: 'tool', tool: 'read_file', title: 'read_file(/w/_wt/aj3-back/app/A.php)', inputKind: 'json' });
    expect(out[2]).toMatchObject({ kind: 'tool', title: 'run_command(php artisan test)' });
    expect(out[3]).toMatchObject({ kind: 'result', toolUseId: out[1]!.id, text: 'Showing lines 1-1 of 1\n1: <?php' });
    expect(out[4]).toMatchObject({ kind: 'result', toolUseId: out[2]!.id, error: true });
    expect((out[4] as { text: string }).text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out[5]).toMatchObject({ kind: 'assistant', text: 'Implementei a fatia 1.' });
    expect(new Set(out.map((e) => e.id)).size).toBe(out.length);
  });

  it('linhas inválidas não quebram nada', () => {
    const p = createAgyTerminalParser();
    expect(p.push('não é json')).toEqual([]);
    expect(p.push('{"type":"USER_INPUT"}')).toEqual([]);
    expect(p.push(step({ step_index: 9, type: 'GENERIC', content: 'Created At: a Completed At: b\nsolto' }))[0]).toMatchObject({ kind: 'system', text: 'solto' });
  });

  it('caminho do transcript só para id de conversa válido; texto do pedido sem as tags do agy', () => {
    expect(agyTranscriptPath('/b', CID)).toBe(`/b/${CID}/.system_generated/logs/transcript_full.jsonl`);
    expect(agyTranscriptPath('/b', '../../etc')).toBeUndefined();
    expect(agyRequestText('<USER_REQUEST>\noi\n</USER_REQUEST>\n<X>y</X>')).toBe('oi');
    expect(agyRequestText('sem tags <X>meta</X>')).toBe('sem tags');
  });

  it('a fase do runner vem do primeiro pedido do arquivo', () => {
    const t = tempDir();
    try {
      const path = agyTranscriptPath(t.dir, CID)!;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, LINES.join('\n') + '\n');
      expect(agyPipelinePhase(path)).toBe('dev');
      const outro = join(t.dir, 'outro.jsonl');
      writeFileSync(outro, step({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Leia a.txt</USER_REQUEST>' }) + '\n');
      expect(agyPipelinePhase(outro)).toBeUndefined();
      expect(agyPipelinePhase(join(t.dir, 'nao-existe.jsonl'))).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  it('consumo: soma tokens das respostas, pega o modelo escolhido e lê só o que é novo', () => {
    const t = tempDir();
    try {
      const path = join(t.dir, 't.jsonl');
      writeFileSync(
        path,
        [
          step({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>oi</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Argon (Low). No need to mention it.\n</USER_SETTINGS_CHANGE>' }),
          step({ step_index: 1, type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 500, output_tokens: 80 }),
        ].join('\n') + '\n',
      );
      const a = scanAgyUsage(path);
      expect(a).toMatchObject({ tokensIn: 1500, tokensOut: 80, model: 'Gemini 4 Argon (Low)' });
      // Linha ainda sendo gravada (sem quebra no fim): fica para a próxima leitura.
      appendFileSync(path, step({ step_index: 2, type: 'PLANNER_RESPONSE', input_tokens: 10, output_tokens: 5 }));
      const b = scanAgyUsage(path, a);
      expect(b).toMatchObject({ tokensIn: 1500, tokensOut: 80, offset: a.offset });
      appendFileSync(path, '\n');
      expect(scanAgyUsage(path, b)).toMatchObject({ tokensIn: 1510, tokensOut: 85, model: 'Gemini 4 Argon (Low)' });
      expect(scanAgyUsage(join(t.dir, 'nao-existe'), b)).toBe(b);
    } finally {
      t.cleanup();
    }
  });
});
