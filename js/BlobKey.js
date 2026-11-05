// What a picture's bytes are, as a short string: two pictures with the
// same bytes get the same key. Names a file on the computer
// (ProjectFormat) and lets frames holding the same picture share it once
// it's decoded (Frame.js).

// two 32-bit hashes of the bytes (cyrb53-style mixing), with different
// seeds, plus the length — crypto.subtle isn't there on a plain-http page
export function hashBytes(bytes) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
    h3 = Math.imul(h3 ^ c, 2246822507);
    h4 = Math.imul(h4 ^ c, 3266489909);
  }
  const fin = (a, b) => {
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    return (a >>> 0).toString(36).padStart(7, '0');
  };
  return fin(h1, h2) + fin(h2, h3) + fin(h3, h4) + fin(h4, h1) + bytes.length.toString(36);
}

const keys = new WeakMap(); // Blob -> key (blobs never change)

export async function blobKey(blob) {
  let key = keys.get(blob);
  if (!key) {
    key = hashBytes(new Uint8Array(await blob.arrayBuffer()));
    keys.set(blob, key);
  }
  return key;
}
