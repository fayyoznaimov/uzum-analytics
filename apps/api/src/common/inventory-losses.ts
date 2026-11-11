/**
 * Расчёт потерь по SKU для FBO: сколько штук склад Uzum принял по накладным и где они сейчас.
 *
 * Владелец 10.11.2026 после видео Sellium: «да, делай». У Sellium одна колонка «неизвестно
 * (потеряно)», и их руководитель сам говорит, что считает её с ошибками и что «неизвестно ≠
 * потеряно»: товар после отказа ещё едет из ПВЗ на склад. Поэтому здесь:
 *  - каждая составляющая видна отдельно (принято, продано, в заказах, на складе, брак);
 *  - отмены и возвраты за последние RETURN_TRANSIT_DAYS дней считаются «возможно едут обратно»
 *    и в «не найдено» не попадают (верхняя оценка: часть отменённых и не уезжала со склада);
 *  - если продано и лежит больше, чем принято по накладным в базе, — это не «минус потери»,
 *    а нехватка истории поставок (или продажи со своего склада), такая строка помечается
 *    и в итог «не найдено» не входит;
 *  - сумма «не найдено» — по себестоимости и только там, где она известна.
 */

export const RETURN_TRANSIT_DAYS = 30;
/** «Проверить» — только когда не найдено хотя бы столько штук… */
export const LOSS_MIN_UNITS = 3;
/** …и хотя бы такая доля принятого: 1–2 штуки из сотни — обычный шум учёта. */
export const LOSS_MIN_SHARE = 0.1;

export type LossInput = {
  skuId: string;
  sellerSku: string;
  title: string;
  /** Принято складом Uzum по FBO-накладным (acceptedQuantity). */
  accepted: number;
  /** Выдано покупателям за вычетом возвратов после выдачи. */
  sold: number;
  /** В активных заказах: собраны, везутся или ждут в ПВЗ, ещё не выданы. */
  inOrders: number;
  /** Отменено или возвращено за последние RETURN_TRANSIT_DAYS дней — может ещё ехать на склад. */
  maybeReturning: number;
  /** В продаже на складе сейчас. */
  stock: number;
  /** Брак по кабинету Uzum; null — кабинет по этому SKU ещё не читали. */
  defective: number | null;
  /** Себестоимость единицы с логистикой до склада; null — не задана. */
  unitCost: number | null;
};

export type LossStatus = 'ok' | 'returning' | 'small' | 'check' | 'no-history';

export type LossRow = LossInput & {
  /** Принято − продано − в заказах − на складе − брак. */
  gap: number;
  /** Разница сверх «возможно едут обратно»: где товар, по данным не видно. */
  notFound: number;
  notFoundCost: number | null;
  status: LossStatus;
};

const units = (value: number) => (Number.isFinite(value) ? Math.round(value) : 0);

export function lossRow(input: LossInput): LossRow {
  const accepted = units(input.accepted);
  const gap = accepted - units(input.sold) - units(input.inOrders) - units(input.stock) - units(input.defective ?? 0);
  if (gap < 0) return { ...input, gap, notFound: 0, notFoundCost: null, status: 'no-history' };
  const notFound = Math.max(0, gap - Math.max(0, units(input.maybeReturning)));
  const status: LossStatus = gap === 0
    ? 'ok'
    : notFound === 0
      ? 'returning'
      : notFound >= LOSS_MIN_UNITS && notFound >= accepted * LOSS_MIN_SHARE ? 'check' : 'small';
  return { ...input, gap, notFound, notFoundCost: input.unitCost === null ? null : notFound * input.unitCost, status };
}

/**
 * Один и тот же товар Uzum иногда ведёт под двумя SKU: J471 «КРЕМОВ-лицевой» заменили на «КРЕМОВ-лицево»,
 * старые накладные и заказы остались на старом id. Без склейки сверка 10.11.2026 показала у новых SKU
 * «не найдено», а у старых — «нет истории поставок». Нормализация та же, что при сверке финотчёта.
 */
export function lossSkuKey(sellerSku: string): string {
  return String(sellerSku ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/лицевой/gu, 'лицево')
    .replace(/банный/gu, 'банны')
    .replace(/[×х]/gu, 'x')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Склеивает SKU с одинаковым нормализованным артикулом; mergedSkus — сколько SKU Uzum вошло в строку. */
export function mergeLossInputs(inputs: LossInput[]): Array<LossInput & { mergedSkus: number }> {
  const groups = new Map<string, LossInput & { mergedSkus: number }>();
  for (const input of inputs) {
    const key = lossSkuKey(input.sellerSku) || input.skuId;
    const current = groups.get(key);
    if (!current) { groups.set(key, { ...input, mergedSkus: 1 }); continue; }
    current.accepted += input.accepted;
    current.sold += input.sold;
    current.inOrders += input.inOrders;
    current.maybeReturning += input.maybeReturning;
    current.stock += input.stock;
    current.defective = current.defective === null && input.defective === null ? null : (current.defective ?? 0) + (input.defective ?? 0);
    current.unitCost = current.unitCost ?? input.unitCost;
    current.mergedSkus += 1;
  }
  return [...groups.values()];
}

const STATUS_ORDER: Record<LossStatus, number> = { check: 0, small: 1, returning: 2, 'no-history': 3, ok: 4 };

export function lossReport(inputs: LossInput[]) {
  const rows = inputs
    .filter((row) => row.accepted > 0 || row.sold > 0 || row.stock > 0 || row.inOrders > 0)
    .map(lossRow)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.notFound - a.notFound || b.gap - a.gap);
  const counted = rows.filter((row) => row.status !== 'no-history');
  const sum = (list: LossRow[], key: 'accepted' | 'sold' | 'inOrders' | 'maybeReturning' | 'stock' | 'notFound') => list.reduce((total, row) => total + units(row[key]), 0);
  const lost = counted.filter((row) => row.notFound > 0);
  return {
    rows,
    summary: {
      // Итоги только по SKU с полной историей: иначе нехватка истории одного SKU «съедает» потери другого.
      accepted: sum(counted, 'accepted'),
      sold: sum(counted, 'sold'),
      inOrders: sum(counted, 'inOrders'),
      maybeReturning: sum(counted, 'maybeReturning'),
      stock: sum(counted, 'stock'),
      defective: counted.reduce((total, row) => total + units(row.defective ?? 0), 0),
      notFound: sum(counted, 'notFound'),
      notFoundCost: lost.filter((row) => row.notFoundCost !== null).reduce((total, row) => total + (row.notFoundCost ?? 0), 0),
      notFoundUnitsWithoutCost: lost.filter((row) => row.notFoundCost === null).reduce((total, row) => total + row.notFound, 0),
      checkSkus: rows.filter((row) => row.status === 'check').length,
      noHistorySkus: rows.filter((row) => row.status === 'no-history').length,
      defectiveUnknownSkus: rows.filter((row) => row.defective === null).length,
    },
  };
}
