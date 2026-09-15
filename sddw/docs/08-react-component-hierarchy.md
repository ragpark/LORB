# 8. React Component Hierarchy

Feature-sliced layout. Nebula Design System components are consumed through a thin adapter layer (`src/components/nebula`) so the design-system package can be upgraded or swapped without touching features.

```
<App>
└─ <AppProviders>                      MSAL, React Query, RuntimeConfig, Toast
   └─ <RouterProvider>
      └─ <AppShell>                    Nebula shell: <SideNav> <TopBar> <main> <AssistantDock?>
         ├─ /                          <DashboardPage>
         │    ├─ <StageSummaryCards>   one card per lifecycle stage
         │    ├─ <OpenBlockersList>
         │    ├─ <PendingReviewsList>
         │    ├─ <CertificationQueueTable>
         │    └─ <RecentlyModifiedList>
         ├─ /specs                     <CataloguePage>
         │    ├─ <CatalogueFilters>    ProductArea, Owner, Status, Tag, Stage
         │    ├─ <SpecificationTable>  sortable, paged  → <StagePill> <CompletionBar>
         │    └─ <NewSpecificationDialog>
         ├─ /specs/:id                 <SpecificationPage>
         │    ├─ <SpecificationHeader> id, title, metadata, <PromoteMenu> → <PromotionDialog>
         │    ├─ <SpecificationTabs>   Sections | Markdown | Manifest | History | Audit
         │    ├─ <SectionNav>          groups + sections with <CompletionIndicator>
         │    ├─ <SectionEditor>       switches on SectionKey
         │    │    ├─ <ProductIntentEditor> <PersonasEditor> <UserJourneysEditor>
         │    │    ├─ <RequirementsTableEditor>   (UX, Accessibility, NFRs)
         │    │    ├─ <ArchitectureEditor> <AdrListEditor> <IntegrationDesignEditor>
         │    │    ├─ <DataDesignEditor> <SecurityEditor> <PrivacyEditor>
         │    │    ├─ <ResponsibleAiEditor> <SafeguardingEditor>
         │    │    ├─ <EngineeringPlanEditor> <QaStrategyEditor>
         │    │    └─ <DevOpsStrategyEditor> <OperationalReadinessEditor>
         │    ├─ <MarkdownPreview> <ManifestPreview> <VersionHistory> <AuditTrail>
         │    └─ <AssistantPanel>      docked right
         │         ├─ <AssistantActionList>   section + spec actions
         │         ├─ <RunStatus>
         │         └─ <ProposalCard>          Accept / Edit / Reject
         ├─ /specs/:id/review          <ReviewWorkspacePage>
         │    ├─ <FindingCategoryTabs>
         │    ├─ <FindingsTable> → <FindingRow> <ResolveFindingDialog>
         │    └─ <ReviewerPanel>
         ├─ /specs/:id/certification   <CertificationPage>
         │    ├─ <ApprovalCard> x4 → <EvidenceList> <AddEvidenceDialog> <DecisionButtons>
         │    └─ <CertificationSummary>
         └─ /specs/:id/delivery        <DeliveryPackPage>
              ├─ <PackToolbar>         Generate, Export, Push
              ├─ <PackTypeTabs>
              └─ <DeliveryItemsTable>  traceability chips
```

## Cross-cutting

| Concern | Where |
|---|---|
| Data fetching / cache | `@tanstack/react-query` hooks in `src/features/*/hooks.ts` calling repository + companion clients |
| Domain rules | `src/domain/*` — pure functions, no React |
| Storage | `src/services/storage/SpecificationRepository.ts` interface; `sharepoint/`, `dataverse/`, `mock/` implementations; `createRepository(config)` factory |
| AI | `src/services/companion/CompanionClient.ts` typed operations; `MockCompanionClient` for local dev |
| Auth | `src/auth/msal.ts` (Graph/Dataverse tokens), `useCurrentUser` (from MSAL account) |
| Config | `/app-config.json` served by the Node host from environment variables; typed by `RuntimeConfig` |
| Design system | `src/components/nebula/*` adapters; Tailwind tokens mirror Nebula colour/spacing |
