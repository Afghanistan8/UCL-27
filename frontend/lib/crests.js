/* lib/crests.js — Maps 2026/27 UEFA Champions League team names to crest images.
 *
 * Crest URLs come from football-data.org's stable CDN (crests.football-data.org),
 * the same source the standings pipeline mirrors, so badges here match the
 * Table tab exactly.
 *
 * Every team id below was VERIFIED against
 *   GET /v4/competitions/CL/teams?season=2026
 * and every crest URL confirmed to return HTTP 200. Do not hand-edit an id
 * without re-checking it against that endpoint — several clubs (Como, Sabah,
 * Bodø/Glimt, Viking, Slovan Bratislava, AEK, LASK, Slavia, Galatasaray,
 * Fenerbahçe) have ids that are NOT guessable from their more famous
 * namesakes.
 *
 * The 36 league-phase clubs — England, Spain, Germany, Italy, France,
 * Portugal, Netherlands, Belgium, Turkey, Greece, Austria, Norway, Czechia,
 * Slovakia, Ukraine, Azerbaijan. Keyed generously (BBC name, official name,
 * alt spellings, nicknames) because fixtures may store either the BBC short
 * name or the football-data full name.
 */

const CDN = 'https://crests.football-data.org';

// One entry per 2026/27 UCL league-phase club (36 total).
const TEAMS = [
  // England
  { crest: `${CDN}/65.png`,    aliases: ['manchester city', 'man city', 'manchester city fc'] },
  { crest: `${CDN}/66.png`,    aliases: ['manchester united', 'man united', 'man utd', 'manchester united fc'] },
  { crest: `${CDN}/64.png`,    aliases: ['liverpool', 'liverpool fc'] },
  { crest: `${CDN}/57.png`,    aliases: ['arsenal', 'arsenal fc'] },
  { crest: `${CDN}/58.png`,    aliases: ['aston villa', 'aston villa fc'] },

  // Spain
  { crest: `${CDN}/86.png`,    aliases: ['real madrid', 'real madrid cf'] },
  { crest: `${CDN}/81.png`,    aliases: ['barcelona', 'fc barcelona', 'barça', 'barca'] },
  { crest: `${CDN}/78.png`,    aliases: ['atletico madrid', 'atlético madrid', 'atletico de madrid', 'atlético de madrid', 'club atlético de madrid', 'club atletico de madrid', 'atleti', 'atletico'] },
  { crest: `${CDN}/94.png`,    aliases: ['villarreal', 'villarreal cf'] },
  { crest: `${CDN}/90.png`,    aliases: ['real betis', 'betis', 'real betis balompié', 'real betis balompie'] },

  // Germany
  { crest: `${CDN}/5.png`,     aliases: ['bayern munich', 'bayern münchen', 'bayern munchen', 'fc bayern münchen', 'fc bayern', 'bayern'] },
  { crest: `${CDN}/4.png`,     aliases: ['borussia dortmund', 'dortmund', 'bvb'] },
  { crest: `${CDN}/721.png`,   aliases: ['rb leipzig', 'leipzig'] },
  { crest: `${CDN}/10.png`,    aliases: ['stuttgart', 'vfb stuttgart'] },

  // Italy
  { crest: `${CDN}/108.png`,   aliases: ['inter milan', 'inter', 'internazionale', 'fc internazionale milano'] },
  { crest: `${CDN}/113.png`,   aliases: ['napoli', 'ssc napoli'] },
  { crest: `${CDN}/100.png`,   aliases: ['roma', 'as roma'] },
  { crest: `${CDN}/7397.png`,  aliases: ['como', 'como 1907'] },

  // France
  { crest: `${CDN}/524.png`,   aliases: ['paris saint-germain', 'paris st-germain', 'paris st germain', 'psg', 'paris saint-germain fc'] },
  { crest: `${CDN}/521.png`,   aliases: ['lille', 'losc lille', 'losc', 'lille osc'] },
  { crest: `${CDN}/546.png`,   aliases: ['lens', 'rc lens', 'racing club de lens'] },

  // Portugal
  { crest: `${CDN}/503.png`,   aliases: ['porto', 'fc porto'] },
  { crest: `${CDN}/498.png`,   aliases: ['sporting cp', 'sporting lisbon', 'sporting clube de portugal'] },

  // Netherlands
  { crest: `${CDN}/674.png`,   aliases: ['psv eindhoven', 'psv'] },
  { crest: `${CDN}/675.png`,   aliases: ['feyenoord', 'feyenoord rotterdam'] },

  // Belgium
  { crest: `${CDN}/851.png`,   aliases: ['club brugge', 'club bruges', 'club brugge kv'] },

  // Turkey
  { crest: `${CDN}/610.png`,   aliases: ['galatasaray', 'galatasaray sk'] },
  { crest: `${CDN}/613.png`,   aliases: ['fenerbahce', 'fenerbahçe', 'fenerbahçe sk', 'fenerbahce sk'] },

  // Greece
  { crest: `${CDN}/1899.png`,  aliases: ['aek athens', 'aek', 'aek athens fc', 'pae aek'] },

  // Austria
  { crest: `${CDN}/2016.png`,  aliases: ['lask', 'lask linz'] },

  // Norway — BBC prints "Bodø / Glimt" WITH spaces around the slash.
  { crest: `${CDN}/5721.png`,  aliases: ['bodo/glimt', 'bodø/glimt', 'bodø / glimt', 'bodo / glimt', 'fk bodo/glimt', 'fk bodø/glimt'] },
  { crest: `${CDN}/5720.png`,  aliases: ['viking', 'viking fk'] },

  // Czechia
  { crest: `${CDN}/930.png`,   aliases: ['slavia prague', 'slavia praha', 'sk slavia praha'] },

  // Slovakia
  { crest: `${CDN}/7509.png`,  aliases: ['slovan bratislava', 'sl. bratislava', 'šk slovan bratislava', 'sk slovan bratislava'] },

  // Ukraine — football-data spells it "Shaktar" (no 'h') in shortName.
  { crest: `${CDN}/1887.png`,  aliases: ['shakhtar donetsk', 'shakhtar', 'shaktar', 'fc shakhtar donetsk', 'fk shakhtar donetsk'] },

  // Azerbaijan
  { crest: `${CDN}/10233.png`, aliases: ['sabah', 'sabah fk', 'sabah fc'] },
];

