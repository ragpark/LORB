/** Accept module messages only from the exact package origin and iframe window. */
export function originAllowed(origin:string,configured:string,moduleOrigin:string,source:unknown,iframeWindow:unknown){
 return origin!=="*"&&configured.split(",").includes(origin)&&origin===moduleOrigin&&source===iframeWindow;
}
