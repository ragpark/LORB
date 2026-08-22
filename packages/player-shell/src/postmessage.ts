/**
 * Accept module messages only from the iframe the shell itself navigated.
 *
 * A module runs in a sandbox without `allow-same-origin` (see the enforced anti-requirements), so its
 * document has an *opaque* origin. The browser reports that to the receiver as the literal string
 * "null", and it can never equal the package origin — so an origin comparison alone can never
 * authenticate a correctly sandboxed module.
 *
 * For that one case the shell falls back to window identity: `event.source` is a live reference the
 * browser supplies, and no other document can make it equal our `frame.contentWindow`. That is a
 * stronger check than a claimed origin string, not a weaker one. A wildcard is still refused
 * outright, and a *concrete* origin must still match the pinned package origin exactly.
 */
export function originAllowed(origin:string,configured:string,moduleOrigin:string,source:unknown,iframeWindow:unknown){
 if(origin==="*"||source!==iframeWindow)return false;
 if(origin==="null")return true;
 return configured.split(",").includes(origin)&&origin===moduleOrigin;
}
