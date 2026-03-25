/**
 * DEPRECATED — este arquivo não é importado nem iniciado em lugar nenhum.
 *
 * O monitoramento de confirmações é feito por MonitorService (com exponential backoff
 * e RPC URL configurado) chamado diretamente de dentro do worker em transaction.queue.ts.
 *
 * Problemas desta implementação que levaram à deprecação:
 * - `createPublicClient({ transport: http() })` sem URL usa provider público padrão,
 *   sujeito a rate-limiting em produção.
 * - Instanciação de Worker no nível de módulo criaria workers órfãos se o arquivo
 *   fosse importado acidentalmente.
 * - Usa queue separada ('monitor-queue') que nunca é alimentada por nenhuma rota.
 *
 * Para monitoramento de transações, use MonitorService em services/transaction/monitor.service.ts.
 */

export {}; // mantém o arquivo como módulo ES válido sem efeitos colaterais
