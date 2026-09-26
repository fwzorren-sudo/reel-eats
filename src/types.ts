export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  GOOGLE_MAPS_API_KEY: string;
  APP_TOKEN: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  CLAUDE_WEB_SEARCH?: string;
  /** Test hooks: point the Worker at local mock servers. Leave unset in production. */
  ANTHROPIC_BASE_URL?: string;
  PLACES_BASE_URL?: string;
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
}

export interface SourceMeta {
  url: string;
  author: string;
  caption: string;
  locationName: string;
  thumbnail: string;
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
}
