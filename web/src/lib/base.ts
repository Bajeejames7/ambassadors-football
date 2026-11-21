/** Where the app is served: "/" on its own, "/ambassadors/" inside the Rafiki server. */
export const BASE: string = import.meta.env.BASE_URL;

/** A file from web/public, e.g. asset("logo.jpg"). */
export const asset = (path: string) => BASE + path.replace(/^\//, "");
