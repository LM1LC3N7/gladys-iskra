// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the IskraApp (src/app.js). Read-only: no command handler,
// the gateway and its meters are never commanded.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { IskraApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';

const gladys = new GladysIntegration();
const app = new IskraApp({ gladys });

// --- Discovery -------------------------------------------------------------------
// The known meters, never a read (the next one comes at its time).
gladys.onScanRequest(() => app.scan());
// A device just created: its values come at the next read.
gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
gladys.onDeviceUpdated((device) => app.onDeviceUpdated(device));

// --- Configuration screen buttons -----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());
// The only way to take an index held back (a save of the form never does).
gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeldIndex());

// --- Configuration changed by the user ----------------------------------------
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated: restarting');
  return app.start(config);
});

// --- Connection lifecycle ------------------------------------------------------
// Every connection (the first one and each reconnection) publishes the
// Discovery list and the status again, and every value at the next read.
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error(`Start failed (${err?.name ?? 'Error'})`);
  }
});
gladys.on('disconnected', () => {
  app.stop().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
});
gladys.handleShutdown(() => app.stop());

logger.info('Starting the Iskra integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
