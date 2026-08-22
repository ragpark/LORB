/** Accept module messages only from the exact package origin and iframe window. */
export function originAllowed(origin:string,configured:string,moduleOrigin:string,source:unknown,iframeWindow:unknown){
 return origin!=="*"&&configured.split(",").includes(origin)&&origin===moduleOrigin&&source===iframeWindow;
}

/**
 * Authenticates the single `module.hello` that opens a module's MessageChannel.
 *
 * A module runs in a sandbox without `allow-same-origin`, so its document has an opaque origin that
 * the browser reports as the literal string "null". An origin comparison therefore cannot identify a
 * correctly sandboxed module, and window identity alone is not enough either: `event.source` proves
 * which *browsing context* sent the message, not which *document* is currently loaded in it. A
 * redirect or a self-navigation keeps the same WindowProxy and the same opaque origin, while
 * `frame.src` still reflects the pinned package URL.
 *
 * So the handshake is bound to a per-launch nonce the shell places in the iframe URL fragment. Only a
 * document the shell itself navigated to receives it; a document that later replaces it in the same
 * browsing context does not. All three checks must pass — window identity, origin shape, and the
 * nonce — and a wildcard origin is refused outright.
 *
 * This is not a defence against a package that is itself hostile: such a package already holds the
 * launch context legitimately. It bounds *which document* may receive it. The remaining gap — a
 * `package_url` that 302s off-origin on the very first load, carrying the fragment with it — cannot be
 * detected from inside the embedding page and is noted for review.
 */
export function handshakeAllowed(origin:string,moduleOrigin:string,source:unknown,iframeWindow:unknown,presentedNonce:unknown,expectedNonce:string){
 if(origin==="*"||source!==iframeWindow)return false;
 if(origin!=="null"&&origin!==moduleOrigin)return false;
 if(typeof presentedNonce!=="string"||presentedNonce.length===0||expectedNonce.length===0)return false;
 return presentedNonce===expectedNonce;
}

/** Query-string-free fragment carrying the handshake nonce to the document the shell navigates to. */
export const HANDSHAKE_FRAGMENT_KEY="lorb_handshake";
export function handshakeNonceFrom(hash:string):string|undefined{
 return new RegExp(`(?:^#|&)${HANDSHAKE_FRAGMENT_KEY}=([^&]+)`).exec(hash)?.[1];
}
