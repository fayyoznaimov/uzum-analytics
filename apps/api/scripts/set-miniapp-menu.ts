/**
 * Кнопка мини-приложения в меню чата:
 *
 *   npx tsx apps/api/scripts/set-miniapp-menu.ts "https://адрес/miniapp"
 *
 * Нужна, когда адрес туннеля сменился (scripts/miniapp-tunnel.sh): бот ставит
 * кнопку меню на /start и menu, а скрипт делает это сразу, без участия владельца.
 * Токен и chat ID берутся из IntegrationCredential TELEGRAM, как в notify-telegram.ts.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';

async function main() {
  const url = (process.argv[2] || process.env.TELEGRAM_MINIAPP_URL || '').trim();
  if (!/^https:\/\//.test(url)) throw new Error('нужен https-адрес мини-приложения');
  const prisma = new PrismaService();
  try {
    const row = await prisma.integrationCredential.findUnique({ where: { type: IntegrationType.TELEGRAM } });
    const metadata = (row?.metadata || {}) as Record<string, any>;
    const token = row?.enabled ? new CryptoService().decrypt(row) : null;
    const chatId = String(metadata.chatId || '');
    if (!token || !chatId) throw new Error('интеграция Telegram выключена или не задан Chat ID');
    await new TelegramClient().setChatMenuButton(token, chatId, '📱 Профит сегодня', url);
    console.log(`кнопка меню обновлена: ${url}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Кнопка меню: ${String(error?.message || error)}`);
  process.exit(1);
});
