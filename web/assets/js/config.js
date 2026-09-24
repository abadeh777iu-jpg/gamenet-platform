'use strict';
/** Public runtime config — served as static file. Google Client ID is NOT a secret. */
window.GN_CONFIG = {
  // Google OAuth Client ID (safe to expose in browser; empty = button hidden)
  GOOGLE_CLIENT_ID: '',
  /**
   * API origin. Empty = same origin (Cloudflare Pages / local dev / the API host itself).
   * On GitHub Pages the API lives on the Cloudflare Worker host — set automatically
   * by hostname so one file works on every deployment.
   */
  API_BASE: (function(){
    const h = location.hostname;
    if(h === 'abadeh777iu-jpg.github.io') return 'https://gamenet-server.abadeh-gamenet.workers.dev';
    return '';
  })()
};
