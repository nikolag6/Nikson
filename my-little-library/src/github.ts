import { stringify } from "yaml";
import type { Movie, Settings } from "./types";
import {
  MAX_RATING, MIN_RATING, RATING_STEP, isValidRating, sanitizeFilename
} from "./movies";

const API = "https://api.github.com";

export class GitHubError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

function headers(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

function cleanFolder(folder: string) {
  return folder.replace(/^\/+|\/+$/g, "");
}

function contentsUrl(s: Settings, relativePath = "") {
  const fullPath = [cleanFolder(s.folder), relativePath].filter(Boolean).join("/");
  const encoded = fullPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${API}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/${encoded}`;
}

// Turns raw GitHub API failures into messages the user can act on.
function friendlyMessage(status: number, apiMessage: string | undefined): string {
  const message = apiMessage || `GitHub API: ${status}`;

  switch (status) {
    case 401:
      return "GitHub rejected the token (invalid or expired). Create a new one and update it in Settings.";
    case 403:
      return /rate limit/i.test(message)
        ? "GitHub rate limit reached. Try again in a few minutes."
        : "The token is not allowed to do this. It needs Contents: Read and write on the data repository.";
    case 404:
      return "Not found. Check the username, repository, branch and folder in Settings (GitHub also answers 404 when the token cannot access the repository).";
    case 409:
      return "This note changed on GitHub after it was loaded. Refresh the library and try again.";
    case 422:
      return /sha/i.test(message)
        ? "A note with this title and year already exists. Edit that one or change the title or year."
        : message;
    default:
      return message;
  }
}

async function failFrom(response: Response): Promise<never> {
  let apiMessage: string | undefined;
  try {
    const data = await response.json();
    apiMessage = typeof data?.message === "string" ? data.message : undefined;
  } catch { /* response was not JSON */ }
  throw new GitHubError(friendlyMessage(response.status, apiMessage), response.status);
}

async function request(url: string, token: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers(token), ...(init?.headers || {}) },
  });
  if (!response.ok) return failFrom(response);
  return response.status === 204 ? null : response.json();
}

function repositoryContentsUrl(s: Settings, path: string) {
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${API}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/contents/${encoded}?ref=${encodeURIComponent(s.branch)}`;
}

function databasePath(s: Settings) {
  const parts = cleanFolder(s.folder).split("/").filter(Boolean);
  parts.pop();
  return [...parts, "library.json.gz"].join("/");
}

function databaseUrl(s: Settings) {
  return repositoryContentsUrl(s, databasePath(s));
}

async function readDatabase(s: Settings): Promise<{ entries: Movie[]; sha: string }> {
  const file = await request(databaseUrl(s), s.token);
  if (!file?.content || !file?.sha) {
    throw new Error("The private library database was not found. Check that the repository is private-data and the folder is Library/Database.");
  }
  const binary = atob(String(file.content).replace(/\s/g, ""));
  const compressed = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot open the compressed library file. Please update your browser.");
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const raw = await new Response(stream).text();
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) throw new Error("The private library database has an invalid format.");
  return {
    entries: (parsed.entries as Movie[]).filter(item =>
      item && typeof item.path === "string" && typeof item.title === "string"
    ).map(item => ({ ...item, sha: file.sha })),
    sha: file.sha
  };
}

async function writeDatabase(s: Settings, entries: Movie[], sha: string): Promise<string> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("This browser cannot update the compressed library file. Please update your browser.");
  }
  const payload = JSON.stringify({ version: 1, entries });
  const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  const content = btoa(binary);
  const written = await request(databaseUrl(s), s.token, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update personal library",
      content,
      sha,
      branch: s.branch
    })
  });
  return String(written?.content?.sha ?? "");
}

/** Loads the private compressed JSON database in one GitHub request. */
export async function loadMovies(s: Settings): Promise<Movie[]> {
  try {
    const database = await readDatabase(s);
    return database.entries;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) {
      throw new Error("library.json.gz was not found in your private-data repository. Check the repository and folder in Settings.");
    }
    throw e;
  }
}

