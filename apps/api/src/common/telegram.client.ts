import { Injectable } from '@nestjs/common';

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

@Injectable()
export class TelegramClient {
  private async call<T>(token: string, method: string, body?: Record<string, unknown>, attempt = 0): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` })) as TelegramResponse<T>;
      if (response.ok && payload.ok) return payload.result as T;

      const retryAfter = payload.parameters?.retry_after;
      const transient = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
      if (attempt < 1 && transient) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(500, (retryAfter || 1) * 1000))));
        return this.call<T>(token, method, body, attempt + 1);
      }
      throw new Error(`Telegram ${method}: ${payload.description || `HTTP ${response.status}`}`);
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error(`Telegram ${method}: превышено время ожидания 15 секунд`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  getMe(token: string) {
    return this.call<{ id: number; is_bot: boolean; first_name: string; username?: string }>(token, 'getMe');
  }

  sendMessage(token: string, chatId: string, text: string, parseMode?: 'HTML' | 'MarkdownV2', replyMarkup?: Record<string, unknown>) {
    return this.call<{ message_id: number; date: number }>(token, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      disable_web_page_preview: true,
    });
  }

  async sendDocument(token: string, chatId: string, document: Buffer, fileName: string, caption?: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const form = new FormData();
      form.set('chat_id', chatId);
      const bytes = document.buffer.slice(document.byteOffset, document.byteOffset + document.byteLength) as ArrayBuffer;
      form.set('document', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);
      if (caption) form.set('caption', caption);
      const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form, signal: controller.signal });
      const payload = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` })) as TelegramResponse<{ message_id: number; date: number }>;
      if (response.ok && payload.ok) return payload.result as { message_id: number; date: number };
      throw new Error(`Telegram sendDocument: ${payload.description || `HTTP ${response.status}`}`);
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error('Telegram sendDocument: превышено время ожидания 60 секунд');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  getUpdates(token: string, offset?: number) {
    return this.call<any[]>(token, 'getUpdates', { timeout: 0, allowed_updates: ['message', 'callback_query'], ...(offset ? { offset } : {}) });
  }

  answerCallbackQuery(token: string, callbackQueryId: string) {
    return this.call<boolean>(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  async test(token: string, chatId: string) {
    if (!chatId.trim()) throw new Error('Укажите Chat ID: без него нельзя проверить доставку сообщения');
    const bot = await this.getMe(token);
    const message = await this.sendMessage(token, chatId, '✅ Uzum Analytics: Telegram подключён, тестовое сообщение доставлено.');
    return {
      botId: bot.id,
      botName: bot.first_name,
      botUsername: bot.username || null,
      chatId,
      messageId: message.message_id,
    };
  }
}
