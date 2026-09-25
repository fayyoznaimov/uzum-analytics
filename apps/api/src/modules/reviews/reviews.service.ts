import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { BadGatewayException, BadRequestException, forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationStatus, IntegrationType, Prisma } from '@prisma/client';
import { DEFAULT_OPENCLAW_MODEL, OpenclawClient } from '../../common/openclaw.client';
import { PrismaService } from '../../common/prisma.service';
import { z } from 'zod';
import { IntegrationsService } from '../integrations/integrations.service';

type ReviewFilter = 'ALL' | 'NO_REPLY';

/**
 * Форма черновика ответа. По API отдаётся модели как structured output; на пути
 * через OpenClaw structured output недоступен, поэтому та же схема служит
 * проверкой разобранного JSON.
 */
const ReviewDraftSchema = z.object({
  reply: z.string().min(10).max(350),
  language: z.enum(['ru', 'uz']),
  risk: z.enum(['LOW', 'REVIEW']),
});

/** Модель по умолчанию для черновиков ответов на отзывы (путь api — свой ключ). */
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);
  private syncInProgress = false;
  private autoReplyInProgress = false;
  private readonly reviewsUrl = 'https://api-seller.uzum.uz/api/seller/product-reviews';

  constructor(
    private readonly prisma: PrismaService,
    // IntegrationsService теперь тоже держит ReviewsService (карточки отзывов в
    // Telegram) — циклическая зависимость требует forwardRef на ОБЕИХ сторонах,
    // не только там, где её завели последней.
    @Inject(forwardRef(() => IntegrationsService)) private readonly integrations: IntegrationsService,
    private readonly openclaw: OpenclawClient,
  ) {}

  /**
   * Чем генерировать черновик. По умолчанию — локальный OpenClaw: он уже
   * авторизован на сервере, ключей заводить не нужно и в базе приложения
   * никаких секретов не появляется. Путь «api» остаётся для собственного ключа.
   */
  private aiProvider(metadata: any): 'openclaw' | 'api' {
    return String(metadata?.provider || 'openclaw') === 'api' ? 'api' : 'openclaw';
  }

  /**
   * Клиент Anthropic. С явным ключом — когда он сохранён в настройках; без него
   * SDK разрешает учётные данные сам (переменные окружения или OAuth-профиль
   * сервера). Пустой конструктор бросит понятную ошибку, если на сервере нет
   * ни того, ни другого.
   */
  private anthropicClient(token?: string | null) {
    const apiKey = String(token || '').replace(/^Bearer\s+/i, '').trim();
    return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  /**
   * Системный промпт черновика. Вынесен отдельно, потому что его используют оба
   * пути генерации. Текст выверен вручную и есть основная ценность этой функции —
   * правки только осознанные.
   *
   * Готовых фраз здесь намеренно НЕТ. В прежней версии они были прописаны
   * дословно («Для 5★ без текста: …»), и это дало 48 одинаковых ответов подряд
   * на витрине — сразу видно скрипт. Вместо шаблонов задаём тон, а от повторов
   * страхует список уже использованных формулировок в пользовательском сообщении.
   */
  private replySystemPrompt(shopName?: string | null) {
    return `Ты отвечаешь от имени магазина «${shopName || 'продавца'}» на отзывы покупателей на Uzum.
Пиши как живой человек из небольшого семейного магазина текстиля, которому правда приятно, что покупка понравилась. Не служба поддержки, не отдел маркетинга.

ГЛАВНОЕ: каждый ответ должен быть непохож на предыдущие. В сообщении придёт список уже использованных формулировок — не повторяй ни одну из них, даже частично, и не строй ответ по той же схеме. Меняй начало, интонацию, порядок мысли, длину. Одинаковые ответы под соседними отзывами выдают бота и обесценивают все остальные.

Язык: определи по тексту отзыва — русский или узбекский (lotin). Если текста нет, смотри на имя: латиница — узбекский, кириллица или «Безымянный» — русский.
Длина: 1–2 предложения. Коротко, тепло, без приторности и канцелярита.
Не пересказывай отзыв и не рекламируй товар. Не выдумывай подробностей, которых в отзыве нет.

Никогда не упоминай саму оценку, баллы, звёзды или их количество — ни числом, ни словами («высокая оценка», «пятёрка», «за оценку», «за отзыв на 5★» и т.п.). Покупатель поставил звёзды на самой платформе, комментировать это в тексте не о чем — это первое, что выдаёт шаблон и бота.
Если текста в отзыве нет — не упоминай оценку (см. выше) и не сочиняй, как товар будет служить, радовать или дарить уют. Просто коротко и тепло поблагодари за отзыв/интерес к магазину, разными словами каждый раз. Обычно это одно короткое предложение.
Если конкретика есть (мягкость, размер, цвет, впитывает, повторный заказ, подарок) — зацепись именно за неё, это и есть источник живого ответа.
Эмодзи — максимум один и только зелёное сердце 💚. В коротких благодарностях ставь его почти всегда, в развёрнутых ответах — по ситуации.
Запрещено: приветствие «Salom», слова «официальный интерфейс», тройные благодарности подряд, длинные инструкции.
Имя используй, только если оно настоящее и звучит естественно. «Безымянный», «***» и «покупатель» — не имена, обращаться так нельзя.
Жалоба, ошибка комплектации, возврат, брак или оценка 1–3★: извинись без признания несуществующей вины, ничего не обещай — ни замены, ни компенсации, ни сроков — и поставь risk=REVIEW. Только в этом случае уместно предложить написать через заказ в Uzum.

Факт о товаре: полотенца продаются в 3 отдельных вариантах — 50×90 (лицевое), 70×140 (банное) и «Комплект» (оба вместе). Если жалоба в духе «заказывал комплект, а пришло одно полотенце» — это почти всегда значит, что при заказе выбрали вариант «1 шт.» (50×90 или 70×140), а не «Комплект», а не недовложение или брак с нашей стороны. В такой жалобе спокойно, без обвинений и без извинений за несуществующую ошибку объясни это в 1–2 предложениях: товар выбирается по вариантам, похоже, оформили вариант без комплекта — и подскажи, что для двух полотенец нужно выбрать вариант «Комплект» при заказе. Не обещай возврат, доукомплектацию или компенсацию.
Любой сомнительный ответ помечай risk=REVIEW.`;
  }

  /**
   * Формулировки, которые уже ушли покупателям. Отдаются модели как стоп-лист,
   * иначе она сходится к одной удачной фразе и печатает её десятками.
   */
  private async recentReplies(shopId: string, limit = 20) {
    const rows = await this.prisma.review.findMany({
      where: { shopId, aiReplyText: { not: null } },
      orderBy: { aiReplyGeneratedAt: 'desc' },
      take: 120,
      select: { aiReplyText: true },
    });
    const seen = new Set<string>();
    for (const row of rows) {
      const text = this.text(row.aiReplyText);
      if (text) seen.add(text);
      if (seen.size >= limit) break;
    }
    return [...seen];
  }

  async generateAiDraft(id: string) {
    const review = await this.prisma.review.findUnique({ where: { id }, include: { shop: true } });
    if (!review) throw new BadRequestException('Отзыв не найден');
    if (!review.needsReply) throw new BadRequestException('На этот отзыв уже есть ответ продавца');
    const configured = await this.integrations.getPlain(IntegrationType.ANTHROPIC);
    const customer = review.anonymous ? 'покупатель' : (review.customerName || 'покупатель');
    const system = this.replySystemPrompt(review.shop?.name);
    const input = JSON.stringify({
      customer,
      rating: review.rating,
      product: review.productTitle,
      variant: review.skuTitle,
      review: review.content,
      pros: review.pros,
      cons: review.cons,
      уже_использовано_не_повторять: await this.recentReplies(review.shopId),
    });

    const generated = this.aiProvider(configured?.metadata) === 'openclaw'
      ? await this.draftViaOpenclaw(system, input, this.text(configured?.metadata?.openclawModel) || DEFAULT_OPENCLAW_MODEL)
      : await this.draftViaAnthropic(system, input, String(configured?.metadata?.model || DEFAULT_ANTHROPIC_MODEL), configured?.token);
    const parsed = generated.draft;
    const model = generated.model;

    const risk = review.rating <= 3 ? 'REVIEW' : parsed.risk;
    const saved = await this.prisma.review.update({
      where: { id },
      data: {
        aiReplyText: parsed.reply.trim(),
        aiReplyLanguage: parsed.language,
        aiReplyRisk: risk,
        aiReplyModel: model,
        aiReplyGeneratedAt: new Date(),
      },
    });
    return { id: saved.id, draft: saved.aiReplyText, language: saved.aiReplyLanguage, risk, model, canAutoSend: risk === 'LOW' && review.rating >= 4, sent: false };
  }

  /**
   * Черновик через локальный OpenClaw. Ключ Anthropic не нужен: OpenClaw уже
   * авторизован на сервере тем же входом, что и рабочие Telegram-боты фабрики.
   * Structured output здесь недоступен, поэтому формат просим текстом и
   * проверяем той же схемой; одна повторная попытка — на случай, если модель
   * обернула JSON пояснением.
   */
  private async draftViaOpenclaw(system: string, input: string, model?: string | null) {
    const format = [
      'Верни РОВНО один JSON-объект и ничего больше: без пояснений, без markdown-обёртки, без тройных кавычек.',
      '{"reply": "текст ответа", "language": "ru" | "uz", "risk": "LOW" | "REVIEW"}',
      'Поле reply — не длиннее 350 символов. Инструменты вызывать не нужно, это чистая генерация текста.',
    ].join('\n');
    let lastError = 'Claude вернул ответ в неверном формате';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const strict = attempt === 0 ? '' : '\n\nПредыдущий ответ не разобрался. Верни только JSON-объект: первый символ «{», последний «}».';
      let result: { text: string; model: string | null };
      try {
        result = await this.openclaw.run(`${system}\n\n${format}${strict}\n\nОтзыв:\n${input}`, { model, thinking: 'off' });
      } catch (error: any) {
        // safeError здесь не годится: он прячет всё незнакомое под «Review
        // synchronization failed», а тут ошибка локальная и её надо видеть.
        throw new BadGatewayException(String(error?.message || 'OpenClaw не ответил').slice(0, 300));
      }
      const candidate = ReviewDraftSchema.safeParse(this.extractJson(result.text));
      if (candidate.success) return { draft: candidate.data, model: result.model || model || 'openclaw' };
      lastError = `Claude вернул ответ в неверном формате: ${candidate.error.issues[0]?.message || 'не сошлось со схемой'}`;
      this.logger.warn(`OpenClaw: черновик не сошёлся со схемой, попытка ${attempt + 1} из 2`);
    }
    throw new BadGatewayException(lastError);
  }

  /** Черновик через API Anthropic — путь для тех, у кого есть собственный ключ. */
  private async draftViaAnthropic(system: string, input: string, model: string, token?: string | null) {
    // Ключ в настройках необязателен: без него SDK сам возьмёт учётные данные
    // сервера — ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN или OAuth-профиль.
    const client = this.anthropicClient(token);
    try {
      const response = await client.messages.parse({
        model,
        max_tokens: 4000,
        // Ответ — пара предложений, рассуждать тут не над чем. Низкий effort
        // держит стоимость и задержку внизу; отключать размышление совсем не
        // стоит — на Opus 5 это даёт побочные эффекты вроде утечки служебных тегов.
        output_config: {
          effort: 'low',
          format: zodOutputFormat(ReviewDraftSchema),
        },
        system,
        messages: [{ role: 'user', content: input }],
      });
      if (response.stop_reason === 'refusal') {
        throw new BadGatewayException('Claude отказался составлять ответ на этот отзыв — ответьте вручную');
      }
      // parsed_output = null, если ответ не сошёлся со схемой.
      if (!response.parsed_output) throw new BadGatewayException('Claude вернул ответ в неверном формате');
      return { draft: response.parsed_output, model };
    } catch (error: any) {
      if (error instanceof BadGatewayException) throw error;
      if (error instanceof Anthropic.AuthenticationError) throw new BadRequestException('Anthropic API key отклонён — проверьте ключ в Настройках');
      if (error instanceof Anthropic.RateLimitError) throw new BadGatewayException('Anthropic: превышен лимит запросов, попробуйте позже');
      if (error instanceof Anthropic.APIConnectionError) throw new BadGatewayException('Не удалось связаться с Anthropic API');
      if (error instanceof Anthropic.APIError) throw new BadGatewayException(`Anthropic API: HTTP ${error.status}`);
      throw new BadGatewayException(`Anthropic API: ${this.safeError(error)}`);
    }
  }

  /** Первый сбалансированный JSON-объект из текста модели. */
  private extractJson(text: string): unknown {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  async sendReply(id: string, requestedContent?: string) {
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw new BadRequestException('Отзыв не найден');
    if (!review.needsReply) throw new BadRequestException('На этот отзыв уже отправлен ответ');
    const content = this.text(requestedContent || review.aiReplyText);
    if (!content) throw new BadRequestException('Сначала создайте AI-ответ или укажите текст');
    if (content.length > 1000) throw new BadRequestException('Ответ длиннее 1000 символов');
    const configured = await this.integrations.getPlain(IntegrationType.UZUM_INTERNAL);
    if (!configured?.token) throw new BadRequestException('Токен кабинета Uzum не настроен');
    const token = configured.token.replace(/^Bearer\s+/i, '').trim();
    const response = await fetch('https://api-seller.uzum.uz/api/seller/product-reviews/reply/create', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ reviewId: Number(review.externalId), content }]),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new BadGatewayException(`Uzum reply API: HTTP ${response.status}${body?.message ? ` — ${body.message}` : ''}`);
    await this.prisma.review.update({
      where: { id },
      data: {
        aiReplyText: content,
        replyStatus: 'SUBMITTED',
        needsReply: false,
      },
    });
    return { ok: true, id, externalId: review.externalId, content, uzum: body?.payload?.[0] || null };
  }

  @Cron('0 */15 * * * *')
  async scheduledAutoReplies() {
    const configured = await this.integrations.getPlain(IntegrationType.ANTHROPIC).catch(() => null);
    if (!configured?.metadata?.autoReplyEnabled) return;
    await this.runAutoReplies().catch((error) => this.logger.error(`Автоответы: ${this.safeError(error)}`));
  }

  async runAutoReplies() {
    if (this.autoReplyInProgress) return { accepted: false, alreadyRunning: true };
    this.autoReplyInProgress = true;
    try {
      const configured = await this.integrations.getPlain(IntegrationType.ANTHROPIC);
      if (!configured?.metadata?.autoReplyEnabled) throw new BadRequestException('Автоответы выключены в Настройках');
      const reviews = await this.prisma.review.findMany({
        where: { needsReply: true, rating: { gte: 4 } },
        orderBy: { dateCreated: 'asc' },
        take: 10,
      });
      let generated = 0;
      let sent = 0;
      let reviewRequired = 0;
      const errors: Array<{ id: string; error: string }> = [];
      for (const review of reviews) {
        try {
          let candidate = review;
          if (!candidate.aiReplyText) {
            await this.generateAiDraft(review.id);
            generated++;
            candidate = await this.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
          }
          if (candidate.aiReplyRisk !== 'LOW') {
            reviewRequired++;
            continue;
          }
          await this.sendReply(candidate.id);
          sent++;
        } catch (error) {
          const message = this.safeError(error);
          errors.push({ id: review.id, error: message });
          if (message.includes('HTTP 429')) {
            await this.prisma.integrationCredential.updateMany({
              where: { type: IntegrationType.ANTHROPIC },
              data: {
                status: IntegrationStatus.ERROR,
                lastTestedAt: new Date(),
                lastError: 'Anthropic: превышен лимит или закончился баланс. Пополните счёт и снова включите автоответы.',
                metadata: { ...configured.metadata, autoReplyEnabled: false },
              },
            });
            break;
          }
        }
      }
      return { accepted: true, checked: reviews.length, generated, sent, reviewRequired, errors };
    } finally {
      this.autoReplyInProgress = false;
    }
  }

  private number(value: unknown, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private integer(value: unknown, fallback = 0) {
    return Math.round(this.number(value, fallback));
  }

  private optionalRating(value: unknown) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = this.integer(value, -1);
    return parsed >= 0 && parsed <= 5 ? parsed : null;
  }

  private text(value: unknown) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  private optionalText(value: unknown) {
    return this.text(value) || null;
  }

  private object(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private json(value: unknown): Prisma.InputJsonValue {
    try {
      return JSON.parse(JSON.stringify(value ?? [])) as Prisma.InputJsonValue;
    } catch {
      return [];
    }
  }

  private date(value: unknown): Date | null {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const numeric = Number(value);
    let parsed: Date;
    if (Number.isFinite(numeric) && numeric > 0) {
      parsed = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    } else {
      parsed = new Date(String(value));
    }
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private boolean(value: unknown) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return ['true', '1', 'yes'].includes(this.text(value).toLowerCase());
  }

  private normalizeFilter(value: unknown): ReviewFilter {
    return this.text(value).toUpperCase() === 'NO_REPLY' ? 'NO_REPLY' : 'ALL';
  }

  private needsReply(replyStatus: string | null, requestedFilter: ReviewFilter) {
    if (requestedFilter === 'NO_REPLY') return true;
    if (!replyStatus) return true;
    return /NO[_\s-]?REPLY|NOT[_\s-]?REPLIED|UNANSWERED|WITHOUT[_\s-]?REPLY|NEW/i.test(replyStatus);
  }

  private firstPhoto(product: Record<string, any>) {
    const photos = Array.isArray(product.photos) ? product.photos : [];
    const first = photos[0];
    if (typeof first === 'string') return first || null;
    const photo = this.object(first);
    const direct = this.optionalText(photo.url ?? photo.photoUrl ?? photo.src);
    if (direct) return direct;

    const variants = this.object(photo.photo);
    const resolutionPriority = ['540', '720', '1080', '360', '240', '80'];
    const keys = Object.keys(variants).sort((left, right) => {
      const leftPreferred = resolutionPriority.findIndex((resolution) => left.includes(resolution));
      const rightPreferred = resolutionPriority.findIndex((resolution) => right.includes(resolution));
      const leftRank = leftPreferred < 0 ? resolutionPriority.length : leftPreferred;
      const rightRank = rightPreferred < 0 ? resolutionPriority.length : rightPreferred;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftSize = Number(left.match(/\d+/)?.[0] || 0);
      const rightSize = Number(right.match(/\d+/)?.[0] || 0);
      return rightSize - leftSize;
    });
    for (const key of keys) {
      const variant = variants[key];
      if (typeof variant === 'string' && variant) return variant;
      const object = this.object(variant);
      const url = this.optionalText(object.high ?? object.low ?? object.url ?? object.src);
      if (url) return url;
    }
    return null;
  }

  private safeError(error: unknown) {
    if (error instanceof BadRequestException || error instanceof BadGatewayException) {
      const response = error.getResponse();
      if (typeof response === 'string') return response;
      const message = this.object(response).message;
      if (typeof message === 'string') return message;
    }
    return 'Review synchronization failed';
  }

  private async requestPage(token: string, page: number, size: number, filter: ReviewFilter) {
    const url = new URL(this.reviewsUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', String(size));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const normalizedToken = token.replace(/^Bearer\s+/i, '').trim();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${normalizedToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filter }),
        signal: controller.signal,
      });
      if (response.status === 401) throw new BadRequestException('Сессия кабинета Uzum истекла. Обновите Bearer token в Настройки → Отзывы Uzum');
      if (!response.ok) throw new BadGatewayException(`Uzum internal reviews API: HTTP ${response.status}`);
      const body = await response.json().catch(() => null);
      if (!body || !Array.isArray(body.payload)) {
        throw new BadGatewayException('Uzum internal reviews API returned an invalid payload');
      }
      return body.payload as Array<Record<string, any>>;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new BadGatewayException('Uzum internal reviews API timed out');
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException('Uzum internal reviews API request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  @Cron(process.env.REVIEW_SYNC_CRON || '*/10 * * * *')
  async scheduledSync() {
    const configured = await this.integrations.getPlain(IntegrationType.UZUM_INTERNAL).catch(() => null);
    if (!configured?.token || this.syncInProgress) return;
    // Токен внутреннего API — это сессия браузера, она протухает. Пока интеграция
    // в ошибке, ломиться каждые 10 минут бессмысленно: это только забивает лог и
    // ест такты. Пробуем раз в час — этого хватит, чтобы синхронизация сама
    // ожила, как только в настройках появится свежий токен.
    if (configured.row.status === 'ERROR' && Date.now() - configured.row.updatedAt.getTime() < 55 * 60_000) return;
    try {
      await this.sync('ALL');
    } catch (error) {
      this.logger.error(`Scheduled review sync failed: ${this.safeError(error)}`);
    }
  }

  async sync(filterInput: unknown = 'ALL') {
    if (this.syncInProgress) return { accepted: false, alreadyRunning: true };
    this.syncInProgress = true;
    let runId: string | null = null;
    try {
      const filter = this.normalizeFilter(filterInput);
      const configured = await this.integrations.getPlain(IntegrationType.UZUM_INTERNAL);
      if (!configured?.token) {
        throw new BadRequestException('Внутренний токен Uzum для отзывов не настроен');
      }
      const configuredShopId = this.text(configured.metadata?.shopId);
      if (!configuredShopId) throw new BadRequestException('Для внутреннего API Uzum не настроен Shop ID');
      const shop = await this.prisma.shop.findUnique({ where: { externalId: configuredShopId } });
      if (!shop) throw new BadRequestException(`Магазин ${configuredShopId} не найден`);

      const run = await this.prisma.syncRun.create({
        data: { shopId: shop.id, type: 'REVIEWS', status: 'RUNNING' },
      });
      runId = run.id;

      const products = await this.prisma.product.findMany({
        where: { shopId: shop.id },
        select: { id: true, externalId: true },
      });
      const productsByExternalId = new Map(products.map((product) => [product.externalId, product.id]));
      const pageSize = Math.min(100, Math.max(1, this.integer(process.env.REVIEW_SYNC_PAGE_SIZE, 100)));
      const maxPages = Math.min(1000, Math.max(1, this.integer(process.env.REVIEW_SYNC_MAX_PAGES, 100)));
      const seen = new Set<string>();
      let received = 0;
      let saved = 0;
      let skippedInvalid = 0;
      let skippedOtherShop = 0;
      let pages = 0;

      for (let page = 0; page < maxPages; page++) {
        const rows = await this.requestPage(configured.token, page, pageSize, filter);
        pages++;
        if (!rows.length) break;
        let newIdsOnPage = 0;
        for (const item of rows) {
          const externalId = this.text(item.reviewId);
          if (!externalId || seen.has(externalId)) continue;
          seen.add(externalId);
          newIdsOnPage++;
          received++;

          const sourceShop = this.object(item.shop);
          const sourceShopId = this.text(sourceShop.id);
          if (sourceShopId && sourceShopId !== configuredShopId) {
            skippedOtherShop++;
            continue;
          }
          const dateCreated = this.date(item.dateCreated);
          if (!dateCreated) {
            skippedInvalid++;
            continue;
          }

          const product = this.object(item.product);
          const externalProductId = this.text(product.productId) || null;
          const productId = externalProductId ? productsByExternalId.get(externalProductId) || null : null;
          const anonymous = this.boolean(item.anonymous);
          const replyStatus = this.optionalText(item.replyStatus);
          const data = {
            productId,
            externalProductId,
            productTitle: this.text(product.productTitle) || 'Без названия',
            skuTitle: this.optionalText(product.skuTitle),
            productPhotoUrl: this.firstPhoto(product),
            rating: Math.min(5, Math.max(0, this.integer(item.rating))),
            packagingQualityRating: this.optionalRating(item.packagingQualityRating),
            deliveryRating: this.optionalRating(item.deliveryRating),
            content: this.optionalText(item.content),
            pros: this.optionalText(item.pros),
            cons: this.optionalText(item.cons),
            photos: this.json(item.photos),
            customerName: anonymous ? null : this.optionalText(item.customerName),
            anonymous,
            replyStatus,
            needsReply: this.needsReply(replyStatus, filter),
            dateCreated,
            dateBought: this.date(item.dateBought),
            characteristics: this.json(item.characteristics),
            isRead: this.boolean(item.read),
            pinned: this.boolean(item.pinned),
            syncedAt: new Date(),
          };
          await this.prisma.review.upsert({
            where: { shopId_externalId: { shopId: shop.id, externalId } },
            update: data,
            create: { shopId: shop.id, externalId, ...data },
          });
          saved++;
        }
        if (!newIdsOnPage || rows.length < pageSize) break;
      }

      const result = { accepted: true, alreadyRunning: false, filter, pages, received, saved, skippedInvalid, skippedOtherShop };
      await this.prisma.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCESS',
          records: saved,
          finishedAt: new Date(),
          message: `Отзывы: ${saved}, страниц: ${pages}, пропущено: ${skippedInvalid + skippedOtherShop}`,
        },
      });
      await this.prisma.integrationCredential.updateMany({
        where: { type: IntegrationType.UZUM_INTERNAL },
        data: { status: IntegrationStatus.CONNECTED, lastTestedAt: new Date(), lastError: null },
      });
      return result;
    } catch (error) {
      const message = this.safeError(error);
      if (runId) {
        await this.prisma.syncRun.update({
          where: { id: runId },
          data: { status: 'ERROR', finishedAt: new Date(), message },
        }).catch(() => undefined);
      }
      await this.prisma.integrationCredential.updateMany({
        where: { type: IntegrationType.UZUM_INTERNAL },
        data: { status: IntegrationStatus.ERROR, lastTestedAt: new Date(), lastError: message },
      }).catch(() => undefined);
      if (error instanceof BadRequestException || error instanceof BadGatewayException) throw error;
      throw new BadGatewayException(message);
    } finally {
      this.syncInProgress = false;
    }
  }

  async feed(query: { page?: string; size?: string; filter?: string; rating?: string; search?: string }) {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return { empty: true, items: [] };
    const page = Math.max(1, this.integer(query.page, 1));
    const size = Math.min(100, Math.max(1, this.integer(query.size, 30)));
    const filter = this.normalizeFilter(query.filter);
    const rating = this.integer(query.rating, 0);
    const search = this.text(query.search);
    const where: Prisma.ReviewWhereInput = {
      shopId: shop.id,
      ...(filter === 'NO_REPLY' ? { needsReply: true } : {}),
      ...(rating >= 1 && rating <= 5 ? { rating } : {}),
      ...(search ? {
        OR: [
          { productTitle: { contains: search, mode: 'insensitive' } },
          { skuTitle: { contains: search, mode: 'insensitive' } },
          { content: { contains: search, mode: 'insensitive' } },
          { pros: { contains: search, mode: 'insensitive' } },
          { cons: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const [items, total, aggregate, negative, unanswered, lastSynced] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: [{ pinned: 'desc' }, { dateCreated: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.aggregate({ where, _avg: { rating: true } }),
      this.prisma.review.count({ where: { ...where, rating: { lte: 3 } } }),
      this.prisma.review.count({ where: { ...where, needsReply: true } }),
      this.prisma.review.findFirst({ where: { shopId: shop.id }, orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } }),
    ]);
    return {
      shop: { id: shop.id, externalId: shop.externalId, name: shop.name },
      capability: { reviewTexts: true, aiDrafts: true, sellerReplies: false, readOnly: true, source: 'Uzum internal product-reviews API' },
      summary: { total, averageRating: aggregate._avg.rating, negative, unanswered },
      pagination: { page, size, total, pages: Math.ceil(total / size) },
      filter,
      lastSyncedAt: lastSynced?.syncedAt || null,
      items,
    };
  }

  async overview(search = '') {
    const shop = await this.prisma.shop.findFirst({ where: { isActive: true } });
    if (!shop) return { empty: true };
    const [products, storedReviews, internalIntegration] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          shopId: shop.id,
          ...(search ? { title: { contains: search, mode: 'insensitive' as const } } : {}),
        },
        include: { skus: { select: { sellerSku: true, stock: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.review.count({ where: { shopId: shop.id } }),
      this.prisma.integrationCredential.findUnique({ where: { type: IntegrationType.UZUM_INTERNAL } }),
    ]);
    const items = products.map((product) => {
      const raw = this.object(product.raw);
      const rating = this.number(raw.rating ?? raw.productRating ?? raw.averageRating);
      const feedbacks = Math.max(0, Math.round(this.number(raw.feedbackQuantity ?? raw.feedbacksQuantity ?? raw.reviewsQuantity ?? raw.feedbackCount)));
      return {
        id: product.id,
        externalId: product.externalId,
        title: product.title,
        imageUrl: product.imageUrl,
        status: product.status,
        rating,
        feedbacks,
        viewers: Math.max(0, Math.round(this.number(raw.viewers ?? raw.viewersQuantity ?? raw.views))),
        conversion: this.number(raw.conversion ?? raw.conversionRate),
        stock: product.skus.reduce((sum, sku) => sum + sku.stock, 0),
        sellerSkus: product.skus.map((sku) => sku.sellerSku).filter(Boolean),
        updatedAt: product.updatedAt,
      };
    }).sort((a, b) => b.feedbacks - a.feedbacks || b.rating - a.rating);
    const rated = items.filter((item) => item.feedbacks > 0 && item.rating > 0);
    const totalFeedbacks = rated.reduce((sum, item) => sum + item.feedbacks, 0);
    const weightedRating = totalFeedbacks
      ? rated.reduce((sum, item) => sum + item.rating * item.feedbacks, 0) / totalFeedbacks
      : null;
    const internalConfigured = Boolean(internalIntegration?.enabled && internalIntegration.encryptedValue);
    return {
      shop: { id: shop.id, externalId: shop.externalId, name: shop.name },
      summary: {
        products: items.length,
        productsWithFeedbacks: rated.length,
        totalFeedbacks,
        averageRating: weightedRating,
        lowRatedProducts: rated.filter((item) => item.rating < 4.5).length,
        fiveStarProducts: rated.filter((item) => item.rating >= 4.95).length,
        storedReviews,
      },
      capability: {
        aggregates: true,
        reviewTexts: internalConfigured,
        sellerReplies: false,
        readOnly: true,
        source: internalConfigured
          ? 'Uzum internal product-reviews API + Seller OpenAPI product aggregates'
          : 'Uzum Seller OpenAPI /v1/product/shop/{shopId}',
        message: internalConfigured
          ? 'Тексты отзывов синхронизируются в режиме только для чтения.'
          : 'Настройте отдельный внутренний токен Uzum, чтобы загрузить тексты отзывов.',
      },
      items,
    };
  }
}
