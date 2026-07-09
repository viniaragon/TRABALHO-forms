# Portal Municipal de Pacientes AGSUS - Direcao de Design

## Principio

O portal deve parecer uma ferramenta de trabalho do gestor municipal: direto, denso, confiavel e facil de escanear. A prioridade visual e encontrar paciente, conferir dados e abrir laudos sem expor funcoes internas de revisao.

## Estrutura da Tela

- Login simples com marca do programa, login, senha e mensagem de erro objetiva.
- Cabecalho compacto apos login com logo, titulo, municipio autorizado, nome do usuario e botao sair.
- Barra de filtros sempre visivel no topo da area de trabalho:
  - busca por nome, CPF, CNS, telefone ou procedimento;
  - tipo de laudo;
  - faixa etaria;
  - status;
  - alerta;
  - periodo.
- KPIs pequenos e horizontais:
  - pacientes;
  - com mamografia;
  - com USG mama;
  - com USG transvaginal;
  - sem laudo;
  - com alerta.
- Tabela principal como primeiro elemento operacional:
  - paciente;
  - CPF/CNS;
  - contato;
  - nascimento/idade;
  - procedimentos;
  - laudos;
  - alertas;
  - ultima data.
- Linha expansivel para detalhes:
  - atendimentos no municipio;
  - laudos disponiveis;
  - abertura do PDF.

## Linguagem Visual

- Fundo cinza claro e paineis brancos para leitura prolongada.
- Azul institucional como cor de navegacao e cabecalho de tabela.
- Teal/verde para exames realizados e amarelo para pontos de atencao.
- Bordas discretas, raio de 7-8px e sombras leves.
- Tipografia Outfit, mantendo consistencia com as telas existentes.
- Tabela mais importante que cards; cards existem apenas para KPIs.

## Regras de Interface

- Nao mostrar botoes de revisar, desvincular, descartar ou quarentena.
- Alertas nao devem soar como erro clinico. Usar nomes neutros:
  - `40+ sem mamografia`;
  - `40+ apenas USG mama`;
  - `Menor de 40 com mamografia`;
  - `Sem laudo disponivel`;
  - `Idade desconhecida`.
- O PDF abre apenas se o laudo estiver dentro do municipio autorizado.
- Dados completos aparecem para o gestor autorizado: nome, CPF, CNS, telefone, nascimento, idade, procedimentos e laudos.

## Responsividade

- Desktop/tablet sao o alvo principal.
- Em telas menores, filtros e KPIs empilham em uma coluna.
- A tabela mantem largura minima e rolagem horizontal para preservar colunas criticas.

