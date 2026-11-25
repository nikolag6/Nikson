import type { Movie } from "./types";

const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

function isStrongTitleMatch(query: string, candidate: string) {
  const q = normalize(query), c = normalize(candidate);
  if (!q || !c) return false;
  if (q === c) return true;
  const a = new Set(q.split(" ")), b = new Set(c.split(" "));
  const overlap = [...a].filter(token => b.has(token)).length;
  return overlap / Math.max(a.size, b.size) >= 0.92;
}

type ItunesResult = {
  trackName?: string;
  collectionName?: string;
  artworkUrl100?: string;
};
type ItunesResponse = { results?: ItunesResult[] };

function searchItunes(term: string, media: "movie" | "tvShow"): Promise<ItunesResponse> {
  return new Promise((resolve, reject) => {
    const callbackName = `__coverSearch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const root = window as unknown as Record<string, unknown>;
    const callback = (data: ItunesResponse) => {
      cleanup();
      resolve(data);
    };
    let timer = 0;
    const script = document.createElement("script");
    const cleanup = () => {
      window.clearTimeout(timer);
      script.remove();
      delete root[callbackName];
    };
    root[callbackName] = callback;
    const params = new URLSearchParams({
      term, country: "pl", media,
      entity: media === "movie" ? "movie" : "tvSeason",
      limit: "20", callback: callbackName
    });
    script.src = `https://itunes.apple.com/search?${params.toString()}`;
    script.onerror = () => { cleanup(); reject(new Error("iTunes lookup failed")); };
    timer = window.setTimeout(() => { cleanup(); reject(new Error("iTunes lookup timed out")); }, 12000);
    document.body.appendChild(script);
  });
}

async function bookCover(title: string): Promise<string> {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:${title}`)}&maxResults=10&printType=books`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      const items = Array.isArray(data.items) ? data.items : [];
      const match = items.find((item: any) => isStrongTitleMatch(title, item.volumeInfo?.title || ""));
      const image = match?.volumeInfo?.imageLinks?.thumbnail || match?.volumeInfo?.imageLinks?.smallThumbnail;
      if (image) return String(image).replace(/^http:/, "https:").replace("&zoom=1", "&zoom=2");
    }
  } catch { /* try the next public catalogue */ }

  try {
    const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=10&fields=title,cover_i`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      const docs = Array.isArray(data.docs) ? data.docs : [];
      const match = docs.find((item: any) => isStrongTitleMatch(title, item.title || "") && item.cover_i);
      if (match?.cover_i) return `https://covers.openlibrary.org/b/id/${match.cover_i}-L.jpg`;
    }
  } catch { /* no cover found */ }
  return "";
}

async function movieCover(title: string): Promise<string> {
  try {
    const data = await searchItunes(title, "movie");
    const match = (data.results || []).find(item => isStrongTitleMatch(title, item.trackName || ""));
    if (match?.artworkUrl100) return match.artworkUrl100.replace(/^http:/, "https:").replace(/100x100bb/, "600x900bb");
  } catch { /* no result */ }
  return "";
}

async function tvCover(title: string): Promise<string> {
  try {
    const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`);
    if (response.ok) {
      const results = await response.json();
      const match = Array.isArray(results) ? results.find((item: any) => isStrongTitleMatch(title, item.show?.name || "")) : null;
      if (match?.show?.image?.original || match?.show?.image?.medium) return match.show.image.original || match.show.image.medium;
    }
  } catch { /* try Apple TV catalogue */ }

  try {
    const data = await searchItunes(title, "tvShow");
    const match = (data.results || []).find(item => isStrongTitleMatch(title, item.collectionName || "") || isStrongTitleMatch(title, item.trackName || ""));
    if (match?.artworkUrl100) return match.artworkUrl100.replace(/^http:/, "https:").replace(/100x100bb/, "600x900bb");
  } catch { /* no result */ }
  return "";
}

export async function findCover(movie: Movie): Promise<string> {
  const type = String(movie.frontmatter?.media_type || "movie");
  if (type === "book") return bookCover(movie.title);
  if (type === "tv") return tvCover(movie.title);
  return movieCover(movie.title);
}
