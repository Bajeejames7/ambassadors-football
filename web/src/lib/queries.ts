import { QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { cached, onSynced } from "./offline";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, err: any) => err?.status === 0 ? false : n < 1, staleTime: 15_000, refetchOnWindowFocus: true, networkMode: "always" },
    mutations: { networkMode: "always" },
  },
});

onSynced(() => void queryClient.invalidateQueries());

export interface Intramural {
  id: number;
  slug: string;
  name: string;
  shortCode: string;
  kind: "intramural" | "club";
  color: string;
  logo: string;
  coordinatorName: string;
  sessionWeekday: number;
  sessionStart: string;
  sessionEnd: string;
  location: string;
  dressCode: string;
  availabilityOptions: { id: string; label: string; tone: "good" | "ok" | "bad" }[];
  defaultRoles: string[];
  defaultSchedule: { time: string; activity: string }[];
  teams: { id: string; name: string; color: string }[];
  categories: string[];
  countryId: number;
  countryName: string;
  currency: string;
  timeZone: string;
  mpesa: boolean;
  dayLabel: string;
  myPermissions: string[];
  nextSession?: Session | null;
  airtable?: any;
  equipment?: { id: number; name: string; expected: number; active: boolean }[];
}

export interface Session {
  id: number;
  intramuralId: number;
  date: string;
  kind: "training" | "match" | "tournament";
  title: string;
  startTime: string;
  endTime: string;
  location: string;
  dressCode: string;
  opponent: string;
  travelNotes: string;
  schedule: { time: string; activity: string }[];
  roles?: { role: string; userId: number | null; name?: string }[];
  cancelled: boolean;
  version: number;
  dayLabel: string;
  timeLabel: string;
  myAnswer?: string | null;
  pollAnswers?: number;
  intramuralName?: string;
  color?: string;
  shortCode?: string;
}

export const useIntramurals = () => useQuery({ queryKey: ["intramurals"], queryFn: () => cached<Intramural[]>("/intramurals") });
export const useIntramural = (id: number) => useQuery({ queryKey: ["intramural", id], queryFn: () => cached<Intramural>(`/intramurals/${id}`), enabled: id > 0 });
export const useUpcoming = () => useQuery({ queryKey: ["upcoming"], queryFn: () => cached<Session[]>("/sessions/upcoming") });
export const useNotifications = () => useQuery({ queryKey: ["notifications"], queryFn: () => cached<any[]>("/notifications"), refetchInterval: 60_000 });

export { api };
