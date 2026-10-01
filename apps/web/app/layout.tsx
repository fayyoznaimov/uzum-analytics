import type { Metadata } from 'next';
import './globals.css';
import './costs-ui.css';
import './reviews-ui.css';

export const metadata: Metadata = { title: 'Uzum Analytics', description: 'Аналитика магазина Uzum' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><head><link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700;800&display=swap"/></head><body>{children}</body></html>;
}
