import { describe, expect, it } from 'vitest';
import { asksYou, pipelinePhaseOf, pipelineTag } from './pipeline';

describe('pipelinePhaseOf', () => {
  it('lê a fase do pedido do runner (build_prompt) e ignora o resto', () => {
    expect(pipelinePhaseOf('Execute SOMENTE a fase review desta tarefa. Nao dispare outros agentes…')).toBe('review');
    expect(pipelinePhaseOf('Execute SOMENTE a fase dev desta tarefa.')).toBe('dev');
    expect(pipelinePhaseOf('  Execute SOMENTE a fase plan desta tarefa.\n\nPolitica…')).toBe('plan');
    expect(pipelinePhaseOf('Execute SOMENTE a fase deploy desta tarefa.')).toBeUndefined();
    expect(pipelinePhaseOf('Pode executar SOMENTE a fase dev desta tarefa?')).toBeUndefined();
    expect(pipelinePhaseOf('Retomar a entrega transparencia-ajustes-3')).toBeUndefined();
    expect(pipelinePhaseOf(undefined)).toBeUndefined();
  });
});

describe('pipelineTag', () => {
  it('fase do runner, ou COORD. para o principal numa sala de funcionalidade', () => {
    expect(pipelineTag({ kind: 'main', roomId: '/w/_wt/aj3-back', pipelinePhase: 'dev' })?.label).toBe('DEV');
    expect(pipelineTag({ kind: 'main', roomId: 'pipeline:entrega:x', pipelinePhase: 'review' })?.key).toBe('review');
    expect(pipelineTag({ kind: 'main', roomId: 'pipeline:entrega:x' })).toEqual({ key: 'coord', label: 'COORD.' });
    expect(pipelineTag({ kind: 'sub', roomId: 'pipeline:entrega:x' })).toBeUndefined();
    expect(pipelineTag({ kind: 'main', roomId: '/home/u/projeto' })).toBeUndefined();
  });
});

describe('asksYou', () => {
  it('respostas reais que pedem algo ao Antonio', () => {
    // Gate do pipeline num bloco de código ("mande só esta linha").
    expect(asksYou('Pronto. Se estiver de acordo, mande só esta linha:\n\n```\nAPROVAR CP1 processo-adm-3960-testes ccecccfb8b\n```')).toBe(
      'APROVAR CP1 processo-adm-3960-testes ccecccfb8b',
    );
    expect(asksYou('As três tarefas estão prontas. Você pode mandar um destes:\n\n- `RECUPERAR transparencia-ajustes-4`')).toBe('RECUPERAR transparencia-ajustes-4');
    expect(asksYou('O ambiente está no ar. Quando você testar a tela, me avise o que achou.')).toMatch(/me avise/);
    expect(asksYou('Segue o desenho. Nada foi alterado ainda.\n\nPosso implementar assim?')).toBe('Posso implementar assim?');
    expect(asksYou('Isso contradiz o que você pediu, então só sigo depois que você decidir.')).toMatch(/só sigo depois/);
    expect(asksYou('Falta alguém abrir a tela: teste no navegador quando puder.')).toMatch(/teste no navegador/);
  });

  it('relatórios que só informam não marcam', () => {
    expect(asksYou('Funcionou de ponta a ponta: o pedido saiu do escritório e o bridge confirmou.')).toBeUndefined();
    expect(asksYou('Confirmei que aj3-back, aj3-front e aj3-portal estão em `validate`. Não vou disparar o run até a liberação chegar aqui.')).toBeUndefined();
    expect(asksYou('Fase dev concluída. Testes passaram (42).')).toBeUndefined();
    expect(asksYou('')).toBeUndefined();
    expect(asksYou(undefined)).toBeUndefined();
  });

  it('pergunta dentro de bloco de código (exemplo) não conta; só o fim da resposta importa', () => {
    expect(asksYou('Exemplo de saída:\n```\nVocê quer continuar? [s/N]\n```\nTudo certo, terminei.')).toBeUndefined();
    const longo = `Você quer que eu siga? ${'x'.repeat(2_000)}\nTerminei a fatia 2.`;
    expect(asksYou(longo)).toBeUndefined();
  });
});
