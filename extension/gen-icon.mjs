import sharp from "sharp";
// Simple mark: brand-blue rounded square with a "C" cut, generated locally so
// the repo carries no binary blob of unknown provenance.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <rect width="512" height="512" rx="112" fill="#0a66c2"/>
  <path d="M352 170a128 128 0 1 0 0 172" fill="none" stroke="#fff"
        stroke-width="54" stroke-linecap="round"/>
  <circle cx="368" cy="256" r="34" fill="#fff"/>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile("./assets/icon.png");
console.log("icon written");
