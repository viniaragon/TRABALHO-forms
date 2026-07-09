# Portal Municipal de Pacientes AGSUS - Guia de Funcionalidades

## MVP Implementado

- Nova pagina `portal-gestor.html` separada da tela interna `pacientes.html`.
- Login de gestor com sessao em cookie `HttpOnly`.
- Usuarios gestores gravados no PostgreSQL em `oci.portal_gestor_usuarios`.
- Sessoes gravadas em `oci.portal_gestor_sessoes`.
- Auditoria simples em `oci.portal_gestor_auditoria`.
- Script manual para criar/atualizar gestor municipal:
  - `node scripts/criar-gestor-municipal.mjs --login gestor.irece --senha "senha-forte" --municipio "IRECE" --nome "Gestor Irece"`
- Script em lote para os gestores da primeira lista:
  - `node scripts/criar-gestores-municipais-lote.mjs`
- Listagem restrita ao municipio exato do usuario.
- Busca por nome, CPF, CNS, telefone, procedimento e metadados dos laudos.
- Filtros por tipo de laudo, idade, status, alerta e periodo.
- KPIs calculados dentro do mesmo escopo municipal.
- Abertura de PDF apenas quando o laudo pertence ao municipio autorizado.

## Permissoes

- Gestor municipal:
  - pode autenticar;
  - pode listar pacientes do proprio municipio;
  - pode ver dados completos dos pacientes autorizados;
  - pode abrir PDFs autorizados.
- Gestor municipal nao pode:
  - revisar vinculo de laudo;
  - desvincular laudo;
  - descartar documentos;
  - acessar quarentena;
  - consultar candidatos de revisao;
  - ver pacientes ou PDFs de outro municipio.

## Regra 40+ e Alertas

- Pacientes com 40 anos ou mais normalmente fazem mamografia primeiro.
- USG de mama pode aparecer como complemento.
- Menores de 40 anos normalmente nao fazem mamografia.
- A tela exibe alertas filtraveis sem afirmar erro:
  - `40+ sem mamografia`;
  - `40+ apenas USG mama`;
  - `Menor de 40 com mamografia`;
  - `Sem laudo disponivel`;
  - `Idade desconhecida`.
- A cor amarela indica ponto de revisao operacional, nao falha clinica.

## Criterios de Aceite

- Um login valido entra no portal e mostra o municipio correto no cabecalho.
- A listagem nao retorna pacientes de outro municipio.
- A busca nao vaza pacientes fora do escopo.
- KPIs e filtros usam o mesmo recorte municipal da tabela.
- A URL de PDF de outro municipio retorna `404` ou `401`, sem entregar arquivo.
- A tela interna `pacientes.html` continua disponivel para a equipe master.
- O portal nao mostra botoes de administracao interna.

## Proximos Incrementos Sugeridos

- Tela administrativa master para criar gestores sem usar script.
- Rotacao obrigatoria de senha no primeiro acesso.
- Expiracao/inativacao visual de usuarios.
- Exportacao CSV restrita ao municipio.
- Log detalhado de abertura de PDF por paciente/laudo.
- Paginação server-side caso algum municipio ultrapasse milhares de registros.
- Politica de mascaramento configuravel para CPF/CNS se a governanca LGPD exigir.
