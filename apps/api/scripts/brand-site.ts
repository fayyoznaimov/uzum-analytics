/**
 * Страница бренда Parisa Home для ИИ-ассистентов и поисковиков.
 *
 * Uzum закрывает карточки капчей от роботов, поэтому ChatGPT, Perplexity и
 * поисковики не видят товары магазина и не могут их рекомендовать. Эта
 * статическая страница — открытая «витрина» с фактами (плотность, состав,
 * размеры, рейтинг, цены) и разметкой Schema.org, со ссылками «купить на
 * Uzum». Данные берутся из базы, перезапуск обновляет цены и рейтинги.
 *
 *   npx tsx --env-file=../../.env --tsconfig tsconfig.json scripts/brand-site.ts [--out ../../site/parisahome]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaService } from '../src/common/prisma.service';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
const OUT = resolve(arg('out') ?? join(__dirname, '../../../site/parisahome'));
/** Цены ниже — служебные SKU (себестоимость-заглушка), на витрину не идут. */
const MIN_SHOWN_PRICE = 10_000;

type Facts = { ru: string; uz: string; bullets: string[]; uzBullets: string[] };

// Только проверяемые факты из карточек Uzum: плотность и состав указаны в названиях товаров.
const FACTS: Record<string, Facts> = {
  '2197711': {
    ru: 'Махровые полотенца HAVANA — плотные и мягкие, хорошо впитывают воду: для лица, тела и бани.',
    uz: 'HAVANA sochiqlari — qalin va yumshoq, suvni yaxshi shimadi: yuz, tana va hammom uchun.',
    bullets: ['Плотность 600 г/м²', 'Размеры 50×90 и 70×140 см, наборы', 'Много цветов'],
    uzBullets: ['Zichligi 600 g/m²', 'O‘lchamlari 50×90 va 70×140 sm, to‘plamlar', 'Ko‘p ranglar'],
  },
  '2263224': {
    ru: 'Большое полотенце для сауны и бани 100×150 см из хлопка.',
    uz: 'Sauna va hammom uchun katta paxta sochiq, 100×150 sm.',
    bullets: ['Размер 100×150 см', 'Плотность 600 г/м²', 'Хлопок'],
    uzBullets: ['O‘lchami 100×150 sm', 'Zichligi 600 g/m²', 'Paxta'],
  },
  '2872482': {
    ru: 'Набор махровых полотенец J403 из 100% хлопка для ванной, душа, тела и лица, в zip-упаковке.',
    uz: 'J403 paxta sochiqlar to‘plami: hammom, dush, tana va yuz uchun, zip-qadoqda.',
    bullets: ['100% хлопок', 'Лицевое, банное, для сауны, микс', 'Zip-упаковка — удобно в подарок'],
    uzBullets: ['100% paxta', 'Yuz, hammom, sauna uchun, aralash', 'Zip-qadoq — sovg‘a uchun qulay'],
  },
  '2898275': {
    ru: 'Набор мягких полотенец J471 из 100% хлопка для лица и тела, в zip-упаковке.',
    uz: 'J471 yumshoq sochiqlar to‘plami, 100% paxta, yuz va tana uchun, zip-qadoqda.',
    bullets: ['100% хлопок', 'Лицевое, банное, для сауны, микс', 'Zip-упаковка'],
    uzBullets: ['100% paxta', 'Yuz, hammom, sauna uchun, aralash', 'Zip-qadoq'],
  },
  '2880108': {
    ru: 'Хлопковый плед Parisa Home 100×170 см для дома, дачи, пикника и отдыха.',
    uz: 'Parisa Home paxtali pledi 100×170 sm: uy, dala hovli, piknik va dam olish uchun.',
    bullets: ['Размер 100×170 см', 'Плотность 420 г/м²', 'Хлопок'],
    uzBullets: ['O‘lchami 100×170 sm', 'Zichligi 420 g/m²', 'Paxta'],
  },
};

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sum = (value: number) => Math.round(value).toLocaleString('ru-RU').replace(/ /g, ' ');

