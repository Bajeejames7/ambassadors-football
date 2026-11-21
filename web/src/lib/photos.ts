// Background photos for each screen, from Ambassadors Football Kenya's own
// website (ambassadorsfootball.org/kenya). They load from there and the
// service worker keeps a copy on the phone, so they still show offline.
// If one can't load, the app's own hero.jpg shows underneath, then plain navy.

const UP = "https://ambassadorsfootball.org/wp-content/uploads/";

export const PHOTOS = {
  kidsPlaying: `${UP}2026/01/kids-playing-football-outside-in-kenya-1024x768.jpg`,
  coachTraining: `${UP}2026/01/coach-training-in-kenya-1024x768.jpg`,
  playerKicking: `${UP}2026/01/af-kenya-youth-team-player-kicking-the-ball-during-a-gam-1024x768.jpg`,
  imaraGame: `${UP}2025/03/fc-imara-game-in-kenya-1024x576.jpg`,
  rosslynHuddle: `${UP}2025/03/fc-rosslyn-team-huddle-1024x576.jpg`,
  campStudy: `${UP}2026/01/toward-the-goal-study-during-summer-camp-in-kenya-1024x768.jpg`,
  outreach: `${UP}2026/01/ambassadors-football-community-outreach-in-kenya-v2-1024x768.jpg`,
  bibleLesson: `${UP}2026/01/leading-a-bible-lesson-during-a-soccer-ministry-tour-in-kenya-819x1024.jpg`,
} as const;

export type PhotoKey = keyof typeof PHOTOS;

export const cssPhoto = (key: PhotoKey) => `url("${PHOTOS[key]}")`;

/** Photo for a whole screen, by its address in the app. */
export function photoForPath(path: string, role?: string): PhotoKey {
  if (path.startsWith("/creator")) return "coachTraining";
  if (path.startsWith("/schedule")) return "imaraGame";
  if (path.startsWith("/field") || /^\/s\/[^/]+\/field/.test(path)) return "playerKicking";
  if (path.startsWith("/s/")) return "playerKicking";
  if (path.startsWith("/players/")) return "playerKicking";
  if (path.startsWith("/register")) return "campStudy";
  if (path.includes("fees")) return "outreach";
  if (path.startsWith("/child/")) return "kidsPlaying";
  if (path.startsWith("/notifications")) return "rosslynHuddle";
  if (path.startsWith("/account")) return "bibleLesson";
  return role === "parent" ? "outreach" : "kidsPlaying";
}

/** Each school or club gets its own photo where the site has one. */
export function photoForSchool(name: string): PhotoKey {
  if (/imara|icc/i.test(name)) return "imaraGame";
  if (/rosslyn/i.test(name)) return "rosslynHuddle";
  if (/daniel/i.test(name)) return "playerKicking";
  return "kidsPlaying";
}

/** Inside a school page, the tab decides; Sessions shows the school's own photo. */
export function photoForHubTab(tab: string, schoolName: string): PhotoKey {
  switch (tab) {
    case "players": return "playerKicking";
    case "reports": return "coachTraining";
    case "mentorship": return "bibleLesson";
    case "tally": return "campStudy";
    case "payments": return "outreach";
    case "people": return "coachTraining";
    case "setup": return "coachTraining";
    default: return photoForSchool(schoolName);
  }
}
