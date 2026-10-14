export function safePartnerSite(value:unknown){
  try{
    const u=new URL(String(value||""));
    if(u.protocol!=="https:"||u.username||u.password||!u.hostname||u.hostname==="localhost"||u.hostname.endsWith(".localhost")||u.hostname.endsWith(".local")||/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)||u.hostname.startsWith("[")||u.port&&u.port!=="443")return "";
    return u.href;
  }catch{return ""}
}
export function ipIsPublic(value:string){
  if(value.includes(":")){
    const v=value.toLowerCase();
    if(v.startsWith("::ffff:"))return false;
    return !(v==="::"||v==="::1"||v.startsWith("fc")||v.startsWith("fd")||v.startsWith("fe80:")||v.startsWith("ff"));
  }
  const a=value.split(".").map(Number);
  if(a.length!==4||a.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  return !(a[0]===0||a[0]===10||a[0]===127||a[0]>=224||(a[0]===169&&a[1]===254)||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)||(a[0]===100&&a[1]>=64&&a[1]<=127)||(a[0]===198&&(a[1]===18||a[1]===19));
}
