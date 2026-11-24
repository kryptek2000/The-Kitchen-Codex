import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { installDesktopRuntime } from './platform/desktop';
import { ShisoEntryProvider } from './application-ui/shisoEntryPoints';
import './index.css';

installDesktopRuntime();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* One Shiso surface, shared by every entry point (global, recipe detail,
        Advanced Nutrition). Mounted above App so all of them can reach it. */}
    <ShisoEntryProvider>
      <App />
    </ShisoEntryProvider>
  </StrictMode>,
);
