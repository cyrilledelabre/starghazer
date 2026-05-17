import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

// OPFS (used by PGlite) needs SharedArrayBuffer, which requires COOP+COEP headers.
// 'credentialless' COEP allows cross-origin fetches (HuggingFace models) without CORP headers.
function crossOriginIsolation(): Plugin {
	return {
		name: 'cross-origin-isolation',
		configureServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
				res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
				next();
			});
		}
	};
}

export default defineConfig({
	plugins: [crossOriginIsolation(), tailwindcss(), sveltekit()],
	optimizeDeps: {
		exclude: ['@electric-sql/pglite']
	},
	worker: {
		format: 'es'
	}
});
