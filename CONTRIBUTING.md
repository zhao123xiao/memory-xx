# Contributing

Use synthetic fixtures for tests and documentation. Do not add real user
conversation data, private runtime reports, local database exports, or provider
credentials.

Before submitting changes, run:

```bash
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm test
TMPDIR=/tmp npm run check:secrets
```
