export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Cloudflare Workers AI. Included with every Cloudflare account; no key needed. */
  AI?: Ai;
  GOOGLE_MAPS_API_KEY: string;
  APP_TOKEN: string;
  /** Optional. Reads reels through Apify, which Instagram blocks far less often. */
  APIFY_TOKEN?: string;
  /** Fallback reader: Apify's own Instagram Scraper. */
  APIFY_ACTOR?: string;
  /** Main reader: full post details, including the location tag's coordinates. */
  APIFY_POST_ACTOR?: string;
  /** Transcript of the reel's audio. Set APIFY_TRANSCRIPTS to "off" to skip it. */
  APIFY_TRANSCRIPT_ACTOR?: string;
  APIFY_TRANSCRIPTS?: string;
  /** Workers AI model used to read captions, or "off". */
  AI_MODEL?: string;
  /** Optional. With a key set, Claude identifies venues instead of Workers AI. */
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  CLAUDE_WEB_SEARCH?: string;
  /** Test hooks: point the Worker at local mock servers. Leave unset in production. */
  ANTHROPIC_BASE_URL?: string;
  PLACES_BASE_URL?: string;
  APIFY_BASE_URL?: string;
}

export type Engine = "claude" | "workers-ai" | "rules";

/** Who is making a request: the owner (APP_TOKEN), a member with their own code, or a read-only link. */
export interface Viewer {
  role: "owner" | "member";
  /** Member's name. NULL for the owner. */
  name: string | null;
}

export const TAGS = [
  "date night",
  "coffee date",
  "brunch",
  "work-friendly",
  "outdoor seating",
  "rooftop",
  "views",
  "late night",
  "quick bite",
  "cheap eats",
  "splurge",
  "family-friendly",
  "groups",
  "dog-friendly",
  "vegetarian-friendly",
  "cocktails",
  "live music",
  "takeout",
] as const;
export type Tag = (typeof TAGS)[number];

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Where to look on Google Maps: a point and how far around it, in meters. */
export interface SearchArea extends GeoPoint {
  radius: number;
}

/** Google's opening hours, trimmed. Days are 0 = Sunday. */
export interface OpeningHours {
  periods: { open: { day: number; hour: number; minute: number }; close?: { day: number; hour: number; minute: number } }[];
  weekdayDescriptions: string[];
}

export interface Home {
  address: string;
  lat: number;
  lng: number;
}

