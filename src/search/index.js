// Search over saved prompts. Today: keyword search (MiniSearch) over title, prompt
// text, tags and filenames. Semantic search (Model2Vec) plugs in through `embed` later
// and gets merged with the keyword score (README: 0.6 semantic / 0.4 keyword).

import MiniSearch from '../../vendor/minisearch.js';

const SEMANTIC_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

export class PromptSearch {
  // embed: optional async (text) => Float32Array. Absent until the model is bundled.
  constructor({ embed = null } = {}) {
    this.embed = embed;
    this.docs = [];
    this.mini = null;
  }

  // prompts: prompt records; filesById: Map(id -> file record)
  setDocuments(prompts, filesById) {
    this.docs = prompts.map((p) => ({
      id: p.id,
      title: p.title || '',
      promptText: p.promptText || '',
      tags: (p.tags || []).join(' '),
      filenames: p.fileIds.map((id) => filesById.get(id)?.name || '').join(' '),
      embedding: p.embedding || null,
    }));
    this.mini = new MiniSearch({
      fields: ['title', 'promptText', 'tags', 'filenames'],
      storeFields: [],
      searchOptions: {
        boost: { title: 3, tags: 2, filenames: 2 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: 'OR',
      },
    });
    this.mini.addAll(this.docs);
  }

  // -> [{ id, score }] best first. Empty query -> [] (caller shows the default order).
  async search(query) {
    const q = query.trim();
    if (!q || !this.mini) return [];

    const keyword = normalize(new Map(this.mini.search(q).map((r) => [r.id, r.score])));

    let semantic = new Map();
    if (this.embed && this.docs.some((d) => d.embedding)) {
      const qv = await this.embed(q);
      semantic = normalize(new Map(
        this.docs.filter((d) => d.embedding).map((d) => [d.id, Math.max(0, cosine(qv, d.embedding))]),
      ));
    }

    const useSemantic = semantic.size > 0;
    const ids = new Set([...keyword.keys(), ...semantic.keys()]);
    return [...ids]
      .map((id) => ({
        id,
        score: useSemantic
          ? SEMANTIC_WEIGHT * (semantic.get(id) || 0) + KEYWORD_WEIGHT * (keyword.get(id) || 0)
          : keyword.get(id) || 0,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}

function normalize(scores) {
  const max = Math.max(0, ...scores.values());
  if (!max) return scores;
  return new Map([...scores].map(([id, s]) => [id, s / max]));
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
