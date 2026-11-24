/**
 * SHISO-C1.7 S2 — full-page SHISO workspace presentation.
 *
 * This is deliberately a thin wrapper around the ONE shared chat surface in
 * `ShisoModal.tsx`. It does not own conversation state, provider selection,
 * tool execution, save authorization, or persistence. The modal and this
 * workspace are two chrome presentations of the same engine instance, so
 * history continuity and cancellation behave identically in both.
 */
import React from 'react';
import { ShisoModal, type ShisoModalProps } from './ShisoModal';

export function ShisoWorkspace(props: ShisoModalProps) {
  return <ShisoModal {...props} presentation="fullpage" />;
}

export default ShisoWorkspace;
