/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef6ff",
          100: "#d9ebff",
          500: "#0a66c2", // LinkedIn blue, so injected UI reads as native
          600: "#084e94",
          700: "#063a6f",
        },
      },
    },
  },
  plugins: [],
};
