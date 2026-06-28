/**
 * Regenerates the plugin artifacts from the public RoxyAPI OpenAPI spec and agent playbook.
 *
 * @remarks
 * Sources: the combined spec at /api/v2/openapi.json and the playbook at /AGENTS.md. Outputs four files: the bundled Skill (skills/roxyapi/SKILL.md), the keyless Docs MCP config (.mcp.json), and the plugin and marketplace manifests (.claude-plugin/). Domains are discovered from the spec, so adding or changing endpoints needs no edit here.
 *
 * Run `bun run sync` to write the artifacts, or `bun run sync --dry-run` to build and validate without writing (CI and the pre-push hook use this).
 */

import { join } from 'node:path';

const API_ORIGIN = 'https://roxyapi.com';
const COMBINED_SPEC_URL = `${API_ORIGIN}/api/v2/openapi.json`;
const AGENTS_URL = `${API_ORIGIN}/AGENTS.md`;
const DOCS_MCP_URL = `${API_ORIGIN}/mcp/docs`;

const ROOT = join(import.meta.dir, '..');
const SKILL_PATH = join(ROOT, 'skills', 'roxyapi', 'SKILL.md');
const MCP_PATH = join(ROOT, '.mcp.json');
const PLUGIN_PATH = join(ROOT, '.claude-plugin', 'plugin.json');
const MARKETPLACE_PATH = join(ROOT, '.claude-plugin', 'marketplace.json');

/** Marketing keywords that are not domain slugs. Merged with the discovered slugs for plugin and marketplace discovery. */
const FIXED_KEYWORDS = [
	'roxyapi',
	'mcp',
	'remote-mcp',
	'claude-code',
	'agent-skill',
	'astrology-api',
	'spiritual',
	'divination',
	'natal-chart',
	'kundli',
	'horoscope',
];

const DRY_RUN = new Set(process.argv.slice(2)).has('--dry-run');

/** Bypass edge cache so generation always reflects the freshest origin, not a stale CDN node. */
const NO_CACHE: RequestInit = { headers: { 'Cache-Control': 'no-cache' } };

interface OpenAPISpec {
	info: { title: string };
	paths: Record<string, unknown>;
}

interface Domain {
	slug: string;
	title: string;
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, NO_CACHE);
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
	return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, NO_CACHE);
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
	return res.text();
}

function writeJson(path: string, data: unknown): Promise<number> {
	return Bun.write(path, `${JSON.stringify(data, null, '\t')}\n`);
}

/** Discover the live domains: combined-spec path segments that serve their own per-domain spec, kept in the spec's order rather than sorted. */
async function discoverDomains(): Promise<Domain[]> {
	const combined = await fetchJson<OpenAPISpec>(COMBINED_SPEC_URL);
	const slugs: string[] = [];
	const seen = new Set<string>();
	for (const path of Object.keys(combined.paths)) {
		const segment = path.split('/')[1];
		if (segment && !seen.has(segment)) {
			seen.add(segment);
			slugs.push(segment);
		}
	}
	const probed = await Promise.all(
		slugs.map(async (slug) => {
			const res = await fetch(
				`${API_ORIGIN}/api/v2/${slug}/openapi.json`,
				NO_CACHE,
			);
			if (!res.ok) return null;
			const spec = (await res.json()) as OpenAPISpec;
			return { slug, title: spec.info.title.replace(/ API$/, '') };
		}),
	);
	return probed.filter((d): d is Domain => d !== null);
}

/** The Docs MCP is POST-only Streamable HTTP, so a GET returns 405 when it exists and 404 when it is gone. Fail the run on 404 so a removed endpoint never ships a dead config. */
async function assertDocsMcp(): Promise<void> {
	const res = await fetch(DOCS_MCP_URL);
	if (res.status === 404)
		throw new Error(`Docs MCP missing: GET ${DOCS_MCP_URL} -> 404`);
}

