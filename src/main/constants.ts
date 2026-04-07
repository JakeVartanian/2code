// Dev mode detection
export const IS_DEV = !!process.env.ELECTRON_RENDERER_URL

// Auth server port - use different port in dev to allow running alongside production
// 21325 for dev avoids conflicts with 21st-desktop which occupies 21322
export const AUTH_SERVER_PORT = IS_DEV ? 21325 : 21321
