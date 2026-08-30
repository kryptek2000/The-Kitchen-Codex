import packageJson from '../package.json';

export const APP_VERSION: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_VERSION) ||
  `v${packageJson.version}`;
