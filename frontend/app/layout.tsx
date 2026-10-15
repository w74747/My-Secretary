import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'لوحة إدارة المهام والمساعد الذكي',
  description: 'منصة متابعة المشاريع والمهام مع الربط المباشر بالواتساب والذكاء الاصطناعي',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body className="bg-background text-slate-800 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
