import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
const env = (key: string) => Deno.env.get(key) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const SESSION_SECRET = env("ADPIXEL_SESSION_SECRET");

function b64url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(value: string) {
  const s = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function sign(payload: Record<string, unknown>) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SESSION_SECRET), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const head = b64url(new TextEncoder().encode(JSON.stringify({alg:"HS256",typ:"JWT"})));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const input = head + "." + body;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return input + "." + b64url(sig);
}
async function verifyToken(token: string) {
  if (!SESSION_SECRET || token.split(".").length !== 3) return false;
  const [head, body, signature] = token.split(".");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SESSION_SECRET), {name:"HMAC",hash:"SHA-256"}, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, fromB64url(signature), new TextEncoder().encode(head + "." + body));
  if (!valid) return false;
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  return payload.role === "admin" && payload.exp > Math.floor(Date.now()/1000);
}
async function db(path: string, init: RequestInit = {}) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const raw = await response.text();
  if (!response.ok) throw new Error("database_request_failed:" + response.status + ":" + raw.slice(0, 300));
  return raw ? JSON.parse(raw) : null;
}
function validUrl(value: unknown) {
  try { const u = new URL(String(value)); return ["https:", "http:"].includes(u.protocol) ? u.href : ""; }
  catch { return ""; }
}
function decodeImage(value: unknown) {
  if (typeof value !== "string") throw new Error("image_missing");
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("unsupported_image");
  const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("image_too_large");
  return { bytes, type: match[1] };
}
async function upload(path: string, dataUrl: unknown) {
  const {bytes, type} = decodeImage(dataUrl);
  const res = await fetch(SUPABASE_URL + "/storage/v1/object/adpixel-assets/" + path, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": type, "x-upsert": "false" },
    body: bytes,
  });
  if (!res.ok) throw new Error("image_upload_failed:" + res.status);
  return path;
}
async function adminAuthorized(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return await verifyToken(token);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", {headers:cors});
  if (!SUPABASE_URL || !SERVICE_KEY) return json({error:"backend_not_configured"}, 503);
  if (req.method !== "POST") return json({error:"method_not_allowed"}, 405);
  let data: Record<string, any>;
  try { data = await req.json(); } catch { return json({error:"invalid_json"}, 400); }
  const action = String(data.action || "");

  try {
    if (action === "public_ads") {
      const ads = await db("adpixel_ads?select=id,image_path,target_url,pixel_width,pixel_height,popup_image_path,popup_text,popup_button,popup_url,published_at&published=eq.true&order=published_at.desc");
      return json({ads: (ads || []).map((ad: any) => ({...ad, image_url: SUPABASE_URL + "/storage/v1/object/public/adpixel-assets/" + ad.image_path, popup_image_url: ad.popup_image_path ? SUPABASE_URL + "/storage/v1/object/public/adpixel-assets/" + ad.popup_image_path : null}))});
    }

    if (action === "create_order") {
      const name = String(data.name || "").trim();
      const email = String(data.email || "").trim();
      const target = validUrl(data.targetUrl);
      const w = Number(data.width), h = Number(data.height);
      if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({error:"invalid_customer"}, 400);
      if (!target || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || w > 100 || h < 1 || h > 100) return json({error:"invalid_ad"}, 400);
      if (data.amazonVoucher && String(data.amazonVoucher).trim()) return json({error:"amazon_voucher_cannot_be_verified_online", message:"Amazon-Geschenkkarten können über diese Schnittstelle nicht zuverlässig auf Echtheit und Restguthaben geprüft werden. Es wurde kein Code gespeichert und keine Bestellung als bezahlt markiert."}, 422);
      const main = decodeImage(data.image);
      const popupPresent = Boolean(data.popupImage || String(data.popupText || "").trim() || String(data.popupButton || "").trim() || String(data.popupUrl || "").trim());
      const popupTarget = data.popupUrl ? validUrl(data.popupUrl) : "";
      if (data.popupUrl && !popupTarget) return json({error:"invalid_popup_url"}, 400);
      const position = data.customPosition === true;
      const base = w * h * 100;
      const popup = popupPresent ? 200 : 0;
      const positionCost = position ? 50 : 0;
      const suppliedCode = typeof data.freeCode === "string" ? data.freeCode : "";
      const configuredCode = env("ADPIXEL_FREE_CODE");
      const isFree = Boolean(configuredCode && suppliedCode && suppliedCode === configuredCode);
      const amount = isFree ? 0 : base + popup + positionCost;
      const orderId = crypto.randomUUID();
      let mainPath = orderId + "/main." + (main.type === "image/jpeg" ? "jpg" : main.type.split("/")[1]);
      await upload(mainPath, data.image);
      let popupPath: string | null = null;
      if (data.popupImage) {
        const p = decodeImage(data.popupImage);
        popupPath = orderId + "/popup." + (p.type === "image/jpeg" ? "jpg" : p.type.split("/")[1]);
        await upload(popupPath, data.popupImage);
      }
      const order = {
        id: orderId, customer_name: name, customer_email: email, main_image_path: mainPath, popup_image_path: popupPath,
        target_url: target, pixel_width: w, pixel_height: h, custom_position: position,
        popup_text: String(data.popupText || "").slice(0,180) || null,
        popup_button: String(data.popupButton || "").slice(0,32) || null,
        popup_url: popupTarget || null, amount_cents: amount, free_code_used: isFree,
        payment_status: isFree ? "free_pending_review" : "pending", status: "pending",
      };
      await db("adpixel_orders", {method:"POST", headers:{"Prefer":"return=minimal"}, body:JSON.stringify(order)});
      return json({ok:true, orderId, amountCents:amount, currency:"EUR", freeUpload:isFree, status:"pending", message:isFree ? "Kostenloser Auftrag eingegangen und wartet auf Freigabe." : "Auftrag gespeichert. Zahlung ist noch nicht erfolgt; Veröffentlichung erst nach bestätigter Zahlung und Freigabe."}, 201);
    }

    if (action === "admin_login") {
      const provided = typeof data.code === "string" ? data.code : "";
      const configured = env("ADPIXEL_ADMIN_CODE");
      if (!configured || !SESSION_SECRET || !provided || provided !== configured) return json({error:"invalid_admin_code"}, 401);
      const now = Math.floor(Date.now()/1000);
      return json({ok:true, token:await sign({role:"admin", iat:now, exp:now+60*60*4})});
    }

    if (!await adminAuthorized(req)) return json({error:"unauthorized"}, 401);
    if (action === "admin_orders") {
      const orders = await db("adpixel_orders?select=*&order=created_at.desc");
      return json({orders});
    }
    if (action === "admin_ads") {
      const ads = await db("adpixel_ads?select=*&order=created_at.desc");
      return json({ads});
    }
    if (action === "admin_update_order") {
      const id = String(data.id || "");
      const status = String(data.status || "");
      const payment = String(data.paymentStatus || "");
      if (!/^[0-9a-f-]{36}$/i.test(id) || !["pending","approved","rejected"].includes(status) || !["pending","free_pending_review","manual_review","paid","refunded","failed"].includes(payment)) return json({error:"invalid_update"}, 400);
      await db("adpixel_orders?id=eq." + encodeURIComponent(id), {method:"PATCH", headers:{"Prefer":"return=minimal"}, body:JSON.stringify({status, payment_status:payment, admin_note:String(data.note||"").slice(0,1000), updated_at:new Date().toISOString()})});
      return json({ok:true});
    }
    if (action === "admin_publish") {
      const id = String(data.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({error:"invalid_id"}, 400);
      const found = await db("adpixel_orders?select=*&id=eq." + encodeURIComponent(id) + "&limit=1");
      const order = found?.[0];
      if (!order) return json({error:"order_not_found"}, 404);
      if (!(order.payment_status === "paid" || order.payment_status === "free_pending_review") || order.status === "rejected") return json({error:"order_not_eligible", message:"Zuerst Zahlung oder kostenlosen Auftrag prüfen und den Auftrag freigeben."}, 409);
      await db("adpixel_ads?on_conflict=order_id", {method:"POST", headers:{"Prefer":"resolution=merge-duplicates,return=minimal"}, body:JSON.stringify({order_id:order.id,image_path:order.main_image_path,target_url:order.target_url,pixel_width:order.pixel_width,pixel_height:order.pixel_height,popup_image_path:order.popup_image_path,popup_text:order.popup_text,popup_button:order.popup_button,popup_url:order.popup_url,published:true,published_at:new Date().toISOString()})});
      await db("adpixel_orders?id=eq." + encodeURIComponent(id), {method:"PATCH", headers:{"Prefer":"return=minimal"}, body:JSON.stringify({status:"published",updated_at:new Date().toISOString()})});
      return json({ok:true});
    }
    if (action === "admin_unpublish") {
      const id = String(data.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({error:"invalid_id"}, 400);
      await db("adpixel_ads?id=eq." + encodeURIComponent(id), {method:"PATCH", headers:{"Prefer":"return=minimal"}, body:JSON.stringify({published:false,published_at:null})});
      return json({ok:true});
    }
    if (action === "admin_delete_order") {
      const id = String(data.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({error:"invalid_id"}, 400);
      await db("adpixel_orders?id=eq." + encodeURIComponent(id), {method:"DELETE"});
      return json({ok:true});
    }
    return json({error:"unknown_action"}, 400);
  } catch (error) {
    console.error("AdPixel API error", error instanceof Error ? error.message : "unknown");
    return json({error:"server_error", message:"Die Anfrage konnte nicht verarbeitet werden."}, 500);
  }
});
