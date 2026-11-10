export type PermissionLevel = 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser';

export interface Site {
  siteUrl: string;
  permissionLevel: PermissionLevel;
}

export const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance', 'hour'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const FILTER_DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const;
export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

export const FILTER_OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface DimensionFilter {
  dimension: FilterDimension;
  operator?: FilterOperator;
  expression: string;
}

export type DataState = 'final' | 'all' | 'hourly_all';
export type AggregationType = 'auto' | 'byPage' | 'byProperty' | 'byNewsShowcasePanel';

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  dimensionFilterGroups?: { groupType?: 'and'; filters: DimensionFilter[] }[];
  aggregationType?: AggregationType;
  rowLimit?: number;
  startRow?: number;
  dataState?: DataState;
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
  metadata?: { first_incomplete_date?: string; first_incomplete_hour?: string };
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
  contents?: { type: string; submitted?: string; indexed?: string }[];
}

export interface IndexStatusResult {
  verdict?: 'VERDICT_UNSPECIFIED' | 'PASS' | 'PARTIAL' | 'FAIL' | 'NEUTRAL';
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  crawledAs?: string;
  sitemap?: string[];
  referringUrls?: string[];
}

export interface RichResultsResult {
  verdict?: string;
  detectedItems?: {
    richResultType?: string;
    items?: { name?: string; issues?: { issueMessage?: string; severity?: string }[] }[];
  }[];
}

export interface UrlInspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: IndexStatusResult;
  ampResult?: { verdict?: string; ampUrl?: string; issues?: { issueMessage?: string; severity?: string }[] };
  richResultsResult?: RichResultsResult;
}

/** The Search Console calls this server makes. Tests swap in a fake. */
export interface GscApi {
  listSites(): Promise<Site[]>;
  searchAnalytics(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse>;
  inspectUrl(siteUrl: string, inspectionUrl: string, languageCode?: string): Promise<UrlInspectionResult>;
  listSitemaps(siteUrl: string): Promise<Sitemap[]>;
  submitSitemap(siteUrl: string, feedpath: string): Promise<void>;
  deleteSitemap(siteUrl: string, feedpath: string): Promise<void>;
}