async function main() {
  const prisma = new PrismaService();
  try {
    const products = await prisma.product.findMany({
      select: { externalId: true, title: true, raw: true, skus: { select: { price: true } } },
    });
    const cards = products
      .filter((product) => FACTS[product.externalId])
      .map((product) => {
        const raw = (product.raw ?? {}) as any;
        const image = (JSON.stringify(raw).match(/https:\/\/images\.uzum\.uz\/[a-z0-9]+\/t_product_540_high\.jpg/) ?? [])[0] ?? null;
        const prices = product.skus.map((sku) => Number(sku.price)).filter((price) => Number.isFinite(price) && price >= MIN_SHOWN_PRICE).sort((a, b) => a - b);
        const rating = Number(raw.rating);
        return { id: product.externalId, title: product.title, image, low: prices[0] ?? null, high: prices[prices.length - 1] ?? null, rating: Number.isFinite(rating) && rating > 0 ? rating : null, facts: FACTS[product.externalId], url: `https://uzum.uz/ru/product/${product.externalId}` };
      });

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', name: 'Parisa Home', description: 'Узбекский производитель домашнего текстиля: махровые полотенца и пледы из хлопка.', areaServed: 'UZ' },
        ...cards.map((card) => ({
          '@type': 'Product',
          name: card.title,
          brand: { '@type': 'Brand', name: 'Parisa Home' },
          description: `${card.facts.ru} ${card.facts.bullets.join('; ')}.`,
          ...(card.image ? { image: card.image } : {}),
          ...(card.rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: card.rating, bestRating: 5 } } : {}),
          ...(card.low ? { offers: { '@type': 'AggregateOffer', priceCurrency: 'UZS', lowPrice: card.low, highPrice: card.high, availability: 'https://schema.org/InStock', url: card.url } } : {}),
        })),
      ],
    };

    const cardHtml = cards.map((card) => `
    <article class="card">
      ${card.image ? `<img src="${card.image}" alt="${esc(card.facts.ru)}" loading="lazy" width="540" height="720">` : ''}
      <div class="body">
        <h2>${esc(card.facts.ru)}</h2>
        <p class="uz" lang="uz">${esc(card.facts.uz)}</p>
        <ul>${card.facts.bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join('')}</ul>
        <p class="meta">${card.rating ? `★ ${card.rating.toFixed(1)} на Uzum` : ''}${card.low ? ` · от ${sum(card.low)} сум` : ''}</p>
        <a class="buy" href="${card.url}" rel="noopener">Купить на Uzum · Uzumda xarid qilish</a>
      </div>
    </article>`).join('');

    const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parisa Home — махровые полотенца и пледы из хлопка | Paxta sochiqlar va pledlar</title>
<meta name="description" content="Parisa Home: махровые полотенца 600 г/м² из хлопка, наборы полотенец, полотенце для сауны 100×150, хлопковый плед 100×170. Покупка на Uzum с доставкой по Узбекистану.">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
:root{--ink:#17191F;--muted:#5d6270;--line:#E7E9EF;--accent:#6C47FF;--bg:#F4F5F8}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
header{background:#fff;border-bottom:1px solid var(--line);padding:28px 16px}
.wrap{max-width:1040px;margin:0 auto}h1{margin:0 0 6px;font-size:28px}header p{margin:0;color:var(--muted);line-height:1.5}
main{padding:24px 16px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.card img{width:100%;height:auto;aspect-ratio:3/4;object-fit:cover;background:#eee}
.body{padding:16px;display:flex;flex-direction:column;gap:8px;flex-grow:1}.body h2{margin:0;font-size:16px;line-height:1.35}
.uz{margin:0;color:var(--muted);font-size:14px}ul{margin:0;padding-left:18px;font-size:14px;line-height:1.6}
.meta{margin:0;font-size:13.5px;color:var(--muted)}.buy{margin-top:auto;display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;border-radius:10px;padding:11px}
section.about{margin-top:28px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;line-height:1.6}
footer{padding:24px 16px;color:var(--muted);font-size:13px;text-align:center}
</style>
</head>
<body>
<header><div class="wrap">
<h1>Parisa Home</h1>
<p>Махровые полотенца и пледы из хлопка. Плотность полотенец HAVANA — 600 г/м²: толстые, мягкие и хорошо впитывают воду. Продаём на маркетплейсе Uzum с доставкой по всему Узбекистану.</p>
<p lang="uz">Paxtadan tikilgan sochiqlar va pledlar. HAVANA sochiqlarining zichligi 600 g/m²: qalin, yumshoq va suvni yaxshi shimadi. Uzum orqali butun O‘zbekiston bo‘ylab yetkazib beriladi.</p>
</div></header>
<main class="wrap">
<div class="grid">${cardHtml}
</div>
<section class="about">
<h2>Как выбрать полотенце</h2>
<p>Плотность (г/м²) — главный показатель махрового полотенца: чем выше, тем оно толще, мягче и лучше впитывает. 400–450 г/м² — тонкие полотенца на каждый день, 500–600 г/м² — плотные «отельные». Для лица подходит размер 50×90 см, для тела — 70×140 см, для сауны и бани — 100×150 см.</p>
<p lang="uz">Zichlik (g/m²) — sochiqning asosiy ko‘rsatkichi: qancha yuqori bo‘lsa, shuncha qalin, yumshoq va yaxshi shimadi. Yuz uchun 50×90 sm, tana uchun 70×140 sm, sauna va hammom uchun 100×150 sm.</p>
</section>
</main>
<footer>Parisa Home · домашний текстиль · Узбекистан · обновлено ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', dateStyle: 'long' }).format(new Date())}</footer>
</body>
</html>
`;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'index.html'), html, 'utf8');
    writeFileSync(join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n', 'utf8');
    console.log(`Страница бренда: ${join(OUT, 'index.html')} (${cards.length} товаров)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(String(error?.message || error)); process.exit(1); });
