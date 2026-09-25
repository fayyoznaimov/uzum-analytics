export type FboSupplySourceItem = { sku: string; quantity: number };
export type SupplyProductType = 'сауна' | 'лицевой' | 'банный' | 'комплект';
type ProductKey = 'HAVANA' | 'J475' | 'J403' | 'J471';

type ColorConfig = { name: string; aliases: readonly string[] };
type ProductConfigEntry = {
  design: string;
  colors: Record<number, ColorConfig>;
  colorOrder: readonly number[];
  typeOrder: readonly SupplyProductType[];
  /** Цвет в списке — код (239…), а не слово. */
  numericColorLabels: boolean;
};

/**
 * Havana и J475 — один и тот же физический товар (крой, размерная сетка,
 * коды цветов 239–244 один в один), но на Uzum заведены как ДВЕ РАЗНЫЕ
 * карточки. В тексте SKU это НЕ отличить по префиксу — обе пишутся
 * HAVANA-…/HAVANASAUNA-…. Отличает только само слово цвета:
 *   J475:   ХРОМ · ПРИГХАК · ШОКОЛ · МОЛОЧ · КРЕМОВ · ПРОЗР
 *   Havana: СЕРЫЙ · ЗЕЛХАКИ · СВЕТКОР · БЕЖЕВ · ПАСТКОР · БЕЛЫЙ
 * Поэтому для этой пары цвет определяет сам товар — см. detectHavanaFamily.
 * Раньше J475 был просто алиасом Havana (одна корзина на двоих), и поставка,
 * где встречались оба, схлопывалась в одну строку — склад не понимал, сколько
 * взять с какой стойки. Это и была реальная жалоба.
 */
const HAVANA_CODE_NAMES: Record<number, string> = {
  239: 'Серый', 240: 'Зелёный хаки', 241: 'Светло-коричневый',
  242: 'Бежевый', 243: 'Пастельно-коралловый', 244: 'Белый',
};
const HAVANA_COLOR_ORDER = [240, 241, 239, 242, 244, 243] as const;
const HAVANA_TYPE_ORDER: SupplyProductType[] = ['сауна', 'лицевой', 'банный', 'комплект'];

function havanaColors(aliasByCode: Record<number, string>): Record<number, ColorConfig> {
  const colors: Record<number, ColorConfig> = {};
  for (const code of HAVANA_COLOR_ORDER) colors[code] = { name: HAVANA_CODE_NAMES[code], aliases: [aliasByCode[code]] };
  return colors;
}

export const PRODUCT_CONFIG: Record<ProductKey, ProductConfigEntry> = {
  HAVANA: {
    design: 'Havana',
    colors: havanaColors({ 239: 'СЕРЫЙ', 240: 'ЗЕЛХАКИ', 241: 'СВЕТКОР', 242: 'БЕЖЕВ', 243: 'ПАСТКОР', 244: 'БЕЛЫЙ' }),
    colorOrder: HAVANA_COLOR_ORDER, typeOrder: HAVANA_TYPE_ORDER, numericColorLabels: true,
  },
  J475: {
    design: 'J475',
    colors: havanaColors({ 239: 'ХРОМ', 240: 'ПРИГХАК', 241: 'ШОКОЛ', 242: 'МОЛОЧ', 243: 'КРЕМОВ', 244: 'ПРОЗР' }),
    colorOrder: HAVANA_COLOR_ORDER, typeOrder: HAVANA_TYPE_ORDER, numericColorLabels: true,
  },
  J403: {
    design: 'J403', numericColorLabels: false,
    colors: {
      1: { name: 'Розовый', aliases: ['РОЗОВ'] },
      2: { name: 'Серый', aliases: ['СЕРЫЙ'] },
      3: { name: 'Белый', aliases: ['БЕЛЫЙ'] },
      4: { name: 'Бежевый', aliases: ['БЕЖЕВ'] },
    },
    colorOrder: [1, 2, 3, 4],
    typeOrder: ['сауна', 'лицевой', 'банный', 'комплект'],
  },
  J471: {
    design: 'J471', numericColorLabels: false,
    colors: {
      1: { name: 'Розовый', aliases: ['РОЗОВ'] },
      2: { name: 'Небесно-голубой', aliases: ['НГОЛУБ'] },
      3: { name: 'Кремовый', aliases: ['КРЕМОВ'] },
      4: { name: 'Сиреневый', aliases: ['СИРЕН'] },
      5: { name: 'Серый', aliases: ['СЕРЫЙ'] },
      6: { name: 'Мятный', aliases: ['МЯТН'] },
    },
    colorOrder: [1, 2, 3, 4, 5, 6],
    typeOrder: ['банный', 'лицевой', 'сауна', 'комплект'],
  },
};

