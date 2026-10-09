// The 16 league teams. Colors follow the provided palette (row 1 light, row 2 dark).
/** Team abbreviation: the first 3 letters of the team name (e.g. ROC, COA, PAC). */
export const teamAbbr = (name) => (String(name || '').replace(/[^A-Za-z]/g, '').slice(0, 3) || 'TM').toUpperCase();

export const TEAM_DEFS = [
  { id: 'RR',  name: 'Rocky Rangers',       color: '#e6e6e6' },
  { id: 'NN',  name: 'Northern Nationals',  color: '#ffcfc9' },
  { id: 'SS',  name: 'Southern Saints',     color: '#ffc8aa' },
  { id: 'PP',  name: 'Pacific Pirates',     color: '#ffe5a0' },
  { id: 'EE',  name: 'Eastern Eagles',      color: '#d4edbc' },
  { id: 'GG',  name: 'Gulf Guardians',      color: '#bfe1f6' },
  { id: 'WW',  name: 'Western Warriors',    color: '#c6dbe1' },
  { id: 'AA',  name: 'Atlantic Angels',     color: '#e6cff2' },
  { id: 'MM',  name: 'Midwest Mavericks',   color: '#3d3d3d' },
  { id: 'CC',  name: 'Coastal Cardinals',   color: '#b10202' },
  { id: 'SU',  name: 'Sierra Suns',         color: '#753800' },
  { id: 'DD',  name: 'Desert Diamondbacks', color: '#473822' },
  { id: 'CE',  name: 'Central Celtics',     color: '#11734b' },
  { id: 'CY',  name: 'Canyon Cubs',         color: '#0a53a8' },
  { id: 'PR',  name: 'Prairie Panthers',    color: '#215a6c' },
  { id: 'VV',  name: 'Valley Vikings',      color: '#5a3286' },
].map((t) => ({ ...t, abbr: teamAbbr(t.name) }));

export function isLight(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

/** Contrasting accent used for caps, numbers and text on the team color. */
export function accentFor(hex) { return isLight(hex) ? '#26323a' : '#f4f1ea'; }
