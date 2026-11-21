import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { queryClient } from "./lib/queries";
import { BASE } from "./lib/base";
import { captureInstallPrompt } from "./lib/install";
import { IN_PARENT_PORTAL, ROUTER_BASE, STAFF_PATH, PORTAL_PATH, takePreviewHandoff, usePortalManifest } from "./lib/portal";

takePreviewHandoff();
usePortalManifest();
captureInstallPrompt();
document.documentElement.style.setProperty("--hero-url", `url("${BASE}hero.jpg")`);
import { Layout } from "./components/Layout";
import { DeleteAccountInfoPage, LoginPage, PrivacyPage, SignupPage } from "./pages/Auth";
import { ChildRoute, FeesPage, ParentHome } from "./pages/Parent";
import { RegisterPage } from "./pages/Register";
import { ParentPreview } from "./pages/Creator";
import { WrongDoor } from "./pages/Portal";
import { FieldIndex, SchedulePage, SessionPage, StaffHome } from "./pages/Staff";
import { FieldCheckIn, QueuePage } from "./pages/Field";
import { IntramuralHub, PlayerPage } from "./pages/Hub";
import { CreatorControl } from "./pages/Creator";
import { AnalyticsPage } from "./pages/Analytics";
import { AccountPage, ChooseOwnPassword, NotificationsPage } from "./pages/Account";

function Routed() {
  const { me } = useAuth();
  if (!me) {
    return (
      <Routes>
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/delete-account" element={<DeleteAccountInfoPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  // Two doors: parents live under /parents; staff never use the parent portal.
  const parent = me.role === "parent";
  if (parent && !IN_PARENT_PORTAL) {
    location.replace(`${PORTAL_PATH}/`);
    return null;
  }
  if (!parent && IN_PARENT_PORTAL) return <WrongDoor />;
  if (me.mustChangePassword) return <ChooseOwnPassword />;
  return (
    <Routes>
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/delete-account" element={<DeleteAccountInfoPage />} />
      <Route element={<Layout />}>
        <Route index element={parent ? <ParentHome /> : <StaffHome />} />
        <Route path="schedule" element={<SchedulePage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="account" element={<AccountPage />} />
        {parent ? (
          <>
            <Route path="child/:id" element={<ChildRoute />} />
            <Route path="child/:id/fees" element={<FeesPage />} />
            <Route path="fees" element={<FeesPage />} />
            <Route path="register" element={<RegisterPage />} />
          </>
        ) : (
          <>
            {/* Parents never get these routes: no school switcher, polls or admin portals. */}
            <Route path="field" element={<FieldIndex />} />
            <Route path="field/queue" element={<QueuePage />} />
            <Route path="i/:id" element={<IntramuralHub />} />
            <Route path="i/:id/:tab" element={<IntramuralHub />} />
            <Route path="s/:id" element={<SessionPage />} />
            <Route path="s/:id/field" element={<FieldCheckIn />} />
            <Route path="players/:id" element={<PlayerPage />} />
            {me.isSuperAdmin && <Route path="analytics" element={<AnalyticsPage />} />}
            {me.isSuperAdmin && <Route path="creator" element={<CreatorControl />} />}
            {me.isSuperAdmin && <Route path="creator/:tab" element={<CreatorControl />} />}
            {me.isSuperAdmin && <Route path="creator/parents/:id/preview" element={<ParentPreview />} />}
          </>
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter basename={ROUTER_BASE}>
          <Routed />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }));
}
