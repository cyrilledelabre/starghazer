import { pipeline, env } from '@huggingface/transformers';

// Use local model cache via OPFS when available
env.allowLocalModels = false;
env.useBrowserCache = true;

type Extractor = (text: string, opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array }>;
let extractor: Extractor | null = null;

async function getExtractor(): Promise<Extractor> {
	if (!extractor) {
		self.postMessage({ type: 'model-loading' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		extractor = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
			dtype: 'fp32'
		})) as unknown as Extractor;
		self.postMessage({ type: 'model-ready' });
	}
	return extractor;
}

self.onmessage = async (e: MessageEvent) => {
	const { type, texts, ids } = e.data;

	if (type === 'embed') {
		const ext = await getExtractor();
		const embeddings: number[][] = [];

		for (let i = 0; i < texts.length; i++) {
			const output = await ext(texts[i], { pooling: 'mean', normalize: true });
			embeddings.push(Array.from(output.data as Float32Array));
			self.postMessage({ type: 'progress', done: i + 1, total: texts.length });
		}

		self.postMessage({ type: 'done', embeddings, ids });
	}

	if (type === 'embed-query') {
		const ext = await getExtractor();
		const output = await ext(e.data.text, { pooling: 'mean', normalize: true });
		self.postMessage({ type: 'query-done', embedding: Array.from(output.data as Float32Array) });
	}
};
