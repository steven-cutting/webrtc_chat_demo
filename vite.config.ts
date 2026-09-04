import { defineConfig } from 'vite';

// base: './' rather than '/webrtc_chat_demo/'. Vite's deploy guide recommends the repo
// path for a project page; relative is chosen instead because it names no repo and so
// survives a rename or a move to another host, and because vite ignores a relative base
// in dev -- so `npm run dev` stays at '/' and playwright.config.ts's baseURL and every
// page.goto('/') are untouched. It holds only because this page loads one entry chunk
// with no dynamic import, `new URL()`, worker or external asset: nothing whose URL is
// built at runtime, which is the case relative base cannot rewrite.
// Only the exact strings '' and './' opt in. './anything' fails resolveBaseUrl's
// `base[0] === '.'` guard, warns, and silently falls back to '/'.
export default defineConfig({ base: './' });
