import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramClient } from '../telegram.client';

afterEach(() => vi.unstubAllGlobals());

describe('Telegram client', () => {
  it('validates bot and sends a real test message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok:true, result:{ id:1, is_bot:true, first_name:'UzumBot', username:'uzum_bot' } }),{status:200,headers:{'content-type':'application/json'}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok:true, result:{ message_id:77, date:1 } }),{status:200,headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',fetchMock);
    const result=await new TelegramClient().test('token','-100123');
    expect(result.messageId).toBe(77);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/sendMessage');
  });

  it('requires chat id to prove delivery', async () => {
    await expect(new TelegramClient().test('token','')).rejects.toThrow(/Chat ID/);
  });

  it('sends an XLSX as a Telegram document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok:true, result:{ message_id:88, date:1 } }),{status:200,headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',fetchMock);
    const result=await new TelegramClient().sendDocument('token','-100123',Buffer.from('xlsx'),'report.xlsx','Отчёт');
    expect(result.message_id).toBe(88);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/sendDocument');
    const form=fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get('chat_id')).toBe('-100123');
    expect((form.get('document') as File).name).toBe('report.xlsx');
  });

  it('retries once after Telegram 429', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok:false, description:'Too Many Requests', parameters:{ retry_after:1 } }),{status:429,headers:{'content-type':'application/json'}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok:true, result:{ id:1, is_bot:true, first_name:'Bot' } }),{status:200,headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',fetchMock);
    const promise=new TelegramClient().getMe('token');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toMatchObject({id:1});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
