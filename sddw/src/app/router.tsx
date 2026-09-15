import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { CataloguePage } from '@/features/catalogue/CataloguePage';
import { SpecificationPage } from '@/features/specification/SpecificationPage';
import { ReviewWorkspacePage } from '@/features/review/ReviewWorkspacePage';
import { CertificationPage } from '@/features/certification/CertificationPage';
import { DeliveryPackPage } from '@/features/delivery/DeliveryPackPage';
import { CertificationQueuePage, DeliveryQueuePage, ReviewsQueuePage } from '@/features/queues';

export const router = createBrowserRouter([
  {
    path: '/', element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'specs', element: <CataloguePage /> },
      { path: 'specs/:id', element: <SpecificationPage /> },
      { path: 'specs/:id/review', element: <ReviewWorkspacePage /> },
      { path: 'specs/:id/certification', element: <CertificationPage /> },
      { path: 'specs/:id/delivery', element: <DeliveryPackPage /> },
      { path: 'reviews', element: <ReviewsQueuePage /> },
      { path: 'certification', element: <CertificationQueuePage /> },
      { path: 'delivery', element: <DeliveryQueuePage /> },
      { path: '*', element: <div className="p-8 text-ink-muted">Page not found.</div> },
    ],
  },
]);
