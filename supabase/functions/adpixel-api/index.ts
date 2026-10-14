import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { PACKAGE_PRICES, POSITION_PRICES, POPUP_PRICE_CENTS, POPUP_POSITION_SURCHARGE_CENTS, calculatePriceCents } from "./pricing.ts";
import { safePartnerSite, ipIsPublic } from "./security.ts";

const env = (key: string) => Deno.env.get(key) ?? "";
const configuredOrigins = (env("ADPIXEL_ALLOWED_ORIGINS") || "https://lordlolqdh.github.io").split(",").map(v => v.trim()).filter(Boolean);
const corsHeaders = (origin: string | null) => ({
  ...(origin && configuredOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
  "Content-Type": "application/json; charset=utf-8",
});
const json = (data: unknown, status = 200, origin: string | null = null) => new Response(JSON.stringify(data), { status, headers: corsHeaders(origin) });
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
async function verifyToken(token: string): Promise<Record<string, any> | null> {
  try {
    if (!SESSION_SECRET || token.split(".").length !== 3) return null;
    const [head, body, signature] = token.split(".");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SESSION_SECRET), {name:"HMAC",hash:"SHA-256"}, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, fromB64url(signature), new TextEncoder().encode(head + "." + body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
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
async function saveReferral(order:any){
  if(!order?.partner_id||!order?.referral_code||!order?.referral_attributed_at||!order?.id)return;
  await db("adpixel_referrals?on_conflict=order_id",{method:"POST",headers:{"Prefer":"resolution=ignore-duplicates,return=minimal"},body:JSON.stringify({partner_id:order.partner_id,order_id:order.id,referral_code:order.referral_code,attributed_at:order.referral_attributed_at})});
}
async function removeUploaded(path:string){
  try{
    await fetch(SUPABASE_URL+"/storage/v1/object/adpixel-assets",{method:"DELETE",headers:{apikey:SERVICE_KEY,Authorization:"Bearer "+SERVICE_KEY,"Content-Type":"application/json"},body:JSON.stringify({prefixes:[path]})});
  }catch{}
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
async function tokenClaims(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return await verifyToken(token);
}
async function adminAuthorized(req: Request) {
  const claims = await tokenClaims(req);
  return claims?.role === "admin";
}
async function partnerAuthorized(req: Request) {
  const claims = await tokenClaims(req);
  if (claims?.role !== "partner" || typeof claims.partnerId !== "string") return null;
  const rows = await db("adpixel_partners?select=id,email,display_name,website_url,partner_code,status,banner_status,free_ad_status,free_ad_order_id,last_banner_check_at,last_banner_check_message,created_at&id=eq." + encodeURIComponent(claims.partnerId) + "&limit=1");
  const partner = rows?.[0];
  if (!partner || partner.status !== "active") return null;
  return { claims, partner };
}


// Central authoritative prices in EUR cents, keyed by package pixel count.
function b64urlEncodeText(s:string){return b64url(new TextEncoder().encode(s))}
function randomCode(length:number){
  const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes=crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes,b=>alphabet[b%alphabet.length]).join("");
}
async function hashPassword(password:string,salt:string){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:fromB64url(salt),iterations:210000,hash:"SHA-256"},key,256);
  return b64url(new Uint8Array(bits));
}
function constantTimeEqual(a:string,b:string){
  if(a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function safePartner(p:any){
  const {password_hash,password_salt,...safe}=p;return safe;
}
async function assertPublicHost(host:string){
  if(/^\d{1,3}(\.\d{1,3}){3}$/.test(host)||host.includes(":"))throw new Error("IP-Adressen sind für die Bannerprüfung nicht erlaubt.");
  const addresses:string[]=[];
  try{addresses.push(...await Deno.resolveDns(host,"A"))}catch{}
  try{addresses.push(...await Deno.resolveDns(host,"AAAA"))}catch{}
  if(!addresses.length||addresses.some(ip=>!ipIsPublic(ip)))throw new Error("Die Website verweist auf eine private, nicht erreichbare oder nicht öffentliche Netzwerkadresse.");
}
async function checkPartnerBanner(site:string,code:string):Promise<{result:"verified"|"warning"|"blocked",message:string,status:number|null}>{
  let current=safePartnerSite(site);
  if(!current)return {result:"blocked",message:"Nur öffentliche HTTPS-Websites sind erlaubt.",status:null};
  try{
    for(let hop=0;hop<=3;hop++){
      const u=new URL(current);await assertPublicHost(u.hostname);
      const response=await fetch(current,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(6000),headers:{"User-Agent":"AdPixel-BannerVerifier/1.0","Accept":"text/html,application/xhtml+xml"}});
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get("location");if(!location||hop===3)return {result:"warning",message:"Zu viele oder ungültige Weiterleitungen.",status:response.status};
        const next=new URL(location,current).href;current=safePartnerSite(next);if(!current)return {result:"blocked",message:"Weiterleitung auf eine nicht erlaubte URL blockiert.",status:response.status};continue;
      }
      if(!response.ok)return {result:"warning",message:"Website antwortet mit HTTP "+response.status+".",status:response.status};
      const type=response.headers.get("content-type")||"";
      if(!/text\/html|application\/xhtml\+xml/i.test(type))return {result:"warning",message:"Die Website liefert kein HTML-Dokument.",status:response.status};
      const reader=response.body?.getReader();if(!reader)return {result:"warning",message:"Website-Inhalt konnte nicht gelesen werden.",status:response.status};
      let total=0,html="";
      while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>512*1024){await reader.cancel();return {result:"warning",message:"HTML ist für die sichere Prüfung zu groß (Limit 512 KB).",status:response.status};}html+=new TextDecoder().decode(value,{stream:true});}
      const markers=[`data-adpixel-partner="${code}"`,`data-adpixel-partner='${code}'`,`APPIXEL-PARTNER:${code}`];
      if(markers.some(m=>html.includes(m)))return {result:"verified",message:"Partner-Bannerkennung im HTML gefunden. Die Prüfung bestätigt den Marker, nicht die Sichtbarkeit oder Klickfunktion des Banners.",status:response.status};
      return {result:"warning",message:"Der AdPixel-Banner-Marker wurde auf der Startseite nicht gefunden.",status:response.status};
    }
    return {result:"warning",message:"Die Website konnte nach Weiterleitungen nicht geprüft werden.",status:null};
  }catch(e){return {result:"warning",message:e instanceof Error?e.message:"Website-Prüfung fehlgeschlagen.",status:null};}
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const respond = (data: unknown, status = 200, _origin: string | null = origin) => json(data, status, origin);
  if (req.method === "OPTIONS") return new Response(null, {status:204, headers:corsHeaders(origin)});
  if (origin && !configuredOrigins.includes(origin)) return respond({error:"origin_not_allowed"}, 403, origin);
  if (!SUPABASE_URL || !SERVICE_KEY) return respond({error:"backend_not_configured"}, 503, origin);
  if (req.method !== "POST") return respond({error:"method_not_allowed"}, 405, origin);
  let data: Record<string, any>;
  try { data = await req.json(); } catch { return respond({error:"invalid_json"}, 400); }
  const action = String(data.action || "");

  try {
    if (action === "pricing") {
      return respond({currency:"EUR", packages:PACKAGE_PRICES, positionSurcharges:POSITION_PRICES, popupPriceCents:POPUP_PRICE_CENTS, popupPositionSurchargeCents:POPUP_POSITION_SURCHARGE_CENTS, maxImageBytes:8388608}, 200, origin);
    }
    if (action === "partner_click") {
      const code = String(data.code || "").trim().toUpperCase();
      if (!/^AP-[A-Z0-9]{6,10}$/.test(code)) return respond({error:"invalid_referral_code"}, 400, origin);
      const found = await db("adpixel_partners?select=id,partner_code,status&id=not.is.null&partner_code=eq." + encodeURIComponent(code) + "&limit=1");
      const partner = found?.[0];
      if (!partner || partner.status !== "active") return respond({error:"referral_unavailable"}, 404, origin);
      const now = Math.floor(Date.now()/1000);
      const token = await sign({role:"referral", partnerId:partner.id, code:partner.partner_code, iat:now, exp:now+90*24*60*60});
      await db("adpixel_partner_events", {method:"POST", headers:{"Prefer":"return=minimal"}, body:JSON.stringify({partner_id:partner.id,event_type:"referral_click",detail:{}})});
      return respond({ok:true,token,expiresAt:now+90*24*60*60}, 200, origin);
    }
    if (action === "public_ads") {
      const ads = await db("adpixel_ads?select=id,image_path,target_url,pixel_width,pixel_height,popup_image_path,popup_text,popup_button,popup_url,published_at&published=eq.true&order=published_at.desc");
      return respond({ads: (ads || []).map((ad: any) => ({...ad, image_url: SUPABASE_URL + "/storage/v1/object/public/adpixel-assets/" + ad.image_path, popup_image_url: ad.popup_image_path ? SUPABASE_URL + "/storage/v1/object/public/adpixel-assets/" + ad.popup_image_path : null}))});
    }

    if (action === "create_order") {
      const name = String(data.name || "").trim();
      const email = String(data.email || "").trim();
      const target = validUrl(data.targetUrl);
      const w = Number(data.width), h = Number(data.height);
      const packagePixels = Number(data.packagePixels);
      const area = w * h;
      if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return respond({error:"invalid_customer"}, 400, origin);
      if (!target || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || w > 100 || h < 1 || h > 100 || !Number.isInteger(packagePixels) || !(packagePixels in PACKAGE_PRICES) || area > packagePixels) return respond({error:"invalid_ad",message:"Größe oder Pixelpaket ist ungültig."}, 400, origin);
      if (data.amazonVoucher && String(data.amazonVoucher).trim()) return respond({error:"amazon_voucher_cannot_be_verified_online", message:"Amazon-Geschenkkarten können über diese Schnittstelle nicht zuverlässig auf Echtheit und Restguthaben geprüft werden. Es wurde kein Code gespeichert und keine Bestellung als bezahlt markiert."}, 422, origin);
      const idempotencyKey=String(data.idempotencyKey||"");
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey))return respond({error:"idempotency_key_required",message:"Bitte Anfrage erneut senden; die Bestellkennung fehlt."},400,origin);
      const previous=await db("adpixel_orders?select=id,amount_cents,payment_status,status,partner_id,referral_code,referral_attributed_at&idempotency_key=eq."+encodeURIComponent(idempotencyKey)+"&limit=1");
      if(previous?.[0]){await saveReferral(previous[0]);return respond({ok:true,orderId:previous[0].id,amountCents:previous[0].amount_cents,currency:"EUR",status:previous[0].status,alreadyProcessed:true,message:"Diese Anfrage wurde bereits verarbeitet. Es wurde keine zweite Bestellung angelegt."},200,origin);}
      const main = decodeImage(data.image);
      const popupPresent = Boolean(data.popupImage || String(data.popupText || "").trim() || String(data.popupButton || "").trim() || String(data.popupUrl || "").trim());
      const popupTarget = data.popupUrl ? validUrl(data.popupUrl) : "";
      if (data.popupUrl && !popupTarget) return respond({error:"invalid_popup_url"}, 400);
      const position = data.customPosition === true;
      const popupCustomPosition = popupPresent && data.popupCustomPosition === true;
      let price;
      try { price = calculatePriceCents(packagePixels,w,h,position,popupPresent,popupCustomPosition); }
      catch { return respond({error:"invalid_ad",message:"Größe oder Pixelpaket ist ungültig."},400,origin); }
      const base = price.baseCents;
      const popup = price.popupCents;
      const positionCost = price.positionCents;
      const popupPositionCost = price.popupPositionCents;
      const suppliedCode = typeof data.freeCode === "string" ? data.freeCode.trim() : "";
      const configuredCode = env("ADPIXEL_FREE_CODE").trim();
      if (suppliedCode && !configuredCode) return respond({error:"free_code_not_configured", message:"Der Freischaltcode ist serverseitig noch nicht eingerichtet. Bitte ADPIXEL_FREE_CODE in den Supabase-Edge-Function-Secrets setzen."}, 503, origin);
      if (suppliedCode && suppliedCode !== configuredCode) return respond({error:"invalid_free_code", message:"Der Freischaltcode ist falsch. Bitte prüfe den eingegebenen Code."}, 422, origin);
      const isFree = Boolean(configuredCode && suppliedCode && suppliedCode === configuredCode);
      const amount = isFree ? 0 : base + popup + positionCost + popupPositionCost;
      let attribution: Record<string, any> | null = null;
      const referralToken = typeof data.referralToken === "string" ? data.referralToken : "";
      if (referralToken) {
        const claims = await verifyToken(referralToken);
        if (claims?.role === "referral" && typeof claims.partnerId === "string" && typeof claims.code === "string") {
          const partners = await db("adpixel_partners?select=id,email,partner_code,status&id=eq." + encodeURIComponent(claims.partnerId) + "&limit=1");
          const p = partners?.[0];
          if (p && p.status === "active" && p.partner_code === claims.code && p.email.toLowerCase() !== email.toLowerCase()) {
            attribution = {partner_id:p.id, referral_code:p.partner_code, referral_attributed_at:new Date(Number(claims.iat || Date.now()/1000)*1000).toISOString()};
          } else if (p && p.email.toLowerCase() === email.toLowerCase()) {
            await db("adpixel_partner_events", {method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:p.id,event_type:"self_referral_rejected",detail:{}})});
          }
        }
      }
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
        popup_url: popupTarget || null, popup_custom_position:popupCustomPosition, amount_cents: amount, free_code_used: isFree,
        partner_id: attribution?.partner_id || null, referral_code: attribution?.referral_code || null,
        referral_attributed_at: attribution?.referral_attributed_at || null, idempotency_key:idempotencyKey,
        payment_status: isFree ? "free_pending_review" : "pending", status: "pending",
      };
      try {
        await db("adpixel_orders", {method:"POST", headers:{"Prefer":"return=minimal"}, body:JSON.stringify(order)});
      } catch (insertError) {
        const duplicate=await db("adpixel_orders?select=id,amount_cents,payment_status,status,partner_id,referral_code,referral_attributed_at&idempotency_key=eq."+encodeURIComponent(idempotencyKey)+"&limit=1").catch(()=>[]);
        if(duplicate?.[0]){
          await removeUploaded(mainPath);
          if(popupPath)await removeUploaded(popupPath);
          await saveReferral(duplicate[0]);
          return respond({ok:true,orderId:duplicate[0].id,amountCents:duplicate[0].amount_cents,currency:"EUR",status:duplicate[0].status,alreadyProcessed:true,message:"Diese Anfrage wurde bereits verarbeitet. Es wurde keine zweite Bestellung angelegt."},200,origin);
        }
        await removeUploaded(mainPath);
        if(popupPath)await removeUploaded(popupPath);
        throw insertError;
      }
      if (attribution) await saveReferral({id:orderId,partner_id:attribution.partner_id,referral_code:attribution.referral_code,referral_attributed_at:attribution.referral_attributed_at});
      return respond({ok:true, orderId, amountCents:amount, currency:"EUR", freeUpload:isFree, status:"pending", message:isFree ? "Kostenloser Auftrag eingegangen und wartet auf Freigabe." : "Auftrag gespeichert. Zahlung ist noch nicht erfolgt; Veröffentlichung erst nach bestätigter Zahlung und Freigabe."}, 201, origin);
    }

    if (action === "admin_login") {
      const provided = typeof data.code === "string" ? data.code : "";
      const configured = env("ADPIXEL_ADMIN_CODE");
      if (!configured || !SESSION_SECRET || !provided || provided !== configured) return respond({error:"invalid_admin_code"}, 401);
      const now = Math.floor(Date.now()/1000);
      return respond({ok:true, token:await sign({role:"admin", iat:now, exp:now+60*60*4})}, 200, origin);
    }

    if (action === "partner_register") {
      const displayName = String(data.displayName || "").trim();
      const email = String(data.email || "").trim().toLowerCase();
      const password = String(data.password || "");
      const website = data.websiteUrl ? safePartnerSite(data.websiteUrl) : "";
      if (displayName.length < 1 || displayName.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 10 || password.length > 128) return respond({error:"invalid_registration",message:"Bitte Name, gültige E-Mail und ein Passwort mit 10–128 Zeichen angeben."}, 400, origin);
      if (data.websiteUrl && !website) return respond({error:"invalid_website",message:"Die Partnerwebsite muss eine öffentliche HTTPS-Adresse sein."}, 400, origin);
      const existing = await db("adpixel_partners?select=id&email=eq." + encodeURIComponent(email) + "&limit=1");
      if (existing?.length) return respond({error:"email_exists",message:"Für diese E-Mail-Adresse existiert bereits ein Partnerkonto."}, 409, origin);
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const salt = b64url(saltBytes);
      const passwordHash = await hashPassword(password, salt);
      const partnerCode = "AP-" + randomCode(8);
      const partner = {email,display_name:displayName,website_url:website||null,password_salt:salt,password_hash:passwordHash,partner_code:partnerCode,status:"active",banner_status:website?"pending":"not_configured",free_ad_status:"locked"};
      const rows = await db("adpixel_partners", {method:"POST",headers:{"Prefer":"return=representation"},body:JSON.stringify(partner)});
      const created = rows?.[0];
      if (!created) return respond({error:"registration_failed"}, 500, origin);
      await db("adpixel_partner_events",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:created.id,event_type:"partner_registered",detail:{}})});
      const now=Math.floor(Date.now()/1000);
      return respond({ok:true,token:await sign({role:"partner",partnerId:created.id,iat:now,exp:now+30*24*60*60}),partner:{id:created.id,email,display_name:displayName,website_url:website||null,partner_code:partnerCode,status:"active",banner_status:partner.banner_status,free_ad_status:"locked"}},201,origin);
    }
    if (action === "partner_login") {
      const email=String(data.email||"").trim().toLowerCase(), password=String(data.password||"");
      const rows=await db("adpixel_partners?select=id,email,display_name,website_url,password_salt,password_hash,partner_code,status,banner_status,free_ad_status,free_ad_order_id,last_banner_check_at,last_banner_check_message,created_at&email=eq."+encodeURIComponent(email)+"&limit=1");
      const p=rows?.[0];
      if (!p || p.status!=="active" || password.length>128 || !constantTimeEqual(await hashPassword(password,p.password_salt||""),p.password_hash||"")) return respond({error:"invalid_credentials",message:"Anmeldedaten ungültig oder Konto gesperrt."},401,origin);
      const now=Math.floor(Date.now()/1000);
      await db("adpixel_partner_events",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:p.id,event_type:"partner_login",detail:{}})});
      return respond({ok:true,token:await sign({role:"partner",partnerId:p.id,iat:now,exp:now+30*24*60*60}),partner:safePartner(p)},200,origin);
    }
    if (action.startsWith("partner_") && action !== "partner_click" && action !== "partner_register" && action !== "partner_login") {
      const auth = await partnerAuthorized(req);
      if (!auth) return respond({error:"unauthorized",message:"Partneranmeldung abgelaufen oder Konto gesperrt."},401,origin);
      const p=auth.partner;
      if (action === "partner_dashboard") {
        const referralRows=await db("adpixel_referrals?select=id,order_id,referral_code,attributed_at,adpixel_orders(pixel_width,pixel_height,amount_cents,payment_status,free_code_used,created_at,status)&partner_id=eq."+encodeURIComponent(p.id)+"&order=attributed_at.desc&limit=500");
        const referrals=(referralRows||[]).map((r:any)=>({createdAt:r.attributed_at,orderId:r.order_id,order:r.adpixel_orders})).filter((r:any)=>r.order);
        const now=Date.now();
        const paidPixels=referrals.reduce((sum:number,r:any)=>{const o=Array.isArray(r.order)?r.order[0]:r.order;const eligible=o && o.payment_status==="paid" && !o.free_code_used && Number(o.amount_cents)>0 && new Date(r.createdAt).getTime()+90*86400000>=now;return sum+(eligible?Number(o.pixel_width)*Number(o.pixel_height):0)},0);
        const eligible=paidPixels>=500 && p.banner_status==="verified" && p.status==="active";
        const newFreeStatus=eligible?((["used","requested","approved"].includes(p.free_ad_status))?p.free_ad_status:"eligible"):(p.free_ad_status==="used"?"used":p.free_ad_status==="approved"?"suspended":"locked");
        if (newFreeStatus!==p.free_ad_status) await db("adpixel_partners?id=eq."+encodeURIComponent(p.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({free_ad_status:newFreeStatus,updated_at:new Date().toISOString()})});
        return respond({ok:true,partner:{...p,free_ad_status:newFreeStatus},stats:{referrals:referrals.length,paidPixels,goalPixels:500,progressPercent:Math.min(100,Math.round(paidPixels/5)),attributionDays:90},referrals:referrals.slice(0,50).map((r:any)=>{const o=Array.isArray(r.order)?r.order[0]:r.order;return {createdAt:r.createdAt,orderId:r.orderId,pixels:Number(o.pixel_width)*Number(o.pixel_height),paymentStatus:o.payment_status,amountCents:o.amount_cents}})},200,origin);
      }
      if (action === "partner_set_website") {
        const website=safePartnerSite(data.websiteUrl);
        if (!website) return respond({error:"invalid_website",message:"Bitte eine öffentliche HTTPS-Website eingeben."},400,origin);
        await db("adpixel_partners?id=eq."+encodeURIComponent(p.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({website_url:website,banner_status:"pending",free_ad_status:p.free_ad_status==="used"?"used":"suspended",last_banner_check_message:"Prüfung ausstehend",updated_at:new Date().toISOString()})});
        await db("adpixel_ads?partner_id=eq."+encodeURIComponent(p.id)+"&is_partner_free=eq.true&published=eq.true",{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({published:false,published_at:null})});
        await db("adpixel_partner_events",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:p.id,event_type:"website_updated",detail:{website_url:website}})});
        return respond({ok:true,websiteUrl:website,message:"Website gespeichert. Bannerintegration jetzt prüfen."},200,origin);
      }
      if (action === "partner_banner_check") {
        if (!p.website_url) return respond({error:"website_required",message:"Speichere zuerst deine Website."},400,origin);
        const check=await checkPartnerBanner(p.website_url,p.partner_code);
        await db("adpixel_partners?id=eq."+encodeURIComponent(p.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({banner_status:check.result,last_banner_check_at:new Date().toISOString(),last_banner_check_message:check.message,free_ad_status:check.result==="verified"?p.free_ad_status:(p.free_ad_status==="used"?"used":"suspended"),updated_at:new Date().toISOString()})});
        await db("adpixel_banner_checks",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:p.id,site_url:p.website_url,result:check.result,message:check.message,http_status:check.status})});
        await db("adpixel_partner_events",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:p.id,event_type:"banner_check",detail:{result:check.result,status:check.status}})});
        if(check.result!=="verified") await db("adpixel_ads?partner_id=eq."+encodeURIComponent(p.id)+"&is_partner_free=eq.true&published=eq.true",{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({published:false,published_at:null})});
        return respond({ok:check.result==="verified",result:check.result,message:check.message,httpStatus:check.status},200,origin);
      }
      if (action === "partner_request_free_ad") {
        const dash=await db("adpixel_referrals?select=attributed_at,adpixel_orders(pixel_width,pixel_height,amount_cents,payment_status,free_code_used)&partner_id=eq."+encodeURIComponent(p.id)+"&limit=500");
        const now=Date.now();
        const pixels=(dash||[]).reduce((sum:number,r:any)=>{const o=Array.isArray(r.adpixel_orders)?r.adpixel_orders[0]:r.adpixel_orders;return sum+(o&&o.payment_status==="paid"&&!o.free_code_used&&Number(o.amount_cents)>0&&new Date(r.attributed_at).getTime()+90*86400000>=now?Number(o.pixel_width)*Number(o.pixel_height):0)},0);
        if(pixels<500||p.banner_status!=="verified")return respond({error:"free_ad_not_eligible",message:"Mindestens 500 bestätigte, bezahlte Werbepixel innerhalb des 90-Tage-Zeitraums und eine gültige Bannerintegration sind erforderlich."},409,origin);
        await db("adpixel_partners?id=eq."+encodeURIComponent(p.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({free_ad_status:"requested",updated_at:new Date().toISOString()})});
        await db("adpixel_partner_events",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:p.id,event_type:"free_ad_requested",detail:{paid_pixels:pixels}})});
        return respond({ok:true,message:"Kostenlose Werbefläche beantragt. Die Freigabe erfolgt nach Adminprüfung."},200,origin);
      }
      return respond({error:"unknown_partner_action"},400,origin);
    }
    if (!await adminAuthorized(req)) return respond({error:"unauthorized"}, 401, origin);
    if (action === "admin_partners") {
      const partners=await db("adpixel_partners?select=id,email,display_name,website_url,partner_code,status,banner_status,free_ad_status,last_banner_check_at,last_banner_check_message,suspended_at,suspension_reason,created_at&order=created_at.desc&limit=500");
      return respond({partners},200,origin);
    }
    if (action === "admin_partner_update") {
      const id=String(data.id||"");
      const status=String(data.status||"");
      const reason=String(data.reason||"").trim().slice(0,500);
      if(!/^[0-9a-f-]{36}$/i.test(id)||!["active","suspended","pending"].includes(status))return respond({error:"invalid_partner_update"},400,origin);
      const existing=await db("adpixel_partners?select=id&id=eq."+encodeURIComponent(id)+"&limit=1");
      if(!existing?.length)return respond({error:"partner_not_found"},404,origin);
      await db("adpixel_partners?id=eq."+encodeURIComponent(id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status,suspended_at:status==="suspended"?new Date().toISOString():null,suspension_reason:status==="suspended"?(reason||"Durch Admin gesperrt"):null,free_ad_status:status==="suspended"?"suspended":"locked",updated_at:new Date().toISOString()})});
      if(status==="suspended")await db("adpixel_ads?partner_id=eq."+encodeURIComponent(id)+"&is_partner_free=eq.true&published=eq.true",{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({published:false,published_at:null})});
      await db("adpixel_partner_events",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:id,event_type:"admin_partner_status_changed",detail:{status,reason}})});
      return respond({ok:true},200,origin);
    }
    if (action === "admin_partner_free_ad") {
      const id=String(data.id||""), status=String(data.status||"");
      if(!/^[0-9a-f-]{36}$/i.test(id)||!["approved","suspended","used","locked"].includes(status))return respond({error:"invalid_free_ad_status"},400,origin);
      const existing=await db("adpixel_partners?select=id,status,banner_status&id=eq."+encodeURIComponent(id)+"&limit=1");
      const p=existing?.[0];
      if(!p)return respond({error:"partner_not_found"},404,origin);
      if(status==="approved"&&(p.status!=="active"||p.banner_status!=="verified"))return respond({error:"partner_not_eligible",message:"Nur aktive Partner mit verifizierter Bannerintegration können eine kostenlose Werbefläche erhalten."},409,origin);
      if(status==="approved"){
        const refs=await db("adpixel_referrals?select=attributed_at,adpixel_orders(pixel_width,pixel_height,amount_cents,payment_status,free_code_used)&partner_id=eq."+encodeURIComponent(id)+"&limit=500");
        const now=Date.now();
        const pixels=(refs||[]).reduce((sum:number,r:any)=>{const o=Array.isArray(r.adpixel_orders)?r.adpixel_orders[0]:r.adpixel_orders;return sum+(o&&o.payment_status==="paid"&&!o.free_code_used&&Number(o.amount_cents)>0&&new Date(r.attributed_at).getTime()+90*86400000>=now?Number(o.pixel_width)*Number(o.pixel_height):0)},0);
        if(pixels<500)return respond({error:"partner_not_eligible",message:"Für die Freigabe sind mindestens 500 bestätigte bezahlte Pixel innerhalb der 90-Tage-Frist erforderlich."},409,origin);
      }
      await db("adpixel_partners?id=eq."+encodeURIComponent(id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({free_ad_status:status,updated_at:new Date().toISOString()})});
      if(status==="suspended"||status==="locked")await db("adpixel_ads?partner_id=eq."+encodeURIComponent(id)+"&is_partner_free=eq.true&published=eq.true",{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({published:false,published_at:null})});
      await db("adpixel_partner_events",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:id,event_type:"admin_free_ad_status_changed",detail:{status}})});
      return respond({ok:true},200,origin);
    }
    if (action === "admin_orders") {
      const orders = await db("adpixel_orders?select=*&order=created_at.desc");
      return respond({orders});
    }
    if (action === "admin_ads") {
      const ads = await db("adpixel_ads?select=*&order=created_at.desc");
      return respond({ads});
    }
    if (action === "admin_update_order") {
      const id = String(data.id || "");
      const status = String(data.status || "");
      const payment = String(data.paymentStatus || "");
      const note=String(data.note||"").trim().slice(0,1000);
      if (!/^[0-9a-f-]{36}$/i.test(id) || !["pending","approved","rejected"].includes(status) || !["pending","free_pending_review","manual_review","paid","refunded","failed"].includes(payment)) return respond({error:"invalid_update"}, 400, origin);
      const existing=await db("adpixel_orders?select=id,free_code_used,payment_status,partner_id,amount_cents&id=eq."+encodeURIComponent(id)+"&limit=1");
      const oldOrder=existing?.[0];
      if(!oldOrder)return respond({error:"order_not_found"},404,origin);
      if(payment==="paid"&&!note)return respond({error:"payment_note_required",message:"Für eine manuelle Zahlungsbestätigung ist eine Prüfnotiz erforderlich."},400,origin);
      if(payment==="paid"&&(oldOrder.free_code_used||Number(oldOrder.amount_cents)<=0))return respond({error:"cannot_mark_free_order_paid",message:"Kostenlose Testbestellungen dürfen nicht als bezahlte Käufe gelten."},409,origin);
      await db("adpixel_orders?id=eq." + encodeURIComponent(id), {method:"PATCH", headers:{"Prefer":"return=minimal"}, body:JSON.stringify({status, payment_status:payment, admin_note:note, updated_at:new Date().toISOString()})});
      if(payment==="refunded"||payment==="failed")await db("adpixel_ads?order_id=eq."+encodeURIComponent(id)+"&published=eq.true",{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({published:false,published_at:null})});
      if(oldOrder.partner_id)await db("adpixel_partner_events",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({partner_id:oldOrder.partner_id,event_type:"referred_order_status_changed",detail:{order_id:id,payment_status:payment,admin_note:note}})});
      return respond({ok:true});
    }
    if (action === "admin_publish") {
      const id = String(data.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return respond({error:"invalid_id"}, 400);
      const found = await db("adpixel_orders?select=*&id=eq." + encodeURIComponent(id) + "&limit=1");
      const order = found?.[0];
      if (!order) return respond({error:"order_not_found"}, 404);
      if (order.status !== "approved" || !(order.payment_status === "paid" || order.payment_status === "free_pending_review")) return respond({error:"order_not_eligible", message:"Zuerst Zahlung oder kostenlosen Auftrag prüfen und den Auftrag freigeben."}, 409, origin);
      if(order.free_code_used && order.payment_status!=="free_pending_review")return respond({error:"free_order_payment_invalid"},409,origin);
      await db("adpixel_ads?on_conflict=order_id", {method:"POST", headers:{"Prefer":"resolution=merge-duplicates,return=minimal"}, body:JSON.stringify({order_id:order.id,image_path:order.main_image_path,target_url:order.target_url,pixel_width:order.pixel_width,pixel_height:order.pixel_height,popup_image_path:order.popup_image_path,popup_text:order.popup_text,popup_button:order.popup_button,popup_url:order.popup_url,popup_custom_position:order.popup_custom_position===true,partner_id:order.partner_id||null,is_partner_free:false,published:true,published_at:new Date().toISOString()})});
      await db("adpixel_orders?id=eq." + encodeURIComponent(id), {method:"PATCH", headers:{"Prefer":"return=minimal"}, body:JSON.stringify({status:"published",updated_at:new Date().toISOString()})});
      return respond({ok:true},200,origin);
    }
    if (action === "admin_unpublish") {
      const id = String(data.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return respond({error:"invalid_id"}, 400);
      await db("adpixel_ads?id=eq." + encodeURIComponent(id), {method:"PATCH", headers:{"Prefer":"return=minimal"}, body:JSON.stringify({published:false,published_at:null})});
      return respond({ok:true});
    }
    if (action === "admin_delete_order") {
      const id = String(data.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return respond({error:"invalid_id"}, 400);
      await db("adpixel_orders?id=eq." + encodeURIComponent(id), {method:"DELETE"});
      return respond({ok:true});
    }
    return respond({error:"unknown_action"}, 400, origin);
  } catch (error) {
    console.error("AdPixel API error", error instanceof Error ? error.message : "unknown");
    return respond({error:"server_error", message:"Die Anfrage konnte nicht verarbeitet werden."}, 500, origin);
  }
});
