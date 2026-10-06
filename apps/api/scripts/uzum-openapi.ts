/**
 * Дамп документации Uzum Seller OpenAPI по заданному разделу — чтобы увидеть точные пути, параметры и тела запросов
 * (анонимно swagger отвечает «RBAC: access denied», с токеном продавца — отдаёт).
 *
 *   npx tsx apps/api/scripts/uzum-openapi.ts                 пути с «fbs» (накладные FBS, тайм-слоты, точки сдачи)
 *   npx tsx apps/api/scripts/uzum-openapi.ts --filter=shop   любой другой фильтр по подстроке пути
 *   npx tsx apps/api/scripts/uzum-openapi.ts --all           все пути (только метод и summary)
 *   npx tsx apps/api/scripts/uzum-openapi.ts --probe         прощупать пути FBS-накладных: GET и OPTIONS по реальной накладной,
 *                                                            по кодам ответа (404 нет / 405 есть, но другой метод) и заголовку Allow
 *
 * Токен берётся из БД (IntegrationCredential UZUM) и нигде не печатается. Только чтение.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { UZUM_OPENAPI_BASE } from '../src/common/uzum-http';

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const DOC_URLS = [
  `${UZUM_OPENAPI_BASE}/v3/api-docs`,
  `${UZUM_OPENAPI_BASE}/v3/api-docs/seller-openapi`,
  `${UZUM_OPENAPI_BASE}/api-docs`,
  `${UZUM_OPENAPI_BASE}/swagger.json`,
  `${UZUM_OPENAPI_BASE}/openapi.json`,
  'https://api-seller.uzum.uz/api/v3/api-docs',
  'https://api-seller.uzum.uz/v3/api-docs',
];

async function fetchDoc(token: string): Promise<{ url: string; doc: any } | null> {
  for (const url of DOC_URLS) {
    for (const headers of [{ Authorization: token }, { Authorization: `Bearer ${token}` }]) {
      try {
        const response = await fetch(url, { headers: { ...headers, Accept: 'application/json' } });
        const text = await response.text();
        if (!response.ok) { console.log(`${url} [${Object.keys(headers)[0]}=${headers.Authorization.startsWith('Bearer') ? 'Bearer' : 'raw'}] → ${response.status} ${text.slice(0, 80)}`); continue; }
        try { const doc = JSON.parse(text); if (doc?.paths) return { url, doc }; console.log(`${url} → JSON без paths (${Object.keys(doc).join(', ').slice(0, 100)})`); }
        catch { console.log(`${url} → не JSON: ${text.slice(0, 100).replace(/\s+/g, ' ')}`); }
      } catch (error: any) { console.log(`${url} → ${error?.message || error}`); }
    }
  }
  return null;
}

function resolve(doc: any, schema: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 4) return schema;
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').pop() as string;
    const target = doc.components?.schemas?.[name] ?? doc.definitions?.[name];
    return target ? { $schema: name, ...resolve(doc, target, depth + 1) } : schema;
  }
  if (schema.type === 'array') return { type: 'array', items: resolve(doc, schema.items, depth + 1) };
  if (schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries<any>(schema.properties)) {
      const inner = resolve(doc, value, depth + 1);
      out[key] = typeof inner === 'object' && inner && !inner.properties && !inner.items ? `${inner.type ?? inner.$schema ?? '?'}${inner.enum ? `(${inner.enum.join('|')})` : ''}${inner.format ? `:${inner.format}` : ''}` : inner;
    }
    return { ...(schema.required ? { required: schema.required } : {}), properties: out };
  }
  return schema;
}

/** Прощуп путей без побочных эффектов: только GET и OPTIONS. */
async function probe(token: string, prisma: PrismaService) {
  const fbs = await prisma.supply.findFirst({ where: { type: 'FBS' }, orderBy: { createdAt: 'desc' } });
  const id = fbs?.externalId ?? '1';
  console.log(`Прощуп по FBS-накладной №${id}${fbs ? ` (${fbs.status}, слот ${fbs.slotFrom ? 'назначен' : 'нет'})` : ' (в БД нет FBS-поставок, id условный)'}
`);
  const paths = [
    '/v1/fbs/invoice', '/v1/fbs/invoice/dop', '/v1/fbs/invoice/dop/time-slot', '/v1/fbs/invoice/time-slot', '/v1/fbs/invoice/dop/time-slot/reserve',
    `/v1/fbs/invoice/${id}`, `/v1/fbs/invoice/${id}/time-slot`, `/v1/fbs/invoice/${id}/dop`, `/v1/fbs/invoice/${id}/dop/time-slot`, `/v1/fbs/invoice/${id}/reserve`,
    `/v1/fbs/invoice/${id}/book`, `/v1/fbs/invoice/${id}/change-time-slot`, `/v1/fbs/invoice/${id}/change-dop`, `/v1/fbs/invoice/${id}/confirm`, `/v1/fbs/invoice/${id}/cancel`,
    `/v1/fbs/invoice/${id}/waybill`, `/v1/fbs/invoice/${id}/products`, `/v1/fbs/invoice/${id}/orders`, `/v1/fbs/invoice/${id}/status`,
    '/v1/fbs/dop', '/v1/fbs/time-slot', '/v1/fbs/invoice/create', '/v1/fbs/order', '/v1/fbs/orders',
  ];
  for (const path of paths) {
    const out: string[] = [];
    for (const method of ['GET', 'OPTIONS']) {
      try {
        const response = await fetch(UZUM_OPENAPI_BASE + path, { method, headers: { Authorization: token, Accept: 'application/json' } });
        const allow = response.headers.get('allow') || response.headers.get('access-control-allow-methods');
        const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 160);
        out.push(`${method} ${response.status}${allow ? ` Allow=${allow}` : ''}${response.status !== 404 && text ? ` ${text}` : ''}`);
      } catch (error: any) { out.push(`${method} ошибка ${error?.message || error}`); }
    }
    console.log(`${path}
   ${out.join('
   ')}`);
  }
}

