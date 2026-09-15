import type { Config } from 'tailwindcss';

/**
 * Tailwind tokens mirror the Nebula Design System palette so utility classes and
 * Nebula components share one visual language. Replace hex values with the
 * official Nebula token export when the package is available.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f3eefb', 100: '#e4d9f5', 200: '#c9b4ec', 300: '#a785de',
          400: '#8559cf', 500: '#6633bd', 600: '#5326a6', 700: '#440099',
          800: '#360079', 900: '#2a005e',
        },
        ink: { DEFAULT: '#151515', muted: '#4b4b4b', subtle: '#767676' },
        surface: { DEFAULT: '#ffffff', alt: '#f7f7f9', line: '#e1e1e6' },
        stage: {
          draft: '#6b7280', review: '#b45309', certified: '#047857',
          delivery: '#1d4ed8', released: '#440099', retired: '#9ca3af',
        },
      },
      fontFamily: { sans: ['"Open Sans"', 'system-ui', 'sans-serif'] },
      borderRadius: { nebula: '8px' },
    },
  },
  plugins: [],
} satisfies Config;
