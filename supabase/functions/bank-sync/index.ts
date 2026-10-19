// Edge Function: bank-sync
// Pulls the live balance and new transactions for the connected Pekao
// account and stores them (balance on bank_sessions, new transactions as
// "pending" rows the app shows for category confirmation). Dedupes by the
// bank's own transaction id, so calling this repeatedly is safe.

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
      // fall through
    }
  }
  throw new Error("no SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEYS available");
}

// Berlin Group / PSD2 responses vary slightly between banks and aggregators —
// try the common field shapes rather than assuming one exact layout.
function pickAmount(obj: any): number | null {
  const cand = obj?.transaction_amount ?? obj?.amount ?? obj;
  const raw = cand?.amount ?? cand?.value;
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Berlin Group APIs send the amount unsigned and the direction in a
  // separate field — without this, every transaction looked like income.
  const indicator = (obj?.credit_debit_indicator ?? obj?.creditDebitIndicator ?? "").toString().toUpperCase();
  if (indicator === "DBIT") return -Math.abs(n);
  if (indicator === "CRDT") return Math.abs(n);
  return n;
}
function pickName(obj: any): string {
  return (
    obj?.creditor?.name ??
    obj?.debtor?.name ??
    obj?.remittance_information_unstructured ??
    obj?.remittance_information ??
    obj?.description ??
    "Транзакція"
  );
}
function pickDate(obj: any): string | null {
  return obj?.booking_date ?? obj?.value_date ?? obj?.date ?? null;
}
function pickTxId(obj: any, fallbackIdx: number): string {
  return obj?.entry_reference ?? obj?.transaction_id ?? obj?.id ?? `idx-${fallbackIdx}-${obj?.booking_date ?? ""}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = getServiceKey();

    const sessRowRes = await fetch(`${SUPABASE_URL}/rest/v1/bank_sessions?id=eq.main&select=session_id,accounts`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!sessRowRes.ok) throw new Error("reading bank_sessions failed: " + (await sessRowRes.text()));
    const rows = await sessRowRes.json();
    const row = rows[0];
    if (!row?.accounts?.length) throw new Error("no linked account yet — connect the bank first");
    const accountUid = row.accounts[0].uid ?? row.accounts[0].account_id ?? row.accounts[0].id;
    if (!accountUid) throw new Error("could not find an account uid in stored accounts: " + JSON.stringify(row.accounts));

    const pem = Deno.env.get("ENABLE_BANKING_KEY");
    if (!pem) throw new Error("ENABLE_BANKING_KEY secret is not set");
    const key = await importPrivateKey(pem);
    const jwt = await signJWT(key);

    const balRes = await fetch(`https://api.enablebanking.com/accounts/${accountUid}/balances`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    let balance: number | null = null;
    if (balRes.ok) {
      const balJson = await balRes.json();
      console.log("bank-sync raw balances response:", JSON.stringify(balJson));
      const first = balJson?.balances?.[0];
      balance = pickAmount(first);
    } else {
      console.error("bank-sync balances fetch failed:", await balRes.text());
    }

    const dateFrom = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
    const txRes = await fetch(
      `https://api.enablebanking.com/accounts/${accountUid}/transactions?date_from=${dateFrom}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    if (!txRes.ok) throw new Error("transactions fetch failed: " + (await txRes.text()));
    const txJson = await txRes.json();
    console.log("bank-sync transactions response keys:", Object.keys(txJson ?? {}), "count:", (txJson?.transactions ?? []).length);
    const txs = txJson?.transactions ?? [];
    console.log("bank-sync raw transaction sample:", JSON.stringify(txs[0] ?? null));

    const pendingRows = txs.map((t: any, i: number) => {
      const amt = pickAmount(t);
      return {
        tx_id: pickTxId(t, i),
        name: pickName(t),
        amount: amt,
        tx_date: pickDate(t),
      };
    }).filter((r: any) => r.amount != null && r.tx_date);

    if (pendingRows.length > 0) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/bank_pending?on_conflict=tx_id`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify(pendingRows),
      });
      if (!insertRes.ok) throw new Error("storing pending transactions failed: " + (await insertRes.text()));
    }

    if (balance != null) {
      const updRes = await fetch(`${SUPABASE_URL}/rest/v1/bank_sessions?id=eq.main`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ balance, balance_updated_at: new Date().toISOString() }),
      });
      if (!updRes.ok) throw new Error("storing balance failed: " + (await updRes.text()));
    }

    return new Response(JSON.stringify({ ok: true, newCount: pendingRows.length, balance }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("bank-sync error:", e);
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
