/**
 * Agents feature constants
 */

export type DevicePreset = {
  name: string
  width: number
  height: number
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { name: "Custom", width: 397, height: 852 },
  { name: "iPhone 16", width: 393, height: 852 },
  { name: "iPhone 16 Pro", width: 393, height: 852 },
  { name: "iPhone 16 Pro Max", width: 430, height: 932 },
  { name: "iPhone 16 Plus", width: 430, height: 932 },
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPad Mini", width: 744, height: 1133 },
  { name: "iPad Air", width: 820, height: 1180 },
  { name: "iPad Pro", width: 1024, height: 1366 },
  { name: "Android Compact", width: 360, height: 640 },
  { name: "Android Medium", width: 412, height: 915 },
] as const

// Scale presets for preview
export const SCALE_PRESETS = [50, 75, 100, 125, 150] as const

export const AGENTS_PREVIEW_CONSTANTS = {
  DEVICE_PRESETS,
  SCALE_PRESETS,
  DEFAULT_WIDTH: 397,
  DEFAULT_HEIGHT: 852,
  MIN_WIDTH: 100,
  MAX_WIDTH: 2000,
  MIN_HEIGHT: 320,
  MAX_HEIGHT: 2000,
  MIN_SCALE: 25,
  MAX_SCALE: 200,
} as const

export type AgentsPreviewConstants = typeof AGENTS_PREVIEW_CONSTANTS

// Common dev server ports to probe
export const COMMON_DEV_PORTS = [3000, 3001, 5173, 5174, 8080, 8000, 4200, 4321] as const

// Framework → default dev server port mapping
export const FRAMEWORK_PORT_MAP: Record<string, number> = {
  vite: 5173,
  next: 3000,
  "react-scripts": 3000,
  nuxt: 3000,
  angular: 4200,
  astro: 4321,
  svelte: 5173,
  remix: 5173,
  gatsby: 8000,
}

// Compare mode viewport categories
export const VIEWPORT_CATEGORIES = {
  phone: ["iPhone 16", "iPhone SE", "Android Compact"],
  tablet: ["iPad Mini", "iPad Air"],
  desktop: ["Desktop"],
} as const

