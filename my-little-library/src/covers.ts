import type { Movie } from "./types";

const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ").trim();

function titleScore(query: string, candidate: string): number {
  const q = normalize(query), c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return Math.min(q.length, c.length) / Math.max(q.length, c.length) * 0.98;
  const a = [...new Set(q.split(" ").filter(token => token.length > 1))];
  const b = new Set(c.split(" ").filter(token => token.length > 1));
  if (!a.length) return 0;
  const overlap = a.filter(token => b.has(token)).length / a.length;
  const distinctive = a.filter(token => token.length >= 4);
  const distinctiveOverlap = distinctive.length ? distinctive.filter(token => b.has(token)).length / distinctive.length : overlap;
  return overlap * 0.65 + distinctiveOverlap * 0.35;
}

function getMetadata(movie: Movie) {
  const fm = movie.frontmatter || {};
  const author = String(fm.author || fm.authors || "");
  const year = String(movie.year || fm.year || "");
  const aliases = [
    fm.original_title, fm.originalTitle, fm.alternative_title, fm.alternativeTitle,
    fm.original_name, fm.originalName, fm.alternative_names
  ].flatMap(value => Array.isArray(value) ? value.map(String) : value ? [String(value)] : []);
  return { author, year, aliases };
}

function bestMatch<T>(items: T[], title: string, getTitle: (item: T) => string, author = "", year = ""): T | undefined {
  return items
    .map(item => {
      const candidate = getTitle(item);
      let score = titleScore(title, candidate);
      if (author) {
        const normalizedAuthor = normalize(author);
        const authorText = normalize(JSON.stringify(item));
        if (normalizedAuthor && authorText.includes(normalizedAuthor)) score += 0.12;
      }
      if (year) {
        const itemText = JSON.stringify(item);
        if (itemText.includes(year)) score += 0.025;
      }
      return { item, score };
    })
    .filter(result => result.score >= 0.62)
    .sort((a, b) => b.score - a.score)[0]?.item;
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
    let timer = 0;
    const script = document.createElement("script");
    const cleanup = () => {
      window.clearTimeout(timer);
      script.remove();
      delete root[callbackName];
    };
    root[callbackName] = (data: ItunesResponse) => { cleanup(); resolve(data); };
    const params = new URLSearchParams({
      term, country: "pl", media,
      entity: media === "movie" ? "movie" : "tvSeason",
      limit: "30", callback: callbackName
    });
    script.src = `https://itunes.apple.com/search?${params.toString()}`;
    script.onerror = () => { cleanup(); reject(new Error("iTunes lookup failed")); };
    timer = window.setTimeout(() => { cleanup(); reject(new Error("iTunes lookup timed out")); }, 12000);
    document.body.appendChild(script);
  });
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Catalogue lookup failed");
  return response.json();
}

async function bookCover(movie: Movie): Promise<string> {
  const { author, year, aliases } = getMetadata(movie);
  const queries = [movie.title, ...aliases].filter(Boolean);
  for (const query of queries) {
    try {
      const q = `intitle:${query}${author ? `+inauthor:${author}` : ""}`;
      const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20&printType=books`);
      const items = Array.isArray(data.items) ? data.items : [];
      const match = bestMatch(items, query, item => item.volumeInfo?.title || "", author, year);
      const image = match?.volumeInfo?.imageLinks?.thumbnail || match?.volumeInfo?.imageLinks?.smallThumbnail;
      if (image) return String(image).replace(/^http:/, "https:").replace("&zoom=1", "&zoom=2");
    } catch { /* continue with other catalogue/query */ }
  }
  for (const query of queries) {
    try {
      const params = new URLSearchParams({ title: query, limit: "30", fields: "title,author_name,first_publish_year,cover_i" });
      if (author) params.set("author", author);
      const data = await fetchJson(`https://openlibrary.org/search.json?${params}`);
      const docs = Array.isArray(data.docs) ? data.docs.filter((item: any) => item.cover_i) : [];
      const match = bestMatch(docs, query, item => item.title || "", author, year);
      if (match?.cover_i) return `https://covers.openlibrary.org/b/id/${match.cover_i}-L.jpg`;
    } catch { /* try next title variant */ }
  }
  return "";
}

async function movieCover(movie: Movie): Promise<string> {
  const { aliases, year } = getMetadata(movie);
  for (const query of [movie.title, ...aliases]) {
    try {
      const data = await searchItunes(query, "movie");
      const match = bestMatch(data.results || [], query, item => item.trackName || "", "", year);
      if (match?.artworkUrl100) return match.artworkUrl100.replace(/^http:/, "https:").replace(/100x100bb/, "600x900bb");
    } catch { /* try another title variant */ }
  }
  return "";
}

async function tvCover(movie: Movie): Promise<string> {
  const { aliases, year } = getMetadata(movie);
  for (const query of [movie.title, ...aliases]) {
    try {
      const results = await fetchJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
      const match = bestMatch(Array.isArray(results) ? results : [], query, item => item.show?.name || "", "", year);
      if (match?.show?.image?.original || match?.show?.image?.medium) return match.show.image.original || match.show.image.medium;
    } catch { /* try Apple TV catalogue */ }
    try {
      const data = await searchItunes(query, "tvShow");
      const match = bestMatch(data.results || [], query, item => item.collectionName || item.trackName || "", "", year);
      if (match?.artworkUrl100) return match.artworkUrl100.replace(/^http:/, "https:").replace(/100x100bb/, "600x900bb");
    } catch { /* try another title variant */ }
  }
  return "";
}

export async function findCover(movie: Movie): Promise<string> {
  const type = String(movie.frontmatter?.media_type || "movie");
  if (type === "book") return bookCover(movie);
  if (type === "tv") return tvCover(movie);
  return movieCover(movie);
}
