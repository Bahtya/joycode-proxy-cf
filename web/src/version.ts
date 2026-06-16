// App version shown in the UI. Injected at build time from the root package.json
// "version" field via vite.config.ts (`define __APP_VERSION__`). Falls back to
// 'dev' for non-build contexts (unit tests, etc.) where the define is absent.
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';