async function main() {
  const prisma = new PrismaService();
  const crypto = new CryptoService();
  try {
    const row = await prisma.integrationCredential.findUnique({ where: { type: IntegrationType.UZUM } });
    const token = row ? crypto.decrypt(row) : null;
    if (!token) throw new Error('UZUM token не настроен');
    if (flag('probe')) { await probe(token, prisma); return; }
    const found = await fetchDoc(token);
    if (!found) { console.log('Документация не получена ни по одному адресу.'); return; }
    console.log(`\n=== OpenAPI ${found.doc.info?.title ?? ''} ${found.doc.info?.version ?? ''} из ${found.url}; путей: ${Object.keys(found.doc.paths).length}\n`);
    const filter = flag('all') ? '' : (arg('filter') ?? 'fbs').toLowerCase();
    for (const [path, methods] of Object.entries<any>(found.doc.paths)) {
      if (filter && !path.toLowerCase().includes(filter)) continue;
      for (const [method, op] of Object.entries<any>(methods)) {
        if (!op || typeof op !== 'object' || ['parameters', 'servers'].includes(method)) continue;
        console.log(`${method.toUpperCase()} ${path} — ${op.summary ?? op.operationId ?? ''}`);
        if (flag('all')) continue;
        if (op.description) console.log(`  ${String(op.description).replace(/\s+/g, ' ').slice(0, 300)}`);
        for (const param of [...(methods.parameters ?? []), ...(op.parameters ?? [])]) {
          const schema = resolve(found.doc, param.schema);
          console.log(`  ${param.in} ${param.name}${param.required ? '*' : ''}: ${typeof schema === 'object' ? JSON.stringify(schema) : schema}${param.description ? ` — ${String(param.description).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
        }
        const body = op.requestBody?.content?.['application/json']?.schema ?? op.requestBody?.content?.['*/*']?.schema;
        if (body) console.log(`  body: ${JSON.stringify(resolve(found.doc, body))}`);
        const ok = op.responses?.['200']?.content?.['application/json']?.schema ?? op.responses?.['200']?.content?.['*/*']?.schema;
        if (ok) console.log(`  200: ${JSON.stringify(resolve(found.doc, ok)).slice(0, 900)}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