export const CATEGORIES = [
  "Pizza",
  "Burgers",
  "Sandwiches & Deli",
  "Tacos & Mexican",
  "BBQ",
  "Seafood",
  "Steakhouse",
  "Italian",
  "Japanese & Sushi",
  "Ramen & Noodles",
  "Chinese",
  "Korean",
  "Thai",
  "Vietnamese",
  "Indian",
  "Middle Eastern & Mediterranean",
  "Latin & Caribbean",
  "American & Comfort",
  "Breakfast & Brunch",
  "Coffee & Cafe",
  "Bakery & Desserts",
  "Bar & Drinks",
  "Vegetarian & Vegan",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** One venue Claude found in a shared post. */
export interface ExtractedPlace {
  name: string;
  alt_names: string[];
  search_query: string;
  city: string;
  address_hint: string;
  instagram_handle: string;
  category: Category;
  cuisine: string;
  summary: string;
  dishes: string[];
  multi_location: boolean;
  confidence: "high" | "medium" | "low";
  /** Only accept Google results typed as food or drink businesses. */
  food_only?: boolean;
  /** Save it without a location when Google can't find it. */
  keep_unresolved?: boolean;
  /** Take the category from Google's place type instead of `category`. */
  category_from_google?: boolean;
  /** Occasion and vibe tags from the fixed TAGS list. */
  tags?: string[];
  /** Why to go soon: new opening, pop-up, seasonal item. Empty when none. */
  go_soon?: string;
  /** Where the reel was filmed, from its location tag: search Google around there. */
  near?: SearchArea | null;
}

export interface Extraction {
  places: ExtractedPlace[];
  reason: string;
}

/** A Google Places result, trimmed to what the app stores. */
export interface PlaceCandidate {
  id: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  mapsUrl: string;
  website: string;
  phone: string;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: string;
  businessStatus: string;
  typeLabel: string;
  distanceM: number | null;
  primaryType: string;
  types: string[];
  hours: OpeningHours | null;
  timeZone: string;
  utcOffset: number | null;
}

export interface SourceMeta {
  url: string;
  author: string;
  authorFullName: string;
  caption: string;
  locationName: string;
  thumbnail: string;
  /** Accounts @mentioned in the caption, without the @. */
  mentions: string[];
  /** Accounts tagged in the video or listed as collaborators. */
  tagged: { username: string; fullName: string }[];
  via: "apify" | "embed" | "preview" | "none";
  /** What is said in the video, when a transcript was fetched. */
  transcript?: string;
  /** When the reel was posted, in ms. */
  postedAt?: number | null;
  /** Location tag with coordinates, when the reader provides them. */
  location?: TaggedLocation | null;
  /** Raw reader results, kept for reprocessing later. */
  raw?: string | null;
  rawTranscript?: string | null;
  /** Apify refused to run for lack of credit. */
  apifyError?: string;
}

/** A reel's location tag. A city tag ("Atlanta, Georgia") has no address. */
export interface TaggedLocation {
  name: string;
  lat: number;
  lng: number;
  address: string;
  city: string;
}

export interface ShareRow {
  id: string;
  status: "pending" | "processing" | "done" | "failed";
  source_url: string | null;
  shared_text: string | null;
  note: string | null;
  image_base64: string | null;
  image_type: string | null;
  source_author: string | null;
  source_caption: string | null;
  source_thumb: string | null;
  error: string | null;
  attempts: number;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
  raw_post: string | null;
  raw_transcript: string | null;
  transcript: string | null;
  posted_at: number | null;
  source_location: string | null;
  added_by: string | null;
  photo_key: string | null;
  /** JSON list of processing attempts; see src/trace.ts. */
  debug: string | null;
}

export interface PlaceRow {
  id: string;
  share_id: string | null;
  name: string;
  category: string;
  cuisine: string | null;
  summary: string | null;
  dishes: string | null;
  search_query: string | null;
  city_hint: string | null;
  multi_location: number;
  located: number;
  google_place_id: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  distance_m: number | null;
  branch_count: number;
  branches: string | null;
  maps_url: string | null;
  website: string | null;
  phone: string | null;
  rating: number | null;
  rating_count: number | null;
  price_level: string | null;
  business_status: string | null;
  source_url: string | null;
  source_author: string | null;
  source_caption: string | null;
  visit_status: "want" | "visited";
  my_rating: number | null;
  notes: string | null;
  visited_at: number | null;
  created_at: number;
  updated_at: number;
  instagram_handle: string | null;
  posted_at: number | null;
  tags: string | null;
  go_soon: string | null;
  hours: string | null;
  time_zone: string | null;
  utc_offset: number | null;
  photo_key: string | null;
  added_by: string | null;
  refreshed_at: number | null;
  archived_at: number | null;
  archive_reason: ArchiveReason | null;
  /** 1 when the saved branch stays put instead of switching to the one nearest home. */
  keep_branch: number;
}

export const ARCHIVE_REASONS = ["not-for-me", "closed", "too-far", "other"] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export interface SourceRow {
  id: string;
  place_id: string;
  share_id: string | null;
  source_url: string | null;
  source_author: string | null;
  source_caption: string | null;
  posted_at: number | null;
  photo_key: string | null;
  added_by: string | null;
  created_at: number;
}

export interface ShareLinkScope {
  status: "want" | "visited" | "all";
  category: string | null;
}

/** Apify's monthly usage, checked once a day. */
export interface ApifyUsage {
  used: number;
  limit: number;
  resetsAt: string;
  checkedAt: number;
  /** Set when Apify refused a run for lack of credit. */
  blocked?: string | null;
}