export async function testGitHub(s: Settings) {
  await request(`${API}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`, s.token);
  await readDatabase(s);
}

function localTimestamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateCoverInBody(body: string, cover: string) {
  const imageLine = /^!\[cover(?:\|\d+)?\]\([^\n]*\)$/m;
  if (!cover) return body.replace(imageLine, "").trim();
  const markdownImage = `![cover|200](${cover})`;
  if (imageLine.test(body)) return body.replace(imageLine, markdownImage);
  return `${body.trim()}${body.trim() ? "\n\n" : ""}${markdownImage}`;
}

function relativeToFolder(path: string, folder: string) {
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
}

export type SaveResult = {
  /** The note as written, with the new blob SHA returned by GitHub. */
  movie: Movie;
  /** Previous path, when a changed title/year moved the note. */
  removedPath: string | null;
  /** Set when the note was saved but cleaning up the old file failed. */
  warning?: string;
};

export async function saveMovie(
  s: Settings,
  movie: Movie | null,
  values: { title: string; year: string; rating: string; poster: string; note: string; finishedOn?: string; mediaType?: "book" | "movie" | "tv" }
): Promise<SaveResult> {
  const title = sanitizeFilename(values.title);
  const year = values.year.trim();
  const mediaType = values.mediaType || (movie?.frontmatter?.media_type as "book" | "movie" | "tv") || "movie";
  if (!title) throw new Error("Enter a title (it cannot consist only of characters that are not allowed in file names).");
  if (year && !/^\d{4}$/.test(year)) throw new Error("Enter the year as YYYY, or leave it blank.");
  if (!isValidRating(values.rating)) {
    throw new Error(`Rating must be empty or between ${MIN_RATING} and ${MAX_RATING} in steps of ${RATING_STEP}.`);
  }

  const folder = cleanFolder(s.folder);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
  const targetPath = `${folder}/${mediaType}/${slug}.md`;
  const oldPath = movie?.path || "";
  const poster = values.poster.trim().replace(/^http:\/\//i, "https://");
  const database = await readDatabase(s);

  const frontmatter: Record<string, unknown> = movie ? { ...movie.frontmatter } : {
    tags: [mediaType],
    aliases: [],
    paused: false,
    dropped: false,
    watched: [],
    created: localTimestamp(),
  };
  frontmatter.media_type = mediaType;
  frontmatter.tags = Array.from(new Set([...((Array.isArray(frontmatter.tags) ? frontmatter.tags : []) as string[]), mediaType]));
  frontmatter.year = year ? Number(year) : null;
  frontmatter.rating = values.rating.trim() === "" ? null : Number(values.rating);
  frontmatter.cover = poster || null;
  if (values.finishedOn && /^\\d{4}-\\d{2}-\\d{2}$/.test(values.finishedOn)) {
    const dates = Array.isArray(frontmatter.watched) ? [...frontmatter.watched] : frontmatter.watched ? [frontmatter.watched] : [];
    const wikiDate = `[[${values.finishedOn}]]`;
    if (!dates.some(value => String(value).includes(values.finishedOn!))) dates.push(wikiDate);
    frontmatter.watched = dates;
  }
  frontmatter.last_modified = localTimestamp();

  const body = updateCoverInBody(values.note, poster).trim();
  const saved: Movie = {
    path: targetPath,
    sha: database.sha,
    title,
    year,
    rating: values.rating.trim(),
    poster,
    body,
    frontmatter,
  };

  const entries = database.entries.filter(entry => entry.path !== oldPath && entry.path !== targetPath);
  entries.push(saved);
  const newSha = await writeDatabase(s, entries, database.sha);
  saved.sha = newSha;
  return { movie: saved, removedPath: movie && oldPath !== targetPath ? oldPath : null };
}

export async function deleteMovie(s: Settings, movie: Movie) {
  const database = await readDatabase(s);
  const entries = database.entries.filter(entry => entry.path !== movie.path);
  if (entries.length === database.entries.length) return;
  await writeDatabase(s, entries, database.sha);
}
