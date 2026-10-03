import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AboutPage } from "./pages/AboutPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SourcesPage } from "./pages/SourcesPage";

export function App() {
  return <Routes><Route element={<Layout />}>
    <Route index element={<OverviewPage />} />
    <Route path="applications" element={<ApplicationsPage />} />
    <Route path="review" element={<ReviewPage />} />
    <Route path="sources" element={<SourcesPage />} />
    <Route path="about" element={<AboutPage />} />
    <Route path="*" element={<NotFoundPage />} />
  </Route></Routes>;
}
