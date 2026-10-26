# VEIL browser rehearsal

A no-funds static simulation. Build from the repository root with `npm run build:judge`. Run `npm run test:judge` after building. Deploy only `dist/`, never the development repository or database. No environment variables are required.

Original vault and pure protocol modules are copied at build time, preserving profiles and licenses. Browser simulation transitions are separate from the SQL TEST lifecycle.