export function normalizeSku(value: string) {
  return String(value || '').trim().toUpperCase().replace(/×/g, 'X').replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-').replace(/\s*X\s*/g, 'X').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
}

function detectType(product: ProductKey, sku: string): SupplyProductType | null {
  const config = PRODUCT_CONFIG[product];
  if (config.numericColorLabels) {
    // Компаунд HAVANASAUNA (старый формат) плюс отдельное слово «САУНА» и
    // размер 100x150 (как уже размечены сауны у J403/J471).
    if (sku.includes('HAVANASAUNA') || /(?:^|[-\s])САУНА(?:$|[-\s])/.test(sku) || /100X150/.test(sku)) return 'сауна';
    if (/50X90\/70X140/.test(sku) || /(?:^|[- ])(?:MIX|МИКС|КОМПЛЕКТ)(?:$|[- ])/.test(sku)) return 'комплект';
    if (/50X90/.test(sku)) return 'лицевой';
    if (/70X140/.test(sku)) return 'банный';
    // Сюда попадают только уже подтверждённые Havana/J475 (эту функцию для
    // них вызывают, только когда цвет уже опознан) — без явного размера
    // это безразмерный маркетинговый SKU, то есть комплект.
    return 'комплект';
  }
  if (/(?:^|-)(?:МИКС|MIX|КОМПЛЕКТ)(?:$|-)/.test(sku)) return 'комплект';
  if (/(?:^|-)(?:БАННЫЙ|БАННЫ|БАННЫЙ)(?:$|-)/.test(sku)) return 'банный';
  if (/(?:^|-)(?:ЛИЦЕВОЙ|ЛИЦЕВО)(?:$|-)/.test(sku)) return 'лицевой';
  if (/(?:^|-)САУНА(?:$|-)/.test(sku)) return 'сауна';
  return null;
}

function detectColor(product: 'J403' | 'J471', sku: string) {
  const config = PRODUCT_CONFIG[product];
  for (const code of config.colorOrder) {
    const color = config.colors[code];
    if (color.aliases.some((alias) => sku.includes(alias))) return { colorCode: code, color: color.name };
  }
  return null;
}

/** Определяет Havana или J475 и цвет одновременно — см. комментарий у PRODUCT_CONFIG. */
function detectHavanaFamily(sku: string): { product: 'HAVANA' | 'J475'; colorCode: number; color: string } | null {
  if (!sku.includes('HAVANA')) return null; // покрывает и HAVANA-…, и HAVANASAUNA-…
  for (const code of HAVANA_COLOR_ORDER) {
    const alias = PRODUCT_CONFIG.J475.colors[code].aliases[0];
    if (sku.includes(alias)) return { product: 'J475', colorCode: code, color: PRODUCT_CONFIG.J475.colors[code].name };
  }
  for (const code of HAVANA_COLOR_ORDER) {
    const alias = PRODUCT_CONFIG.HAVANA.colors[code].aliases[0];
    if (sku.includes(alias)) return { product: 'HAVANA', colorCode: code, color: PRODUCT_CONFIG.HAVANA.colors[code].name };
  }
  // Числовой код без словесного алиаса (03240, 240 …) — по нему не отличить
  // J475 от Havana. Оставляем Havana по умолчанию: так исторически размечены
  // документы, где встречается голый код без слова.
  for (const token of sku.match(/\d+/g) || []) {
    const normalized = token.length > 3 ? token.slice(-3) : token.replace(/^0+/, '') || '0';
    const code = Number(normalized);
    if (PRODUCT_CONFIG.HAVANA.colors[code]) return { product: 'HAVANA', colorCode: code, color: PRODUCT_CONFIG.HAVANA.colors[code].name };
  }
  return null;
}

