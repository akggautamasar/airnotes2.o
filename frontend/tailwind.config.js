/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans:    ['"DM Sans"', 'system-ui', 'sans-serif'],
        display: ['"Syne"', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'monospace'],
        body:    ['"DM Sans"', 'sans-serif'],
      },
      colors: {
        ink: {
          50: '#f4f4f5', 100: '#e4e4e7', 200: '#d4d4d8',
          300: '#a1a1aa', 400: '#71717a', 500: '#52525b',
          600: '#3f3f46', 700: '#27272a', 800: '#1c1c1f',
          900: '#131315', 950: '#0c0c0d',
        },
        paper: { 50: '#fafafa', 100: '#f5f5f5' },
        accent: { DEFAULT: '#6366f1', hover: '#818cf8', muted: '#312e81' },
        teal:   { DEFAULT: '#14b8a6', hover: '#2dd4bf' },
      },
      animation: {
        'slide-up':   'slideUp 0.3s ease-out',
        'fade-in':    'fadeIn 0.2s ease-out',
        'spin-slow':  'spin 2s linear infinite',
      },
      keyframes: {
        slideUp: { from: { opacity: 0, transform: 'translateY(12px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        fadeIn:  { from: { opacity: 0 }, to: { opacity: 1 } },
      },
    },
  },
  plugins: [],
};
