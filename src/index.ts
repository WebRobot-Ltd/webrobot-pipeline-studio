/**
 * webrobot-pipeline-studio — a host-agnostic client and UI for the WebRobot Tenant Studio
 * (the org-scoped pipeline designer backend, /webrobot/api/tenant/*).
 *
 * The core (client + yaml + types) has no framework dependency: call configureTenantStudio()
 * once with your apiBase and a token provider, then use the typed client or the React
 * components. Built to be embedded outside the main app — e.g. a WordPress plugin.
 */
export * from './client';
export * from './yaml';
export * from './types';

export { default as ExistingPipelines } from './components/ExistingPipelines';
export { default as BuildWizard } from './components/BuildWizard';
export { default as FieldEditor } from './components/FieldEditor';
export { default as OddsMarketsEditor } from './components/OddsMarketsEditor';
export { default as PythonExtensionsEditor } from './components/PythonExtensionsEditor';
export { default as SelectorPicker } from './components/SelectorPicker';
