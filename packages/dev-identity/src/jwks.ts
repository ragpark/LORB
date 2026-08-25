// The development provider publishes exactly one key. A real provider publishes a set and rotates it.
export const stubJwks=(key:unknown)=>({keys:[key]});
