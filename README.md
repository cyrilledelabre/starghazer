# starghazer

Your GitHub stars as an interactive galaxy. Semantic search, local AI, no API key.

## What it does

- Fetches all your starred repos from the public GitHub API
- Embeds each repo (name + description + topics) with a local MiniLM model running in a Web Worker (`@huggingface/transformers`)
- Projects embeddings to 2D with UMAP and clusters with k-means
- Renders the resulting galaxy with D3 + Canvas
- Semantic search via pgvector inside an in-browser PGlite database
- Everything runs client-side. Embeddings, repos and galaxy layout are cached in IndexedDB so revisits are instant

## Stack

- SvelteKit 2 + Svelte 5 runes, static adapter (deployed on Vercel)
- Tailwind v4
- `@electric-sql/pglite` with the `vector` extension
- `@huggingface/transformers` (Xenova/all-MiniLM-L6-v2)
- `umap-js`, `ml-kmeans`, `d3`

## Develop

```sh
npm install
npm run dev
```

The dev server sets `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy: credentialless` so PGlite (OPFS / SharedArrayBuffer) works while still letting the model download from HuggingFace.

## Build

```sh
npm run build
npm run preview
```

## Deploy

Static output, deployable anywhere. CI in `.github/workflows/deploy.yml` ships to Vercel — set `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` as repo secrets.

## Notes

- No login, no token, no server. Public stars only.
- Model is ~23 MB, cached by the browser after first run.
- Rate limit: unauthenticated GitHub API gives 60 req/h per IP. Users with thousands of stars may hit the limit.
</content>
</invoke>