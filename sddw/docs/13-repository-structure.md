# 13. Suggested Repository Structure

```
sdd-workbench/
├── README.md
├── Dockerfile                    # SIF node base, multi-stage, non-root, port 8080
├── .env.example                  # runtime configuration keys (no secrets)
├── package.json / package-lock.json
├── index.html
├── vite.config.ts  tsconfig.json  tailwind.config.ts  postcss.config.js
├── server/
│   └── index.mjs                 # static host: /health, /ready, /app-config.json, SPA fallback
├── docs/                         # this design pack (01–13) and ADRs
│   └── adr/
├── src/
│   ├── main.tsx  App.tsx  index.css
│   ├── app/                      # router, providers, runtime config
│   ├── auth/                     # MSAL setup, useCurrentUser, group → role mapping
│   ├── components/
│   │   ├── nebula/               # Nebula Design System adapters (Button, Card, Badge, Table, Tabs, Dialog…)
│   │   └── layout/               # AppShell, SideNav, TopBar
│   ├── domain/                   # pure: types, sections, lifecycle, completion, manifest, authorization
│   ├── features/
│   │   ├── dashboard/  catalogue/  specification/  assistant/
│   │   ├── review/  certification/  delivery/
│   │   └── */hooks.ts            # React Query hooks per feature
│   ├── services/
│   │   ├── http.ts               # fetch wrapper: auth, correlation, retry
│   │   ├── companion/            # CompanionClient (real + mock), types
│   │   ├── graph/                # Graph client helpers
│   │   └── storage/              # SpecificationRepository + sharepoint/ dataverse/ mock/
│   ├── mocks/                    # seed data for local development and demos
│   └── test/                     # vitest setup
└── tests/                        # unit tests (domain) and component tests
```

Conventions: feature folders own their pages, hooks and feature-specific components; anything shared by two features moves to `components/` or `domain/`. No feature imports another feature directly — they share through `domain/` and `services/`.
