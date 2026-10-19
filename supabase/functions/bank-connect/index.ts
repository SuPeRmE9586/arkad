// Edge Function: bank-connect
// Called when the user taps "Підключити банк" in the app. Signs a request to
// Enable Banking, finds Bank Pekao in their Polish bank list, starts a PSD2
// authorization, and returns the link to send the user to (Pekao's own login
// page — this app never sees the bank password).

const APP_ID = "1460a61c-2f00-428e-b61f-314b4f2626ff";
const REDIRECT_URL = "https://superme9586.github.io/arkad/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

function b64url(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str: string): string {
  return b64url(new TextEncoder().encode(str));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signJWT(key: CryptoKey): Promise<string> {
  const header = { typ: "JWT", alg: "RS256", kid: APP_ID };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 };
  const data = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const pem = Deno.env.get("ENABLE_BANKING_KEY");
    if (!pem) throw new Error("ENABLE_BANKING_KEY secret is not set");
    const key = await importPrivateKey(pem);
    const jwt = await signJWT(key);

    const aspspsRes = await fetch("https://api.enablebanking.com/aspsps?country=PL", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!aspspsRes.ok) throw new Error("aspsps lookup failed: " + (await aspspsRes.text()));
    const aspspsJson = await aspspsRes.json();
    const aspsps = (aspspsJson.aspsps ?? aspspsJson) as Array<{ name: string; country: string }>;
    const pekao = aspsps.find((a) => a.name.toLowerCase().includes("pekao"));
    if (!pekao) {
      throw new Error(
        "Pekao not found among PL banks: " + aspsps.map((a) => a.name).join(", "),
      );
    }

    const validUntil = new Date(Date.now() + 89 * 86400000).toISOString();
    const authRes = await fetch("https://api.enablebanking.com/auth", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        access: { valid_until: validUntil },
        aspsp: { name: pekao.name, country: "PL" },
        state: "arkad",
        redirect_url: REDIRECT_URL,
        psu_type: "personal",
      }),
    });
    if (!authRes.ok) throw new Error("auth start failed: " + (await authRes.text()));
    const { url } = await authRes.json();

    return new Response(JSON.stringify({ url }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bank-connect error:", e);
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
