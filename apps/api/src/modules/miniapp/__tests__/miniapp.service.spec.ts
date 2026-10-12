import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({ IntegrationType: { TELEGRAM: 'TELEGRAM' } }));

import { MiniAppService } from '../miniapp.service';

const TOKEN = '123456:AAHtestTokenForSignature';

function initDataFor(userId: number) {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'Владелец' }),
  };
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(checkString).digest('hex') }).toString();
}

function createService(overview: any = { metrics: { paidUnits: 3, revenue: 300, payout: 240, profit: 90, profitKnown: true } }) {
  const integrations = { getPlain: vi.fn().mockResolvedValue({ token: TOKEN, metadata: { chatId: '777' } }) };
  const dashboard = { overview: vi.fn().mockResolvedValue(overview) };
  return { service: new MiniAppService(integrations as any, dashboard as any), dashboard };
}

describe('MiniAppService', () => {
  afterEach(() => { delete process.env.TELEGRAM_MINIAPP_USER_IDS; });

  it('отдаёт сводку владельцу и запрашивает выбранный период без сравнения', async () => {
    const { service, dashboard } = createService();
    const summary = await service.summary(initDataFor(777), 'today');
    expect(summary.bought).toEqual({ units: 3, revenue: 300, payout: 240 });
    expect(summary.profit.net).toBe(90);
    const query = dashboard.overview.mock.calls[0][0];
    expect(query.compare).toBe('false');
    expect(query.from).toBe(query.to);
  });

  it('не пускает чужой Telegram-аккаунт', async () => {
    const { service, dashboard } = createService();
    await expect(service.summary(initDataFor(999), 'today')).rejects.toThrow('не имеет доступа');
    expect(dashboard.overview).not.toHaveBeenCalled();
  });

  it('пускает дополнительные id из TELEGRAM_MINIAPP_USER_IDS', async () => {
    process.env.TELEGRAM_MINIAPP_USER_IDS = '999, 1000';
    const { service } = createService();
    await expect(service.summary(initDataFor(999), 'week')).resolves.toMatchObject({ period: { key: 'week' } });
  });

  it('не пускает без подписи', async () => {
    const { service } = createService();
    await expect(service.summary('user=%7B%22id%22%3A777%7D', 'today')).rejects.toThrow('Подпись Telegram отсутствует');
  });
});
