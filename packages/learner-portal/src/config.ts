import {z} from 'zod';
import {ENVIRONMENT_LABELS,type EnvironmentLabel} from '@lorb/web-auth';
import { webEnv } from './runtime-env.js';
const environmentSchema=z.enum(ENVIRONMENT_LABELS as unknown as [EnvironmentLabel,...EnvironmentLabel[]]);
export type Environment=EnvironmentLabel;
export interface Config {runtimeApiBase:string;adminApiBase:string;runtimeIssuer:string;jwksUrl:string;playerShellOrigin:string;
 /** Development-only sign-in endpoint. Reachable only when environment is DEVELOPMENT. */
 developmentLoginUrl:string;identityIssuer:string;environment:Environment;allowedShellOrigins:ReadonlySet<string>;
 /** The identity provider, where one is configured. Its absence is what enables the development path. */
 oidc?:{issuer:string;clientId:string;redirectUri:string;audience?:string;scope?:string}}
export function readConfig(env:ImportMetaEnv=webEnv):Config{
 const environment=environmentSchema.parse(env.VITE_ENVIRONMENT_LABEL??'DEVELOPMENT');
 const runtimeApiBase=env.VITE_RUNTIME_API_BASE?.trim()||'http://localhost:3000/api/v1/runtime';
 // Derived, never configured separately: an issuer that can disagree with the API it belongs to is
 // a setting whose only reachable states are 'correct' and 'subtly wrong'.
 const runtimeIssuer=new URL(runtimeApiBase).origin;
 // Roster administration lives under a different path prefix from the learner-facing runtime routes.
 const adminApiBase=env.VITE_ADMIN_API_BASE?.trim()||`${new URL(runtimeApiBase).origin}/api/v1/admin`;
 const playerShellOrigin=env.VITE_PLAYER_SHELL_ORIGIN??'http://localhost:3200';
 const origins=(env.VITE_ALLOWED_SHELL_ORIGINS??playerShellOrigin).split(',').map(x=>x.trim()).filter(Boolean);
 if(!origins.length||origins.includes('*'))throw new Error('Shell origins must be an explicit allow-list.');
 const oidc=env.VITE_OIDC_ISSUER&&env.VITE_OIDC_CLIENT_ID
  ?{issuer:env.VITE_OIDC_ISSUER,clientId:env.VITE_OIDC_CLIENT_ID,redirectUri:env.VITE_OIDC_REDIRECT_URI??location.origin,audience:env.VITE_OIDC_AUDIENCE,scope:env.VITE_OIDC_SCOPE}
  :undefined;
 // A deployed portal must have a provider. Without this check a misconfigured deployment would fall
 // through to the development sign-in and hand out learner sessions to anyone who asked.
 if(!oidc&&environment!=='DEVELOPMENT')throw new Error('VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID are required outside a development environment.');
 return {runtimeApiBase,adminApiBase,runtimeIssuer,jwksUrl:env.VITE_JWKS_URL??'http://localhost:3000/api/v1/runtime/jwks',playerShellOrigin,developmentLoginUrl:env.VITE_DEVELOPMENT_LOGIN_URL??env.VITE_DEVELOPMENT_IDENTITY_LOGIN_URL??'http://localhost:4000/dev-login',identityIssuer:env.VITE_OIDC_ISSUER??env.VITE_DEVELOPMENT_IDENTITY_ISSUER??'http://localhost:4000',environment,allowedShellOrigins:new Set(origins),oidc};
}
