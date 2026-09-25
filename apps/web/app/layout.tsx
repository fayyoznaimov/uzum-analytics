import type { Metadata } from 'next';
import './globals.css';
import './costs-ui.css';
import './reviews-ui.css';

export const metadata: Metadata = { title: 'Uzum Analytics', description: 'Аналитика магазина Uzum' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
