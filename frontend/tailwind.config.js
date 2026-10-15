/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#F8FAFC',
        surface: '#FFFFFF',
        accent: {
          purple: '#8B5CF6',
          teal: '#14B8A6',
          blue: '#38BDF8',
          emerald: '#10B981',
          rose: '#F43F5E',
        },
        muted: '#64748B',
        borderLight: '#F1F5F9',
      },
      boxShadow: {
        soft: '0 10px 25px -5px rgba(0, 0, 0, 0.04), 0 8px 10px -6px rgba(0, 0, 0, 0.02)',
        cardHover: '0 20px 30px -10px rgba(99, 102, 241, 0.08), 0 10px 10px -5px rgba(0, 0, 0, 0.02)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
};
