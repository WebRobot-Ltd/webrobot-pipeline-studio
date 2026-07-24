# webrobot-pipeline-studio

Host-agnostic client and React UI for the **WebRobot Tenant Studio** — the org-scoped pipeline
designer backend (`/webrobot/api/tenant/*`). Extracted from the WebRobot dashboard so the same
designer can be embedded elsewhere (for example a WordPress plugin) without pulling in the app.

## What's in it

- **Core (no framework dependency):** a typed client for all 26 Tenant Studio endpoints, and
  the pipeline → YAML generator that turns a visually composed pipeline into the exact YAML the
  ETL runtime runs. Pure TypeScript, unit-tested.
- **React components (optional):** the designer screens — execute existing pipelines, build a
  pipeline from the live stage catalogue, edit extraction fields, odds markets and Python
  extensions.

The core imports neither a token helper nor `process.env`: you inject an API base and a token
provider once, and the rest is host-agnostic.

## Install

```bash
npm install webrobot-pipeline-studio
# react is a peer dependency, only needed for the UI components
```

## Configure

Call once at startup, wherever your host gets its API base and auth token:

```ts
import { configureTenantStudio } from 'webrobot-pipeline-studio';

configureTenantStudio({
  apiBase: 'https://api.webrobot.eu',
  getToken: () => localStorage.getItem('authToken'), // a function, so a rotated token is picked up
});
```

## Use the core

```ts
import { listPipelines, buildYamlFromPipeline } from 'webrobot-pipeline-studio';

const { demos } = await listPipelines();

const yaml = buildYamlFromPipeline(
  [
    { stage: 'fetch', args: { url: 'https://example.com' }, _src: 1 },
    { stage: 'extract', args: {}, _src: 1, _fields: [{ selector: 'h1', as: 'title' }] },
  ],
  { catalog: (await getStageCatalog()).data },
);
```

`buildYamlFromPipeline` is a pure function — same input, same YAML — and is covered by
`test/`. It is the piece you most want to trust, because a subtle deviation produces pipelines
that look right and fail at execution.

## Use the UI (React)

```tsx
import { ExistingPipelines, BuildWizard } from 'webrobot-pipeline-studio';

export function Studio() {
  return (
    <div>
      <ExistingPipelines />
      <BuildWizard />
    </div>
  );
}
```

The components are unstyled beyond minimal utility classes — bring your own styling.

## Endpoints

Everything targets `/webrobot/api/tenant/*` (authenticated, per-organization). It is the
org-scoped twin of the public `/demo/*` API; the org comes from the caller's JWT.

## Build

```bash
npm run build      # tsc → dist/
npm test           # runs the YAML generator tests
npm run typecheck
```

## License

MIT © WebRobot Ltd
