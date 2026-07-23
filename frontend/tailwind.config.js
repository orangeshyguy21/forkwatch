/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        core: {
          bg: '#0a0a0b',
          line: '#e5e5e5',
          dim: '#8a8a8a',
          accent: '#f5f5f5',
        },
        knots: {
          bg: '#04140d',
          moss: '#065f46',
          emerald: '#059669',
          leaf: '#34d399',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        tear: {
          '0%': { transform: 'translateY(-8px) scale(0.98)', opacity: '0' },
          '100%': { transform: 'translateY(0) scale(1)', opacity: '1' },
        },
        pulseSlow: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        tear: 'tear 0.35s ease-out both',
        'pulse-slow': 'pulseSlow 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
