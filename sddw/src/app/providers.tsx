import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicClientApplication } from '@azure/msal-browser';
import { loadRuntimeConfig, type RuntimeConfig } from './runtimeConfig';
import { createMsal, createTokenProvider } from '@/auth/msal';
import { useCurrentUser } from '@/auth/useCurrentUser';
import { createGraphClient, type GraphClient } from '@/services/graph/graphClient';
import { createRepository } from '@/services/storage/createRepository';
import type { SpecificationRepository } from '@/services/storage/SpecificationRepository';
import { createCompanionClient } from '@/services/companion/createCompanionClient';
import type { CompanionClient } from '@/services/companion/types';
import type { Principal } from '@/domain/authorization';
import { Spinner } from '@/components/nebula';

interface Services { config: RuntimeConfig; repo: SpecificationRepository; companion: CompanionClient; graph: GraphClient | null; msal: PublicClientApplication | null }
const ServicesContext = createContext<Services | null>(null);
const PrincipalContext = createContext<Principal | null>(null);

export function useServices(): Services { const s = useContext(ServicesContext); if (!s) throw new Error('Services not ready'); return s; }
export function useRepository() { return useServices().repo; }
export function useCompanion() { return useServices().companion; }
export function usePrincipal(): Principal { const p = useContext(PrincipalContext); if (!p) throw new Error('Principal not ready'); return p; }

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } });

export function AppProviders({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<Services | null>(null);
  useEffect(() => {
    loadRuntimeConfig().then((config) => {
      const msal = createMsal(config);
      const getToken = createTokenProvider(msal);
      const graph = msal ? createGraphClient(getToken) : null;
      setServices({ config, msal, graph, repo: createRepository(config, getToken), companion: createCompanionClient(config, getToken) });
    });
  }, []);
  if (!services) return <div className="p-8"><Spinner label="Loading configuration" /></div>;
  return (
    <QueryClientProvider client={queryClient}>
      <ServicesContext.Provider value={services}>
        <PrincipalGate services={services}>{children}</PrincipalGate>
      </ServicesContext.Provider>
    </QueryClientProvider>
  );
}

function PrincipalGate({ services, children }: { services: Services; children: ReactNode }) {
  const principal = useCurrentUser(services.msal, services.graph);
  const value = useMemo(() => principal, [principal]);
  if (!value) return <div className="p-8"><Spinner label="Signing in" /></div>;
  return <PrincipalContext.Provider value={value}>{children}</PrincipalContext.Provider>;
}
