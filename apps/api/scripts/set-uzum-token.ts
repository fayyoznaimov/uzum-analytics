/**
 * Замена токена Uzum Seller OpenAPI без веб-интерфейса.
 *
 *   npx tsx apps/api/scripts/set-uzum-token.ts
 *
 * Токен вводится скрытно (как пароль), проверяется запросом /v1/shops и
 * сохраняется зашифрованным в IntegrationCredential UZUM — так же, как это
 * делает экран настроек. Shop ID и название магазина сохраняются прежними.
 * Если токен не видит настроенный магазин, ничего не записывается.
 */
import { createInterface } from 'readline';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';

function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Запустите скрипт в обычном терминале: нужен скрытый ввод токена');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WriteStream };
    output._writeToOutput = (text: string) => { if (text.includes(question)) output.output.write(text); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

async function main() {
  const prisma = new PrismaService();
  const crypto = new CryptoService();
  try {
    const current = await prisma.integrationCredential.findUnique({ where: { type: IntegrationType.UZUM } });
    const metadata = (current?.metadata || {}) as Record<string, any>;
    const shopId = String(metadata.shopId || '').trim();
    if (!shopId) throw new Error('В настройках нет Shop ID — сначала подключите Uzum через экран настроек');

    const token = (await askHidden('Новый токен Uzum (ввод скрыт): ')).replace(/^Bearer\s+/i, '');
    if (!token) throw new Error('Токен пустой — ничего не изменено');

    const response = await fetch('https://api-seller.uzum.uz/api/seller-openapi/v1/shops', { headers: { Authorization: token, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Uzum отклонил токен: HTTP ${response.status} — ничего не изменено`);
    const body: any = await response.json().catch(() => ({}));
    const shops: any[] = ['payload', 'data', 'content', 'shops'].map((key) => body?.[key]).find(Array.isArray) || (Array.isArray(body) ? body : []);
    if (!shops.some((shop) => String(shop?.id ?? shop?.shopId ?? '') === shopId)) {
      throw new Error(`Токен не видит магазин ${shopId} — ничего не изменено`);
    }

    await prisma.integrationCredential.update({
      where: { type: IntegrationType.UZUM },
      data: { ...crypto.encrypt(token), status: IntegrationStatus.CONNECTED, lastTestedAt: new Date(), lastError: null },
    });
    console.log(`Токен сохранён: ${crypto.mask(token)} (магазин ${shopId}${metadata.shopName ? `, ${metadata.shopName}` : ''})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
