import { PACKAGE_PRICES, POSITION_PRICES, calculatePriceCents } from "./pricing.ts";
function assert(condition:unknown,message:string){if(!condition)throw new Error(message)}
Deno.test("all advertised package prices match the price list",()=>{
  const expected:Record<number,number>={1:1,2:2,4:4,10:10,100:100,200:200,400:370,500:450};
  assert(JSON.stringify(PACKAGE_PRICES)===JSON.stringify(expected),"package prices changed unexpectedly");
});
Deno.test("all position surcharges match the price list",()=>{
  const expected:Record<number,number>={1:30,2:30,4:30,10:30,100:25,200:25,400:25,500:20};
  assert(JSON.stringify(POSITION_PRICES)===JSON.stringify(expected),"position prices changed unexpectedly");
});
Deno.test("base price and position surcharge are calculated in integer cents",()=>{
  assert(calculatePriceCents(400,20,20,true,false,false).totalCents===395,"400-pixel package should be 3.95 EUR with position");
  assert(calculatePriceCents(500,25,20,true,false,false).totalCents===470,"500-pixel package should be 4.70 EUR with position");
});
Deno.test("popup and free popup position surcharge are applied only when popup is present",()=>{
  assert(calculatePriceCents(10,5,2,false,true,true).totalCents===310,"10 pixels plus popup and popup position should be 3.10 EUR");
  assert(calculatePriceCents(10,5,2,false,false,true).totalCents===10,"popup position without popup must not be charged");
});
Deno.test("valid package area boundaries are accepted",()=>{
  assert(calculatePriceCents(500,25,20,false,false,false).areaPixels===500,"25x20 should fit 500 pixels");
  assert(calculatePriceCents(1,1,1,false,false,false).totalCents===1,"single pixel price should be 0.01 EUR");
});
Deno.test("manipulated packages and oversized dimensions are rejected",()=>{
  for(const args of [[11,1,1],[500,26,20],[100,10,11],[2,2,2]] as number[][]){
    let rejected=false;try{calculatePriceCents(args[0],args[1],args[2],false,false,false)}catch{rejected=true}
    assert(rejected,"invalid pricing input was accepted: "+args.join("x"));
  }
});
