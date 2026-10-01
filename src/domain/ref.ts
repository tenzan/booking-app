const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ALPHABET_SIZE = ALPHABET.length; // 31

export function newRef(): string {
  // Generate 8 random characters (4 for each group after "R-")
  const chars: string[] = [];
  const bytes = new Uint8Array(16);

  while (chars.length < 8) {
    crypto.getRandomValues(bytes);

    for (let i = 0; i < 16 && chars.length < 8; i++) {
      const byte = bytes[i]!;
      // Reject sampling: reject bytes >= 248 to avoid modulo bias
      // 248 = 31 * 8, so this ensures uniform distribution
      if (byte < 248) {
        chars.push(ALPHABET[byte % ALPHABET_SIZE]!);
      }
    }
  }

  // Format: R-XXXX-XXXX
  return `R-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}
