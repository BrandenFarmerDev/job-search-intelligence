import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { DashboardPage } from "./pages/DashboardPage";

export function App() {
  return <Routes><Route element={<Layout />}>
    <Route index element={<DashboardPage />} />
    <Route path="about" element={<HomePage />} />
    <Route path="*" element={<NotFoundPage />} />
  </Route></Routes>;
}
