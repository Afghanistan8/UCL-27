/* lib/crests.js — Maps 2026/27 UEFA Champions League team names to crest images.
 *
 * Crest URLs come from football-data.org's stable CDN (crests.football-data.org),
 * the same source the standings pipeline mirrors, so badges here match the
 * Table tab exactly.
 *
 * The 36 league-phase clubs — England, Spain, Germany, Italy, France,
 * Portugal, Netherlands, Belgium, Turkey, Greece, Austria, Norway, Czechia,
 * Slovakia, Ukraine, Azerbaijan. Keyed generously (BBC name, official name,
 * alt spellings, nicknames) because fixtures may store either the BBC short
 * name or the football-data full name.
 */

const CDN = 'https://crests.football-data.org';

// One entry per 2026/27 UCL league-phase club (36 total).
// If a specific football-data team ID is wrong for a club, updating the CDN
// path here fixes it everywhere the crest appears.
const TEAMS = [
  // England
  { crest: `${CDN}/65.png`,   aliases: ['manchester city', 'man city'] },
  { crest: `${CDN}/66.png`,   aliases: ['manchester united', 'man united', 'man utd'] },
  { crest: `${CDN}/64.png`,   aliases: ['liverpool', 'liverpool fc'] },
  { crest: `${CDN}/57.png`,   aliases: ['arsenal', 'arsenal fc'] },
  { crest: `${CDN}/58.png`,   aliases: ['aston villa', 'aston villa fc'] },

  // Spain
  { crest: `${CDN}/86.png`,   aliases: ['real madrid', 'real madrid cf'] },
  { crest: `${CDN}/81.png`,   aliases: ['barcelona', 'fc barcelona', 'barça', 'barca'] },
  { crest: `${CDN}/78.png`,   aliases: ['atletico madrid', 'atlético madrid', 'atletico de madrid', 'atlético de madrid', 'club atletico de madrid', 'atleti', 'atletico'] },
  { crest: `${CDN}/94.png`,   aliases: ['villarreal', 'villarreal cf'] },
  { crest: `${CDN}/90.png`,   aliases: ['real betis', 'betis', 'real betis balompié'] },

  // Germany
  { crest: `${CDN}/5.png`,    aliases: ['bayern munich', 'bayern münchen', 'fc bayern münchen', 'fc bayern'] },
  { crest: `${CDN}/4.png`,    aliases: ['borussia dortmund', 'dortmund', 'bvb'] },
  { crest: `${CDN}/721.png`,  aliases: ['rb leipzig', 'leipzig'] },
  { crest: `${CDN}/10.png`,   aliases: ['stuttgart', 'vfb stuttgart'] },

  // Italy
  { crest: `${CDN}/108.png`,  aliases: ['inter milan', 'inter', 'internazionale', 'fc internazionale milano'] },
  { crest: `${CDN}/113.png`,  aliases: ['napoli', 'ssc napoli'] },
  { crest: `${CDN}/100.png`,  aliases: ['roma', 'as roma'] },
  { crest: `${CDN}/604.png`,  aliases: ['como', 'como 1907'] },

  // France
  { crest: `${CDN}/524.png`,  aliases: ['paris saint-germain', 'paris st-germain', 'paris st germain', 'psg'] },
  { crest: `${CDN}/521.png`,  aliases: ['lille', 'losc lille', 'losc'] },
  { crest: `${CDN}/546.png`,  aliases: ['lens', 'rc lens'] },

  // Portugal
  { crest: `${CDN}/503.png`,  aliases: ['porto', 'fc porto'] },
  { crest: `${CDN}/498.png`,  aliases: ['sporting cp', 'sporting lisbon', 'sporting clube de portugal'] },

  // Netherlands
  { crest: `${CDN}/674.png`,  aliases: ['psv eindhoven', 'psv'] },
  { crest: `${CDN}/675.png`,  aliases: ['feyenoord', 'feyenoord rotterdam'] },

  // Belgium
  { crest: `${CDN}/851.png`,  aliases: ['club brugge', 'club bruges', 'club brugge kv'] },

  // Turkey
  { crest: `${CDN}/645.png`,  aliases: ['galatasaray', 'galatasaray sk'] },
  { crest: `${CDN}/611.png`,  aliases: ['fenerbahce', 'fenerbahçe', 'fenerbahçe sk'] },

  // Greece
  { crest: `${CDN}/6969.png`, aliases: ['aek athens', 'aek', 'aek athens fc'] },

  // Austria
  { crest: `${CDN}/2020.png`, aliases: ['lask', 'lask linz'] },

  // Norway
  { crest: `${CDN}/1959.png`, aliases: ['bodo/glimt', 'bodø/glimt', 'bodø / glimt', 'fk bodo/glimt', 'fk bodø/glimt'] },
  { crest: `${CDN}/1948.png`, aliases: ['viking', 'viking fk'] },

  // Czechia
  { crest: `${CDN}/907.png`,  aliases: ['slavia prague', 'slavia praha', 'sk slavia praha'] },

  // Slovakia
  { crest: `${CDN}/7910.png`, aliases: ['slovan bratislava', 'šk slovan bratislava'] },

  // Ukraine
  { crest: `${CDN}/1887.png`, aliases: ['shakhtar donetsk', 'shakhtar', 'fc shakhtar donetsk'] },

  // Azerbaijan
  { crest: `${CDN}/7995.png`, aliases: ['sabah', 'sabah fk', 'sabah fc'] },
];

const CREST_BY_NAME = {};
for (const t of TEAMS) {
  for (const a of t.aliases) CREST_BY_NAME[a] = t.crest;
}

function normalize(name) {
  return (name || '').toString().trim().toLowerCase();
}

export function getCrestUrl(teamName) {
  const n = normalize(teamName);
  if (CREST_BY_NAME[n]) return CREST_BY_NAME[n];
  // Fall back: strip a trailing " fc"/" cf"/" sk"/" kv" and retry.
  const stripped = n.replace(/\s+(a?fc|cf|sk|kv)$/, '').trim();
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
