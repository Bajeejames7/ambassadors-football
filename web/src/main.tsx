import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { queryClient } from "./lib/queries";
import { Layout } from "./components/Layout";
import { DeleteAccountInfoPage, LoginPage, PrivacyPage, SignupPage } from "./pages/Auth";
import { ChildRoute, FeesPage, ParentHome } from "./pages/Parent";
import { FieldIndex, SchedulePage, SessionPage, StaffHome } from "./pages/Staff";
import { FieldCheckIn, QueuePage } from "./pages/Field";
import { IntramuralHub, PlayerPage } from "./pages/Hub";
import { CreatorControl } from "./pages/Creator";
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
  if (me.mustChangePassword) return <ChooseOwnPassword />;
  const parent = me.role === "parent";
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
            {me.isSuperAdmin && <Route path="creator" element={<CreatorControl />} />}
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
        <BrowserRouter>
          <Routed />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
