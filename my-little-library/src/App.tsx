import { useEffect, useMemo, useRef, useState } from "react";
import {
  Film, Plus, Search, Settings as SettingsIcon, Star, X, BookOpen,
  RefreshCw, Github, LoaderCircle, Pencil, Trash2, Info,
  Image as ImageIcon, Clapperboard, Tv, LayoutDashboard,
  Library, ArrowRight, ChartNoAxesCombined, CalendarDays
} from "lucide-react";
import { deleteMovie, loadMovies, saveCoverUpdates, saveMovie, testGitHub } from "./github";
import { findCover } from "./covers";
import MovieDetails from "./MovieDetails";
import {
  MAX_RATING, MIN_RATING, PLATFORM_NAMES, RATING_OPTIONS, RATING_STEP,
  applyPending, getLastWatched, getRating, getTags, getWatchedDates,
  isBacklog, isValidRating, isWatched, getMediaType
} from "./movies";
import type { PendingChanges } from "./movies";
import type { Movie, Settings } from "./types";

const STORAGE_KEY = "media-app-settings";
const defaults: Settings = {
  owner: "nikolag6",
  repo: "private-data",
  branch: "main",
  folder: "Library/Database",
  token: ""
};

function MovieGrid({
  movies,
  onSelect
}: {
  movies: Movie[];
  onSelect: (movie: Movie) => void;
}) {
  return (
    <div className="movie-grid">
      {movies.map(movie => (
        <article className="movie-card" key={movie.path}>
          <button
            className="poster-button"
            onClick={() => onSelect(movie)}
            aria-label={`Show details: ${movie.title}`}
          >
            {movie.poster ? (
              <img
                src={movie.poster}
                alt={`Poster: ${movie.title}`}
                loading="lazy"
                onError={e => {
                  e.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <div className="poster-placeholder">
                <ImageIcon size={34} />
              </div>
            )}
            <span className="edit-overlay">
              <Info size={17} />
            </span>
          </button>

          <div className="movie-meta">
            <div className="movie-title" title={movie.title}>
              {movie.title}
            </div>
            <div className="movie-sub">
              <span>{movie.year || "—"}</span>
              <span className="rating">
                <Star size={13} fill="currentColor" />
                {getRating(movie)?.toFixed(0) ?? "—"}
              </span>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.repo === "media_lists" || saved.folder === "Movies/Database" || saved.folder === "Database") {
        saved.repo = "private-data";
        saved.folder = "Library/Database";
        saved.token = "";
      }
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  });

  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [query, setQuery] = useState("");

  // The index is rebuilt by GitHub Actions and lags behind writes. Changes we
  // made ourselves are kept in `pendingRef` and laid over the last loaded
  // index until the index catches up.
  const indexRef = useRef<Movie[]>([]);
  const pendingRef = useRef<PendingChanges>(new Map());
  const refreshSeq = useRef(0);
  const reconcileTimer = useRef<number | undefined>(undefined);
  const [pendingCount, setPendingCount] = useState(0);

  const [mediaSection, setMediaSection] = useState<"all" | "books" | "movies" | "tv">("all");
  const [movieView, setMovieView] = useState<"overview" | "library" | "statistics">("library");
  const [selectedStatsYear, setSelectedStatsYear] = useState(new Date().getFullYear());
  const [filter, setFilter] = useState<"all" | "watched" | "backlog">("all");
  const [selectedReleaseYear, setSelectedReleaseYear] = useState("all");
  const [sortBy, setSortBy] = useState<"recent" | "oldest" | "ratingHigh" | "ratingLow" | "title">("recent");
  const [minimumRating, setMinimumRating] = useState("all");

  const [showSettings, setShowSettings] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [editing, setEditing] = useState<Movie | null>(null);
  const [details, setDetails] = useState<Movie | null>(null);

  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [rating, setRating] = useState("");
  const [poster, setPoster] = useState("");
  const [note, setNote] = useState("");
  const [finishedOn, setFinishedOn] = useState("");
  const [author, setAuthor] = useState("");
  const [seasons, setSeasons] = useState("");
  const [coverMode, setCoverMode] = useState<"url" | "file">("url");
  const [entryMediaType, setEntryMediaType] = useState<"book" | "movie" | "tv">("movie");
  const [coverProgress, setCoverProgress] = useState<{ done: number; total: number } | null>(null);
  const [coverMessage, setCoverMessage] = useState("");

  const configured = Boolean(
    settings.owner && settings.repo && settings.folder && settings.token
  );

  const currentYear = new Date().getFullYear();
  const activeEntries = useMemo(() => {
    if (mediaSection === "all") return movies;
    const mediaType = mediaSection === "books" ? "book" : mediaSection === "movies" ? "movie" : "tv";
    return movies.filter(movie => getMediaType(movie) === mediaType);
  }, [movies, mediaSection]);
  const releaseYears = useMemo(() => [...new Set(activeEntries.flatMap(movie => getWatchedDates(movie).map(date => Number(date.slice(0, 4)))))].sort((x, y) => y - x), [activeEntries]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  function showMovies() {
    const { movies: merged, remaining } = applyPending(indexRef.current, pendingRef.current);
    pendingRef.current = remaining;
    setPendingCount(remaining.size);
    setMovies(merged);
  }

  async function refresh(options: { silent?: boolean } = {}) {
    if (!configured) {
      setShowSettings(true);
      return;
    }

    // Only the most recent request may update the screen, so a slow older
    // response cannot overwrite newer data.
    const seq = ++refreshSeq.current;

    if (!options.silent) {
      setLoading(true);
      setError("");
    }

    try {
      const indexMovies = await loadMovies(settings);
      if (seq !== refreshSeq.current) return;
      indexRef.current = indexMovies;
      showMovies();
    } catch (e) {
      if (!options.silent && seq === refreshSeq.current) {
        setError((e as Error).message);
      }
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  // After a write, re-check the index in the background (with growing delays,
  // about four minutes in total) until it contains our changes.
  const RECONCILE_DELAYS = [8000, 15000, 25000, 40000, 60000, 90000];

  function scheduleReconcile() {
    window.clearTimeout(reconcileTimer.current);
    let attempt = 0;

    const tick = () => {
      if (pendingRef.current.size === 0 || attempt >= RECONCILE_DELAYS.length) return;
      reconcileTimer.current = window.setTimeout(async () => {
        await refresh({ silent: true });
        tick();
      }, RECONCILE_DELAYS[attempt++]);
    };

    tick();
  }

  function registerChange(upsert: Movie | null, removedPath: string | null) {
    if (upsert) pendingRef.current.set(upsert.path, upsert);
    if (removedPath) pendingRef.current.set(removedPath, null);
    showMovies();
    scheduleReconcile();
  }

  useEffect(() => () => window.clearTimeout(reconcileTimer.current), []);

  useEffect(() => {
    if (configured) void refresh();
  }, []);

  const watchedMovies = useMemo(
    () => activeEntries.filter(isWatched),
    [activeEntries]
  );

  const yearlyWatchActivity = useMemo(() => {
    const counts = new Map<number, number>();

    activeEntries.forEach(movie => {
      getWatchedDates(movie).forEach(date => {
        const year = Number(date.slice(0, 4));
        counts.set(year, (counts.get(year) || 0) + 1);
      });
    });

    if (!counts.size) return [];

    const minYear = Math.min(...counts.keys());
    const maxYear = Math.max(...counts.keys());

    return Array.from(
      { length: maxYear - minYear + 1 },
      (_, i) => ({
        year: minYear + i,
        count: counts.get(minYear + i) || 0
      })
    );
  }, [activeEntries]);

  const releaseYearActivity = useMemo(() => {
    const counts = new Map<number, number>();

    activeEntries.forEach(movie => {
      if (!getWatchedDates(movie).length) return;

      const year = Number(movie.year);

      if (!Number.isInteger(year) || year < 1888 || year > currentYear + 5) {
        return;
      }

      counts.set(year, (counts.get(year) || 0) + 1);
    });

    if (!counts.size) return [];

    const minYear = Math.min(...counts.keys());
    const maxYear = Math.max(...counts.keys());

    return Array.from(
      { length: maxYear - minYear + 1 },
      (_, i) => ({
        year: minYear + i,
        count: counts.get(minYear + i) || 0
      })
    );
  }, [activeEntries, currentYear]);

  const maxYearlyWatches = Math.max(
    1,
    ...yearlyWatchActivity.map(item => item.count)
  );

  const maxReleaseYearCount = Math.max(
    1,
    ...releaseYearActivity.map(item => item.count)
  );

  const backlogMovies = useMemo(
    () => activeEntries.filter(isBacklog),
    [activeEntries]
  );

  const recentlyWatched = useMemo(
    () => [...watchedMovies]
      .sort((a, b) => getLastWatched(b) - getLastWatched(a))
      .slice(0, 6),
    [watchedMovies]
  );

  const statsYears = useMemo(() => {
  const years = new Set(
    activeEntries.flatMap(movie =>
      getWatchedDates(movie).map(date => Number(date.slice(0, 4)))
    )
  );

  years.add(currentYear);

  return [...years].sort((a, b) => b - a);
  }, [activeEntries, currentYear]);

  const yearWatches = useMemo(() => {
    return activeEntries.flatMap(movie =>
      getWatchedDates(movie)
        .filter(date => Number(date.slice(0, 4)) === selectedStatsYear)
        .map(date => ({ movie, date }))
    );
  }, [activeEntries, selectedStatsYear]);

  const yearMovies = useMemo(() => {
    const unique = new Map<string, Movie>();

    yearWatches.forEach(({ movie }) => {
      unique.set(movie.path, movie);
    });

    return [...unique.values()];
  }, [yearWatches]);

  const monthlyActivity = useMemo(() => {
    return Array.from({ length: 12 }, (_, index) => ({
      month: index,
      count: yearWatches.filter(({ date }) =>
        Number(date.slice(5, 7)) === index + 1
      ).length
    }));
  }, [yearWatches]);

  const weekdayActivity = useMemo(() => {
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

    return days.map((day, index) => ({
      day,
      count: yearWatches.filter(({ date }) => {
        const [year, month, dayOfMonth] = date.split("-").map(Number);
        const weekday = new Date(year, month - 1, dayOfMonth).getDay();
        return (weekday + 6) % 7 === index;
      }).length
    }));
  }, [yearWatches]);

  const platformActivity = useMemo(() => {
    const platforms = ["apple", "hbo", "kino", "netflix", "prime", "stremio", "yt"];

    return platforms.map(platform => ({
      platform,
      count: yearMovies.filter(movie =>
        getTags(movie).includes(`movie/${platform}/${selectedStatsYear}`)
      ).length
    }));
  }, [yearMovies, selectedStatsYear]);

  const selectedYearReleaseActivity = useMemo(() => {
    const counts = new Map<number, number>();

    yearMovies.forEach(movie => {
      const year = Number(movie.year);
      if (!Number.isInteger(year)) return;

      counts.set(year, (counts.get(year) || 0) + 1);
    });

    if (!counts.size) return [];

    const minYear = Math.min(...counts.keys());
    const maxYear = Math.max(...counts.keys());

    return Array.from({ length: maxYear - minYear + 1 }, (_, i) => ({
      year: minYear + i,
      count: counts.get(minYear + i) || 0
    }));
  }, [yearMovies]);

  const maxSelectedYearReleaseCount = Math.max(
    1,
    ...selectedYearReleaseActivity.map(item => item.count)
  );

  // Unrated movies must not drag the average down, so they are left out.
  const ratedYearMovies = yearMovies.filter(movie => getRating(movie) !== null);
  const yearAverageRating = ratedYearMovies.length
    ? (
        ratedYearMovies.reduce((sum, movie) => sum + (getRating(movie) ?? 0), 0) /
        ratedYearMovies.length
      ).toFixed(2)
    : "—";

  const maxMonthlyCount = Math.max(1, ...monthlyActivity.map(item => item.count));
  const maxWeekdayCount = Math.max(1, ...weekdayActivity.map(item => item.count));
  const maxPlatformCount = Math.max(1, ...platformActivity.map(item => item.count));

  const bestMonth = monthlyActivity.reduce(
    (best, item) => item.count > best.count ? item : best,
    monthlyActivity[0]
  );

  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];

  const ratingDistribution = useMemo(() => {
    const distribution = RATING_OPTIONS.map(rating => ({
      rating,
      count: watchedMovies.filter(
        movie => getRating(movie) === rating
      ).length
    }));

    return distribution;
  }, [watchedMovies]);

  const maxRatingCount = Math.max(
    1,
    ...ratingDistribution.map(item => item.count)
  );

const averageRating = watchedMovies.length
  ? (
      watchedMovies.reduce(
        (sum, movie) => sum + (getRating(movie) || 0),
        0
      ) / watchedMovies.length
    ).toFixed(2)
  : "—";

  const visibleMovies = useMemo(() => {
    let result = [...activeEntries];

    if (filter === "watched") result = result.filter(isWatched);
    if (filter === "backlog") result = result.filter(isBacklog);
    if (selectedReleaseYear !== "all") result = result.filter(movie => getWatchedDates(movie).some(date => date.slice(0, 4) === selectedReleaseYear));
    if (minimumRating !== "all") {
      result = result.filter(movie => (getRating(movie) ?? 0) >= Number(minimumRating));
    }

    if (query.trim()) {
      const search = query.toLowerCase();
      result = result.filter(movie =>
        movie.title.toLowerCase().includes(search)
      );
    }

    result.sort((a, b) => {
      if (sortBy === "recent") return getLastWatched(b) - getLastWatched(a);
      if (sortBy === "oldest") return getLastWatched(a) - getLastWatched(b);
      if (sortBy === "ratingHigh") return (getRating(b) ?? 0) - (getRating(a) ?? 0);
      if (sortBy === "ratingLow") return (getRating(a) ?? 99) - (getRating(b) ?? 99);
      return a.title.localeCompare(b.title);
    });
    return result;
  }, [activeEntries, filter, query, selectedReleaseYear, sortBy, minimumRating]);

  function openDetails(movie: Movie) {
    setDetails(movie);
  }

  // Escape closes the details card.
  useEffect(() => {
    if (!details) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetails(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [details]);

  function openNew() {
    setEditorError("");
    setEditing(null);
    setTitle("");
    setYear("");
    setRating("");
    setPoster("");
    setNote("");
    setFinishedOn("");
    setAuthor("");
    setSeasons("");
    setCoverMode("url");
    setEntryMediaType(mediaSection === "books" ? "book" : mediaSection === "tv" ? "tv" : "movie");
    setShowEditor(true);
  }

  function openEdit(movie: Movie) {
    setEditorError("");
    setEditing(movie);
    setTitle(movie.title);
    setYear(movie.year);
    setRating(String(getRating(movie) ?? ""));
    setPoster(movie.poster);
    setNote(movie.body || "");
    setFinishedOn([...getWatchedDates(movie)].sort().reverse()[0] ?? "");
    setAuthor(String(movie.frontmatter?.author ?? ""));
    setSeasons(String(movie.frontmatter?.seasons ?? ""));
    setCoverMode("url");
    setEntryMediaType(getMediaType(movie));
    setShowEditor(true);
  }

  async function save() {
    // Errors are shown inside the editor: the page-level banner sits behind
    // the modal and would be invisible.
    setEditorError("");

    if (!title.trim()) {
      setEditorError("Enter a title.");
      return;
    }
    const effectiveMediaType = editing ? getMediaType(editing) : entryMediaType;
    if (effectiveMediaType === "book" && !author.trim()) {
      setEditorError("Enter the book author.");
      return;
    }

if (!isValidRating(rating)) {
      setEditorError(
        `Rating must be empty or between ${MIN_RATING} and ${MAX_RATING} in steps of ${RATING_STEP}.`
      );
      return;
    }

    setLoading(true);

    try {
      const result = await saveMovie(settings, editing, { title, year: editing?.year ?? "", rating, poster, note, finishedOn, author, seasons, mediaType: effectiveMediaType });
      registerChange(result.movie, result.removedPath);
      setShowEditor(false);
      if (result.warning) setError(result.warning);
    } catch (e) {
      setEditorError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function findMissingCovers() {
    const missing = movies.filter(movie => !movie.poster && !String(movie.frontmatter?.cover || "").startsWith("data:image/"));
    if (!missing.length) {
      setCoverMessage("Every title already has a cover.");
      return;
    }
    setCoverMessage("");
    setCoverProgress({ done: 0, total: missing.length });
    setLoading(true);
    let cursor = 0;
    let done = 0;
    const updates: Array<{ path: string; poster: string }> = [];
    const worker = async () => {
      while (cursor < missing.length) {
        const movie = missing[cursor++];
        try {
          const poster = await findCover(movie);
          if (poster) updates.push({ path: movie.path, poster });
        } catch { /* keep unmatched titles available for manual cover upload */ }
        done += 1;
        setCoverProgress({ done, total: missing.length });
      }
    };
    try {
      await Promise.all(Array.from({ length: 4 }, () => worker()));
      if (updates.length) {
        const saved = await saveCoverUpdates(settings, updates);
        saved.forEach(movie => pendingRef.current.set(movie.path, movie));
        showMovies();
        scheduleReconcile();
      }
      setCoverMessage(`Added ${updates.length} covers. ${missing.length - updates.length} titles still need a manual match.`);
    } catch (e) {
      setError(`Covers were found, but could not be saved: ${(e as Error).message}`);
    } finally {
      setCoverProgress(null);
      setLoading(false);
    }
  }

  async function remove(movie: Movie) {
    if (!confirm(`Delete "${movie.title}" from the repository?`)) return;

    setLoading(true);
    setError("");

    try {
      await deleteMovie(settings, movie);
      registerChange(null, movie.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon"><Film size={19} /></div>
          <span>my little <span className="accent">library</span></span>
        </div>

        <nav className="main-nav">
          <button className={movieView === "library" ? "active" : ""} onClick={() => setMovieView("library")}><Library size={16} /> Library</button>
          <button className={movieView === "statistics" ? "active" : ""} onClick={() => setMovieView("statistics")}><ChartNoAxesCombined size={16} /> Stats</button>
        </nav>
        <div className="header-actions">
          <button
            className="icon-btn"
            aria-label="Refresh library"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={18} />
          </button>
          <button
            className="icon-btn"
            aria-label="Settings"
            onClick={() => setShowSettings(true)}
          >
            <SettingsIcon size={19} />
          </button>
        </div>
      </header>

      <main>
        {mediaSection === "all" || mediaSection === "movies" || mediaSection === "books" || mediaSection === "tv" ? (
          <>
            <div className="section-nav category-nav" aria-label="Media type">
              {([["all","All"],["books","Books"],["movies","Movies"],["tv","TV Series"]] as const).map(([value,label]) => (
                <button key={value} className={mediaSection === value ? "selected" : ""} onClick={() => setMediaSection(value)}>{label}</button>
              ))}
            </div>

            <section className="intro intro-compact">
              <div>
                <h1>{mediaSection === "all" ? "A little home for everything you love." : mediaSection === "books" ? "A little home for the books you love." : mediaSection === "tv" ? "A little home for the shows you love." : "A little home for the movies you love."}</h1>
                <p className="subline">{activeEntries.length} titles, kept in one place.</p>
              </div>
              <button className="primary-btn" onClick={openNew}>
                <Plus size={16} /> Add {mediaSection === "all" ? "title" : mediaSection === "books" ? "book" : mediaSection === "tv" ? "show" : "movie"}
              </button>
            </section>

            {configured && (
              <div className="cover-tools">
                <button className="secondary-btn" onClick={() => void findMissingCovers()} disabled={loading || Boolean(coverProgress)}>
                  {coverProgress ? <LoaderCircle className="spin" size={16} /> : <ImageIcon size={16} />}
                  {coverProgress ? `Finding covers… ${coverProgress.done}/${coverProgress.total}` : "Find covers for my library"}
                </button>
                {coverMessage && <span className="help">{coverMessage}</span>}
              </div>
            )}

            {error && (
              <div className="error-banner">
                <span>{error}</span>
                <button onClick={() => setError("")}><X size={16} /></button>
              </div>
            )}

            {!configured ? (
              <div className="empty-state">
                <Github size={36} />
                <h2>Connect your library</h2>
                <p>Configure your private GitHub repository to get started.</p>
                <button className="primary-btn" onClick={() => setShowSettings(true)}>
                  Open settings
                </button>
              </div>
            ) : loading && movies.length === 0 ? (
              <div className="empty-state">
                <LoaderCircle className="spin" size={30} />
                <p>Loading your library...</p>
              </div>
            ) : movieView === "statistics" ? (
                <div className="year-statistics">
                  <div className="section-heading year-heading">
                    <div>
                      <p className="eyebrow">YOUR WATCHING HISTORY</p>
                      <h2>Year in Review</h2>
                    </div>

                    <select
                      className="year-select"
                      value={selectedStatsYear}
                      onChange={e => setSelectedStatsYear(Number(e.target.value))}
                    >
                      {statsYears.map(year => (
                        <option key={year} value={year}>{year}</option>
                      ))}
                    </select>
                  </div>

                  <div className="stats-grid">
                    <article className="stat-card">
                      <div className="stat-icon"><Film size={19} /></div>
                      <p className="stat-label">Unique titles</p>
                      <div className="stat-value">{yearMovies.length}</div>
                    </article>

                    <article className="stat-card">
                      <div className="stat-icon"><Clapperboard size={19} /></div>
                      <p className="stat-label">Total finishes</p>
                      <div className="stat-value">{yearWatches.length}</div>
                    </article>

                    <article className="stat-card">
                      <div className="stat-icon"><Star size={19} /></div>
                      <p className="stat-label">Average rating</p>
                      <div className="stat-value">{yearAverageRating}</div>
                    </article>

                    <article className="stat-card">
                      <div className="stat-icon"><CalendarDays size={19} /></div>
                      <p className="stat-label">Best month</p>
                      <div className="stat-value best-month">
                        {bestMonth.count ? monthNames[bestMonth.month] : "—"}
                      </div>
                    </article>
                  </div>

                  <section className="analytics-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">WATCHING HABITS</p>
                        <h2>Monthly activity</h2>
                      </div>
                      <span className="chart-total">{yearWatches.length} watches</span>
                    </div>

                    <div className="monthly-chart">
                      {monthlyActivity.map(item => (
                        <div className="monthly-column" key={item.month}>
                          <span className="chart-count">{item.count || ""}</span>
                          <div className="monthly-bar-track">
                            <div
                              className="monthly-bar"
                              style={{
                                height: `${item.count / maxMonthlyCount * 100}%`
                              }}
                            />
                          </div>
                          <span className="chart-label">{monthNames[item.month]}</span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="analytics-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">WATCHING HABITS</p>
                        <h2>Activity by weekday</h2>
                      </div>
                    </div>

                    <div className="weekday-chart">
                      {weekdayActivity.map(item => (
                        <div className="weekday-row" key={item.day}>
                          <span>{item.day}</span>
                          <div className="weekday-track">
                            <div
                              className="weekday-bar"
                              style={{
                                width: `${item.count / maxWeekdayCount * 100}%`
                              }}
                            />
                          </div>
                          <strong>{item.count}</strong>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="analytics-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">WHERE YOU WATCH</p>
                        <h2>Platforms</h2>
                      </div>
                    </div>

                    {mediaSection === "movies" && <div className="platform-chart">
                      {platformActivity.map(item => (
                        <div className="weekday-row" key={item.platform}>
                          <span>{PLATFORM_NAMES[item.platform] ?? item.platform}</span>
                          <div className="weekday-track">
                            <div
                              className="weekday-bar"
                              style={{
                                width: `${item.count / maxPlatformCount * 100}%`
                              }}
                            />
                          </div>
                          <strong>{item.count}</strong>
                        </div>
                      ))}
                    </div>}
                  </section>

                  <section className="analytics-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">COLLECTION HISTORY</p>
                        <h3>Titles by release year</h3>
                      </div>
                    </div>

                    {selectedYearReleaseActivity.length ? (
                      <div className="year-horizontal-chart">
                        <div className="horizontal-bars">
                          {selectedYearReleaseActivity.map(item => (
                            <div
                              className="horizontal-bar-column"
                              key={item.year}
                              title={`${item.year}: ${item.count} titles`}
                            >
                              <div className="horizontal-bar-track">
                                <div
                                  className="horizontal-bar"
                                  style={{
                                    height: `${item.count / maxSelectedYearReleaseCount * 100}%`
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="horizontal-axis">
                          <span>{selectedYearReleaseActivity[0]?.year}</span>
                          <span>{selectedYearReleaseActivity[selectedYearReleaseActivity.length - 1]?.year}</span>
                        </div>
                      </div>
                    ) : (
                      <p className="chart-empty">No release-year data available.</p>
                    )}
                  </section>

                  <section className="analytics-section">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">YOUR COLLECTION</p>
                        <h2>Titles finished in {selectedStatsYear}</h2>
                      </div>
                      <span className="chart-total">{yearMovies.length} titles</span>
                    </div>

                    {yearMovies.length ? (
                      <MovieGrid movies={yearMovies} onSelect={openDetails} />
                    ) : (
                      <div className="empty-state compact">
                        <Film size={30} />
                        <p>No titles finished in this year.</p>
                      </div>
                    )}
                  </section>
                </div>
              ) : (
                <>
                  <div className="toolbar">
                  <div className="searchbox">
                    <Search size={17} />
                    <input
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      placeholder="Search your library..."
                    />
                  </div>
                  <span className="count">
                    {visibleMovies.length} / {activeEntries.length}
                  </span>
                  <label className="library-select-label">
                    <span>Sort</span>
                    <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}>
                      <option value="recent">Recently finished</option>
                      <option value="oldest">Oldest finished</option>
                      <option value="ratingHigh">Highest rated</option>
                      <option value="ratingLow">Lowest rated</option>
                      <option value="title">Title</option>
                    </select>
                  </label>
                  <label className="library-select-label rating-filter">
                    <span>Rating</span>
                    <select value={minimumRating} onChange={e => setMinimumRating(e.target.value)}>
                      <option value="all">Any</option>
                      <option value="6">6+</option>
                      <option value="7">7+</option>
                      <option value="8">8+</option>
                      <option value="9">9+</option>
                    </select>
                  </label>
                </div>

                {coverMessage && <p className="cover-message">{coverMessage}</p>}
                <div className="filter-bar">
                  {([["all","All"],["watched","Finished"],["backlog","Backlog"]] as const).map(([value,label]) => (
                    <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>
                  ))}
                  <label className="year-filter"><span>Year</span>
                    <select value={selectedReleaseYear} onChange={e => setSelectedReleaseYear(e.target.value)}>
                      <option value="all">Any year</option>
                      {releaseYears.map(value => <option key={value} value={String(value)}>{value}</option>)}
                    </select>
                  </label>
                </div>

                {visibleMovies.length === 0 ? (
                  <div className="empty-state">
                    <Film size={36} />
                    <h2>{query ? "No titles found" : "No titles here yet"}</h2>
                    <p>
                      {query
                        ? "Try a different search term."
                        : "There are no titles matching this filter."}
                    </p>
                    {!query && filter === "all" && (
                      <button className="primary-btn" onClick={openNew}>
                        <Plus size={18} /> Add {mediaSection === "books" ? "book" : mediaSection === "tv" ? "show" : "movie"}
                      </button>
                    )}
                  </div>
                ) : (
                  <MovieGrid movies={visibleMovies} onSelect={openDetails} />
                )}
              </>
            )}
          </>
        ) : (
          <section className="coming-soon">
            <div className="coming-icon"><Tv size={30} /></div>
            <p className="eyebrow">YOUR NEXT COLLECTION</p>
            <h1>TV Shows<span className="muted">.</span></h1>
            <p>Track your series, seasons and episodes.</p>
            <span className="coming-label">COMING SOON</span>
          </section>
        )}
      </main>

      <footer>
        <span>MEDIA LISTS · MARKDOWN LIBRARY</span>
        <span>
          {loading
            ? "Loading..."
            : pendingCount
              ? `Syncing ${pendingCount} change${pendingCount === 1 ? "" : "s"}…`
              : "All systems ready"}
        </span>
      </footer>

      {showSettings && (
        <div
          className="modal-backdrop"
          onMouseDown={e => e.target === e.currentTarget && setShowSettings(false)}
        >
          <section className="modal">
            <div className="modal-head">
              <div>
                <p className="eyebrow">CONFIGURATION</p>
                <h2>Settings</h2>
              </div>
              <button className="icon-btn" onClick={() => setShowSettings(false)}>
                <X />
              </button>
            </div>

            <p className="help">
              Enter your private <b>private-data</b> repository details.
              Your token is stored locally in this browser.
            </p>

            <label>
              GitHub username
              <input
                value={settings.owner}
                onChange={e => setSettings({ ...settings, owner: e.target.value })}
                placeholder="Your GitHub username"
              />
            </label>

            <label>
              Repository
              <input
                value={settings.repo}
                onChange={e => setSettings({ ...settings, repo: e.target.value })}
                placeholder="private-data"
              />
            </label>

            <div className="two-col">
              <label>
                Branch
                <input
                  value={settings.branch}
                  onChange={e => setSettings({ ...settings, branch: e.target.value })}
                  placeholder="main"
                />
              </label>
              <label>
                Markdown folder
                <input
                  value={settings.folder}
                  onChange={e => setSettings({ ...settings, folder: e.target.value })}
                  placeholder="Library/Database"
                />
              </label>
            </div>

            <label>
              GitHub Fine-grained Personal Access Token
              <input
                type="password"
                autoComplete="off"
                value={settings.token}
                onChange={e => setSettings({ ...settings, token: e.target.value })}
                placeholder="github_pat_..."
              />
            </label>

            <div className="help">
              Token permissions: select only the <b>private-data</b> repository
              and set Repository permissions → Contents: Read and write.
              Keep Metadata as Read-only.
            </div>

            <div className="modal-actions">
              <button
                className="secondary-btn"
                onClick={async () => {
                  try {
                    await testGitHub(settings);
                    alert("GitHub connection successful.");
                  } catch (e) {
                    alert((e as Error).message);
                  }
                }}
              >
                Test GitHub
              </button>
              <button
                className="primary-btn"
                onClick={() => {
                  // A different repo/branch must not inherit pending changes.
                  window.clearTimeout(reconcileTimer.current);
                  pendingRef.current = new Map();
                  setPendingCount(0);
                  setShowSettings(false);
                  void refresh();
                }}
              >
                Save & Load
              </button>
            </div>
          </section>
        </div>
      )}

      {details && (
        <div
          className="modal-backdrop"
          onMouseDown={e => e.target === e.currentTarget && setDetails(null)}
        >
          <section
            className="modal details-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Details: ${details.title}`}
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">{getMediaType(details) === "book" ? "BOOK DETAILS" : getMediaType(details) === "tv" ? "TV DETAILS" : "MOVIE DETAILS"}</p>
                <h2>{details.title}</h2>
              </div>
              <button
                className="icon-btn"
                aria-label="Close"
                onClick={() => setDetails(null)}
              >
                <X />
              </button>
            </div>

            <MovieDetails movie={details} />

            <div className="modal-actions">
              <button
                className="primary-btn"
                onClick={() => {
                  setDetails(null);
                  openEdit(details);
                }}
              >
                <Pencil size={16} /> Edit
              </button>
            </div>
          </section>
        </div>
      )}

      {showEditor && (
        <div
          className="modal-backdrop"
          onMouseDown={e => e.target === e.currentTarget && setShowEditor(false)}
        >
          <section className="modal">
            <div className="modal-head">
              <div>
                <p className="eyebrow">{editing ? "EDIT ENTRY" : "NEW ENTRY"}</p>
                <h2>{editing ? `Edit ${getMediaType(editing) === "book" ? "book" : getMediaType(editing) === "tv" ? "show" : "movie"}` : `Add ${entryMediaType === "book" ? "book" : entryMediaType === "tv" ? "show" : "movie"}`}</h2>
              </div>
              <button className="icon-btn" onClick={() => setShowEditor(false)}>
                <X />
              </button>
            </div>

            <p className="help">
              Add a title, your rating and the date you finished it. Your notes stay in your private GitHub library.
            </p>

            {editorError && (
              <div className="error-banner" role="alert">
                <span>{editorError}</span>
              </div>
            )}

            <label>
              Title
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Blade Runner 2049"
              />
            </label>

            {!editing && mediaSection === "all" && <label>Type<select value={entryMediaType} onChange={e => setEntryMediaType(e.target.value as typeof entryMediaType)}><option value="movie">Movie</option><option value="book">Book</option><option value="tv">TV Series</option></select></label>}
            {((editing && getMediaType(editing) === "book") || (!editing && entryMediaType === "book")) && <label>Author *<input value={author} onChange={e => setAuthor(e.target.value)} placeholder="Author name" /></label>}
            {((editing && getMediaType(editing) === "tv") || (!editing && entryMediaType === "tv")) && <label>Seasons<input type="number" min="1" value={seasons} onChange={e => setSeasons(e.target.value)} placeholder="Number of seasons" /></label>}
            <div className="two-col">
              <label>
                Rating
                <select value={rating} onChange={e => setRating(e.target.value)}>
                  <option value="">Not rated</option>
                  {rating !== "" && !RATING_OPTIONS.includes(Number(rating)) && (
                    <option value={rating}>{rating} (outside {MIN_RATING}–{MAX_RATING})</option>
                  )}
                  {RATING_OPTIONS.map(value => (
                    <option key={value} value={String(value)}>{value}</option>
                  ))}
                </select>
              </label>
            </div>

            <label>
              Finished on
              <input
                type="date"
                value={finishedOn}
                onChange={e => setFinishedOn(e.target.value)}
              />
            </label>

            <div className="cover-mode">
              <button type="button" className={coverMode === "url" ? "active" : ""} onClick={() => setCoverMode("url")}>From internet</button>
              <button type="button" className={coverMode === "file" ? "active" : ""} onClick={() => setCoverMode("file")}>Upload file</button>
            </div>
            {coverMode === "url" ? <label>Cover URL<input value={poster} onChange={e => setPoster(e.target.value)} placeholder="Paste an image URL..." /></label> :
              <label>Choose cover from device<input type="file" accept="image/*" onChange={async e => {
                const file=e.target.files?.[0]; if(!file)return;
                try {
                  const objectUrl=URL.createObjectURL(file);
                  const img=await new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=objectUrl;});
                  const scale=Math.min(1,600/img.width,900/img.height),canvas=document.createElement("canvas");
                  canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
                  const ctx=canvas.getContext("2d");if(!ctx)throw new Error("canvas");
                  ctx.drawImage(img,0,0,canvas.width,canvas.height);URL.revokeObjectURL(objectUrl);
                  setPoster(canvas.toDataURL("image/jpeg",0.78));setEditorError("");
                } catch {setEditorError("Could not read this image. Try another file.");}
              }} /></label>}

            {poster && (
              <div className="poster-preview">
                <img
                  src={poster}
                  alt="Poster preview"
                  onError={e => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              </div>
            )}

            <label>
              Notes (optional)
              <textarea
                rows={3}
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Your thoughts..."
              />
            </label>

            <div className="modal-actions">
              {editing && (
                <button
                  className="danger-btn"
                  onClick={() => {
                    setShowEditor(false);
                    void remove(editing);
                  }}
                >
                  <Trash2 size={16} /> Delete
                </button>
              )}
              <button
                className="primary-btn"
                onClick={() => void save()}
                disabled={loading || !title.trim() || ((editing ? getMediaType(editing) : entryMediaType) === "book" && !author.trim())}
              >
                {loading ? <LoaderCircle className="spin" /> : null}
                Save to GitHub
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}