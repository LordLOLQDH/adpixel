import { safePartnerSite, ipIsPublic } from "./security.ts";
function assert(condition:unknown,message:string){if(!condition)throw new Error(message)}
Deno.test("only public HTTPS sites are accepted for partner checks",()=>{
  assert(safePartnerSite("https://example.com") === "https://example.com/","public HTTPS site rejected");
  for(const url of ["http://example.com","file:///etc/passwd","https://localhost","https://service.local","https://127.0.0.1","https://192.168.1.5","https://user:pass@example.com","https://example.com:8443"])assert(safePartnerSite(url)==="","unsafe URL accepted: "+url);
});
Deno.test("private and special IPv4 ranges are rejected",()=>{
  for(const ip of ["127.0.0.1","10.0.0.1","172.16.0.1","192.168.0.1","169.254.10.20","100.64.0.1","198.18.0.1","0.0.0.0","224.0.0.1"])assert(!ipIsPublic(ip),"private IPv4 accepted: "+ip);
  for(const ip of ["1.1.1.1","8.8.8.8","203.0.113.10"])assert(ipIsPublic(ip),"public IPv4 rejected: "+ip);
});
Deno.test("private IPv6 and IPv4-mapped IPv6 are rejected",()=>{
  for(const ip of ["::","::1","fc00::1","fd12::1","fe80::1","ff02::1","::ffff:192.168.1.1"])assert(!ipIsPublic(ip),"private IPv6 accepted: "+ip);
  assert(ipIsPublic("2606:4700:4700::1111"),"public IPv6 rejected");
});
