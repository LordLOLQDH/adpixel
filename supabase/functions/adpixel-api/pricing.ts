export const PACKAGE_PRICES: Record<number, number> = {1:1,2:2,4:4,10:10,100:100,200:200,400:370,500:450};
export const POSITION_PRICES: Record<number, number> = {1:30,2:30,4:30,10:30,100:25,200:25,400:25,500:20};
export const POPUP_PRICE_CENTS = 200;
export const POPUP_POSITION_SURCHARGE_CENTS = 10;

export function calculatePriceCents(packagePixels:number,width:number,height:number,customPosition:boolean,popupPresent:boolean,popupCustomPosition:boolean) {
  if (!Number.isInteger(packagePixels) || !Object.prototype.hasOwnProperty.call(PACKAGE_PRICES,String(packagePixels))) throw new Error("invalid_package");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 100 || height > 100 || width * height > packagePixels) throw new Error("invalid_area");
  const baseCents = PACKAGE_PRICES[packagePixels];
  const positionCents = customPosition ? POSITION_PRICES[packagePixels] : 0;
  const popupCents = popupPresent ? POPUP_PRICE_CENTS : 0;
  const popupPositionCents = popupPresent && popupCustomPosition ? POPUP_POSITION_SURCHARGE_CENTS : 0;
  return {baseCents,positionCents,popupCents,popupPositionCents,totalCents:baseCents+positionCents+popupCents+popupPositionCents,areaPixels:width*height,packagePixels};
}
