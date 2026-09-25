/**
 * Сообщение в Telegram из shell-скриптов (автодеплой):
 *
 *   npx tsx apps/api/scripts/notify-telegram.ts "текст"
 *
 * Токен бота и chat ID берутся из IntegrationCredential TELEGRAM так же, как в
 * приложении; уважается переключатель notifyErrors. Ошибки не роняют вызывающий скрипт.
 */
import { IntegrationType } from '@prisma/client';
import { CryptoService } from '../src/common/crypto.service';
import { PrismaService } from '../src/common/prisma.service';
import { TelegramClient } from '../src/common/telegram.client';

async function main() {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) return;
  const prisma = new PrismaService();
  try {
    const row = await prisma.integrationCredential.findUnique({ where: { type: IntegrationType.TELEGRAM } });
    const metadata = (row?.metadata || {}) as Record<string, any>;
    const token = row?.enabled ? new CryptoService().decrypt(row) : null;
    const chatId = String(metadata.chatId || '');
    if (!token || !chatId || metadata.notifyErrors === false) return;
    await new TelegramClient().sendMessage(token, chatId, text);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => console.error(`Telegram: ${String(error?.message || error)}`));
