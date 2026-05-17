export interface Repo {
	id: number;
	full_name: string;
	name: string;
	owner: { login: string; avatar_url: string };
	description: string | null;
	html_url: string;
	homepage: string | null;
	language: string | null;
	topics: string[];
	stargazers_count: number;
	forks_count: number;
	starred_at: string; // ISO timestamp from star+json header
}

interface StarredItem {
	starred_at: string;
	repo: Omit<Repo, 'starred_at'>;
}

export async function fetchAllStars(
	username: string,
	onProgress: (fetched: number) => void
): Promise<Repo[]> {
	const headers = {
		Accept: 'application/vnd.github.star+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};

	const repos: Repo[] = [];
	let page = 1;

	while (true) {
		const res = await fetch(
			`https://api.github.com/users/${encodeURIComponent(username)}/starred?per_page=100&page=${page}`,
			{ headers }
		);

		if (!res.ok) {
			if (res.status === 404) throw new Error(`User "${username}" not found.`);
			if (res.status === 403) throw new Error('Rate limit hit. Wait a minute and try again.');
			throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
		}

		const items: StarredItem[] = await res.json();
		if (items.length === 0) break;

		for (const item of items) {
			repos.push({ ...item.repo, starred_at: item.starred_at });
		}

		onProgress(repos.length);
		if (items.length < 100) break;
		page++;
	}

	return repos;
}

export async function fetchUser(username: string): Promise<{ login: string; avatar_url: string }> {
	const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
		headers: { 'X-GitHub-Api-Version': '2022-11-28' }
	});
	if (!res.ok) throw new Error(`User "${username}" not found.`);
	const data = await res.json();
	return { login: data.login, avatar_url: data.avatar_url };
}