export function recognizeSupplySku(value: string) {
  const sku = normalizeSku(value);
  if (sku.includes('J403')) {
    const color = detectColor('J403', sku);
    const type = detectType('J403', sku);
    if (!color || !type) return null;
    return { product: 'J403' as const, design: PRODUCT_CONFIG.J403.design, type, ...color };
  }
  if (sku.includes('J471')) {
    const color = detectColor('J471', sku);
    const type = detectType('J471', sku);
    if (!color || !type) return null;
    return { product: 'J471' as const, design: PRODUCT_CONFIG.J471.design, type, ...color };
  }
  const havana = detectHavanaFamily(sku);
  if (!havana) return null;
  const type = detectType(havana.product, sku);
  if (!type) return null;
  return { product: havana.product, design: PRODUCT_CONFIG[havana.product].design, type, colorCode: havana.colorCode, color: havana.color };
}

export const recognizeHavanaSku = (value: string) => {
  const parsed = recognizeSupplySku(value);
  if (!parsed || parsed.product !== 'HAVANA') return null;
  const { product: _product, ...result } = parsed;
  return result;
};

export function buildFboSupplySummary(supplyNumber: string | number, sourceItems: FboSupplySourceItem[]) {
  const buckets = new Map<string, ReturnType<typeof recognizeSupplySku> & { quantity: number }>();
  const unrecognizedItems: FboSupplySourceItem[] = [];
  let sourceTotal = 0;
  for (const item of sourceItems) {
    const quantity = Math.max(0, Math.round(Number(item.quantity) || 0));
    sourceTotal += quantity;
    const parsed = recognizeSupplySku(item.sku);
    if (!parsed) { unrecognizedItems.push({ sku: item.sku, quantity }); continue; }
    // product обязательно входит в ключ — иначе Havana и J475 одного цвета и
    // типа снова схлопнутся в одну корзину, ровно та ошибка, которую чиним.
    const key = `${parsed.product}|${parsed.type}|${parsed.colorCode}`;
    const current = buckets.get(key) || { ...parsed, quantity: 0 };
    current.quantity += quantity;
    buckets.set(key, current);
  }
  const groups = (Object.keys(PRODUCT_CONFIG) as ProductKey[]).flatMap((product) => {
    const config = PRODUCT_CONFIG[product];
    return config.typeOrder.map((type) => {
      const items = [...buckets.values()].filter((item) => item?.product === product && item.type === type)
        .sort((a, b) => config.colorOrder.indexOf(a!.colorCode as never) - config.colorOrder.indexOf(b!.colorCode as never))
        .map((item) => ({ colorCode: item!.colorCode, color: item!.color, quantity: item!.quantity }));
      return { design: config.design, numericColorLabels: config.numericColorLabels, type, items, total: items.reduce((sum, item) => sum + item.quantity, 0) };
    }).filter((group) => group.items.length);
  });
  const parsedTotal = groups.reduce((sum, group) => sum + group.total, 0);
  const isValid = unrecognizedItems.length === 0 && sourceTotal === parsedTotal;
  const sectionTitle = (design: string, type: SupplyProductType) => {
    if (design === 'Havana' && type === 'сауна') return 'Havana sauna';
    if (design === 'Havana' && type === 'банный') return 'Хавана банный';
    if (design === 'J475' && type === 'сауна') return 'J475 sauna';
    if (design === 'J475' && type === 'банный') return 'J475 банный';
    return `${design} ${type}`;
  };
  const sections = groups.map((group) => [
    sectionTitle(group.design, group.type),
    ...group.items.map((item) => `${group.numericColorLabels ? item.colorCode : item.color} - ${item.quantity} та`),
    `общий ${group.total} та`,
  ].join('\n'));
  const legend = ['Зелёный хаки - 240', 'Светло-коричневый - 241', 'Серый - 239', 'Бежевый - 242', 'Белый - 244', 'Пастельно-коралловый - 243'].join('\n');
  const warning = unrecognizedItems.length ? `\n\n⚠️ Не распознано: ${unrecognizedItems.map((item) => `${item.sku} — ${item.quantity} та`).join('; ')}` : '';
  const formattedText = [...sections, `**Общий: ${parsedTotal} та**`, `**Поставка №${supplyNumber}**`, legend].join('\n\n') + warning;
  return { supplyNumber: Number(supplyNumber) || String(supplyNumber), groups, sourceTotal, parsedTotal, isValid, unrecognizedItems, formattedText };
}