const CREST_BY_NAME = {};
for (const t of TEAMS) {
  for (const a of t.aliases) CREST_BY_NAME[a] = t.crest;
}

// Collapse whitespace and lowercase, so "Bodø / Glimt" and "Bodø/Glimt" both
// normalize to a comparable form.
function normalize(name) {
  return (name || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getCrestUrl(teamName) {
  const n = normalize(teamName);
  if (CREST_BY_NAME[n]) return CREST_BY_NAME[n];

  // Try with spaces around a slash removed ("bodø / glimt" -> "bodø/glimt").
  const noSlashSpaces = n.replace(/\s*\/\s*/g, '/');
  if (CREST_BY_NAME[noSlashSpaces]) return CREST_BY_NAME[noSlashSpaces];

  // Fall back: strip a trailing " fc"/" cf"/" sk"/" kv" and retry.
  const stripped = noSlashSpaces.replace(/\s+(a?fc|cf|sk|kv)$/, '').trim();
  return CREST_BY_NAME[stripped] || null;
}

/* A two-letter monogram used when no crest is found (keeps layout stable). */
function monogram(teamName) {
  const words = (teamName || '?').trim().split(/\s+/).filter(Boolean);
  const initials = (words.length >= 2
    ? words[0][0] + words[1][0]
    : (teamName || '?').slice(0, 2)).toUpperCase();
  return `<span class="team-crest crest-fallback" aria-hidden="true">${initials}</span>`;
}

/* Returns an <img> for the club crest, or a monogram span if unmapped.
 * size: pixel box (crests render square). */
export function crestImg(teamName, size = 40, className = 'team-crest') {
  const url = getCrestUrl(teamName);
  if (!url) return monogram(teamName);
  return `<img src="${url}" alt="${teamName}" class="${className}" width="${size}" height="${size}" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`;
}
