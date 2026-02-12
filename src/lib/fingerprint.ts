import FingerprintJS from "@fingerprintjs/fingerprintjs";

let cachedFingerprint: string | null = null;
let loadingPromise: Promise<string> | null = null;

export async function getFingerprint(): Promise<string> {
  // Return cached value if available
  if (cachedFingerprint) return cachedFingerprint;

  // If already loading, return the existing promise
  if (loadingPromise) return loadingPromise;

  // Start loading
  loadingPromise = (async () => {
    try {
      const fp = await FingerprintJS.load();
      const result = await fp.get();
      cachedFingerprint = result.visitorId;
      return cachedFingerprint;
    } catch {
      // Fallback: generate a random ID if fingerprinting fails
      cachedFingerprint = `fallback-${crypto.randomUUID()}`;
      return cachedFingerprint;
    }
  })();

  return loadingPromise;
}