/** Compose the bundled Skill: model-invocation frontmatter over the live agent playbook. The trigger sentence lists discovered domains so it tracks the catalog; the body is /AGENTS.md verbatim (already generated from the spec). */
function buildSkill(domains: Domain[], playbook: string): string {
	const list = domains.map((d) => d.title).join(', ');
	const description = `Use RoxyAPI to build or integrate any astrology, divination, or insight feature. RoxyAPI is a multi domain API with Remote MCP covering ${list}. Invoke when the user is building or asking about natal charts, horoscopes, Vedic kundli, panchang, synastry or compatibility, tarot readings, numerology reports, human design charts, transits or forecasts, biorhythm, I Ching, crystals, dream meanings, angel numbers, or city and timezone lookup, or any prediction, divination, or self knowledge app, agent, chatbot, or MCP integration. Covers endpoints, X-API-Key auth, the location first rule, typed SDKs, and Remote MCP.`;
	return `---\nname: roxyapi\ndescription: ${description}\n---\n\n${playbook.trimStart()}`;
}

function buildMcpConfig() {
	return {
		mcpServers: {
			'roxy-docs': {
				type: 'http',
				url: DOCS_MCP_URL,
			},
		},
	};
}

function keywords(domains: Domain[]): string[] {
	return [...new Set([...FIXED_KEYWORDS, ...domains.map((d) => d.slug)])];
}

function buildPlugin(domains: Domain[]) {
	return {
		name: 'roxyapi',
		description:
			'RoxyAPI multi domain spiritual intelligence API and Remote MCP for Claude Code. Auto connects the keyless Docs MCP and ships a skill that teaches Claude how to build natal charts, Vedic kundli, tarot, numerology, human design, forecasts, and more, all under one key.',
		author: { name: 'RoxyAPI' },
		homepage: 'https://roxyapi.com',
		repository: 'https://github.com/RoxyAPI/claude-plugin',
		license: 'MIT',
		keywords: keywords(domains),
	};
}

function buildMarketplace(domains: Domain[]) {
	return {
		name: 'roxyapi',
		owner: { name: 'RoxyAPI' },
		description:
			'RoxyAPI: the multi domain spiritual intelligence API and Remote MCP. One plugin connects Claude Code to verified astrology, Vedic, tarot, numerology, human design, forecast, and more.',
		plugins: [
			{
				name: 'roxyapi',
				source: './',
				description:
					'Connects Claude Code to RoxyAPI: a keyless Docs MCP for live endpoint lookup plus a skill that teaches Claude how to build on every RoxyAPI domain under one key.',
				category: 'api',
				keywords: keywords(domains),
				homepage: 'https://roxyapi.com',
				repository: 'https://github.com/RoxyAPI/claude-plugin',
				license: 'MIT',
			},
		],
	};
}

async function main(): Promise<void> {
	console.log(DRY_RUN ? 'sync: DRY RUN (no writes)\n' : 'sync: live\n');

	const [domains, playbook] = await Promise.all([
		discoverDomains(),
		fetchText(AGENTS_URL),
		assertDocsMcp(),
	]);

	if (!domains.length)
		throw new Error('no domains discovered from the combined spec');
	if (playbook.length < 1000)
		throw new Error(
			`/AGENTS.md too short (${playbook.length} bytes), refusing to ship`,
		);

	console.log(
		`discovered ${domains.length} domains: ${domains.map((d) => d.slug).join(', ')}`,
	);
	console.log(`playbook: ${playbook.length} bytes from ${AGENTS_URL}\n`);

	const skill = buildSkill(domains, playbook);
	const mcp = buildMcpConfig();
	const plugin = buildPlugin(domains);
	const marketplace = buildMarketplace(domains);

	if (DRY_RUN) {
		console.log(
			'built: SKILL.md, .mcp.json, plugin.json, marketplace.json (validated, not written)',
		);
		return;
	}

	await Promise.all([
		Bun.write(SKILL_PATH, skill),
		writeJson(MCP_PATH, mcp),
		writeJson(PLUGIN_PATH, plugin),
		writeJson(MARKETPLACE_PATH, marketplace),
	]);

	console.log(
		'wrote: skills/roxyapi/SKILL.md, .mcp.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json',
	);
}

await main();
