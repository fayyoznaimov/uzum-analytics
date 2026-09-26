import Anthropic from '@anthropic-ai/sdk';
import { BadRequestException, forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { advertisingEstimateAt, advertisingRateTimeline, ORDER_BOOST_CODE } from '../../common/advertising';
import { CryptoService } from '../../common/crypto.service';
import { DEFAULT_OPENCLAW_MODEL, OpenclawClient } from '../../common/openclaw.client';
import { PrismaService } from '../../common/prisma.service';
import { TelegramClient } from '../../common/telegram.client';
import { DashboardService } from '../dashboard/dashboard.service';
import { CostsService } from '../costs/costs.service';
import { ReviewsService } from '../reviews/reviews.service';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private telegramPolling = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly telegram: TelegramClient,
    private readonly openclaw: OpenclawClient,
    @Inject(forwardRef(() => DashboardService)) private readonly dashboard: DashboardService,
    private readonly costs: CostsService,
    // ReviewsService уже сам держит IntegrationsService (читает токены ANTHROPIC/UZUM_INTERNAL) —
    // forwardRef на обеих сторонах разрывает цикл инициализации Nest.
    @Inject(forwardRef(() => ReviewsService)) private readonly reviews: ReviewsService,
  ) {}

  private telegramMenu() {
    return { inline_keyboard: [
      [
        { text: '📊 Сегодня', callback_data: 'report:today' },
        { text: '📅 Вчера', callback_data: 'report:yesterday' },
      ],
      [
        { text: '🗓 7 дней', callback_data: 'report:week' },
        { text: '📆 С начала месяца', callback_data: 'report:month' },
      ],
      [
        { text: '💰 Кошелёк', callback_data: 'report:wallet' },
        { text: '📦 Потенциал склада', callback_data: 'report:stock' },
      ],
      [
        { text: '📝 Отзывы', callback_data: 'reviews:next' },
      ],
    ] };
  }

  private money(value: unknown) { return Math.round(Number(value || 0)).toLocaleString('ru-RU'); }

  /** Сегодняшняя дата по Ташкенту в формате YYYY-MM-DD — точка отсчёта для всех периодов отчёта. */
  private tashkentToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
  }

  private addDays(dateKey: string, delta: number) {
    const d = new Date(`${dateKey}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  private fmt(dateKey: string) {
    const [, m, d] = dateKey.split('-');
    return `${d}.${m}`;
  }

  /**
   * Один и тот же отчёт о прибыли на разные периоды — «Сегодня», «Вчера», «7 дней»,
   * «С начала месяца». Раньше был только «Профит сегодня»; директор попросил
   * кнопки, а не только текущий день, поэтому период вынесен наружу.
   */
  private async sendProfitReport(token: string, chatId: string, period: 'today' | 'yesterday' | 'week' | 'month') {
    const today = this.tashkentToday();
    const ranges: Record<typeof period, { from: string; to: string; title: string }> = {
      today: { from: today, to: today, title: 'ЗА СЕГОДНЯ' },
      yesterday: { from: this.addDays(today, -1), to: this.addDays(today, -1), title: 'ЗА ВЧЕРА' },
      week: { from: this.addDays(today, -6), to: today, title: `ЗА 7 ДНЕЙ (${this.fmt(this.addDays(today, -6))}–${this.fmt(today)})` },
      month: { from: `${today.slice(0, 7)}-01`, to: today, title: `С НАЧАЛА МЕСЯЦА (${this.fmt(`${today.slice(0, 7)}-01`)}–${this.fmt(today)})` },
    };
    const { from, to, title } = ranges[period];
    const data: any = await this.dashboard.overview({ from, to, compare: 'false' });
    const m = data.metrics || {};
    const orderedPotentialProfitKnown = m.orderedPotentialProfitKnown === true
      && m.orderedPotentialProfit !== null
      && m.orderedPotentialProfit !== undefined
      && Number.isFinite(Number(m.orderedPotentialProfit));
    const profitKnown = m.profitKnown === true
      && m.profit !== null
      && m.profit !== undefined
      && Number.isFinite(Number(m.profit));
    const margin = profitKnown
      ? Number(m.revenue) > 0 ? Number(m.profit) / Number(m.revenue) * 100 : 0
      : null;
    const orderedPotentialProfit = orderedPotentialProfitKnown
      ? `${this.money(m.orderedPotentialProfit)} сум`
      : 'не рассчитана';
    const profit = profitKnown ? `${this.money(m.profit)} сум` : 'не рассчитана';
    const marginText = margin === null ? '—' : `${margin.toFixed(1)}%`;
    const factNote = profitKnown
      ? 'Реклама учтена только по поступившему факту Uzum.'
      : 'Прибыль не показана: период или исходные данные ещё не финальны; модельная реклама не подменяет факт.';
    // Разбивка трат — из уже поступившего ledger finance/expenses, та же арифметика,
    // что и на дашборде: expenses = комиссия + логистика + реклама + себестоимость +
    // налог + прочие сборы Uzum. Раньше всё, кроме рекламы и логистики, сваливалось
    // в одну строку «прочее» — а это были себестоимость и комиссия, обычно бОльшая
    // часть всех трат. Показываем каждую составляющую отдельно.
    const advertisingExpense = Number(m.advertisingExpense || 0);
    const marketplaceLogistics = Number(m.marketplaceLogistics || 0);
    const commission = Number(m.commission || 0);
    const cogs = Number(m.cogs || 0);
    const taxExpense = Number(m.taxExpense || 0);
    const otherFees = Number(m.otherMarketplaceFeesExpense || 0) + Number(m.otherMarketplaceDeductions || 0);
    const commissionPercent = Number(m.commissionPercent || (Number(m.revenue) > 0 ? commission / Number(m.revenue) * 100 : 0));
    const adPercent = Number(m.revenue) > 0 ? advertisingExpense / Number(m.revenue) * 100 : 0;
    const expensesBlock = `📦 Себестоимость товара: <b>${this.money(cogs)} сум</b>\n🏛 Комиссия Uzum: <b>${this.money(commission)} сум • ${commissionPercent.toFixed(1)}%</b>\n🚚 Логистика маркетплейса: <b>${this.money(marketplaceLogistics)} сум</b>\n📣 Реклама: <b>${this.money(advertisingExpense)} сум • ${adPercent.toFixed(1)}% от выручки</b>\n🧮 Налог: <b>${this.money(taxExpense)} сум</b>${otherFees > 0 ? `\n🧾 Прочие сборы Uzum: <b>${this.money(otherFees)} сум</b>` : ''}\n\n`;
    const text = `📊 <b>ПРОФИТ ${title}</b>\n━━━━━━━━━━━━━━━━━━━━\n🛒 Заказано: <b>${m.orderedUnits || 0} шт. • ${this.money(m.orderedRevenue)} сум</b>\n💵 Выплата Uzum по заказам: <b>${this.money(m.orderedPayout)} сум</b>\n📈 Потенциальная прибыль: <b>${orderedPotentialProfit}</b>\n\n✅ Выкуплено: <b>${m.paidUnits || 0} шт. • ${this.money(m.revenue)} сум</b>\n🏦 Выплата по выкупам: <b>${this.money(m.payout)} сум</b>\n\n${expensesBlock}💰 Чистая прибыль: <b>${profit}</b>\n📊 Чистая маржа: <b>${marginText}</b>\n\n<i>${factNote}</i>`;
    await this.telegram.sendMessage(token, chatId, text, 'HTML', this.telegramMenu());
  }

  /**
   * «Сколько и когда попадёт на счёт» — директор просил именно это. Вся логика
   * уже посчитана в dashboard.overview() (корзина вывода + график выплат банком,
   * см. common/payout-basket.ts), здесь только перекладка в текст. payoutForecast
   * не зависит от периода на экране дашборда, дата тут нужна только чтобы вызов
   * overview() был валиден — берём тот же today, что и остальные отчёты.
   */
  private async sendWalletReport(token: string, chatId: string) {
    const today = this.tashkentToday();
    const data: any = await this.dashboard.overview({ from: today, to: today, compare: 'false' });
    const pf = data.payoutForecast || {};
    const s = pf.summary || {};
    const statementAsOf = pf.statementAsOf || s.statementAsOf;
    const staleStatement = statementAsOf
      ? Math.floor((Date.now() - new Date(statementAsOf).getTime()) / 86_400_000) > 7
      : false;
    const staleNote = statementAsOf
      ? ` <i>(сверка ${this.fmt(statementAsOf.slice(0, 10))}${staleStatement ? ' — давно, могла устареть' : ''})</i>`
      : '';
    const upcoming: any[] = (pf.payoutDailyRows || []).filter((r: any) => r.date >= pf.today && r.status !== 'NEEDS_RECONCILE');
    const nextPayout = upcoming[0];
    const nextPayoutLine = nextPayout
      ? `📅 Ближайшее зачисление: <b>${this.fmt(nextPayout.date)} — ${this.money(nextPayout.bankAmount)} сум</b> (${nextPayout.orders} заказ.)`
      : '📅 Ближайшее зачисление: пока не запланировано';
    const reconcileNote = Number(s.needsReconcile || 0) > 0
      ? `\n⚠️ Прошлые даты по графику не сверены с банком: <b>${this.money(s.needsReconcile)} сум</b> — обычно деньги уже пришли, это флаг для сверки, а не факт недостачи.`
      : '';
    const text = `💰 <b>КОШЕЛЁК</b>\n━━━━━━━━━━━━━━━━━━━━\n🏦 Баланс кабинета Uzum: <b>${this.money(s.overallBalance)} сум</b>${staleNote}\n✅ Доступно к выводу сейчас: <b>${this.money(s.availableToWithdraw)} сум</b>\n⏳ В удержании (${pf.holdDays || 10} дней с даты выдачи): <b>${this.money(s.inReturnHold)} сум</b>\n\n${nextPayoutLine}\n📊 Итого за 7 дней: <b>${this.money(s.next7Days)} сум</b>\n📊 Итого за 30 дней: <b>${this.money(s.next30Days)} сум</b>${reconcileNote}\n\n<i>Схема выплат: ${pf.schedule || 'BIWEEKLY'}. Праздники и фактическое зачисление всегда сверяйте с банком.</i>`;
    await this.telegram.sendMessage(token, chatId, text, 'HTML', this.telegramMenu());
  }

  // ── Ответ на отзывы прямо из Telegram ──────────────────────────────────────
  // Раньше это можно было сделать только через веб-интерфейс. Карточка отзыва
  // с черновиком и тремя кнопками: отправить / другой вариант / дальше.
  // «Дальше» и «Отправить» двигаются по одному и тому же списку (feed NO_REPLY,
  // сортировка та же, что на дашборде — сначала новые), поэтому пропущенный
  // отзыв не всплывает повторно, пока не решишь вернуться к нему сам.

  private reviewStars(rating: number) { return '⭐'.repeat(Math.max(0, Math.min(5, rating))); }

  private renderReviewCard(review: any) {
    const parts = [review.content, review.pros && `плюс: ${review.pros}`, review.cons && `минус: ${review.cons}`].filter(Boolean);
    const body = parts.length ? parts.join('\n') : '<i>(без текста, только оценка)</i>';
    const customer = review.anonymous ? 'аноним' : (review.customerName || 'аноним');
    // feed() вызывается in-process, а не через HTTP — dateCreated приходит
    // настоящим Date, не ISO-строкой; String(date) даёт совсем не то.
    const date = review.dateCreated ? this.fmt(new Date(review.dateCreated).toISOString().slice(0, 10)) : '';
    const product = [review.productTitle, review.skuTitle].filter(Boolean).join(' / ');
    const draft = review.aiReplyText
      ? `💬 <b>Черновик</b> (${review.aiReplyLanguage || '?'}${review.aiReplyRisk === 'REVIEW' ? ', ⚠️ на проверку' : ''}):\n${review.aiReplyText}`
      : '💬 <i>черновика нет</i>';
    const text = `📝 <b>ОТЗЫВ ЖДЁТ ОТВЕТА</b>\n━━━━━━━━━━━━━━━━━━━━\n${this.reviewStars(review.rating)} ${customer} • ${date}\n🛍 ${product}\n\n${body}\n\n${draft}`;
    // Кнопки карточки + основное меню в одной клавиатуре — раньше карточка
    // полностью заменяла меню (Сегодня/Кошелёк/…) своими тремя кнопками, и
    // директору казалось, что кнопки «пропадают». Теперь они не пропадают
    // никогда: действия по отзыву сверху, обычное меню — под ними.
    const keyboard = { inline_keyboard: [
      [
        { text: '✅ Отправить', callback_data: `reviews:send:${review.id}` },
        { text: '🔁 Другой вариант', callback_data: `reviews:redo:${review.id}` },
      ],
      [{ text: '⏭ Дальше', callback_data: `reviews:skip:${review.id}` }],
      ...this.telegramMenu().inline_keyboard,
    ] };
    return { text, keyboard };
  }

  /**
   * Показывает карточку отзыва в чате. mode:
   *  'next'  — первый в очереди (самый свежий без ответа);
   *  'skip'  — следующий ПОСЛЕ review id в том же списке (пропущенный не повторяется);
   *  'redo'  — тот же review id, но черновик пересобирается заново.
   * Черновик генерируется на лету, если его ещё нет (для только что пришедшего отзыва).
   */
  private async sendReviewCard(token: string, chatId: string, mode: 'next' | 'skip' | 'redo', reviewId?: string) {
    if (mode === 'redo' && reviewId) {
      await this.reviews.generateAiDraft(reviewId).catch((error: any) => {
        throw new Error(`Не удалось пересобрать ответ: ${String(error?.message || error)}`);
      });
    }
    const feed: any = await this.reviews.feed({ filter: 'NO_REPLY', size: '50' });
    const items: any[] = feed.items || [];
    let target: any;
    if (mode === 'next') target = items[0];
    else if (mode === 'redo') target = items.find((r) => r.id === reviewId);
    else {
      const index = items.findIndex((r) => r.id === reviewId);
      target = index >= 0 ? items[index + 1] : items[0];
    }
    if (!target) {
      await this.telegram.sendMessage(token, chatId, '📝 Отзывов, ждущих ответа, больше нет 🎉', 'HTML', this.telegramMenu());
      return;
    }
    if (!target.aiReplyText) {
      await this.reviews.generateAiDraft(target.id).catch((error: any) => this.logger.warn(`Черновик для ${target.id}: ${error?.message || error}`));
      const refreshed: any = await this.reviews.feed({ filter: 'NO_REPLY', size: '50' });
      target = (refreshed.items || []).find((r: any) => r.id === target.id) || target;
    }
    const { text, keyboard } = this.renderReviewCard(target);
    await this.telegram.sendMessage(token, chatId, text, 'HTML', keyboard);
  }

  private async sendReviewAndAdvance(token: string, chatId: string, reviewId: string) {
    await this.reviews.sendReply(reviewId);
    // Раньше это подтверждение уходило вообще без клавиатуры — один короткий
    // момент, когда в чате не было ни одной кнопки. Меню на месте всегда.
    await this.telegram.sendMessage(token, chatId, '✅ Ответ отправлен на Uzum.', 'HTML', this.telegramMenu());
    await this.sendReviewCard(token, chatId, 'skip', reviewId);
  }

  private async sendStockReport(token: string, chatId: string) {
    const rows: any[] = await this.costs.list();
    const totals = rows.reduce((s, row) => {
      const stock = Number(row.stock || 0);
      const estimateKnown = row.marginEstimateKnown !== false
        && row.fullCostEstimate !== null
        && row.fullCostEstimate !== undefined
        && row.marginEstimate !== null
        && row.marginEstimate !== undefined
        && Number.isFinite(Number(row.fullCostEstimate))
        && Number.isFinite(Number(row.marginEstimate));
      s.stock += stock;
      s.sales += Number(row.price || 0) * stock;
      s.payout += Number(row.sellerPayout || 0) * stock;
      s.cost += (Number(row.cost || 0) + Number(row.packagingCost || 0) + Number(row.warehouseLogisticsCost || 0) + Number(row.additionalCost || 0)) * stock;
      s.skus += 1;
      if (estimateKnown) {
        s.coveredSkus += 1;
        s.coveredUnits += stock;
        s.expenses += Number(row.fullCostEstimate) * stock;
        s.profit += Number(row.marginEstimate) * stock;
      }
      return s;
    }, { stock: 0, sales: 0, payout: 0, cost: 0, expenses: 0, profit: 0, skus: 0, coveredSkus: 0, coveredUnits: 0 });
    const incomplete = totals.coveredSkus < totals.skus;
    const expenseLabel = incomplete ? 'Расходы по известной части' : 'Все расходы';
    const profitLabel = incomplete ? 'Прибыль по известной части' : 'Потенциальная прибыль';
    const missingNote = incomplete
      ? `\n⚠️ Без расчёта: <b>${totals.skus - totals.coveredSkus} SKU • ${this.money(totals.stock - totals.coveredUnits)} шт.</b> — нет наблюдаемой ставки рекламы.`
      : '';
    const text = `📦 <b>ПОТЕНЦИАЛ СКЛАДА</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 Текущий остаток: <b>${this.money(totals.stock)} шт.</b>\n🛍 Потенциальные продажи: <b>${this.money(totals.sales)} сум</b>\n🏦 Потенциальная выплата Uzum: <b>${this.money(totals.payout)} сум</b>\n🏷 Себестоимость товаров: <b>${this.money(totals.cost)} сум</b>\n📉 ${expenseLabel}: <b>${this.money(totals.expenses)} сум</b>\n📈 ${profitLabel}: <b>${this.money(totals.profit)} сум</b>\n📊 Покрытие расчёта: <b>${totals.coveredSkus} из ${totals.skus} SKU • ${this.money(totals.coveredUnits)} из ${this.money(totals.stock)} шт.</b>${missingNote}`;
    await this.telegram.sendMessage(token, chatId, text, 'HTML', this.telegramMenu());
  }

  async sendTelegramMenu() {
    const stored = await this.getPlain(IntegrationType.TELEGRAM);
    const token = stored?.token;
    const chatId = String(stored?.metadata?.chatId || '');
    if (!token || !chatId) throw new BadRequestException('Telegram-бот или Chat ID не настроены');
    const sent = await this.telegram.sendMessage(token, chatId, 'Выберите отчёт:', undefined, this.telegramMenu());
    return { ok: true, messageId: sent.message_id };
  }

  @Cron('*/5 * * * * *')
  async pollTelegram() {
    if (this.telegramPolling) return;
    this.telegramPolling = true;
    try {
      const stored = await this.getPlain(IntegrationType.TELEGRAM);
      const token = stored?.token;
      const chatId = String(stored?.metadata?.chatId || '');
      if (!token || !chatId) return;
      const offset = Number(stored.metadata?.updateOffset || 0);
      const updates = await this.telegram.getUpdates(token, offset);
      let nextOffset = offset;
      for (const update of updates) {
        nextOffset = Math.max(nextOffset, Number(update.update_id) + 1);
        const incomingChatId = String(update.callback_query?.message?.chat?.id ?? update.message?.chat?.id ?? '');
        if (incomingChatId !== chatId) continue;
        const action = update.callback_query?.data;
        if (update.callback_query?.id) await this.telegram.answerCallbackQuery(token, update.callback_query.id).catch(() => undefined);
        // Каждый обработчик — в своём try/catch: nextOffset для этого update уже
        // посчитан выше, и если дать исключению всплыть до внешнего catch, сдвиг
        // курсора не запишется — бот будет получать то же сообщение и падать
        // на нём каждые 5 секунд, пока кто-то не заметит логи.
        try {
          if (action === 'report:today' || action === 'report:yesterday' || action === 'report:week' || action === 'report:month') {
            await this.sendProfitReport(token, chatId, action.slice('report:'.length) as 'today' | 'yesterday' | 'week' | 'month');
          } else if (action === 'report:wallet') {
            await this.sendWalletReport(token, chatId);
          } else if (action === 'report:stock') {
            await this.sendStockReport(token, chatId);
          } else if (action === 'reviews:next') {
            await this.sendReviewCard(token, chatId, 'next');
          } else if (action?.startsWith('reviews:skip:')) {
            await this.sendReviewCard(token, chatId, 'skip', action.slice('reviews:skip:'.length));
          } else if (action?.startsWith('reviews:redo:')) {
            await this.sendReviewCard(token, chatId, 'redo', action.slice('reviews:redo:'.length));
          } else if (action?.startsWith('reviews:send:')) {
            await this.sendReviewAndAdvance(token, chatId, action.slice('reviews:send:'.length));
          } else if (action === 'menu' || update.message?.text === '/start' || update.message?.text === '/menu') {
            await this.telegram.sendMessage(token, chatId, 'Выберите отчёт:', undefined, this.telegramMenu());
          }
        } catch (error: any) {
          this.logger.error(`Telegram action «${action}»: ${error?.message || error}`);
          await this.telegram.sendMessage(token, chatId, `⚠️ ${String(error?.message || 'Не удалось выполнить').slice(0, 300)}`, undefined, this.telegramMenu()).catch(() => undefined);
        }
      }
      if (nextOffset !== offset) {
        await this.prisma.integrationCredential.update({ where: { type: IntegrationType.TELEGRAM }, data: { metadata: { ...stored.metadata, updateOffset: nextOffset } } });
      }
    } catch (error: any) {
      this.logger.error(`Telegram polling failed: ${error?.message || error}`);
    } finally {
      this.telegramPolling = false;
    }
  }

  /** Клиент Anthropic: с ключом из настроек либо на учётных данных сервера. */
  private anthropicClient(token?: string | null) {
    const apiKey = String(token || '').replace(/^Bearer\s+/i, '').trim();
    return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  private type(value: string) {
    const type = value.toUpperCase() as IntegrationType;
    if (!Object.values(IntegrationType).includes(type)) throw new BadRequestException('Неизвестный тип интеграции');
    return type;
  }

  private async uzumRequest(path: string, token: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`https://api-seller.uzum.uz/api/seller-openapi${path}`, {
        headers: { Authorization: token, Accept: 'application/json' },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Uzum API: HTTP ${response.status}${body?.message ? ` — ${body.message}` : ''}`);
      return body;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error('Uzum API: превышено время ожидания 20 секунд');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async uzumInternalReviewsRequest(token: string, requestedShopId: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const normalizedToken = token.replace(/^Bearer\s+/i, '').trim();
      const response = await fetch('https://api-seller.uzum.uz/api/seller/product-reviews?page=0&size=1', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${normalizedToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filter: 'ALL' }),
        signal: controller.signal,
      });
      if (response.status === 401) throw new Error('Сессия кабинета Uzum истекла. Вставьте свежий Bearer token в Настройки → Отзывы Uzum');
      if (!response.ok) throw new Error(`Uzum internal reviews API: HTTP ${response.status}`);
      const body = await response.json().catch(() => ({}));
      const rows = Array.isArray(body?.payload) ? body.payload : [];
      const returnedShopId = rows.length ? String(rows[0]?.shop?.id ?? '').trim() : '';
      if (returnedShopId && requestedShopId && returnedShopId !== requestedShopId) {
        throw new Error(`Uzum internal reviews API returned shop ${returnedShopId}, expected ${requestedShopId}`);
      }
      return {
        rowsAvailable: rows.length,
        shopId: returnedShopId || requestedShopId || null,
        timestamp: body?.timestamp ?? null,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error('Uzum internal reviews API: timeout after 20 seconds');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async list() {
    const rows = await this.prisma.integrationCredential.findMany();
    return rows.map((row) => ({
      type: row.type,
      status: row.status,
      enabled: row.enabled,
      metadata: this.publicMetadata(row.metadata),
      tokenMasked: this.crypto.mask(this.safeDecrypt(row)),
      lastTestedAt: row.lastTestedAt,
      lastError: row.lastError,
    }));
  }

  async save(value: string, dto: any) {
    const type = this.type(value);
    const current = await this.prisma.integrationCredential.findUnique({ where: { type } });
    const previousMetadata = (current?.metadata || {}) as Record<string, any>;
    const sellerIntegration = type === IntegrationType.UZUM_INTERNAL
      ? await this.prisma.integrationCredential.findUnique({ where: { type: IntegrationType.UZUM } })
      : null;
    const sellerMetadata = (sellerIntegration?.metadata || {}) as Record<string, any>;
    const secret = dto.token?.trim() ? this.crypto.encrypt(dto.token.trim()) : {};
    const metadata = type === IntegrationType.UZUM
      ? {
          shopId: dto.shopId?.trim() || previousMetadata.shopId || null,
          shopName: dto.shopName?.trim() || previousMetadata.shopName || null,
        }
      : type === IntegrationType.UZUM_INTERNAL
        ? {
            shopId: dto.shopId?.trim() || previousMetadata.shopId || sellerMetadata.shopId || null,
          }
        : type === IntegrationType.ANTHROPIC
          ? {
              // openclaw — генерация локальным OpenClaw на учётных данных сервера,
              // api — через api.anthropic.com с собственным ключом.
              provider: (dto.provider || previousMetadata.provider) === 'api' ? 'api' : 'openclaw',
              model: dto.model?.trim() || previousMetadata.model || 'claude-opus-5',
              // Пусто — модель агента OpenClaw по умолчанию.
              openclawModel: dto.openclawModel?.trim() || previousMetadata.openclawModel || '',
              autoReplyEnabled: dto.autoReplyEnabled ?? previousMetadata.autoReplyEnabled ?? false,
            }
        : type === IntegrationType.OPENAI
          ? {
              model: dto.model?.trim() || previousMetadata.model || 'gpt-5.4-nano',
              autoReplyEnabled: dto.autoReplyEnabled ?? previousMetadata.autoReplyEnabled ?? false,
            }
        : {
            // Курсор опроса Telegram ставит фоновый цикл, а не форма настроек.
            // Раньше он тут терялся при каждом сохранении, и бот заново
            // вычитывал уже обработанные сообщения.
            updateOffset: previousMetadata.updateOffset ?? null,
            chatId: dto.chatId?.trim() || previousMetadata.chatId || null,
            dailyDigestTime: dto.dailyDigestTime || previousMetadata.dailyDigestTime || '09:00',
            notifyDailyDigest: dto.notifyDailyDigest ?? previousMetadata.notifyDailyDigest ?? true,
            notifyNewOrders: dto.notifyNewOrders ?? previousMetadata.notifyNewOrders ?? true,
            notifyLowStock: dto.notifyLowStock ?? previousMetadata.notifyLowStock ?? true,
            notifyGoals: dto.notifyGoals ?? previousMetadata.notifyGoals ?? true,
            notifyErrors: dto.notifyErrors ?? previousMetadata.notifyErrors ?? true,
            notifySupplyStatus: dto.notifySupplyStatus ?? previousMetadata.notifySupplyStatus ?? true,
            notifySlotFound: dto.notifySlotFound ?? previousMetadata.notifySlotFound ?? true,
            notifyAgents: dto.notifyAgents ?? previousMetadata.notifyAgents ?? true,
          };

    if (type === IntegrationType.UZUM && !metadata.shopId) throw new BadRequestException('Укажите Shop ID');
    if (type === IntegrationType.UZUM_INTERNAL && !metadata.shopId) throw new BadRequestException('Укажите Shop ID для внутреннего API Uzum');
    if (type === IntegrationType.TELEGRAM && !metadata.chatId) throw new BadRequestException('Укажите Telegram Chat ID');
    const hasExistingToken = Boolean(current && this.safeDecrypt(current));
    if (!dto.token?.trim() && !hasExistingToken && type !== IntegrationType.ANTHROPIC) throw new BadRequestException('Укажите токен');

    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.integrationCredential.upsert({
        where: { type },
        update: { ...secret, metadata, enabled: dto.enabled ?? true },
        create: { type, ...secret, metadata, enabled: dto.enabled ?? true },
      });
      if (type === IntegrationType.UZUM) {
        const shopId = String(metadata.shopId);
        const shop = await tx.shop.upsert({
          where: { externalId: shopId },
          update: { name: metadata.shopName || `Магазин ${shopId}`, isActive: true },
          create: { externalId: shopId, name: metadata.shopName || `Магазин ${shopId}`, isActive: true },
        });
        await tx.shop.updateMany({ where: { id: { not: shop.id } }, data: { isActive: false } });
      }
      return saved;
    });
    return { type: row.type, saved: true, metadata: this.publicMetadata(row.metadata), tokenMasked: this.crypto.mask(this.safeDecrypt(row)) };
  }

  /**
   * Служебные поля metadata, которые ставит сам сервер. В интерфейс они не
   * отдаются: экран настроек присылает metadata обратно как есть, а
   * ValidationPipe (forbidNonWhitelisted) на незнакомом поле роняет весь
   * запрос — «property updateOffset should not exist».
   */
  private publicMetadata(metadata: unknown) {
    const { updateOffset, ...rest } = (metadata || {}) as Record<string, unknown>;
    return rest;
  }

  /**
   * Расшифровка, которая не валит запрос. Строка, зашифрованная прежним
   * APP_ENCRYPTION_KEY (переезд на другой сервер, ротация ключа), возвращается
   * как пустая — иначе экран настроек и сохранение нового токена падают с 500,
   * и вписать рабочий токен становится нечем.
   */
  private safeDecrypt(row: { }): string {
    try {
      return this.crypto.decrypt(row as any) ?? '';
    } catch {
      return '';
    }
  }

  async getPlain(type: IntegrationType) {
    const row = await this.prisma.integrationCredential.findUnique({ where: { type } });
    if (!row || !row.enabled) return null;
    // Секрета могло не быть вообще с самого начала — например, ANTHROPIC с
    // provider=openclaw токен не требует. Это не ошибка расшифровки, и metadata
    // (в т.ч. autoReplyEnabled) в этом случае вполне рабочая — терять её нельзя.
    if (!row.encryptedValue || !row.iv || !row.authTag) {
      return { token: '', metadata: (row.metadata || {}) as any, row };
    }
    // Токен зашифрован ключом APP_ENCRYPTION_KEY. Если ключ сменился (переезд на
    // другой сервер, ротация), расшифровать старую строку нельзя — и раньше это
    // валило исключением ВСЕХ, кто сюда обращается: и фоновый опрос Telegram, и
    // сохранение нового токена в настройках. Получался тупик: чтобы вписать
    // рабочий токен, надо сначала расшифровать нерасшифровываемый.
    // Считаем такую строку просто ненастроенной — вызывающий код уже умеет
    // обрабатывать null, а пользователь может ввести токен заново.
    const token = this.safeDecrypt(row);
    if (!token) {
      this.logger.warn(`Интеграция ${type}: сохранённый токен не расшифровывается текущим APP_ENCRYPTION_KEY — считаю её ненастроенной, введите токен заново`);
      return null;
    }
    return { token, metadata: (row.metadata || {}) as any, row };
  }

  async test(value: string, dto: any) {
    const type = this.type(value);
    const stored = await this.getPlain(type);
    const token = dto.token?.trim() || stored?.token;
    // У Anthropic ключ необязателен: если его нет, SDK возьмёт учётные данные
    // сервера (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / OAuth-профиль).
    if (!token && type !== IntegrationType.ANTHROPIC) throw new BadRequestException('Сначала укажите токен');

    try {
      let details: any;
      if (type === IntegrationType.UZUM) {
        const response = await this.uzumRequest('/v1/shops', token);
        const shops = Array.isArray(response) ? response : response?.payload || response?.data || response?.shops || [];
        const requestedShopId = String(dto.shopId || stored?.metadata?.shopId || '').trim();
        const shopFound = !requestedShopId || !Array.isArray(shops) || shops.some((shop: any) => String(shop?.id ?? shop?.shopId) === requestedShopId);
        if (!shopFound) throw new Error(`Uzum API работает, но магазин ${requestedShopId} не найден среди доступных`);
        details = { shopCount: Array.isArray(shops) ? shops.length : null, shopId: requestedShopId || null };
      } else if (type === IntegrationType.UZUM_INTERNAL) {
        const requestedShopId = String(dto.shopId || stored?.metadata?.shopId || '').trim();
        if (!requestedShopId) throw new Error('Укажите Shop ID для внутреннего API Uzum');
        details = await this.uzumInternalReviewsRequest(token, requestedShopId);
      } else if (type === IntegrationType.ANTHROPIC) {
        const provider = (dto.provider || stored?.metadata?.provider) === 'api' ? 'api' : 'openclaw';
        if (provider === 'openclaw') {
          // Здесь важен не сам ответ, а то, что OpenClaw на сервере нашёлся и
          // его вход в Claude ещё живой. Дешевле этого проверить нечем: у CLI
          // нет отдельной ручки «проверь авторизацию».
          const model = String(dto.openclawModel || stored?.metadata?.openclawModel || '').trim() || DEFAULT_OPENCLAW_MODEL;
          const version = await this.openclaw.version();
          const probe = await this.openclaw.run('Ответь ровно одним словом: ok', { model, thinking: 'off', timeoutSec: 90 });
          details = { via: 'OpenClaw', version, model: probe.model || model || 'по умолчанию', provider: probe.provider, answer: probe.text.slice(0, 40) };
        } else {
          // Проверяем доступ самым дешёвым запросом: читаем карточку модели.
          // Генерацию не запускаем — она стоит денег и ничего не добавляет.
          const model = String(dto.model || stored?.metadata?.model || 'claude-opus-5');
          const info = await this.anthropicClient(token).models.retrieve(model);
          details = { via: 'API Anthropic', model: info.id, displayName: info.display_name, auth: token ? 'ключ из настроек' : 'учётные данные сервера' };
        }
      } else if (type === IntegrationType.OPENAI) {
        const model = String(dto.model || stored?.metadata?.model || 'gpt-5.4-nano');
        const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
          headers: { Authorization: `Bearer ${token.replace(/^Bearer\s+/i, '').trim()}` },
        });
        if (!response.ok) throw new Error(`OpenAI API: HTTP ${response.status}`);
        details = { model };
      } else {
        const chatId = String(dto.chatId || stored?.metadata?.chatId || '').trim();
        details = await this.telegram.test(token, chatId);
      }
      await this.prisma.integrationCredential.upsert({
        where: { type },
        update: { status: IntegrationStatus.CONNECTED, lastTestedAt: new Date(), lastError: null },
        create: { type, status: IntegrationStatus.CONNECTED, lastTestedAt: new Date() },
      });
      return { ok: true, details };
    } catch (error: any) {
      // token может быть пустым (у Anthropic он необязателен) — тогда заменять нечего.
      const message = token
        ? String(error?.message || 'Неизвестная ошибка').split(token).join('***')
        : String(error?.message || 'Неизвестная ошибка');
      await this.prisma.integrationCredential.upsert({
        where: { type },
        update: { status: IntegrationStatus.ERROR, lastTestedAt: new Date(), lastError: message },
        create: { type, status: IntegrationStatus.ERROR, lastTestedAt: new Date(), lastError: message },
      });
      throw new BadRequestException(message);
    }
  }

  async notifyTelegram(
    text: string,
    option: 'notifyErrors' | 'notifyNewOrders' | 'notifyLowStock' | 'notifyGoals' | 'notifySupplyStatus' | 'notifySlotFound' | 'notifyDailyDigest' | 'notifyAgents' = 'notifyErrors',
    parseMode?: 'HTML' | 'MarkdownV2',
  ) {
    const stored = await this.getPlain(IntegrationType.TELEGRAM);
    const token = stored?.token;
    const chatId = String(stored?.metadata?.chatId || '');
    if (!token || !chatId || stored?.metadata?.[option] === false) return false;
    await this.telegram.sendMessage(token, chatId, text, parseMode);
    return true;
  }

  async testLatestOrderNotification() {
    const stored = await this.getPlain(IntegrationType.TELEGRAM);
    const token = stored?.token;
    const chatId = String(stored?.metadata?.chatId || '');
    if (!token || !chatId) throw new BadRequestException('Telegram-бот или Chat ID не настроены');
    const order = await this.prisma.order.findFirst({
      orderBy: [{ orderedAt: 'desc' }, { createdAt: 'desc' }],
      include: { items: { orderBy: { id: 'asc' }, include: { sku: { include: { product: true, costs: { where: { validTo: null }, orderBy: { validFrom: 'desc' }, take: 1 } } } } } },
    });
    if (!order) throw new BadRequestException('В базе нет заказов для теста');
    const orderNumber = order.marketplaceOrderId || order.externalId;
    const skuTitle = order.items[0]?.title || 'UNKNOWN';
    const upperSku = skuTitle.toUpperCase();
    const family = upperSku.match(/(?:^|[-_])(J\d+|YD|D272)(?:[-_]|$)/)?.[1] || 'UNKNOWN';
    const variant = upperSku.includes('ЛИЦ') ? 'ЛИЦЕВОЕ' : upperSku.includes('БАНН') ? 'БАННОЕ' : upperSku.includes('САУН') ? 'САУНА' : upperSku.includes('КОМПЛ') || upperSku.includes('МИКС') ? 'КОМПЛЕКТ' : 'UNKNOWN';
    const productCost = order.items.reduce((sum, item) => {
      const cost = item.sku?.costs?.[0];
      if (!cost) return sum;
      return sum + (Number(cost.amount) + Number(cost.packagingCost) + Number(cost.additionalCost) + Number(cost.warehouseLogisticsCost)) * item.quantity;
    }, 0);
    const gross = Number(order.grossRevenue);
    const payout = Number(order.payout);
    const settings = await this.prisma.financialSettings.findUnique({ where: { shopId: order.shopId } });
    const tax = gross * Number(settings?.taxPercent ?? 1) / 100;
    const productIds = [...new Set(order.items.map((item) => item.sku?.product.externalId).filter((value): value is string => Boolean(value)))];
    const recentAdvertisingExpenses = productIds.length ? await this.prisma.marketplaceExpense.findMany({
      where: {
        shopId: order.shopId,
        code: ORDER_BOOST_CODE,
        type: 'OUTCOME',
        productExternalId: { in: productIds },
        serviceAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
      select: { id: true, productExternalId: true, serviceAt: true, createdAt: true, name: true, raw: true },
    }) : [];
    const rateTimeline = advertisingRateTimeline(recentAdvertisingExpenses);
    const estimatedAdvertising = advertisingEstimateAt(order.items.map((item) => ({
      amount: Number(item.amount),
      productExternalId: item.sku?.product.externalId || null,
    })), rateTimeline, order.orderedAt || order.createdAt);
    const advertising = order.adCostReported ? Number(order.adCost) : estimatedAdvertising.amount;
    const profit = payout - productCost - tax - advertising;
    const payoutKnown = Boolean(order.payoutReported);
    const productCostKnown = order.items.every((item) => Boolean(item.sku?.costs?.[0]));
    const advertisingKnown = Boolean(order.adCostReported)
      || estimatedAdvertising.totalRevenue <= estimatedAdvertising.coveredRevenue + 0.01;
    const profitKnown = payoutKnown && productCostKnown && advertisingKnown;
    const money = (value: number) => Math.round(Math.abs(value)).toLocaleString('ru-RU');
    const date = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tashkent' }).format(order.orderedAt || order.createdAt).replace(',', '');
    const payoutLine = payoutKnown ? `<b>+${money(payout)} so'm</b>` : '<b>нет факта API</b>';
    const costLine = productCostKnown ? `<b>-${money(productCost)} so'm</b>` : '<b>не задана</b>';
    const advertisingLine = advertisingKnown
      ? `<b>-${money(advertising)} so'm</b>${order.adCostReported ? ' (факт)' : ' (оценка по ставкам товаров)'}`
      : '<b>не рассчитана — ставка товара не наблюдалась</b>';
    const profitLine = profitKnown
      ? `<b>${profit >= 0 ? '+' : '-'}${money(profit)} so'm</b>`
      : '<b>не рассчитан из-за отсутствующих исходных данных</b>';
    const message = `🛒 <b>НОВЫЙ ЗАКАЗ UZUM</b>\n━━━━━━━━━━━━━━━━━━━━\n🧾 Заказ: <b>${orderNumber}</b>\n📦 SKU: <b>${skuTitle}</b>\n🏷 Тип: <b>${family} | ${variant}</b>\n🔢 Кол-во: <b>${order.quantity}</b> шт\n💰 Цена продажи: <b>${money(gross)} so'm</b>\n💵 К выводу: ${payoutLine}\n🏷 Себестоимость: ${costLine}\n📣 Реклама: ${advertisingLine}\n📈 Профит: ${profitLine}\n🕒 Дата: ${date}`;
    const sent = await this.telegram.sendMessage(token, chatId, message, 'HTML');
    return { ok: true, orderId: order.id, externalId: orderNumber, messageId: sent?.message_id || null };
  }
}
