

/** Live local-runtime identity used by managed model and content-safety requests. */
export interface LocalRuntimeAuthContext {
  readonly accessToken?: string;
  readonly loginEpoch?: string;
  readonly realUserID?: string;
  readonly userEmail?: string;
  readonly userName?: string;
  readonly subUserName?: string;
  /** Electron-internal propagation state; omitted by non-Desktop hosts. */
  readonly authState?: 'pending' | 'authenticated' | 'logged_out';
}
