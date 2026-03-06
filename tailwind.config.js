/** @type {import('tailwindcss').Config} */
export default {
  content: ["./*.{html,tsx}", "./components/**/*.tsx"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
