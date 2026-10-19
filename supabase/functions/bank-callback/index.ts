// Edge Function: bank-callback
// Called by the app right after Pekao redirects the user back with a ?code=
// in the URL. Exchanges that code for an Enable Banking session and stores
// the session id + account list in bank_sessions (never in the public
// anon-readable `arkad` table).

const APP_ID = "1460a61c-2f00-428e-b61f-314b4f2626ff";
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

// Newer Supabase projects no longer auto-populate SUPABASE_SERVICE_ROLE_KEY
// (deprecated) — the replacement is SUPABASE_SECRET_KEYS, a JSON object of
// secret keys. Support both so this keeps working either way.
function getServiceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  const dict = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (dict) {
    try {
      const parsed = JSON.parse(dict) as Record<string, string>;
      const vals = Object.values(parsed);
      if (vals.length > 0) return vals[0];
    } catch (_e) {
      // fall through to the error below
    }
  }
  throw new Error("no SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEYS available");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const { code } = await req.json();
    if (!code) throw new Error("missing code");

    const pem = Deno.env.get("ENABLE_BANKING_KEY");
    if (!pem) throw new Error("ENABLE_BANKING_KEY secret is not set");
    const key = await importPrivateKey(pem);
    const jwt = await signJWT(key);

    const sessRes = await fetch("https://api.enablebanking.com/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!sessRes.ok) throw new Error("session exchange failed: " + (await sessRes.text()));
    const session = await sessRes.json();

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = getServiceKey();
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/bank_sessions?id=eq.main`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY!,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        session_id: session.session_id,
        accounts: session.accounts,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!upsertRes.ok) throw new Error("storing session failed: " + (await upsertRes.text()));

    return new Response(JSON.stringify({ ok: true, accounts: session.accounts }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bank-callback error:", e);
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
