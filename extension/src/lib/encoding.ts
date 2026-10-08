/** Chrome's messaging channel cannot carry binary, so blobs cross as base64. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked to stay clear of the argument-count limit on String.fromCharCode,
  // which a multi-megabyte PDF would otherwise blow past.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
